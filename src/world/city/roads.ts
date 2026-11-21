/* Road surfaces, markings, pavement blocks, highway barriers, street lamps, terrain mesh. */
import type { Vec2 } from '../../core/types';
import { BAY, RING, TUNNEL, districtAt } from '../../core/layout';
import { box, flatQuad, quad3, rgb, wallQuad } from './batch';
import type { RGB } from './batch';
import { COLORS } from './ctx';
import type { Block, Ctx } from './ctx';
import type { CityEdge } from './roadGraph';
import { DIAGONALS, RING_LENGTH, ROAD_SPECS, ringLateral, ringPose } from './roadPlan';
import type { GridLine } from './roadPlan';
import { SURF } from './ground';
import { HILL_EDGE_X } from './terrain';
import { LAMP_COLORS } from './props';

const ROAD_Y = 0.03;

function densify(points: Vec2[], maxSeg: number): Vec2[] {
  const out: Vec2[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / maxSeg));
    for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** Position + unit tangent at arc-length s of a polyline. */
function poseAt(pts: Vec2[], cum: ArrayLike<number>, s: number, out: { x: number; z: number; dx: number; dz: number }): void {
  let i = 0;
  const n = pts.length;
  // linear scan is fine: callers walk forward and polylines are short
  while (i + 2 < n && cum[i + 1] < s) i++;
  const a = pts[i];
  const b = pts[i + 1];
  const len = cum[i + 1] - cum[i] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i]) / len));
  out.x = a.x + (b.x - a.x) * t;
  out.z = a.z + (b.z - a.z) * t;
  out.dx = (b.x - a.x) / len;
  out.dz = (b.z - a.z) / len;
}

function isFlat(e: CityEdge): boolean {
  return e.kind !== 'hill' && e.kind !== 'highway';
}

/** Largest half width among the roads meeting at a node. */
function nodeHalfWidth(ctx: Ctx, nodeId: number): number {
  let hw = 0;
  for (const eid of ctx.graph.nodes[nodeId].edges) hw = Math.max(hw, ctx.graph.edges[eid].width / 2);
  return hw;
}

// ---------------------------------------------------------------------------
// Blocks (pavement cells between the grid streets)
// ---------------------------------------------------------------------------

export function computeBlocks(ctx: Ctx): void {
  const lines = ctx.core.plan.lines;
  const xs = new Set<number>([BAY.minX, 1078]);
  const zs = new Set<number>([BAY.minZ, -1078, 1078]);
  for (const l of lines) (l.vertical ? xs : zs).add(l.c);
  const X = [...xs].sort((a, b) => a - b);
  const Z = [...zs].sort((a, b) => a - b);
  const roadOn = (vertical: boolean, c: number, mid: number): GridLine | null => {
    for (const l of lines) if (l.vertical === vertical && l.c === c && mid > l.a && mid < l.b) return l;
    return null;
  };
  interface Cell extends Block {
    wRoad: boolean;
    nRoad: boolean;
    dead: boolean;
  }
  const cells: (Cell | null)[][] = [];
  for (let j = 0; j + 1 < Z.length; j++) {
    const row: (Cell | null)[] = [];
    for (let i = 0; i + 1 < X.length; i++) {
      const x0 = X[i];
      const x1 = X[i + 1];
      const z0 = Z[j];
      const z1 = Z[j + 1];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      if (cx > BAY.minX && cz > BAY.minZ) {
        row.push(null);
        continue;
      }
      const w = roadOn(true, x0, cz);
      const e = roadOn(true, x1, cz);
      const n = roadOn(false, z0, cx);
      const s = roadOn(false, z1, cx);
      const hw = (l: GridLine | null) => (l ? ROAD_SPECS[l.kind].width / 2 : 0);
      const cell: Cell = {
        minX: x0 + hw(w),
        maxX: x1 - hw(e),
        minZ: z0 + hw(n),
        maxZ: z1 - hw(s),
        district: districtAt(cx, cz) === 'highway' ? districtAt(cx * 0.92, cz * 0.92) : districtAt(cx, cz),
        open: false,
        wRoad: !!w,
        nRoad: !!n,
        dead: false,
      };
      // quay edges are not roads but keep an apron strip free along the water
      for (const d of DIAGONALS) {
        const mx = (d[0] + d[2]) / 2;
        const mz = (d[1] + d[3]) / 2;
        if (mx > x0 && mx < x1 && mz > z0 && mz < z1) cell.open = true;
      }
      // keep the block inside the ring (corner cells are shrunk)
      for (let guard = 0; guard < 40; guard++) {
        const worst = Math.max(
          ringLateral(cell.minX, cell.minZ),
          ringLateral(cell.maxX, cell.minZ),
          ringLateral(cell.minX, cell.maxZ),
          ringLateral(cell.maxX, cell.maxZ),
        );
        if (worst < -22) break;
        if (cx > 0) cell.maxX -= 5;
        else cell.minX += 5;
        if (cz > 0) cell.maxZ -= 5;
        else cell.minZ += 5;
      }
      row.push(cell.maxX - cell.minX > 8 && cell.maxZ - cell.minZ > 8 ? cell : null);
    }
    cells.push(row);
  }
  // merge neighbours that have no street between them (docks super-blocks)
  for (const row of cells) {
    for (let i = 1; i < row.length; i++) {
      const a = row[i - 1];
      const b = row[i];
      if (!a || !b || a.dead || b.wRoad || a.open || b.open) continue;
      if (a.minZ !== b.minZ || a.maxZ !== b.maxZ || Math.abs(a.maxX - b.minX) > 0.01) continue;
      b.minX = a.minX;
      b.wRoad = a.wRoad;
      b.nRoad = a.nRoad && b.nRoad;
      a.dead = true;
    }
  }
  for (let j = 1; j < cells.length; j++) {
    for (let i = 0; i < cells[j].length; i++) {
      const b = cells[j][i];
      if (!b || b.dead || b.nRoad || b.open) continue;
      // find the live cell right above with the same x extent
      for (const a of cells[j - 1]) {
        if (!a || a.dead || a.open) continue;
        if (a.minX === b.minX && a.maxX === b.maxX && Math.abs(a.maxZ - b.minZ) < 0.01) {
          b.minZ = a.minZ;
          b.nRoad = a.nRoad;
          a.dead = true;
          break;
        }
      }
    }
  }
  for (const row of cells) for (const c of row) if (c && !c.dead) ctx.blocks.push(c);
}

export function buildBlocks(ctx: Ctx): void {
  const ground = ctx.core.ground;
  for (const blk of ctx.blocks) {
    const cx = (blk.minX + blk.maxX) / 2;
    const cz = (blk.minZ + blk.maxZ) / 2;
    const b = ctx.tiles.batch('ground', cx, cz);
    const col: RGB = blk.open ? COLORS.plaza : blk.district === 'docks' ? COLORS.apron : COLORS.concrete;
    b.color(col);
    flatQuad(b, cx, blk.open ? -0.02 : 0.07, cz, (blk.maxX - blk.minX) / 2, (blk.maxZ - blk.minZ) / 2, 0, true);
    ground.paintRect(blk.minX, blk.minZ, blk.maxX, blk.maxZ, SURF.concrete);
  }
}

// ---------------------------------------------------------------------------
// Road ribbons + markings
// ---------------------------------------------------------------------------

export function buildRoads(ctx: Ctx): void {
  const { graph, tiles, h } = ctx;
  const pose = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const e of graph.edges) {
    const flat = isFlat(e);
    const pts = flat ? e.points : densify(e.points, e.kind === 'highway' ? 14 : 5);
    const n = pts.length;
    const hw = e.width / 2;
    const cols = e.kind === 'hill' ? 4 : e.kind === 'highway' ? 2 : 1;
    // mitred normals
    const nxs = new Float32Array(n);
    const nzs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const c = pts[Math.min(n - 1, i + 1)];
      const p = pts[i];
      let d0x = p.x - a.x;
      let d0z = p.z - a.z;
      let d1x = c.x - p.x;
      let d1z = c.z - p.z;
      const l0 = Math.hypot(d0x, d0z);
      const l1 = Math.hypot(d1x, d1z);
      if (l0 < 1e-6) {
        d0x = d1x;
        d0z = d1z;
      } else {
        d0x /= l0;
        d0z /= l0;
      }
      if (l1 < 1e-6) {
        d1x = d0x;
        d1z = d0z;
      } else {
        d1x /= l1;
        d1z /= l1;
      }
      let tx = d0x + d1x;
      let tz = d0z + d1z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      const miter = Math.min(1.4, 1 / Math.max(0.5, tx * d0x + tz * d0z));
      nxs[i] = -tz * miter;
      nzs[i] = tx * miter;
    }
    for (let i = 0; i + 1 < n; i++) {
      const a = pts[i];
      const c = pts[i + 1];
      const b = tiles.batch('ground', (a.x + c.x) / 2, (a.z + c.z) / 2);
      b.color(COLORS.asphalt).normal(0, 1, 0);
      for (let k = 0; k < cols; k++) {
        const o0 = -hw + (e.width * k) / cols;
        const o1 = -hw + (e.width * (k + 1)) / cols;
        const corner = (p: Vec2, idx: number, o: number) => {
          const x = p.x + nxs[idx] * o;
          const z = p.z + nzs[idx] * o;
          return b.vert(x, flat ? ROAD_Y : h(x, z) + 0.05, z, x / 16, z / 16);
        };
        const v0 = corner(a, i, o0);
        const v1 = corner(a, i, o1);
        const v2 = corner(c, i + 1, o1);
        const v3 = corner(c, i + 1, o0);
        b.quad(v0, v1, v2, v3);
      }
    }
    buildMarkings(ctx, e, pose);
  }
  // node patches (fill the outer corner of bends / dead ends)
  for (const node of graph.nodes) {
    const hw = nodeHalfWidth(ctx, node.id);
    const b = tiles.batch('ground', node.x, node.z);
    b.color(COLORS.asphalt).normal(0, 1, 0);
    if (node.x >= HILL_EDGE_X && Math.abs(ringLateral(node.x, node.z)) > 1) {
      flatQuad(b, node.x, ROAD_Y, node.z, hw, hw, 0, true);
    } else {
      const c = b.vert(node.x, h(node.x, node.z) + 0.05, node.z, node.x / 16, node.z / 16);
      const ring: number[] = [];
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const x = node.x + Math.cos(a) * hw;
        const z = node.z + Math.sin(a) * hw;
        ring.push(b.vert(x, h(x, z) + 0.05, z, x / 16, z / 16));
      }
      for (let k = 0; k < 10; k++) b.tri(c, ring[(k + 1) % 10], ring[k]);
    }
  }
}

function buildMarkings(ctx: Ctx, e: CityEdge, pose: { x: number; z: number; dx: number; dz: number }): void {
  const { tiles, h, graph } = ctx;
  const flat = isFlat(e);
  const hw = e.width / 2;
  const trimOf = (nodeId: number) => (graph.nodes[nodeId].edges.length > 2 ? nodeHalfWidth(ctx, nodeId) + 3.5 : 0);
  const s0 = trimOf(e.a);
  const s1 = e.length - trimOf(e.b);
  if (s1 - s0 < 4) return;
  const y = (x: number, z: number) => (flat ? ROAD_Y + 0.012 : h(x, z) + 0.065);
  /** one painted piece between arc-lengths sa..sb at a lateral offset */
  const piece = (sa: number, sb: number, lat: number, width: number, color: RGB) => {
    poseAt(e.points, e.cum, sa, pose);
    const ax = pose.x - pose.dz * lat;
    const az = pose.z + pose.dx * lat;
    const anx = -pose.dz;
    const anz = pose.dx;
    poseAt(e.points, e.cum, sb, pose);
    const bx = pose.x - pose.dz * lat;
    const bz = pose.z + pose.dx * lat;
    const bnx = -pose.dz;
    const bnz = pose.dx;
    const b = tiles.batch('mark', (ax + bx) / 2, (az + bz) / 2);
    b.color(color).normal(0, 1, 0);
    const w = width / 2;
    quad3(
      b,
      [ax - anx * w, y(ax, az), az - anz * w],
      [ax + anx * w, y(ax, az), az + anz * w],
      [bx + bnx * w, y(bx, bz), bz + bnz * w],
      [bx - bnx * w, y(bx, bz), bz - bnz * w],
    );
  };
  const line = (lat: number, width: number, color: RGB, dash = 0, gap = 0) => {
    if (dash > 0) {
      for (let s = s0 + gap * 0.5; s + dash <= s1; s += dash + gap) piece(s, s + dash, lat, width, color);
    } else {
      const step = flat ? s1 - s0 : e.kind === 'highway' ? 14 : 5;
      const cnt = Math.max(1, Math.ceil((s1 - s0) / step));
      for (let k = 0; k < cnt; k++) piece(s0 + ((s1 - s0) * k) / cnt, s0 + ((s1 - s0) * (k + 1)) / cnt, lat, width, color);
    }
  };
  const W = COLORS.markWhite;
  const Y = COLORS.markYellow;
  switch (e.kind) {
    case 'street':
      line(0, 0.18, W, 3, 6);
      break;
    case 'industrial':
      line(0, 0.2, Y, 4, 8);
      line(-hw + 0.6, 0.25, Y);
      line(hw - 0.6, 0.25, Y);
      break;
    case 'avenue':
      line(-0.22, 0.16, Y);
      line(0.22, 0.16, Y);
      line(-5, 0.16, W, 3, 7);
      line(5, 0.16, W, 3, 7);
      line(-hw + 0.5, 0.16, W);
      line(hw - 0.5, 0.16, W);
      break;
    case 'hill':
      line(-0.2, 0.14, Y);
      line(0.2, 0.14, Y);
      line(-hw + 0.4, 0.16, W);
      line(hw - 0.4, 0.16, W);
      break;
    case 'highway': {
      const lane = e.width / 6;
      line(-0.25, 0.2, Y);
      line(0.25, 0.2, Y);
      for (const k of [1, 2]) {
        line(-lane * k, 0.18, W, 4, 10);
        line(lane * k, 0.18, W, 4, 10);
      }
      line(-hw + 0.5, 0.22, W);
      line(hw - 0.5, 0.22, W);
      break;
    }
    default:
      break;
  }
  // stop lines + zebra crossings in the dense districts
  if ((e.kind === 'street' || e.kind === 'avenue') && e.district !== 'docks' && e.district !== 'hills') {
    for (const end of [0, 1]) {
      const nodeId = end === 0 ? e.a : e.b;
      if (graph.nodes[nodeId].edges.length < 3) continue;
      const trim = trimOf(nodeId);
      const sStop = end === 0 ? trim + 0.4 : e.length - trim - 0.4;
      const dir = end === 0 ? 1 : -1;
      piece(sStop, sStop + 0.5 * dir, 0, e.width - 1, W);
      const bars = Math.floor((e.width - 1.5) / 1.3);
      for (let k = 0; k < bars; k++) {
        const lat = -hw + 1.2 + k * 1.3;
        piece(sStop - 0.9 * dir, sStop - 3.2 * dir, lat, 0.6, W);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Ring highway barriers (colliders + visuals) and its lamp masts
// ---------------------------------------------------------------------------

export function buildRingBarriers(ctx: Ctx): void {
  const { colliders, tiles, h, props } = ctx;
  const pose = ringPose(0);
  const lat = RING.width / 2 + 0.6;
  const gaps = ctx.core.plan.ringJunctions.map((j) => ({ s: j.s, half: j.halfWidth + 3 }));
  const inGap = (s: number) => gaps.some((g) => Math.abs(((s - g.s + RING_LENGTH * 1.5) % RING_LENGTH) - RING_LENGTH / 2) < g.half);
  const step = 12;
  const count = Math.round(RING_LENGTH / step);
  const ds = RING_LENGTH / count;
  const neonIn = rgb(0x22e3ff, 1.6);
  const neonOut = rgb(0xff9a30, 1.5);
  for (let i = 0; i < count; i++) {
    const s = (i + 0.5) * ds;
    ringPose(s, pose);
    const rot = Math.atan2(pose.dx, pose.dz);
    const rx = -pose.dz;
    const rz = pose.dx; // right = inner side
    const inTunnel = pose.x < -1000 && pose.z >= TUNNEL.zFrom - 1 && pose.z <= TUNNEL.zTo + 1;
    for (const side of [1, -1]) {
      if (side === 1 && inGap(s)) continue;
      if (inTunnel) {
        // tunnel side walls double as the trench walls (nothing can drop in from the hill)
        const x = pose.x + rx * side * 16.75;
        const z = pose.z + rz * side * 16.75;
        colliders.add({ shape: 'box', x, z, hx: 3.25, hz: ds / 2 + 0.1, rot, yMin: -1, yMax: 220, kind: 'wall' });
        continue;
      }
      const x = pose.x + rx * side * lat;
      const z = pose.z + rz * side * lat;
      const y = h(pose.x, pose.z);
      colliders.add({ shape: 'box', x, z, hx: 0.35, hz: ds / 2 + 0.15, rot, yMin: y - 1.2, yMax: y + 1.15, kind: 'barrier' });
      const b = tiles.batch('static', x, z);
      b.color(COLORS.barrier);
      box(b, x, y, z, 0.3, 0.9, ds / 2 + 0.2, rot);
      const g = tiles.batch('glow', x, z);
      g.color(side === 1 ? neonIn : neonOut).anim(0, 0);
      box(g, x, y + 0.9, z, 0.06, 0.07, ds / 2 + 0.2, rot);
    }
    // lamp masts on the outer side
    if (i % 5 === 0 && !inTunnel) {
      const mx = pose.x - rx * (lat + 1.4);
      const mz = pose.z - rz * (lat + 1.4);
      const y = h(pose.x, pose.z);
      const b = tiles.batch('static', mx, mz);
      b.color(rgb(0x1c1f26));
      box(b, mx, y, mz, 0.16, 12, 0.16, rot);
      box(b, mx + rx * 3, y + 11.8, mz + rz * 3, 3, 0.16, 0.1, rot);
      b.color([1, 1, 1]).patch('sodium');
      box(b, mx + rx * 6, y + 11.5, mz + rz * 6, 0.9, 0.2, 0.35, rot, true);
      b.patch(null);
      lampGlow(ctx, pose.x - rx * 5, y, pose.z - rz * 5, mx + rx * 6, y + 11.4, mz + rz * 6, rot, LAMP_COLORS.sodium, 15, null);
      props.addLamp(mx + rx * 6, y + 11, mz + rz * 6, LAMP_COLORS.sodium, null);
    }
  }
}

/** Fake light: additive pool + wet streak on the road and a halo around the lamp head. */
function lampGlow(
  ctx: Ctx,
  px: number,
  py: number,
  pz: number,
  hx: number,
  hy: number,
  hz: number,
  rot: number,
  color: number,
  size: number,
  rec: import('./props').PropRec | null,
): void {
  const a = ctx.tiles.batch('add', px, pz);
  const start = a.nv;
  a.color(rgb(color, 0.3));
  flatQuad(a, px, py + 0.09, pz, size, size, rot);
  a.color(rgb(color, 0.11));
  flatQuad(a, px, py + 0.1, pz, 1.6, size * 2.2, rot);
  a.color(rgb(color, 0.32));
  wallQuad(a, hx, hy, hz, Math.sin(rot), Math.cos(rot), 1.1, 1.1, 0, 0, 1, 1);
  wallQuad(a, hx, hy, hz, Math.cos(rot), -Math.sin(rot), 1.1, 1.1, 0, 0, 1, 1);
  if (rec) ctx.props.track(rec, a, start);
}

export function buildStreetLamps(ctx: Ctx): void {
  const { graph, props, h } = ctx;
  const pose = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const e of graph.edges) {
    if (e.kind === 'highway') continue;
    const hw = e.width / 2;
    const spacing = e.kind === 'hill' ? 58 : e.kind === 'industrial' ? 50 : 37.5;
    const name =
      e.district === 'docks' ? 'lamp-sodium' : e.district === 'hills' ? 'lamp-white' : e.kind === 'avenue' ? 'lamp-cyan' : e.district === 'lantern' ? 'lamp-pink' : 'lamp-white';
    const color = LAMP_COLORS[name.slice(5)];
    const height = name === 'lamp-pink' ? 6 : name === 'lamp-cyan' ? 9 : 8.5;
    const arm = name === 'lamp-pink' ? 1.6 : name === 'lamp-cyan' ? 3 : 2.6;
    const trimA = nodeHalfWidth(ctx, e.a) + 7;
    const trimB = nodeHalfWidth(ctx, e.b) + 7;
    let k = 0;
    for (let s = spacing / 2; s < e.length; s += spacing, k++) {
      if (s < trimA || s > e.length - trimB) continue;
      const sides = e.kind === 'avenue' ? [1, -1] : [k % 2 === 0 ? 1 : -1];
      for (const side of sides) {
        poseAt(e.points, e.cum, s, pose);
        const rx = -pose.dz * side;
        const rz = pose.dx * side;
        const x = pose.x + rx * (hw + 1.1);
        const z = pose.z + rz * (hw + 1.1);
        if (ctx.isReserved(x, z, 1.5)) continue;
        if (graph.clearance(x, z, 6, e.id) < 0.8) continue;
        const y = h(x, z);
        const rot = Math.atan2(-rx, -rz); // arm towards the road
        const rec = props.place(name, x, y, z, rot);
        const headX = x - rx * arm;
        const headZ = z - rz * arm;
        lampGlow(ctx, pose.x + rx * (hw - 3.2), h(pose.x, pose.z), pose.z + rz * (hw - 3.2), headX, y + height - 0.4, headZ, Math.atan2(pose.dx, pose.dz), color, name === 'lamp-pink' ? 7 : 9.5, rec);
        props.addLamp(headX, y + height - 0.8, headZ, color, rec);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Terrain mesh (adaptive: 8 m blocks where the field is planar, 4 m cells elsewhere)
// ---------------------------------------------------------------------------

export function buildTerrain(ctx: Ctx): void {
  const hf = ctx.core.hf;
  const n = hf.n;
  const iMax = Math.round((HILL_EDGE_X - hf.origin) / hf.cell); // 212
  const vis = (i: number, j: number) => hf.visualAt(Math.min(n - 1, Math.max(0, i)), Math.min(n - 1, Math.max(0, j)));
  const px = (i: number) => hf.origin + i * hf.cell;
  const GRASS: RGB = [0.016, 0.034, 0.02];
  const DIRT: RGB = [0.06, 0.048, 0.036];
  const ROCK: RGB = [0.075, 0.075, 0.085];
  const portalRow = (j: number) => {
    const z0 = px(j);
    return z0 === TUNNEL.zFrom - hf.cell || z0 === TUNNEL.zTo;
  };
  const skipCell = (i: number, j: number) => portalRow(j) && Math.abs(px(i) + 2 + RING.half) < 54;
  const nearTunnel = (i: number, j: number) => {
    const x = px(i);
    const z = px(j);
    return Math.abs(x + RING.half) < 64 && z > TUNNEL.zFrom - 16 && z < TUNNEL.zTo + 16;
  };
  const vert = (b: import('./batch').Batch, i: number, j: number): number => {
    const y = vis(i, j);
    const gx = (vis(i + 1, j) - vis(i - 1, j)) / (2 * hf.cell);
    const gz = (vis(i, j + 1) - vis(i, j - 1)) / (2 * hf.cell);
    const slope = Math.hypot(gx, gz);
    const inv = 1 / Math.sqrt(gx * gx + gz * gz + 1);
    b.normal(-gx * inv, inv, -gz * inv);
    const k = Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i));
    const cw = hf.carveW[k];
    const rock = Math.min(1, Math.max(0, (slope - 0.38) * 4));
    const dirt = Math.min(1, cw * 1.2) * (1 - rock);
    const gr = 1 - rock - dirt;
    const tint = 0.85 + 0.3 * (((i * 7 + j * 13) % 5) / 5);
    b.cr = (GRASS[0] * gr + DIRT[0] * dirt + ROCK[0] * rock) * tint;
    b.cg = (GRASS[1] * gr + DIRT[1] * dirt + ROCK[1] * rock) * tint;
    b.cb = (GRASS[2] * gr + DIRT[2] * dirt + ROCK[2] * rock) * tint;
    return b.vert(px(i), y, px(j), px(i) / 12, px(j) / 12);
  };
  const up = (b: import('./batch').Batch, a: number, c: number, d: number) => {
    // emit with upward winding
    const p = b.pos;
    const cross = (p[c * 3 + 2] - p[a * 3 + 2]) * (p[d * 3] - p[a * 3]) - (p[c * 3] - p[a * 3]) * (p[d * 3 + 2] - p[a * 3 + 2]);
    if (cross >= 0) b.tri(a, c, d);
    else b.tri(a, d, c);
  };
  for (let bj = 0; bj < (n - 1) / 2; bj++) {
    for (let bi = 0; bi < iMax / 2; bi++) {
      const i0 = bi * 2;
      const j0 = bj * 2;
      // far outside the ring: nothing can be seen up close, keep it coarse
      let fine = false;
      if (px(i0) > -1200) {
        const c00 = vis(i0, j0);
        const c20 = vis(i0 + 2, j0);
        const c02 = vis(i0, j0 + 2);
        const c22 = vis(i0 + 2, j0 + 2);
        const dev = Math.max(
          Math.abs(vis(i0 + 1, j0) - (c00 + c20) / 2),
          Math.abs(vis(i0, j0 + 1) - (c00 + c02) / 2),
          Math.abs(vis(i0 + 2, j0 + 1) - (c20 + c22) / 2),
          Math.abs(vis(i0 + 1, j0 + 2) - (c02 + c22) / 2),
          Math.abs(vis(i0 + 1, j0 + 1) - (c00 + c20 + c02 + c22) / 4),
        );
        fine = dev > 0.07 || nearTunnel(i0 + 1, j0 + 1);
      }
      const b = ctx.tiles.batch('terrain', px(i0 + 1), px(j0 + 1));
      if (fine) {
        for (let dj = 0; dj < 2; dj++) {
          for (let di = 0; di < 2; di++) {
            const i = i0 + di;
            const j = j0 + dj;
            if (skipCell(i, j)) continue;
            const a = vert(b, i, j);
            const c = vert(b, i + 1, j);
            const d = vert(b, i + 1, j + 1);
            const e = vert(b, i, j + 1);
            up(b, a, c, d);
            up(b, a, d, e);
          }
        }
      } else {
        const a = vert(b, i0, j0);
        const c = vert(b, i0 + 2, j0);
        const d = vert(b, i0 + 2, j0 + 2);
        const e = vert(b, i0, j0 + 2);
        up(b, a, c, d);
        up(b, a, d, e);
      }
    }
  }
  // skirt: the plateau continues west beyond the heightfield, into the haze
  for (let j = 0; j + 8 < n; j += 8) {
    const b = ctx.tiles.batch('terrain', hf.origin, px(j + 4));
    const a = vert(b, 0, j);
    const c = vert(b, 0, j + 8);
    b.normal(0, 1, 0);
    b.cr = GRASS[0];
    b.cg = GRASS[1];
    b.cb = GRASS[2];
    const d = b.vert(-2500, vis(0, j + 8) * 0.7, px(j + 8), 0, 0);
    const e = b.vert(-2500, vis(0, j) * 0.7, px(j), 0, 0);
    up(b, a, c, d);
    up(b, a, d, e);
  }
}
