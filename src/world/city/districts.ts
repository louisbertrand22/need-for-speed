/* Buildings and district dressing: Néon Central, Quartier Lanterne, Docks de Ferraille,
 * Hauts-de-Sélène, plus the dark skyline beyond the ring. */
import { BAY, RING, TUNNEL } from '../../core/layout';
import { ATLAS, box, cyl, facadeBox, flatQuad, quad3, rgb, wallQuad } from './batch';
import type { Batch, RGB } from './batch';
import type { Block, Ctx } from './ctx';
import type { PadDef } from './core';
import type { CityRoadGraph } from './roadGraph';
import { ringLateral } from './roadPlan';
import { bigSignUV, tallSignUV, wideSignUV } from './look';
import { HILL_EDGE_X } from './terrain';

const NEON = [0x22e3ff, 0xff4fa3, 0xb48cff, 0xffb020, 0x7dff6a, 0xff3b3b, 0x4f8cff, 0xfff0a0];
const LANTERN_NEON = [0xff4fa3, 0xff3b3b, 0xffb020, 0xffd76a, 0xff7a3c, 0x22e3ff, 0xff5fd0];

function pickN<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

/** A footprint is usable when it is clear of roads, reserved zones and the ring. */
function footprintOk(ctx: Ctx, cx: number, cz: number, hx: number, hz: number, roadMargin = 2.5): boolean {
  for (const [sx, sz] of [
    [0, 0],
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    const x = cx + sx * hx;
    const z = cz + sz * hz;
    if (ctx.isReserved(x, z, 1)) return false;
    if (ringLateral(x, z) > -(RING.width / 2 + 6)) return false;
    if (ctx.graph.clearance(x, z, roadMargin + 1) < roadMargin) return false;
  }
  return true;
}

function addBuildingCollider(ctx: Ctx, cx: number, cz: number, hx: number, hz: number, y0: number, y1: number): void {
  ctx.colliders.add({ shape: 'box', x: cx, z: cz, hx, hz, rot: 0, yMin: y0, yMax: y1, kind: 'building' });
}

/** Thin neon tube box in the glow layer. */
function neonBox(ctx: Ctx, cx: number, y0: number, cz: number, hx: number, h: number, hz: number, color: number, power: number, mode = 0, phase = 0): void {
  const g = ctx.tiles.batch('glow', cx, cz);
  g.color(rgb(color, power)).anim(phase, mode);
  box(g, cx, y0, cz, hx, h, hz, 0, true);
}

/** Neon tube running around a rectangular footprint (roof edges, setbacks, shop bands). */
function neonRing(ctx: Ctx, cx: number, y0: number, cz: number, hx: number, h: number, hz: number, color: number, power: number, mode = 0, phase = 0): void {
  const g = ctx.tiles.batch('glow', cx, cz);
  g.color(rgb(color, power)).anim(phase, mode);
  const t = Math.min(0.16, h);
  box(g, cx, y0, cz + hz, hx, h, t, 0, true);
  box(g, cx, y0, cz - hz, hx, h, t, 0, true);
  box(g, cx + hx, y0, cz, t, h, hz, 0, true);
  box(g, cx - hx, y0, cz, t, h, hz, 0, true);
}

/** Sign quad on a facade + its fake reflection on the wet ground in front. */
function facadeSign(
  ctx: Ctx,
  x: number,
  y: number,
  z: number,
  nx: number,
  nz: number,
  hw: number,
  hh: number,
  uv: [number, number, number, number],
  color: number,
  power: number,
  mode: number,
): void {
  const s = ctx.tiles.batch('sign', x, z);
  s.color(rgb(color, power)).anim(ctx.rng(), mode);
  wallQuad(s, x + nx * 0.25, y, z + nz * 0.25, nx, nz, hw, hh, uv[0], uv[1], uv[2], uv[3]);
  const a = ctx.tiles.batch('add', x, z);
  a.color(rgb(color, 0.1 + Math.min(0.14, hw * 0.012)));
  const rot = Math.atan2(nx, nz);
  flatQuad(a, x + nx * (6 + hh), 0.12, z + nz * (6 + hh), hw * 1.1, 8 + hh * 2, rot);
}

// ---------------------------------------------------------------------------
// Néon Central
// ---------------------------------------------------------------------------

function tower(ctx: Ctx, cx: number, cz: number, hx: number, hz: number, height: number): void {
  const { rng, tiles } = ctx;
  const b = tiles.batch('static', cx, cz);
  const band = rng() < 0.4 ? 3 : rng() < 0.6 ? 0 : 1;
  const shade = 0.35 + rng() * 0.5;
  const tint: RGB = [shade * (0.8 + rng() * 0.3), shade * (0.85 + rng() * 0.2), shade * (0.9 + rng() * 0.3)];
  const neon = pickN(rng, NEON);
  const style = rng();
  let top = height;
  let thx = hx;
  let thz = hz;
  b.color(tint);
  if (style < 0.4 && height > 70) {
    // setbacks
    const h1 = height * (0.5 + rng() * 0.15);
    const h2 = height * 0.3;
    facadeBox(b, cx, 0, cz, hx, h1, hz, band, rng);
    facadeBox(b, cx, h1, cz, hx * 0.72, h2, hz * 0.72, band, rng);
    thx = hx * 0.45;
    thz = hz * 0.45;
    facadeBox(b, cx, h1 + h2, cz, thx, height - h1 - h2, thz, band, rng);
    neonRing(ctx, cx, h1, cz, hx + 0.15, 0.35, hz + 0.15, neon, 2.2, 1, rng());
    neonRing(ctx, cx, h1 + h2, cz, hx * 0.72 + 0.15, 0.35, hz * 0.72 + 0.15, neon, 2.2, 1, rng());
  } else if (style < 0.6) {
    // podium + slab
    const hp = 14 + rng() * 8;
    facadeBox(b, cx, 0, cz, hx, hp, hz, 1, rng);
    thx = hx * (0.55 + rng() * 0.2);
    thz = hz * (0.55 + rng() * 0.2);
    facadeBox(b, cx, hp, cz, thx, height - hp, thz, band, rng);
    neonRing(ctx, cx, hp, cz, hx + 0.15, 0.4, hz + 0.15, neon, 2.4, 0);
  } else {
    facadeBox(b, cx, 0, cz, hx, height, hz, band, rng);
  }
  // crown
  const crown = rng();
  if (crown < 0.45) {
    neonRing(ctx, cx, top - 0.5, cz, thx + 0.2, 0.6, thz + 0.2, neon, 2.8, 1, rng());
  } else if (crown < 0.7) {
    b.color([0.05, 0.05, 0.06]);
    box(b, cx, top, cz, thx * 0.6, 4, thz * 0.6);
    neonRing(ctx, cx, top + 3.6, cz, thx * 0.6 + 0.1, 0.4, thz * 0.6 + 0.1, neon, 3, 0);
    top += 4;
  }
  if (height > 110 || rng() < 0.3) {
    // antenna / spire with a red beacon
    const sh = 12 + rng() * 26;
    b.color([0.08, 0.08, 0.09]);
    cyl(b, cx, top, cz, 0.5, 0.1, sh, 4, false);
    neonBox(ctx, cx, top + sh, cz, 0.35, 0.7, 0.35, 0xff2020, 4, 3, rng());
    top += sh;
  }
  // vertical neon edges
  if (rng() < 0.45) {
    for (const [sx, sz] of [
      [1, 1],
      [-1, -1],
    ]) {
      neonBox(ctx, cx + sx * (hx + 0.1), 3, cz + sz * (hz + 0.1), 0.14, Math.min(height, 90) * (0.5 + rng() * 0.5), 0.14, neon, 2.4, rng() < 0.2 ? 2 : 0, rng());
    }
  }
  // big billboard on one face
  if (rng() < 0.5) {
    const side = Math.floor(rng() * 4);
    const nx = [1, -1, 0, 0][side];
    const nz = [0, 0, 1, -1][side];
    const w = Math.min(nx !== 0 ? hz : hx, 13) * 0.9;
    const y = 14 + rng() * Math.min(40, height * 0.3);
    facadeSign(ctx, cx + nx * hx, y, cz + nz * hz, nx, nz, w, w * 0.5, bigSignUV(Math.floor(rng() * 4)), pickN(rng, NEON), 2.3, rng() < 0.3 ? 1 : 0);
  }
  // street-level shop band glow
  neonRing(ctx, cx, 4.2, cz, hx + 0.12, 0.22, hz + 0.12, neon, 1.8, 0);
  addBuildingCollider(ctx, cx, cz, hx, hz, 0, height);
}

function downtownBlock(ctx: Ctx, blk: Block): void {
  const { rng } = ctx;
  const inset = 4.5;
  const x0 = blk.minX + inset;
  const x1 = blk.maxX - inset;
  const z0 = blk.minZ + inset;
  const z1 = blk.maxZ - inset;
  const nx = x1 - x0 > 95 ? (rng() < 0.3 ? 3 : 2) : 1;
  const nz = z1 - z0 > 95 ? (rng() < 0.3 ? 3 : 2) : 1;
  const cw = (x1 - x0) / nx;
  const cd = (z1 - z0) / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const gap = 3 + rng() * 4;
      const hx = cw / 2 - gap;
      const hz = cd / 2 - gap;
      if (hx < 7 || hz < 7) continue;
      const cx = x0 + (i + 0.5) * cw;
      const cz = z0 + (j + 0.5) * cd;
      if (!footprintOk(ctx, cx, cz, hx, hz)) continue;
      const d = Math.hypot(cx, cz);
      let height = (210 - d * 0.27) * (0.5 + rng() * 0.6);
      if (d < 200 && rng() < 0.4) height = 170 + rng() * 50;
      height = Math.max(40, Math.min(220, height));
      tower(ctx, cx, cz, hx, hz, height);
    }
  }
}

// ---------------------------------------------------------------------------
// Quartier Lanterne
// ---------------------------------------------------------------------------

function lanternHouse(ctx: Ctx, cx: number, cz: number, hx: number, hz: number, nx: number, nz: number): void {
  const { rng, tiles } = ctx;
  if (!footprintOk(ctx, cx, cz, hx, hz)) return;
  const height = 8 + rng() * rng() * 27;
  const b = tiles.batch('static', cx, cz);
  const warm = rng();
  b.color([0.38 + warm * 0.4, 0.3 + warm * 0.22, 0.28 + rng() * 0.2]);
  facadeBox(b, cx, 0, cz, hx, height, hz, rng() < 0.75 ? 2 : 1, rng, 3.3);
  addBuildingCollider(ctx, cx, cz, hx, hz, 0, height);
  // street face: storefront strip, awning, signs
  const fx = cx + nx * hx;
  const fz = cz + nz * hz;
  const w = nx !== 0 ? hz : hx;
  const neon = pickN(rng, LANTERN_NEON);
  b.color([1, 1, 1]);
  const u0 = Math.floor(rng() * 16) * (64 / ATLAS);
  wallQuad(b, fx + nx * 0.06, 2, fz + nz * 0.06, nx, nz, w - 0.4, 2, u0, 1 - 864 / ATLAS, u0 + (Math.round((w * 2) / 4) * 64) / ATLAS, 1 - 768 / ATLAS);
  b.color(rgb(neon, 0.25));
  b.normal(0, 1, 0);
  const tx = -nz;
  const tz = nx;
  quad3(
    b,
    [fx - tx * w, 4.3, fz - tz * w],
    [fx + tx * w, 4.3, fz + tz * w],
    [fx + tx * w + nx * 1.6, 3.7, fz + tz * w + nz * 1.6],
    [fx - tx * w + nx * 1.6, 3.7, fz - tz * w + nz * 1.6],
  );
  const a = tiles.batch('add', fx, fz);
  a.color(rgb(0xffc890, 0.2));
  flatQuad(a, fx + nx * 3, 0.13, fz + nz * 3, w, 4.5, Math.atan2(nx, nz));
  if (rng() < 0.7) {
    // vertical sign sticking out of the facade
    const sh = Math.min(height * 0.36, 5.5);
    const off = (rng() - 0.5) * w * 1.2;
    const sx = fx + tx * off + nx * 1.1;
    const sz = fz + tz * off + nz * 1.1;
    const s = tiles.batch('sign', sx, sz);
    const uv = tallSignUV(Math.floor(rng() * 16));
    s.color(rgb(neon, 2.6)).anim(rng(), rng() < 0.18 ? 2 : 0);
    wallQuad(s, sx, 5 + sh, sz, tx, tz, sh * 0.26, sh, uv[0], uv[1], uv[2], uv[3], true);
    const ar = tiles.batch('add', sx, sz);
    ar.color(rgb(neon, 0.14));
    flatQuad(ar, sx + nx * 5, 0.12, sz + nz * 5, 2.2, 9, Math.atan2(nx, nz));
  }
  if (rng() < 0.45 && w > 6) {
    facadeSign(ctx, fx, 5.4, fz, nx, nz, Math.min(w - 1, 5), Math.min(w - 1, 5) * 0.25, wideSignUV(Math.floor(rng() * 16)), pickN(rng, LANTERN_NEON), 2.4, rng() < 0.2 ? 2 : 0);
  }
  if (rng() < 0.3) neonRing(ctx, cx, height - 0.3, cz, hx + 0.1, 0.25, hz + 0.1, neon, 2, 0);
}

function lanternBlock(ctx: Ctx, blk: Block): void {
  const { rng } = ctx;
  const inset = 3.2;
  const x0 = blk.minX + inset;
  const x1 = blk.maxX - inset;
  const z0 = blk.minZ + inset;
  const z1 = blk.maxZ - inset;
  if (x1 - x0 < 30 || z1 - z0 < 30) return;
  const depth = Math.min(21, (Math.min(x1 - x0, z1 - z0) - 8) / 2);
  const row = (a: number, c: number, fixed: number, alongX: boolean, n: number) => {
    let p = a;
    while (p < c - 9) {
      let w = 13 + rng() * 11;
      if (c - (p + w) < 10) w = c - p;
      const mid = p + w / 2;
      const hw = w / 2 - 0.35;
      if (alongX) lanternHouse(ctx, mid, fixed + (n * -depth) / 2, hw, depth / 2, 0, n);
      else lanternHouse(ctx, fixed + (n * -depth) / 2, mid, depth / 2, hw, n, 0);
      p += w;
    }
  };
  row(x0, x1, z0, true, -1); // north row faces north
  row(x0, x1, z1, true, 1);
  row(z0 + depth + 1, z1 - depth - 1, x0, false, -1);
  row(z0 + depth + 1, z1 - depth - 1, x1, false, 1);
}

/** Strings of lanterns across some Lanterne streets. */
function lanternStrings(ctx: Ctx): void {
  const { rng, graph, tiles } = ctx;
  for (const e of graph.edges) {
    if (e.district !== 'lantern' || e.kind !== 'street' || e.points.length !== 2 || rng() > 0.4) continue;
    const a = e.points[0];
    const c = e.points[1];
    const dx = (c.x - a.x) / e.length;
    const dz = (c.z - a.z) / e.length;
    for (const t of [0.3, 0.5, 0.7]) {
      const mx = a.x + (c.x - a.x) * t;
      const mz = a.z + (c.z - a.z) * t;
      const g = tiles.batch('glow', mx, mz);
      const col = pickN(rng, [0xff3b3b, 0xffb020, 0xff4fa3]);
      for (let k = -4; k <= 4; k++) {
        const lat = k * 2.1;
        const sag = 7.6 - 1.3 * (1 - (k * k) / 16);
        g.color(rgb(col, 2.2)).anim(rng(), 1);
        box(g, mx - dz * lat, sag, mz + dx * lat, 0.22, 0.42, 0.22, 0, true);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Docks de Ferraille
// ---------------------------------------------------------------------------

/** Box with corrugated walls (warehouses, containers). */
function corrBox(b: Batch, cx: number, y0: number, cz: number, hx: number, h: number, hz: number): void {
  const y1 = y0 + h;
  const face = (ax: number, az: number, bx: number, bz: number, nx: number, nz: number) => {
    b.normal(nx, 0, nz);
    const w = Math.hypot(bx - ax, bz - az);
    const u0 = 66 / ATLAS;
    const u1 = (66 + Math.min(376, w * 10)) / ATLAS;
    const v0 = b.vert(ax, y0, az, u0, 0.01);
    const v1 = b.vert(bx, y0, bz, u1, 0.01);
    const v2 = b.vert(bx, y1, bz, u1, 0.15);
    const v3 = b.vert(ax, y1, az, u0, 0.15);
    b.quad(v0, v1, v2, v3);
  };
  face(cx - hx, cz + hz, cx + hx, cz + hz, 0, 1);
  face(cx + hx, cz - hz, cx - hx, cz - hz, 0, -1);
  face(cx + hx, cz + hz, cx + hx, cz - hz, 1, 0);
  face(cx - hx, cz - hz, cx - hx, cz + hz, -1, 0);
  flatQuad(b, cx, y1, cz, hx, hz);
}

const CONTAINER_COLORS: RGB[] = [
  [0.3, 0.06, 0.04],
  [0.04, 0.12, 0.3],
  [0.05, 0.22, 0.12],
  [0.35, 0.2, 0.03],
  [0.2, 0.2, 0.22],
  [0.28, 0.1, 0.02],
];

function docksYard(ctx: Ctx, x0: number, z0: number, x1: number, z1: number): void {
  const { rng, tiles, colliders, props } = ctx;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const w = x1 - x0;
  const d = z1 - z0;
  const kind = rng();
  const b = tiles.batch('static', cx, cz);
  if (kind < 0.42) {
    // warehouse with sodium wall lights
    const hx = w / 2 - 9;
    const hz = d / 2 - 9;
    if (hx < 8 || hz < 8 || !footprintOk(ctx, cx, cz, hx, hz)) return;
    const h = 10 + rng() * 6;
    const g = 0.14 + rng() * 0.16;
    b.color([g, g * 0.95, g * 0.9]);
    corrBox(b, cx, 0, cz, hx, h, hz);
    b.color([0.07, 0.07, 0.08]);
    box(b, cx, h, cz, hx * 0.3, 2.2, hz * 0.9);
    addBuildingCollider(ctx, cx, cz, hx, hz, 0, h + 2.2);
    for (const [nx, nz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const half = nx !== 0 ? hz : hx;
      for (let t = -half + 8; t < half - 4; t += 22) {
        const lx = cx + nx * (hx + 0.2) + (nx === 0 ? t : 0);
        const lz = cz + nz * (hz + 0.2) + (nz === 0 ? t : 0);
        neonBox(ctx, lx, h - 2.6, lz, 0.3, 0.3, 0.3, 0xffa040, 3.2, 0);
        const a = tiles.batch('add', lx, lz);
        a.color(rgb(0xffa040, 0.2));
        flatQuad(a, lx + nx * 5, 0.12, lz + nz * 5, 7, 7);
      }
    }
    // roller doors
    b.color([0.25, 0.22, 0.12]);
    wallQuad(b, cx, 3, cz + hz + 0.08, 0, 1, Math.min(5, hx * 0.5), 3, 450 / ATLAS, 0.02, 574 / ATLAS, 0.14);
  } else if (kind < 0.82) {
    // container stacks in rows
    for (let rz = z0 + 10; rz + 3 < z1 - 8; rz += 9) {
      let px = x0 + 10;
      while (px + 13 < x1 - 8) {
        const len = rng() < 0.3 ? 6.1 : 12.2;
        if (rng() < 0.78) {
          const levels = 1 + Math.floor(rng() * rng() * 4);
          const ccx = px + len / 2;
          const ccz = rz + 1.3;
          if (footprintOk(ctx, ccx, ccz, len / 2, 1.3, 3)) {
            for (let l = 0; l < levels; l++) {
              b.color(pickN(rng, CONTAINER_COLORS));
              corrBox(b, ccx, l * 2.6, ccz, len / 2 - 0.05, 2.55, 1.22);
            }
            colliders.add({ shape: 'box', x: ccx, z: ccz, hx: len / 2, hz: 1.25, rot: 0, yMin: 0, yMax: levels * 2.6, kind: levels > 1 ? 'wall' : 'barrier' });
          }
        }
        px += len + 0.6 + (rng() < 0.15 ? 9 : 0);
      }
    }
  } else {
    // tank farm
    const r = Math.min(9, Math.min(w, d) / 2 - 12);
    if (r < 4) return;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const tx = cx + (i - 0.5) * Math.min(w - 2 * r - 20, 3 * r);
        const tz = cz + (j - 0.5) * Math.min(d - 2 * r - 20, 3 * r);
        if (!footprintOk(ctx, tx, tz, r, r)) continue;
        const h = 9 + rng() * 9;
        b.color([0.2, 0.2, 0.21]);
        cyl(b, tx, 0, tz, r, r, h, 14);
        colliders.add({ shape: 'circle', x: tx, z: tz, hx: 0, hz: 0, rot: 0, r, yMin: 0, yMax: h, kind: 'building' });
        neonBox(ctx, tx, h, tz, 0.3, 0.6, 0.3, 0xff2020, 3.5, 3, rng());
        neonBox(ctx, tx + r + 0.1, h * 0.5, tz, 0.08, h * 0.5, 0.08, 0xffa040, 1.6, 0);
      }
    }
  }
  // loose barrels / cones on the apron edges
  for (let k = 0; k < 3; k++) {
    const px = x0 + 4 + rng() * (w - 8);
    const pz = rng() < 0.5 ? z0 + 3.5 : z1 - 3.5;
    if (ctx.isReserved(px, pz, 2) || ctx.graph.clearance(px, pz, 4) < 1.5) continue;
    props.place(rng() < 0.6 ? 'barrel' : 'cone', px, 0, pz);
  }
}

function docksBlock(ctx: Ctx, blk: Block): void {
  const w = blk.maxX - blk.minX;
  const d = blk.maxZ - blk.minZ;
  if (w < 44 || d < 44) return; // narrow quay aprons stay open
  const nx = Math.max(1, Math.round(w / 95));
  const nz = Math.max(1, Math.round(d / 95));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      docksYard(ctx, blk.minX + (w * i) / nx, blk.minZ + (d * j) / nz, blk.minX + (w * (i + 1)) / nx, blk.minZ + (d * (j + 1)) / nz);
    }
  }
}

/** Gantry cranes on the quays (solid legs, red beacons, floodlights). */
function cranes(ctx: Ctx): void {
  const { tiles, colliders } = ctx;
  for (const [cx, cz, alongX] of [
    [622, 760, false],
    [624, 1010, false],
    [1000, 624, true],
  ] as const) {
    const b = tiles.batch('static', cx, cz);
    b.color([0.3, 0.16, 0.03]);
    const span = 11;
    for (const s of [-1, 1]) {
      for (const t of [-1, 1]) {
        const lx = cx + (alongX ? t * 7 : s * span);
        const lz = cz + (alongX ? s * span : t * 7);
        if (ctx.graph.clearance(lx, lz, 4) < 1.5) continue;
        box(b, lx, 0, lz, 0.7, 30, 0.7);
        colliders.add({ shape: 'circle', x: lx, z: lz, hx: 0, hz: 0, rot: 0, r: 1, yMin: 0, yMax: 30, kind: 'pillar' });
      }
    }
    box(b, cx, 30, cz, alongX ? 9 : span + 2, 3, alongX ? span + 2 : 9, 0, true);
    // boom reaching over the water
    if (alongX) box(b, cx, 33, cz + 22, 2, 2.2, 34, 0, true);
    else box(b, cx + 22, 33, cz, 34, 2.2, 2, 0, true);
    neonBox(ctx, cx, 35.2, cz, 0.4, 0.8, 0.4, 0xff2020, 4, 3, 0.2);
    neonBox(ctx, cx + (alongX ? 0 : 54), 35.2, cz + (alongX ? 54 : 0), 0.4, 0.8, 0.4, 0xff2020, 4, 3, 0.7);
    neonBox(ctx, cx, 29.4, cz, alongX ? 8 : 1, 0.3, alongX ? 1 : 8, 0xffe0b0, 3, 0);
    const a = tiles.batch('add', cx, cz);
    a.color(rgb(0xffd0a0, 0.22));
    flatQuad(a, cx, 0.12, cz, 20, 20);
  }
}

// ---------------------------------------------------------------------------
// Hauts-de-Sélène
// ---------------------------------------------------------------------------

export const LOOKOUT = { x: -926, z: -104, radius: 24 };

/** Flat pads carved into the hills: the summit lookout + villa plots along the roads. */
export function makeHillPads(graph: CityRoadGraph): PadDef[] {
  const pads: PadDef[] = [{ x: LOOKOUT.x, z: LOOKOUT.z, radius: LOOKOUT.radius }];
  const hill = graph.edges.filter((e) => e.kind === 'hill');
  // [edge index among hill edges, fraction along, side]
  const spots: [number, number, number][] = [
    [1, 0.5, 1],
    [2, 0.3, -1],
    [2, 0.72, 1],
    [5, 0.35, 1],
    [5, 0.7, -1],
    [8, 0.3, -1],
    [8, 0.62, 1],
    [9, 0.25, 1],
    [9, 0.55, 1],
    [9, 0.8, 1],
    [3, 0.12, 1],
    [6, 0.1, -1],
  ];
  for (const [ei, f, side] of spots) {
    const e = hill[ei];
    if (!e) continue;
    const s = e.length * f;
    let i = 0;
    while (i + 2 < e.points.length && e.cum[i + 1] < s) i++;
    const a = e.points[i];
    const c = e.points[i + 1];
    const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
    const x = a.x - ((c.z - a.z) / len) * side * 27;
    const z = a.z + ((c.x - a.x) / len) * side * 27;
    if (graph.clearance(x, z, 30) < 16) continue;
    if (Math.hypot(x - LOOKOUT.x, z - LOOKOUT.z) < 60) continue;
    if (x < -1040 && z > TUNNEL.zFrom - 30 && z < TUNNEL.zTo + 30) continue;
    pads.push({ x, z, radius: 14 });
  }
  return pads;
}

function hills(ctx: Ctx): void {
  const { rng, tiles, colliders, h, graph } = ctx;
  const hf = ctx.core.hf;
  // lookout: observatory dome + radio mast
  {
    const y = h(LOOKOUT.x, LOOKOUT.z);
    const ox = LOOKOUT.x + 4;
    const oz = LOOKOUT.z + 14;
    const b = tiles.batch('static', ox, oz);
    b.color([0.3, 0.3, 0.33]);
    cyl(b, ox, y, oz, 6, 6, 5, 12);
    b.color([0.5, 0.5, 0.55]);
    cyl(b, ox, y + 5, oz, 6, 3.4, 3, 12, false);
    cyl(b, ox, y + 8, oz, 3.4, 0.3, 1.6, 12);
    colliders.add({ shape: 'circle', x: ox, z: oz, hx: 0, hz: 0, rot: 0, r: 6.2, yMin: y - 1, yMax: y + 10, kind: 'building' });
    neonRing(ctx, ox, y + 4.9, oz, 6.1, 0.2, 6.1, 0x22e3ff, 2, 1);
    const mx = LOOKOUT.x - 6;
    const mz = LOOKOUT.z - 17;
    b.color([0.12, 0.12, 0.13]);
    cyl(b, mx, y, mz, 1.1, 0.25, 64, 4, false);
    colliders.add({ shape: 'circle', x: mx, z: mz, hx: 0, hz: 0, rot: 0, r: 1.3, yMin: y - 1, yMax: y + 64, kind: 'pillar' });
    for (const hh of [20, 42, 64]) neonBox(ctx, mx, y + hh, mz, 0.4, 0.8, 0.4, 0xff2020, 4.5, 3, hh / 64);
    const a = tiles.batch('add', LOOKOUT.x, LOOKOUT.z);
    a.color(rgb(0x9fd8ff, 0.16));
    flatQuad(a, LOOKOUT.x, y + 0.12, LOOKOUT.z, 22, 22);
  }
  // villas on their pads
  for (const pad of ctx.core.pads) {
    if (pad.radius > 20) continue;
    const y = pad.h;
    const hx = 6 + rng() * 2.5;
    const hz = 4.5 + rng() * 2;
    if (ctx.isReserved(pad.x, pad.z, 12)) continue;
    const b = tiles.batch('static', pad.x, pad.z);
    b.color([0.5, 0.48, 0.44]);
    facadeBox(b, pad.x, y, pad.z, hx, 3.6, hz, 1, rng);
    b.color([0.4, 0.4, 0.42]);
    facadeBox(b, pad.x - hx * 0.3, y + 3.6, pad.z, hx * 0.6, 3.6, hz * 0.8, 3, rng);
    b.color([0.06, 0.06, 0.07]);
    box(b, pad.x, y + 3.6, pad.z, hx + 0.8, 0.25, hz + 0.8, 0, true);
    colliders.add({ shape: 'box', x: pad.x, z: pad.z, hx: hx + 0.5, hz: hz + 0.5, rot: 0, yMin: y - 2, yMax: y + 7.5, kind: 'building' });
    neonRing(ctx, pad.x, y + 3.85, pad.z, hx + 0.85, 0.1, hz + 0.85, 0xffd9a0, 1.8, 0);
    const a = tiles.batch('add', pad.x, pad.z);
    a.color(rgb(0xffc890, 0.16));
    flatQuad(a, pad.x, y + 0.14, pad.z, 13, 13);
  }
  // pines
  const trunk: RGB = [0.05, 0.035, 0.025];
  let placed = 0;
  for (let attempt = 0; attempt < 5200 && placed < 1500; attempt++) {
    const x = -1084 + rng() * (HILL_EDGE_X - 8 + 1084);
    const z = -1080 + rng() * 2160;
    if (ringLateral(x, z) > -24) continue;
    if (x < -1052 && z > TUNNEL.zFrom - 40 && z < TUNNEL.zTo + 40) continue;
    if (hf.carveW[Math.round((z - hf.origin) / hf.cell) * hf.n + Math.round((x - hf.origin) / hf.cell)] > 0.12) continue;
    if (graph.clearance(x, z, 9) < 7 || ctx.isReserved(x, z, 3)) continue;
    const y = h(x, z);
    if (Math.abs(h(x + 3, z) - y) > 1.6 || Math.abs(h(x, z + 3) - y) > 1.6) continue;
    // denser groves driven by a cheap pattern
    if ((Math.sin(x * 0.021) + Math.sin(z * 0.017 + 1.3)) * 0.5 + rng() * 0.9 < 0.35) continue;
    const s = 0.8 + rng() * 0.9;
    const b = tiles.batch('static', x, z);
    b.color(trunk);
    cyl(b, x, y - 0.3, z, 0.22 * s, 0.16 * s, 2.3 * s, 4, false);
    const gcol = 0.02 + rng() * 0.02;
    b.color([gcol * 0.7, gcol * 1.6, gcol]);
    cyl(b, x, y + 1.6 * s, z, 1.9 * s, 0.9 * s, 2.6 * s, 6, false);
    cyl(b, x, y + 3.8 * s, z, 1.3 * s, 0, 3.4 * s, 6, false);
    colliders.add({ shape: 'circle', x, z, hx: 0, hz: 0, rot: 0, r: 0.4, yMin: y - 1, yMax: y + 6 * s, kind: 'pillar' });
    placed++;
  }
  // reflective delineators + hairpin chevrons along the hill roads
  for (const e of graph.edges) {
    if (e.kind !== 'hill') continue;
    const pts = e.points;
    for (let i = 3; i + 3 < pts.length; i += 3) {
      const p = pts[i];
      const q = pts[i + 1];
      const o = pts[i - 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const dx = (q.x - p.x) / len;
      const dz = (q.z - p.z) / len;
      const turn = (p.x - o.x) * (q.z - p.z) - (p.z - o.z) * (q.x - p.x);
      for (const side of [-1, 1]) {
        const x = p.x - dz * side * (e.width / 2 + 0.75);
        const z = p.z + dx * side * (e.width / 2 + 0.75);
        if (graph.clearance(x, z, 3, e.id) < 1) continue;
        const y = h(x, z);
        const g = tiles.batch('glow', x, z);
        const sharp = Math.abs(turn) > 2.2 && Math.sign(turn) === -side;
        if (sharp) {
          g.color(rgb(0xffd000, 2.4)).anim((i % 12) / 12, 4);
          box(g, x, y + 0.9, z, 0.07, 0.55, 0.5, Math.atan2(dx, dz), true);
        } else {
          g.color(rgb(side > 0 ? 0xffffff : 0xffb020, 1.5)).anim(0, 0);
          box(g, x, y + 0.55, z, 0.05, 0.14, 0.05, 0, true);
        }
      }
    }
  }
}

/** Guard rails on the outside of hill bends and above steep drops (colliders + W-beams). */
export function buildGuardRails(ctx: Ctx): void {
  const { graph, tiles, colliders, h } = ctx;
  for (const e of graph.edges) {
    if (e.kind !== 'hill') continue;
    const pts = e.points;
    const lat = e.width / 2 + 1.0;
    for (let i = 1; i + 1 < pts.length; i++) {
      const p = pts[i];
      const q = pts[i + 1];
      const o = pts[i - 1];
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      if (len < 0.5) continue;
      const dx = (q.x - p.x) / len;
      const dz = (q.z - p.z) / len;
      const mx = (p.x + q.x) / 2;
      const mz = (p.z + q.z) / 2;
      const yRoad = h(mx, mz);
      const turn = ((p.x - o.x) * (q.z - p.z) - (p.z - o.z) * (q.x - p.x)) / (len * len);
      for (const side of [-1, 1]) {
        const nx = -dz * side;
        const nz = dx * side;
        const drop = yRoad - Math.min(h(mx + nx * (lat + 9), mz + nz * (lat + 9)), h(mx + nx * (lat + 17), mz + nz * (lat + 17)));
        // turn > 0 = bending towards +right (side 1), so the outside is side -1
        const outside = Math.abs(turn) > 0.014 && Math.sign(turn) === -side;
        if (drop < 2.2 && !outside) continue;
        const x = mx + nx * lat;
        const z = mz + nz * lat;
        if (graph.clearance(x, z, 4, e.id) < 2.2 || ctx.isReserved(x, z, 0.5)) continue;
        const half = len / 2 + 0.25;
        if (graph.clearance(x + dx * half, z + dz * half, 4, e.id) < 1.3 || graph.clearance(x - dx * half, z - dz * half, 4, e.id) < 1.3) continue;
        const rot = Math.atan2(dx, dz);
        colliders.add({ shape: 'box', x, z, hx: 0.22, hz: len / 2 + 0.25, rot, yMin: yRoad - 2.5, yMax: yRoad + 0.95, kind: 'barrier' });
        const b = tiles.batch('static', x, z);
        b.color([0.26, 0.27, 0.29]);
        box(b, x, yRoad + 0.42, z, 0.06, 0.34, len / 2 + 0.25, rot, true);
        box(b, x, yRoad - 0.4, z, 0.07, 0.85, 0.07, rot);
      }
    }
  }
}

// ---------------------------------------------------------------------------

function backdrop(ctx: Ctx): void {
  const { rng, tiles } = ctx;
  for (let k = 0; k < 130; k++) {
    const along = -1250 + rng() * 2500;
    const out = RING.half + 55 + rng() * 150;
    const side = Math.floor(rng() * 3);
    const x = side === 0 ? along : side === 1 ? out : along;
    const z = side === 0 ? -out : side === 1 ? along : out;
    if (x < -420 || (x > BAY.minX - 60 && z > BAY.minZ - 60)) continue;
    if (ringLateral(x, z) < 40) continue;
    const hx = 12 + rng() * 16;
    const hz = 12 + rng() * 16;
    const height = side === 2 ? 14 + rng() * 30 : 30 + rng() * rng() * 130;
    const b = tiles.batch('static', x, z);
    const g = 0.25 + rng() * 0.3;
    b.color([g, g, g * 1.1]);
    facadeBox(b, x, 0, z, hx, height, hz, Math.floor(rng() * 4), rng);
    if (rng() < 0.4) neonRing(ctx, x, height - 0.5, z, hx + 0.2, 0.5, hz + 0.2, pickN(rng, NEON), 2.2, 0);
    if (height > 90) neonBox(ctx, x, height + 0.5, z, 0.4, 0.8, 0.4, 0xff2020, 4, 3, rng());
  }
}

/** Small street furniture on the pavements of the dense districts. */
function furniture(ctx: Ctx): void {
  const { rng, props, graph } = ctx;
  for (const e of graph.edges) {
    if (e.points.length !== 2 || (e.kind !== 'street' && e.kind !== 'avenue')) continue;
    if (e.district !== 'downtown' && e.district !== 'lantern') continue;
    const a = e.points[0];
    const c = e.points[1];
    const dx = (c.x - a.x) / e.length;
    const dz = (c.z - a.z) / e.length;
    const n = 2 + Math.floor(rng() * 3);
    for (let k = 0; k < n; k++) {
      const s = 22 + rng() * (e.length - 44);
      const side = rng() < 0.5 ? 1 : -1;
      const lat = e.width / 2 + 1.5 + rng() * 0.8;
      const x = a.x + dx * s - dz * side * lat;
      const z = a.z + dz * s + dx * side * lat;
      if (x < -452 || ctx.isReserved(x, z, 1.5) || graph.clearance(x, z, 3, e.id) < 1.2) continue;
      const name = pickN(rng, ['bin', 'hydrant', 'bench', 'sign', 'cone', 'bin']);
      props.place(name, x, 0, z, Math.atan2(dx, dz) + (name === 'bench' ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : 0));
    }
    // traffic signals at the busy ends
    for (const [nodeId, s] of [
      [e.a, 1],
      [e.b, -1],
    ] as const) {
      const node = graph.nodes[nodeId];
      if (node.edges.length < 4 || (e.kind !== 'avenue' && rng() < 0.6)) continue;
      let hwN = 0;
      for (const eid of node.edges) hwN = Math.max(hwN, graph.edges[eid].width / 2);
      const x = node.x + dx * s * (hwN + 2.2) - dz * -s * (e.width / 2 + 1.2);
      const z = node.z + dz * s * (hwN + 2.2) + dx * -s * (e.width / 2 + 1.2);
      if (ctx.isReserved(x, z, 1.5) || graph.clearance(x, z, 3) < 0.9) continue;
      props.place('signal', x, 0, z, Math.atan2(dx * s, dz * s));
    }
  }
}

export function buildDistricts(ctx: Ctx): void {
  for (const blk of ctx.blocks) {
    if (blk.open) continue;
    if (blk.district === 'downtown') downtownBlock(ctx, blk);
    else if (blk.district === 'lantern') lanternBlock(ctx, blk);
    else if (blk.district === 'docks') docksBlock(ctx, blk);
  }
  lanternStrings(ctx);
  cranes(ctx);
  hills(ctx);
  backdrop(ctx);
  furniture(ctx);
}
