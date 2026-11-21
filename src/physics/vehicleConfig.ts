/* =============================================================================
 * APEX NOCTURNE — vehicle configuration builder (pure, no simulation).
 * Turns a catalogue spec + tuning levels into the resolved physical parameters
 * used by VehiclePhysics. The two simulated estimates (top speed, 0-100) are
 * filled by buildVehicleConfig() in vehiclePhysics.ts.
 * ===========================================================================*/
import type { CarPhysicsSpec, PerfStats, TuningState, VehicleConfig } from '../core/types';
import { TUNE_EFFECTS } from '../game/catalog';
import { clamp, remap } from '../core/math';

export const GRAVITY = 9.81;
export const HP_TO_WATT = 735.49875;
export const RPM_TO_RAD = Math.PI / 30;
/** boost already present on stock turbo cars */
export const STOCK_TURBO_BOOST = 0.12;
/** top gear reaches the target top speed at this fraction of the redline */
export const TOP_GEAR_RPM_FRACTION = 0.925;
/** hard limiter position relative to the redline */
export const REV_LIMIT_FACTOR = 1.055;
export const ROLL_COEF = 0.013;
/** top speed grows with (power ratio)^this (a little under the ideal cube root: rolling losses) */
const TOP_SPEED_POWER_EXPONENT = 0.3;

/** Linear interpolation in a [rpm, Nm] table (clamped at both ends). */
export function sampleTorqueCurve(curve: readonly (readonly [number, number])[], rpm: number): number {
  const n = curve.length;
  if (n === 0) return 0;
  if (rpm <= curve[0][0]) return curve[0][1];
  if (rpm >= curve[n - 1][0]) return curve[n - 1][1];
  for (let i = 1; i < n; i++) {
    const p1 = curve[i];
    if (rpm <= p1[0]) {
      const p0 = curve[i - 1];
      const t = (rpm - p0[0]) / (p1[0] - p0[0]);
      return p0[1] + (p1[1] - p0[1]) * t;
    }
  }
  return curve[n - 1][1];
}

function hermite(p0: number, m0: number, p1: number, m1: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * p1 + (t3 - t2) * m1;
}

/**
 * Builds a torque curve whose maximum is `peakTorque` and whose maximum power is `peakPowerW`.
 * Everything is expressed as a fraction of the redline:
 *   - below fT the torque rises from the idle value to the peak (turbo engines: early flat plateau),
 *   - between fT (torque peak) and fP (power peak) the POWER follows a monotone Hermite arc,
 *   - above fP the power decays up to the limiter.
 */
export function buildTorqueCurve(
  idleRpm: number,
  redlineRpm: number,
  revLimitRpm: number,
  peakTorque: number,
  peakPowerW: number,
  cylinders: number,
  turboShaped: boolean,
): [number, number][] {
  const wRed = redlineRpm * RPM_TO_RAD;
  // fraction of the redline at which (peak torque x omega) equals the peak power
  const q = clamp(peakPowerW / Math.max(1, peakTorque) / wRed, 0.5, 0.96);
  const fIdle = clamp(idleRpm / redlineRpm, 0.05, 0.3);
  const fLim = revLimitRpm / redlineRpm;

  // where the power peaks
  let fP = cylinders >= 12 ? 0.93 : cylinders >= 8 ? 0.87 : cylinders >= 6 ? 0.89 : 0.88;
  if (turboShaped) fP -= 0.03;
  fP = clamp(Math.max(fP, q + 0.04), 0.6, 0.985);

  // where the torque peaks (end of the plateau for turbo engines)
  let fT = turboShaped ? 0.62 : cylinders >= 12 ? 0.74 : cylinders >= 8 ? 0.66 : cylinders >= 6 ? 0.68 : 0.67;
  // the Hermite arc in the power domain stays monotone when (q - fT) >= (fP - fT) / 3
  const fTBound = 1.5 * q - 0.5 * fP - 0.01;
  fT = clamp(Math.min(fT, fTBound), fIdle + 0.15, fP - 0.05);
  const fPlateau = turboShaped ? Math.min(0.4, fT - 0.1) : fT;

  // torque at idle relative to the peak
  const low = turboShaped ? 0.6 : cylinders >= 12 ? 0.6 : cylinders >= 8 ? 0.76 : cylinders >= 6 ? 0.68 : 0.63;
  const fall = turboShaped ? 0.2 : cylinders >= 12 ? 0.1 : 0.15;

  const torqueAt = (f: number): number => {
    if (f <= fPlateau) {
      const t = clamp((f - fIdle) / (fPlateau - fIdle), 0, 1);
      const ease = 1 - (1 - t) * (1 - t);
      return peakTorque * (low + (1 - low) * ease);
    }
    if (f <= fT) return peakTorque;
    if (f <= fP) {
      const span = fP - fT;
      const t = (f - fT) / span;
      // power fraction: starts tangent to the constant-torque line, ends flat at the power peak
      const p = hermite(fT, span, q, 0, t);
      return (peakTorque * Math.min(p, f)) / f;
    }
    const t = clamp((f - fP) / Math.max(0.02, fLim - fP), 0, 1.3);
    return (peakTorque * q * (1 - fall * t * t)) / f;
  };

  const fractions = [fIdle, 0.2, 0.26, 0.32, 0.38, 0.44, 0.5, 0.56, 0.62, 0.68, 0.74, 0.8, 0.85, 0.9, 0.95, 1, fLim, fPlateau, fT, fP];
  const sorted = fractions.filter((f) => f >= fIdle - 1e-6 && f <= fLim + 1e-6).sort((a, b) => a - b);
  const curve: [number, number][] = [];
  let last = -1;
  for (const f of sorted) {
    if (f - last < 0.012) continue;
    last = f;
    curve.push([Math.round(f * redlineRpm), Math.round(torqueAt(f) * 10) / 10]);
  }
  return curve;
}

function peakPowerWatts(curve: readonly (readonly [number, number])[], from: number, to: number): number {
  let best = 0;
  for (let rpm = from; rpm <= to; rpm += 25) {
    const p = sampleTorqueCurve(curve, rpm) * rpm * RPM_TO_RAD;
    if (p > best) best = p;
  }
  return best;
}

function peakTorqueOf(curve: readonly (readonly [number, number])[]): number {
  let best = 0;
  for (const p of curve) if (p[1] > best) best = p[1];
  return best;
}

/**
 * Resolved configuration with ANALYTIC estimates only (estTopSpeed = target speed,
 * estZeroToHundred = 0). Use buildVehicleConfig() to get the simulated figures.
 */
export function buildBaseConfig(spec: CarPhysicsSpec, tuning: TuningState): VehicleConfig {
  const fx = TUNE_EFFECTS;
  const d = spec.dims;
  const powerMult = fx.engine.power[tuning.engine];
  const redline = spec.redlineRpm + fx.engine.redline[tuning.engine];
  const stockBoost = spec.aspiration === 'turbo' ? STOCK_TURBO_BOOST : 0;
  const boost = stockBoost + fx.turbo.boost[tuning.turbo];
  const revLimit = Math.round((redline * REV_LIMIT_FACTOR) / 50) * 50;

  // --- engine (the curve excludes forced induction: full boost restores the catalogue figures)
  const baseTorque = (spec.torqueNm * powerMult) / (1 + stockBoost);
  const basePowerW = (spec.powerHp * HP_TO_WATT * powerMult) / (1 + stockBoost);
  const torqueCurve = buildTorqueCurve(spec.idleRpm, redline, revLimit, baseTorque, basePowerW, spec.cylinders, spec.aspiration === 'turbo');
  const peakTorqueNm = peakTorqueOf(torqueCurve) * (1 + boost);
  const peakPowerHp = (peakPowerWatts(torqueCurve, spec.idleRpm, revLimit) * (1 + boost)) / HP_TO_WATT;

  // --- transmission: top gear reaches the target top speed at ~92.5 % of the redline
  const efficiency = fx.transmission.efficiency[tuning.transmission];
  const powerRatio = (powerMult * (1 + boost)) / (1 + stockBoost);
  const vTarget = (spec.topSpeedKmh / 3.6) * Math.pow(powerRatio, TOP_SPEED_POWER_EXPONENT) * fx.transmission.topSpeed[tuning.transmission];
  const gearRatios = spec.gearRatios.slice();
  const topRatio = gearRatios[gearRatios.length - 1];
  const rpmTop = TOP_GEAR_RPM_FRACTION * redline;
  const finalDrive = (rpmTop * RPM_TO_RAD * d.wheelRadius) / (topRatio * vTarget);

  // --- aero drag: thrust at vTarget (top gear, full boost) balances drag + rolling resistance
  const wheelPower = sampleTorqueCurve(torqueCurve, rpmTop) * (1 + boost) * rpmTop * RPM_TO_RAD * efficiency;
  const dragCoef = Math.max(0.05, (wheelPower / vTarget - ROLL_COEF * spec.massKg * GRAVITY) / (vTarget * vTarget));

  // --- chassis
  const lowBody = d.height < 1.2;
  let frontWeight: number;
  if (spec.drivetrain === 'FWD') frontWeight = 0.61;
  else if (lowBody) frontWeight = spec.drivetrain === 'AWD' ? 0.44 : 0.43;
  else frontWeight = spec.drivetrain === 'AWD' ? 0.55 : 0.53;

  // --- tyres
  const baseGrip = (spec.grip + fx.suspension.grip[tuning.suspension]) * fx.tires.grip[tuning.tires];
  const gripFront = baseGrip;
  // the rear always keeps a small margin (stable, mild understeer at the limit); drifty cars keep less
  const gripRear = baseGrip * (1.07 - 0.05 * spec.driftBias);
  const heightRatio = 1.3 / d.height;
  const downforce = 0.8e-5 * heightRatio * heightRatio + (lowBody ? 1.4e-5 : 0);

  const perfectShiftHi = Math.round(redline * 0.995);
  const perfectShiftLo = Math.round(perfectShiftHi - 0.07 * redline);
  const rollMult = fx.suspension.roll[tuning.suspension];

  return {
    specId: spec.id,
    mass: spec.massKg,
    length: d.length,
    width: d.width,
    height: d.height,
    wheelbase: d.wheelbase,
    track: d.track,
    wheelRadius: d.wheelRadius,
    cgHeight: 0.38 * d.height,
    frontWeight,
    drivetrain: spec.drivetrain,
    cylinders: spec.cylinders,
    aspiration: boost > 0 ? 'turbo' : 'na',
    idleRpm: spec.idleRpm,
    redlineRpm: redline,
    revLimitRpm: revLimit,
    peakTorqueNm,
    peakPowerHp,
    torqueCurve,
    turboBoost: boost,
    turboSpool: (spec.aspiration === 'turbo' ? 2.6 : 2.1) * fx.turbo.spool[tuning.turbo],
    gearRatios,
    reverseRatio: gearRatios[0] * 0.92,
    finalDrive,
    shiftTime: fx.transmission.shiftTime[tuning.transmission],
    efficiency,
    autoUpRpm: Math.round(perfectShiftLo + 0.55 * (perfectShiftHi - perfectShiftLo)),
    autoDownRpm: Math.round(0.36 * redline),
    perfectShiftLo,
    perfectShiftHi,
    nitroCapacity: fx.nitro.capacity[tuning.nitro],
    nitroAccel: fx.nitro.accel[tuning.nitro],
    nitroRegen: fx.nitro.regen[tuning.nitro],
    dragCoef,
    rollCoef: ROLL_COEF,
    downforce,
    gripFront,
    gripRear,
    driftBias: clamp(spec.driftBias, 0, 1),
    brakeDecel: spec.brakeG * GRAVITY * fx.brakes.force[tuning.brakes],
    maxSteer: 0.5 + 0.16 * spec.agility,
    steerResponse: (3.0 + 3.0 * spec.agility) * fx.suspension.response[tuning.suspension],
    bodyRoll: (0.055 + 0.05 * (1 - spec.agility)) * rollMult,
    bodyPitch: (0.03 + 0.03 * (1 - spec.agility)) * (0.5 + 0.5 * rollMult),
    estTopSpeed: vTarget,
    estZeroToHundred: 0,
  };
}

/** Garage figures and 0..100 bars derived from a fully built configuration. */
export function computeStats(cfg: VehicleConfig): PerfStats {
  const topSpeedKmh = cfg.estTopSpeed * 3.6;
  const barTopSpeed = remap(topSpeedKmh, 180, 430, 0, 100);
  const barAcceleration = remap(cfg.estZeroToHundred, 9, 1.9, 0, 100);
  const grip = 0.5 * (cfg.gripFront + cfg.gripRear);
  const barHandling = clamp(
    remap(grip, 0.85, 1.8, 0, 70) + remap(cfg.steerResponse, 4, 7.5, 0, 20) + remap(cfg.bodyRoll, 0.09, 0.03, 0, 10),
    0,
    100,
  );
  const barBraking = remap(cfg.brakeDecel / GRAVITY, 0.9, 1.9, 0, 100);
  const barNitro = clamp(20 + ((cfg.nitroCapacity * cfg.nitroAccel - 12.5) / 62.5) * 80, 0, 100);
  const rating = 0.3 * barTopSpeed + 0.3 * barAcceleration + 0.22 * barHandling + 0.1 * barBraking + 0.08 * barNitro;
  return {
    powerHp: Math.round(cfg.peakPowerHp),
    torqueNm: Math.round(cfg.peakTorqueNm),
    massKg: Math.round(cfg.mass),
    topSpeedKmh: Math.round(topSpeedKmh),
    zeroToHundred: Math.round(cfg.estZeroToHundred * 100) / 100,
    barTopSpeed: Math.round(barTopSpeed),
    barAcceleration: Math.round(barAcceleration),
    barHandling: Math.round(barHandling),
    barBraking: Math.round(barBraking),
    barNitro: Math.round(barNitro),
    rating: Math.round(rating),
  };
}
