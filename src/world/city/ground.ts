/* Ground model = the physics truth of the world: heightfield + bridge deck + bay + ramps,
 * and the surface-type raster. */
import type { RampInfo, Rect, SurfaceType } from '../../core/types';
import { BAY, RING } from '../../core/layout';
import type { Heightfield } from './terrain';
import { HILL_EDGE_X } from './terrain';
import { bridgeDeckHeight, bridgeU, ringLateral } from './roadPlan';

/** Pier decks standing in the bay (y = 0). */
export const PIERS: Rect[] = [
  { minX: BAY.minX, maxX: 826, minZ: 872, maxZ: 928 }, // west pier, along the street z = 900
  { minX: 872, maxX: 928, minZ: BAY.minZ, maxZ: 864 }, // north pier, along the street x = 900
];

/** Physics depth of the bay floor (cars end up half sunk; the surface type is 'water'). */
export const BAY_FLOOR = BAY.level - 0.6;
/** Half width of the bridge deck (carriageway + parapets). */
export const DECK_HALF = RING.width / 2 + 1.7;

const SURF_CELL = 2;
const SURF_ORIGIN = -1304;
const SURF_N = 1304;
export const SURF_CODES: SurfaceType[] = ['dirt', 'asphalt', 'concrete', 'grass', 'water'];
export const SURF = { dirt: 0, asphalt: 1, concrete: 2, grass: 3, water: 4 } as const;

export function inPier(x: number, z: number): boolean {
  for (const p of PIERS) if (x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ) return true;
  return false;
}

export function inBay(x: number, z: number): boolean {
  return x > BAY.minX && z > BAY.minZ && !inPier(x, z);
}

interface RampRec extends RampInfo {
  sin: number;
  cos: number;
  radius: number;
}

export class GroundModel {
  readonly ramps: RampRec[] = [];
  readonly surface = new Uint8Array(SURF_N * SURF_N);

  constructor(readonly hf: Heightfield) {}

  addRamp(info: RampInfo): void {
    this.ramps.push({
      ...info,
      sin: Math.sin(info.heading),
      cos: Math.cos(info.heading),
      radius: Math.hypot(info.length, info.width) * 0.5 + 0.5,
    });
  }

  /** Ground without the jump ramps. */
  baseHeight(x: number, z: number): number {
    if (x > 600 && z > 600) {
      if (Math.abs(ringLateral(x, z)) < DECK_HALF) {
        const u = bridgeU(x, z);
        if (u >= 0) return bridgeDeckHeight(u);
      }
      if (x > BAY.minX && z > BAY.minZ && !inPier(x, z)) return BAY_FLOOR;
    }
    return x < HILL_EDGE_X ? this.hf.sample(x, z) : 0;
  }

  height(x: number, z: number): number {
    const base = this.baseHeight(x, z);
    const ramps = this.ramps;
    for (let i = 0; i < ramps.length; i++) {
      const r = ramps[i];
      const dx = x - r.x;
      const dz = z - r.z;
      if (dx > r.radius || dx < -r.radius || dz > r.radius || dz < -r.radius) continue;
      const u = dx * r.sin + dz * r.cos + r.length * 0.5;
      if (u < 0 || u > r.length) continue;
      const v = dx * r.cos - dz * r.sin;
      if (v > r.width * 0.5 || v < -r.width * 0.5) continue;
      return base + (r.height * u) / r.length;
    }
    return base;
  }

  surfaceAt(x: number, z: number): SurfaceType {
    let i = Math.floor((x - SURF_ORIGIN) / SURF_CELL);
    let j = Math.floor((z - SURF_ORIGIN) / SURF_CELL);
    if (i < 0) i = 0;
    else if (i >= SURF_N) i = SURF_N - 1;
    if (j < 0) j = 0;
    else if (j >= SURF_N) j = SURF_N - 1;
    return SURF_CODES[this.surface[j * SURF_N + i]];
  }

  /** Paint an axis-aligned rectangle of the surface raster. */
  paintRect(minX: number, minZ: number, maxX: number, maxZ: number, code: number): void {
    const i0 = Math.max(0, Math.round((minX - SURF_ORIGIN) / SURF_CELL));
    const i1 = Math.min(SURF_N, Math.round((maxX - SURF_ORIGIN) / SURF_CELL));
    const j0 = Math.max(0, Math.round((minZ - SURF_ORIGIN) / SURF_CELL));
    const j1 = Math.min(SURF_N, Math.round((maxZ - SURF_ORIGIN) / SURF_CELL));
    for (let j = j0; j < j1; j++) this.surface.fill(code, j * SURF_N + i0, j * SURF_N + Math.max(i0, i1));
  }

  /** Paint every raster cell whose centre is within `half` of the segment. */
  paintSegment(ax: number, az: number, bx: number, bz: number, half: number, code: number): void {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - half - SURF_ORIGIN) / SURF_CELL));
    const i1 = Math.min(SURF_N - 1, Math.floor((Math.max(ax, bx) + half - SURF_ORIGIN) / SURF_CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - half - SURF_ORIGIN) / SURF_CELL));
    const j1 = Math.min(SURF_N - 1, Math.floor((Math.max(az, bz) + half - SURF_ORIGIN) / SURF_CELL));
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    const h2 = half * half;
    for (let j = j0; j <= j1; j++) {
      const z = SURF_ORIGIN + (j + 0.5) * SURF_CELL;
      for (let i = i0; i <= i1; i++) {
        const x = SURF_ORIGIN + (i + 0.5) * SURF_CELL;
        let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + dx * t - x;
        const pz = az + dz * t - z;
        if (px * px + pz * pz <= h2) this.surface[j * SURF_N + i] = code;
      }
    }
  }

  /** Base classification: water in the bay, grass / dirt in the hills, dirt verges elsewhere. */
  paintBase(): void {
    const hf = this.hf;
    for (let j = 0; j < SURF_N; j++) {
      const z = SURF_ORIGIN + (j + 0.5) * SURF_CELL;
      for (let i = 0; i < SURF_N; i++) {
        const x = SURF_ORIGIN + (i + 0.5) * SURF_CELL;
        let code: number = SURF.dirt;
        if (x > BAY.minX && z > BAY.minZ) code = inPier(x, z) ? SURF.concrete : SURF.water;
        else if (x < HILL_EDGE_X) {
          // steep or freshly cut ground is bare dirt / rock, the rest is grass
          const fi = Math.min(hf.n - 2, Math.max(0, Math.floor((x - hf.origin) / hf.cell)));
          const fj = Math.min(hf.n - 2, Math.max(0, Math.floor((z - hf.origin) / hf.cell)));
          const k = fj * hf.n + fi;
          const sx = hf.data[k + 1] - hf.data[k];
          const sz = hf.data[k + hf.n] - hf.data[k];
          const slope = Math.hypot(sx, sz) / hf.cell;
          code = slope > 0.42 || hf.carveW[k] > 0.55 ? SURF.dirt : SURF.grass;
        }
        this.surface[j * SURF_N + i] = code;
      }
    }
  }
}
