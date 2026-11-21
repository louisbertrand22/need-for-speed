/* =============================================================================
 * PORT-SÉLÈNE — procedural open world of APEX NOCTURNE
 * generateCity() builds everything in one pass: heightfield, road graph, the
 * ring highway with its tunnel and bridge, four districts, colliders, jump
 * ramps, pursuit breakers, map data. See src/world/city/* for the pieces.
 * ===========================================================================*/
import * as THREE from 'three';
import type {
  CityWorld,
  DistrictId,
  LandmarkId,
  MapData,
  PursuitBreaker,
  RampInfo,
  Rect,
  SpawnPoint,
  StaticCollider,
  SurfaceType,
} from '../core/types';
import { GARAGE_SPOT, RING, TUNNEL, WORLD_BOUNDS, districtAt as layoutDistrictAt } from '../core/layout';
import { buildCore } from './city/core';
import type { CityCore } from './city/core';
import { ColliderIndex } from './city/colliders';
import type { CityRoadGraph } from './city/roadGraph';
import { BRIDGE_LEN, BRIDGE_S0, ringPose } from './city/roadPlan';

/** Extra, non-contract members exposed for the dev tools (dev/city-*.ts). */
export interface CityDebug {
  naturalHeight(x: number, z: number): number;
  allColliders(): StaticCollider[];
  /** generation timings (ms) per stage */
  timings: Record<string, number>;
}

class PortSelene implements CityWorld {
  readonly group = new THREE.Group();
  readonly bounds: Rect = WORLD_BOUNDS;
  readonly roads: CityRoadGraph;
  readonly mapData: MapData;
  readonly landmarks: Record<LandmarkId, SpawnPoint>;
  readonly pursuitBreakers: PursuitBreaker[] = [];
  readonly ramps: RampInfo[] = [];
  readonly fogColor = 0x0b0e22;
  readonly fogDensity = 0.0022;
  readonly debug: CityDebug;

  private core: CityCore;
  private colliders = new ColliderIndex();

  constructor(seed: number) {
    const timings: Record<string, number> = {};
    let t = performance.now();
    const lap = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round((now - t) * 10) / 10;
      t = now;
    };
    this.group.name = 'PortSelene';
    this.core = buildCore(seed, []);
    this.roads = this.core.graph;
    lap('core');
    this.core.ground.paintBase();
    for (const e of this.roads.edges) {
      for (let i = 0; i + 1 < e.points.length; i++) {
        this.core.ground.paintSegment(e.points[i].x, e.points[i].z, e.points[i + 1].x, e.points[i + 1].z, e.width / 2, 1);
      }
    }
    lap('surface');
    this.landmarks = this.buildLandmarks();
    this.mapData = { bounds: WORLD_BOUNDS, roads: [], districts: [], water: [], tunnels: [], bridges: [] };
    this.debug = {
      naturalHeight: (x, z) => this.core.hf.sampleNatural(x, z),
      allColliders: () => this.colliders.all(),
      timings,
    };
  }

  private buildLandmarks(): Record<LandmarkId, SpawnPoint> {
    const hn = this.core.plan.hillNodes;
    const node = (key: string) => this.roads.nodes[hn[key]];
    // highest point of the hill roads
    let summit = { x: node('summit').x, z: node('summit').z, heading: 0 };
    let best = -Infinity;
    for (const e of this.roads.edges) {
      if (e.kind !== 'hill') continue;
      for (let i = 0; i + 1 < e.points.length; i++) {
        const p = e.points[i];
        const h = this.core.ground.height(p.x, p.z);
        if (h > best) {
          best = h;
          const q = e.points[i + 1];
          summit = { x: p.x, z: p.z, heading: Math.atan2(q.x - p.x, q.z - p.z) };
        }
      }
    }
    const bridgeMid = ringPose(BRIDGE_S0 + BRIDGE_LEN / 2);
    return {
      garage: { x: GARAGE_SPOT.x, z: GARAGE_SPOT.z, heading: GARAGE_SPOT.heading },
      downtownCore: { x: 0, z: 0, heading: Math.PI / 2 },
      lanternPlaza: { x: 675, z: -300, heading: Math.PI / 2 },
      docksGate: { x: 0, z: 450, heading: 0 },
      docksPier: { x: 800, z: 900, heading: -Math.PI / 2 },
      hillsSummit: summit,
      hillsEastGate: { x: node('gateE').x, z: node('gateE').z, heading: -Math.PI / 2 },
      hillsNorthGate: { x: node('gateN').x, z: node('gateN').z, heading: -Math.PI / 2 },
      hillsSouthGate: { x: node('gateS').x, z: node('gateS').z, heading: -Math.PI / 2 },
      ringNorth: { x: 0, z: -RING.half, heading: Math.PI / 2 },
      ringEast: { x: RING.half, z: 0, heading: 0 },
      ringSouth: { x: 0, z: RING.half, heading: -Math.PI / 2 },
      tunnelMid: { x: -RING.half, z: (TUNNEL.zFrom + TUNNEL.zTo) / 2, heading: Math.PI },
      bridgeMid: { x: bridgeMid.x, z: bridgeMid.z, heading: Math.atan2(bridgeMid.dx, bridgeMid.dz) },
    };
  }

  // --- PhysicsEnvironment ---------------------------------------------------

  getGroundHeight(x: number, z: number): number {
    return this.core.ground.height(x, z);
  }

  getSurface(x: number, z: number): SurfaceType {
    return this.core.ground.surfaceAt(x, z);
  }

  queryColliders(x: number, z: number, radius: number, out: StaticCollider[]): number {
    return this.colliders.query(x, z, radius, out);
  }

  // --- CityWorld --------------------------------------------------------------

  districtAt(x: number, z: number): DistrictId {
    return layoutDistrictAt(x, z);
  }

  lineOfSight(x1: number, z1: number, x2: number, z2: number): boolean {
    return this.colliders.lineOfSight(x1, z1, x2, z2);
  }

  isInTunnel(x: number, z: number): boolean {
    return z >= TUNNEL.zFrom && z <= TUNNEL.zTo && Math.abs(x + RING.half) < RING.width / 2 + 1.5;
  }

  addCollider(c: Omit<StaticCollider, 'id'>): StaticCollider {
    return this.colliders.add(c);
  }

  removeCollider(c: StaticCollider): void {
    this.colliders.remove(c);
  }

  hitProp(_collider: StaticCollider, _vx: number, _vz: number): void {}

  triggerBreaker(_id: string, _dirX: number, _dirZ: number): boolean {
    return false;
  }

  resetDestructibles(): void {}

  update(_dt: number, _time: number, _focus: THREE.Vector3): void {}

  dispose(): void {}
}

export function generateCity(seed = 20261): CityWorld {
  return new PortSelene(seed);
}
