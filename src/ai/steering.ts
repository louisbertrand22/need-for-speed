/* =============================================================================
 * APEX NOCTURNE — low-level driving helpers shared by the race rivals and the
 * police: pure-pursuit steering with slide catching, pedal controller with
 * hysteresis, static-obstacle feelers. Pure logic, allocation-free at runtime.
 * ===========================================================================*/
import type { CityWorld, DriveInput, StaticCollider, VehicleConfig, VehicleState } from '../core/types';

export const GRAVITY = 9.81;

export function clampAbs(v: number, m: number): number {
  return v < -m ? -m : v > m ? m : v;
}

// -----------------------------------------------------------------------------
// Steering
// -----------------------------------------------------------------------------

const STEER_BUCKETS = 14;
const STEER_BUCKET_SPEED = 7; // m/s per bucket

/**
 * Per-car steering memory: learns the effective maximum front-wheel angle of the
 * physics at each speed (the physics reduces it with speed and smooths the input),
 * so pure-pursuit curvatures can be converted to a -1..1 command accurately.
 */
export interface SteerMemo {
  /** learnt max wheel angle (rad) per speed bucket */
  maxAngle: Float32Array;
  /**
   * learnt understeer coefficient: the wheel angle needed for a curvature k at speed v is
   * atan(wheelbase · k) · (1 + understeer · v²)
   */
  understeer: number;
  /** last command, for rate limiting */
  last: number;
}

export function createSteerMemo(config: VehicleConfig): SteerMemo {
  const maxAngle = new Float32Array(STEER_BUCKETS);
  // prior = the steering law of physics/vehiclePhysics.ts (the table keeps learning the real ratio at run time)
  let k = (config.maxSteer - 0.5) / 0.16;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  const v0 = 9.5 + 2.5 * k;
  for (let i = 0; i < STEER_BUCKETS; i++) {
    const q = (i * STEER_BUCKET_SPEED) / v0;
    maxAngle[i] = config.maxSteer * (0.14 + 0.86 / (1 + q * q));
  }
  return { maxAngle, understeer: 0.00012, last: 0 };
}

function learnSteer(memo: SteerMemo, st: VehicleState, config: VehicleConfig, latLimit: number): void {
  const a = Math.abs(st.steer);
  const v = st.speed;
  // understeer: compare the kinematic yaw rate of the current wheel angle with the real one
  // (only in clean, moderate cornering: no slide, tyres far from saturation)
  const yaw = Math.abs(st.yawRate);
  if (v > 12 && yaw > 0.1 && st.grounded && Math.abs(st.steerAngle) > 0.004 && st.steerAngle * st.yawRate < 0) {
    const latAcc = v * yaw;
    if (latAcc < 0.7 * latLimit && Math.abs(st.lateralSpeed) < 0.06 * v) {
      const kin = (v * Math.tan(Math.abs(st.steerAngle))) / config.wheelbase;
      let ratio = kin / yaw;
      if (ratio < 1) ratio = 1;
      else if (ratio > 4) ratio = 4;
      const c = (ratio - 1) / (v * v);
      memo.understeer += (c - memo.understeer) * 0.02;
    }
  }
  if (a < 0.25) return;
  const ratio = Math.abs(st.steerAngle) / a;
  if (!(ratio > 0.005 && ratio < 1.2)) return;
  const f = Math.abs(st.speed) / STEER_BUCKET_SPEED;
  let i = Math.round(f);
  if (i >= STEER_BUCKETS) i = STEER_BUCKETS - 1;
  memo.maxAngle[i] += (ratio - memo.maxAngle[i]) * 0.2;
  // keep the table monotonic-ish (max angle never grows with speed)
  for (let k = i + 1; k < STEER_BUCKETS; k++) if (memo.maxAngle[k] > memo.maxAngle[i]) memo.maxAngle[k] = memo.maxAngle[i];
}

export function maxWheelAngle(memo: SteerMemo, speed: number): number {
  const f = Math.abs(speed) / STEER_BUCKET_SPEED;
  const i = Math.floor(f);
  if (i >= STEER_BUCKETS - 1) return memo.maxAngle[STEER_BUCKETS - 1];
  const t = f - i;
  return memo.maxAngle[i] * (1 - t) + memo.maxAngle[i + 1] * t;
}

/**
 * Pure-pursuit steering command (-1 left .. +1 right) toward a world point, with
 * yaw-rate feedback and counter-steering when the car slides.
 *
 * @param slideGain  how strongly the driver catches slides (≈1 = expert)
 * @param latLimit   lateral acceleration the tyres can give (m/s²): the requested curvature is
 *                   clamped to latLimit / v² so the driver never asks for more than the grip
 */
export function steerToward(
  st: VehicleState,
  config: VehicleConfig,
  memo: SteerMemo,
  tx: number,
  tz: number,
  slideGain: number,
  latLimit: number,
  dt: number,
): number {
  learnSteer(memo, st, config, latLimit);
  const fx = Math.sin(st.heading);
  const fz = Math.cos(st.heading);
  const dx = tx - st.x;
  const dz = tz - st.z;
  const lf = dx * fx + dz * fz; // forward
  const lr = -dx * fz + dz * fx; // right
  const d2 = dx * dx + dz * dz;
  const v = Math.abs(st.speed);
  let cmd: number;
  if (lf < 0.5 || d2 < 0.25) {
    // target beside / behind: full lock toward it
    cmd = lr >= 0 ? 1 : -1;
  } else {
    let kappa = (2 * lr) / d2; // > 0 = right
    const kMax = latLimit / (v * v > 30 ? v * v : 30);
    if (kappa > kMax) kappa = kMax;
    else if (kappa < -kMax) kappa = -kMax;
    const maxA = maxWheelAngle(memo, v);
    // geometric wheel angle + learnt understeer compensation at speed
    const delta = Math.atan(config.wheelbase * kappa) * (1 + v * v * memo.understeer);
    cmd = delta / (maxA > 0.02 ? maxA : 0.02);
    if (v > 4) {
      // yaw-rate feedback (turning right = negative yaw rate)
      const rDes = -v * kappa;
      const rErr = st.yawRate - rDes;
      cmd += clampAbs((rErr * 0.07) / (maxA > 0.03 ? maxA : 0.03), 0.6);
    }
  }
  if (v > 5) {
    // counter-steer into the slide: lateralSpeed > 0 = sliding to the right => steer right
    const slip = Math.atan2(st.lateralSpeed, v);
    const a = Math.abs(slip);
    if (a > 0.06) {
      const maxA = maxWheelAngle(memo, v);
      cmd += (clampAbs(slip - (slip > 0 ? 0.06 : -0.06), 0.6) * slideGain * 1.15) / (maxA > 0.05 ? maxA : 0.05);
    }
  }
  cmd = clampAbs(cmd, 1);
  // rate limit: the physics smooths the wheel anyway, this only removes chatter
  const maxStep = 9 * dt;
  if (cmd > memo.last + maxStep) cmd = memo.last + maxStep;
  else if (cmd < memo.last - maxStep) cmd = memo.last - maxStep;
  memo.last = cmd;
  return cmd;
}

// -----------------------------------------------------------------------------
// Pedals
// -----------------------------------------------------------------------------

/** 0 = drive, 1 = lift (coast), 2 = brake */
export interface PedalState {
  phase: number;
  throttle: number;
  brake: number;
}

export function createPedalState(): PedalState {
  return { phase: 0, throttle: 0, brake: 0 };
}

/**
 * Longitudinal controller with hysteresis: full/part throttle below the target,
 * lift for small excesses, brake proportionally for larger ones.
 * Writes pedal.throttle / pedal.brake (smoothed).
 *
 * @param latUse  0..1 share of the lateral grip currently used (limits throttle & brake in corners)
 */
export function updatePedals(pedal: PedalState, speed: number, target: number, latUse: number, dt: number): void {
  const over = speed - target;
  // phase transitions with hysteresis
  if (pedal.phase === 0) {
    if (over > 1.6) pedal.phase = 2;
    else if (over > 0.5) pedal.phase = 1;
  } else if (pedal.phase === 1) {
    if (over > 1.6) pedal.phase = 2;
    else if (over < 0.05) pedal.phase = 0;
  } else {
    if (over < 0.35) pedal.phase = over < 0.05 ? 0 : 1;
  }
  let thr = 0;
  let brk = 0;
  if (pedal.phase === 0) {
    thr = 0.2 + -over * 0.45;
    if (thr > 1) thr = 1;
    if (thr < 0) thr = 0;
    // traction circle: do not light up the tyres while they are busy cornering
    const cap = 1 - 0.8 * clamp01((latUse - 0.5) / 0.45);
    if (thr > cap) thr = cap;
  } else if (pedal.phase === 2) {
    brk = 0.3 + over * 0.38;
    if (brk > 1) brk = 1;
    const cap = 1 - 0.45 * clamp01((latUse - 0.45) / 0.5);
    if (brk > cap) brk = cap;
  }
  // smooth the pedals (fast on, fast off) — no chatter
  const k = 1 - Math.exp(-dt * 14);
  pedal.throttle += (thr - pedal.throttle) * k;
  pedal.brake += (brk - pedal.brake) * (brk > pedal.brake ? 1 - Math.exp(-dt * 22) : k);
  if (pedal.throttle < 0.01) pedal.throttle = 0;
  if (pedal.brake < 0.01) pedal.brake = 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function clearInput(input: DriveInput): void {
  input.throttle = 0;
  input.brake = 0;
  input.steer = 0;
  input.handbrake = false;
  input.nitro = false;
  input.shiftUp = false;
  input.shiftDown = false;
}

/** Peak lateral grip of a car (g) including downforce at the given speed. */
export function gripAt(config: VehicleConfig, gripScale: number, speed: number): number {
  const base = config.gripFront < config.gripRear ? config.gripFront : config.gripRear;
  return base * gripScale + config.downforce * speed * speed;
}

/** Corner speed for |curvature| k at a lateral acceleration budget of `coef` × grip × g (downforce included). */
export function cornerSpeed(config: VehicleConfig, coef: number, gripScale: number, k: number): number {
  const base = (config.gripFront < config.gripRear ? config.gripFront : config.gripRear) * gripScale;
  const den = k - coef * config.downforce * GRAVITY;
  if (den <= 1e-5) return 200;
  const v = Math.sqrt((coef * base * GRAVITY) / den);
  return v > 200 ? 200 : v;
}

// -----------------------------------------------------------------------------
// Static obstacle feelers
// -----------------------------------------------------------------------------

const _cols: StaticCollider[] = [];

/** Collider the last successful feeler touched (valid until the next call). */
export const feelerResult: { collider: StaticCollider | null; nx: number; nz: number } = { collider: null, nx: 0, nz: 0 };

/**
 * Sweeps a corridor of half-width `halfW` from (x, z) along the unit direction (dx, dz).
 * Returns the distance to the first blocking collider, or `len` when the way is clear.
 * Soft colliders and colliders outside the car's vertical span are ignored.
 */
export function castFeeler(
  world: CityWorld,
  x: number,
  z: number,
  dx: number,
  dz: number,
  len: number,
  halfW: number,
  baseY: number,
): number {
  const mx = x + dx * len * 0.5;
  const mz = z + dz * len * 0.5;
  const n = world.queryColliders(mx, mz, len * 0.5 + halfW, _cols);
  let best = len;
  feelerResult.collider = null;
  for (let i = 0; i < n; i++) {
    const c = _cols[i];
    if (c.soft) continue;
    if (c.yMax < baseY + 0.25 || c.yMin > baseY + 1.8) continue;
    let t = len;
    if (c.shape === 'circle') {
      const ox = x - c.x;
      const oz = z - c.z;
      const rr = c.r + halfW;
      const b = ox * dx + oz * dz;
      const cc = ox * ox + oz * oz - rr * rr;
      if (cc <= 0) t = 0;
      else {
        const disc = b * b - cc;
        if (disc < 0 || b > 0) continue;
        t = -b - Math.sqrt(disc);
      }
    } else {
      // box local space: local X = (cos r, -sin r), local Z = (sin r, cos r)
      const cr = Math.cos(c.rot);
      const sr = Math.sin(c.rot);
      const ox = (x - c.x) * cr - (z - c.z) * sr;
      const oz = (x - c.x) * sr + (z - c.z) * cr;
      const ddx = dx * cr - dz * sr;
      const ddz = dx * sr + dz * cr;
      const hx = c.hx + halfW;
      const hz = c.hz + halfW;
      let t0 = 0;
      let t1 = len;
      if (Math.abs(ddx) < 1e-7) {
        if (ox < -hx || ox > hx) continue;
      } else {
        let ta = (-hx - ox) / ddx;
        let tb = (hx - ox) / ddx;
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      if (Math.abs(ddz) < 1e-7) {
        if (oz < -hz || oz > hz) continue;
      } else {
        let ta = (-hz - oz) / ddz;
        let tb = (hz - oz) / ddz;
        if (ta > tb) {
          const tmp = ta;
          ta = tb;
          tb = tmp;
        }
        if (ta > t0) t0 = ta;
        if (tb < t1) t1 = tb;
        if (t0 > t1) continue;
      }
      t = t0;
    }
    if (t < best) {
      best = t;
      feelerResult.collider = c;
    }
  }
  return best;
}

/**
 * Pushes a circle (x, z, radius) out of a collider. Writes the separation normal into
 * `pushOut` and returns the penetration depth (<= 0 when not touching).
 */
export const pushOut = { nx: 0, nz: 0 };

export function circlePenetration(c: StaticCollider, x: number, z: number, radius: number): number {
  if (c.shape === 'circle') {
    const dx = x - c.x;
    const dz = z - c.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6) {
      pushOut.nx = 1;
      pushOut.nz = 0;
      return c.r + radius;
    }
    pushOut.nx = dx / d;
    pushOut.nz = dz / d;
    return c.r + radius - d;
  }
  const cr = Math.cos(c.rot);
  const sr = Math.sin(c.rot);
  const lx = (x - c.x) * cr - (z - c.z) * sr;
  const lz = (x - c.x) * sr + (z - c.z) * cr;
  const qx = lx < -c.hx ? -c.hx : lx > c.hx ? c.hx : lx;
  const qz = lz < -c.hz ? -c.hz : lz > c.hz ? c.hz : lz;
  let dx = lx - qx;
  let dz = lz - qz;
  const d = Math.sqrt(dx * dx + dz * dz);
  let pen: number;
  if (d < 1e-6) {
    // centre inside the box: leave through the nearest face
    const ex = c.hx - Math.abs(lx);
    const ez = c.hz - Math.abs(lz);
    if (ex < ez) {
      dx = lx >= 0 ? 1 : -1;
      dz = 0;
      pen = ex + radius;
    } else {
      dx = 0;
      dz = lz >= 0 ? 1 : -1;
      pen = ez + radius;
    }
  } else {
    pen = radius - d;
    dx /= d;
    dz /= d;
  }
  pushOut.nx = dx * cr + dz * sr;
  pushOut.nz = -dx * sr + dz * cr;
  return pen;
}

/** Small deterministic string hash (seeds per-driver RNGs). */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
