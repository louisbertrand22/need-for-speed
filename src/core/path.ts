import type { Vec2 } from './types';

export interface PathProjection {
  /** Arc-length position of the closest point on the path (m). */
  s: number;
  /** Unsigned distance from the query point to the path (m). */
  dist: number;
  /** Signed lateral offset: > 0 when the query point is on the RIGHT of the travel direction. */
  side: number;
  /** Closest point. */
  x: number;
  z: number;
}

/**
 * Arc-length parameterised polyline on the XZ plane.
 * Used for race routes, GPS routes, AI racing lines and traffic lanes.
 *
 * Travel direction is points[0] -> points[n-1]. For `closed` paths the segment
 * points[n-1] -> points[0] is part of the path and `s` wraps modulo `length`.
 */
export class PolylinePath {
  readonly points: Vec2[];
  /** cum[i] = arc length at points[i]; cum.length === points.length (+1 when closed). */
  readonly cum: number[];
  readonly length: number;
  readonly closed: boolean;

  constructor(points: Vec2[], closed = false) {
    // drop consecutive duplicates
    const pts: Vec2[] = [];
    for (const p of points) {
      const last = pts[pts.length - 1];
      if (!last || Math.abs(last.x - p.x) > 1e-4 || Math.abs(last.z - p.z) > 1e-4) pts.push({ x: p.x, z: p.z });
    }
    if (closed && pts.length > 2) {
      const a = pts[0];
      const b = pts[pts.length - 1];
      if (Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.z - b.z) < 1e-4) pts.pop();
    }
    if (pts.length < 2) {
      const p = pts[0] ?? { x: 0, z: 0 };
      pts.length = 0;
      pts.push({ x: p.x, z: p.z }, { x: p.x, z: p.z + 0.01 });
    }
    this.points = pts;
    this.closed = closed;
    this.cum = [0];
    let acc = 0;
    const segCount = this.segmentCount;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      acc += Math.hypot(b.x - a.x, b.z - a.z);
      this.cum.push(acc);
    }
    this.length = acc;
  }

  get segmentCount(): number {
    return this.closed ? this.points.length : this.points.length - 1;
  }

  /** Normalise an arc-length: wraps for closed paths, clamps otherwise. */
  norm(s: number): number {
    if (this.closed) {
      s %= this.length;
      return s < 0 ? s + this.length : s;
    }
    return s < 0 ? 0 : s > this.length ? this.length : s;
  }

  /** Index of the segment containing arc-length s (binary search). */
  segmentAt(s: number): number {
    s = this.norm(s);
    let lo = 0;
    let hi = this.segmentCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  pointAt(s: number, out: Vec2 = { x: 0, z: 0 }): Vec2 {
    s = this.norm(s);
    const i = this.segmentAt(s);
    const a = this.points[i];
    const b = this.points[(i + 1) % this.points.length];
    const segLen = this.cum[i + 1] - this.cum[i];
    const t = segLen > 1e-6 ? (s - this.cum[i]) / segLen : 0;
    out.x = a.x + (b.x - a.x) * t;
    out.z = a.z + (b.z - a.z) * t;
    return out;
  }

  /** Unit tangent (travel direction) at s. */
  tangentAt(s: number, out: Vec2 = { x: 0, z: 0 }): Vec2 {
    const i = this.segmentAt(s);
    const a = this.points[i];
    const b = this.points[(i + 1) % this.points.length];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l = Math.hypot(dx, dz) || 1;
    out.x = dx / l;
    out.z = dz / l;
    return out;
  }

  /** Heading (game convention, atan2(dx, dz)) of the travel direction at s. */
  headingAt(s: number): number {
    const t = this.tangentAt(s, _tmpA);
    return Math.atan2(t.x, t.z);
  }

  /**
   * Signed curvature (1/m) estimated over `span` metres around s.
   * > 0 when the path turns RIGHT (heading decreasing), < 0 when it turns left.
   */
  curvatureAt(s: number, span = 14): number {
    const h0 = this.headingAt(s - span * 0.5);
    const h1 = this.headingAt(s + span * 0.5);
    let d = h1 - h0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return -d / span;
  }

  /**
   * Project a point on the path.
   * @param hintS  when given, only segments within `window` metres of hintS are searched
   *               (use the previous projection for moving objects; avoids jumping between
   *               overlapping parts of a route).
   */
  project(x: number, z: number, hintS?: number, window = 80, out?: PathProjection): PathProjection {
    const res: PathProjection = out ?? { s: 0, dist: Infinity, side: 0, x: 0, z: 0 };
    res.dist = Infinity;
    const n = this.points.length;
    const segCount = this.segmentCount;
    let from = 0;
    let count = segCount;
    if (hintS !== undefined) {
      const i0 = this.segmentAt(hintS - window);
      const i1 = this.segmentAt(hintS + window);
      from = i0;
      if (this.closed) {
        count = ((i1 - i0 + segCount) % segCount) + 1;
        if (window * 2 >= this.length) {
          from = 0;
          count = segCount;
        }
      } else {
        count = i1 - i0 + 1;
      }
    }
    let bestD2 = Infinity;
    for (let k = 0; k < count; k++) {
      const i = (from + k) % segCount;
      const a = this.points[i];
      const b = this.points[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const l2 = dx * dx + dz * dz;
      let t = l2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = a.x + dx * t;
      const pz = a.z + dz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < bestD2) {
        bestD2 = d2;
        const l = Math.sqrt(l2) || 1;
        res.s = this.cum[i] + l * t;
        res.x = px;
        res.z = pz;
        // right vector of the travel direction (tx, tz) is (-tz, tx)
        res.side = ((x - px) * -dz + (z - pz) * dx) / l;
      }
    }
    res.dist = Math.sqrt(bestD2);
    return res;
  }

  /** Resample a polyline with (approximately) constant spacing. Keeps first and last points. */
  static resample(points: Vec2[], spacing: number, closed = false): Vec2[] {
    const path = new PolylinePath(points, closed);
    const n = Math.max(1, Math.round(path.length / spacing));
    const out: Vec2[] = [];
    const last = closed ? n - 1 : n;
    for (let i = 0; i <= last; i++) out.push(path.pointAt((i / n) * path.length));
    return out;
  }

  /** Chaikin corner cutting — rounds sharp corners (e.g. 90° grid turns). */
  static smooth(points: Vec2[], iterations = 2, closed = false): Vec2[] {
    let pts = points;
    for (let it = 0; it < iterations; it++) {
      const out: Vec2[] = [];
      const n = pts.length;
      if (!closed) out.push({ x: pts[0].x, z: pts[0].z });
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
      }
      if (!closed) out.push({ x: pts[n - 1].x, z: pts[n - 1].z });
      pts = out;
    }
    return pts;
  }
}

const _tmpA: Vec2 = { x: 0, z: 0 };
