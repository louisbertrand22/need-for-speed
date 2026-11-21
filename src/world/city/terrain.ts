/* Heightfield of Port-Sélène: natural hills on the west band, carved by the roads.
 * The bilinear `sample()` of `data` is the physics truth; the terrain mesh is built
 * from the very same samples. */
import type { Vec2 } from '../../core/types';
import { RING, TUNNEL, distanceToRing } from '../../core/layout';
import { fbm } from './noise';

export const HF_CELL = 4;
export const HF_ORIGIN = -1304;
export const HF_N = 653; // covers [-1304, 1304]

/** East limit of the terrain: everything east of it is the flat city (y = 0). */
export const HILL_EDGE_X = -456;
/** Half width of the flat highway corridor (carriageway + shoulders) cut into the terrain. */
export const RING_CORE = 16;

function smooth01(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** Catmull-Rom style interpolation of (z, h) control points (non-uniform, clamped ends). */
function curve1D(pts: readonly (readonly [number, number])[], z: number): number {
  const n = pts.length;
  if (z <= pts[0][0]) return pts[0][1];
  if (z >= pts[n - 1][0]) return pts[n - 1][1];
  let i = 0;
  while (i < n - 2 && z > pts[i + 1][0]) i++;
  const p0 = pts[Math.max(0, i - 1)];
  const p1 = pts[i];
  const p2 = pts[i + 1];
  const p3 = pts[Math.min(n - 1, i + 2)];
  const t = (z - p1[0]) / (p2[0] - p1[0]);
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || 1)) * (p2[0] - p1[0]);
  const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || 1)) * (p2[0] - p1[0]);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1[1] + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2[1] + (t3 - t2) * m2;
}

/** Height of the ridge crest along z. */
const CREST: readonly (readonly [number, number])[] = [
  [-1040, 0],
  [-930, 5],
  [-800, 22],
  [-640, 46],
  [-480, 60],
  [-300, 70],
  [-140, 81],
  [-60, 84],
  [60, 80],
  [220, 70],
  [380, 60],
  [540, 44],
  [700, 26],
  [860, 8],
  [1000, 0],
];

/** Height of the western plateau (over the tunnel) along z. */
const PLATEAU: readonly (readonly [number, number])[] = [
  [-640, 0],
  [-560, 8],
  [-500, 19],
  [-400, 30],
  [-100, 36],
  [200, 30],
  [300, 19],
  [360, 8],
  [440, 0],
];

export function crestX(z: number): number {
  return -884 + 22 * Math.sin(z * 0.0105 + 0.6) + 10 * Math.sin(z * 0.023 + 2.1);
}

/** Natural (un-carved) terrain height. 0 everywhere east of the hills. */
export function naturalHeight(x: number, z: number, seed: number): number {
  if (x >= -462) return 0;
  const fadeE = smooth01((-462 - x) / 46);
  const xc = crestX(z);
  const ch = Math.max(0, curve1D(CREST, z));
  let h: number;
  if (x > xc) {
    // east face: from the crest down to the foot at x = -470, with spurs and gullies
    const foot = -470;
    const t = Math.min(1, (x - xc) / (foot - xc));
    const p = 0.5 * (1 - t) + 0.25 * (1 + Math.cos(Math.PI * t));
    const spur = 1 + 0.1 * Math.sin(z * 0.021 + 1.3) * Math.sin(Math.PI * t);
    h = ch * p * spur;
  } else {
    const pl = Math.min(Math.max(0, curve1D(PLATEAU, z)), ch * 0.55);
    const t = Math.min(1, (xc - x) / 210);
    const p = 0.5 * (1 + Math.cos(Math.PI * t));
    h = pl + (ch - pl) * p;
    // beyond the ring the plateau rolls gently
    if (x < -1140) h += pl * 0.25 * smooth01((-1140 - x) / 160) * (0.5 + 0.5 * Math.sin(z * 0.012 + x * 0.004));
  }
  // knolls
  const k1 = Math.exp(-(((x + 640) / 70) ** 2) - ((z + 300) / 90) ** 2) * 7;
  const k2 = Math.exp(-(((x + 610) / 80) ** 2) - ((z - 360) / 100) ** 2) * 6;
  const env = Math.min(1, h / 24);
  const n = fbm(x * 0.011, z * 0.011, seed, 4) * 4.5 + fbm(x * 0.045, z * 0.045, seed + 91, 2) * 0.9;
  h += (k1 + k2) * Math.min(1, ch / 40) + n * env;
  // the tunnel always keeps a solid roof of rock above it
  const dx = Math.abs(x + RING.half);
  if (dx < 70 && z > TUNNEL.zFrom - 60 && z < TUNNEL.zTo + 60) {
    const m = (1 - smooth01((dx - 30) / 40)) * smooth01((z - (TUNNEL.zFrom - 56)) / 52) * smooth01((TUNNEL.zTo + 56 - z) / 52);
    const roof = 12.5 * m;
    if (h < roof) h = roof;
  }
  return Math.max(0, h * fadeE);
}

export class Heightfield {
  readonly n = HF_N;
  readonly cell = HF_CELL;
  readonly origin = HF_ORIGIN;
  /** carved heights = physics truth */
  readonly data: Float32Array;
  /** heights before any carving */
  readonly natural: Float32Array;
  /** 0..1 how strongly a node was flattened by a road / pad (used for dirt tint and mesh detail) */
  readonly carveW: Float32Array;

  private wSum: Float64Array;
  private whSum: Float64Array;
  private bestD: Float32Array;
  private bestH: Float32Array;
  private stamp: Int32Array;
  private touched: number[] = [];
  private stampId = 0;

  constructor(seed: number) {
    const n = this.n;
    this.data = new Float32Array(n * n);
    this.natural = new Float32Array(n * n);
    this.carveW = new Float32Array(n * n);
    this.wSum = new Float64Array(n * n);
    this.whSum = new Float64Array(n * n);
    this.bestD = new Float32Array(n * n);
    this.bestH = new Float32Array(n * n);
    this.stamp = new Int32Array(n * n);
    const iMax = Math.ceil((-462 - this.origin) / this.cell);
    for (let j = 0; j < n; j++) {
      const z = this.origin + j * this.cell;
      for (let i = 0; i <= iMax; i++) {
        const x = this.origin + i * this.cell;
        this.natural[j * n + i] = naturalHeight(x, z, seed);
      }
    }
    this.data.set(this.natural);
  }

  private bilinear(arr: Float32Array, x: number, z: number): number {
    const n = this.n;
    let fx = (x - this.origin) / this.cell;
    let fz = (z - this.origin) / this.cell;
    if (fx < 0) fx = 0;
    else if (fx > n - 1.001) fx = n - 1.001;
    if (fz < 0) fz = 0;
    else if (fz > n - 1.001) fz = n - 1.001;
    const i = fx | 0;
    const j = fz | 0;
    const tx = fx - i;
    const tz = fz - j;
    const k = j * n + i;
    const a = arr[k];
    const b = arr[k + 1];
    const c = arr[k + n];
    const d = arr[k + n + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /** Carved height (physics truth). */
  sample(x: number, z: number): number {
    return this.bilinear(this.data, x, z);
  }

  sampleNatural(x: number, z: number): number {
    return this.bilinear(this.natural, x, z);
  }

  /**
   * Flatten the terrain along a polyline with a height per point: flat across `core`
   * metres on each side, blended back to the natural terrain beyond.
   * `filter` can exclude nodes (returns false to skip).
   */
  carvePolyline(points: Vec2[], heights: ArrayLike<number>, core: number, filter?: (x: number, z: number) => boolean): void {
    const n = this.n;
    const cell = this.cell;
    const org = this.origin;
    const maxBlend = 46;
    const reach = core + maxBlend;
    const id = ++this.stampId;
    const touched = this.touched;
    touched.length = 0;
    for (let s = 0; s + 1 < points.length; s++) {
      const a = points[s];
      const b = points[s + 1];
      const ha = heights[s];
      const hb = heights[s + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach - org) / cell));
      const i1 = Math.min(n - 1, Math.ceil((Math.max(a.x, b.x) + reach - org) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach - org) / cell));
      const j1 = Math.min(n - 1, Math.ceil((Math.max(a.z, b.z) + reach - org) / cell));
      for (let j = j0; j <= j1; j++) {
        const z = org + j * cell;
        for (let i = i0; i <= i1; i++) {
          const x = org + i * cell;
          let t = l2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = a.x + dx * t - x;
          const pz = a.z + dz * t - z;
          const d = Math.sqrt(px * px + pz * pz);
          if (d > reach) continue;
          const k = j * n + i;
          if (this.stamp[k] !== id) {
            this.stamp[k] = id;
            this.bestD[k] = d;
            this.bestH[k] = ha + (hb - ha) * t;
            touched.push(k);
          } else if (d < this.bestD[k]) {
            this.bestD[k] = d;
            this.bestH[k] = ha + (hb - ha) * t;
          }
        }
      }
    }
    for (let q = 0; q < touched.length; q++) {
      const k = touched[q];
      const d = this.bestD[k];
      const hr = this.bestH[k];
      const blend = Math.min(maxBlend, Math.max(12, 9 + 1.7 * Math.abs(this.natural[k] - hr)));
      const w = 1 - smooth01((d - core) / blend);
      if (w <= 0) continue;
      if (filter) {
        const i = k % n;
        const j = (k - i) / n;
        if (!filter(org + i * cell, org + j * cell)) continue;
      }
      // a node inside the flat core of one road is (almost) fully owned by that road
      const ww = w / (1.0001 - w);
      this.wSum[k] += ww;
      this.whSum[k] += ww * hr;
      if (w > this.carveW[k]) this.carveW[k] = w;
    }
  }

  /** Flatten a disc (building pad, lookout...) to height h. */
  carveDisc(cx: number, cz: number, radius: number, h: number, blendMin = 10): void {
    const n = this.n;
    const cell = this.cell;
    const org = this.origin;
    const reach = radius + 46;
    const i0 = Math.max(0, Math.floor((cx - reach - org) / cell));
    const i1 = Math.min(n - 1, Math.ceil((cx + reach - org) / cell));
    const j0 = Math.max(0, Math.floor((cz - reach - org) / cell));
    const j1 = Math.min(n - 1, Math.ceil((cz + reach - org) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = org + j * cell;
      for (let i = i0; i <= i1; i++) {
        const x = org + i * cell;
        const d = Math.hypot(x - cx, z - cz);
        const k = j * n + i;
        const blend = Math.min(46, Math.max(blendMin, 8 + 1.7 * Math.abs(this.natural[k] - h)));
        const w = 1 - smooth01((d - radius) / blend);
        if (w <= 0) continue;
        const ww = w / (1.0001 - w);
        this.wSum[k] += ww;
        this.whSum[k] += ww * h;
        if (w > this.carveW[k]) this.carveW[k] = w;
      }
    }
  }

  /** Apply the accumulated carves, then cut the highway trench under the tunnel. */
  finishCarve(): void {
    const n = this.n;
    const total = n * n;
    for (let k = 0; k < total; k++) {
      const ws = this.wSum[k];
      if (ws > 0) {
        const target = this.whSum[k] / ws;
        const w = this.carveW[k];
        this.data[k] = this.natural[k] + (target - this.natural[k]) * w;
      }
    }
    // tunnel trench: hard edged (the tunnel structure + rock lid are built over it)
    for (let j = 0; j < n; j++) {
      const z = this.origin + j * this.cell;
      if (z < TUNNEL.zFrom || z > TUNNEL.zTo) continue;
      for (let i = 0; i < n; i++) {
        const x = this.origin + i * this.cell;
        if (Math.abs(x + RING.half) <= RING_CORE) this.data[j * n + i] = 0;
      }
    }
  }

  /** True for nodes of the rock lid above the tunnel (the mesh shows the natural height there). */
  isLidNode(i: number, j: number): boolean {
    const x = this.origin + i * this.cell;
    const z = this.origin + j * this.cell;
    return z >= TUNNEL.zFrom && z <= TUNNEL.zTo && Math.abs(x + RING.half) <= RING_CORE;
  }

  /** Height shown by the terrain mesh at a node (identical to the physics except on the tunnel lid). */
  visualAt(i: number, j: number): number {
    const k = j * this.n + i;
    return this.isLidNode(i, j) ? this.natural[k] : this.data[k];
  }
}

/** Carve filter for the ring corridor: the tunnel stretch is handled by the trench instead. */
export function ringCarveFilter(x: number, z: number): boolean {
  if (x < -900 && z >= TUNNEL.zFrom && z <= TUNNEL.zTo) return false;
  return distanceToRing(x, z) < 200;
}
