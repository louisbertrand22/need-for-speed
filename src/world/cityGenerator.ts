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
import { BAY, DISTRICTS, GARAGE_SPOT, RING, TUNNEL, WORLD_BOUNDS, districtAt as layoutDistrictAt, ringPolyline } from '../core/layout';
import { buildCore } from './city/core';
import type { CityCore } from './city/core';
import { ColliderIndex } from './city/colliders';
import type { CityRoadGraph } from './city/roadGraph';
import { BRIDGE_LEN, BRIDGE_S0, ringPose } from './city/roadPlan';
import { Batch, TileSet, flatQuad } from './city/batch';
import type { TileInfo } from './city/batch';
import { COLORS, zoneContains } from './city/ctx';
import type { Ctx } from './city/ctx';
import { PropSystem } from './city/props';
import { createLook } from './city/look';
import type { CityLook } from './city/look';
import { buildBlocks, buildRingBarriers, buildRoads, buildStreetLamps, buildTerrain, computeBlocks } from './city/roads';
import { buildBridge, buildGarage, buildQuays, buildRamps, buildTunnel, registerRamps, reserveGarage } from './city/structures';
import { buildDistricts, buildGuardRails, makeHillPads } from './city/districts';
import { BreakerSystem } from './city/breakers';
import { SURF } from './city/ground';
import { mulberry32 } from '../core/math';

/** Extra, non-contract members exposed for the dev tools (dev/city-*.ts). */
export interface CityDebug {
  naturalHeight(x: number, z: number): number;
  allColliders(): StaticCollider[];
  /** generation timings (ms) per stage */
  timings: Record<string, number>;
  tileCount: number;
  propCount: number;
  lampCount: number;
}

const HIDE_DISTANCE = 980;

class PortSelene implements CityWorld {
  readonly group = new THREE.Group();
  readonly bounds: Rect = WORLD_BOUNDS;
  readonly roads: CityRoadGraph;
  readonly mapData: MapData;
  readonly landmarks: Record<LandmarkId, SpawnPoint>;
  readonly pursuitBreakers: PursuitBreaker[];
  readonly ramps: RampInfo[] = [];
  readonly fogColor = 0x0b0e22;
  readonly fogDensity = 0.0022;
  readonly debug: CityDebug;

  private core: CityCore;
  private colliders = new ColliderIndex();
  private look: CityLook;
  private props: PropSystem;
  private breakers: BreakerSystem;
  private tileInfos: TileInfo[];
  private extraGeometries: THREE.BufferGeometry[] = [];

  constructor(seed: number) {
    const timings: Record<string, number> = {};
    let t = performance.now();
    const lap = (name: string) => {
      const now = performance.now();
      timings[name] = Math.round((now - t) * 10) / 10;
      t = now;
    };
    const rng = mulberry32(seed);
    this.group.name = 'PortSelene';
    this.core = buildCore(seed, makeHillPads);
    this.roads = this.core.graph;
    const ground = this.core.ground;
    lap('core');

    const tiles = new TileSet();
    this.props = new PropSystem(tiles, this.colliders);
    const ctx: Ctx = {
      rng,
      core: this.core,
      graph: this.roads,
      colliders: this.colliders,
      tiles,
      props: this.props,
      blocks: [],
      reserved: [],
      h: (x, z) => ground.height(x, z),
      isReserved: (x, z, margin) => {
        for (const zn of ctx.reserved) if (zoneContains(zn, x, z, margin)) return true;
        return false;
      },
    };
    registerRamps(ctx, this.ramps);
    reserveGarage(ctx);
    const sites = BreakerSystem.reserve(ctx);
    computeBlocks(ctx);
    // the two plazas: Place Sélène (downtown) and Place des Lampions (Lanterne)
    for (const blk of ctx.blocks) {
      for (const [px, pz] of [
        [75, -75],
        [675, -225],
      ]) {
        if (px > blk.minX && px < blk.maxX && pz > blk.minZ && pz < blk.maxZ) blk.open = true;
      }
    }
    ground.paintBase();
    lap('plan');

    this.look = createLook(rng, this.fogColor);
    lap('textures');

    buildBlocks(ctx);
    buildQuays(ctx);
    for (const e of this.roads.edges) {
      for (let i = 0; i + 1 < e.points.length; i++) {
        ground.paintSegment(e.points[i].x, e.points[i].z, e.points[i + 1].x, e.points[i + 1].z, e.width / 2, SURF.asphalt);
      }
    }
    buildRoads(ctx);
    buildRingBarriers(ctx);
    buildStreetLamps(ctx);
    lap('roads');
    buildTerrain(ctx);
    lap('terrain');
    buildTunnel(ctx);
    buildBridge(ctx);
    buildRamps(ctx);
    buildGarage(ctx);
    buildGuardRails(ctx);
    lap('structures');
    buildDistricts(ctx);
    lap('districts');
    this.breakers = new BreakerSystem(ctx, this.look.layers);
    this.breakers.build(sites);
    this.pursuitBreakers = this.breakers.list;

    this.tileInfos = tiles.build(this.look.layers, this.group);
    this.props.finalize(this.look.layers.static);
    this.group.add(this.props.group, this.breakers.group);
    this.buildGlobals();
    lap('meshes');

    this.landmarks = this.buildLandmarks();
    this.mapData = this.buildMapData();
    this.debug = {
      naturalHeight: (x, z) => this.core.hf.sampleNatural(x, z),
      allColliders: () => this.colliders.all(),
      timings,
      tileCount: this.tileInfos.length,
      propCount: this.props.records.length,
      lampCount: this.props.lamps.length,
    };
  }

  /** Base ground, water, sky and the two dim global lights. */
  private buildGlobals(): void {
    const b = new Batch('ground');
    b.color(COLORS.ground);
    const rect = (x0: number, z0: number, x1: number, z1: number) => flatQuad(b, (x0 + x1) / 2, -0.05, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, 0, true);
    rect(-456, -2600, BAY.minX, 2600);
    rect(BAY.minX, -2600, 2600, BAY.minZ);
    rect(-2600, -2600, -456, -1304);
    rect(-2600, 1304, -456, 2600);
    const base = new THREE.Mesh(b.toGeometry(), this.look.layers.ground);
    base.name = 'base ground';
    base.frustumCulled = false;
    const waterGeo = new THREE.PlaneGeometry(1960, 1960, 1, 1);
    waterGeo.rotateX(-Math.PI / 2);
    const uv = waterGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 40, uv.getY(i) * 40);
    const water = new THREE.Mesh(waterGeo, this.look.water);
    water.position.set(BAY.minX + 980, BAY.level, BAY.minZ + 980);
    water.name = 'bay';
    this.extraGeometries.push(base.geometry, waterGeo);
    const hemi = new THREE.HemisphereLight(0x46558f, 0x14121c, 0.6);
    const moon = new THREE.DirectionalLight(0x9fb4ff, 0.55);
    moon.position.set(-450, 500, -740);
    this.group.add(base, water, this.look.sky, hemi, moon, moon.target);
  }

  private buildMapData(): MapData {
    const H = RING.half;
    const P = (pts: number[][]) => pts.map(([x, z]) => ({ x, z }));
    const bridge: { x: number; z: number }[] = [];
    for (const side of [1, -1]) {
      const n = 24;
      for (let i = 0; i <= n; i++) {
        const k = side === 1 ? i : n - i;
        const p = ringPose(BRIDGE_S0 + (BRIDGE_LEN * k) / n);
        bridge.push({ x: p.x - p.dz * side * (RING.width / 2 + 2), z: p.z + p.dx * side * (RING.width / 2 + 2) });
      }
    }
    return {
      bounds: WORLD_BOUNDS,
      roads: this.roads.edges.map((e) => ({ points: e.points, width: e.width, kind: e.kind })),
      districts: [
        { id: 'downtown', name: DISTRICTS.downtown.name, color: DISTRICTS.downtown.color, polygon: P([[-450, -450], [450, -450], [450, 450], [-450, 450]]), labelX: 0, labelZ: -75 },
        { id: 'lantern', name: DISTRICTS.lantern.name, color: DISTRICTS.lantern.color, polygon: P([[-450, -H], [H, -H], [H, 450], [450, 450], [450, -450], [-450, -450]]), labelX: 675, labelZ: -640 },
        { id: 'docks', name: DISTRICTS.docks.name, color: DISTRICTS.docks.color, polygon: P([[-450, 450], [H, 450], [H, BAY.minZ], [BAY.minX, BAY.minZ], [BAY.minX, H], [-450, H]]), labelX: 80, labelZ: 800 },
        { id: 'hills', name: DISTRICTS.hills.name, color: DISTRICTS.hills.color, polygon: P([[-H, -H], [-450, -H], [-450, H], [-H, H]]), labelX: -800, labelZ: 60 },
        { id: 'highway', name: DISTRICTS.highway.name, color: DISTRICTS.highway.color, polygon: ringPolyline(40), labelX: 0, labelZ: -1160 },
      ],
      water: [P([[BAY.minX, BAY.minZ], [1300, BAY.minZ], [1300, 1300], [BAY.minX, 1300]])],
      tunnels: [P([[-H - 14, TUNNEL.zFrom], [-H + 14, TUNNEL.zFrom], [-H + 14, TUNNEL.zTo], [-H - 14, TUNNEL.zTo]])],
      bridges: [bridge],
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
      docksPier: { x: 770, z: 900, heading: -Math.PI / 2 },
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

  hitProp(collider: StaticCollider, vx: number, vz: number): void {
    this.props.hit(collider, vx, vz);
  }

  triggerBreaker(id: string, _dirX: number, _dirZ: number): boolean {
    return this.breakers.trigger(id);
  }

  resetDestructibles(): void {
    this.props.reset();
    this.breakers.reset();
  }

  update(dt: number, time: number, focus: THREE.Vector3): void {
    this.look.time.value = time;
    this.look.sky.position.copy(focus);
    const tiles = this.tileInfos;
    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const dx = tile.x - focus.x;
      const dz = tile.z - focus.z;
      const reach = HIDE_DISTANCE + tile.radius;
      tile.group.visible = dx * dx + dz * dz < reach * reach;
    }
    this.props.update(dt, focus);
    this.breakers.update(dt, focus.x, focus.z);
  }

  dispose(): void {
    for (const tile of this.tileInfos) {
      for (const m of tile.group.children) (m as THREE.Mesh).geometry.dispose();
    }
    for (const g of this.extraGeometries) g.dispose();
    this.props.dispose();
    this.breakers.dispose();
    this.look.dispose();
    this.group.clear();
  }
}

export function generateCity(seed = 20261): CityWorld {
  return new PortSelene(seed);
}
