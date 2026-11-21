/* =============================================================================
 * APEX NOCTURNE — arcade vehicle dynamics.
 *
 * One VehiclePhysics instance simulates one car (player, rivals, police):
 *   - bicycle model in the car frame (longitudinal / lateral speed, yaw rate) with a
 *     saturating tyre curve, longitudinal weight transfer, traction circle, downforce,
 *   - keyboard friendly steering (slew + speed sensitive lock), low speed kinematic blend,
 *   - first-class drifting: handbrake / power-over / lift-off initiation, then a drift
 *     assist (ideal counter-steer on the front axle + slip-rate damping) keeps the slide
 *     holdable with on/off keys,
 *   - powertrain: torque curve, turbo, slipping clutch, wheelspin, 6 gears (auto / manual
 *     with shift quality), rev limiter, engine temperature, nitro,
 *   - ground following, jumps, static collisions (3 circles vs boxes / circles).
 *
 * Internally the body frame is x = forward, y = right and the yaw rate `w` is positive
 * when turning RIGHT (w = -state.yawRate), which keeps the textbook bicycle equations.
 * update() is allocation free except for the event objects it emits.
 * ===========================================================================*/
import type {
  CarPhysicsSpec,
  DriveInput,
  IVehicle,
  PerfStats,
  PhysicsEnvironment,
  ShiftQuality,
  StaticCollider,
  SurfaceType,
  TuningState,
  VehicleConfig,
  VehicleEvent,
  VehicleState,
} from '../core/types';
import { clamp, wrapAngle } from '../core/math';
import { GRAVITY, buildBaseConfig, computeStats, sampleTorqueCurve } from './vehicleConfig';
import {
  RESTITUTION,
  bodyCircleOffset,
  bodyCircleRadius,
  circleVsBox,
  circleVsCircle,
  contactNormal,
  yawInertia,
} from './collision';

export { resolveVehiclePair, resolveVehicleVsBody } from './collision';

// -----------------------------------------------------------------------------
// Tunables
// -----------------------------------------------------------------------------

const G = GRAVITY;
/** vertical gravity used for jumps (slightly heavier than real: snappier, less floaty flights) */
const JUMP_GRAVITY = 11.0;
const DEG = Math.PI / 180;
const RPM_PER_RADS = 30 / Math.PI;

// tyres
const PEAK_SLIP_FRONT = 8 * DEG;
const PEAK_SLIP_REAR = 9.5 * DEG;
const FRONT_FALLOFF = 0.1;
/** longitudinal (launch) grip relative to the lateral grip figure of the driven axle */
const LONG_GRIP_RWD = 1.15;
const LONG_GRIP_FWD = 1.05;
/** AWD traction = C0·weight + C1·(sum of axle grip): strong launches with diminishing returns on very sticky cars */
const AWD_TRACTION_C0 = 0.66;
const AWD_TRACTION_C1 = 0.49;
const AWD_FRONT_SHARE = 0.4;
/** lateral grip left on the rear axle while the handbrake is held */
const HANDBRAKE_GRIP = 0.35;
/** share of the lateral grip lost under full braking (traction circle) */
const BRAKE_CIRCLE = 0.72;

// steering
const STEER_FLOOR = 0.14;
const STEER_RETURN_RATE = 7.5;

// drift assist
const DRIFT_IN = 9 * DEG;
const DRIFT_FULL = 17 * DEG;
const DRIFT_SOFT_LIMIT = 44 * DEG;
const DRIFT_SPIN_START = 70 * DEG;
const DRIFT_SPIN_END = 92 * DEG;
const DRIFT_YAW_DAMP = 4.0;
const DRIFT_LIMIT_GAIN = 12;
/** < 1: with neutral steering a held drift slowly straightens */
const DRIFT_BALANCE = 0.9;

// powertrain
const LIMITER_CUT = 0.065;
const LIMITER_MEMORY = 0.22;
const ROT_INERTIA = 0.0012;
const REVERSE_MAX_SPEED = 15.3;
const NITRO_DRAG = 0.72;
const HEAT_TIME = 3.7;
const AUTO_HEAT_CAP = 0.9;
const PUNCTURE_SPEED = 25;

// ground
const SUSPENSION_DROOP = 0.1;
const SOFT_MEMORY = 8;

function sstep(a: number, b: number, v: number): number {
  let t = (v - a) / (b - a);
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  t = t * t * (3 - 2 * t);
  return t;
}

function unit(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0; // NaN -> 0
}

/** Normalised tyre force for a normalised slip x = |alpha| / alphaPeak: peaks at 1 then falls off slightly. */
function tyreCurve(x: number, falloff: number): number {
  if (x < 1) return x * (1.5 - 0.5 * x * x);
  const e = x - 1;
  return 1 - (falloff * e) / (e + 1.2);
}

/** Inverse of the rising part of tyreCurve (two Newton steps are plenty). */
function tyreCurveInverse(f: number): number {
  let x = f * 0.68;
  x -= (x * (1.5 - 0.5 * x * x) - f) / (1.5 - 1.5 * x * x);
  x -= (x * (1.5 - 0.5 * x * x) - f) / (1.5 - 1.5 * x * x);
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function surfaceGrip(s: SurfaceType): number {
  switch (s) {
    case 'asphalt':
      return 1;
    case 'concrete':
      return 0.96;
    case 'dirt':
      return 0.68;
    case 'grass':
      return 0.58;
    case 'water':
      return 0.4;
    default:
      return 1;
  }
}

function surfaceRolling(s: SurfaceType): number {
  switch (s) {
    case 'dirt':
      return 0.035;
    case 'grass':
      return 0.06;
    case 'water':
      return 0.22;
    default:
      return 0;
  }
}

function makeState(): VehicleState {
  return {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yawRate: 0,
    speed: 0,
    lateralSpeed: 0,
    speedKmh: 0,
    accelLong: 0,
    accelLat: 0,
    rpm: 800,
    gear: 1,
    shifting: false,
    throttle: 0,
    brake: 0,
    steer: 0,
    steerAngle: 0,
    handbrake: false,
    nitro: 1,
    nitroActive: false,
    turbo: 0,
    engineTemp: 0,
    engineBlown: false,
    slipAngle: 0,
    drifting: false,
    driftAngleDeg: 0,
    driftTime: 0,
    wheelSlip: 0,
    punctured: false,
    grounded: true,
    airTime: 0,
    surface: 'asphalt',
    damage: 0,
  };
}

const TQ_SAMPLES = 128;

// -----------------------------------------------------------------------------
// VehiclePhysics
// -----------------------------------------------------------------------------

export class VehiclePhysics implements IVehicle {
  readonly state: VehicleState = makeState();
  config: VehicleConfig;
  readonly events: VehicleEvent[] = [];

  manualGearbox = false;
  holdAtLine = false;
  powerScale = 1;
  gripScale = 1;
  draft = 0;

  private readonly env: PhysicsEnvironment;

  // --- derived from the configuration
  private wheelbase = 2.6;
  private a = 1.3; // CG -> front axle
  private b = 1.3; // CG -> rear axle
  private iz = 2000;
  private circleR = 0.85;
  private circleOff = 1.3;
  private readonly tqTable = new Float32Array(TQ_SAMPLES + 1);
  private tqStep = 100;
  /** overall ratio (gear x final) per gear, index 0 = reverse */
  private readonly overall = new Float32Array(10);
  private readonly rpmPerMs = new Float32Array(10);
  private biteRpm = 4000;
  private peakTqBase = 300;
  private looseAmount = 0;
  private rearFalloff = 0.2;
  private kxDrive = 0.6;
  private spinGripLoss = 0.5;
  private steerV0 = 11;
  private nitroTopSpeed = 80;
  private highPower = false;

  // --- internal dynamic state
  private time = 0;
  private shiftTimer = 0;
  private shiftDwell = 0;
  private limiterCut = 0;
  private limiterRecent = 0;
  private spinVel = 0;
  private rearLoose = 0;
  private driftF = 0;
  private beta = 0;
  private axS = 0;
  private ayS = 0;
  private boostTimer = 0;
  private bogTimer = 0;
  private bogFactor = 1;
  private tractionTimer = 0;
  private nitroIdle = 0;
  private nitroArmed = true;
  private reverseTimer = 0;
  private thrLatch = false;
  private blowoffCd = 0;
  private backfireCd = 0;
  private driftLowTimer = 0;
  private driftMaxAngle = 0;
  private punctureTimer = 0;
  private impactCd = 0;
  private unsettle = 0;
  private wasHeld = false;
  private handbrakeOn = false;
  private rng = 0x2f6e2b1;
  // ground
  private groundY = 0;
  private slopeF = 0;
  private slopeR = 0;
  private surfGrip = 1;
  private surfRoll = 0;
  private onGround = true;
  private jumpEmitted = false;
  private landCompress = 0;
  // collisions
  private readonly colliders: StaticCollider[] = [];
  private readonly softIds: (number | null)[] = new Array<number | null>(SOFT_MEMORY).fill(null);
  private readonly softTimes = new Float64Array(SOFT_MEMORY);
  private softNext = 0;
  private fx = 0;
  private fz = 1;
  private hitX = 0;
  private hitZ = 0;
  private hitNx = 0;
  private hitNz = 0;
  private hitCollider: StaticCollider | null = null;
  // last finite pose (NaN guard)
  private safeX = 0;
  private safeZ = 0;
  private safeH = 0;

  constructor(config: VehicleConfig, env: PhysicsEnvironment) {
    this.env = env;
    this.config = config;
    this.applyConfig(config);
    this.reset(0, 0, 0, 0);
  }

  // ---------------------------------------------------------------------------
  // Extra public read-only telemetry (debugging, tests, effects)
  // ---------------------------------------------------------------------------

  /** Surface speed excess of the driven wheels (m/s) — wheelspin. */
  get wheelSpin(): number {
    return this.spinVel;
  }

  /** 0..1 strength of the drift assist currently applied. */
  get driftAssist(): number {
    return this.driftF;
  }

  /** 0..1 how loose the rear axle currently is (drift sustain). */
  get rearLooseness(): number {
    return this.rearLoose;
  }

  /** true while the engine is bouncing on the rev limiter. */
  get onLimiter(): boolean {
    return this.limiterRecent > 0;
  }

  /** Yaw moment of inertia (kg·m²) used by applyImpulse and the collision resolvers. */
  get yawInertia(): number {
    return this.iz;
  }

  // ---------------------------------------------------------------------------
  // IVehicle
  // ---------------------------------------------------------------------------

  update(dt: number, input: DriveInput): void {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    const n = dt > 1 / 80 ? Math.ceil(dt * 80) : 1;
    const h = dt / n;
    for (let i = 0; i < n; i++) this.step(h, input, i === 0);
  }

  reset(x: number, z: number, heading: number, speed = 0): void {
    const s = this.state;
    const c = this.config;
    s.x = x;
    s.z = z;
    s.heading = wrapAngle(heading);
    this.fx = Math.sin(s.heading);
    this.fz = Math.cos(s.heading);
    s.vx = this.fx * speed;
    s.vz = this.fz * speed;
    s.vy = 0;
    s.yawRate = 0;
    s.speed = speed;
    s.lateralSpeed = 0;
    s.speedKmh = Math.abs(speed) * 3.6;
    s.accelLong = 0;
    s.accelLat = 0;
    s.shifting = false;
    s.throttle = 0;
    s.brake = 0;
    s.steer = 0;
    s.steerAngle = 0;
    s.handbrake = false;
    s.slipAngle = 0;
    s.drifting = false;
    s.driftAngleDeg = 0;
    s.driftTime = 0;
    s.wheelSlip = 0;
    s.grounded = true;
    s.airTime = 0;
    if (s.nitroActive) {
      s.nitroActive = false;
      this.events.push({ type: 'nitroEnd' });
    }
    // gear matching the speed
    let gear = 1;
    if (speed < -0.5) gear = -1;
    else {
      const n = c.gearRatios.length;
      while (gear < n && speed * this.rpmPerMs[gear] > 0.82 * c.autoUpRpm) gear++;
    }
    s.gear = gear;
    const rpm = Math.abs(speed) * this.rpmPerMs[gear > 0 ? gear : 0];
    s.rpm = s.engineBlown ? 0 : clamp(rpm, c.idleRpm, c.revLimitRpm - 50);
    s.turbo = speed > 5 && c.turboBoost > 0 ? 0.6 : 0;

    this.shiftTimer = 0;
    this.shiftDwell = 0.3;
    this.limiterCut = 0;
    this.limiterRecent = 0;
    this.spinVel = 0;
    this.rearLoose = 0;
    this.driftF = 0;
    this.beta = 0;
    this.axS = 0;
    this.ayS = 0;
    this.boostTimer = 0;
    this.bogTimer = 0;
    this.tractionTimer = 0;
    this.reverseTimer = 0;
    this.thrLatch = false;
    this.driftLowTimer = 0;
    this.driftMaxAngle = 0;
    this.impactCd = 0;
    this.unsettle = 0;
    this.wasHeld = this.holdAtLine;
    this.handbrakeOn = false;
    this.jumpEmitted = false;
    this.landCompress = 0;
    for (let i = 0; i < SOFT_MEMORY; i++) this.softIds[i] = null;

    this.sampleGround();
    s.y = this.groundY;
    this.onGround = true;
    s.pitch = Math.atan(this.slopeF);
    s.roll = Math.atan(-this.slopeR);
    this.safeX = s.x;
    this.safeZ = s.z;
    this.safeH = s.heading;
  }

  setConfig(config: VehicleConfig): void {
    this.config = config;
    this.applyConfig(config);
    const s = this.state;
    const n = config.gearRatios.length;
    if (s.gear > n) s.gear = n;
    s.rpm = s.engineBlown ? s.rpm : clamp(s.rpm, config.idleRpm, config.revLimitRpm);
    if (config.turboBoost <= 0) s.turbo = 0;
  }

  addNitro(fraction: number): void {
    if (!Number.isFinite(fraction)) return;
    const s = this.state;
    s.nitro = clamp(s.nitro + fraction, 0, 1);
    if (s.nitro >= 0.05) this.nitroArmed = true;
  }

  applyImpulse(jx: number, jz: number, px?: number, pz?: number): void {
    if (!Number.isFinite(jx) || !Number.isFinite(jz)) return;
    const s = this.state;
    const im = 1 / this.config.mass;
    s.vx += jx * im;
    s.vz += jz * im;
    if (px !== undefined && pz !== undefined && Number.isFinite(px) && Number.isFinite(pz)) {
      const rx = px - s.x;
      const rz = pz - s.z;
      const dw = (rz * jx - rx * jz) / this.iz;
      s.yawRate = clamp(s.yawRate + dw, -7, 7);
      // a strong off-centre hit (PIT manoeuvre) unsettles the car: no drift assist, loose rear
      const kick = Math.abs(dw);
      if (kick > 0.8) this.unsettle = Math.max(this.unsettle, Math.min(1.6, 0.4 + kick * 0.5));
    }
  }

  puncture(duration: number): void {
    if (!(duration > 0)) return;
    const s = this.state;
    if (!s.punctured) this.events.push({ type: 'puncture' });
    s.punctured = true;
    if (duration > this.punctureTimer) this.punctureTimer = duration;
  }

  repair(): void {
    const s = this.state;
    const wasBlown = s.engineBlown;
    s.damage = 0;
    s.engineTemp = 0;
    s.engineBlown = false;
    s.nitro = 1;
    s.punctured = false;
    this.punctureTimer = 0;
    this.nitroArmed = true;
    this.unsettle = 0;
    if (wasBlown || s.rpm < this.config.idleRpm) s.rpm = this.config.idleRpm;
  }

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  private applyConfig(c: VehicleConfig): void {
    this.wheelbase = c.wheelbase;
    this.a = c.wheelbase * (1 - c.frontWeight);
    this.b = c.wheelbase * c.frontWeight;
    this.iz = yawInertia(c);
    this.circleR = bodyCircleRadius(c);
    this.circleOff = bodyCircleOffset(c);

    // uniform torque table (fast lookup)
    this.tqStep = (c.revLimitRpm * 1.05) / TQ_SAMPLES;
    let peak = 0;
    let peakRpm = c.idleRpm;
    for (let i = 0; i <= TQ_SAMPLES; i++) {
      const rpm = i * this.tqStep;
      const t = sampleTorqueCurve(c.torqueCurve, rpm);
      this.tqTable[i] = t;
      if (t > peak + 0.01 && rpm >= c.idleRpm && rpm <= c.revLimitRpm) {
        peak = t;
        peakRpm = rpm;
      }
    }
    this.peakTqBase = peak;
    this.biteRpm = clamp(peakRpm, 0.42 * c.redlineRpm, 0.6 * c.redlineRpm);

    const n = Math.min(c.gearRatios.length, 9);
    this.overall[0] = c.reverseRatio * c.finalDrive;
    for (let g = 1; g <= n; g++) this.overall[g] = c.gearRatios[g - 1] * c.finalDrive;
    for (let g = 0; g <= n; g++) this.rpmPerMs[g] = (this.overall[g] * RPM_PER_RADS) / c.wheelRadius;

    const db = c.driftBias;
    if (c.drivetrain === 'RWD') {
      this.looseAmount = 0.26 + 0.24 * db;
      this.kxDrive = 0.45 + 0.3 * db;
      this.spinGripLoss = 0.25 + 0.4 * db;
    } else if (c.drivetrain === 'AWD') {
      this.looseAmount = 0.6 * (0.26 + 0.24 * db);
      this.kxDrive = 0.45;
      this.spinGripLoss = 0.2 + 0.2 * db;
    } else {
      this.looseAmount = 0;
      this.kxDrive = 0.55;
      this.spinGripLoss = 0.3;
    }
    this.rearFalloff = 0.1 + 0.14 * db;
    // speed (m/s) at which the steering lock has shrunk to about half
    this.steerV0 = 9.5 + 2.5 * clamp((c.maxSteer - 0.5) / 0.16, 0, 1);
    // nitro pushes up to just under the limiter in top gear (≈ +13 % over the natural top speed)
    const limiterSpeed = c.revLimitRpm / this.rpmPerMs[n];
    this.nitroTopSpeed = Math.min(c.estTopSpeed * 1.16, limiterSpeed * 0.99);
    this.highPower = c.peakPowerHp > 300 || c.peakPowerHp / (c.mass / 1000) > 230;
  }

  private torqueAt(rpm: number): number {
    const f = rpm / this.tqStep;
    if (f <= 0) return this.tqTable[0];
    if (f >= TQ_SAMPLES) return this.tqTable[TQ_SAMPLES];
    const i = f | 0;
    const t0 = this.tqTable[i];
    return t0 + (this.tqTable[i + 1] - t0) * (f - i);
  }

  private rand(): number {
    // xorshift32, deterministic per vehicle
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x >>> 0) / 4294967296;
  }

  // ---------------------------------------------------------------------------
  // Gearbox
  // ---------------------------------------------------------------------------

  private beginShift(newGear: number, quality: ShiftQuality): void {
    const s = this.state;
    const c = this.config;
    const rpm = s.rpm;
    const up = newGear > s.gear;
    s.gear = newGear;
    s.shifting = true;
    this.shiftTimer = c.shiftTime;
    this.events.push({ type: 'shift', gear: newGear, quality, rpm });
    if (c.turboBoost > 0 && s.turbo > 0.55 && this.blowoffCd <= 0) {
      this.events.push({ type: 'blowoff' });
      this.blowoffCd = 0.4;
    }
    if (up && this.highPower && rpm > 0.85 * c.redlineRpm && s.throttle > 0.6 && this.backfireCd <= 0 && this.rand() < 0.6) {
      this.events.push({ type: 'backfire' });
      this.backfireCd = 0.5;
    }
  }

  private manualUp(): void {
    const s = this.state;
    const c = this.config;
    if (s.gear >= c.gearRatios.length) return;
    const rpm = s.rpm;
    let q: ShiftQuality;
    if (this.limiterRecent > 0 || rpm > c.perfectShiftHi * 1.06) q = 'late';
    else if (rpm >= c.perfectShiftLo && rpm <= c.perfectShiftHi) q = 'perfect';
    else if (rpm >= c.perfectShiftLo * 0.94) q = 'good';
    else q = 'early';
    if (q === 'perfect') this.boostTimer = 1.2;
    else if (q === 'early') {
      this.bogTimer = 0.8;
      this.bogFactor = 0.9;
    } else if (q === 'late' && !s.engineBlown) {
      s.engineTemp += 0.12;
    }
    this.beginShift(s.gear + 1, q);
  }

  private manualDown(u: number): void {
    const s = this.state;
    if (s.gear <= 1) return;
    // refuse a downshift that would over-rev the engine
    const post = (u > 0 ? u : 0) * this.rpmPerMs[s.gear - 1];
    if (post > this.config.revLimitRpm) return;
    this.beginShift(s.gear - 1, 'auto');
  }

  private autoShift(u: number, thr: number): void {
    const s = this.state;
    const c = this.config;
    const g = s.gear;
    const n = c.gearRatios.length;
    const along = u > 0 ? u : 0;
    const rpmG = along * this.rpmPerMs[g];
    const up = c.autoUpRpm;
    const upThr = thr >= 0.65 ? up : thr > 0.05 ? up * (0.66 + (0.34 * (thr - 0.05)) / 0.6) : up;

    if (g < n && s.rpm >= upThr && (thr > 0.05 || s.rpm >= up)) {
      // mid-slide / wheelspin: only shift when the next gear would not bog the engine
      const sliding = s.drifting || this.handbrakeOn || this.spinVel > 1.5 || Math.abs(this.beta) > 0.14;
      const post = (rpmG * this.overall[g + 1]) / this.overall[g];
      if (!sliding || post >= 0.55 * c.redlineRpm) {
        this.beginShift(g + 1, 'auto');
        return;
      }
    }
    if (g > 1) {
      let target = g;
      if (thr > 0.85) {
        // kick-down: lowest gear that still leaves usable revs before the next upshift
        if (rpmG < 0.6 * c.redlineRpm) {
          for (let t = g - 1; t >= 1; t--) {
            if ((rpmG * this.overall[t]) / this.overall[g] < 0.82 * up) target = t;
            else break;
          }
        }
      } else if (rpmG < c.autoDownRpm) {
        for (let t = g - 1; t >= 1; t--) {
          if ((rpmG * this.overall[t]) / this.overall[g] < 0.5 * c.redlineRpm) target = t;
          else break;
        }
      }
      if (target < g) this.beginShift(target, 'auto');
    }
  }

  private freeRev(rpm: number, thrEng: number, dt: number): number {
    const c = this.config;
    const target = c.idleRpm + thrEng * (c.revLimitRpm * 1.03 - c.idleRpm);
    if (target > rpm) {
      const rate = 7000 * (1 - (0.55 * rpm) / c.revLimitRpm) * (0.3 + 0.7 * thrEng);
      rpm += rate * dt;
      return rpm > target ? target : rpm;
    }
    rpm -= 3800 * dt;
    return rpm < target ? target : rpm;
  }

  private launch(): void {
    const s = this.state;
    const c = this.config;
    const lo = 0.62 * c.redlineRpm;
    const hi = 0.8 * c.redlineRpm;
    const rpm = s.rpm;
    let q: ShiftQuality;
    if (rpm >= lo && rpm <= hi) q = 'perfect';
    else if (rpm >= lo * 0.92 && rpm <= hi * 1.08) q = 'good';
    else if (rpm < lo) q = 'early';
    else q = 'late';
    if (q === 'perfect') this.boostTimer = 1.2;
    else if (q === 'early') {
      this.bogTimer = 1;
      this.bogFactor = 0.8;
    } else if (q === 'late') this.tractionTimer = 1;
    s.gear = 1;
    s.shifting = false;
    this.shiftTimer = 0;
    this.shiftDwell = 0.2;
    this.events.push({ type: 'launch', quality: q, rpm });
  }

  // ---------------------------------------------------------------------------
  // Shared sub-systems
  // ---------------------------------------------------------------------------

  private updateTurbo(thrEng: number, thr: number, rpm: number, dt: number): void {
    const s = this.state;
    const c = this.config;
    const lift = this.thrLatch && thr < 0.2;
    if (thr > 0.5) this.thrLatch = true;
    else if (thr < 0.2) this.thrLatch = false;
    if (c.turboBoost > 0) {
      if (lift && s.turbo > 0.55 && this.blowoffCd <= 0) {
        this.events.push({ type: 'blowoff' });
        this.blowoffCd = 0.4;
      }
      const target = thrEng * sstep(0.2 * c.redlineRpm, 0.48 * c.redlineRpm, rpm);
      const rate = target > s.turbo ? c.turboSpool : c.turboSpool * 2 + 2;
      s.turbo += (target - s.turbo) * (1 - Math.exp(-rate * dt));
    } else s.turbo = 0;
    if (lift && this.highPower && rpm > 0.85 * c.redlineRpm && this.backfireCd <= 0 && !s.engineBlown && this.rand() < 0.55) {
      this.events.push({ type: 'backfire' });
      this.backfireCd = 0.5;
    }
  }

  private updateEngineTemp(thr: number, dt: number): void {
    const s = this.state;
    if (s.engineBlown) return;
    if (this.limiterRecent > 0 && thr > 0.3) {
      s.engineTemp += ((s.nitroActive ? 1.6 : 1) / HEAT_TIME) * dt;
    } else {
      s.engineTemp -= (s.rpm > 0.9 * this.config.redlineRpm ? 0.03 : 0.07) * dt;
      if (s.engineTemp < 0) s.engineTemp = 0;
    }
    // the automatic gearbox protects the engine: it can run hot but never blows
    if (!this.manualGearbox && s.engineTemp > AUTO_HEAT_CAP) s.engineTemp = AUTO_HEAT_CAP;
    if (s.engineTemp >= 1) {
      s.engineTemp = 1;
      s.engineBlown = true;
      this.events.push({ type: 'engineBlown' });
    }
  }

  private updateNitro(wants: boolean, dt: number): void {
    const s = this.state;
    const c = this.config;
    if (wants && this.nitroArmed && s.nitro > 0) {
      if (!s.nitroActive) {
        s.nitroActive = true;
        this.events.push({ type: 'nitroStart' });
      }
      this.nitroIdle = 0;
      s.nitro -= dt / c.nitroCapacity;
      if (s.nitro <= 0) {
        s.nitro = 0;
        this.nitroArmed = false;
        s.nitroActive = false;
        this.events.push({ type: 'nitroEnd' });
      }
    } else {
      if (s.nitroActive) {
        s.nitroActive = false;
        this.events.push({ type: 'nitroEnd' });
      }
      this.nitroIdle += dt;
      if (this.nitroIdle > 1) s.nitro += c.nitroRegen * dt;
      if (s.drifting) s.nitro += (0.03 + 0.05 * Math.min(1, s.driftAngleDeg / 45)) * dt;
      if (s.nitro > 1) s.nitro = 1;
      if (!this.nitroArmed && s.nitro >= 0.05) this.nitroArmed = true;
    }
  }

  private updateSteer(steerIn: number, uAbs: number, dt: number): number {
    const s = this.state;
    const c = this.config;
    const cur = s.steer;
    let rate: number;
    if (steerIn === 0 || steerIn * cur < 0) rate = STEER_RETURN_RATE + c.steerResponse * 0.4;
    else rate = c.steerResponse * (1 - 0.4 * sstep(25, 75, uAbs));
    const step = rate * dt;
    s.steer = cur < steerIn ? Math.min(cur + step, steerIn) : Math.max(cur - step, steerIn);
    const q = uAbs / this.steerV0;
    return s.steer * c.maxSteer * (STEER_FLOOR + (1 - STEER_FLOOR) / (1 + q * q));
  }

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------

  private sampleGround(): void {
    const s = this.state;
    const env = this.env;
    const c = this.config;
    const hl = c.wheelbase * 0.5;
    const ht = c.track * 0.5;
    const fx = this.fx;
    const fz = this.fz;
    // right(h) = (-cos h, sin h) = (-fz, fx)
    const hC = env.getGroundHeight(s.x, s.z);
    let hF = env.getGroundHeight(s.x + fx * hl, s.z + fz * hl);
    let hB = env.getGroundHeight(s.x - fx * hl, s.z - fz * hl);
    let hR = env.getGroundHeight(s.x - fz * ht, s.z + fx * ht);
    let hL = env.getGroundHeight(s.x + fz * ht, s.z - fx * ht);
    // ignore cliffs (ramp ends, kerb walls): a sample further than a ~35° slope is not "under" the car
    const mF = 0.7 * hl;
    const mT = 0.7 * ht;
    hF = clamp(hF, hC - mF, hC + mF);
    hB = clamp(hB, hC - mF, hC + mF);
    hR = clamp(hR, hC - mT, hC + mT);
    hL = clamp(hL, hC - mT, hC + mT);
    this.groundY = Number.isFinite(hC) ? hC : this.groundY;
    const sf = (hF - hB) / (2 * hl);
    const sr = (hR - hL) / (2 * ht);
    this.slopeF = Number.isFinite(sf) ? sf : 0;
    this.slopeR = Number.isFinite(sr) ? sr : 0;
    const surf = env.getSurface(s.x, s.z);
    s.surface = surf;
    this.surfGrip = surfaceGrip(surf);
    this.surfRoll = surfaceRolling(surf);
  }

  /** Vertical motion: follow the ground, take off on crests / ramp ends, land. */
  private updateVertical(dt: number, speed: number, u: number, v: number): void {
    const s = this.state;
    const gY = this.groundY;
    const prevY = s.y;
    const vyBall = s.vy - JUMP_GRAVITY * dt;
    const yBall = prevY + vyBall * dt;
    if (yBall <= gY) {
      // --- supported by the ground
      const slopeVy = this.slopeF * u + this.slopeR * v;
      if (!s.grounded) {
        // touchdown
        const impact = Math.max(0, slopeVy - vyBall);
        const air = s.airTime;
        if (this.jumpEmitted || impact > 2.5) {
          this.events.push({ type: 'landing', intensity: impact, airTime: air });
          if (impact > 7) s.damage = Math.min(1, s.damage + Math.min(0.15, (impact - 7) * 0.012));
          this.landCompress = Math.min(0.09, impact * 0.008);
          const keep = 1 - Math.min(0.1, impact * 0.005);
          s.vx *= keep;
          s.vz *= keep;
        }
        s.grounded = true;
        s.airTime = 0;
        this.jumpEmitted = false;
        s.vy = slopeVy;
      } else if (this.onGround) {
        const dh = gY - prevY;
        const ds = speed * dt;
        let target: number;
        if (dh > 0.04 + 0.9 * ds) {
          // vertical step (kerb, platform edge): climb it without being catapulted
          target = s.vy > 0 ? s.vy : 0;
          if (target > slopeVy && slopeVy >= 0) target = slopeVy;
        } else {
          target = dh / dt;
          const cap = 0.9 * speed + 0.5;
          if (target > cap) target = cap;
        }
        s.vy += (target - s.vy) * (1 - Math.exp(-45 * dt));
      } else {
        // was floating inside the suspension droop
        s.vy = slopeVy;
      }
      s.y = gY;
      this.onGround = true;
    } else {
      // --- above the ground
      s.y = yBall;
      s.vy = vyBall;
      this.onGround = false;
      if (s.grounded && yBall - gY > SUSPENSION_DROOP) {
        s.grounded = false;
        s.airTime = 0;
        this.jumpEmitted = false;
      }
      if (!s.grounded) {
        s.airTime += dt;
        if (!this.jumpEmitted && s.airTime > 0.08) {
          this.jumpEmitted = true;
          this.events.push({ type: 'jump' });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Static collisions
  // ---------------------------------------------------------------------------

  private softSeen(id: number): boolean {
    const now = this.time;
    for (let i = 0; i < SOFT_MEMORY; i++) {
      if (this.softIds[i] === id && now - this.softTimes[i] < 1) {
        this.softTimes[i] = now; // still touching: keep it alive
        return true;
      }
    }
    this.softIds[this.softNext] = id;
    this.softTimes[this.softNext] = now;
    this.softNext = (this.softNext + 1) % SOFT_MEMORY;
    return false;
  }

  /** Resolves the 3 body circles against the `count` colliders gathered for this step. Returns the absorbed normal speed. */
  private collide(count: number): number {
    const s = this.state;
    const c = this.config;
    const r = this.circleR;
    const off = this.circleOff;
    const fx = this.fx;
    const fz = this.fz;
    const reach = off + r;
    const top = s.y + c.height;
    const im = 1 / c.mass;
    // collisions spin the car less than a free rigid body would (never a violent spin)
    const izc = this.iz * 2.2;
    let worst = 0;
    for (let i = 0; i < count; i++) {
      const col = this.colliders[i];
      const dx = s.x - col.x;
      const dz = s.z - col.z;
      const far = reach + col.r;
      if (dx * dx + dz * dz > far * far) continue;
      if (s.y >= col.yMax - 0.25 || top <= col.yMin) continue;
      const box = col.shape === 'box';
      let sinR = 0;
      let cosR = 1;
      if (box) {
        sinR = Math.sin(col.rot);
        cosR = Math.cos(col.rot);
      }
      for (let k = -1; k <= 1; k++) {
        const cx = s.x + fx * off * k;
        const cz = s.z + fz * off * k;
        const depth = box
          ? circleVsBox(cx, cz, r, col.x, col.z, col.hx, col.hz, sinR, cosR)
          : circleVsCircle(cx, cz, r, col.x, col.z, col.r);
        if (depth <= 0) continue;
        if (col.soft) {
          if (!this.softSeen(col.id)) {
            s.vx *= 0.97;
            s.vz *= 0.97;
            this.events.push({ type: 'softHit', collider: col, speedKmh: Math.sqrt(s.vx * s.vx + s.vz * s.vz) * 3.6 });
          }
          break;
        }
        const nx = contactNormal.x;
        const nz = contactNormal.z;
        s.x += nx * depth;
        s.z += nz * depth;
        // contact point on the circle and its velocity (omega about +Y: v = (w·rz, -w·rx))
        const rx = fx * off * k - nx * r;
        const rz = fz * off * k - nz * r;
        const vn = (s.vx + s.yawRate * rz) * nx + (s.vz - s.yawRate * rx) * nz;
        if (vn >= 0) continue;
        const arm = rz * nx - rx * nz;
        const jn = (-(1 + RESTITUTION) * vn) / (im + (arm * arm) / izc);
        let dvx = jn * nx * im;
        let dvz = jn * nz * im;
        // wall friction: gentle scrub along the surface
        const tx = -nz;
        const tz = nx;
        const vt = s.vx * tx + s.vz * tz;
        const maxDvt = 0.22 * jn * im;
        const dvt = vt > maxDvt ? -maxDvt : vt < -maxDvt ? maxDvt : -vt;
        dvx += dvt * tx;
        dvz += dvt * tz;
        s.vx += dvx;
        s.vz += dvz;
        const dw = clamp((arm * jn) / izc, -2.2, 2.2);
        s.yawRate = clamp(s.yawRate + dw, -5, 5);
        if (-vn > worst) {
          worst = -vn;
          this.hitX = cx - nx * r;
          this.hitZ = cz - nz * r;
          this.hitNx = nx;
          this.hitNz = nz;
          this.hitCollider = col;
        }
      }
    }
    return worst;
  }

  private moveAndCollide(dt: number): void {
    const s = this.state;
    const mx = s.vx * dt;
    const mz = s.vz * dt;
    const dist = Math.sqrt(mx * mx + mz * mz);
    const count = this.env.queryColliders(s.x + mx * 0.5, s.z + mz * 0.5, this.circleOff + this.circleR + 0.4 + dist * 0.5, this.colliders);
    if (!(count > 0)) {
      s.x += mx;
      s.z += mz;
      return;
    }
    // sub-step fast moves so thin barriers cannot be tunnelled
    let n = Math.ceil(dist / (0.5 * this.circleR));
    if (n < 1) n = 1;
    else if (n > 6) n = 6;
    const h = dt / n;
    let worst = 0;
    for (let i = 0; i < n; i++) {
      s.x += s.vx * h;
      s.z += s.vz * h;
      const hit = this.collide(count);
      if (hit > worst) worst = hit;
    }
    if (worst > 1.2 && this.impactCd <= 0) {
      this.impactCd = 0.08;
      this.events.push({
        type: 'impact',
        x: this.hitX,
        y: s.y + 0.45,
        z: this.hitZ,
        nx: this.hitNx,
        nz: this.hitNz,
        intensity: worst,
        collider: this.hitCollider,
      });
      if (worst > 3) s.damage = Math.min(1, s.damage + 0.0045 * (worst - 3));
    }
    this.hitCollider = null;
  }

  // ---------------------------------------------------------------------------
  // Start-line hold
  // ---------------------------------------------------------------------------

  private stepHeld(dt: number, thrIn: number, brkIn: number, steerIn: number, handbrake: boolean): void {
    const s = this.state;
    const c = this.config;
    this.wasHeld = true;
    s.vx = 0;
    s.vz = 0;
    s.vy = 0;
    s.yawRate = 0;
    s.gear = 1;
    s.shifting = false;
    this.shiftTimer = 0;
    this.spinVel = 0;
    this.rearLoose = 0;
    this.driftF = 0;
    this.beta = 0;
    this.reverseTimer = 0;

    let thrEng = this.limiterCut > 0 || s.engineBlown ? 0 : thrIn;
    let rpm = s.rpm;
    if (s.engineBlown) rpm = Math.max(0, rpm - 3000 * dt);
    else {
      rpm = this.freeRev(rpm, thrEng, dt);
      if (rpm >= c.revLimitRpm) {
        rpm = c.revLimitRpm;
        this.limiterCut = LIMITER_CUT;
        this.limiterRecent = LIMITER_MEMORY;
        thrEng = 0;
      }
    }
    s.rpm = rpm;
    this.updateTurbo(thrEng, thrIn, rpm, dt);
    this.updateEngineTemp(thrIn, dt);
    this.updateNitro(false, dt);

    const delta = this.updateSteer(steerIn, 0, dt);
    s.steerAngle = delta;
    s.throttle = thrIn;
    s.brake = brkIn;
    s.handbrake = handbrake;
    this.handbrakeOn = handbrake;

    this.sampleGround();
    s.y = this.groundY;
    this.onGround = true;
    s.grounded = true;
    s.airTime = 0;
    const k = 1 - Math.exp(-10 * dt);
    this.axS += (0 - this.axS) * k;
    this.ayS += (0 - this.ayS) * k;
    s.accelLong = this.axS;
    s.accelLat = this.ayS;
    s.pitch += (Math.atan(this.slopeF) - s.pitch) * k;
    s.roll += (Math.atan(-this.slopeR) - s.roll) * k;
    s.speed = 0;
    s.lateralSpeed = 0;
    s.speedKmh = 0;
    s.slipAngle = 0;
    s.wheelSlip += (0 - s.wheelSlip) * k;
    if (s.drifting) {
      s.drifting = false;
      this.events.push({ type: 'driftEnd', duration: s.driftTime, maxAngleDeg: this.driftMaxAngle });
    }
    s.driftAngleDeg = 0;
  }

  // ---------------------------------------------------------------------------
  // One fixed step
  // ---------------------------------------------------------------------------

  private step(dt: number, input: DriveInput, edges: boolean): void {
    const s = this.state;
    const c = this.config;
    this.time += dt;

    if (this.limiterCut > 0) this.limiterCut -= dt;
    if (this.limiterRecent > 0) this.limiterRecent -= dt;
    if (this.shiftDwell > 0) this.shiftDwell -= dt;
    if (this.boostTimer > 0) this.boostTimer -= dt;
    if (this.bogTimer > 0) this.bogTimer -= dt;
    if (this.tractionTimer > 0) this.tractionTimer -= dt;
    if (this.blowoffCd > 0) this.blowoffCd -= dt;
    if (this.backfireCd > 0) this.backfireCd -= dt;
    if (this.impactCd > 0) this.impactCd -= dt;
    if (this.unsettle > 0) this.unsettle -= dt;
    if (this.punctureTimer > 0) {
      this.punctureTimer -= dt;
      if (this.punctureTimer <= 0) s.punctured = false;
    }

    const thrIn = unit(input.throttle);
    const brkIn = unit(input.brake);
    const steerIn = Number.isFinite(input.steer) ? clamp(input.steer, -1, 1) : 0;
    const hb = !!input.handbrake;

    if (this.holdAtLine) {
      this.stepHeld(dt, thrIn, brkIn, steerIn, hb);
      return;
    }
    if (this.wasHeld) {
      this.wasHeld = false;
      this.launch();
    }

    // --- body frame (x forward, y right, w > 0 = turning right)
    const sinH = this.fx;
    const cosH = this.fz;
    const u = s.vx * sinH + s.vz * cosH;
    const v = -s.vx * cosH + s.vz * sinH;
    const w = -s.yawRate;
    const speed = Math.sqrt(s.vx * s.vx + s.vz * s.vz);
    const uAbs = u < 0 ? -u : u;
    const grounded = s.grounded;

    // --- reverse selection: brake held at standstill engages reverse, throttle goes back to 1st
    if (s.gear >= 1) {
      if (brkIn > 0.1 && thrIn < 0.05 && speed < 1.2 && grounded) {
        this.reverseTimer += dt;
        if (this.reverseTimer > 0.12) {
          this.reverseTimer = 0;
          s.shifting = false;
          this.shiftTimer = 0;
          s.gear = -1;
          this.events.push({ type: 'shift', gear: -1, quality: 'auto', rpm: s.rpm });
        }
      } else this.reverseTimer = 0;
    } else if (s.gear < 0) {
      if (thrIn > 0.05 && u > -1) {
        s.gear = 1;
        this.events.push({ type: 'shift', gear: 1, quality: 'auto', rpm: s.rpm });
      }
    } else if (thrIn > 0.05) s.gear = 1;

    const reverse = s.gear < 0;
    const thr = reverse ? brkIn : thrIn;
    const brk = reverse ? thrIn : brkIn;

    // --- gearbox
    if (s.shifting) {
      this.shiftTimer -= dt;
      if (this.shiftTimer <= 0) {
        s.shifting = false;
        this.shiftDwell = 0.3;
      }
    }
    if (s.gear >= 1 && !s.shifting) {
      if (this.manualGearbox) {
        if (edges) {
          if (input.shiftUp) this.manualUp();
          else if (input.shiftDown) this.manualDown(u);
        }
      } else if (this.shiftDwell <= 0 && grounded) this.autoShift(u, thr);
    }

    // --- engine speed
    const gear = s.gear;
    const overall = gear > 0 ? this.overall[gear] : gear < 0 ? this.overall[0] : 0;
    const rpmPerMs = (overall * RPM_PER_RADS) / c.wheelRadius;
    const along = reverse ? -u : u;
    const alongPos = along > 0 ? along : 0;
    const rearDriven = c.drivetrain !== 'FWD';
    const clutchOpen = s.shifting || gear === 0 || (hb && rearDriven);
    const blown = s.engineBlown;
    let thrEng = this.limiterCut > 0 || s.shifting || blown ? 0 : thr;
    let rpm = s.rpm;
    if (blown) rpm = Math.max(0, rpm - 3000 * dt);
    else {
      if (!grounded) {
        // wheels unloaded: the engine spins them up freely
        const target = thrEng > 0.05 ? c.revLimitRpm * 1.02 : Math.max(c.idleRpm, alongPos * rpmPerMs);
        rpm += (target - rpm) * (1 - Math.exp(-5 * dt));
      } else if (clutchOpen) {
        if (s.shifting) rpm += (Math.max(c.idleRpm, alongPos * rpmPerMs) - rpm) * (1 - Math.exp(-12 * dt));
        else rpm = this.freeRev(rpm, thrEng, dt);
      } else {
        const locked = (alongPos + this.spinVel) * rpmPerMs;
        const slip = c.idleRpm + thr * (this.biteRpm - c.idleRpm);
        rpm += ((locked > slip ? locked : slip) - rpm) * (1 - Math.exp(-16 * dt));
      }
      if (rpm < c.idleRpm) rpm = c.idleRpm;
      if (rpm >= c.revLimitRpm) {
        rpm = c.revLimitRpm;
        this.limiterCut = LIMITER_CUT;
        this.limiterRecent = LIMITER_MEMORY;
        thrEng = 0;
      }
    }
    s.rpm = rpm;
    this.updateTurbo(thrEng, thr, rpm, dt);

    // --- nitro
    const nitroWanted = !!input.nitro && thr > 0.1 && gear >= 1 && !blown;
    this.updateNitro(nitroWanted, dt);

    // --- steering
    const deltaIn = this.updateSteer(steerIn, uAbs, dt);
    let delta = deltaIn;

    // --- forces
    const mass = c.mass;
    const dragK = (c.dragCoef * (1 - 0.35 * unit(this.draft)) * (s.nitroActive ? NITRO_DRAG : 1) * speed) / mass;
    let uN: number;
    let vN: number;
    let wN: number;
    let absAR = 0;
    let absAF = 0;
    let lockSlip = 0;
    let kinBlend = 0;
    const beta = speed > 3 ? Math.atan2(v, uAbs) : 0;
    const absBeta = beta < 0 ? -beta : beta;
    this.beta = beta;

    if (grounded) {
      // drive force requested at the wheels
      let fDrive = 0;
      let fEngBrake = 0;
      if (!clutchOpen && !blown) {
        const tq = this.torqueAt(rpm) * (1 + c.turboBoost * s.turbo);
        let mult = Math.max(0, this.powerScale) * (1 - 0.12 * s.damage);
        if (this.boostTimer > 0) mult *= 1.08;
        if (this.bogTimer > 0) mult *= this.bogFactor;
        fDrive = (tq * thrEng * mult * overall * c.efficiency) / (c.wheelRadius * (1 + ROT_INERTIA * overall * overall));
        if (reverse) fDrive *= clamp((REVERSE_MAX_SPEED - alongPos) / 3, 0, 1);
        if (s.punctured) fDrive *= clamp((PUNCTURE_SPEED + 2 - alongPos) / 5, 0, 1);
        if (thr < 0.05 && alongPos * rpmPerMs > c.idleRpm * 1.15) {
          fEngBrake = ((0.03 + (0.1 * rpm) / c.redlineRpm) * this.peakTqBase * overall * c.efficiency) / c.wheelRadius;
        }
      }

      // axle loads (longitudinal weight transfer) and friction coefficients
      const W = mass * G;
      const transfer = clamp((mass * this.axS * c.cgHeight) / this.wheelbase, -0.3 * W, 0.3 * W);
      let fzF = W * c.frontWeight - transfer;
      if (fzF < 0.08 * W) fzF = 0.08 * W;
      else if (fzF > 0.92 * W) fzF = 0.92 * W;
      const fzR = W - fzF;
      const aero = c.downforce * speed * speed;
      const gmul = this.surfGrip * clamp(this.gripScale, 0.05, 3) * (s.punctured ? 0.55 : 1);
      const muF = (c.gripFront + aero) * gmul;
      const muR = (c.gripRear + aero) * gmul;

      // traction limit, wheelspin
      let fxF = 0;
      let fxR = 0;
      let usedF = 0;
      let usedR = 0;
      const spinRef = 2.2 + 0.1 * alongPos;
      if (fDrive > 0) {
        let fMax: number;
        if (c.drivetrain === 'RWD') fMax = muR * fzR * LONG_GRIP_RWD;
        else if (c.drivetrain === 'FWD') fMax = muF * fzF * LONG_GRIP_FWD;
        else fMax = AWD_TRACTION_C0 * W * gmul + AWD_TRACTION_C1 * (muF * fzF + muR * fzR);
        if (this.tractionTimer > 0) fMax *= 0.75;
        if (fMax < 1) fMax = 1;
        const mEff = 40 + 2 * overall * overall;
        let fApp = fDrive;
        if (fDrive > fMax) {
          this.spinVel += ((fDrive - fMax) / mEff) * dt;
          const cap = spinRef + this.driftF * (3 + 0.2 * alongPos) + (this.tractionTimer > 0 ? 3 : 0);
          if (this.spinVel > cap) this.spinVel = cap;
          fApp = fMax * (1 - 0.03 * Math.min(1, this.spinVel / 4));
        } else {
          this.spinVel -= (((fMax - fDrive) / mEff) * 2 + 5 * this.spinVel) * dt;
          if (this.spinVel < 0) this.spinVel = 0;
        }
        const used = fApp / fMax;
        const dir = reverse ? -1 : 1;
        if (c.drivetrain === 'RWD') {
          fxR = dir * fApp;
          usedR = used;
        } else if (c.drivetrain === 'FWD') {
          fxF = dir * fApp;
          usedF = used;
        } else {
          fxF = dir * fApp * AWD_FRONT_SHARE;
          fxR = dir * fApp * (1 - AWD_FRONT_SHARE);
          usedF = used;
          usedR = used;
        }
      } else {
        this.spinVel -= (8 * this.spinVel + 2) * dt;
        if (this.spinVel < 0) this.spinVel = 0;
      }
      const spinLoss = Math.min(1, this.spinVel / spinRef);

      // rear slip angle
      const uRef = uAbs > 1 ? uAbs : 1;
      const vr = v - this.b * w;
      const alphaR = Math.atan2(vr, uRef);
      absAR = alphaR < 0 ? -alphaR : alphaR;

      // rear looseness: what keeps a drift alive while the throttle is down
      if (this.looseAmount > 0 && u > 5) {
        let rise = 0;
        if (hb) rise = 9;
        else if (absAR > 0.23) rise = 5 * (0.4 + c.driftBias);
        else if (this.spinVel > 1.2 && absAR > 0.1) rise = 4 * c.driftBias;
        if (rise > 0) this.rearLoose += (1 - this.rearLoose) * (1 - Math.exp(-rise * dt));
        else if (!(thr > 0.25 && absBeta > 0.12)) this.rearLoose -= this.rearLoose * (1 - Math.exp(-3.5 * dt));
      } else this.rearLoose -= this.rearLoose * (1 - Math.exp(-8 * dt));

      // drift assist strength
      let dTarget = 0;
      if (u > 4 && this.unsettle <= 0) {
        dTarget = sstep(DRIFT_IN, DRIFT_FULL, absBeta) * sstep(4, 9, u) * (1 - sstep(DRIFT_SPIN_START, DRIFT_SPIN_END, absBeta));
      }
      this.driftF += (dTarget - this.driftF) * (1 - Math.exp(-14 * dt));
      const d = this.driftF;

      // lateral capacity of each axle (traction circle)
      const brakeCap = Math.sqrt(1 - BRAKE_CIRCLE * BRAKE_CIRCLE * brk * brk);
      let capF = Math.sqrt(Math.max(0.05, 1 - this.kxDrive * this.kxDrive * usedF * usedF)) * brakeCap;
      let capR = Math.sqrt(Math.max(0.05, 1 - this.kxDrive * this.kxDrive * usedR * usedR)) * brakeCap;
      if (usedF > 0) capF *= 1 - 0.3 * spinLoss;
      if (usedR > 0) capR *= 1 - this.spinGripLoss * spinLoss;
      capR *= 1 - this.looseAmount * this.rearLoose;
      if (hb) {
        capR *= HANDBRAKE_GRIP;
        lockSlip = 1;
      }
      if (this.unsettle > 0) capR *= 0.6;

      const lowR = Math.min(1, ((vr < 0 ? -vr : vr) + 0.12 * uAbs) / 0.6);
      const fyR = -(alphaR < 0 ? -1 : 1) * muR * fzR * capR * tyreCurve(absAR / PEAK_SLIP_REAR, this.rearFalloff) * lowR;

      // front axle: steering + ideal counter-steer while drifting
      const vf = v + this.a * w;
      if (d > 0.001) {
        const betaF = Math.atan2(vf, uRef);
        const rho = clamp((DRIFT_BALANCE * this.b * (fyR < 0 ? -fyR : fyR)) / (this.a * muF * fzF * capF + 1), 0, 0.97);
        const ideal = betaF + (fyR < 0 ? -1 : 1) * tyreCurveInverse(rho) * PEAK_SLIP_FRONT;
        delta = clamp(deltaIn + d * ideal, -1.05, 1.05);
      }
      const cd = Math.cos(delta);
      const sd = Math.sin(delta);
      const vperp = vf * cd - u * sd;
      const vpar = u * cd + vf * sd;
      const vparAbs = vpar < 0 ? -vpar : vpar;
      const alphaF = Math.atan2(vperp, vparAbs > 1 ? vparAbs : 1);
      absAF = alphaF < 0 ? -alphaF : alphaF;
      const lowF = Math.min(1, ((vperp < 0 ? -vperp : vperp) + 0.12 * vparAbs) / 0.6);
      const fyFw = -(alphaF < 0 ? -1 : 1) * muF * fzF * capF * tyreCurve(absAF / PEAK_SLIP_FRONT, FRONT_FALLOFF) * lowF;

      // nitro thrust (fades toward the nitro top speed)
      let fNitro = 0;
      if (s.nitroActive) {
        fNitro = mass * c.nitroAccel * clamp((this.nitroTopSpeed - alongPos) / (0.45 * this.nitroTopSpeed), 0, 1);
      }

      // sum in the body frame
      const fyFront = fyFw * cd + fxF * sd;
      const fxBody = fxR + fxF * cd - fyFw * sd + fNitro;
      const fyBody = fyR + fyFront;
      let wDot = (this.a * fyFront - this.b * fyR) / this.iz;
      if (d > 0.001) {
        // hold the slide: pull the yaw rate toward the rate at which the velocity vector turns
        wDot += d * DRIFT_YAW_DAMP * (fyBody / mass / (u > 6 ? u : 6) - w);
        if (absBeta > DRIFT_SOFT_LIMIT) wDot += (beta < 0 ? -1 : 1) * DRIFT_LIMIT_GAIN * (absBeta - DRIFT_SOFT_LIMIT) * d;
      }

      const sf = this.slopeF;
      const sr = this.slopeR;
      uN = u + (fxBody / mass - dragK * u - (G * sf) / (1 + sf * sf)) * dt;
      vN = v + (fyBody / mass - dragK * v - (G * sr) / (1 + sr * sr)) * dt;
      wN = w + wDot * dt;

      // resistive forces never reverse the motion
      let aRes = (c.rollCoef + this.surfRoll) * G + fEngBrake / mass;
      aRes += c.brakeDecel * brk * Math.min(1, 0.25 + 0.75 * this.surfGrip) * (s.punctured ? 0.75 : 1);
      if (hb) aRes += (0.3 * muR * fzR) / mass + (uAbs < 2 ? 3 : 0);
      if (s.punctured) aRes += 1.2 + 0.012 * Math.max(0, uAbs - PUNCTURE_SPEED) * Math.max(0, uAbs - PUNCTURE_SPEED);
      if (s.surface === 'water') aRes += 0.02 * u * u;
      if (uN > 0) uN = Math.max(0, uN - aRes * dt);
      else uN = Math.min(0, uN + aRes * dt);

      // low speed: blend to a kinematic bicycle (no jitter, no creep)
      const kin = 1 - sstep(2, 5, speed);
      kinBlend = kin;
      if (kin > 0) {
        const k = 1 - Math.exp(-16 * kin * dt);
        const wKin = (uN * Math.tan(deltaIn)) / this.wheelbase;
        wN += (wKin - wN) * k;
        vN += (this.b * wKin - vN) * k;
        const slope = Math.abs(sf) + Math.abs(sr);
        if (thr < 0.02 && slope < 0.4 && Math.abs(uN) < 0.3 && Math.abs(vN) < 0.4) {
          uN = 0;
          vN = 0;
          wN = 0;
        }
      }
    } else {
      // airborne: ballistic, no tyre forces, light yaw damping
      uN = u - dragK * u * dt;
      vN = v - dragK * v * dt;
      wN = w * (1 - 0.35 * dt);
      this.spinVel = 0;
      this.driftF -= this.driftF * (1 - Math.exp(-6 * dt));
      this.rearLoose -= this.rearLoose * (1 - Math.exp(-2 * dt));
    }
    wN = clamp(wN, -8, 8);

    // smoothed body accelerations (weight transfer, visuals)
    const kA = 1 - Math.exp(-10 * dt);
    this.axS += (clamp((uN - u) / dt, -30, 30) - this.axS) * kA;
    this.ayS += (clamp((vN - v) / dt + kinBlend * u * w, -30, 30) - this.ayS) * kA;

    // --- integrate
    s.yawRate = -wN;
    s.heading = wrapAngle(s.heading + s.yawRate * dt);
    this.fx = Math.sin(s.heading);
    this.fz = Math.cos(s.heading);
    if (kinBlend > 0) {
      // kinematic regime: the velocity vector turns with the body (no tyre slip needed to steer it)
      const hk = s.heading - s.yawRate * dt * (1 - kinBlend);
      const sk = Math.sin(hk);
      const ck = Math.cos(hk);
      s.vx = uN * sk - vN * ck;
      s.vz = uN * ck + vN * sk;
    } else {
      s.vx = uN * sinH - vN * cosH;
      s.vz = uN * cosH + vN * sinH;
    }
    this.moveAndCollide(dt);

    // NaN guard: never let a bad value poison the simulation
    if (!(s.x === s.x && s.z === s.z && s.vx === s.vx && s.vz === s.vz && s.heading === s.heading)) {
      s.x = this.safeX;
      s.z = this.safeZ;
      s.heading = this.safeH;
      s.vx = 0;
      s.vz = 0;
      s.vy = 0;
      s.yawRate = 0;
      this.fx = Math.sin(s.heading);
      this.fz = Math.cos(s.heading);
    } else {
      this.safeX = s.x;
      this.safeZ = s.z;
      this.safeH = s.heading;
    }

    // --- outputs in the new frame
    const fx = this.fx;
    const fz = this.fz;
    const u2 = s.vx * fx + s.vz * fz;
    const v2 = -s.vx * fz + s.vz * fx;
    const speed2 = Math.sqrt(s.vx * s.vx + s.vz * s.vz);

    this.sampleGround();
    this.updateVertical(dt, speed2, u2, v2);

    s.speed = u2;
    s.lateralSpeed = v2;
    s.speedKmh = speed2 * 3.6;
    s.throttle = thr;
    s.brake = brk;
    s.handbrake = hb;
    this.handbrakeOn = hb;
    s.steerAngle = clamp(delta, -c.maxSteer, c.maxSteer);
    s.accelLong = this.axS;
    s.accelLat = this.ayS;
    s.slipAngle = speed2 > 3 ? Math.atan2(v2, u2 < 0 ? -u2 : u2) : 0;

    // body attitude
    const kP = 1 - Math.exp(-9 * dt);
    if (this.landCompress > 0) this.landCompress -= this.landCompress * (1 - Math.exp(-6 * dt));
    if (s.grounded) {
      const pitchT = Math.atan(this.slopeF) + (c.bodyPitch * this.axS) / G - this.landCompress;
      const rollT = Math.atan(-this.slopeR) - (c.bodyRoll * this.ayS) / G;
      s.pitch += (pitchT - s.pitch) * kP;
      s.roll += (clamp(rollT, -0.6, 0.6) - s.roll) * kP;
    } else {
      // the nose follows the trajectory and drops gently
      const pitchT = clamp(Math.atan2(s.vy, speed2 + 4) * 0.6 - 0.04 * Math.min(1.5, s.airTime), -0.4, 0.35);
      const kAir = 1 - Math.exp(-2.2 * dt);
      s.pitch += (pitchT - s.pitch) * kAir;
      s.roll -= s.roll * kAir;
    }

    // drift state
    const angDeg = (s.slipAngle < 0 ? -s.slipAngle : s.slipAngle) / DEG;
    if (!s.drifting) {
      if (angDeg > 12 && s.speedKmh > 35 && s.grounded && u2 > 0) {
        s.drifting = true;
        s.driftTime = 0;
        this.driftMaxAngle = angDeg;
        this.driftLowTimer = 0;
        this.events.push({ type: 'driftStart' });
      }
    } else {
      s.driftTime += dt;
      if (angDeg > this.driftMaxAngle && angDeg < 110) this.driftMaxAngle = angDeg;
      if (angDeg < 7 || angDeg > 110 || s.speedKmh < 25) this.driftLowTimer += dt;
      else if (!s.grounded) this.driftLowTimer += dt * 0.35;
      else this.driftLowTimer = 0;
      if (this.driftLowTimer > 0.25) {
        s.drifting = false;
        this.events.push({ type: 'driftEnd', duration: s.driftTime, maxAngleDeg: this.driftMaxAngle });
      }
    }
    s.driftAngleDeg = s.drifting ? angDeg : 0;

    // tyre squeal / smoke
    let slipT = 0;
    if (s.grounded) {
      const sp = sstep(3, 8, speed2);
      slipT = sstep(7 * DEG, 22 * DEG, absAR) * sp;
      const front = 0.7 * sstep(11 * DEG, 26 * DEG, absAF) * sp;
      if (front > slipT) slipT = front;
      const spin = Math.min(1, this.spinVel / 3.5);
      if (spin > slipT) slipT = spin;
      if (lockSlip > 0 && speed2 > 2) slipT = Math.max(slipT, 0.85);
      else if (brk > 0.9 && speed2 > 6) slipT = Math.max(slipT, 0.12);
    }
    s.wheelSlip += (slipT - s.wheelSlip) * (1 - Math.exp(-12 * dt));

    this.updateEngineTemp(thr, dt);
    if (s.engineBlown && s.nitroActive) {
      s.nitroActive = false;
      this.events.push({ type: 'nitroEnd' });
    }
  }
}

// -----------------------------------------------------------------------------
// Factories, configuration cache, estimates
// -----------------------------------------------------------------------------

export function createVehicle(config: VehicleConfig, env: PhysicsEnvironment): IVehicle {
  return new VehiclePhysics(config, env);
}

const FLAT_ENV: PhysicsEnvironment = {
  getGroundHeight: () => 0,
  getSurface: () => 'asphalt',
  queryColliders: () => 0,
};

const SIM_DT = 1 / 120;
const SIM_INPUT: DriveInput = { throttle: 1, brake: 0, steer: 0, handbrake: false, nitro: false, shiftUp: false, shiftDown: false };

/** Full-throttle standing start on flat asphalt with the automatic gearbox (s). */
function simulateZeroToHundred(cfg: VehicleConfig): number {
  const car = new VehiclePhysics(cfg, FLAT_ENV);
  car.reset(0, 0, 0, 0);
  const target = 100 / 3.6;
  let t = 0;
  let prev = 0;
  while (t < 40) {
    car.update(SIM_DT, SIM_INPUT);
    car.events.length = 0;
    t += SIM_DT;
    const sp = car.state.speed;
    if (sp >= target) return t - (SIM_DT * (sp - target)) / Math.max(1e-6, sp - prev);
    prev = sp;
  }
  return 40;
}

/** Flat-out terminal speed on flat asphalt (m/s). */
function simulateTopSpeed(cfg: VehicleConfig): number {
  const car = new VehiclePhysics(cfg, FLAT_ENV);
  car.reset(0, 0, 0, cfg.estTopSpeed * 0.9);
  let t = 0;
  let mark = car.state.speed;
  let best = mark;
  while (t < 150) {
    for (let i = 0; i < 240; i++) car.update(SIM_DT, SIM_INPUT);
    car.events.length = 0;
    t += 2;
    const sp = car.state.speed;
    if (sp > best) best = sp;
    if (Math.abs(sp - mark) < 0.01) break;
    mark = sp;
  }
  return best;
}

function cloneConfig(c: VehicleConfig): VehicleConfig {
  return {
    ...c,
    gearRatios: c.gearRatios.slice(),
    torqueCurve: c.torqueCurve.map((p): [number, number] => [p[0], p[1]]),
  };
}

function cacheKey(spec: CarPhysicsSpec, t: TuningState): string {
  const d = spec.dims;
  return [
    spec.id,
    t.engine,
    t.turbo,
    t.transmission,
    t.suspension,
    t.brakes,
    t.tires,
    t.nitro,
    spec.drivetrain,
    spec.aspiration,
    spec.massKg,
    spec.powerHp,
    spec.torqueNm,
    spec.idleRpm,
    spec.redlineRpm,
    spec.cylinders,
    spec.topSpeedKmh,
    spec.grip,
    spec.agility,
    spec.brakeG,
    spec.driftBias,
    spec.gearRatios.join('/'),
    d.length,
    d.width,
    d.height,
    d.wheelbase,
    d.track,
    d.wheelRadius,
  ].join('|');
}

const configCache = new Map<string, VehicleConfig>();
const statsCache = new Map<string, PerfStats>();

function buildCached(spec: CarPhysicsSpec, tuning: TuningState): VehicleConfig {
  const key = cacheKey(spec, tuning);
  let cfg = configCache.get(key);
  if (!cfg) {
    cfg = buildBaseConfig(spec, tuning);
    // calibrate the aero drag so the simulated terminal speed lands on the target
    const target = cfg.estTopSpeed;
    let top = simulateTopSpeed(cfg);
    for (let i = 0; i < 2 && Math.abs(top / target - 1) > 0.004; i++) {
      cfg.dragCoef *= Math.pow(top / target, 2.6);
      top = simulateTopSpeed(cfg);
    }
    cfg.estTopSpeed = top;
    cfg.estZeroToHundred = simulateZeroToHundred(cfg);
    configCache.set(key, cfg);
  }
  return cfg;
}

/**
 * Resolves a catalogue spec + tuning levels into physical parameters (TUNE_EFFECTS applied
 * exactly). Deterministic and cached; every call returns a fresh copy.
 */
export function buildVehicleConfig(spec: CarPhysicsSpec, tuning: TuningState): VehicleConfig {
  return cloneConfig(buildCached(spec, tuning));
}

/** Garage figures (0..100 bars) for a spec + tuning. Deterministic and cached. */
export function estimateStats(spec: CarPhysicsSpec, tuning: TuningState): PerfStats {
  const key = cacheKey(spec, tuning);
  let stats = statsCache.get(key);
  if (!stats) {
    stats = computeStats(buildCached(spec, tuning));
    statsCache.set(key, stats);
  }
  return { ...stats };
}
