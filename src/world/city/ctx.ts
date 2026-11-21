/* Shared build context passed to every generation stage. */
import type { DistrictId } from '../../core/types';
import type { CityCore } from './core';
import type { CityRoadGraph } from './roadGraph';
import type { ColliderIndex } from './colliders';
import type { TileSet } from './batch';
import type { PropSystem } from './props';

export interface Block {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  district: DistrictId;
  /** open ground (plaza, cell crossed by a diagonal): no raised pavement */
  open: boolean;
}

export interface Zone {
  x: number;
  z: number;
  hx: number;
  hz: number;
  rot: number;
}

export interface Ctx {
  rng: () => number;
  core: CityCore;
  graph: CityRoadGraph;
  colliders: ColliderIndex;
  tiles: TileSet;
  props: PropSystem;
  blocks: Block[];
  /** oriented no-build zones (ramp run-ups and landings, breakers, garage forecourt...) */
  reserved: Zone[];
  /** ground height (physics truth) */
  h(x: number, z: number): number;
  isReserved(x: number, z: number, margin: number): boolean;
}

export function zoneContains(zn: Zone, x: number, z: number, margin: number): boolean {
  const cs = Math.cos(zn.rot);
  const sn = Math.sin(zn.rot);
  const rx = x - zn.x;
  const rz = z - zn.z;
  const lx = rx * cs - rz * sn;
  const lz = rx * sn + rz * cs;
  return Math.abs(lx) <= zn.hx + margin && Math.abs(lz) <= zn.hz + margin;
}

export const COLORS = {
  asphalt: [0.034, 0.036, 0.044] as const,
  concrete: [0.13, 0.13, 0.14] as const,
  plaza: [0.09, 0.09, 0.105] as const,
  apron: [0.075, 0.075, 0.08] as const,
  ground: [0.022, 0.022, 0.026] as const,
  barrier: [0.2, 0.2, 0.21] as const,
  markWhite: [0.5, 0.5, 0.46] as const,
  markYellow: [0.55, 0.4, 0.08] as const,
};
