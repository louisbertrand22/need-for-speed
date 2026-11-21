/* Spatial hash of static colliders (32 m cells) + 2D line-of-sight test. */
import type { StaticCollider } from '../../core/types';

const CELL = 32;
const ORIGIN = -1440;
const DIM = 90; // covers [-1440, 1440]

interface ColliderRec extends StaticCollider {
  /** per-query stamp (dedupe across cells) */
  _q: number;
  /** blocks the line of sight */
  _sight: boolean;
}

export type ColliderInit = Omit<StaticCollider, 'id' | 'r'> & { r?: number };

export class ColliderIndex {
  private cells: ColliderRec[][] = [];
  private sightCells: ColliderRec[][] = [];
  private nextId = 1;
  private stamp = 1;
  count = 0;

  constructor() {
    for (let i = 0; i < DIM * DIM; i++) {
      this.cells.push([]);
      this.sightCells.push([]);
    }
  }

  private cc(v: number): number {
    const c = Math.floor((v - ORIGIN) / CELL);
    return c < 0 ? 0 : c >= DIM ? DIM - 1 : c;
  }

  private extent(c: StaticCollider): [number, number] {
    if (c.shape === 'circle') return [c.r, c.r];
    const s = Math.abs(Math.sin(c.rot));
    const k = Math.abs(Math.cos(c.rot));
    // local X -> (cos, -sin), local Z -> (sin, cos)
    return [c.hx * k + c.hz * s, c.hx * s + c.hz * k];
  }

  add(init: ColliderInit): StaticCollider {
    const rec: ColliderRec = {
      id: this.nextId++,
      shape: init.shape,
      x: init.x,
      z: init.z,
      hx: init.hx,
      hz: init.hz,
      rot: init.rot,
      r: init.shape === 'circle' ? (init.r ?? 0) : Math.hypot(init.hx, init.hz),
      yMin: init.yMin,
      yMax: init.yMax,
      kind: init.kind,
      _q: 0,
      _sight: !init.soft && (init.kind === 'building' || init.kind === 'wall') && init.yMax - init.yMin > 4,
    };
    if (init.soft) rec.soft = true;
    if (init.refId !== undefined) rec.refId = init.refId;
    this.insert(rec);
    return rec;
  }

  /** Re-insert a collider previously removed (same object, same id). */
  restore(c: StaticCollider): void {
    this.insert(c as ColliderRec);
  }

  private insert(rec: ColliderRec): void {
    const [ex, ez] = this.extent(rec);
    const i0 = this.cc(rec.x - ex);
    const i1 = this.cc(rec.x + ex);
    const j0 = this.cc(rec.z - ez);
    const j1 = this.cc(rec.z + ez);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        this.cells[j * DIM + i].push(rec);
        if (rec._sight) this.sightCells[j * DIM + i].push(rec);
      }
    }
    this.count++;
  }

  remove(c: StaticCollider): void {
    const rec = c as ColliderRec;
    const [ex, ez] = this.extent(rec);
    const i0 = this.cc(rec.x - ex);
    const i1 = this.cc(rec.x + ex);
    const j0 = this.cc(rec.z - ez);
    const j1 = this.cc(rec.z + ez);
    let found = false;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[j * DIM + i];
        const k = list.indexOf(rec);
        if (k >= 0) {
          list[k] = list[list.length - 1];
          list.pop();
          found = true;
        }
        if (rec._sight) {
          const sl = this.sightCells[j * DIM + i];
          const q = sl.indexOf(rec);
          if (q >= 0) {
            sl[q] = sl[sl.length - 1];
            sl.pop();
          }
        }
      }
    }
    if (found) this.count--;
  }

  query(x: number, z: number, radius: number, out: StaticCollider[]): number {
    const stamp = ++this.stamp;
    const i0 = this.cc(x - radius);
    const i1 = this.cc(x + radius);
    const j0 = this.cc(z - radius);
    const j1 = this.cc(z + radius);
    let n = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const list = this.cells[j * DIM + i];
        for (let k = 0; k < list.length; k++) {
          const c = list[k];
          if (c._q === stamp) continue;
          c._q = stamp;
          const dx = c.x - x;
          const dz = c.z - z;
          const rr = radius + c.r;
          if (dx * dx + dz * dz <= rr * rr) out[n++] = c;
        }
      }
    }
    return n;
  }

  /** Every collider currently registered (dev tools / validation only: allocates). */
  all(): StaticCollider[] {
    const stamp = ++this.stamp;
    const out: StaticCollider[] = [];
    for (const list of this.cells) {
      for (const c of list) {
        if (c._q === stamp) continue;
        c._q = stamp;
        out.push(c);
      }
    }
    return out;
  }

  /** true when no tall building / wall crosses the 2D segment. */
  lineOfSight(x1: number, z1: number, x2: number, z2: number): boolean {
    const stamp = ++this.stamp;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    // exact grid traversal (DDA) over the cells crossed by the segment
    let ci = this.cc(x1);
    let cj = this.cc(z1);
    const ei = this.cc(x2);
    const ej = this.cc(z2);
    const stepI = dx > 0 ? 1 : -1;
    const stepJ = dz > 0 ? 1 : -1;
    const tDeltaX = dx !== 0 ? CELL / Math.abs(dx) : Infinity;
    const tDeltaZ = dz !== 0 ? CELL / Math.abs(dz) : Infinity;
    let tMaxX = dx !== 0 ? (ORIGIN + (ci + (dx > 0 ? 1 : 0)) * CELL - x1) / dx : Infinity;
    let tMaxZ = dz !== 0 ? (ORIGIN + (cj + (dz > 0 ? 1 : 0)) * CELL - z1) / dz : Infinity;
    for (let guard = 0; guard < DIM * 3; guard++) {
      const list = this.sightCells[cj * DIM + ci];
      for (let k = 0; k < list.length; k++) {
        const c = list[k];
        if (c._q === stamp) continue;
        c._q = stamp;
        if (segmentHitsCollider(x1, z1, dx, dz, c)) return false;
      }
      if (ci === ei && cj === ej) break;
      if (tMaxX < tMaxZ) {
        ci += stepI;
        tMaxX += tDeltaX;
      } else {
        cj += stepJ;
        tMaxZ += tDeltaZ;
      }
      if (ci < 0 || cj < 0 || ci >= DIM || cj >= DIM) break;
    }
    return true;
  }
}

/** 2D segment (origin + delta) against a box / circle collider. */
function segmentHitsCollider(x1: number, z1: number, dx: number, dz: number, c: StaticCollider): boolean {
  if (c.shape === 'circle') {
    const fx = x1 - c.x;
    const fz = z1 - c.z;
    const a = dx * dx + dz * dz;
    let t = a > 0 ? -(fx * dx + fz * dz) / a : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = fx + dx * t;
    const pz = fz + dz * t;
    return px * px + pz * pz <= c.r * c.r;
  }
  // into the box frame: local X = (cos, -sin), local Z = (sin, cos)
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const rx = x1 - c.x;
  const rz = z1 - c.z;
  const ox = rx * cs - rz * sn;
  const oz = rx * sn + rz * cs;
  const ddx = dx * cs - dz * sn;
  const ddz = dx * sn + dz * cs;
  // slab test
  let t0 = 0;
  let t1 = 1;
  if (Math.abs(ddx) < 1e-9) {
    if (Math.abs(ox) > c.hx) return false;
  } else {
    let a = (-c.hx - ox) / ddx;
    let b = (c.hx - ox) / ddx;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  if (Math.abs(ddz) < 1e-9) {
    if (Math.abs(oz) > c.hz) return false;
  } else {
    let a = (-c.hz - oz) / ddz;
    let b = (c.hz - oz) / ddz;
    if (a > b) {
      const t = a;
      a = b;
      b = t;
    }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return true;
}
