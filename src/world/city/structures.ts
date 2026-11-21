/* Tunnel, bridge, quays and piers, jump ramps, the garage. */
import type { RampInfo } from '../../core/types';
import { BAY, GARAGE_SPOT, RING, TUNNEL } from '../../core/layout';
import { box, flatQuad, quad3, rgb, wallQuad } from './batch';
import type { Batch, RGB } from './batch';
import { COLORS } from './ctx';
import type { Ctx } from './ctx';
import { PIERS, SURF } from './ground';
import { BRIDGE_LEN, BRIDGE_S0, bridgeDeckHeight, ringLateral, ringPose } from './roadPlan';
import { wideSignUV } from './look';
import { LAMP_COLORS } from './props';

const TX = -RING.half;

/** Square beam between two points (static or glow batch). */
function beam(b: Batch, ax: number, ay: number, az: number, bx: number, by: number, bz: number, half: number): void {
  let dx = bx - ax;
  let dy = by - ay;
  let dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1;
  dx /= len;
  dy /= len;
  dz /= len;
  // side vector: horizontal, perpendicular to the beam
  let sx = -dz;
  let sz = dx;
  const sl = Math.hypot(sx, sz);
  if (sl < 1e-4) {
    sx = 1;
    sz = 0;
  } else {
    sx /= sl;
    sz /= sl;
  }
  // up vector = d x s
  const ux = dy * sz;
  const uy = dz * sx - dx * sz;
  const uz = -dy * sx;
  const corner = (px: number, py: number, pz: number, a: number, c: number) => [px + (sx * a + ux * c) * half, py + uy * c * half, pz + (sz * a + uz * c) * half];
  const faces: [number, number, number, number][] = [
    [1, 1, 1, -1],
    [-1, -1, -1, 1],
    [-1, 1, 1, 1],
    [1, -1, -1, -1],
  ];
  for (const [a0, c0, a1, c1] of faces) {
    const nx = sx * (a0 + a1) * 0.5 + ux * (c0 + c1) * 0.5;
    const ny = uy * (c0 + c1) * 0.5;
    const nz = sz * (a0 + a1) * 0.5 + uz * (c0 + c1) * 0.5;
    b.normal(nx, ny, nz);
    quad3(b, corner(ax, ay, az, a0, c0), corner(ax, ay, az, a1, c1), corner(bx, by, bz, a1, c1), corner(bx, by, bz, a0, c0));
  }
}

// ---------------------------------------------------------------------------

export function buildTunnel(ctx: Ctx): void {
  const { tiles, colliders, props } = ctx;
  const hf = ctx.core.hf;
  const H = 7.4;
  const wallX = RING.width / 2 + 0.9;
  const tile: RGB = [0.2, 0.2, 0.22];
  const dark: RGB = [0.05, 0.05, 0.06];
  const lampCol = rgb(0xffb060, 3.2);
  const stripCol = rgb(0xff8a30, 1.3);
  const seg = 20;
  for (let z = TUNNEL.zFrom; z < TUNNEL.zTo; z += seg) {
    const zc = z + seg / 2;
    const b = tiles.batch('static', TX, zc);
    for (const side of [-1, 1]) {
      b.color(tile);
      wallQuad(b, TX + side * wallX, H / 2, zc, -side, 0, seg / 2, H / 2, 0.03, 0.08, 0.03, 0.08);
    }
    b.color(dark).normal(0, -1, 0);
    quad3(b, [TX - wallX, H, z], [TX + wallX, H, z], [TX + wallX, H, z + seg], [TX - wallX, H, z + seg]);
    const g = tiles.batch('glow', TX, zc);
    for (const side of [-1, 1]) {
      g.color(lampCol).anim(0, 0);
      box(g, TX + side * 4.5, H - 0.14, zc, 0.22, 0.1, 2.6, 0, true);
      g.color(stripCol);
      box(g, TX + side * (wallX - 0.06), 3.1, zc, 0.04, 0.12, seg / 2, 0, true);
    }
    const a = tiles.batch('add', TX, zc);
    a.color(rgb(0xffa040, 0.34));
    flatQuad(a, TX, 0.1, zc, 15, 11);
    if (((z - TUNNEL.zFrom) / seg) % 2 === 0) props.addLamp(TX, H - 0.8, zc, LAMP_COLORS.sodium, null);
  }
  // portals: concrete headwalls set into the hillside
  for (const [zp, facing] of [
    [TUNNEL.zFrom - 2, -1],
    [TUNNEL.zTo + 2, 1],
  ] as const) {
    let top = H + 3;
    for (let dx = -48; dx <= 48; dx += 8) top = Math.max(top, hf.sampleNatural(TX + dx, zp - facing * 4) + 1.6);
    const b = tiles.batch('static', TX, zp);
    b.color([0.16, 0.16, 0.17]);
    const wingHalf = (54 - wallX) / 2;
    for (const side of [-1, 1]) {
      const cx = TX + side * (wallX + wingHalf);
      box(b, cx, -0.5, zp, wingHalf, top + 0.5, 2, 0);
      colliders.add({ shape: 'box', x: cx, z: zp, hx: wingHalf, hz: 2, rot: 0, yMin: -1, yMax: 220, kind: 'wall' });
    }
    box(b, TX, H, zp, wallX, top - H, 2, 0, true);
    const g = tiles.batch('glow', TX, zp);
    g.color(rgb(0x22e3ff, 2.4)).anim(0, 1);
    const zf = zp + facing * 2.08;
    box(g, TX - wallX + 0.1, 0, zf, 0.14, H, 0.06, 0, true);
    box(g, TX + wallX - 0.1, 0, zf, 0.14, H, 0.06, 0, true);
    box(g, TX, H - 0.1, zf, wallX, 0.28, 0.06, 0, true);
    const s = tiles.batch('sign', TX, zp);
    s.color(rgb(0xffb040, 2.2)).anim(0.3, 0);
    const uv = wideSignUV(13);
    wallQuad(s, TX, H + 1.7, zp + facing * 2.1, 0, facing, 6, 1.5, uv[0], uv[1], uv[2], uv[3]);
  }
}

// ---------------------------------------------------------------------------

export function buildBridge(ctx: Ctx): void {
  const { tiles, colliders } = ctx;
  const pose = ringPose(0);
  const step = 12;
  const count = Math.round(BRIDGE_LEN / step);
  const ds = BRIDGE_LEN / count;
  const steel: RGB = [0.07, 0.075, 0.09];
  const SPAN = 8; // steps per arch
  const archLat = RING.width / 2 + 2.6;
  const colA = rgb(0x22e3ff, 2.6);
  const colB = rgb(0xff4fa3, 2.6);
  const at = (u: number, lat: number) => {
    ringPose(BRIDGE_S0 + u, pose);
    return { x: pose.x - pose.dz * lat, z: pose.z + pose.dx * lat, rot: Math.atan2(pose.dx, pose.dz) };
  };
  for (let i = 0; i < count; i++) {
    const u0 = i * ds;
    const u1 = u0 + ds;
    const um = (u0 + u1) / 2;
    const deck = bridgeDeckHeight(um);
    const c = at(um, 0);
    const b = tiles.batch('static', c.x, c.z);
    // deck slab
    if (deck > 0.6) {
      b.color([0.09, 0.09, 0.1]);
      box(b, c.x, deck - 1.5, c.z, RING.width / 2 + 1.6, 1.42, ds / 2 + 0.3, c.rot, true);
    }
    // piers into the water
    if (i % 5 === 2 && deck > 2.5) {
      b.color([0.12, 0.12, 0.13]);
      for (const lat of [-8, 8]) {
        const p = at(um, lat);
        box(b, p.x, BAY.level - 3, p.z, 1.6, deck - 1.5 - (BAY.level - 3), 1.6, c.rot);
        if (ringLateral(p.x, p.z) < 0) colliders.add({ shape: 'circle', x: p.x, z: p.z, hx: 0, hz: 0, rot: 0, r: 1.8, yMin: BAY.level - 3, yMax: deck - 1.5, kind: 'pillar' });
      }
    }
    // lit arches + hangers on both sides (only over the high part of the deck)
    if (deck < 3) continue;
    const k = i % SPAN;
    const rise = (q: number) => 4 * 22 * (q / SPAN) * (1 - q / SPAN);
    const d1 = bridgeDeckHeight(u1);
    const d0 = bridgeDeckHeight(u0);
    for (const side of [-1, 1]) {
      const p0 = at(u0, side * archLat);
      const p1 = at(u1, side * archLat);
      beam(b.color(steel), p0.x, d0 + rise(k) + 0.6, p0.z, p1.x, d1 + rise(k + 1) + 0.6, p1.z, 0.55);
      const g = tiles.batch('glow', p0.x, p0.z);
      g.color(Math.floor(i / SPAN) % 2 === 0 ? colA : colB).anim((i % SPAN) / SPAN, 1);
      beam(g, p0.x, d0 + rise(k) + 1.25, p0.z, p1.x, d1 + rise(k + 1) + 1.25, p1.z, 0.12);
      if (k > 0) {
        g.color(rgb(0xcfe6ff, 0.5)).anim(0, 0);
        beam(g, p0.x, d0 + 0.3, p0.z, p0.x, d0 + rise(k) + 0.4, p0.z, 0.05);
      }
      // coloured shimmer on the water below
      const a = tiles.batch('add', p0.x, p0.z);
      a.color(Math.floor(i / SPAN) % 2 === 0 ? rgb(0x22e3ff, 0.1) : rgb(0xff4fa3, 0.1));
      const w = at(um, side * (archLat + 16));
      flatQuad(a, w.x, BAY.level + 0.05, w.z, 16, ds * 0.8, c.rot);
    }
  }
}

// ---------------------------------------------------------------------------

/** Quay walls around the bay and the pier edges (colliders + low concrete walls). */
export function buildQuays(ctx: Ctx): void {
  const { tiles, colliders, props } = ctx;
  const ground = ctx.core.ground;
  const wall = (ax: number, az: number, bx: number, bz: number, waterNx: number, waterNz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / 16));
    const rot = Math.atan2(bx - ax, bz - az);
    for (let i = 0; i < n; i++) {
      const x = ax + ((bx - ax) * (i + 0.5)) / n;
      const z = az + ((bz - az) * (i + 0.5)) / n;
      const lat = ringLateral(x, z);
      const b = tiles.batch('static', x, z);
      b.color([0.1, 0.1, 0.11]);
      // quay face down to the water
      wallQuad(b, x + waterNx * 0.02, -2.4, z + waterNz * 0.02, waterNx, waterNz, len / n / 2, 2.6, 0.03, 0.08, 0.03, 0.08);
      b.color(COLORS.barrier);
      box(b, x - waterNx * 0.5, 0, z - waterNz * 0.5, 0.4, 0.85, len / n / 2, rot);
      if (lat < 0) colliders.add({ shape: 'box', x: x - waterNx * 0.5, z: z - waterNz * 0.5, hx: 0.45, hz: len / n / 2 + 0.05, rot, yMin: -4, yMax: 0.95, kind: 'wall' });
      if (i % 2 === 0 && lat < 0) {
        const g = tiles.batch('glow', x, z);
        g.color(rgb(0xffa040, 2)).anim(0, 0);
        box(g, x - waterNx * 0.5, 0.85, z - waterNz * 0.5, 0.12, 0.1, 0.12, rot);
      }
    }
  };
  // the quays stop at the highway barriers (the ring crosses them on the bridge approaches)
  const ringIn = RING.half - RING.width / 2 - 0.8;
  const ringOut = RING.half + RING.width / 2 + 0.8;
  const [pw, pn] = PIERS;
  // west quay (x = BAY.minX, water to the east) with a gap where the west pier starts
  wall(BAY.minX, BAY.minZ, BAY.minX, pw.minZ, 1, 0);
  wall(BAY.minX, pw.maxZ, BAY.minX, ringIn, 1, 0);
  wall(BAY.minX, ringOut, BAY.minX, 1300, 1, 0);
  // north quay (z = BAY.minZ, water to the south) with a gap for the north pier
  wall(BAY.minX, BAY.minZ, pn.minX, BAY.minZ, 0, 1);
  wall(pn.maxX, BAY.minZ, ringIn, BAY.minZ, 0, 1);
  wall(ringOut, BAY.minZ, 1300, BAY.minZ, 0, 1);
  // pier edges
  wall(pw.minX, pw.minZ, pw.maxX, pw.minZ, 0, -1);
  wall(pw.minX, pw.maxZ, pw.maxX, pw.maxZ, 0, 1);
  wall(pw.maxX, pw.minZ, pw.maxX, pw.maxZ, 1, 0);
  wall(pn.minX, pn.minZ, pn.minX, pn.maxZ, -1, 0);
  wall(pn.maxX, pn.minZ, pn.maxX, pn.maxZ, 1, 0);
  wall(pn.minX, pn.maxZ, pn.maxX, pn.maxZ, 0, 1);
  for (const p of PIERS) {
    const cx = (p.minX + p.maxX) / 2;
    const cz = (p.minZ + p.maxZ) / 2;
    const b = tiles.batch('ground', cx, cz);
    b.color(COLORS.apron);
    flatQuad(b, cx, -0.02, cz, (p.maxX - p.minX) / 2, (p.maxZ - p.minZ) / 2, 0, true);
    ground.paintRect(p.minX, p.minZ, p.maxX, p.maxZ, SURF.concrete);
  }
  // barrels on the piers
  for (let k = 0; k < 10; k++) {
    props.place('barrel', pw.minX + 30 + k * 16, 0, pw.maxZ - 5 - (k % 2) * 1.2);
    props.place('barrel', pn.minX + 5 + (k % 2) * 1.2, 0, pn.minZ + 30 + k * 17);
  }
}

// ---------------------------------------------------------------------------

export const RAMP_DEFS: RampInfo[] = [
  { id: 'plaza', x: 48, z: -112, heading: Math.PI / 2, length: 13, width: 8, height: 2.8 },
  { id: 'docks', x: -30, z: 560, heading: 0, length: 14, width: 8, height: 3 },
  { id: 'pier', x: 700, z: 881.5, heading: Math.PI / 2, length: 12, width: 7, height: 2.6 },
  { id: 'lanterne', x: 640, z: -225, heading: Math.PI / 2, length: 13, width: 8, height: 2.8 },
  { id: 'belvedere', x: -934, z: -100, heading: -Math.PI / 2, length: 12, width: 8, height: 2.6 },
  { id: 'piemont', x: -500, z: 760, heading: 0, length: 13, width: 8, height: 2.8 },
  { id: 'orbitale', x: 200, z: -RING.half - 8.6, heading: -Math.PI / 2, length: 14, width: 8, height: 2.6 },
  { id: 'quai-nord', x: 700, z: 622, heading: Math.PI / 2, length: 13, width: 8, height: 2.8 },
];

/** Registers the ramps in the ground model and reserves their run-up / landing corridors. */
export function registerRamps(ctx: Ctx, out: RampInfo[]): void {
  for (const r of RAMP_DEFS) {
    ctx.core.ground.addRamp(r);
    out.push({ ...r });
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    // corridor: 40 m run-up, 95 m landing
    ctx.reserved.push({ x: r.x + fx * 27, z: r.z + fz * 27, hx: r.width / 2 + 3.5, hz: 74, rot: r.heading });
  }
}

export function buildRamps(ctx: Ctx): void {
  const { tiles, colliders } = ctx;
  const ground = ctx.core.ground;
  for (const r of RAMP_DEFS) {
    const fx = Math.sin(r.heading);
    const fz = Math.cos(r.heading);
    const rx = fz;
    const rz = -fx;
    const hw = r.width / 2;
    const P = (u: number, v: number, lift: number): number[] => {
      const x = r.x + fx * (u - r.length / 2) + rx * v;
      const z = r.z + fz * (u - r.length / 2) + rz * v;
      return [x, ground.baseHeight(x, z) + (r.height * u) / r.length * lift + 0.04, z];
    };
    const b = tiles.batch('static', r.x, r.z);
    const steps = 4;
    for (let k = 0; k < steps; k++) {
      const u0 = (r.length * k) / steps;
      const u1 = (r.length * (k + 1)) / steps;
      b.color([0.06, 0.06, 0.07]).normal(0, 1, 0);
      quad3(b, P(u0, -hw, 1), P(u0, hw, 1), P(u1, hw, 1), P(u1, -hw, 1));
      b.color([0.3, 0.22, 0.03]);
      for (const side of [-1, 1]) {
        b.normal(rx * side, 0, rz * side);
        quad3(b, P(u0, hw * side, 0), P(u1, hw * side, 0), P(u1, hw * side, 1), P(u0, hw * side, 1));
        // side wall collider: top just below the ramp surface at the low end of the piece
        const lowTop = (r.height * u0) / r.length;
        if (lowTop > 0.45) {
          const c = P((u0 + u1) / 2, (hw - 0.25) * side, 0);
          colliders.add({ shape: 'box', x: c[0], z: c[2], hx: 0.2, hz: (u1 - u0) / 2, rot: r.heading, yMin: c[1] - 1.5, yMax: c[1] + lowTop - 0.12, kind: 'wall' });
        }
      }
      // glowing chevrons
      const g = tiles.batch('glow', r.x, r.z);
      g.color(rgb(0xffd000, 2.6)).anim(1 - k / steps, 4).normal(0, 1, 0);
      const um = (u0 + u1) / 2;
      for (const side of [-1, 1]) {
        const a0 = P(um - 0.9, hw * 0.75 * side, 1);
        const a1 = P(um + 0.5, 0, 1);
        const a2 = P(um + 1.2, 0, 1);
        const a3 = P(um - 0.2, hw * 0.75 * side, 1);
        for (const p of [a0, a1, a2, a3]) p[1] += 0.03;
        quad3(g, a0, a1, a2, a3);
      }
    }
    // back face + back wall
    b.color([0.3, 0.22, 0.03]).normal(fx, 0, fz);
    quad3(b, P(r.length, -hw, 0), P(r.length, hw, 0), P(r.length, hw, 1), P(r.length, -hw, 1));
    const c = P(r.length - 0.25, 0, 0);
    // Low enough that a car climbing the ramp (already > 1.3 m up when its nose reaches the lip)
    // flies over it, high enough to stop a car driving into the back of the ramp at ground level.
    colliders.add({ shape: 'box', x: c[0], z: c[2], hx: hw, hz: 0.2, rot: r.heading, yMin: c[1] - 1.5, yMax: c[1] + Math.min(1.1, r.height * 0.4), kind: 'wall' });
    // edge lights
    const g = tiles.batch('glow', r.x, r.z);
    g.color(rgb(0xff5a14, 2.4)).anim(0, 3);
    for (const side of [-1, 1]) {
      const p = P(r.length - 0.2, hw * side, 1);
      box(g, p[0], p[1], p[2], 0.12, 0.35, 0.12, r.heading, true);
    }
    const a = tiles.batch('add', r.x, r.z);
    a.color(rgb(0xffd000, 0.16));
    flatQuad(a, r.x, ground.baseHeight(r.x, r.z) + 0.12, r.z, hw + 4, r.length / 2 + 4, r.heading);
  }
}

// ---------------------------------------------------------------------------

export const GARAGE_RECT = { minX: 48, maxX: 102, minZ: 166, maxZ: 196 };

export function reserveGarage(ctx: Ctx): void {
  ctx.reserved.push({ x: GARAGE_SPOT.x, z: 178, hx: 33, hz: 24, rot: 0 });
}

export function buildGarage(ctx: Ctx): void {
  const { tiles, colliders } = ctx;
  const r = GARAGE_RECT;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  const hx = (r.maxX - r.minX) / 2;
  const hz = (r.maxZ - r.minZ) / 2;
  const H = 9.5;
  const b = tiles.batch('static', cx, cz);
  b.color([0.07, 0.075, 0.09]);
  box(b, cx, 0, cz, hx, H, hz, 0);
  b.color([0.1, 0.1, 0.12]);
  box(b, cx, H, cz, hx + 0.4, 0.5, hz + 0.4, 0, true);
  colliders.add({ shape: 'box', x: cx, z: cz, hx, hz, rot: 0, yMin: 0, yMax: H + 0.5, kind: 'building' });
  // roller door (lit) facing the street on the north side
  const zf = r.minZ - 0.06;
  const g = tiles.batch('glow', cx, zf);
  g.anim(0, 0);
  for (let k = 0; k < 11; k++) {
    g.color(rgb(0xffe2b0, k % 2 === 0 ? 1.5 : 1.05));
    wallQuad(g, GARAGE_SPOT.x, 0.25 + k * 0.5, zf, 0, -1, 6.5, 0.25);
  }
  g.color(rgb(0x22e3ff, 3)).anim(0, 1);
  box(g, GARAGE_SPOT.x - 6.8, 0, zf, 0.16, 5.9, 0.08, 0, true);
  box(g, GARAGE_SPOT.x + 6.8, 0, zf, 0.16, 5.9, 0.08, 0, true);
  box(g, GARAGE_SPOT.x, 5.7, zf, 6.96, 0.3, 0.08, 0, true);
  g.color(rgb(0xff4fa3, 2.6)).anim(0.4, 1);
  box(g, cx, H + 0.5, r.minZ - 0.3, hx + 0.4, 0.14, 0.08, 0, true);
  box(g, r.minX + 6, 0.3, zf, 0.1, 5, 0.06, 0, true);
  box(g, r.maxX - 6, 0.3, zf, 0.1, 5, 0.06, 0, true);
  const s = tiles.batch('sign', cx, zf);
  s.color(rgb(0x22e3ff, 3.2)).anim(0.1, 2);
  const uv = wideSignUV(12);
  wallQuad(s, GARAGE_SPOT.x, 7.6, zf - 0.1, 0, -1, 9, 1.45, uv[0], uv[1], uv[2], uv[3]);
  const a = tiles.batch('add', cx, zf);
  a.color(rgb(0xffe2b0, 0.4));
  flatQuad(a, GARAGE_SPOT.x, 0.12, r.minZ - 6, 10, 7);
  a.color(rgb(0x22e3ff, 0.16));
  flatQuad(a, GARAGE_SPOT.x, 0.11, GARAGE_SPOT.z, 14, 5);
}
