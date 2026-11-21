/* Deterministic value noise helpers used by the terrain and the procedural textures. */

function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in [0, 1). */
export function valueNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Fractal value noise, result roughly in [-1, 1]. */
export function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * f, z * f, seed + o * 17) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Value noise that tiles with the given integer period (lattice units). Result in [0, 1). */
export function tileNoise(x: number, z: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const x0 = ((ix % period) + period) % period;
  const z0 = ((iz % period) + period) % period;
  const x1 = (x0 + 1) % period;
  const z1 = (z0 + 1) % period;
  const a = hash2(x0, z0, seed);
  const b = hash2(x1, z0, seed);
  const c = hash2(x0, z1, seed);
  const d = hash2(x1, z1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Tileable fractal noise in [0, 1]: `period` lattice cells across the unit square (u, v in [0, 1)). */
export function tileFbm(u: number, v: number, period: number, seed: number, octaves = 4): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += tileNoise(u * p, v * p, p, seed + o * 31) * amp;
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}
