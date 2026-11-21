/* Geometry accumulation: growable vertex batches, merged per material layer and per
 * spatial tile so that frustum / distance culling works on whole chunks. */
import * as THREE from 'three';

export type LayerName = 'static' | 'ground' | 'mark' | 'glow' | 'sign' | 'add' | 'terrain';

const LAYER_ATTRS: Record<LayerName, { nor: boolean; uv: boolean; fx: boolean }> = {
  static: { nor: true, uv: true, fx: false },
  ground: { nor: true, uv: true, fx: false },
  mark: { nor: true, uv: false, fx: false },
  glow: { nor: false, uv: false, fx: true },
  sign: { nor: false, uv: true, fx: true },
  add: { nor: false, uv: true, fx: false },
  terrain: { nor: true, uv: true, fx: false },
};

// --- facade atlas layout (1024 px canvas) -------------------------------------
export const ATLAS = 1024;
export const FLOOR_PX = 32;
export const BAND_PX = 192;
export const BAND_FLOORS = 6;
/** metres per window bay / per floor on the facade bands */
export const BAY_M = 3.2;
export const FLOOR_M = 3.6;
export const PLAIN_U = 32 / ATLAS;
export const PLAIN_V = 1 - 944 / ATLAS;
/** emissive colour patches of the atlas */
export const PATCH = { sodium: 0, white: 1, cyan: 2, pink: 3, red: 4, green: 5, amber: 6 } as const;
export type PatchName = keyof typeof PATCH;
export function patchU(name: PatchName): number {
  return (576 + PATCH[name] * 64 + 32) / ATLAS;
}

export type RGB = readonly [number, number, number];
const _c = new THREE.Color();
/** sRGB hex -> linear RGB triple, optionally scaled (HDR for glow layers). */
export function rgb(hex: number, scale = 1): RGB {
  _c.setHex(hex);
  return [_c.r * scale, _c.g * scale, _c.b * scale];
}

export class Batch {
  pos = new Float32Array(3 * 256);
  nor: Float32Array | null;
  uv: Float32Array | null;
  col = new Float32Array(3 * 256);
  fx: Float32Array | null;
  idx = new Uint32Array(1024);
  nv = 0;
  ni = 0;
  // pen
  nx = 0;
  ny = 1;
  nz = 0;
  cr = 1;
  cg = 1;
  cb = 1;
  fa = 0;
  fb = 0;
  /** pen UV (defaults to the plain white texel of the atlas) */
  pu = PLAIN_U;
  pv = PLAIN_V;
  geometry: THREE.BufferGeometry | null = null;

  constructor(readonly layer: LayerName) {
    const a = LAYER_ATTRS[layer];
    this.nor = a.nor ? new Float32Array(3 * 256) : null;
    this.uv = a.uv ? new Float32Array(2 * 256) : null;
    this.fx = a.fx ? new Float32Array(2 * 256) : null;
  }

  private growV(): void {
    const cap = (this.pos.length / 3) * 2;
    const g = (a: Float32Array, k: number) => {
      const n = new Float32Array(cap * k);
      n.set(a);
      return n;
    };
    this.pos = g(this.pos, 3);
    this.col = g(this.col, 3);
    if (this.nor) this.nor = g(this.nor, 3);
    if (this.uv) this.uv = g(this.uv, 2);
    if (this.fx) this.fx = g(this.fx, 2);
  }

  color(c: RGB, scale = 1): this {
    this.cr = c[0] * scale;
    this.cg = c[1] * scale;
    this.cb = c[2] * scale;
    return this;
  }

  normal(x: number, y: number, z: number): this {
    this.nx = x;
    this.ny = y;
    this.nz = z;
    return this;
  }

  /** glow / sign animation: phase (0..1) and mode (0 steady, 1 pulse, 2 flicker, 3 blink, 4 chase, 5 slow alternate) */
  anim(phase: number, mode: number): this {
    this.fa = phase;
    this.fb = mode;
    return this;
  }

  /** Following vertices use an emissive colour patch of the atlas (lamp heads...). */
  patch(name: PatchName | null): this {
    this.pu = name ? patchU(name) : PLAIN_U;
    return this;
  }

  vert(x: number, y: number, z: number, u = this.pu, v = this.pv): number {
    if (this.nv * 3 >= this.pos.length) this.growV();
    const i = this.nv++;
    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.col[i * 3] = this.cr;
    this.col[i * 3 + 1] = this.cg;
    this.col[i * 3 + 2] = this.cb;
    if (this.nor) {
      this.nor[i * 3] = this.nx;
      this.nor[i * 3 + 1] = this.ny;
      this.nor[i * 3 + 2] = this.nz;
    }
    if (this.uv) {
      this.uv[i * 2] = u;
      this.uv[i * 2 + 1] = v;
    }
    if (this.fx) {
      this.fx[i * 2] = this.fa;
      this.fx[i * 2 + 1] = this.fb;
    }
    return i;
  }

  tri(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const n = new Uint32Array(this.idx.length * 2);
      n.set(this.idx);
      this.idx = n;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  /** Quad a-b-c-d; the winding is fixed so that the front face looks along the pen normal. */
  quad(a: number, b: number, c: number, d: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const dot = (uy * vz - uz * vy) * this.nx + (uz * vx - ux * vz) * this.ny + (ux * vy - uy * vx) * this.nz;
    if (dot >= 0) {
      this.tri(a, b, c);
      this.tri(a, c, d);
    } else {
      this.tri(a, c, b);
      this.tri(a, d, c);
    }
  }

  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos.slice(0, this.nv * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col.slice(0, this.nv * 3), 3));
    if (this.nor) g.setAttribute('normal', new THREE.BufferAttribute(this.nor.slice(0, this.nv * 3), 3));
    if (this.uv) g.setAttribute('uv', new THREE.BufferAttribute(this.uv.slice(0, this.nv * 2), 2));
    if (this.fx) g.setAttribute('fx', new THREE.BufferAttribute(this.fx.slice(0, this.nv * 2), 2));
    g.setIndex(new THREE.BufferAttribute(this.idx.slice(0, this.ni), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    this.geometry = g;
    return g;
  }
}

export interface TileInfo {
  group: THREE.Group;
  x: number;
  z: number;
  radius: number;
}

export class TileSet {
  private map = new Map<string, Batch>();
  readonly tileSize = 325;

  batch(layer: LayerName, x: number, z: number): Batch {
    const ix = Math.max(-5, Math.min(4, Math.floor(x / this.tileSize)));
    const iz = Math.max(-5, Math.min(4, Math.floor(z / this.tileSize)));
    const key = `${ix}:${iz}:${layer}`;
    let b = this.map.get(key);
    if (!b) {
      b = new Batch(layer);
      this.map.set(key, b);
    }
    return b;
  }

  build(materials: Record<LayerName, THREE.Material>, parent: THREE.Group): TileInfo[] {
    const tiles = new Map<string, TileInfo>();
    const box = new THREE.Box3();
    const sphere = new THREE.Sphere();
    for (const [key, b] of this.map) {
      if (b.ni === 0) continue;
      const [ix, iz] = key.split(':');
      const tk = `${ix}:${iz}`;
      let tile = tiles.get(tk);
      if (!tile) {
        tile = { group: new THREE.Group(), x: 0, z: 0, radius: 0 };
        tile.group.name = `tile ${tk}`;
        tiles.set(tk, tile);
        parent.add(tile.group);
      }
      const mesh = new THREE.Mesh(b.toGeometry(), materials[b.layer]);
      mesh.matrixAutoUpdate = false;
      if (b.layer === 'add') mesh.renderOrder = 2;
      tile.group.add(mesh);
    }
    const out: TileInfo[] = [];
    for (const tile of tiles.values()) {
      box.makeEmpty();
      for (const m of tile.group.children) box.union((m as THREE.Mesh).geometry.boundingBox!);
      box.getBoundingSphere(sphere);
      tile.x = sphere.center.x;
      tile.z = sphere.center.z;
      tile.radius = sphere.radius;
      tile.group.matrixAutoUpdate = false;
      out.push(tile);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Shape helpers (all use the batch pen colour)
// ---------------------------------------------------------------------------

/** Box standing on y0 (5 faces + optional bottom), yaw `rot` (heading convention), plain atlas UVs. */
export function box(b: Batch, cx: number, y0: number, cz: number, hx: number, h: number, hz: number, rot = 0, bottom = false): void {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  // local (lx, lz) -> world: X axis (cos, -sin), Z axis (sin, cos)
  const wx = (lx: number, lz: number) => cx + lx * cs + lz * sn;
  const wz = (lx: number, lz: number) => cz - lx * sn + lz * cs;
  const y1 = y0 + h;
  const face = (ax: number, az: number, bx: number, bz: number, nlx: number, nlz: number) => {
    b.normal(nlx * cs + nlz * sn, 0, -nlx * sn + nlz * cs);
    const v0 = b.vert(wx(ax, az), y0, wz(ax, az));
    const v1 = b.vert(wx(bx, bz), y0, wz(bx, bz));
    const v2 = b.vert(wx(bx, bz), y1, wz(bx, bz));
    const v3 = b.vert(wx(ax, az), y1, wz(ax, az));
    b.quad(v0, v1, v2, v3);
  };
  face(-hx, hz, hx, hz, 0, 1);
  face(hx, -hz, -hx, -hz, 0, -1);
  face(hx, hz, hx, -hz, 1, 0);
  face(-hx, -hz, -hx, hz, -1, 0);
  for (const top of bottom ? [true, false] : [true]) {
    b.normal(0, top ? 1 : -1, 0);
    const y = top ? y1 : y0;
    const v0 = b.vert(wx(-hx, -hz), y, wz(-hx, -hz));
    const v1 = b.vert(wx(hx, -hz), y, wz(hx, -hz));
    const v2 = b.vert(wx(hx, hz), y, wz(hx, hz));
    const v3 = b.vert(wx(-hx, hz), y, wz(-hx, hz));
    b.quad(v0, v1, v2, v3);
  }
}

/** Tapered n-gon column (r0 at the bottom, r1 at the top) with a cap. */
export function cyl(b: Batch, cx: number, y0: number, cz: number, r0: number, r1: number, h: number, sides = 8, cap = true): void {
  const y1 = y0 + h;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    b.normal(Math.cos(am), 0.15, Math.sin(am));
    const v0 = b.vert(cx + Math.cos(a0) * r0, y0, cz + Math.sin(a0) * r0);
    const v1 = b.vert(cx + Math.cos(a1) * r0, y0, cz + Math.sin(a1) * r0);
    const v2 = b.vert(cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1);
    const v3 = b.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1);
    b.quad(v0, v1, v2, v3);
  }
  if (cap && r1 > 0.01) {
    b.normal(0, 1, 0);
    const c = b.vert(cx, y1, cz);
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2;
      const a1 = ((i + 1) / sides) * Math.PI * 2;
      const v0 = b.vert(cx + Math.cos(a0) * r1, y1, cz + Math.sin(a0) * r1);
      const v1 = b.vert(cx + Math.cos(a1) * r1, y1, cz + Math.sin(a1) * r1);
      b.tri(c, v1, v0);
    }
  }
}

/** Free quad from 4 corners (pen normal decides the facing); optional UV rectangle. */
export function quad3(
  b: Batch,
  p0: readonly number[],
  p1: readonly number[],
  p2: readonly number[],
  p3: readonly number[],
  u0 = PLAIN_U,
  v0 = PLAIN_V,
  u1 = PLAIN_U,
  v1 = PLAIN_V,
): void {
  const a = b.vert(p0[0], p0[1], p0[2], u0, v0);
  const c = b.vert(p1[0], p1[1], p1[2], u1, v0);
  const d = b.vert(p2[0], p2[1], p2[2], u1, v1);
  const e = b.vert(p3[0], p3[1], p3[2], u0, v1);
  b.quad(a, c, d, e);
}

/** Horizontal rectangle centred on (cx, cz), half sizes along the heading frame, UV 0..1 or world-space. */
export function flatQuad(b: Batch, cx: number, y: number, cz: number, hx: number, hz: number, rot = 0, worldUv = false): void {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  b.normal(0, 1, 0);
  const corner = (lx: number, lz: number, u: number, v: number) => {
    const x = cx + lx * cs + lz * sn;
    const z = cz - lx * sn + lz * cs;
    return worldUv ? b.vert(x, y, z, x / 16, z / 16) : b.vert(x, y, z, u, v);
  };
  const v0 = corner(-hx, -hz, 0, 0);
  const v1 = corner(hx, -hz, 1, 0);
  const v2 = corner(hx, hz, 1, 1);
  const v3 = corner(-hx, hz, 0, 1);
  b.quad(v0, v1, v2, v3);
}

/**
 * Vertical quad facing (nx, nz): centre (cx, cy, cz), half width along the tangent, half height.
 * UV rectangle optional; `twoSided` adds the back face.
 */
export function wallQuad(
  b: Batch,
  cx: number,
  cy: number,
  cz: number,
  nx: number,
  nz: number,
  hw: number,
  hh: number,
  u0 = 0,
  v0 = 0,
  u1 = 1,
  v1 = 1,
  twoSided = false,
): void {
  // tangent pointing to the viewer's right when looking at the face: (nz, -nx)... for a viewer in front, right = (-nz, nx) mirrored
  const tx = -nz;
  const tz = nx;
  for (const side of twoSided ? [1, -1] : [1]) {
    b.normal(nx * side, 0, nz * side);
    const sx = tx * side;
    const sz = tz * side;
    // viewer in front of the face sees +s to the LEFT, so u runs from +s (u0) to -s (u1)
    const a = b.vert(cx + sx * hw, cy - hh, cz + sz * hw, u0, v0);
    const c = b.vert(cx - sx * hw, cy - hh, cz - sz * hw, u1, v0);
    const d = b.vert(cx - sx * hw, cy + hh, cz - sz * hw, u1, v1);
    const e = b.vert(cx + sx * hw, cy + hh, cz + sz * hw, u0, v1);
    b.quad(a, c, d, e);
  }
}

/**
 * Building volume with windowed walls from a facade band of the atlas.
 * Walls are split every BAND_FLOORS floors so each piece maps inside the band.
 */
export function facadeBox(
  b: Batch,
  cx: number,
  y0: number,
  cz: number,
  hx: number,
  h: number,
  hz: number,
  band: number,
  rng: () => number,
  floorM = FLOOR_M,
  rot = 0,
): void {
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const wx = (lx: number, lz: number) => cx + lx * cs + lz * sn;
  const wz = (lx: number, lz: number) => cz - lx * sn + lz * cs;
  const floors = Math.max(1, Math.round(h / floorM));
  const fh = h / floors;
  const bandV0 = 1 - ((band + 1) * BAND_PX) / ATLAS;
  const fv = FLOOR_PX / ATLAS;
  const face = (ax: number, az: number, bx: number, bz: number, nlx: number, nlz: number) => {
    b.normal(nlx * cs + nlz * sn, 0, -nlx * sn + nlz * cs);
    const w = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.round(w / BAY_M));
    const u0 = Math.floor(rng() * 32) * fv;
    const u1 = u0 + bays * fv;
    let f = 0;
    while (f < floors) {
      const nf = Math.min(BAND_FLOORS, floors - f);
      const f0 = Math.floor(rng() * (BAND_FLOORS - nf + 1));
      const va = bandV0 + f0 * fv;
      const vb = va + nf * fv;
      const ya = y0 + f * fh;
      const yb = ya + nf * fh;
      const v0 = b.vert(wx(ax, az), ya, wz(ax, az), u0, va);
      const v1 = b.vert(wx(bx, bz), ya, wz(bx, bz), u1, va);
      const v2 = b.vert(wx(bx, bz), yb, wz(bx, bz), u1, vb);
      const v3 = b.vert(wx(ax, az), yb, wz(ax, az), u0, vb);
      b.quad(v0, v1, v2, v3);
      f += nf;
    }
  };
  face(-hx, hz, hx, hz, 0, 1);
  face(hx, -hz, -hx, -hz, 0, -1);
  face(hx, hz, hx, -hz, 1, 0);
  face(-hx, -hz, -hx, hz, -1, 0);
  // roof
  b.normal(0, 1, 0);
  const y1 = y0 + h;
  const r0 = b.vert(wx(-hx, -hz), y1, wz(-hx, -hz));
  const r1 = b.vert(wx(hx, -hz), y1, wz(hx, -hz));
  const r2 = b.vert(wx(hx, hz), y1, wz(hx, hz));
  const r3 = b.vert(wx(-hx, hz), y1, wz(-hx, hz));
  b.quad(r0, r1, r2, r3);
}
