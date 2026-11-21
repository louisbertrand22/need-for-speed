/* =============================================================================
 * Parametric lofted car body.
 *
 * A body is described by a `BodyDef`: side-view profile curves (centre line,
 * shoulder line, floor), a plan-view width curve, a greenhouse (windscreen /
 * roof / rear window lines, tumblehome) and rounded nose / tail caps.
 * `BodySurface` turns it into an analytic surface (cross-section at any z) that
 * the shell builder samples into a grid and that detail features (lamps,
 * grilles, shut-lines, kits, spoilers) are projected onto.
 *
 * Local frame: +Z = front, +Y = up, +X = the car's LEFT side. y = 0 is the road.
 * ===========================================================================*/
import * as THREE from 'three';
import type { CarDimensions } from '../../core/types';
import { GeoBuilder, pchip, smoothstep01, trs, type P2, type P3 } from './geo';
import { CH, PART } from './materials';
import { atlasRect, type AtlasRegion } from './textures';

export type BodyDetail = 'high' | 'low' | 'traffic';

export interface EndShape {
  /** plan-view corner: length (m) and superellipse exponent (2 = round, 5 = square) */
  r: number;
  n: number;
  /** side-view roundover of the top line: drop (fraction of the height) over `rv` metres */
  drop: number;
  rv: number;
}

/**
 * All `P2` control points are [f, value] with f = distance from the nose as a fraction of the
 * length (0 = nose tip, 1 = tail tip). Heights are fractions of the total height unless noted.
 */
export interface BodyDef {
  /** body top on the centre line, greenhouse excluded (hood → cowl → deck → tail) */
  centre: readonly P2[];
  /** shoulder / belt line (top of the body side) */
  shoulder: readonly P2[];
  /** underside: metres above the ride height */
  floor: readonly P2[];
  /** half width as a fraction of the nominal half width */
  plan: readonly P2[];
  /** greenhouse stations: windscreen base, roof front, roof rear, rear-window base */
  cowl: number;
  roofF: number;
  roofR: number;
  deck: number;
  /** roof height at its front / rear end; the peak (= full height) sits at `roofPeak` (0..1 along the roof) */
  roofFH: number;
  roofRH: number;
  roofPeak: number;
  /** how much lower the roof edge is than its centre (m) */
  roofCrown: number;
  /** profile exponents of the windscreen / rear window (< 1 = bulging) and edge lag (plan curvature) */
  wsExp: number;
  rwExp: number;
  wsLag: number;
  rwLag: number;
  /** glass base half width as a fraction of the shoulder half width */
  ghW: readonly P2[];
  /** inward lean of the side glass (m per m of height) */
  tumble: number;
  nose: EndShape;
  tail: EndShape;
  /** section: rocker tuck-under, body-side lean, shoulder inset (fractions of the half width) */
  tuck: number;
  lean: number;
  inset: number;
  /** shoulder fillet: share of the side height and superellipse exponent */
  shoulderR: number;
  shoulderA: number;
  /** crown exponents: hood / deck power curve, roof superellipse */
  pHood: number;
  roofA: number;
  /** wheel-arch flares (m) front / rear and their radial fall-off (m) */
  flareF: number;
  flareR: number;
  flareFall: number;
  /** wheels shifted forward by this much relative to the body centre (m) */
  axleShift: number;
  /** tyre width front / rear (m) */
  tyreW: readonly [number, number];
  /** rim radius / wheel radius */
  rimRatio: number;
  /** side glazing ends here (C-pillar starts) */
  sideGlassEnd: number;
  /** B-pillar positions */
  pillars: readonly number[];
  /** rear window range (inside roofR..deck), null = solid */
  rearGlass: readonly [number, number] | null;
  /** glass roof / canopy */
  roofGlass: boolean;
  /** painted length at the front tip of the side glazing (m) */
  mirrorSail: number;
  /** where lip / ducktail / wings are mounted */
  spoilerAt: number;
  /** separate trunk lid shut-lines */
  trunkLid: boolean;
  /** number of doors per side (shut-lines) */
  doors: number;
  /** exhaust tips: x offsets (m, mirrored when `mirror`), height above the floor line (m) */
  exhaust: { x: readonly number[]; y: number; radius: number };
  caliper: number;
  /** seats: rows of [z offset behind the cowl (m)] */
  seatZ: number;
  /** style-specific details (lamps, grilles, vents...) */
  features: (ctx: BodyBuilder) => void;
}

export interface BodyBuildOptions {
  detail: BodyDetail;
  /** 0 stock, 1 street, 2 wide, 3 extreme */
  kit: number;
  /** 0 none, 1 lip, 2 ducktail, 3 GT wing, 4 drag wing */
  spoiler: number;
  /** paint vertex colour per zone (police two-tone); default white */
  livery?: (seg: number, z: number, y: number) => THREE.ColorRepresentation;
  /** interior objects (seats, dash) — default: detail === 'high' */
  interior?: boolean;
  /** number of exhaust tips to model (default: all of def.exhaust) */
  exhaustCount?: number;
  /** extra geometry added after the standard features (light bars, roof signs, merged wheels...) */
  extraParts?: (b: BodyBuilder) => void;
  /** merge the painted shell into the parts geometry (single draw call, traffic) with this [roughness, metalness] */
  mergePaint?: readonly [number, number];
}

export const SEG = { floor: 0, side: 1, ledge: 2, glass: 3, top: 4 } as const;

export interface Section {
  z: number;
  /** plan end factor (0 at the tips) */
  pe: number;
  yb: number;
  ys: number;
  ytv: number;
  yt: number;
  yL: number;
  yg: number;
  /** greenhouse edge height above the ledge */
  E: number;
  /** side half width (max), floor half width, shoulder half width, glass base / roof edge half widths */
  W: number;
  wb: number;
  xs: number;
  wg0: number;
  wg1: number;
  /** blend power-crown → superellipse roof */
  k: number;
}

function newSection(): Section {
  return { z: 0, pe: 1, yb: 0, ys: 0, ytv: 0, yt: 0, yL: 0, yg: 0, E: 0, W: 0, wb: 0, xs: 0, wg0: 0, wg1: 0, k: 0 };
}

const S_TUCK = 0.3;

function endFactor(d: number, r: number, n: number): number {
  if (d >= r) return 1;
  if (d <= 0) return 0;
  return Math.pow(1 - Math.pow(1 - d / r, n), 1 / n);
}

function roundover(u: number): number {
  if (u >= 1) return 0;
  if (u <= 0) return 1;
  const m = 2.3;
  return 1 - Math.pow(1 - Math.pow(1 - u, m), 1 / m);
}

function softmax(a: number, b: number, k = 28): number {
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(k * (a - m)) + Math.exp(k * (b - m))) / k;
}

// -----------------------------------------------------------------------------
// Analytic surface
// -----------------------------------------------------------------------------

export class BodySurface {
  readonly L: number;
  readonly H: number;
  readonly halfW: number;
  readonly ride: number;
  readonly zNose: number;
  readonly zTail: number;
  readonly zCowl: number;
  readonly zRoofF: number;
  readonly zRoofR: number;
  readonly zDeck: number;
  /** front / rear axle z, axle height, arch radius */
  readonly axleZ: [number, number];
  readonly axleY: number;
  readonly archR: number;
  readonly tyreW: readonly [number, number];
  /** half track of the visual wheels (flush with the arches) */
  readonly wheelX: [number, number] = [0, 0];
  /** inner wall of the wheel wells */
  readonly wellX: [number, number] = [0, 0];
  private flareAmp: [number, number] = [0, 0];

  private centreFn: (f: number) => number;
  private shoulderFn: (f: number) => number;
  private floorFn: (f: number) => number;
  private planFn: (f: number) => number;
  private ghFn: (f: number) => number;
  private roofFn: (f: number) => number;
  private cowlY = 0;
  private cowlYL = 0;
  private deckY = 0;
  private deckYL = 0;
  private gh = false;
  private tmp = newSection();

  constructor(
    readonly def: BodyDef,
    readonly dims: CarDimensions,
    kitFlare: number,
  ) {
    this.L = dims.length;
    this.H = dims.height;
    this.halfW = dims.width / 2;
    this.ride = dims.rideHeight;
    this.zNose = this.L / 2;
    this.zTail = -this.L / 2;
    this.zCowl = this.zOf(def.cowl);
    this.zRoofF = this.zOf(def.roofF);
    this.zRoofR = this.zOf(def.roofR);
    this.zDeck = this.zOf(def.deck);
    this.axleZ = [dims.wheelbase / 2 + def.axleShift, -dims.wheelbase / 2 + def.axleShift];
    this.axleY = dims.wheelRadius;
    this.archR = dims.wheelRadius + 0.05;
    this.tyreW = def.tyreW;
    this.centreFn = pchip(def.centre);
    this.shoulderFn = pchip(def.shoulder);
    this.floorFn = pchip(def.floor);
    this.planFn = pchip(def.plan);
    this.ghFn = pchip(def.ghW);
    const peak = def.roofF + (def.roofR - def.roofF) * def.roofPeak;
    this.roofFn = pchip([
      [def.roofF, def.roofFH],
      [peak, 1],
      [def.roofR, def.roofRH],
    ]);

    // 1) flush stance: flares so that the arches cover the tyres, wheels pushed out to the arch lips
    for (let k = 0; k < 2; k++) {
      const defFlare = (k === 0 ? def.flareF : def.flareR) + kitFlare * (k === 0 ? 0.85 : 1);
      const yTop = this.axleY + this.archR * 0.75;
      const x0 = this.sideX(this.axleZ[k], yTop);
      const need = dims.track / 2 + this.tyreW[k] / 2 + 0.012 - x0;
      this.flareAmp[k] = Math.max(defFlare, need, 0);
      this.wheelX[k] = x0 + this.flareAmp[k] - this.tyreW[k] / 2 - 0.012;
      this.wellX[k] = this.wheelX[k] - this.tyreW[k] / 2 - 0.05;
    }
    // 2) greenhouse anchor heights (need the flares for the ledge)
    const c = this.section(this.zCowl, newSection());
    this.cowlY = c.ytv;
    this.cowlYL = c.yL;
    const d = this.section(this.zDeck, newSection());
    this.deckY = d.ytv;
    this.deckYL = d.yL;
    this.gh = true;
  }

  zOf(f: number): number {
    return this.zNose - f * this.L;
  }

  fOf(z: number): number {
    return (this.zNose - z) / this.L;
  }

  flareAt(z: number, y: number): number {
    let f = 0;
    const fall = this.def.flareFall;
    for (let k = 0; k < 2; k++) {
      const amp = this.flareAmp[k];
      if (amp <= 0) continue;
      const d = Math.hypot(z - this.axleZ[k], y - this.axleY);
      const t = (d - this.archR) / fall;
      if (t <= 0) f += amp;
      else if (t < 1) f += amp * (1 - smoothstep01(t));
    }
    return f;
  }

  /** side profile: fraction of W at relative height s (0 rocker → 1 shoulder) */
  sideProfile(s: number): number {
    const d = this.def;
    const sR = 1 - d.shoulderR;
    if (s < S_TUCK) {
      const u = 1 - s / S_TUCK;
      return 1 - d.tuck * u * u;
    }
    if (s < sR) {
      const u = (s - S_TUCK) / (sR - S_TUCK);
      return 1 - d.lean * u * u;
    }
    const u = Math.min(1, (s - sR) / (1 - sR));
    const c = Math.pow(Math.max(0, 1 - Math.pow(u, d.shoulderA)), 1 / d.shoulderA);
    return 1 - d.lean - (d.inset - d.lean) * (1 - c);
  }

  /** Cross-section parameters at z. Writes into `o` (default: a shared temporary). */
  section(z: number, o: Section = this.tmp): Section {
    const d = this.def;
    const f = (this.zNose - z) / this.L;
    const dN = this.zNose - z;
    const dT = z - this.zTail;
    const pe = endFactor(dN, d.nose.r, d.nose.n) * endFactor(dT, d.tail.r, d.tail.n);
    const W = this.halfW * this.planFn(f) * pe;
    const drop = (d.nose.drop * roundover(dN / d.nose.rv) + d.tail.drop * roundover(dT / d.tail.rv)) * this.H;
    const ytv = this.centreFn(f) * this.H - drop;
    let ys = this.shoulderFn(f) * this.H;
    // fenders always clear the arches
    for (let k = 0; k < 2; k++) {
      const rr = this.archR + 0.04;
      const dz = z - this.axleZ[k];
      if (Math.abs(dz) < rr) ys = softmax(ys, this.axleY + Math.sqrt(rr * rr - dz * dz));
    }
    ys -= drop;
    const yb = this.ride + this.floorFn(f);
    if (ys < yb + 0.02) ys = yb + 0.02;
    const xsBase = W * (1 - d.inset);
    const xs = xsBase + this.flareAt(z, ys) * pe;
    const wg0 = this.ghFn(f) * xsBase;
    const ytvC = Math.max(ytv, yb + 0.02);
    const yL = xs > 1e-6 ? ytvC - (ytvC - ys) * Math.pow(wg0 / xs, d.pHood) : ytvC;
    let G = 0;
    let E = 0;
    if (this.gh && f > d.cowl && f < d.deck) {
      let ytA: number;
      let ygA: number;
      if (f <= d.roofF) {
        const s = (f - d.cowl) / (d.roofF - d.cowl);
        const top = d.roofFH * this.H;
        ytA = this.cowlY + (top - this.cowlY) * Math.pow(s, d.wsExp);
        ygA = this.cowlYL + (top - d.roofCrown - this.cowlYL) * Math.pow(s, d.wsExp * (1 + d.wsLag));
      } else if (f <= d.roofR) {
        ytA = this.roofFn(f) * this.H;
        ygA = ytA - d.roofCrown;
      } else {
        const s = (d.deck - f) / (d.deck - d.roofR);
        const top = d.roofRH * this.H;
        ytA = this.deckY + (top - this.deckY) * Math.pow(s, d.rwExp);
        ygA = this.deckYL + (top - d.roofCrown - this.deckYL) * Math.pow(s, d.rwExp * (1 + d.rwLag));
      }
      G = Math.max(0, ytA - ytvC);
      E = Math.max(0, ygA - yL);
    }
    let yt = ytvC + G;
    const yg = yL + E;
    if (E > 0 && yt < yg + 0.004) yt = yg + 0.004;
    o.z = z;
    o.pe = pe;
    o.yb = yb;
    o.ys = ys;
    o.ytv = ytvC;
    o.yt = yt;
    o.yL = yL;
    o.yg = yg;
    o.E = E;
    o.W = W;
    o.wb = W * (1 - d.tuck);
    o.xs = xs;
    o.wg0 = wg0;
    o.wg1 = E > 0 ? Math.max(wg0 * 0.35, wg0 - d.tumble * E) : wg0;
    o.k = smoothstep01(E / 0.1);
    return o;
  }

  /** crown shape: 1 at the centre → 0 at the edge */
  crown(r: number, k: number): number {
    const d = this.def;
    const a = 1 - Math.pow(r, d.pHood);
    if (k <= 0) return a;
    const b = Math.pow(Math.max(0, 1 - Math.pow(r, d.roofA)), 1 / d.roofA);
    return a + (b - a) * k;
  }

  /** x of the body side at height y on a section (flares included) */
  private xOnSide(sec: Section, y: number): number {
    const s = (y - sec.yb) / Math.max(1e-6, sec.ys - sec.yb);
    return sec.W * this.sideProfile(s) + this.flareAt(sec.z, y) * sec.pe;
  }

  /** Half width of the body outline at (z, y); 0 outside the vertical extent. */
  sideX(z: number, y: number): number {
    const sec = this.section(z);
    if (sec.W <= 0) return 0;
    if (y < sec.yb) return 0;
    if (y <= sec.ys) return this.xOnSide(sec, y);
    if (sec.E > 1e-4) {
      if (y <= sec.yL) return sec.wg0 + (sec.xs - sec.wg0) * ((sec.yL - y) / Math.max(1e-6, sec.yL - sec.ys));
      if (y <= sec.yg) return sec.wg0 + (sec.wg1 - sec.wg0) * ((y - sec.yL) / sec.E);
    }
    if (y >= sec.yt) return 0;
    // on the top surface: invert the crown
    const edgeY = sec.E > 1e-4 ? sec.yg : sec.ys;
    const edgeX = sec.E > 1e-4 ? sec.wg1 : sec.xs;
    const topY = sec.yt;
    if (topY <= edgeY) return 0;
    const target = (y - edgeY) / (topY - edgeY);
    if (sec.E <= 1e-4) return edgeX * Math.pow(Math.max(0, 1 - target), 1 / this.def.pHood);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (this.crown(mid, sec.k) > target) lo = mid;
      else hi = mid;
    }
    return edgeX * (lo + hi) * 0.5;
  }

  /** Height of the upper surface at (z, |x|). */
  topY(z: number, x: number): number {
    const sec = this.section(z);
    const ax = Math.abs(x);
    if (ax <= sec.wg1) return sec.yg + (sec.yt - sec.yg) * this.crown(sec.wg1 > 1e-6 ? ax / sec.wg1 : 0, sec.k);
    if (ax <= sec.wg0 && sec.wg0 > sec.wg1) return sec.yL + sec.E * ((sec.wg0 - ax) / (sec.wg0 - sec.wg1));
    if (ax <= sec.xs) return sec.ytv - (sec.ytv - sec.ys) * Math.pow(ax / Math.max(1e-6, sec.xs), this.def.pHood);
    return sec.ys;
  }

  /** z of the nose surface seen from the front at (|x|, y). */
  frontZ(x: number, y: number): number {
    let lo = this.axleZ[0];
    let hi = this.zNose;
    if (this.sideX(lo, y) <= x) return lo;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (this.sideX(mid, y) > x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  /** z of the tail surface seen from behind at (|x|, y). */
  rearZ(x: number, y: number): number {
    let lo = this.axleZ[1];
    let hi = this.zTail;
    if (this.sideX(lo, y) <= x) return lo;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (this.sideX(mid, y) > x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
}

// -----------------------------------------------------------------------------
// Shell + feature builder
// -----------------------------------------------------------------------------

export type View = 'front' | 'rear' | 'side' | 'top';

export interface PatchOptions {
  /** offset along the surface normal (m), default 3 mm */
  off?: number;
  nu?: number;
  nv?: number;
  tex?: AtlasRegion;
  /** flip the texture horizontally */
  flipU?: boolean;
}

export interface BodyMetrics {
  wheelX: [number, number];
  axleZ: [number, number];
  tyreW: [number, number];
  wheelRadius: number;
  rimRatio: number;
  exhausts: P3[];
  /** beam origins (left, right) */
  headlights: P3[];
  hoodPivot: P3;
  frontBumperPivot: P3;
  rearBumperPivot: P3;
  /** under-floor height (neon / shadow) */
  floorY: number;
  caliper: number;
  /** highest roof point (light bars, taxi signs) */
  roofY: number;
  roofZ: number;
  roofHalfW: number;
}

export interface BodyGeometry {
  paint: THREE.BufferGeometry;
  glass: THREE.BufferGeometry | null;
  parts: THREE.BufferGeometry;
  metrics: BodyMetrics;
  triangles: number;
}

const DETAIL = {
  high: { h: 0.085, nEnd: 8, nLow: 7, nFil: 5, nLedge: 2, glassS: [0, 0.3, 0.6, 0.88, 1], topR: [1, 0.985, 0.95, 0.89, 0.8, 0.68, 0.52, 0.35, 0.18, 0], pillarCols: 2 },
  low: { h: 0.2, nEnd: 5, nLow: 4, nFil: 3, nLedge: 1, glassS: [0, 0.86, 1], topR: [1, 0.975, 0.88, 0.66, 0.36, 0], pillarCols: 1 },
  traffic: { h: 0.36, nEnd: 3, nLow: 2, nFil: 2, nLedge: 1, glassS: [0, 0.86, 1], topR: [1, 0.96, 0.75, 0.4, 0], pillarCols: 1 },
} as const;

const COL_TRIM = 0x08080a;
const COL_INTERIOR = 0x0b0b0d;

export class BodyBuilder {
  readonly s: BodySurface;
  readonly def: BodyDef;
  readonly dims: CarDimensions;
  readonly detail: BodyDetail;
  readonly kit: number;
  readonly spoiler: number;
  readonly paint = new GeoBuilder();
  readonly glass = new GeoBuilder();
  readonly parts = new GeoBuilder();
  readonly headlights: P3[] = [];
  readonly exhausts: P3[] = [];
  /** z of the hood leading edge / bumper split lines */
  readonly zHoodF: number;
  readonly zBumperF: number;
  readonly zBumperR: number;
  private opts: BodyBuildOptions;

  constructor(def: BodyDef, dims: CarDimensions, opts: BodyBuildOptions) {
    this.def = def;
    this.dims = dims;
    this.opts = opts;
    this.detail = opts.detail;
    this.kit = opts.kit;
    this.spoiler = opts.spoiler;
    const kitFlare = opts.kit === 2 ? 0.055 : opts.kit === 3 ? 0.085 : 0;
    this.s = new BodySurface(def, dims, kitFlare);
    this.zHoodF = this.s.zNose - Math.max(def.nose.rv, 0.14) - 0.03;
    this.zBumperF = this.s.axleZ[0] + this.s.archR + 0.07;
    this.zBumperR = this.s.axleZ[1] - this.s.archR - 0.07;
  }

  get hi(): boolean {
    return this.detail === 'high';
  }

  // ---------------------------------------------------------------------------
  // projections
  // ---------------------------------------------------------------------------

  private mapRaw(view: View, a: number, b: number): P3 {
    const s = this.s;
    switch (view) {
      case 'front':
        return [a, b, s.frontZ(Math.abs(a), b)];
      case 'rear':
        return [a, b, s.rearZ(Math.abs(a), b)];
      case 'side':
        return [s.sideX(a, b), b, a];
      default:
        return [a, s.topY(b, a), b];
    }
  }

  /** Surface point + outward unit normal for view coordinates (a, b). */
  surfacePoint(view: View, a: number, b: number, off = 0): { p: P3; n: P3 } {
    const e = 0.008;
    const p = this.mapRaw(view, a, b);
    const pa = this.mapRaw(view, a + e, b);
    const pb = this.mapRaw(view, a, b + e);
    const ax = pa[0] - p[0];
    const ay = pa[1] - p[1];
    const az = pa[2] - p[2];
    const bx = pb[0] - p[0];
    const by = pb[1] - p[1];
    const bz = pb[2] - p[2];
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    // outward reference direction
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (view === 'top') oy = 1;
    else {
      const zc = Math.min(this.s.zNose - this.s.halfW, Math.max(this.s.zTail + this.s.halfW, p[2]));
      ox = p[0];
      oz = p[2] - zc;
      if (view === 'front') oz += 0.05;
      if (view === 'rear') oz -= 0.05;
      if (view === 'side') ox += 0.05;
    }
    if (nx * ox + ny * oy + nz * oz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    return { p: [p[0] + nx * off, p[1] + ny * off, p[2] + nz * off], n: [nx, ny, nz] };
  }

  private scale(n: number): number {
    return this.detail === 'high' ? n : Math.max(1, Math.round(n * 0.5));
  }

  /**
   * Surface-conforming patch. `fn(u, v)` (u, v ∈ [0, 1]) returns view coordinates.
   * Colour / surface / channel / part come from the target builder's current state.
   */
  patch(view: View, target: GeoBuilder, fn: (u: number, v: number) => P2, o: PatchOptions = {}): void {
    const nu = this.scale(o.nu ?? 6);
    const nv = this.scale(o.nv ?? 2);
    const off = o.off ?? 0.003;
    const rect = o.tex ? atlasRect(o.tex) : null;
    const pts: P3[][] = [];
    const nrm: P3[][] = [];
    for (let j = 0; j <= nv; j++) {
      const row: P3[] = [];
      const nrow: P3[] = [];
      for (let i = 0; i <= nu; i++) {
        const ab = fn(i / nu, j / nv);
        const r = this.surfacePoint(view, ab[0], ab[1], off);
        row.push(r.p);
        nrow.push(r.n);
      }
      pts.push(row);
      nrm.push(nrow);
    }
    const uvAt = (i: number, j: number): P2 | undefined => {
      if (!rect) return undefined;
      const u = o.flipU ? 1 - i / nu : i / nu;
      return [rect.u0 + (rect.u1 - rect.u0) * u, rect.v0 + (rect.v1 - rect.v0) * (j / nv)];
    };
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const a = pts[j][i];
        const b = pts[j][i + 1];
        const c = pts[j + 1][i + 1];
        const d = pts[j + 1][i];
        const n = nrm[j][i];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const ez = b[2] - a[2];
        const fx = d[0] - a[0];
        const fy = d[1] - a[1];
        const fz = d[2] - a[2];
        const dot = (ey * fz - ez * fy) * n[0] + (ez * fx - ex * fz) * n[1] + (ex * fy - ey * fx) * n[2];
        const ua = uvAt(i, j);
        const ub = uvAt(i + 1, j);
        const uc = uvAt(i + 1, j + 1);
        const ud = uvAt(i, j + 1);
        if (dot >= 0) target.quad(a, b, c, d, ua, ub, uc, ud);
        else target.quad(a, d, c, b, ua, ud, uc, ub);
      }
  }

  /** Quadrilateral patch between four view-space corners (p00 → p10 → p11 → p01). */
  quadPatch(view: View, target: GeoBuilder, p00: P2, p10: P2, p11: P2, p01: P2, o: PatchOptions = {}): void {
    this.patch(
      view,
      target,
      (u, v) => {
        const a0 = p00[0] + (p10[0] - p00[0]) * u;
        const b0 = p00[1] + (p10[1] - p00[1]) * u;
        const a1 = p01[0] + (p11[0] - p01[0]) * u;
        const b1 = p01[1] + (p11[1] - p01[1]) * u;
        return [a0 + (a1 - a0) * v, b0 + (b1 - b0) * v];
      },
      o,
    );
  }

  rect(view: View, target: GeoBuilder, a0: number, b0: number, a1: number, b1: number, o: PatchOptions = {}): void {
    this.quadPatch(view, target, [a0, b0], [a1, b0], [a1, b1], [a0, b1], o);
  }

  /** Elliptic disc / ring patch. */
  disc(view: View, target: GeoBuilder, ca: number, cb: number, ra: number, rb: number, o: PatchOptions & { inner?: number } = {}): void {
    const inner = o.inner ?? 0;
    this.patch(
      view,
      target,
      (u, v) => {
        const ang = u * Math.PI * 2;
        const r = inner + (1 - inner) * v;
        return [ca + Math.cos(ang) * ra * r, cb + Math.sin(ang) * rb * r];
      },
      { nu: o.nu ?? 16, nv: o.nv ?? 1, off: o.off, tex: o.tex },
    );
  }

  /** Thin ribbon along a view-space polyline (shut-lines, trims). */
  ribbon(view: View, target: GeoBuilder, line: readonly P2[], width: number, off = 0.0015, step = 0.05): void {
    const pts: { p: P3; n: P3 }[] = [];
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / (this.hi ? step : step * 2.5)));
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const t = k / n;
        pts.push(this.surfacePoint(view, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, off));
      }
    }
    const left: P3[] = [];
    const right: P3[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[Math.max(0, i - 1)].p;
      const p1 = pts[Math.min(pts.length - 1, i + 1)].p;
      const tx = p1[0] - p0[0];
      const ty = p1[1] - p0[1];
      const tz = p1[2] - p0[2];
      const n = pts[i].n;
      let wx = ty * n[2] - tz * n[1];
      let wy = tz * n[0] - tx * n[2];
      let wz = tx * n[1] - ty * n[0];
      const wl = Math.hypot(wx, wy, wz) || 1;
      wx = (wx / wl) * width * 0.5;
      wy = (wy / wl) * width * 0.5;
      wz = (wz / wl) * width * 0.5;
      const p = pts[i].p;
      left.push([p[0] + wx, p[1] + wy, p[2] + wz]);
      right.push([p[0] - wx, p[1] - wy, p[2] - wz]);
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = left[i];
      const b = right[i];
      const c = right[i + 1];
      const d = left[i + 1];
      const n = pts[i].n;
      const ex = b[0] - a[0];
      const ey = b[1] - a[1];
      const ez = b[2] - a[2];
      const fx = d[0] - a[0];
      const fy = d[1] - a[1];
      const fz = d[2] - a[2];
      const dot = (ey * fz - ez * fy) * n[0] + (ez * fx - ex * fz) * n[1] + (ex * fy - ey * fx) * n[2];
      if (dot >= 0) target.quad(a, b, c, d);
      else target.quad(a, d, c, b);
    }
  }

  /** Runs `fn` (which builds +X side features) then mirrors everything it added to the -X side. */
  mirrored(fn: () => void): void {
    const a = this.paint.triangleCount;
    const b = this.glass.triangleCount;
    const c = this.parts.triangleCount;
    fn();
    this.paint.mirrorX(a);
    this.glass.mirrorX(b);
    this.parts.mirrorX(c);
  }

  /** Dark trim material state on the parts builder. */
  trim(rough = 0.55, metal = 0.1): GeoBuilder {
    return this.parts.paint(COL_TRIM, rough, metal);
  }

  /** Emissive lamp state on the parts builder: lens colour + channel. */
  lamp(channel: number, lens: THREE.ColorRepresentation = 0xd8dce4): GeoBuilder {
    return this.parts.color(lens).surface(0.12, 0.55).channel(channel);
  }

  // ---------------------------------------------------------------------------
  // shell
  // ---------------------------------------------------------------------------

  private stations(): number[] {
    const s = this.s;
    const d = this.def;
    const cfg = DETAIL[this.detail];
    const hStep = this.detail === 'traffic' ? Math.max(cfg.h, s.L / 11) : cfg.h;
    const rN = Math.max(d.nose.r, d.nose.rv);
    const rT = Math.max(d.tail.r, d.tail.rv);
    const out: number[] = [];
    for (let k = 0; k < cfg.nEnd; k++) {
      const phi = Math.pow(k / cfg.nEnd, 1.35) * (Math.PI / 2);
      out.push(s.zNose - rN * (1 - Math.pow(Math.cos(phi), 2 / 2.4)));
    }
    const keys: number[] = [s.zNose - rN, s.zCowl, s.zRoofF, s.zRoofR, s.zDeck, s.zTail + rT];
    const add = (z: number): void => {
      if (z > s.zTail + rT + 0.03 && z < s.zNose - rN - 0.03) keys.push(z);
    };
    add(this.zHoodF);
    add(s.zCowl - d.mirrorSail);
    add(s.zOf(d.sideGlassEnd));
    if (d.rearGlass) {
      add(s.zOf(d.rearGlass[0]));
      add(s.zOf(d.rearGlass[1]));
    }
    if (this.detail !== 'traffic' || d.pillars.length > 2)
      for (const p of d.pillars) {
        add(s.zOf(p) + 0.035);
        add(s.zOf(p) - 0.035);
      }
    keys.sort((a, b) => b - a);
    const uniq: number[] = [];
    for (const z of keys) if (uniq.length === 0 || uniq[uniq.length - 1] - z > 0.022) uniq.push(z);
    uniq[uniq.length - 1] = s.zTail + rT;
    for (let i = 0; i < uniq.length - 1; i++) {
      const a = uniq[i];
      const b = uniq[i + 1];
      const n = Math.max(1, Math.round((a - b) / hStep));
      for (let k = 0; k < n; k++) out.push(a + ((b - a) * k) / n);
    }
    for (let k = cfg.nEnd; k >= 0; k--) {
      const phi = Math.pow(k / cfg.nEnd, 1.35) * (Math.PI / 2);
      out.push(s.zTail + rT * (1 - Math.pow(Math.cos(phi), 2 / 2.4)));
    }
    return out;
  }

  /** Outline points of the +X half section (floor centre → top centre) and the segment of each interval. */
  private outline(sec: Section, segs: number[], idx: number[]): P3[] {
    const s = this.s;
    const d = this.def;
    const cfg = DETAIL[this.detail];
    const pts: P3[] = [];
    const z = sec.z;
    const push = (x: number, y: number, seg: number, i: number): void => {
      if (pts.length > 0) {
        segs.push(seg);
        idx.push(i);
      }
      pts.push([Math.max(0, x), y, z]);
    };
    segs.length = 0;
    idx.length = 0;
    // floor
    push(0, sec.yb, SEG.floor, 0);
    push(sec.wb * 0.74, sec.yb, SEG.floor, 0);
    push(sec.wb + s.flareAt(z, sec.yb) * sec.pe, sec.yb, SEG.floor, 1);
    // side: lower part
    const sR = 1 - d.shoulderR;
    for (let i = 1; i <= cfg.nLow; i++) {
      const sv = sR * Math.pow(i / cfg.nLow, 1.2);
      const y = sec.yb + (sec.ys - sec.yb) * sv;
      push(sec.W * s.sideProfile(sv) + s.flareAt(z, y) * sec.pe, y, SEG.side, i - 1);
    }
    // side: shoulder fillet
    for (let i = 1; i <= cfg.nFil; i++) {
      const th = (i / cfg.nFil) * (Math.PI / 2);
      const u = Math.pow(Math.sin(th), 2 / d.shoulderA);
      const sv = sR + (1 - sR) * u;
      const y = sec.yb + (sec.ys - sec.yb) * sv;
      push(sec.W * s.sideProfile(sv) + s.flareAt(z, y) * sec.pe, y, SEG.side, cfg.nLow + i - 1);
    }
    // ledge: shoulder → glass base (follows the hood crown)
    for (let i = 1; i <= cfg.nLedge; i++) {
      const x = sec.xs + (sec.wg0 - sec.xs) * (i / cfg.nLedge);
      const y = sec.ytv - (sec.ytv - sec.ys) * Math.pow(sec.xs > 1e-6 ? x / sec.xs : 0, d.pHood);
      push(x, y, SEG.ledge, i - 1);
    }
    // side glass
    for (let i = 1; i < cfg.glassS.length; i++) {
      const g = cfg.glassS[i];
      const bulge = Math.sin(Math.PI * g) * 0.018 * Math.min(1, sec.E / 0.3);
      push(sec.wg0 + (sec.wg1 - sec.wg0) * g + bulge, sec.yL + sec.E * g, SEG.glass, i - 1);
    }
    // top: edge → centre
    for (let i = 1; i < cfg.topR.length; i++) {
      const r = cfg.topR[i];
      push(sec.wg1 * r, sec.yg + (sec.yt - sec.yg) * s.crown(r, sec.k), SEG.top, i - 1);
    }
    return pts;
  }

  private buildShell(): void {
    const s = this.s;
    const d = this.def;
    const cfg = DETAIL[this.detail];
    const zs = this.stations();
    const segs: number[] = [];
    const idx: number[] = [];
    const rows: P3[][] = [];
    const sec = newSection();
    for (const z of zs) rows.push(this.outline(s.section(z, sec), segs, idx));
    const nI = rows[0].length - 1;
    const nGlassRows = cfg.glassS.length - 1;
    const zSideF = s.zCowl - d.mirrorSail;
    const zSideR = s.zOf(d.sideGlassEnd);
    const pillarZ = d.pillars.map((p) => s.zOf(p));
    const rg0 = d.rearGlass ? s.zOf(d.rearGlass[0]) : 0;
    const rg1 = d.rearGlass ? s.zOf(d.rearGlass[1]) : 0;
    const bumperRows = Math.round(cfg.nLow * 0.72);
    const cabinF = s.zCowl + 0.12;
    const cabinR = Math.min(s.zDeck, zSideR) - 0.06;
    const trafficGlass = this.detail === 'traffic';
    const livery = this.opts.livery;
    const cuts: [P3, P3, number][] = [];
    const paint = this.paint;
    const eps = 1e-4;

    const emitPaint = (a: P3, b: P3, c: P3, seg: number, part: number, interior: boolean): void => {
      // wheel-arch cut-outs on the body side
      let tris: P3[][] = [[a, b, c]];
      if (seg === SEG.side || seg === SEG.ledge || seg === -1) {
        for (let k = 0; k < 2; k++) {
          const zc = s.axleZ[k];
          if (Math.abs(a[2] - zc) > s.archR + 0.5) continue;
          const next: P3[][] = [];
          for (const t of tris) clipOutsideCircle(t[0], t[1], t[2], zc, s.axleY, s.archR, next, cuts, k);
          tris = next;
        }
      }
      if (tris.length === 0) return;
      if (livery) {
        const cz = (a[2] + b[2] + c[2]) / 3;
        const cy = (a[1] + b[1] + c[1]) / 3;
        paint.color(livery(seg === -1 ? SEG.floor : seg, cz, cy));
      }
      paint.setPart(part);
      for (const t of tris) paint.tri(t[0], t[1], t[2]);
      if (interior) {
        this.parts.paint(COL_INTERIOR, 0.92, 0).setPart(PART.body);
        for (const t of tris) this.parts.tri(t[0], t[2], t[1]);
      }
    };

    paint.color(0xffffff).surface(this.opts.mergePaint?.[0] ?? 0.5, this.opts.mergePaint?.[1] ?? 0);
    this.glass.color(0xffffff).setPart(PART.body);
    for (let j = 0; j < rows.length - 1; j++) {
      const r0 = rows[j];
      const r1 = rows[j + 1];
      const zm = (zs[j] + zs[j + 1]) / 2;
      const inCabin = zm < cabinF && zm > cabinR;
      for (let i = 0; i < nI; i++) {
        const seg = segs[i];
        const k = idx[i];
        const a = r0[i];
        const b = r1[i];
        const c = r1[i + 1];
        const e = r0[i + 1];
        // --- glazing?
        let glass = false;
        if (seg === SEG.top && k >= cfg.pillarCols) {
          if (zm < s.zCowl - eps && zm > s.zRoofF + eps) glass = true;
          else if (d.roofGlass && zm < s.zRoofF && zm > s.zRoofR) glass = true;
          else if (d.rearGlass && zm < rg0 - eps && zm > rg1 + eps) glass = true;
        } else if (seg === SEG.glass && k < nGlassRows - 1) {
          if (zm < zSideF && zm > zSideR) {
            glass = true;
            for (const pz of pillarZ) if (Math.abs(zm - pz) < 0.035) glass = false;
          }
        }
        if (glass) {
          if (trafficGlass) {
            this.parts.paint(0x39424d, 0.08, 0.92).setPart(PART.body);
            this.parts.quad(a, b, c, e);
          } else this.glass.quad(a, b, c, e);
          continue;
        }
        // --- damage part
        let part: number = PART.body;
        if (zm > this.zBumperF && (seg === SEG.floor || (seg === SEG.side && k < bumperRows))) part = PART.frontBumper;
        else if (zm < this.zBumperR && (seg === SEG.floor || (seg === SEG.side && k < bumperRows))) part = PART.rearBumper;
        else if ((seg === SEG.top || seg === SEG.ledge) && zm < this.zHoodF && zm > s.zCowl) part = PART.hood;
        const interior = inCabin && !trafficGlass;
        // outer floor strip is clipped like the side (tag -1)
        const tag = seg === SEG.floor ? (k === 1 ? -1 : SEG.floor) : seg;
        emitPaint(a, b, c, tag, part, interior);
        emitPaint(a, c, e, tag, part, interior);
      }
    }

    // --- wheel-well liners from the cut edges
    this.trim(0.95, 0);
    this.parts.setPart(PART.body);
    for (const [p, q, k] of cuts) {
      const xi = s.wellX[k];
      if (p[0] <= xi + 0.005 && q[0] <= xi + 0.005) continue;
      const p2: P3 = [Math.min(xi, p[0]), p[1], p[2]];
      const q2: P3 = [Math.min(xi, q[0]), q[1], q[2]];
      const zc = s.axleZ[k];
      // orient toward the axle
      const mx = (p[1] + q[1]) / 2 - s.axleY;
      const mz = (p[2] + q[2]) / 2 - zc;
      const ex = q[1] - p[1];
      const ez = q[2] - p[2];
      // normal of quad (p, q, q2, p2) in the yz-plane ~ (0, ez, -ex) * sign(dx)
      const inward = -(ez * mx - ex * mz) > 0;
      if (inward) this.parts.quad(p, q, q2, p2);
      else this.parts.quad(p, p2, q2, q);
      const cpt: P3 = [xi, s.axleY, zc];
      if (inward) this.parts.tri(cpt, p2, q2);
      else this.parts.tri(cpt, q2, p2);
    }

    // --- cabin bulkheads (close the interior tub)
    if (!trafficGlass) {
      this.parts.paint(COL_INTERIOR, 0.92, 0).setPart(PART.body);
      for (const [zc, facing] of [
        [cabinF, -1],
        [cabinR, 1],
      ] as const) {
        const o = this.outline(s.section(zc, sec), [], []);
        const mid: P3 = [0, (sec.yb + sec.yt) / 2, zc];
        for (let i = 0; i < o.length - 1; i++) {
          if (facing < 0) this.parts.tri(mid, o[i + 1], o[i]);
          else this.parts.tri(mid, o[i], o[i + 1]);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // generic details
  // ---------------------------------------------------------------------------

  private buildShutLines(): void {
    if (!this.hi) return;
    const s = this.s;
    const d = this.def;
    const sec = newSection();
    this.trim(0.7, 0).setPart(PART.body);
    const w = 0.009;
    // doors
    const zDoorF = s.zCowl - 0.06;
    const zB = d.pillars.length ? s.zOf(d.pillars[0]) : s.zOf(d.sideGlassEnd);
    const doorEdges: number[] = [zDoorF, zB - 0.02];
    if (d.doors > 1) doorEdges.push(s.zOf(d.sideGlassEnd) + 0.02);
    const yRock = (z: number): number => s.section(z, sec).yb + 0.075;
    const yBelt = (z: number): number => {
      const c = s.section(z, sec);
      return c.yb + (c.ys - c.yb) * (1 - d.shoulderR * 0.55);
    };
    for (const z of doorEdges) {
      const tilt = z === zDoorF ? 0.05 : -0.03;
      this.ribbon('side', this.parts, [
        [z - tilt, yRock(z)],
        [z, (yRock(z) + yBelt(z)) / 2],
        [z + tilt * 0.4, yBelt(z)],
      ], w);
    }
    const zLast = doorEdges[doorEdges.length - 1];
    this.ribbon('side', this.parts, [
      [zDoorF - 0.05, yRock(zDoorF)],
      [(zDoorF + zLast) / 2, yRock((zDoorF + zLast) / 2)],
      [zLast, yRock(zLast)],
    ], w);
    // door handles
    for (let i = 1; i < doorEdges.length; i++) {
      const z = doorEdges[i] + 0.16;
      const y = yBelt(z) - 0.035;
      this.parts.paint(0x101012, 0.3, 0.6);
      this.rect('side', this.parts, z - 0.075, y - 0.014, z + 0.075, y + 0.014, { nu: 2, nv: 1, off: 0.006 });
    }
    this.trim(0.7, 0);
    // bumper split lines
    for (const zb of [this.zBumperF, this.zBumperR]) {
      const c = s.section(zb, sec);
      const y1 = c.yb + (c.ys - c.yb) * (1 - d.shoulderR) * 0.66;
      this.ribbon('side', this.parts, [
        [zb, c.yb + 0.02],
        [zb, y1],
      ], w);
    }
    // hood (top view): sides + leading edge
    const hoodX = (z: number): number => s.section(z, sec).wg0 * 0.985;
    const zH0 = s.zCowl + 0.03;
    const zH1 = this.zHoodF;
    this.mirrored(() => {
      const pts: P2[] = [];
      for (let i = 0; i <= 6; i++) {
        const z = zH0 + ((zH1 - zH0) * i) / 6;
        pts.push([hoodX(z), z]);
      }
      this.ribbon('top', this.parts, pts, w);
      this.ribbon('top', this.parts, [
        [0, zH1],
        [hoodX(zH1) * 0.5, zH1],
        [hoodX(zH1), zH1],
      ], w);
    });
    // trunk lid
    if (d.trunkLid) {
      const zT0 = s.zDeck - 0.05;
      const zT1 = s.zTail + Math.max(d.tail.rv, 0.1) + 0.03;
      if (zT0 - zT1 > 0.2)
        this.mirrored(() => {
          const pts: P2[] = [];
          for (let i = 0; i <= 4; i++) {
            const z = zT0 + ((zT1 - zT0) * i) / 4;
            pts.push([s.section(z, sec).wg0 * 0.97, z]);
          }
          this.ribbon('top', this.parts, pts, w);
          this.ribbon('top', this.parts, [
            [0, zT0],
            [s.section(zT0, sec).wg0 * 0.97, zT0],
          ], w);
        });
    }
    // fuel filler (left rear quarter)
    {
      const z = s.axleZ[1] + 0.02;
      const c = s.section(z, sec);
      const y = c.yb + (c.ys - c.yb) * 0.86;
      if (y > s.axleY + s.archR + 0.06) this.disc('side', this.parts, z, y, 0.07, 0.07, { inner: 0.86, nu: 14, off: 0.0015 });
    }
  }

  private buildMirrors(): void {
    if (this.detail === 'traffic') return;
    const s = this.s;
    const sec = newSection();
    const z = s.zCowl - this.def.mirrorSail - 0.02;
    const c = s.section(z, sec);
    const yBase = c.yL + 0.03;
    const x0 = c.wg0 - 0.01;
    const segsU = this.hi ? 8 : 5;
    const segsV = this.hi ? 6 : 4;
    this.mirrored(() => {
      // stalk
      this.trim(0.5, 0.2).setPart(PART.body);
      this.parts.hexa(
        [
          [x0, yBase - 0.012, z - 0.03],
          [x0 + 0.1, yBase + 0.012, z - 0.03],
          [x0 + 0.1, yBase + 0.012, z + 0.03],
          [x0, yBase - 0.012, z + 0.03],
        ],
        [
          [x0, yBase + 0.014, z - 0.02],
          [x0 + 0.1, yBase + 0.034, z - 0.02],
          [x0 + 0.1, yBase + 0.034, z + 0.02],
          [x0, yBase + 0.014, z + 0.02],
        ],
      );
      // housing (painted)
      const m = trs(x0 + 0.15, yBase + 0.062, z + 0.012, 0, 0.12, 0, 0.1, 0.062, 0.06);
      this.paint.color(0xffffff).setPart(PART.body);
      this.paint.addGeometry(new THREE.SphereGeometry(1, segsU, segsV), m);
      // mirror glass
      this.parts.paint(0x9aa4b0, 0.05, 1);
      this.parts.addGeometry(
        new THREE.CircleGeometry(1, 10),
        trs(x0 + 0.152, yBase + 0.062, z - 0.047, 0, Math.PI, 0, 0.085, 0.05, 1),
      );
    });
  }

  private buildWipers(): void {
    if (!this.hi) return;
    const s = this.s;
    const sec = s.section(s.zCowl, newSection());
    const w = sec.wg0;
    this.trim(0.6, 0.1).setPart(PART.body);
    const z0 = s.zCowl - 0.035;
    this.ribbon('top', this.parts, [
      [w * 0.55, z0 - 0.01],
      [w * 0.05, z0 - 0.05],
    ], 0.022, 0.012);
    this.ribbon('top', this.parts, [
      [-w * 0.1, z0 - 0.01],
      [-w * 0.62, z0 - 0.05],
    ], 0.022, 0.012);
    // cowl panel
    this.trim(0.8, 0);
    this.rect('top', this.parts, -w * 0.92, s.zCowl - 0.005, w * 0.92, s.zCowl + 0.045, { nu: 8, nv: 1, off: 0.002 });
  }

  private buildInterior(): void {
    if (!(this.opts.interior ?? this.hi)) return;
    const s = this.s;
    const d = this.def;
    const sec = s.section(s.zCowl - 0.3, newSection());
    const p = this.parts;
    const floorY = s.ride + 0.05;
    const beltY = sec.yL;
    const halfCabin = sec.wg0 * 0.96;
    p.setPart(PART.body);
    // dashboard
    p.paint(0x0d0d10, 0.85, 0);
    const zD0 = s.zCowl + 0.05;
    const zD1 = s.zCowl - 0.42;
    p.hexa(
      [
        [-halfCabin, beltY - 0.3, zD1],
        [halfCabin, beltY - 0.3, zD1],
        [halfCabin, beltY - 0.3, zD0],
        [-halfCabin, beltY - 0.3, zD0],
      ],
      [
        [-halfCabin, beltY - 0.07, zD1],
        [halfCabin, beltY - 0.07, zD1],
        [halfCabin, beltY - 0.012, zD0],
        [-halfCabin, beltY - 0.012, zD0],
      ],
    );
    // instrument binnacle + gauges (left-hand drive: the driver sits at +X)
    const driverX = halfCabin * 0.5;
    p.box(driverX, beltY - 0.035, zD1 + 0.06, 0.34, 0.09, 0.14);
    const gr = atlasRect('gauges');
    p.color(0xffffff).surface(0.4, 0).channel(CH.drl);
    p.quad(
      [driverX + 0.15, beltY - 0.07, zD1 - 0.012],
      [driverX - 0.15, beltY - 0.07, zD1 - 0.012],
      [driverX - 0.15, beltY + 0.005, zD1 - 0.011],
      [driverX + 0.15, beltY + 0.005, zD1 - 0.011],
      [gr.u0, gr.v0],
      [gr.u1, gr.v0],
      [gr.u1, gr.v1],
      [gr.u0, gr.v1],
    );
    p.channel(CH.none);
    // steering wheel
    p.paint(0x070708, 0.7, 0);
    const wheelZ = zD1 - 0.11;
    const wheelY = beltY - 0.1;
    p.addGeometry(new THREE.TorusGeometry(0.175, 0.017, 6, 18), trs(driverX, wheelY, wheelZ, -0.38, 0, 0));
    p.addGeometry(new THREE.CylinderGeometry(0.045, 0.05, 0.03, 8), trs(driverX, wheelY, wheelZ, Math.PI / 2 - 0.38, 0, 0));
    p.box(driverX, wheelY, wheelZ, 0.32, 0.03, 0.012);
    p.addGeometry(new THREE.CylinderGeometry(0.025, 0.03, 0.26, 6), trs(driverX, wheelY + 0.03, wheelZ + 0.13, Math.PI / 2 - 0.38, 0, 0));
    // centre console
    p.paint(0x0c0c0e, 0.8, 0);
    const seatZ = s.zCowl - d.seatZ;
    p.box(0, floorY + 0.15, seatZ + 0.2, 0.2, 0.3, 1.1);
    // gear lever
    p.paint(0x8a8d92, 0.3, 1);
    p.addGeometry(new THREE.CylinderGeometry(0.012, 0.012, 0.16, 6), trs(0, floorY + 0.36, seatZ + 0.42, 0.2, 0, 0));
    p.addGeometry(new THREE.SphereGeometry(0.03, 8, 6), trs(0, floorY + 0.45, seatZ + 0.44));
    // seats
    const seatX = halfCabin * 0.52;
    for (const sx of [seatX, -seatX]) {
      p.paint(0x101013, 0.9, 0);
      // cushion
      p.hexa(
        [
          [sx - 0.24, floorY + 0.08, seatZ - 0.26],
          [sx + 0.24, floorY + 0.08, seatZ - 0.26],
          [sx + 0.24, floorY + 0.08, seatZ + 0.27],
          [sx - 0.24, floorY + 0.08, seatZ + 0.27],
        ],
        [
          [sx - 0.22, floorY + 0.22, seatZ - 0.24],
          [sx + 0.22, floorY + 0.22, seatZ - 0.24],
          [sx + 0.22, floorY + 0.26, seatZ + 0.26],
          [sx - 0.22, floorY + 0.26, seatZ + 0.26],
        ],
      );
      // backrest (raked)
      const top = Math.min(sec.yL + 0.3, s.H - 0.14);
      p.hexa(
        [
          [sx - 0.23, floorY + 0.16, seatZ - 0.36],
          [sx + 0.23, floorY + 0.16, seatZ - 0.36],
          [sx + 0.23, floorY + 0.2, seatZ - 0.22],
          [sx - 0.23, floorY + 0.2, seatZ - 0.22],
        ],
        [
          [sx - 0.19, top - 0.14, seatZ - 0.56],
          [sx + 0.19, top - 0.14, seatZ - 0.56],
          [sx + 0.19, top - 0.14, seatZ - 0.45],
          [sx - 0.19, top - 0.14, seatZ - 0.45],
        ],
      );
      // headrest
      p.box(sx, top - 0.06, seatZ - 0.53, 0.22, 0.15, 0.09);
      // bolster accents
      p.paint(0x2a2a30, 0.7, 0);
      p.box(sx - 0.235, floorY + 0.24, seatZ, 0.05, 0.1, 0.46);
      p.box(sx + 0.235, floorY + 0.24, seatZ, 0.05, 0.1, 0.46);
    }
    // rear shelf / bench behind the seats
    const zShelf0 = seatZ - 0.62;
    const zShelf1 = Math.min(s.zDeck, s.zOf(d.sideGlassEnd)) - 0.04;
    if (zShelf0 - zShelf1 > 0.12) {
      p.paint(0x0c0c0e, 0.9, 0);
      p.box(0, beltY - 0.16, (zShelf0 + zShelf1) / 2, halfCabin * 2, 0.06, zShelf0 - zShelf1);
    }
  }

  private buildExhausts(): void {
    const s = this.s;
    const d = this.def;
    const sec = newSection();
    const count = Math.min(d.exhaust.x.length, this.opts.exhaustCount ?? d.exhaust.x.length);
    const r = d.exhaust.radius;
    const segs = this.hi ? 12 : 7;
    const xsList = count === 1 && d.exhaust.x.length > 1 ? [-d.exhaust.x[0]] : d.exhaust.x.slice(0, count);
    for (const x of xsList) {
      const y = s.section(s.zTail + 0.3, sec).yb + d.exhaust.y;
      const zSurf = s.rearZ(Math.abs(x), y);
      const z = Math.min(zSurf, s.zTail + 0.25) - 0.035;
      const p = this.parts;
      p.setPart(PART.body);
      // polished outer tube
      p.paint(0xc8ccd2, 0.14, 1);
      const m = trs(x, y, z + 0.09, Math.PI / 2, 0, 0);
      p.addGeometry(new THREE.CylinderGeometry(r, r, 0.2, segs, 1, true), m);
      // lip ring + dark inside
      p.addGeometry(new THREE.RingGeometry(r * 0.82, r, segs), trs(x, y, z - 0.01, 0, Math.PI, 0));
      p.paint(0x050505, 0.9, 0.2);
      p.addGeometry(new THREE.CylinderGeometry(r * 0.82, r * 0.82, 0.16, segs, 1, true), trs(x, y, z + 0.07, Math.PI / 2, 0, 0).multiply(new THREE.Matrix4().makeScale(-1, 1, 1)));
      p.addGeometry(new THREE.CircleGeometry(r * 0.82, segs), trs(x, y, z + 0.15, 0, Math.PI, 0));
      this.exhausts.push([x, y, z - 0.02]);
    }
  }

  private buildNeonTubes(): void {
    if (this.detail === 'traffic') return;
    const s = this.s;
    const sec = newSection();
    const p = this.parts;
    p.color(0x0a0a0c).surface(0.4, 0).channel(CH.neon).setPart(PART.body);
    const z0 = s.axleZ[0] - s.archR - 0.08;
    const z1 = s.axleZ[1] + s.archR + 0.08;
    const c = s.section(0, sec);
    const y = c.yb - 0.012;
    const x = c.wb - 0.07;
    for (const sx of [x, -x]) p.box(sx, y, (z0 + z1) / 2, 0.022, 0.022, z0 - z1);
    const cf = s.section(s.zNose - 0.45, sec);
    p.box(0, cf.yb - 0.012, s.zNose - 0.45, cf.wb * 1.5, 0.022, 0.022);
    const cr = s.section(s.zTail + 0.4, sec);
    p.box(0, cr.yb - 0.012, s.zTail + 0.4, cr.wb * 1.5, 0.022, 0.022);
    p.channel(CH.none);
  }

  // ---------------------------------------------------------------------------
  // body kits
  // ---------------------------------------------------------------------------

  /** Points of the nose / tail plan curve at height y, from the centre (x = 0) to xMax. */
  private planCurve(view: 'front' | 'rear', y: number, xMax: number, n: number): P3[] {
    const pts: P3[] = [];
    for (let i = 0; i <= n; i++) {
      const x = xMax * Math.sin(((i / n) * Math.PI) / 2);
      const z = view === 'front' ? this.s.frontZ(x, y) : this.s.rearZ(x, y);
      pts.push([x, y, z]);
    }
    return pts;
  }

  /** Horizontal blade following the nose / tail plan (splitters, lips, diffuser plates). */
  private blade(view: 'front' | 'rear', target: GeoBuilder, yRef: number, y0: number, y1: number, xMax: number, out: number, inn: number): void {
    const n = this.hi ? 14 : 7;
    const base = this.planCurve(view, yRef, xMax, n);
    const dir = view === 'front' ? 1 : -1;
    const outer: P3[] = [];
    const inner: P3[] = [];
    for (let i = 0; i <= n; i++) {
      const p0 = base[Math.max(0, i - 1)];
      const p1 = base[Math.min(n, i + 1)];
      // plan normal (pointing away from the car)
      let nx = -(p1[2] - p0[2]) * dir;
      let nz = (p1[0] - p0[0]) * dir;
      const l = Math.hypot(nx, nz) || 1;
      nx /= l;
      nz /= l;
      if (i === 0) {
        nx = 0;
        nz = dir;
      }
      const taper = i === n ? 0.35 : 1;
      outer.push([base[i][0] + nx * out * taper, 0, base[i][2] + nz * out * taper]);
      inner.push([Math.max(0, base[i][0] - nx * inn), 0, base[i][2] - nz * inn]);
    }
    const from = target.triangleCount;
    for (let i = 0; i < n; i++) {
      const o0 = outer[i];
      const o1 = outer[i + 1];
      const i0 = inner[i];
      const i1 = inner[i + 1];
      const quadUp = (a: P3, b: P3, c: P3, d: P3): void => {
        if (dir > 0) target.quad(a, b, c, d);
        else target.quad(a, d, c, b);
      };
      // top, bottom, outer edge
      quadUp([o0[0], y1, o0[2]], [o1[0], y1, o1[2]], [i1[0], y1, i1[2]], [i0[0], y1, i0[2]]);
      quadUp([o0[0], y0, o0[2]], [i0[0], y0, i0[2]], [i1[0], y0, i1[2]], [o1[0], y0, o1[2]]);
      quadUp([o0[0], y0, o0[2]], [o1[0], y0, o1[2]], [o1[0], y1, o1[2]], [o0[0], y1, o0[2]]);
    }
    // end cap
    const oe = outer[n];
    const ie = inner[n];
    if (dir > 0) target.quad([oe[0], y0, oe[2]], [ie[0], y0, ie[2]], [ie[0], y1, ie[2]], [oe[0], y1, oe[2]]);
    else target.quad([oe[0], y0, oe[2]], [oe[0], y1, oe[2]], [ie[0], y1, ie[2]], [ie[0], y0, ie[2]]);
    target.mirrorX(from);
  }

  private buildKit(): void {
    const kit = this.kit;
    if (kit <= 0 || this.detail === 'traffic') return;
    const s = this.s;
    const sec = newSection();
    const p = this.parts;

    // --- front lip / splitter
    const cN = s.section(s.zNose - Math.max(this.def.nose.r, 0.3), sec);
    const yN = s.section(s.zNose - 0.06, sec).yb;
    const xLip = cN.wb * 0.97;
    p.paint(0x0a0a0c, kit === 3 ? 0.35 : 0.5, 0.3).setPart(PART.frontBumper);
    if (kit === 3) {
      this.blade('front', p, yN + 0.035, yN - 0.03, yN - 0.008, xLip, 0.13, 0.12);
      // support rods
      p.paint(0x9a9da2, 0.3, 1);
      for (const x of [0.32, -0.32]) {
        const z = s.frontZ(Math.abs(x), yN + 0.14);
        p.tube([
          [x, yN - 0.01, z + 0.1],
          [x, yN + 0.14, z + 0.005],
        ], 0.007, 5);
      }
    } else {
      this.blade('front', p, yN + 0.03, yN - 0.022, yN + 0.004, xLip, kit === 2 ? 0.075 : 0.055, 0.08);
    }

    // --- side skirts
    const z0 = s.axleZ[0] - s.archR - 0.03;
    const z1 = s.axleZ[1] + s.archR + 0.03;
    const nSk = this.hi ? 8 : 4;
    const skirtOut = kit === 1 ? 0.028 : 0.045;
    const skirtH = kit === 3 ? 0.1 : 0.08;
    this.mirrored(() => {
      this.paint.color(0xffffff).setPart(PART.body);
      const outerTop: P3[] = [];
      const outerBot: P3[] = [];
      const innerTop: P3[] = [];
      const innerBot: P3[] = [];
      for (let i = 0; i <= nSk; i++) {
        const z = z0 + ((z1 - z0) * i) / nSk;
        const c = s.section(z, sec);
        const taper = i === 0 || i === nSk ? 0.4 : 1;
        const xb = s.sideX(z, c.yb + skirtH);
        const xo = Math.max(xb, s.sideX(z, c.yb + 0.01)) + skirtOut * taper;
        outerTop.push([xo, c.yb + skirtH * 0.75, z]);
        outerBot.push([xo + 0.004, c.yb - 0.025, z]);
        innerTop.push([xb - 0.01, c.yb + skirtH, z]);
        innerBot.push([xb - 0.08, c.yb - 0.025, z]);
      }
      for (let i = 0; i < nSk; i++) {
        this.paint.quad(outerBot[i], outerBot[i + 1], outerTop[i + 1], outerTop[i]);
        this.paint.quad(outerTop[i], outerTop[i + 1], innerTop[i + 1], innerTop[i]);
        this.paint.quad(innerBot[i], innerBot[i + 1], outerBot[i + 1], outerBot[i]);
      }
      this.paint.quad(outerBot[0], outerTop[0], innerTop[0], innerBot[0]);
      this.paint.quad(outerBot[nSk], innerBot[nSk], innerTop[nSk], outerTop[nSk]);
      if (kit === 3) {
        // carbon blade under the skirt
        p.paint(0x0a0a0c, 0.35, 0.3).setPart(PART.body);
        for (let i = 0; i < nSk; i++) {
          const a = outerBot[i];
          const b = outerBot[i + 1];
          p.quad([a[0] + 0.05, a[1] - 0.004, a[2]], [b[0] + 0.05, b[1] - 0.004, b[2]], [b[0] - 0.02, b[1] + 0.002, b[2]], [a[0] - 0.02, a[1] + 0.002, a[2]]);
          p.quad([a[0] + 0.05, a[1] - 0.004, a[2]], [a[0] - 0.02, a[1] - 0.012, a[2]], [b[0] - 0.02, b[1] - 0.012, b[2]], [b[0] + 0.05, b[1] - 0.004, b[2]]);
        }
      }
    });

    // --- rear diffuser (wide + extreme)
    if (kit >= 2) {
      const yT = s.section(s.zTail + 0.1, sec).yb;
      const cT = s.section(s.zTail + Math.max(this.def.tail.r, 0.3), sec);
      p.paint(0x0a0a0c, 0.45, 0.3).setPart(PART.rearBumper);
      this.blade('rear', p, yT + 0.03, yT - 0.03, yT - 0.006, cT.wb * 0.8, kit === 3 ? 0.1 : 0.045, 0.3);
      const fins = kit === 3 ? 6 : 4;
      const finL = kit === 3 ? 0.42 : 0.3;
      const finH = kit === 3 ? 0.13 : 0.09;
      for (let i = 0; i < fins; i++) {
        const x = (i / (fins - 1) - 0.5) * 2 * cT.wb * 0.62;
        const zr = s.rearZ(Math.abs(x), yT + 0.03) - (kit === 3 ? 0.09 : 0.04);
        p.hexa(
          [
            [x - 0.008, yT - 0.035, zr],
            [x + 0.008, yT - 0.035, zr],
            [x + 0.008, yT - 0.03, zr + finL],
            [x - 0.008, yT - 0.03, zr + finL],
          ],
          [
            [x - 0.008, yT - 0.035 + finH, zr],
            [x + 0.008, yT - 0.035 + finH, zr],
            [x + 0.008, yT + 0.02, zr + finL],
            [x - 0.008, yT + 0.02, zr + finL],
          ],
        );
      }
    }

    // --- extreme: canards, hood vents, roof scoop
    if (kit === 3) {
      this.mirrored(() => {
        p.paint(0x0a0a0c, 0.35, 0.3).setPart(PART.frontBumper);
        const zc = s.axleZ[0] + s.archR + 0.12;
        const cc = s.section(zc, sec);
        for (const [h, len] of [
          [0.32, 0.26],
          [0.52, 0.2],
        ] as const) {
          const y = cc.yb + (cc.ys - cc.yb) * h;
          const za = zc;
          const zb = zc + len;
          const xa = s.sideX(za, y);
          const xb = s.sideX(zb, y - 0.05);
          p.hexa(
            [
              [xa - 0.01, y - 0.006, za],
              [xa + 0.085, y + 0.012, za],
              [xb + 0.03, y - 0.058, zb],
              [xb - 0.01, y - 0.058, zb],
            ],
            [
              [xa - 0.01, y + 0.006, za],
              [xa + 0.085, y + 0.024, za],
              [xb + 0.03, y - 0.046, zb],
              [xb - 0.01, y - 0.046, zb],
            ],
          );
        }
        // hood vents
        const zv0 = s.zCowl + (this.zHoodF - s.zCowl) * 0.3;
        const zv1 = s.zCowl + (this.zHoodF - s.zCowl) * 0.62;
        const wv = s.section((zv0 + zv1) / 2, sec).wg0;
        p.color(0xffffff).surface(0.6, 0.2).setPart(PART.hood);
        this.quadPatch('top', p, [wv * 0.3, zv0], [wv * 0.72, zv0 + 0.03], [wv * 0.66, zv1], [wv * 0.34, zv1 - 0.02], { nu: 3, nv: 3, tex: 'louvres', off: 0.004 });
      });
      // roof scoop
      const zs0 = s.zRoofF - 0.04;
      const zs1 = zs0 - 0.5;
      if (s.zRoofF - s.zRoofR > 0.45 && !this.def.roofGlass) {
        const rowsScoop: P3[][] = [];
        const nL = 5;
        for (let j = 0; j <= nL; j++) {
          const t = j / nL;
          const z = zs0 + (zs1 - zs0) * t;
          const hh = 0.075 * (1 - t * t);
          const ww = 0.17 * (1 - 0.35 * t);
          const row: P3[] = [];
          for (let i = 0; i <= 6; i++) {
            const a = (i / 6) * Math.PI;
            const x = Math.cos(a) * ww;
            row.push([x, s.topY(z, x) - 0.004 + Math.sin(a) * hh, z]);
          }
          rowsScoop.push(row);
        }
        this.paint.color(0xffffff).setPart(PART.body);
        this.paint.grid(rowsScoop, false);
        // dark mouth
        p.paint(0x030303, 0.9, 0).setPart(PART.body);
        const r0 = rowsScoop[0];
        const cy = s.topY(zs0, 0);
        for (let i = 0; i < r0.length - 1; i++) p.tri([0, cy, zs0 - 0.012], [r0[i + 1][0] * 0.9, cy + (r0[i + 1][1] - cy) * 0.86, zs0 - 0.012], [r0[i][0] * 0.9, cy + (r0[i][1] - cy) * 0.86, zs0 - 0.012]);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // spoilers
  // ---------------------------------------------------------------------------

  private buildSpoiler(): void {
    const sp = this.spoiler;
    if (sp <= 0 || this.detail === 'traffic') return;
    const s = this.s;
    const d = this.def;
    const sec = newSection();
    const zA = s.zOf(d.spoilerAt);
    const cA = s.section(zA, sec);
    const wDeck = Math.max(0.3, cA.E > 0.02 ? cA.wg1 : cA.xs) * 0.94;
    const n = this.hi ? 12 : 6;
    const topAt = (x: number, z: number): number => s.topY(z, x);

    if (sp === 1 || sp === 2) {
      // lip / ducktail: lofted wedge across the deck
      const chord = sp === 1 ? 0.085 : 0.26;
      const height = sp === 1 ? 0.035 : 0.105;
      const over = sp === 1 ? 0.0 : 0.05;
      const rowsS: P3[][] = [];
      const nx = n;
      // cross profile (z offset from the trailing edge, height) – front foot → crest → rear foot
      const prof: P2[] = sp === 1
        ? [[chord, 0], [chord * 0.35, height * 0.75], [0.004, height], [-0.004, height * 0.9], [-0.004, -0.004]]
        : [[chord, 0], [chord * 0.6, height * 0.12], [chord * 0.25, height * 0.5], [0.0, height], [-over, height * 1.02], [-over - 0.004, height * 0.86], [-0.01, -0.004]];
      for (const [dz, hh] of prof) {
        const row: P3[] = [];
        for (let i = 0; i <= nx; i++) {
          const u = (i / nx) * 2 - 1;
          const x = u * wDeck;
          const edge = Math.pow(1 - Math.pow(Math.abs(u), 6), 0.5);
          const z = zA + dz * (0.75 + 0.25 * edge) - 0.05 * u * u;
          row.push([x, topAt(x, Math.max(z, s.zTail + 0.02)) - 0.003 + hh * edge, z]);
        }
        rowsS.push(row);
      }
      this.paint.color(0xffffff).setPart(PART.body);
      this.paint.grid(rowsS, false);
      return;
    }

    // --- wings
    const drag = sp === 4;
    const span = drag ? s.halfW * 0.99 : Math.min(s.halfW * 0.9, wDeck + 0.22);
    const chord = drag ? 0.36 : 0.25;
    const zW = drag ? zA - 0.1 : zA + 0.02;
    const deckY = Math.max(topAt(0, Math.max(zW, s.zTail + 0.05)), topAt(span * 0.4, Math.max(zW, s.zTail + 0.05)));
    const yW = Math.max(deckY + (drag ? 0.4 : 0.22), drag ? s.H * 0.98 : 0);
    const aoa = drag ? 0.2 : 0.12;
    // aerofoil section (z forward, y up) around the quarter chord
    const foil = (c: number, t: number): P2[] => {
      const pts: P2[] = [];
      const m = this.hi ? 6 : 3;
      for (let i = 0; i <= m; i++) {
        const u = i / m;
        pts.push([c * (0.5 - u), t * 0.9 * Math.sin(Math.PI * Math.pow(u, 0.7)) + 0.01]);
      }
      for (let i = m; i >= 0; i--) {
        const u = i / m;
        pts.push([c * (0.5 - u), -t * 0.35 * Math.sin(Math.PI * Math.pow(u, 0.8))]);
      }
      return pts;
    };
    const plank = (target: GeoBuilder, c: number, t: number, zc: number, yc: number, ang: number, half: number): void => {
      const sectionPts = foil(c, t);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const rowsW: P3[][] = [];
      for (const x of [-half, half]) {
        rowsW.push(sectionPts.map(([dz, dy]) => [x, yc + dy * ca + dz * sa, zc + dz * ca - dy * sa] as P3));
      }
      target.grid(rowsW, true);
    };
    const wingTarget = drag ? this.parts : this.paint;
    if (drag) this.parts.paint(0x0b0b0d, 0.32, 0.35).setPart(PART.body);
    else this.paint.color(0xffffff).setPart(PART.body);
    plank(wingTarget, chord, 0.03, zW, yW, aoa, span);
    if (drag) plank(this.parts, 0.16, 0.018, zW - 0.2, yW + 0.075, 0.5, span);
    // end plates
    const p = this.parts;
    p.paint(0x0b0b0d, 0.32, 0.35).setPart(PART.body);
    const epH = drag ? 0.3 : 0.15;
    const epL = drag ? 0.52 : 0.31;
    for (const x of [span, -span]) {
      const zc = drag ? zW - 0.06 : zW;
      p.prism(
        [
          [zc + epL * 0.5, yW - epH * 0.45],
          [zc + epL * 0.42, yW + epH * 0.3],
          [zc - epL * 0.5, yW + epH * 0.55],
          [zc - epL * 0.5, yW - epH * 0.45],
        ],
        x - 0.007,
        x + 0.007,
        (a, b, dd) => [-dd, b, a],
      );
    }
    // struts
    const strutX = drag ? span * 0.42 : span * 0.5;
    for (const x of [strutX, -strutX]) {
      const zFoot = Math.max(zW + (drag ? 0.16 : 0.04), s.zTail + 0.1);
      const yFoot = topAt(x, zFoot) - 0.01;
      const yTop = yW - 0.012;
      p.prism(
        [
          [zFoot + 0.09, yFoot],
          [zW + chord * 0.3, yTop],
          [zW - chord * 0.3, yTop],
          [zFoot - 0.06, yFoot],
        ],
        x - 0.008,
        x + 0.008,
        (a, b, dd) => [-dd, b, a],
      );
    }
  }

  // ---------------------------------------------------------------------------

  build(): BodyGeometry {
    const s = this.s;
    const d = this.def;
    this.buildShell();
    // mirror the half shell (+ liners, interior copy) built so far
    this.paint.mirrorX(0);
    this.glass.mirrorX(0);
    this.parts.mirrorX(0);
    this.buildShutLines();
    this.buildMirrors();
    this.buildWipers();
    this.buildInterior();
    this.buildExhausts();
    this.buildNeonTubes();
    d.features(this);
    this.buildKit();
    this.buildSpoiler();
    this.opts.extraParts?.(this);
    if (this.opts.mergePaint) this.parts.append(this.paint);

    const sec = s.section(s.zCowl, newSection());
    const hoodPivot: P3 = [0, sec.ytv, s.zCowl];
    const cF = s.section(this.zBumperF, newSection());
    const frontBumperPivot: P3 = [cF.W * 0.9, cF.yb + (cF.ys - cF.yb) * 0.5, this.zBumperF];
    const cR = s.section(this.zBumperR, newSection());
    const rearBumperPivot: P3 = [-cR.W * 0.9, cR.yb + (cR.ys - cR.yb) * 0.5, this.zBumperR];
    const zPeak = s.zOf(d.roofF + (d.roofR - d.roofF) * 0.5);
    const cP = s.section(zPeak, newSection());
    if (this.headlights.length === 0) {
      const y = s.section(s.zNose - 0.3, newSection()).ys - 0.1;
      this.headlights.push([s.halfW * 0.68, y, s.zNose - 0.2], [-s.halfW * 0.68, y, s.zNose - 0.2]);
    }
    const metrics: BodyMetrics = {
      wheelX: [s.wheelX[0], s.wheelX[1]],
      axleZ: [s.axleZ[0], s.axleZ[1]],
      tyreW: [s.tyreW[0], s.tyreW[1]],
      wheelRadius: this.dims.wheelRadius,
      rimRatio: d.rimRatio,
      exhausts: this.exhausts,
      headlights: this.headlights,
      hoodPivot,
      frontBumperPivot,
      rearBumperPivot,
      floorY: s.ride,
      caliper: d.caliper,
      roofY: cP.yt,
      roofZ: zPeak,
      roofHalfW: cP.wg1,
    };
    const triangles = this.paint.triangleCount + this.glass.triangleCount + this.parts.triangleCount;
    return {
      paint: this.paint.build({ crease: 40, planarUv: true }),
      glass: this.glass.triangleCount > 0 ? this.glass.build({ crease: 50, planarUv: true, mat: false, color: false }) : null,
      parts: this.parts.build({ crease: 40 }),
      metrics,
      triangles,
    };
  }
}

/** Splits triangle (a, b, c) by the circle (zc, yc, R) in the ZY plane; keeps the part outside. */
function clipOutsideCircle(a: P3, b: P3, c: P3, zc: number, yc: number, R: number, out: P3[][], cuts: [P3, P3, number][], tag: number): void {
  const da = Math.hypot(a[2] - zc, a[1] - yc) - R;
  const db = Math.hypot(b[2] - zc, b[1] - yc) - R;
  const dc = Math.hypot(c[2] - zc, c[1] - yc) - R;
  const ia = da < 0;
  const ib = db < 0;
  const ic = dc < 0;
  const inside = (ia ? 1 : 0) + (ib ? 1 : 0) + (ic ? 1 : 0);
  if (inside === 0) {
    out.push([a, b, c]);
    return;
  }
  if (inside === 3) return;
  const cut = (p: P3, dp: number, q: P3, dq: number): P3 => {
    const t = dp / (dp - dq);
    const x = p[0] + (q[0] - p[0]) * t;
    let y = p[1] + (q[1] - p[1]) * t;
    let z = p[2] + (q[2] - p[2]) * t;
    const l = Math.hypot(z - zc, y - yc) || 1;
    y = yc + ((y - yc) * R) / l;
    z = zc + ((z - zc) * R) / l;
    return [x, y, z];
  };
  // rotate so that the odd vertex is first
  let v: [P3, P3, P3] = [a, b, c];
  let dd: [number, number, number] = [da, db, dc];
  if (inside === 1) {
    while (!(dd[0] < 0)) {
      v = [v[1], v[2], v[0]];
      dd = [dd[1], dd[2], dd[0]];
    }
    // v0 inside, v1 & v2 outside → quad (p01, v1, v2, p20)
    const p01 = cut(v[1], dd[1], v[0], dd[0]);
    const p20 = cut(v[2], dd[2], v[0], dd[0]);
    out.push([p01, v[1], v[2]]);
    out.push([p01, v[2], p20]);
    cuts.push([p01, p20, tag]);
  } else {
    while (dd[0] < 0) {
      v = [v[1], v[2], v[0]];
      dd = [dd[1], dd[2], dd[0]];
    }
    // v0 outside, v1 & v2 inside → triangle (v0, p01, p02)
    const p01 = cut(v[0], dd[0], v[1], dd[1]);
    const p02 = cut(v[0], dd[0], v[2], dd[2]);
    out.push([v[0], p01, p02]);
    cuts.push([p01, p02, tag]);
  }
}

// -----------------------------------------------------------------------------
// Geometry cache (bodies are shared by every instance with the same shape)
// -----------------------------------------------------------------------------

export function buildBody(def: BodyDef, dims: CarDimensions, opts: BodyBuildOptions): BodyGeometry {
  return new BodyBuilder(def, dims, opts).build();
}

export function disposeBody(g: BodyGeometry): void {
  g.paint.dispose();
  g.glass?.dispose();
  g.parts.dispose();
}
