/* =============================================================================
 * APEX NOCTURNE — race rivals.
 *
 * Each rival drives a real physics vehicle through its VehicleHandle.input:
 *  - a minimum-curvature racing line is pre-computed for the route at setup()
 *    (out-in-out through corners, the driver's own lane on straights);
 *  - pure-pursuit steering toward a look-ahead point of that line;
 *  - a per-driver speed profile (corner speed from lateral grip + backward
 *    braking pass) gives the target speed, a hysteresis controller the pedals;
 *  - dynamic obstacles (traffic, other racers, the player) shift the lateral
 *    target or make the driver lift; rubber-banding scales engine power.
 * Pure logic: no Three.js, no allocation in update().
 * ===========================================================================*/
import type {
  AIHost,
  BodyInfo,
  IRaceAI,
  RaceAIContext,
  RivalDriver,
  RivalSetup,
  Vec2,
  VehicleConfig,
} from '../core/types';
import type { PathProjection, PolylinePath } from '../core/path';
import { mulberry32 } from '../core/math';
import {
  GRAVITY,
  castFeeler,
  clampAbs,
  clearInput,
  cornerSpeed,
  createPedalState,
  createSteerMemo,
  hashString,
  steerToward,
  updatePedals,
} from './steering';
import type { PedalState, SteerMemo } from './steering';

/** Tunable constants of the rival AI. */
export const RACE_TUNING = {
  /** racing-line sample spacing (m) */
  lineStep: 3,
  /** margin kept between the car centre and the edge of the usable width (m) */
  edgeMargin: 1.5,
  /** look-ahead = lookBase + lookGain × speed (m) */
  lookBase: 6,
  lookGain: 0.45,
  /** lateral acceleration budget = (latBase + latSkill × skill) × grip × g */
  latBase: 0.72,
  latSkill: 0.22,
  /** planned braking = brakeShare × config.brakeDecel (scaled down for low skill) */
  brakeShare: 0.8,
  /** rubber band: distance (m) of the dead zone and of the full effect */
  rbBehindStart: 50,
  rbAheadStart: 60,
  rbRange: 260,
  rbBoost: 0.22,
  rbSlow: 0.16,
  rbGrip: 0.05,
  /** extra: target-speed easing when far ahead of the player (fraction × rubberBand) */
  rbPace: 0.05,
  /** base power scale from skill: powerMin + powerSkill × skill */
  powerMin: 0.92,
  powerSkill: 0.11,
  /** reaction delay at the green light (s): reactionSlow (skill 0) → reactionFast (skill 1) */
  reactionSlow: 0.45,
  reactionFast: 0.05,
  /** recovery */
  stuckSpeed: 2,
  stuckDelay: 2,
  reverseTime: 1.2,
  resetAfter: 6,
  resetForceAfter: 9,
  offRouteDist: 35,
  offRouteTime: 4,
  resetSpeed: 15,
};

// -----------------------------------------------------------------------------
// Racing line
// -----------------------------------------------------------------------------

interface RaceLine {
  n: number;
  /** mean distance between two samples along the line (m) */
  ds: number;
  closed: boolean;
  length: number;
  /** ideal line points (uniformly spaced) and right-hand normals */
  x: Float64Array;
  z: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
  /** route arc-length of the projection of every sample */
  rs: Float64Array;
  /** distance from sample i to sample i + 1 along the line (m) */
  seg: Float32Array;
  /** signed lateral position of the line relative to the route centre (m, + = right) */
  side: Float32Array;
  /** free room on the left / right of the line inside the usable width (m, >= 0) */
  roomL: Float32Array;
  roomR: Float32Array;
  /** line curvature (1/m, + = right turn) */
  kappa: Float32Array;
  /** 0 = straight (drivers keep their lane) .. 1 = corner (drivers follow the ideal line) */
  w: Float32Array;
}

function wrapIndex(i: number, n: number, closed: boolean): number {
  if (closed) {
    i %= n;
    return i < 0 ? i + n : i;
  }
  return i < 0 ? 0 : i >= n ? n - 1 : i;
}

/**
 * Minimum-curvature racing line inside the corridor "distance to the route <= halfWidth - margin".
 *  1. the route is sampled every ~3 m and rounded (binomial smoothing kept inside the corridor) so
 *     that sharp polyline corners get well-defined normals;
 *  2. every sample may slide along its normal between two limits found by bisection on the true
 *     distance to the route;
 *  3. a projected Gauss-Seidel relaxation minimises the bending energy (coarse → fine);
 *  4. the result is re-sampled uniformly and becomes the reference of the next round (the energy
 *     is parameterisation dependent: a few rounds converge to the true out-in-out line).
 */
function buildRaceLine(route: PolylinePath, halfWidth: number): RaceLine {
  const closed = route.closed;
  const length = route.length;
  const step = RACE_TUNING.lineStep;
  // multiple of 4 samples (closed) / 4k+1 samples (open) for the coarse relaxation level
  const quads = Math.max(2, Math.round(length / (step * 4)));
  const n = closed ? quads * 4 : quads * 4 + 1;
  const ds = closed ? length / n : length / (n - 1);
  const cx = new Float64Array(n);
  const cz = new Float64Array(n);
  const tx = new Float64Array(n);
  const tz = new Float64Array(n);
  const nx = new Float64Array(n);
  const nz = new Float64Array(n);
  const rs = new Float64Array(n);
  const cum = new Float64Array(n + 1);
  const off = new Float32Array(n);
  const oMin = new Float32Array(n);
  const oMax = new Float32Array(n);
  const p: Vec2 = { x: 0, z: 0 };
  const pr: PathProjection = { s: 0, dist: 0, side: 0, x: 0, z: 0 };
  for (let i = 0; i < n; i++) {
    route.pointAt(i * ds, p);
    cx[i] = p.x;
    cz[i] = p.z;
    rs[i] = i * ds;
  }
  const lim = Math.max(0.2, halfWidth - RACE_TUNING.edgeMargin);

  // --- 1. rounding of the reference line
  const sigma = Math.min(9, 1.3 * lim);
  const rounds = Math.max(1, Math.round(2 * (sigma / ds) * (sigma / ds)));
  const keep = lim * 0.8;
  for (let it = 0; it < rounds; it++) {
    for (let i = 0; i < n; i++) {
      if (!closed && (i === 0 || i === n - 1)) {
        tx[i] = cx[i];
        tz[i] = cz[i];
        continue;
      }
      const a = wrapIndex(i - 1, n, closed);
      const b = wrapIndex(i + 1, n, closed);
      tx[i] = cx[a] * 0.25 + cx[i] * 0.5 + cx[b] * 0.25;
      tz[i] = cz[a] * 0.25 + cz[i] * 0.5 + cz[b] * 0.25;
    }
    for (let i = 0; i < n; i++) {
      route.project(tx[i], tz[i], rs[i], 45, pr);
      if (pr.dist > keep) {
        const k = keep / pr.dist;
        tx[i] = pr.x + (tx[i] - pr.x) * k;
        tz[i] = pr.z + (tz[i] - pr.z) * k;
      }
      cx[i] = tx[i];
      cz[i] = tz[i];
    }
  }

  const computeNormals = () => {
    for (let i = 0; i < n; i++) {
      const a = wrapIndex(i - 2, n, closed);
      const b = wrapIndex(i + 2, n, closed);
      let dx = cx[b] - cx[a];
      let dz = cz[b] - cz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      nx[i] = -dz;
      nz[i] = dx;
    }
  };
  // offset limit along a normal: bisection on the distance to the route
  const reach = (i: number, dir: number): number => {
    let lo = 0;
    let hi = 2.2 * lim + 1;
    for (let k = 0; k < 9; k++) {
      const mid = (lo + hi) * 0.5;
      route.project(cx[i] + nx[i] * mid * dir, cz[i] + nz[i] * mid * dir, rs[i], 45, pr);
      if (pr.dist <= lim) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const computeLimits = () => {
    for (let i = 0; i < n; i++) {
      route.project(cx[i], cz[i], rs[i], 45, pr);
      rs[i] = pr.s;
      if (pr.dist > lim) {
        // (rare) reference outside the corridor: only allow coming back
        oMax[i] = 0;
        oMin[i] = 0;
        const back = pr.dist - lim * 0.95;
        const toward = ((pr.x - cx[i]) * nx[i] + (pr.z - cz[i]) * nz[i]) / pr.dist;
        if (toward > 0) oMax[i] = back / Math.max(0.3, toward);
        else oMin[i] = -back / Math.max(0.3, -toward);
      } else {
        oMax[i] = reach(i, 1);
        oMin[i] = -reach(i, -1);
      }
    }
  };
  // minimum bending-energy offsets (projected Gauss-Seidel)
  const relax = (h: number, iterations: number) => {
    const first = closed ? 0 : h;
    const last = closed ? n - 1 : n - 1 - h;
    for (let it = 0; it < iterations; it++) {
      for (let j = first; j <= last; j += h) {
        const i0 = wrapIndex(j - 2 * h, n, closed);
        const i1 = wrapIndex(j - h, n, closed);
        const i2 = wrapIndex(j + h, n, closed);
        const i3 = wrapIndex(j + 2 * h, n, closed);
        const px = (4 * (cx[i1] + nx[i1] * off[i1] + cx[i2] + nx[i2] * off[i2]) - (cx[i0] + nx[i0] * off[i0] + cx[i3] + nx[i3] * off[i3])) / 6;
        const pz = (4 * (cz[i1] + nz[i1] * off[i1] + cz[i2] + nz[i2] * off[i2]) - (cz[i0] + nz[i0] * off[i0] + cz[i3] + nz[i3] * off[i3])) / 6;
        let o = (px - cx[j]) * nx[j] + (pz - cz[j]) * nz[j];
        if (o > oMax[j]) o = oMax[j];
        else if (o < oMin[j]) o = oMin[j];
        off[j] = o;
      }
    }
  };
  const solve = (coarse: number, mid: number, fine: number) => {
    off.fill(0);
    relax(4, coarse);
    for (let j = 0; j < n; j++) {
      const r = j % 4;
      if (r === 0) continue;
      const a = j - r;
      const b = wrapIndex(a + 4, n, closed);
      off[j] = off[a] + ((off[b] - off[a]) * r) / 4;
    }
    relax(2, mid);
    for (let j = 1; j < n; j += 2) {
      const b = wrapIndex(j + 1, n, closed);
      off[j] = (off[j - 1] + off[b]) * 0.5;
    }
    relax(1, fine);
    for (let i = 0; i < n; i++) {
      const o = off[i] > oMax[i] ? oMax[i] : off[i] < oMin[i] ? oMin[i] : off[i];
      off[i] = o;
      cx[i] += nx[i] * o;
      cz[i] += nz[i] * o;
    }
  };
  // uniform arc-length re-sampling of the current line (keeps n, endpoints of open lines)
  const resample = () => {
    const segs = closed ? n : n - 1;
    cum[0] = 0;
    for (let i = 0; i < segs; i++) {
      const b = (i + 1) % n;
      cum[i + 1] = cum[i] + Math.hypot(cx[b] - cx[i], cz[b] - cz[i]);
    }
    const total = cum[segs];
    const stepLen = total / segs;
    let k = 0;
    for (let j = 0; j < n; j++) {
      const target = j * stepLen;
      while (k < segs - 1 && cum[k + 1] < target) k++;
      const b = (k + 1) % n;
      const l = cum[k + 1] - cum[k];
      const t = l > 1e-9 ? (target - cum[k]) / l : 0;
      tx[j] = cx[k] + (cx[b] - cx[k]) * (t > 1 ? 1 : t);
      tz[j] = cz[k] + (cz[b] - cz[k]) * (t > 1 ? 1 : t);
      // hint for the route projection of the new sample
      const sa = rs[k];
      let sb = rs[b];
      if (closed && sb < sa - length * 0.5) sb += length;
      nx[j] = sa + (sb - sa) * (t > 1 ? 1 : t); // (temporarily stored in nx)
    }
    for (let j = 0; j < n; j++) {
      cx[j] = tx[j];
      cz[j] = tz[j];
      rs[j] = route.norm(nx[j]);
    }
  };

  if (lim > 0.4) {
    const ROUNDS = 4;
    for (let round = 0; round < ROUNDS; round++) {
      if (round > 0) resample();
      computeNormals();
      computeLimits();
      if (round === 0) solve(240, 50, 40);
      else solve(90, 30, 30);
    }
    resample();
  }
  computeNormals();
  computeLimits();

  // --- final line
  const x = new Float64Array(n);
  const z = new Float64Array(n);
  const seg = new Float32Array(n);
  const side = new Float32Array(n);
  const roomL = new Float32Array(n);
  const roomR = new Float32Array(n);
  const kappa = new Float32Array(n);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = cx[i];
    z[i] = cz[i];
    roomR[i] = Math.max(0, oMax[i]);
    roomL[i] = Math.max(0, -oMin[i]);
    route.project(x[i], z[i], rs[i], 45, pr);
    side[i] = pr.side >= 0 ? pr.dist : -pr.dist;
  }
  for (let i = 0; i < n; i++) {
    const b = wrapIndex(i + 1, n, closed);
    seg[i] = Math.hypot(x[b] - x[i], z[b] - z[i]);
    if (seg[i] < 0.05) seg[i] = 0.05;
  }
  // curvature (Menger curvature over ±2 samples), lightly smoothed
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - 2, n, closed);
    const b = wrapIndex(i + 2, n, closed);
    const ax = x[i] - x[a];
    const az = z[i] - z[a];
    const bx = x[b] - x[i];
    const bz = z[b] - z[i];
    const den = Math.hypot(ax, az) * Math.hypot(bx, bz) * Math.hypot(ax + bx, az + bz);
    raw[i] = den > 1e-6 ? (2 * (ax * bz - az * bx)) / den : 0;
  }
  for (let i = 0; i < n; i++) {
    const a = wrapIndex(i - 1, n, closed);
    const b = wrapIndex(i + 1, n, closed);
    kappa[i] = raw[a] * 0.25 + raw[i] * 0.5 + raw[b] * 0.25;
  }
  // --- corner influence: 1 from ~75 m before a bend to ~40 m after it, smoothed
  const before = Math.round(75 / ds);
  const after = Math.round(40 / ds);
  const mark = new Float32Array(n);
  const passes = closed ? 2 : 1;
  let run = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n; i++) {
      if (Math.abs(kappa[i]) > 0.004) run = after;
      else if (run > 0) run--;
      if (run > 0) mark[i] = 1;
    }
  }
  run = 0;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      if (Math.abs(kappa[i]) > 0.004) run = before;
      else if (run > 0) run--;
      if (run > 0) mark[i] = 1;
    }
  }
  const box = Math.round(24 / ds);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -box; k <= box; k++) sum += mark[wrapIndex(i + k, n, closed)];
    w[i] = sum / (2 * box + 1);
  }
  return { n, ds: seg.length ? meanSeg(seg, closed) : ds, closed, length, x, z, nx, nz, rs, seg, side, roomL, roomR, kappa, w };
}

function meanSeg(seg: Float32Array, closed: boolean): number {
  const m = closed ? seg.length : seg.length - 1;
  let sum = 0;
  for (let i = 0; i < m; i++) sum += seg[i];
  return m > 0 ? sum / m : 1;
}

/** Fractional line index of the sample whose route arc-length is closest to s (binary search on rs). */
function lineIndexAt(line: RaceLine, s: number): number {
  const n = line.n;
  const rs = line.rs;
  // rs is increasing except for one wrap on closed lines: find the rotation start
  let lo = 0;
  let hi = n - 1;
  let startAt = 0;
  if (line.closed && rs[0] > rs[n - 1]) {
    // wrapped somewhere: locate the minimum
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rs[mid] > rs[hi]) lo = mid + 1;
      else hi = mid;
    }
    startAt = lo;
  }
  lo = 0;
  hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rs[(startAt + mid) % n] <= s) lo = mid;
    else hi = mid - 1;
  }
  return (startAt + lo) % n;
}

// -----------------------------------------------------------------------------
// Rival state
// -----------------------------------------------------------------------------

interface Rival extends RivalDriver {
  aggression: number;
  laneOffset: number;
  config: VehicleConfig;
  rng: () => number;
  /** arc-length of the projection on the route, lateral offset (+ right), distance to the route */
  s: number;
  lat: number;
  offDist: number;
  /** position on the racing line (fractional sample index) and distance to it */
  li: number;
  lineDist: number;
  /** per-driver speed profile along the line (m/s) */
  vmax: Float32Array;
  steerMemo: SteerMemo;
  pedal: PedalState;
  released: boolean;
  goTimer: number;
  raceTime: number;
  /** avoidance shift of the lateral target (m) and sticky pass side */
  shift: number;
  passSide: number;
  passHold: number;
  basePower: number;
  power: number;
  grip: number;
  pace: number;
  /** recovery */
  slowT: number;
  episodeT: number;
  episodeProgress: number;
  reverseT: number;
  reverseCooldown: number;
  offRouteT: number;
  /** imperfection */
  mistakeIn: number;
  mistakeT: number;
  mistakeKind: number;
  mistakeAmt: number;
  nitroOn: boolean;
  nitroThink: number;
  nitroWant: boolean;
  blip: number;
  frame: number;
  feelerLimit: number;
  /** distance to the static obstacle straight ahead (999 = clear), time spent nose against it */
  wallDist: number;
  wallT: number;
  reverseElapsed: number;
  parkT: number;
  /** public extras (debugging / telemetry): planned target speed (m/s), number of route resets */
  targetSpeed: number;
  resets: number;
}

const MAX_OBS = 12;

class RaceAI implements IRaceAI {
  readonly rivals: RivalDriver[] = [];
  private host: AIHost;
  private list: Rival[] = [];
  private ctx: RaceAIContext | null = null;
  private line: RaceLine | null = null;
  private racing = false;

  // scratch (no per-frame allocation)
  private proj: PathProjection = { s: 0, dist: 0, side: 0, x: 0, z: 0 };
  private projB: PathProjection = { s: 0, dist: 0, side: 0, x: 0, z: 0 };
  private tmp: Vec2 = { x: 0, z: 0 };
  private bodies: BodyInfo[] = [];
  private obsGap = new Float32Array(MAX_OBS);
  private obsGapC = new Float32Array(MAX_OBS);
  private obsLo = new Float32Array(MAX_OBS);
  private obsHi = new Float32Array(MAX_OBS);
  private obsSide = new Float32Array(MAX_OBS);
  private obsV = new Float32Array(MAX_OBS);
  private obsPlayer = new Uint8Array(MAX_OBS);
  private obsFollow = new Uint8Array(MAX_OBS);
  private tgtX = 0;
  private tgtZ = 0;

  constructor(host: AIHost) {
    this.host = host;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setup(ctx: RaceAIContext, rivals: RivalSetup[]): void {
    this.clear();
    this.ctx = ctx;
    this.racing = false;
    this.line = ctx.mode === 'drag' ? null : buildRaceLine(ctx.route, ctx.halfWidth);
    const route = ctx.route;
    for (let i = 0; i < rivals.length; i++) {
      const su = rivals[i];
      const handle = this.host.spawnVehicle(su.config, su.x, su.z, su.heading, su.tag);
      handle.disabled = false;
      const v = handle.vehicle;
      v.manualGearbox = false;
      v.holdAtLine = true;
      clearInput(handle.input);
      const skill = su.skill < 0 ? 0 : su.skill > 1 ? 1 : su.skill;
      const aggression = su.aggression < 0 ? 0 : su.aggression > 1 ? 1 : su.aggression;
      const rng = mulberry32((hashString(su.name) ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
      // initial projection: near the start of the route first, anywhere otherwise
      let pr = route.project(su.x, su.z, 0, 220, this.proj);
      if (pr.dist > 40) pr = route.project(su.x, su.z, undefined, 80, this.proj);
      let progress = pr.s;
      if (route.closed && progress > route.length * 0.5) progress -= route.length;
      const basePower = RACE_TUNING.powerMin + RACE_TUNING.powerSkill * skill;
      const r: Rival = {
        handle,
        name: su.name,
        skill,
        progress,
        finished: false,
        wrecked: false,
        aggression,
        laneOffset: su.laneOffset,
        config: su.config,
        rng,
        s: pr.s,
        lat: pr.side,
        offDist: pr.dist,
        li: this.line ? lineIndexAt(this.line, pr.s) : 0,
        lineDist: 0,
        vmax: this.line ? this.buildSpeedProfile(this.line, su.config, skill) : new Float32Array(0),
        steerMemo: createSteerMemo(su.config),
        pedal: createPedalState(),
        released: false,
        goTimer: 0,
        raceTime: 0,
        shift: 0,
        passSide: 0,
        passHold: 0,
        basePower,
        power: basePower,
        grip: 1,
        pace: 1,
        slowT: 0,
        episodeT: 0,
        episodeProgress: progress,
        reverseT: 0,
        reverseCooldown: 0,
        offRouteT: 0,
        mistakeIn: (6 + 22 * skill) * (0.5 + rng()),
        mistakeT: 0,
        mistakeKind: 0,
        mistakeAmt: 0,
        nitroOn: false,
        nitroThink: rng() * 1.5,
        nitroWant: false,
        blip: rng() * 6.28,
        frame: i,
        feelerLimit: 999,
        wallDist: 999,
        wallT: 0,
        reverseElapsed: 0,
        parkT: 0,
        targetSpeed: 0,
        resets: 0,
      };
      v.powerScale = basePower;
      v.gripScale = 1;
      this.list.push(r);
      this.rivals.push(r);
    }
  }

  setRacing(go: boolean): void {
    this.racing = go;
    for (let i = 0; i < this.list.length; i++) {
      const r = this.list[i];
      if (go) {
        if (!r.released) {
          const base = RACE_TUNING.reactionSlow + (RACE_TUNING.reactionFast - RACE_TUNING.reactionSlow) * r.skill;
          const t = base + (r.rng() - 0.5) * 0.06;
          r.goTimer = t < 0.05 ? 0.05 : t > 0.45 ? 0.45 : t;
        }
      } else {
        r.released = false;
        r.raceTime = 0;
        if (r.handle.alive) r.handle.vehicle.holdAtLine = true;
      }
    }
  }

  clear(): void {
    for (let i = 0; i < this.list.length; i++) {
      const h = this.list[i].handle;
      if (h.alive) this.host.despawnVehicle(h);
    }
    this.list.length = 0;
    this.rivals.length = 0;
    this.ctx = null;
    this.line = null;
    this.racing = false;
  }

  update(dt: number, playerProgress: number): void {
    const ctx = this.ctx;
    if (!ctx || dt <= 0) return;
    const list = this.list;
    // pack situation for the rubber band: is everybody ahead of the player, and who leads?
    let leader: Rival | null = null;
    let allAhead = list.length > 1;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r.handle.alive || r.finished || r.wrecked) continue;
      if (r.progress < playerProgress + RACE_TUNING.rbAheadStart) allAhead = false;
      if (!leader || r.progress > leader.progress) leader = r;
    }
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r.handle.alive) continue;
      this.updateRival(r, dt, playerProgress, allAhead && r === leader);
    }
  }

  // ---------------------------------------------------------------------------
  // Speed profile
  // ---------------------------------------------------------------------------

  private brakeAccel(config: VehicleConfig, skill: number): number {
    const a = RACE_TUNING.brakeShare * config.brakeDecel * (0.78 + 0.22 * skill);
    const gripCap = (config.gripFront < config.gripRear ? config.gripFront : config.gripRear) * GRAVITY * 0.92;
    return a < gripCap ? a : gripCap;
  }

  private buildSpeedProfile(line: RaceLine, config: VehicleConfig, skill: number): Float32Array {
    const n = line.n;
    const v = new Float32Array(n);
    const coef = RACE_TUNING.latBase + RACE_TUNING.latSkill * skill;
    for (let i = 0; i < n; i++) v[i] = cornerSpeed(config, coef, 1, Math.abs(line.kappa[i]));
    const twoA = 2 * this.brakeAccel(config, skill);
    const passes = line.closed ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const next = line.closed ? (i + 1) % n : i + 1;
        if (next >= n) continue;
        const lim = Math.sqrt(v[next] * v[next] + twoA * line.seg[i]);
        if (v[i] > lim) v[i] = lim;
      }
    }
    return v;
  }

  // ---------------------------------------------------------------------------
  // Line sampling
  // ---------------------------------------------------------------------------

  /**
   * Driver's own lateral offset from the ideal line at sample i (m, + = right):
   * 0 in corners (everybody wants the ideal line), the driver's lane on straights.
   */
  private baseOffset(r: Rival, line: RaceLine, i: number): number {
    let q = (1 - line.w[i]) * (r.laneOffset - line.side[i]);
    // low skill: runs a little wide of the apex
    const k = line.kappa[i];
    if (k > 0.006 || k < -0.006) q -= (k > 0 ? 1 : -1) * Math.min(1, Math.abs(k) * 30) * (1 - r.skill) * 0.9;
    if (q > line.roomR[i]) q = line.roomR[i];
    else if (q < -line.roomL[i]) q = -line.roomL[i];
    return q;
  }

  /** World point of the driver's line at fractional sample index f with an extra lateral shift; fills tgtX / tgtZ. */
  private lineTarget(r: Rival, line: RaceLine, f: number, shift: number): void {
    const n = line.n;
    let extra = 0;
    if (line.closed) {
      f %= n;
      if (f < 0) f += n;
    } else if (f < 0) f = 0;
    else if (f > n - 1) {
      extra = (f - (n - 1)) * line.ds;
      f = n - 1;
    }
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = wrapIndex(i0, n, line.closed);
    const b = wrapIndex(i0 + 1, n, line.closed);
    let qa = this.baseOffset(r, line, a) + shift;
    if (qa > line.roomR[a]) qa = line.roomR[a];
    else if (qa < -line.roomL[a]) qa = -line.roomL[a];
    let qb = this.baseOffset(r, line, b) + shift;
    if (qb > line.roomR[b]) qb = line.roomR[b];
    else if (qb < -line.roomL[b]) qb = -line.roomL[b];
    this.tgtX = (line.x[a] + line.nx[a] * qa) * (1 - t) + (line.x[b] + line.nx[b] * qb) * t;
    this.tgtZ = (line.z[a] + line.nz[a] * qa) * (1 - t) + (line.z[b] + line.nz[b] * qb) * t;
    if (extra > 0) {
      // past the end of an open route: keep going straight (tangent = (nz, -nx))
      this.tgtX += line.nz[n - 1] * extra;
      this.tgtZ += -line.nx[n - 1] * extra;
    }
  }

  private sampleProfile(r: Rival, line: RaceLine, f: number): number {
    const n = line.n;
    if (line.closed) {
      f %= n;
      if (f < 0) f += n;
    } else if (f < 0) f = 0;
    else if (f > n - 1) f = n - 1;
    const i0 = Math.floor(f);
    const t = f - i0;
    const a = wrapIndex(i0, n, line.closed);
    const b = wrapIndex(i0 + 1, n, line.closed);
    return r.vmax[a] * (1 - t) + r.vmax[b] * t;
  }

  /** Local projection of the car on the racing line (continuous through sharp route corners). */
  private trackLine(r: Rival, line: RaceLine, x: number, z: number): void {
    const n = line.n;
    const closed = line.closed;
    for (let attempt = 0; attempt < 2; attempt++) {
      const i0 = Math.floor(r.li);
      let best = Infinity;
      let bestF = r.li;
      let bestLat = 0;
      for (let k = -5; k <= 10; k++) {
        const ia = i0 + k;
        if (!closed && (ia < 0 || ia + 1 > n - 1)) continue;
        const a = wrapIndex(ia, n, closed);
        const b = wrapIndex(ia + 1, n, closed);
        const dx = line.x[b] - line.x[a];
        const dz = line.z[b] - line.z[a];
        const l2 = dx * dx + dz * dz;
        let t = l2 > 1e-9 ? ((x - line.x[a]) * dx + (z - line.z[a]) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x - (line.x[a] + dx * t);
        const ez = z - (line.z[a] + dz * t);
        const d2 = ex * ex + ez * ez;
        if (d2 < best) {
          best = d2;
          bestF = ia + t;
          bestLat = (ex * -dz + ez * dx) / (Math.sqrt(l2) || 1);
        }
      }
      if (best < 30 * 30 || attempt === 1) {
        if (closed) {
          bestF %= n;
          if (bestF < 0) bestF += n;
        }
        r.li = bestF;
        r.lineDist = bestLat;
        return;
      }
      // lost (teleport / long excursion): re-synchronise with the route position
      r.li = lineIndexAt(line, r.s);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-rival update
  // ---------------------------------------------------------------------------

  private updateRival(r: Rival, dt: number, playerProgress: number, leadsAheadPack: boolean): void {
    const ctx = this.ctx!;
    const route = ctx.route;
    const h = r.handle;
    const veh = h.vehicle;
    const st = veh.state;
    const input = h.input;
    r.frame++;

    // --- progress along the route (robust to resets: only projected deltas are accumulated)
    const pr = route.project(st.x, st.z, r.s, 90, this.proj);
    let d = pr.s - r.s;
    if (route.closed) {
      const L = route.length;
      if (d > L * 0.5) d -= L;
      else if (d < -L * 0.5) d += L;
    }
    r.progress += d;
    r.s = pr.s;
    r.lat = pr.side;
    // before the start / past the end of an open route only the lateral distance matters
    r.offDist = !route.closed && (pr.s <= 0.01 || pr.s >= route.length - 0.01) ? Math.abs(pr.side) : pr.dist;

    input.shiftUp = false;
    input.shiftDown = false;

    if (st.engineBlown) r.wrecked = true;

    // --- start line
    if (!r.released) {
      if (this.racing) {
        r.goTimer -= dt;
        if (r.goTimer <= 0) {
          veh.holdAtLine = false;
          r.released = true;
          r.raceTime = 0;
          r.episodeProgress = r.progress;
        }
      }
      if (!r.released) {
        this.holdAtLine(r, dt);
        return;
      }
    }
    r.raceTime += dt;

    const line = this.line;
    if (line) this.trackLine(r, line, st.x, st.z);

    if (r.finished || r.wrecked) {
      this.park(r, dt);
      return;
    }

    this.updateRubberBand(r, dt, playerProgress, leadsAheadPack);

    if (ctx.mode === 'drag' || !line) {
      this.driveDrag(r, dt);
      return;
    }

    // --- recovery
    if (this.updateRecovery(r, dt)) return;

    const v = st.speed > 0 ? st.speed : 0;
    const halfW = r.config.width * 0.5;
    const halfL = r.config.length * 0.5;

    // --- imperfection: occasional small mistakes
    let speedFactor = 1;
    let drift = 0;
    if (r.mistakeT > 0) {
      r.mistakeT -= dt;
      if (r.mistakeKind === 0) drift = r.mistakeAmt;
      else speedFactor = r.mistakeAmt;
    } else {
      r.mistakeIn -= dt;
      if (r.mistakeIn <= 0) {
        r.mistakeIn = (7 + 24 * r.skill) * (0.6 + 0.8 * r.rng());
        const roll = r.rng();
        const lack = 1 - r.skill;
        if (roll < 0.4) {
          r.mistakeKind = 0; // drifts off its line
          r.mistakeAmt = (r.rng() < 0.5 ? -1 : 1) * (0.4 + 1.6 * lack);
          r.mistakeT = 1.4 + r.rng();
        } else if (roll < 0.75) {
          r.mistakeKind = 1; // brakes late
          r.mistakeAmt = 1.025 + 0.06 * lack;
          r.mistakeT = 1.2;
        } else {
          r.mistakeKind = 1; // lifts early
          r.mistakeAmt = 0.94 - 0.05 * lack;
          r.mistakeT = 1.5;
        }
      }
    }

    // --- dynamic obstacles: lateral goal (route-lateral coordinates) + speed cap
    const iHere = wrapIndex(Math.round(r.li + (2 + v * 0.15) / line.ds), line.n, line.closed);
    const baseHere = this.baseOffset(r, line, iHere);
    const desired = line.side[iHere] + baseHere;
    const limR = line.side[iHere] + line.roomR[iHere];
    const limL = line.side[iHere] - line.roomL[iHere];
    // corner zone: the line matters and the speed profile is about to bite => no overtaking of racers there
    const cornerZone = line.w[iHere] > 0.7 && this.sampleProfile(r, line, r.li + (v * 1.8 + 10) / line.ds) < v + 4;
    let vCap = 999;
    let goal = desired;
    let urgent = false;

    const fx = Math.sin(st.heading);
    const fz = Math.cos(st.heading);
    const radius = Math.min(110, 20 + v * 1.8);
    const nb = this.host.queryBodies(st.x, st.z, radius, this.bodies);
    let nObs = 0;
    let nPass = 0;
    let chaserSide = 0;
    let chased = false;
    for (let k = 0; k < nb && nObs < MAX_OBS; k++) {
      const b = this.bodies[k];
      if (b.handle === h) continue;
      const dx = b.x - st.x;
      const dz = b.z - st.z;
      const fwd = dx * fx + dz * fz;
      if (fwd < -22) continue;
      const pb = route.project(b.x, b.z, r.s + fwd, 70, this.projB);
      if (pb.dist > ctx.halfWidth + 5) continue;
      let gapC = pb.s - r.s;
      if (route.closed) {
        const L = route.length;
        if (gapC > L * 0.5) gapC -= L;
        else if (gapC < -L * 0.5) gapC += L;
      }
      const tan = route.tangentAt(pb.s, this.tmp);
      const vb = b.vx * tan.x + b.vz * tan.z;
      // extents of the body along / across the route
      let c = Math.sin(b.heading) * tan.x + Math.cos(b.heading) * tan.z;
      if (c < 0) c = -c;
      if (c > 1) c = 1;
      const sn = Math.sqrt(1 - c * c);
      const extLat = b.halfWidth * c + b.halfLength * sn;
      const extLong = b.halfLength * c + b.halfWidth * sn;
      const gap = gapC - extLong - halfL;
      const isPlayer = b.type === 'player';
      const isRacer = isPlayer || b.type === 'rival';
      if (gapC < -(extLong + halfL + 1.2)) {
        // somebody behind: remember a faster racer on our tail (defending)
        if (isRacer && gapC > -20 && vb > v + 0.5) {
          chased = true;
          chaserSide = pb.side;
        }
        continue;
      }
      const closing = v - vb;
      const horizon = Math.max(7, closing * (2.1 + 0.7 * (1 - r.aggression)) + 6);
      if (gap > horizon) continue;
      const margin = (isPlayer ? 0.75 : b.type === 'traffic' ? 0.55 : 0.45) + v * 0.004;
      this.obsGap[nObs] = gap;
      this.obsGapC[nObs] = gapC;
      this.obsSide[nObs] = pb.side;
      this.obsLo[nObs] = pb.side - extLat - halfW - margin;
      this.obsHi[nObs] = pb.side + extLat + halfW + margin;
      this.obsV[nObs] = vb;
      this.obsPlayer[nObs] = isPlayer ? 1 : 0;
      // racers of similar pace are followed (not passed) through corner zones unless already alongside
      // (also on straights while there is no real speed advantage: slipstream instead of pulling out)
      const follow =
        isRacer &&
        gap > 0.8 &&
        vb > 4 &&
        (cornerZone ? closing < 9 + 5 * r.aggression : r.passSide === 0 && closing < 1.6 - r.aggression);
      this.obsFollow[nObs] = follow ? 1 : 0;
      if (!follow) nPass++;
      nObs++;
    }

    if (nObs > 0) {
      let boxed = false;
      if (nPass > 0) {
        // candidates: the desired offset and both edges of every blocked interval
        let best = NaN;
        let bestCost = Infinity;
        let nearest = -1;
        for (let k = 0; k < nObs; k++) {
          if (this.obsFollow[k]) continue;
          if (nearest < 0 || this.obsGap[k] < this.obsGap[nearest]) nearest = k;
        }
        const nearSide = this.obsSide[nearest];
        for (let ci = 0; ci <= nObs * 2; ci++) {
          let cand: number;
          if (ci === 0) cand = desired;
          else {
            const k = (ci - 1) >> 1;
            if (this.obsFollow[k]) continue;
            cand = (ci - 1) & 1 ? this.obsHi[k] + 0.05 : this.obsLo[k] - 0.05;
          }
          if (cand > limR || cand < limL) continue;
          let free = true;
          for (let k = 0; k < nObs; k++) {
            if (this.obsFollow[k]) continue;
            if (cand > this.obsLo[k] && cand < this.obsHi[k]) {
              free = false;
              break;
            }
          }
          if (!free) continue;
          let cost = Math.abs(cand - r.lat) + 0.4 * Math.abs(cand - desired);
          if (r.passSide !== 0 && (cand > nearSide ? 1 : -1) !== r.passSide) cost += 2.5;
          if (cost < bestCost) {
            bestCost = cost;
            best = cand;
          }
        }
        boxed = best !== best; // NaN: no free slot
        if (!boxed) {
          goal = best;
          if (Math.abs(best - desired) > 0.3) {
            r.passSide = best > nearSide ? 1 : -1;
            r.passHold = 1.2;
          }
        } else {
          goal = r.lat;
        }
      }
      // speed cap from every obstacle in our way
      for (let k = 0; k < nObs; k++) {
        if (this.obsGapC[k] <= 0) continue; // alongside / behind our nose
        const gap = this.obsGap[k];
        const vb = this.obsV[k];
        let tLat: number;
        if (this.obsFollow[k]) {
          // tuck in behind: relevant when it sits on (or near) the path we are about to drive
          const lo = this.obsLo[k] - 1.2;
          const hi = this.obsHi[k] + 1.2;
          if (!((r.lat > lo && r.lat < hi) || (desired > lo && desired < hi))) continue;
          tLat = 0.9;
        } else {
          if (!(r.lat > this.obsLo[k] + 0.25 && r.lat < this.obsHi[k] - 0.25)) continue;
          // time needed to move out of the way
          tLat = 1.6;
          if (!boxed) {
            const need = goal > this.obsSide[k] ? this.obsHi[k] - r.lat : r.lat - this.obsLo[k];
            tLat = 0.3 + need / (2.6 + 1.6 * r.skill);
          }
        }
        const keep = this.obsFollow[k] ? 2 + vb * 0.06 + (this.obsPlayer[k] ? 1 : 0) : this.obsPlayer[k] ? 3.5 : 2;
        const room = gap - keep;
        const lim = (vb > 0 ? vb : 0) + (room > 0 ? room / tLat : room * (this.obsFollow[k] ? 1.2 : 2));
        if (lim < vCap) vCap = lim;
        if (!this.obsFollow[k] && gap < 12 + v * 0.3) urgent = true;
      }
    } else if (r.passHold > 0) {
      r.passHold -= dt;
      if (r.passHold <= 0) r.passSide = 0;
    }

    // --- defending: aggressive drivers cover the inside of the next bend when chased
    if (chased && nObs === 0 && r.aggression > 0.55) {
      let inside = 0;
      const span = Math.round(110 / line.ds);
      for (let k = 4; k < span; k += 4) {
        const kp = line.kappa[wrapIndex(iHere + k, line.n, line.closed)];
        if (kp > 0.012) {
          inside = 1;
          break;
        }
        if (kp < -0.012) {
          inside = -1;
          break;
        }
      }
      if (inside !== 0) {
        const insideLat = inside > 0 ? line.side[iHere] + line.roomR[iHere] * 0.75 : line.side[iHere] - line.roomL[iHere] * 0.75;
        goal = desired + (insideLat - desired) * (r.aggression - 0.3);
      } else {
        goal = desired + clampAbs(chaserSide - r.lat, 1.5) * (r.aggression - 0.4);
      }
    }

    // --- smooth the lateral shift (rate limited, faster when urgent)
    const wantShift = goal - desired + drift;
    const rate = (urgent ? 5.5 : 2.6) + 1.4 * r.skill;
    const maxStep = rate * dt;
    if (wantShift > r.shift + maxStep) r.shift += maxStep;
    else if (wantShift < r.shift - maxStep) r.shift -= maxStep;
    else r.shift = wantShift;
    // never wind the shift up beyond the room available around the line
    const shiftMax = line.roomR[iHere] - baseHere;
    const shiftMin = -line.roomL[iHere] - baseHere;
    if (r.shift > shiftMax + 0.5) r.shift = shiftMax + 0.5;
    else if (r.shift < shiftMin - 0.5) r.shift = shiftMin - 0.5;

    // --- static obstacles: feeler when off the ideal line / off the track
    const offTrack = r.offDist > ctx.halfWidth + 0.5;
    if (Math.abs(r.shift) > 1 || offTrack || st.speed < 3) {
      if ((r.frame & 1) === 0) {
        const sp = Math.hypot(st.vx, st.vz);
        const dirX = sp > 3 ? st.vx / sp : fx;
        const dirZ = sp > 3 ? st.vz / sp : fz;
        const len = Math.min(45, 7 + v * 0.75);
        const hit = castFeeler(this.host.world, st.x, st.z, dirX, dirZ, len, halfW + 0.25, st.y);
        r.wallDist = hit < len ? hit : 999;
        if (hit < len) {
          r.feelerLimit = Math.sqrt(2 * this.brakeAccel(r.config, r.skill) * Math.max(0, hit - halfL - 2)) + 2.5;
          // come back toward the middle of the road
          r.shift -= (r.lat > 0 ? 1 : -1) * 6 * dt;
        } else {
          r.feelerLimit = 999;
        }
      }
      if (r.feelerLimit < vCap) vCap = r.feelerLimit;
    } else {
      r.feelerLimit = 999;
      r.wallDist = 999;
    }

    // --- steering: pure pursuit on the (shifted) line
    const look = RACE_TUNING.lookBase + RACE_TUNING.lookGain * v;
    this.lineTarget(r, line, r.li + look / line.ds, r.shift);
    const slideGain = 0.75 + 0.35 * r.skill;
    const latLimit = cornerGrip(r) * GRAVITY * 0.97;
    input.steer = steerToward(st, r.config, r.steerMemo, this.tgtX, this.tgtZ, slideGain, latLimit, dt);

    // --- target speed
    const iNow = wrapIndex(Math.round(r.li), line.n, line.closed);
    let target = this.sampleProfile(r, line, r.li + (v * 0.1) / line.ds) * Math.sqrt(r.grip) * speedFactor * r.pace;
    // off the ideal line around a bend: the profile assumed the ideal radius
    if (cornerZone) {
      const offLine = Math.abs(r.shift) - 1;
      if (offLine > 0) target *= 1 - 0.22 * (offLine > 3.5 ? 1 : offLine / 3.5);
    }
    const kq = line.kappa[iNow] * r.lineDist;
    if (kq > 0.02) target *= Math.sqrt(kq > 0.5 ? 0.5 : 1 - kq);
    if (offTrack) {
      // off the track: rejoin carefully
      const rejoin = 15 + 8 * r.skill;
      if (target > rejoin) target = rejoin;
    }
    // arc check: can the car actually make the arc toward its look-ahead points at this speed?
    {
      let dx = this.tgtX - st.x;
      let dz = this.tgtZ - st.z;
      let k1 = (2 * (-dx * fz + dz * fx)) / (dx * dx + dz * dz + 1e-6);
      if (k1 < 0) k1 = -k1;
      this.lineTarget(r, line, r.li + (look * 1.8 + 6) / line.ds, r.shift);
      dx = this.tgtX - st.x;
      dz = this.tgtZ - st.z;
      let k2 = (2 * (-dx * fz + dz * fx)) / (dx * dx + dz * dz + 1e-6);
      if (k2 < 0) k2 = -k2;
      const need = k1 * 0.85 > k2 ? k1 * 0.85 : k2;
      const coef = RACE_TUNING.latBase + RACE_TUNING.latSkill * r.skill + 0.05;
      let vArc = cornerSpeed(r.config, coef, r.grip, need);
      if (vArc < 7) vArc = 7;
      if (vArc < target) target = vArc;
    }
    if (vCap < target) target = vCap;
    if (target < 0) target = 0;
    r.targetSpeed = target;

    const latUse = Math.abs(st.speed * st.yawRate) / (latLimit / 0.97);
    updatePedals(r.pedal, st.speed, target, latUse, dt);
    let throttle = r.pedal.throttle;
    let brake = r.pedal.brake;
    // sliding: ease off until the car is caught
    const slip = st.speed > 6 ? Math.abs(Math.atan2(st.lateralSpeed, st.speed)) : 0;
    if (slip > 0.14) {
      const cut = 1 - Math.min(0.85, (slip - 0.14) * 3.2);
      if (throttle > cut) throttle = cut;
      if (slip > 0.3 && brake > 0.4) brake = 0.4;
    }
    input.throttle = throttle;
    input.brake = brake;
    input.handbrake = false;

    // --- nitro on straights
    this.updateNitro(r, dt, line, v, target, vCap, slip, playerProgress);
    input.nitro = r.nitroOn;

    veh.powerScale = r.power;
    veh.gripScale = r.grip;
  }

  // ---------------------------------------------------------------------------

  private holdAtLine(r: Rival, dt: number): void {
    const input = r.handle.input;
    const st = r.handle.vehicle.state;
    const c = r.config;
    r.blip += dt * (3.2 + 1.5 * r.aggression);
    // blip between ~35 % and ~72 % of the redline; drag racers hold a steady launch rpm
    const wave = 0.5 + 0.5 * Math.sin(r.blip);
    const frac = this.ctx!.mode === 'drag' ? 0.62 + 0.1 * r.skill : 0.34 + 0.4 * wave * wave;
    const targetRpm = c.idleRpm + (c.redlineRpm - c.idleRpm) * frac;
    let thr = 0.25 + (targetRpm - st.rpm) / 2500;
    if (st.rpm > c.redlineRpm * 0.93 || st.engineTemp > 0.6) thr = 0;
    input.throttle = thr < 0 ? 0 : thr > 1 ? 1 : thr;
    input.brake = 0;
    input.steer = 0;
    input.handbrake = false;
    input.nitro = false;
    r.pedal.phase = 0;
    r.pedal.throttle = input.throttle;
    r.pedal.brake = 0;
  }

  private updateRubberBand(r: Rival, dt: number, playerProgress: number, leadsAheadPack: boolean): void {
    const T = RACE_TUNING;
    const rb = this.ctx!.rubberBand;
    const gap = r.progress - playerProgress;
    let power = r.basePower;
    let grip = 1;
    let pace = 1;
    if (gap < -T.rbBehindStart) {
      let k = (-gap - T.rbBehindStart) / T.rbRange;
      if (k > 1) k = 1;
      k = k * k * (3 - 2 * k);
      power = r.basePower + (1 + T.rbBoost * rb - r.basePower) * k;
      grip = 1 + T.rbGrip * rb * k;
    } else if (gap > T.rbAheadStart) {
      let k = (gap - T.rbAheadStart) / T.rbRange;
      if (k > 1) k = 1;
      k = k * k * (3 - 2 * k);
      power = r.basePower + (1 - T.rbSlow * rb - r.basePower) * k;
      if (leadsAheadPack) power -= 0.04 * rb * (0.4 + 0.6 * k);
      // far ahead: also drive a little below the limit (earlier lifts, calmer corners)
      pace = 1 - T.rbPace * rb * k;
    }
    // ease over seconds
    const a = 1 - Math.exp(-dt * 0.45);
    r.power += (power - r.power) * a;
    r.grip += (grip - r.grip) * a;
    r.pace += (pace - r.pace) * a;
    if (r.power < 0.75) r.power = 0.75;
    else if (r.power > 1.3) r.power = 1.3;
  }

  private updateNitro(
    r: Rival,
    dt: number,
    line: RaceLine,
    v: number,
    target: number,
    vCap: number,
    slip: number,
    playerProgress: number,
  ): void {
    const st = r.handle.vehicle.state;
    const mode = this.ctx!.mode;
    r.nitroThink -= dt;
    if (r.nitroThink <= 0) {
      r.nitroThink = 1 + r.rng();
      const behind = r.progress - playerProgress < -20;
      const chance = mode === 'speedtrap' ? 0.9 : behind ? 0.75 : r.aggression > 0.5 ? 0.15 + 0.5 * r.aggression : 0.06;
      r.nitroWant = r.rng() < chance;
    }
    let ok =
      r.nitroWant &&
      v > 14 &&
      st.nitro > (r.nitroOn ? 0.03 : mode === 'speedtrap' ? 0.2 : 0.35) &&
      vCap > 900 &&
      v < target - 4 &&
      slip < 0.07 &&
      Math.abs(st.steer) < 0.22 &&
      r.pedal.phase === 0;
    if (ok) {
      // straight ahead for the next ~2.5 s?
      const span = Math.round((v * 2.5 + 20) / line.ds);
      const i0 = Math.round(r.li);
      for (let k = 0; k <= span; k += 3) {
        const i = wrapIndex(i0 + k, line.n, line.closed);
        if (Math.abs(line.kappa[i]) > 0.0045 || r.vmax[i] < v + 5) {
          ok = false;
          break;
        }
      }
    }
    r.nitroOn = ok;
  }

  /** Stuck / off-route handling. Returns true when it took over the controls this frame. */
  private updateRecovery(r: Rival, dt: number): boolean {
    const T = RACE_TUNING;
    const h = r.handle;
    const st = h.vehicle.state;
    const input = h.input;
    const route = this.ctx!.route;

    // off-route timer
    if (r.offDist > T.offRouteDist) r.offRouteT += dt;
    else r.offRouteT = 0;

    // stuck episode bookkeeping
    const slow = Math.abs(st.speed) < T.stuckSpeed;
    if (r.raceTime > 2.5 && slow) r.slowT += dt;
    else if (!slow) r.slowT = 0;
    if (r.episodeT > 0) {
      r.episodeT += dt;
      if (r.progress > r.episodeProgress + 8 && st.speed > 4) r.episodeT = 0; // free again
    } else if (r.slowT > T.stuckDelay) {
      r.episodeT = r.slowT;
      r.episodeProgress = r.progress;
    }

    let needReset = r.offRouteT > T.offRouteTime;
    let force = r.offRouteT > T.offRouteTime + (T.resetForceAfter - T.resetAfter);
    if (r.episodeT > T.resetAfter) needReset = true;
    if (r.episodeT > T.resetForceAfter) force = true;
    if (needReset) {
      let visible = false;
      if (!force) {
        const cam = this.host.getCameraPosition();
        const dx = cam.x - st.x;
        const dz = cam.z - st.z;
        visible = dx * dx + dz * dz < 90 * 90 && this.host.world.lineOfSight(cam.x, cam.z, st.x, st.z);
      }
      if (!visible) {
        this.resetOnRoute(r);
        return true;
      }
    }

    if (r.reverseCooldown > 0) r.reverseCooldown -= dt;
    // nose against a wall: no need to wait, back up right away
    const halfL = r.config.length * 0.5;
    if (r.wallDist < halfL + 2.2 && Math.abs(st.speed) < 4.5 && r.raceTime > 1) r.wallT += dt;
    else r.wallT = 0;
    if (r.reverseT <= 0 && r.reverseCooldown <= 0) {
      if (r.episodeT > 0 && slow && r.slowT > T.stuckDelay) {
        r.reverseT = T.reverseTime;
        r.reverseElapsed = 0;
      } else if (r.wallT > 0.4) {
        r.reverseT = T.reverseTime;
        r.reverseElapsed = 0;
        if (r.episodeT <= 0) {
          r.episodeT = 0.01;
          r.episodeProgress = r.progress;
        }
      }
    }
    if (r.reverseT > 0) {
      r.reverseT -= dt;
      r.reverseElapsed += dt;
      if (r.reverseT <= 0 && r.reverseElapsed < 2.8) {
        // keep backing up while the nose is still boxed in
        const hit = castFeeler(this.host.world, st.x, st.z, Math.sin(st.heading), Math.cos(st.heading), 10, r.config.width * 0.5 + 0.3, st.y);
        if (hit < 7.5) r.reverseT = 0.3;
      }
      // blocked behind as well: stop insisting
      if (r.reverseElapsed > 1 && Math.abs(st.speed) < 0.25) r.reverseT = 0;
      if (r.reverseT <= 0) {
        r.reverseCooldown = 2.2;
        r.slowT = 0;
        r.wallT = 0;
        r.wallDist = 999;
        r.feelerLimit = 999;
        r.pedal.phase = 0;
      }
      // back up, swinging the nose toward the route a little further on
      const p = route.pointAt(r.s + 14, this.tmp);
      const want = Math.atan2(p.x - st.x, p.z - st.z);
      let dh = want - st.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      // need to turn right (dh < 0) => while reversing steer left
      let steer = dh < -0.05 ? -1 : dh > 0.05 ? 1 : 0;
      // still rolling forward: brake first (the physics engages reverse once stopped)
      if (st.speed > 0.8) steer = -steer;
      input.steer = steer;
      input.throttle = 0;
      input.brake = 1;
      input.handbrake = false;
      input.nitro = false;
      r.nitroOn = false;
      r.steerMemo.last = steer;
      return true;
    }
    return false;
  }

  /** Teleports a hopelessly stuck / lost rival back onto its line, rolling at 15 m/s along the route. */
  private resetOnRoute(r: Rival): void {
    const line = this.line!;
    const h = r.handle;
    let i = lineIndexAt(line, r.s);
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < 6; attempt++) {
      const a = wrapIndex(i, line.n, line.closed);
      const q = this.baseOffset(r, line, a);
      x = line.x[a] + line.nx[a] * q;
      z = line.z[a] + line.nz[a] * q;
      const nb = this.host.queryBodies(x, z, 7, this.bodies);
      let busy = false;
      for (let k = 0; k < nb; k++) if (this.bodies[k].handle !== h) busy = true;
      if (!busy) break;
      i += 4;
    }
    const a = wrapIndex(i, line.n, line.closed);
    // line tangent = (nz, -nx)
    const heading = Math.atan2(line.nz[a], -line.nx[a]);
    h.vehicle.reset(x, z, heading, RACE_TUNING.resetSpeed);
    // `progress` stays consistent: the next projection only adds the (small) real displacement
    r.li = a;
    r.slowT = 0;
    r.episodeT = 0;
    r.offRouteT = 0;
    r.reverseT = 0;
    r.reverseCooldown = 0;
    r.shift = 0;
    r.passSide = 0;
    r.feelerLimit = 999;
    r.wallDist = 999;
    r.wallT = 0;
    r.pedal.phase = 0;
    r.pedal.throttle = 0.5;
    r.pedal.brake = 0;
    r.steerMemo.last = 0;
    r.episodeProgress = r.progress;
    r.resets++;
    clearInput(h.input);
    h.input.throttle = 0.5;
  }

  /** After the finish (or with a blown engine): lift, brake gently, pull over and stop on the handbrake. */
  private park(r: Rival, dt: number): void {
    const ctx = this.ctx!;
    const h = r.handle;
    const st = h.vehicle.state;
    const input = h.input;
    input.nitro = false;
    r.nitroOn = false;
    input.throttle = 0;
    const v = Math.abs(st.speed);
    const line = this.line;
    if (ctx.mode === 'drag' || !line) {
      // brake hard in a straight line, keeping the lane
      this.dragSteer(r, dt);
      input.brake = v > 1 ? 1 : 0.5;
      input.handbrake = v < 3;
      return;
    }
    const i = wrapIndex(Math.round(r.li), line.n, line.closed);
    // pull to the nearest side of the road
    const wantShift = (r.lat >= 0 ? line.roomR[i] : -line.roomL[i]) - this.baseOffset(r, line, i);
    const step = 2.2 * dt;
    if (wantShift > r.shift + step) r.shift += step;
    else if (wantShift < r.shift - step) r.shift -= step;
    else r.shift = wantShift;
    this.lineTarget(r, line, r.li + (8 + v * 0.5) / line.ds, r.shift);
    input.steer = steerToward(st, r.config, r.steerMemo, this.tgtX, this.tgtZ, 1, cornerGrip(r) * GRAVITY * 0.8, dt);
    r.parkT += dt;
    if (v > 2.5) {
      // coast for a moment, then slow down gently — harder when something is right ahead
      let brake = r.parkT < 1.2 ? 0 : v > 30 ? 0.4 : 0.26;
      const fx = Math.sin(st.heading);
      const fz = Math.cos(st.heading);
      const nb = this.host.queryBodies(st.x + fx * 10, st.z + fz * 10, 12, this.bodies);
      for (let k = 0; k < nb; k++) {
        const b = this.bodies[k];
        if (b.handle === h) continue;
        const dx = b.x - st.x;
        const dz = b.z - st.z;
        const fwd = dx * fx + dz * fz;
        const lat = -dx * fz + dz * fx;
        if (fwd > 0 && Math.abs(lat) < 2.2) brake = 1;
      }
      input.brake = brake;
      input.handbrake = false;
    } else {
      input.brake = 0.6;
      input.handbrake = true;
      input.steer = 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Drag racing
  // ---------------------------------------------------------------------------

  /** Lane keeping with tiny corrections: far look-ahead point on the lane, clamped command. */
  private dragSteer(r: Rival, dt: number): void {
    const route = this.ctx!.route;
    const st = r.handle.vehicle.state;
    const v = Math.abs(st.speed);
    const look = 22 + v * 0.9;
    const s = r.s + look;
    const p = route.pointAt(s, this.tmp);
    let px = p.x;
    let pz = p.z;
    const hd = route.headingAt(s);
    if (s > route.length && !route.closed) {
      const e = s - route.length;
      px += Math.sin(hd) * e;
      pz += Math.cos(hd) * e;
    }
    // right(h) = (-cos h, sin h)
    px += -Math.cos(hd) * r.laneOffset;
    pz += Math.sin(hd) * r.laneOffset;
    const cmd = steerToward(st, r.config, r.steerMemo, px, pz, 1, 4, dt);
    r.handle.input.steer = clampAbs(cmd, 0.35);
  }

  private driveDrag(r: Rival, dt: number): void {
    const h = r.handle;
    const st = h.vehicle.state;
    const input = h.input;
    this.dragSteer(r, dt);
    input.brake = 0;
    input.handbrake = false;
    // flat out; breathe only if the engine is about to cook or the car gets badly out of shape
    let thr = 1;
    if (st.engineTemp > 0.88) thr = 0.6;
    const slip = st.speed > 8 ? Math.abs(Math.atan2(st.lateralSpeed, st.speed)) : 0;
    if (slip > 0.12) thr = 0.5;
    input.throttle = thr;
    if (!r.nitroOn) {
      if (st.gear >= 3 && st.nitro > 0.25 && slip < 0.05) r.nitroOn = true;
    } else if (st.nitro <= 0.02 || slip > 0.1) {
      r.nitroOn = false;
    }
    input.nitro = r.nitroOn;
    h.vehicle.powerScale = r.power;
    h.vehicle.gripScale = r.grip;
    r.targetSpeed = r.config.estTopSpeed;
  }
}

function cornerGrip(r: Rival): number {
  const c = r.config;
  const st = r.handle.vehicle.state;
  return (c.gripFront < c.gripRear ? c.gripFront : c.gripRear) * r.grip + c.downforce * st.speed * st.speed;
}

export function createRaceAI(host: AIHost): IRaceAI {
  return new RaceAI(host);
}

/** Exposed for tests / debugging tools: the ideal racing line as world points. */
export function debugRaceLine(route: PolylinePath, halfWidth: number): { x: number; z: number; side: number; curvature: number }[] {
  const line = buildRaceLine(route, halfWidth);
  const out: { x: number; z: number; side: number; curvature: number }[] = [];
  for (let i = 0; i < line.n; i++) out.push({ x: line.x[i], z: line.z[i], side: line.side[i], curvature: line.kappa[i] });
  return out;
}
