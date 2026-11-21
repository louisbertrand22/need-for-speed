/** Small shared math helpers (no Three.js dependency). */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const KMH = 3.6; // m/s -> km/h multiplier

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : clamp01((v - a) / (b - a));
}

export function remap(v: number, a: number, b: number, c: number, d: number): number {
  return lerp(c, d, invLerp(a, b, v));
}

export function smoothstep(a: number, b: number, v: number): number {
  const t = invLerp(a, b, v);
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach: move `a` toward `b` with rate `lambda` (1/s). */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Move `a` toward `b` by at most `maxDelta`. */
export function approach(a: number, b: number, maxDelta: number): number {
  if (a < b) return Math.min(a + maxDelta, b);
  return Math.max(a - maxDelta, b);
}

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed difference `to - from`, wrapped to (-PI, PI]. */
export function angleDiff(from: number, to: number): number {
  return wrapAngle(to - from);
}

export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  return a + angleDiff(a, b) * (1 - Math.exp(-lambda * dt));
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

export function hypot2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

export function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Heading convention used everywhere in the game:
 *   forward(h) = (sin h, 0, cos h)      right(h) = (-cos h, 0, sin h)
 * A heading is obtained from a direction with atan2(dx, dz).
 */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(dx, dz);
}

/** Deterministic PRNG (mulberry32). Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng: () => number, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

export function randInt(rng: () => number, lo: number, hiInclusive: number): number {
  return lo + Math.floor(rng() * (hiInclusive - lo + 1));
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length) % arr.length];
}

export function formatTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '--:--.---';
  const total = Math.floor(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mil = total % 1000;
  return `${m}:${s.toString().padStart(2, '0')}.${mil.toString().padStart(3, '0')}`;
}

export function formatMoney(v: number): string {
  return `${Math.round(v).toLocaleString('fr-FR')} $`;
}
