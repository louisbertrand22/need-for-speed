/* =============================================================================
 * Procedural geometry toolkit shared by every model builder.
 *
 *  - `GeoBuilder`: triangle soup with per-triangle colour / surface parameters,
 *    creased smooth normals and conversion to a (non-indexed) BufferGeometry.
 *  - `pchip`: monotone cubic interpolation for profile curves.
 *  - `RefCache`: reference-counted cache for GPU resources shared by instances.
 * ===========================================================================*/
import * as THREE from 'three';

export type P3 = readonly [number, number, number];
export type P2 = readonly [number, number];

/** UV of the solid white texel block of the shared parts atlas (see atlas.ts). */
export const WHITE_UV: P2 = [0.016, 0.984];

// -----------------------------------------------------------------------------
// Curves
// -----------------------------------------------------------------------------

/** Monotone cubic (Fritsch–Carlson) interpolation through `pts` (sorted by x). Clamped outside. */
export function pchip(pts: readonly P2[]): (x: number) => number {
  const n = pts.length;
  if (n === 1) {
    const c = pts[0][1];
    return () => c;
  }
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = pts[i][0];
    ys[i] = pts[i][1];
  }
  const h = new Float64Array(n - 1);
  const dl = new Float64Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = Math.max(1e-9, xs[i + 1] - xs[i]);
    dl[i] = (ys[i + 1] - ys[i]) / h[i];
  }
  const d = new Float64Array(n);
  d[0] = dl[0];
  d[n - 1] = dl[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (dl[i - 1] * dl[i] <= 0) d[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / dl[i - 1] + w2 / dl[i]);
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const t = (x - xs[lo]) / h[lo];
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] +
      (t3 - 2 * t2 + t) * h[lo] * d[lo] +
      (-2 * t3 + 3 * t2) * ys[lo + 1] +
      (t3 - t2) * h[lo] * d[lo + 1]
    );
  };
}

/** n+1 values from a to b. mode 'cos' clusters samples toward both ends, 'in' toward a, 'out' toward b. */
export function samples(a: number, b: number, n: number, mode: 'lin' | 'cos' | 'in' | 'out' = 'lin'): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) {
    let t = i / n;
    if (mode === 'cos') t = 0.5 - 0.5 * Math.cos(Math.PI * t);
    else if (mode === 'in') t = 1 - Math.cos((Math.PI / 2) * t);
    else if (mode === 'out') t = Math.sin((Math.PI / 2) * t);
    out.push(a + (b - a) * t);
  }
  return out;
}

export function smoothstep01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

// -----------------------------------------------------------------------------
// Triangle soup builder
// -----------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _c = new THREE.Color();

export interface BuildOptions {
  /** crease angle in degrees: edges sharper than this stay hard (default 38) */
  crease?: number;
  /** emit the `color` attribute (default true) */
  color?: boolean;
  /** emit the `aMat` attribute: (roughness [negative = rim-tinted], metalness, emissive channel, damage part) */
  mat?: boolean;
  /** emit `uv` (default true) */
  uv?: boolean;
}

export class GeoBuilder {
  private pos: number[] = [];
  private uvs: number[] = [];
  private cols: number[] = [];
  private mats: number[] = [];
  private cr = 1;
  private cg = 1;
  private cb = 1;
  private rough = 0.5;
  private metal = 0;
  private chan = 0;
  private part = 0;
  private matrix: THREE.Matrix4 | null = null;
  private flip = false;

  get triangleCount(): number {
    return this.pos.length / 9;
  }

  /** Linear-space vertex colour from an sRGB hex / css colour. */
  color(c: THREE.ColorRepresentation): this {
    _c.set(c);
    this.cr = _c.r;
    this.cg = _c.g;
    this.cb = _c.b;
    return this;
  }

  /** roughness / metalness for the following triangles. `tinted` = multiplied by the material tint uniform (rims). */
  surface(roughness: number, metalness: number, tinted = false): this {
    this.rough = tinted ? -Math.max(0.02, roughness) : Math.max(0.02, roughness);
    this.metal = metalness;
    return this;
  }

  /** emissive channel (0 = none) */
  channel(ch: number): this {
    this.chan = ch;
    return this;
  }

  /** damage part id (0 body, 1 hood, 2 front bumper, 3 rear bumper) */
  setPart(p: number): this {
    this.part = p;
    return this;
  }

  /** Shorthand: colour + surface + channel 0. */
  paint(c: THREE.ColorRepresentation, roughness: number, metalness: number, tinted = false): this {
    return this.color(c).surface(roughness, metalness, tinted).channel(0);
  }

  /** Transform applied to every vertex added afterwards (null = identity). */
  setTransform(m: THREE.Matrix4 | null): this {
    this.matrix = m ? m.clone() : null;
    this.flip = m ? m.determinant() < 0 : false;
    return this;
  }

  private pushVertex(p: P3, uv: P2): void {
    if (this.matrix) {
      _v.set(p[0], p[1], p[2]).applyMatrix4(this.matrix);
      this.pos.push(_v.x, _v.y, _v.z);
    } else {
      this.pos.push(p[0], p[1], p[2]);
    }
    this.uvs.push(uv[0], uv[1]);
    this.cols.push(this.cr, this.cg, this.cb);
    this.mats.push(this.rough, this.metal, this.chan, this.part);
  }

  tri(a: P3, b: P3, c: P3, ua: P2 = WHITE_UV, ub: P2 = WHITE_UV, uc: P2 = WHITE_UV): void {
    if (this.flip) {
      this.pushVertex(a, ua);
      this.pushVertex(c, uc);
      this.pushVertex(b, ub);
    } else {
      this.pushVertex(a, ua);
      this.pushVertex(b, ub);
      this.pushVertex(c, uc);
    }
  }

  /** Counter-clockwise quad a → b → c → d. */
  quad(a: P3, b: P3, c: P3, d: P3, ua: P2 = WHITE_UV, ub: P2 = WHITE_UV, uc: P2 = WHITE_UV, ud: P2 = WHITE_UV): void {
    this.tri(a, b, c, ua, ub, uc);
    this.tri(a, c, d, ua, uc, ud);
  }

  /**
   * Grid of points rows[j][i]. Front face = counter-clockwise for (j, i) → (j, i+1) → (j+1, i+1).
   * `uvOf(j, i)` optionally provides texture coordinates.
   */
  grid(rows: readonly (readonly P3[])[], reverse = false, uvOf?: (j: number, i: number) => P2): void {
    for (let j = 0; j < rows.length - 1; j++) {
      const r0 = rows[j];
      const r1 = rows[j + 1];
      const n = Math.min(r0.length, r1.length);
      for (let i = 0; i < n - 1; i++) {
        const a = r0[i];
        const b = r0[i + 1];
        const c = r1[i + 1];
        const d = r1[i];
        if (uvOf) {
          const ua = uvOf(j, i);
          const ub = uvOf(j, i + 1);
          const uc = uvOf(j + 1, i + 1);
          const ud = uvOf(j + 1, i);
          if (reverse) this.quad(a, d, c, b, ua, ud, uc, ub);
          else this.quad(a, b, c, d, ua, ub, uc, ud);
        } else if (reverse) this.quad(a, d, c, b);
        else this.quad(a, b, c, d);
      }
    }
  }

  /** Axis-aligned box centred on (cx, cy, cz) (before the current transform). */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]); // +z
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]); // -z
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]); // +x
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]); // -x
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]); // +y
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]); // -y
  }

  /**
   * Hexahedron from two quads (bottom a0..a3 and top b0..b3, both counter-clockwise seen from
   * outside of the TOP face). Handy for tapered blocks, wing planks, spokes.
   */
  hexa(a: readonly [P3, P3, P3, P3], b: readonly [P3, P3, P3, P3]): void {
    this.quad(b[0], b[1], b[2], b[3]);
    this.quad(a[3], a[2], a[1], a[0]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.quad(a[i], a[j], b[j], b[i]);
    }
  }

  /** Imports a three.js geometry (disposed afterwards). `m` is applied before the builder transform. */
  addGeometry(geom: THREE.BufferGeometry, m?: THREE.Matrix4, useUv = false): void {
    const g = geom.index ? geom.toNonIndexed() : geom;
    if (m) g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const uv = useUv ? g.getAttribute('uv') : null;
    const flipped = m ? m.determinant() < 0 : false;
    for (let i = 0; i + 2 < p.count; i += 3) {
      const a: P3 = [p.getX(i), p.getY(i), p.getZ(i)];
      const b: P3 = [p.getX(i + 1), p.getY(i + 1), p.getZ(i + 1)];
      const c: P3 = [p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)];
      if (uv) {
        const ua: P2 = [uv.getX(i), uv.getY(i)];
        const ub: P2 = [uv.getX(i + 1), uv.getY(i + 1)];
        const uc: P2 = [uv.getX(i + 2), uv.getY(i + 2)];
        if (flipped) this.tri(a, c, b, ua, uc, ub);
        else this.tri(a, b, c, ua, ub, uc);
      } else if (flipped) this.tri(a, c, b);
      else this.tri(a, b, c);
    }
    if (g !== geom) g.dispose();
    geom.dispose();
  }

  /** Surface of revolution around the X axis: profile = [x, radius] pairs. */
  latheX(profile: readonly P2[], segments: number, cx = 0, cy = 0, cz = 0, reverse = false): void {
    const rows: P3[][] = [];
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      rows.push(profile.map(([x, r]) => [cx + x, cy + r * ca, cz + r * sa] as P3));
    }
    this.grid(rows, reverse);
  }

  /** Surface of revolution around the Y axis: profile = [radius, y] pairs. */
  latheY(profile: readonly P2[], segments: number, cx = 0, cy = 0, cz = 0, reverse = false): void {
    const rows: P3[][] = [];
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      rows.push(profile.map(([r, y]) => [cx + r * sa, cy + y, cz + r * ca] as P3));
    }
    this.grid(rows, reverse);
  }

  /** Round tube along a polyline. */
  tube(path: readonly P3[], radius: number, radialSegments = 6, closed = false): void {
    const pts = path.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
    const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
    this.addGeometry(new THREE.TubeGeometry(curve, Math.max(2, (pts.length - 1) * 3), radius, radialSegments, closed));
  }

  /** Extrudes a 2D polygon (counter-clockwise in the (a, b) plane) along `depth`, mapped to 3D by `map`. */
  prism(poly: readonly P2[], d0: number, d1: number, map: (a: number, b: number, d: number) => P3): void {
    const contour = poly.map((p) => new THREE.Vector2(p[0], p[1]));
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const cw = THREE.ShapeUtils.isClockWise(contour);
    for (const t of tris) {
      const [i0, i1, i2] = cw ? [t[0], t[2], t[1]] : [t[0], t[1], t[2]];
      this.tri(map(poly[i0][0], poly[i0][1], d1), map(poly[i1][0], poly[i1][1], d1), map(poly[i2][0], poly[i2][1], d1));
      this.tri(map(poly[i0][0], poly[i0][1], d0), map(poly[i2][0], poly[i2][1], d0), map(poly[i1][0], poly[i1][1], d0));
    }
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0 = map(poly[i][0], poly[i][1], d0);
      const b0 = map(poly[j][0], poly[j][1], d0);
      const a1 = map(poly[i][0], poly[i][1], d1);
      const b1 = map(poly[j][0], poly[j][1], d1);
      if (cw) this.quad(a0, a1, b1, b0);
      else this.quad(a0, b0, b1, a1);
    }
  }

  /**
   * Duplicates every triangle added since `fromTriangle` mirrored through the YZ plane (x → -x).
   * `flipU(u)` lets textured patches (text) stay readable on the mirrored side.
   */
  mirrorX(fromTriangle = 0, remapUv?: (u: number, v: number) => P2): void {
    const start = fromTriangle * 9;
    const end = this.pos.length;
    for (let i = start; i < end; i += 9) {
      const t = i / 9;
      for (const k of [0, 2, 1]) {
        const pi = i + k * 3;
        this.pos.push(-this.pos[pi], this.pos[pi + 1], this.pos[pi + 2]);
        const ui = (t * 3 + k) * 2;
        if (remapUv) {
          const uv = remapUv(this.uvs[ui], this.uvs[ui + 1]);
          this.uvs.push(uv[0], uv[1]);
        } else this.uvs.push(this.uvs[ui], this.uvs[ui + 1]);
        const ci = (t * 3 + k) * 3;
        this.cols.push(this.cols[ci], this.cols[ci + 1], this.cols[ci + 2]);
        const mi = (t * 3 + k) * 4;
        this.mats.push(this.mats[mi], this.mats[mi + 1], this.mats[mi + 2], this.mats[mi + 3]);
      }
    }
  }

  /** Appends another builder's triangles (attributes kept, current transform ignored). */
  append(other: GeoBuilder): void {
    for (const v of other.pos) this.pos.push(v);
    for (const v of other.uvs) this.uvs.push(v);
    for (const v of other.cols) this.cols.push(v);
    for (const v of other.mats) this.mats.push(v);
  }

  /** Planar UVs (dominant axis of the face normal) at `scale` repeats per metre — for tiling noise maps. */
  private planarUvs(pos: Float32Array, uv: Float32Array): void {
    const s = 1;
    for (let t = 0; t < pos.length / 9; t++) {
      const i = t * 9;
      const ax = pos[i + 3] - pos[i];
      const ay = pos[i + 4] - pos[i + 1];
      const az = pos[i + 5] - pos[i + 2];
      const bx = pos[i + 6] - pos[i];
      const by = pos[i + 7] - pos[i + 1];
      const bz = pos[i + 8] - pos[i + 2];
      const nx = Math.abs(ay * bz - az * by);
      const ny = Math.abs(az * bx - ax * bz);
      const nz = Math.abs(ax * by - ay * bx);
      for (let k = 0; k < 3; k++) {
        const x = pos[i + k * 3];
        const y = pos[i + k * 3 + 1];
        const z = pos[i + k * 3 + 2];
        const o = (t * 3 + k) * 2;
        if (nx >= ny && nx >= nz) {
          uv[o] = z * s;
          uv[o + 1] = y * s;
        } else if (ny >= nz) {
          uv[o] = x * s;
          uv[o + 1] = z * s;
        } else {
          uv[o] = x * s;
          uv[o + 1] = y * s;
        }
      }
    }
  }

  /**
   * Converts the soup to a BufferGeometry with creased smooth normals.
   * `planarUv` replaces the stored UVs by metric planar coordinates (body paint flake map, glass cracks).
   */
  build(opts: BuildOptions & { planarUv?: boolean } = {}): THREE.BufferGeometry {
    const crease = Math.cos(((opts.crease ?? 38) * Math.PI) / 180);
    const src = this.pos;
    const triCount = src.length / 9;

    // --- drop degenerate triangles
    const keep: number[] = [];
    const fnx: number[] = [];
    const fny: number[] = [];
    const fnz: number[] = [];
    const fa: number[] = [];
    for (let t = 0; t < triCount; t++) {
      const i = t * 9;
      const ax = src[i + 3] - src[i];
      const ay = src[i + 4] - src[i + 1];
      const az = src[i + 5] - src[i + 2];
      const bx = src[i + 6] - src[i];
      const by = src[i + 7] - src[i + 1];
      const bz = src[i + 8] - src[i + 2];
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len < 1e-9) continue;
      keep.push(t);
      fnx.push(nx / len);
      fny.push(ny / len);
      fnz.push(nz / len);
      fa.push(len);
    }
    const n = keep.length;
    const position = new Float32Array(n * 9);
    const normal = new Float32Array(n * 9);
    for (let k = 0; k < n; k++) {
      const s = keep[k] * 9;
      for (let j = 0; j < 9; j++) position[k * 9 + j] = src[s + j];
    }

    // --- weld corners by quantised position
    const Q = 2000; // 0.5 mm
    const R = 60000;
    const clusterOfCorner = new Int32Array(n * 3);
    const map = new Map<number, number>();
    let clusters = 0;
    for (let c = 0; c < n * 3; c++) {
      const x = Math.round(position[c * 3] * Q) + R;
      const y = Math.round(position[c * 3 + 1] * Q) + R;
      const z = Math.round(position[c * 3 + 2] * Q) + R;
      const key = x + y * 120001 + z * 120001 * 120001;
      let id = map.get(key);
      if (id === undefined) {
        id = clusters++;
        map.set(key, id);
      }
      clusterOfCorner[c] = id;
    }
    const count = new Int32Array(clusters + 1);
    for (let c = 0; c < n * 3; c++) count[clusterOfCorner[c] + 1]++;
    for (let i = 0; i < clusters; i++) count[i + 1] += count[i];
    const fill = count.slice(0, clusters);
    const trisOf = new Int32Array(n * 3);
    for (let c = 0; c < n * 3; c++) {
      const id = clusterOfCorner[c];
      trisOf[fill[id]++] = (c / 3) | 0;
    }
    for (let c = 0; c < n * 3; c++) {
      const t = (c / 3) | 0;
      const id = clusterOfCorner[c];
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let k = count[id]; k < count[id + 1]; k++) {
        const t2 = trisOf[k];
        if (fnx[t] * fnx[t2] + fny[t] * fny[t2] + fnz[t] * fnz[t2] >= crease) {
          sx += fnx[t2] * fa[t2];
          sy += fny[t2] * fa[t2];
          sz += fnz[t2] * fa[t2];
        }
      }
      const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1;
      normal[c * 3] = sx / len;
      normal[c * 3 + 1] = sy / len;
      normal[c * 3 + 2] = sz / len;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    if (opts.uv !== false) {
      const uv = new Float32Array(n * 6);
      if (opts.planarUv) this.planarUvs(position, uv);
      else
        for (let k = 0; k < n; k++) {
          const s = keep[k] * 6;
          for (let j = 0; j < 6; j++) uv[k * 6 + j] = this.uvs[s + j];
        }
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (opts.color !== false) {
      const col = new Float32Array(n * 9);
      for (let k = 0; k < n; k++) {
        const s = keep[k] * 9;
        for (let j = 0; j < 9; j++) col[k * 9 + j] = this.cols[s + j];
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (opts.mat !== false) {
      const mat = new Float32Array(n * 12);
      for (let k = 0; k < n; k++) {
        const s = keep[k] * 12;
        for (let j = 0; j < 12; j++) mat[k * 12 + j] = this.mats[s + j];
      }
      geo.setAttribute('aMat', new THREE.BufferAttribute(mat, 4));
    }
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

// -----------------------------------------------------------------------------
// Reference-counted cache
// -----------------------------------------------------------------------------

export class RefCache<T> {
  private entries = new Map<string, { value: T; refs: number }>();
  constructor(private readonly destroy: (value: T) => void) {}

  acquire(key: string, create: () => T): T {
    let e = this.entries.get(key);
    if (!e) {
      e = { value: create(), refs: 0 };
      this.entries.set(key, e);
    }
    e.refs++;
    return e.value;
  }

  release(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.refs--;
    if (e.refs <= 0) {
      this.destroy(e.value);
      this.entries.delete(key);
    }
  }
}

/** Matrix helper: translation · rotation (Euler XYZ) · scale. */
export function trs(
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0,
  sx = 1,
  sy = sx,
  sz = sx,
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}
