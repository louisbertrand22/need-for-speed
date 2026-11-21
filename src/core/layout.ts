/* =============================================================================
 * PORT-SÉLÈNE — master plan of the open world
 * -----------------------------------------------------------------------------
 * Fixed layout constants shared by the city generator (which builds it) and the
 * game modes / AI (which place events on it). See core/types.ts for conventions
 * (+X east, +Z south, heading = atan2(dx, dz)).
 *
 *                       N (-Z)
 *        ┌───────────── ring highway "L'Orbitale" ─────────────┐
 *        │ HILLS        │ LANTERN (north band)                 │
 *        │ (west band)  ├──────────────┬───────────────────────┤
 *   W    │ tunnel on    │  DOWNTOWN    │ LANTERN (east band)   │   E (+X)
 *        │ the west     │  -450..450   │                       │
 *        │ side of the  ├──────────────┴───────────┬───────────┤
 *        │ ring         │ DOCKS (south band)       │ bay/water │
 *        └──────────────────────────────────────── bridge (SE) ┘
 *                       S (+Z)
 * ===========================================================================*/
import type { DistrictId, Rect, SpawnPoint, Vec2 } from './types';

/** The playable world spans [-WORLD_HALF, WORLD_HALF] on both axes. */
export const WORLD_HALF = 1300;

export const WORLD_BOUNDS: Rect = { minX: -WORLD_HALF, maxX: WORLD_HALF, minZ: -WORLD_HALF, maxZ: WORLD_HALF };

/** City streets follow a 150 m grid (lines at every multiple of GRID_SPACING). */
export const GRID_SPACING = 150;

/** Ring highway: rounded rectangle centred on the origin. */
export const RING = {
  /** half extent of the centre line on both axes */
  half: 1100,
  /** corner radius of the centre line */
  cornerRadius: 320,
  /** full drivable width */
  width: 26,
  /** lanes per direction */
  lanes: 3,
  speedLimitKmh: 130,
} as const;

/** Highway tunnel: the west side of the ring (x = -RING.half) between these z values runs under the hills. */
export const TUNNEL = { zFrom: -520, zTo: 320 } as const;

/**
 * Bridge: the south-east corner of the ring (the whole arc plus BRIDGE.approach metres
 * on each side) crosses the bay on a deck rising smoothly to BRIDGE.deckHeight.
 */
export const BRIDGE = { deckHeight: 14, approach: 160 } as const;

/** Water (the bay) covers roughly x > BAY.minX and z > BAY.minZ, at y = BAY.level. */
export const BAY = { minX: 640, minZ: 640, level: -3 } as const;

/** Garage ("QG") spawn point: on the east-west street z = 150, between x = 0 and x = 150, facing east. */
export const GARAGE_SPOT: SpawnPoint = { x: 75, z: 150, heading: Math.PI / 2 };

export interface DistrictInfo {
  id: DistrictId;
  name: string;
  tagline: string;
  /** '#rrggbb' accent used on the map and in the HUD */
  color: string;
}

export const DISTRICTS: Record<DistrictId, DistrictInfo> = {
  downtown: { id: 'downtown', name: 'Néon Central', tagline: 'Gratte-ciels, néons et avenues à angle droit', color: '#22e3ff' },
  lantern: { id: 'lantern', name: 'Quartier Lanterne', tagline: 'Ruelles serrées et enseignes lumineuses', color: '#ff4fa3' },
  docks: { id: 'docks', name: 'Docks de Ferraille', tagline: 'Entrepôts, conteneurs et larges quais', color: '#ffb020' },
  hills: { id: 'hills', name: 'Hauts-de-Sélène', tagline: 'Lacets de montagne au-dessus de la baie', color: '#7dff6a' },
  highway: { id: 'highway', name: "L'Orbitale", tagline: 'Périphérique à haute vitesse', color: '#b48cff' },
};

/** District rectangles (the highway corridor takes precedence, see districtAt). */
export const DISTRICT_RECTS: { id: DistrictId; rect: Rect }[] = [
  { id: 'downtown', rect: { minX: -450, maxX: 450, minZ: -450, maxZ: 450 } },
  { id: 'hills', rect: { minX: -WORLD_HALF, maxX: -450, minZ: -WORLD_HALF, maxZ: WORLD_HALF } },
  { id: 'docks', rect: { minX: -450, maxX: WORLD_HALF, minZ: 450, maxZ: WORLD_HALF } },
  { id: 'lantern', rect: { minX: -450, maxX: WORLD_HALF, minZ: -WORLD_HALF, maxZ: 450 } },
];

/**
 * Centre line of the ring highway as a CLOSED polyline (last point != first point).
 * Travel order: north side heading east → east side heading south → south side heading
 * west → west side heading north (clockwise on the map).
 */
export function ringPolyline(step = 20): Vec2[] {
  const { half: H, cornerRadius: R } = RING;
  const S = H - R; // straight half length
  const pts: Vec2[] = [];
  const line = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, z: z0 + ((z1 - z0) * i) / n });
  };
  const arc = (cx: number, cz: number, a0: number, a1: number) => {
    const len = Math.abs(a1 - a0) * R;
    const n = Math.max(2, Math.round(len / step));
    for (let i = 0; i < n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R });
    }
  };
  // angles measured in the XZ plane: point = centre + (cos a, sin a) * R
  line(-S, -H, S, -H); // north side → east
  arc(S, -S, -Math.PI / 2, 0); // NE corner
  line(H, -S, H, S); // east side → south
  arc(S, S, 0, Math.PI / 2); // SE corner (bridge)
  line(S, H, -S, H); // south side → west
  arc(-S, S, Math.PI / 2, Math.PI); // SW corner
  line(-H, S, -H, -S); // west side → north (tunnel)
  arc(-S, -S, Math.PI, Math.PI * 1.5); // NW corner
  return pts;
}

/** Unsigned distance from a point to the ring centre line (analytic). */
export function distanceToRing(x: number, z: number): number {
  const { half: H, cornerRadius: R } = RING;
  const S = H - R;
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax > S && az > S) return Math.abs(Math.hypot(ax - S, az - S) - R);
  if (ax <= S && az <= S) return Math.min(H - ax, H - az);
  return ax > S ? Math.abs(ax - H) : Math.abs(az - H);
}

/** Reference implementation of the district lookup. */
export function districtAt(x: number, z: number): DistrictId {
  if (distanceToRing(x, z) < RING.width * 0.5 + 8) return 'highway';
  for (const d of DISTRICT_RECTS) {
    const r = d.rect;
    if (x >= r.minX && x < r.maxX && z >= r.minZ && z < r.maxZ) return d.id;
  }
  return 'highway';
}
