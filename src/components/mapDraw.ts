/* =============================================================================
 * Map rendering helpers shared by the radar (bitmap, drawn rotated at 60 Hz) and
 * the world map (vector Path2D, redrawn only when the view changes).
 * Map convention: +X east → right, +Z south → down.
 * ===========================================================================*/
import type { MapData, MapRoad, RoadKind, Vec2 } from '../core/types';

const TAU = Math.PI * 2;

function tracePolyline(target: Path2D | CanvasRenderingContext2D, pts: readonly Vec2[], close = false): void {
  if (pts.length === 0) return;
  target.moveTo(pts[0].x, pts[0].z);
  for (let i = 1; i < pts.length; i++) target.lineTo(pts[i].x, pts[i].z);
  if (close) target.closePath();
}

// -----------------------------------------------------------------------------
// Vector paths (world coordinates)
// -----------------------------------------------------------------------------

export interface MapPaths {
  roads: Record<RoadKind, { path: Path2D; width: number }>;
  water: Path2D;
  tunnels: Path2D;
  bridges: Path2D;
  districts: { id: string; name: string; color: string; path: Path2D; labelX: number; labelZ: number }[];
}

const ROAD_KINDS: RoadKind[] = ['industrial', 'street', 'hill', 'ramp', 'avenue', 'highway'];

const pathCache = new WeakMap<MapData, MapPaths>();

export function getMapPaths(map: MapData): MapPaths {
  const hit = pathCache.get(map);
  if (hit) return hit;
  const roads = {} as MapPaths['roads'];
  for (const kind of ROAD_KINDS) roads[kind] = { path: new Path2D(), width: 8 };
  const widthSum: Partial<Record<RoadKind, { sum: number; n: number }>> = {};
  for (const r of map.roads as MapRoad[]) {
    const slot = roads[r.kind] ?? roads.street;
    tracePolyline(slot.path, r.points);
    const w = widthSum[r.kind] ?? (widthSum[r.kind] = { sum: 0, n: 0 });
    w.sum += r.width;
    w.n++;
  }
  for (const kind of ROAD_KINDS) {
    const w = widthSum[kind];
    if (w && w.n > 0) roads[kind].width = w.sum / w.n;
  }
  const water = new Path2D();
  for (const poly of map.water) tracePolyline(water, poly, true);
  const tunnels = new Path2D();
  for (const poly of map.tunnels) tracePolyline(tunnels, poly, true);
  const bridges = new Path2D();
  for (const poly of map.bridges) tracePolyline(bridges, poly, true);
  const districts = map.districts.map((d) => {
    const path = new Path2D();
    tracePolyline(path, d.polygon, true);
    return { id: d.id, name: d.name, color: d.color, path, labelX: d.labelX, labelZ: d.labelZ };
  });
  const out: MapPaths = { roads, water, tunnels, bridges, districts };
  pathCache.set(map, out);
  return out;
}

const routeCache = new WeakMap<readonly Vec2[], Path2D>();

/** Path2D of a route polyline (cached on the array reference, which changes with the route). */
export function getRoutePath(route: readonly Vec2[]): Path2D {
  let p = routeCache.get(route);
  if (!p) {
    p = new Path2D();
    tracePolyline(p, route);
    routeCache.set(route, p);
  }
  return p;
}

// -----------------------------------------------------------------------------
// Radar bitmap: the whole road network rasterised once
// -----------------------------------------------------------------------------

export interface RoadBitmap {
  canvas: HTMLCanvasElement;
  /** bitmap pixels per metre */
  pxPerM: number;
  minX: number;
  minZ: number;
  width: number;
  height: number;
}

const bitmapCache = new WeakMap<MapData, RoadBitmap>();

const RADAR_ROAD_STYLE: Record<RoadKind, { color: string; minWidth: number; scale: number }> = {
  industrial: { color: 'rgba(132,146,176,0.78)', minWidth: 9, scale: 1 },
  street: { color: 'rgba(150,164,194,0.82)', minWidth: 9, scale: 1 },
  hill: { color: 'rgba(150,176,170,0.82)', minWidth: 9, scale: 1 },
  ramp: { color: 'rgba(200,190,240,0.85)', minWidth: 8, scale: 1 },
  avenue: { color: 'rgba(206,216,238,0.92)', minWidth: 14, scale: 1 },
  highway: { color: 'rgba(224,206,255,1)', minWidth: 22, scale: 1 },
};

export function getRoadBitmap(map: MapData, maxSize = 2048): RoadBitmap {
  const hit = bitmapCache.get(map);
  if (hit) return hit;
  const b = map.bounds;
  const spanX = Math.max(1, b.maxX - b.minX);
  const spanZ = Math.max(1, b.maxZ - b.minZ);
  const pxPerM = Math.min(1.2, maxSize / Math.max(spanX, spanZ));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(spanX * pxPerM);
  canvas.height = Math.ceil(spanZ * pxPerM);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const paths = getMapPaths(map);
    ctx.setTransform(pxPerM, 0, 0, pxPerM, -b.minX * pxPerM, -b.minZ * pxPerM);
    ctx.fillStyle = 'rgba(24,74,128,0.55)';
    ctx.fill(paths.water);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // dark casing first so that junctions merge cleanly
    for (const kind of ROAD_KINDS) {
      const st = RADAR_ROAD_STYLE[kind];
      ctx.strokeStyle = 'rgba(4,6,12,0.85)';
      ctx.lineWidth = Math.max(st.minWidth, paths.roads[kind].width) + 5;
      ctx.stroke(paths.roads[kind].path);
    }
    for (const kind of ROAD_KINDS) {
      const st = RADAR_ROAD_STYLE[kind];
      ctx.strokeStyle = st.color;
      ctx.lineWidth = Math.max(st.minWidth, paths.roads[kind].width);
      ctx.stroke(paths.roads[kind].path);
    }
    // tunnel = dimmed road, bridge = bright rails
    ctx.fillStyle = 'rgba(6,8,16,0.62)';
    ctx.fill(paths.tunnels);
    ctx.strokeStyle = 'rgba(34,227,255,0.8)';
    ctx.lineWidth = 2.5;
    ctx.stroke(paths.bridges);
  }
  const out: RoadBitmap = { canvas, pxPerM, minX: b.minX, minZ: b.minZ, width: canvas.width, height: canvas.height };
  bitmapCache.set(map, out);
  return out;
}

// -----------------------------------------------------------------------------
// Small canvas glyphs (radar blips)
// -----------------------------------------------------------------------------

/** Arrow pointing "up" (−Y) before rotation. */
export function drawArrow(ctx: CanvasRenderingContext2D, x: number, y: number, rot: number, size: number, fill: string, stroke?: string): void {
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const px = (lx: number, ly: number) => x + (lx * c - ly * s) * size;
  const py = (lx: number, ly: number) => y + (lx * s + ly * c) * size;
  ctx.beginPath();
  ctx.moveTo(px(0, -1.15), py(0, -1.15));
  ctx.lineTo(px(0.82, 0.95), py(0.82, 0.95));
  ctx.lineTo(px(0, 0.45), py(0, 0.45));
  ctx.lineTo(px(-0.82, 0.95), py(-0.82, 0.95));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

export function drawDiamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

export function drawChecker(ctx: CanvasRenderingContext2D, x: number, y: number, half: number): void {
  ctx.fillStyle = '#05060d';
  ctx.fillRect(x - half - 1, y - half - 1, half * 2 + 2, half * 2 + 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - half, y - half, half, half);
  ctx.fillRect(x, y, half, half);
}

export { TAU, tracePolyline };
