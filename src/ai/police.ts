/* =============================================================================
 * APEX NOCTURNE — police: ambient patrols + wanted-level pursuits (heat 1–5).
 *
 * Units are real physics vehicles driven through VehicleHandle.input. The system
 * owns: vision / infractions, heat escalation and unit composition, pursuit
 * tactics (pursue / ram / pit / block / search), reinforcements, unit health,
 * pursuit breakers, roadblocks (barrier colliders + spike strips), the
 * helicopter and the evade / cooldown / bust gauges.
 * Pure logic, no allocation in update() except when units / roadblocks / events
 * are created.
 * ===========================================================================*/
import type {
  AIHost,
  BodyInfo,
  HelicopterState,
  InfractionKind,
  IPoliceSystem,
  PoliceKind,
  PoliceMode,
  PoliceUnit,
  PursuitEvent,
  PursuitState,
  PursuitStatus,
  RoadEdge,
  Roadblock,
  StaticCollider,
  TuningState,
  VehicleConfig,
  VehicleHandle,
} from '../core/types';
import { mulberry32 } from '../core/math';
import { POLICE_SPECS, STOCK_TUNING, maxedTuning } from '../game/catalog';
import { GRAVITY, castFeeler, clearInput, cornerSpeed, createPedalState, createSteerMemo, gripAt, steerToward, updatePedals } from './steering';
import type { PedalState, SteerMemo } from './steering';

/** Tunable constants of the police system. */
export const POLICE_TUNING = {
  /** engaged units per heat level (index = heat) */
  unitsPerHeat: [0, 2, 4, 5, 6, 8],
  maxUnits: 12,
  visionRange: 130,
  visionHalfAngle: Math.PI / 3,
  visionNear: 22,
  witnessRange: 45,
  spotDelay: 1.2,
  /** seconds per heat level from pursuit time alone */
  heatTime: 66,
  evadeTime: 8,
  bustTime: 3.5,
  bustSpeed: 12 / 3.6,
  bountyRate: 40,
  patrolMin: 150,
  patrolMax: 450,
  patrolRecycle: 550,
  spawnMin: 180,
  spawnMax: 350,
  despawnDist: 600,
  disabledLinger: 12,
  roadblockMin: 28,
  roadblockMax: 45,
  roadblockLife: 40,
  heliAltitude: 50,
  heliSpeed: 75,
  heliRange: 170,
};

const MAX_WP = 40;
const KIND_FRAGILITY: Record<PoliceKind, number> = { patrol: 1, interceptor: 1.35, suv: 0.6 };
const KIND_BOUNTY: Record<PoliceKind, number> = { patrol: 250, interceptor: 500, suv: 650 };
const INFRACTION_HEAT: Record<InfractionKind, number> = { speeding: 0.02, ramming: 0.07, property: 0.03, traffic: 0.05, racing: 0.015 };
const INFRACTION_BOUNTY: Record<InfractionKind, number> = { speeding: 60, ramming: 250, property: 90, traffic: 150, racing: 80 };

interface Unit extends PoliceUnit {
  config: VehicleConfig;
  steerMemo: SteerMemo;
  pedal: PedalState;
  /** waypoints (x, z pairs) of the current route */
  wp: Float32Array;
  wpN: number;
  wpI: number;
  navT: number;
  navNode: number;
  /** patrol: node we are driving to, edge we are on */
  patrolTo: number;
  patrolEdge: number;
  slot: number;
  stuckT: number;
  reverseT: number;
  disabledT: number;
  notified: boolean;
  roadblockId: number;
  leaving: boolean;
  directOk: boolean;
  holdT: number;
  /** route look-ahead point, start of the first leg, side of the last target (for reversing) */
  tx: number;
  tz: number;
  startX: number;
  startZ: number;
  lastSide: number;
  avoidT: number;
  avoidSide: number;
  wallCap: number;
  dist: number;
  tick: number;
}

interface Block extends Roadblock {
  colliders: StaticCollider[];
  age: number;
}

class PoliceSystem implements IPoliceSystem {
  readonly state: PursuitState = {
    status: 'idle',
    heat: 0,
    heatProgress: 0,
    bounty: 0,
    duration: 0,
    evadeProgress: 0,
    cooldownProgress: 0,
    bustProgress: 0,
    inSight: false,
    unitsEngaged: 0,
    unitsDisabled: 0,
    heliActive: false,
    infractions: { speeding: 0, ramming: 0, property: 0, traffic: 0 },
  };
  readonly units: Unit[] = [];
  readonly roadblocks: Block[] = [];
  readonly helicopter: HelicopterState = { active: false, x: 0, y: 0, z: 0, heading: 0, spotX: 0, spotZ: 0, seesPlayer: false };
  readonly events: PursuitEvent[] = [];

  private host: AIHost;
  private rng = mulberry32(0xc0ffee1);
  private enabled = false;
  private baseHeat = 1;
  private time = 0;
  private frame = 0;
  private configs = new Map<string, VehicleConfig>();
  private bodies: BodyInfo[] = [];
  // idle
  private spotT = -1;
  private graceT = 0;
  private patrolSpawnT = 2;
  // pursuit
  private spawnT = 0;
  private tacticT = 0;
  private rotation = 0;
  private roadblockT = 30;
  private nextBlockId = 1;
  private lastX = 0;
  private lastZ = 0;
  private lastVx = 0;
  private lastVz = 0;
  private unseenT = 0;
  private knownX = 0;
  private knownZ = 0;
  private infractionCd: Record<InfractionKind, number> = { speeding: 0, ramming: 0, property: 0, traffic: 0, racing: 0 };
  // helicopter: 0 off, 1 on station, 2 leaving
  private heliPhase = 0;
  private heliT = 0;
  private heliVx = 0;
  private heliVz = 0;
  private heliSweep = 0;
  // spike test: previous wheel positions of the player
  private wheelPrev = new Float32Array(8);
  private wheelNow = new Float32Array(8);
  private wheelsValid = false;
  // roadblock prediction scratch
  private rbX = 0;
  private rbZ = 0;
  private rbH = 0;
  private rbEdge: RoadEdge | null = null;
  private scratch = new Float32Array(MAX_WP * 2);

  constructor(host: AIHost) {
    this.host = host;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  setEnabled(enabled: boolean): void {
    if (!enabled) this.dropEverything();
    this.enabled = enabled;
  }

  setBaseHeat(heat: number): void {
    const h = Math.round(heat);
    this.baseHeat = h < 1 ? 1 : h > 5 ? 5 : h;
  }

  reset(): void {
    this.dropEverything();
  }

  reportInfraction(kind: InfractionKind, severity = 1): void {
    if (!this.enabled) return;
    const s = this.state;
    const sev = severity < 0.1 ? 0.1 : severity > 2 ? 2 : severity;
    if (s.status === 'idle') {
      if (this.graceT > 0 || this.spotT >= 0) return;
      // only counts when a unit witnesses it
      let witness = false;
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (u.mode === 'disabled' || u.leaving) continue;
        if (u.seesPlayer || u.dist < POLICE_TUNING.witnessRange) witness = true;
      }
      if (!witness) return;
      this.events.push({ type: 'spotted', reason: kind });
      this.spotT = POLICE_TUNING.spotDelay;
      this.countInfraction(kind);
      return;
    }
    // pursuit / cooldown: adds heat and bounty (rate limited per kind — some are reported every frame)
    if (this.infractionCd[kind] > 0) return;
    this.infractionCd[kind] = kind === 'speeding' || kind === 'racing' ? 3 : 0.6;
    this.countInfraction(kind);
    s.heatProgress += INFRACTION_HEAT[kind] * sev;
    s.bounty += INFRACTION_BOUNTY[kind] * sev * (s.heat > 0 ? s.heat : 1);
  }

  notifyPoliceHit(handle: VehicleHandle, intensity: number): void {
    if (!this.enabled) return;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.handle !== handle) continue;
      u.notified = true;
      this.damage(u, intensity, false);
      break;
    }
    if (this.state.status === 'idle' && intensity > 3 && this.graceT <= 0) this.startPursuit();
  }

  update(dt: number): void {
    if (!this.enabled || dt <= 0) return;
    const T = POLICE_TUNING;
    const s = this.state;
    const world = this.host.world;
    const pst = this.host.player.vehicle.state;
    this.time += dt;
    this.frame++;
    if (this.graceT > 0) this.graceT -= dt;
    this.infractionCd.speeding -= dt;
    this.infractionCd.ramming -= dt;
    this.infractionCd.property -= dt;
    this.infractionCd.traffic -= dt;
    this.infractionCd.racing -= dt;

    // --- unit bookkeeping: damage from own impacts, vision, breakers
    let anySees = false;
    let nearest = 999;
    let near9 = 0;
    let near15 = 0;
    let engaged = 0;
    const breakers = world.pursuitBreakers;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      const h = u.handle;
      if (!h.alive) {
        this.units.splice(i, 1);
        continue;
      }
      const st = h.vehicle.state;
      u.tick++;
      const dx = pst.x - st.x;
      const dz = pst.z - st.z;
      u.dist = Math.sqrt(dx * dx + dz * dz);
      if (u.mode !== 'disabled') {
        // own impacts (walls, traffic, other cars); player hits were already notified by the engine
        const ev = h.vehicle.events;
        for (let k = 0; k < ev.length; k++) {
          const e = ev[k];
          if (e.type !== 'impact' || e.intensity < 2.5) continue;
          if (e.collider === null && u.notified) continue;
          this.damage(u, e.intensity * (e.collider ? 0.8 : 0.6), false);
        }
        for (let k = 0; k < breakers.length; k++) {
          const b = breakers[k];
          if (!b.dangerActive || (u.mode as PoliceMode) === 'disabled') continue;
          const bx = st.x - b.danger.x;
          const bz = st.z - b.danger.z;
          if (bx * bx + bz * bz < b.danger.radius * b.danger.radius) this.disable(u, true);
        }
      }
      u.notified = false;
      if ((u.mode as PoliceMode) === 'disabled') {
        u.seesPlayer = false;
        u.disabledT += dt;
        clearInput(h.input);
        h.input.brake = 1;
        h.input.handbrake = true;
        if (u.disabledT > T.disabledLinger && this.hidden(st.x, st.z)) this.removeUnit(i);
        continue;
      }
      // vision (line of sight refreshed every 3rd frame per unit)
      if ((u.tick + i) % 3 === 0) {
        let sees = false;
        if (u.dist < T.visionRange) {
          let inCone = u.dist < T.visionNear;
          if (!inCone) {
            const c = (dx * Math.sin(st.heading) + dz * Math.cos(st.heading)) / (u.dist > 0.01 ? u.dist : 0.01);
            inCone = c > Math.cos(T.visionHalfAngle);
          }
          if (inCone) sees = world.lineOfSight(st.x, st.z, pst.x, pst.z);
        }
        u.seesPlayer = sees;
        // a direct chase also needs a clear run to where the player will be in a moment
        u.directOk = sees && u.dist < 95 && world.lineOfSight(st.x, st.z, pst.x + pst.vx * 0.9, pst.z + pst.vz * 0.9);
      } else if (u.seesPlayer && u.dist > T.visionRange) {
        // stale result (teleport, very fast player): out of range is out of sight
        u.seesPlayer = false;
        u.directOk = false;
      }
      if (u.leaving) continue;
      if (u.seesPlayer) anySees = true;
      if (u.mode !== 'roadblock' && u.mode !== 'patrol') engaged++;
      if (u.dist < nearest) nearest = u.dist;
      if (u.dist < 9) near9++;
      if (u.dist < 15) near15++;
    }

    this.updateHelicopter(dt);
    if (this.helicopter.active && this.helicopter.seesPlayer) anySees = true;
    s.inSight = anySees;
    s.heliActive = this.helicopter.active;
    s.unitsEngaged = engaged;
    if (anySees) {
      this.lastX = pst.x;
      this.lastZ = pst.z;
      this.lastVx = pst.vx;
      this.lastVz = pst.vz;
      this.unseenT = 0;
    } else {
      this.unseenT += dt;
    }
    // where the units believe the player is: exact while seen, dead reckoning (≤ 4 s) afterwards
    {
      const k = this.unseenT < 4 ? this.unseenT : 4;
      this.knownX = this.lastX + this.lastVx * k;
      this.knownZ = this.lastZ + this.lastVz * k;
    }

    // --- status machine
    if (s.status === 'idle') {
      s.inSight = false;
      if (this.spotT >= 0) {
        this.spotT -= dt;
        if (this.spotT < 0) this.startPursuit();
      }
      this.updateAmbient(dt);
    } else {
      s.duration += dt;
      const speed = Math.hypot(pst.vx, pst.vz);
      // bust gauge
      if (speed < T.bustSpeed && (near9 >= 1 || near15 >= 2)) s.bustProgress += dt / T.bustTime;
      else s.bustProgress -= dt / (T.bustTime * 2);
      if (s.bustProgress < 0) s.bustProgress = 0;
      if (s.bustProgress >= 1) {
        this.endPursuit(true);
      } else if (s.status === 'pursuit') {
        s.bounty += T.bountyRate * s.heat * dt;
        s.heatProgress += dt / T.heatTime;
        if (s.heat < 5) {
          if (s.heatProgress >= 1) {
            s.heatProgress -= 1;
            s.heat++;
            this.events.push({ type: 'heatUp', heat: s.heat });
          }
        } else if (s.heatProgress > 1) s.heatProgress = 1;
        if (anySees) s.evadeProgress -= (3 * dt) / T.evadeTime;
        else {
          let k = 1 + (nearest - 120) / 100;
          k = k < 1 ? 1 : k > 2 ? 2 : k;
          s.evadeProgress += (k * dt) / T.evadeTime;
        }
        if (s.evadeProgress < 0) s.evadeProgress = 0;
        if (s.evadeProgress >= 1) {
          s.evadeProgress = 1;
          s.status = 'cooldown';
          s.cooldownProgress = 0;
          this.events.push({ type: 'cooldownStart' });
          for (let i = 0; i < this.units.length; i++) {
            const u = this.units[i];
            if (this.isChaser(u)) {
              u.mode = 'search';
              u.navT = 0;
            }
          }
        }
      } else {
        // cooldown
        if (anySees) {
          s.status = 'pursuit';
          s.evadeProgress = 0;
          s.cooldownProgress = 0;
          this.events.push({ type: 'lostCooldown' });
          for (let i = 0; i < this.units.length; i++) if (this.units[i].mode === 'search') this.units[i].mode = 'pursue';
          this.tacticT = 0;
        } else {
          s.cooldownProgress += dt / (12 + 3 * s.heat);
          if (s.cooldownProgress >= 1) this.endPursuit(false);
        }
      }
      if ((s.status as PursuitStatus) !== 'idle') {
        this.updateReinforcements(dt, engaged);
        this.updateTactics(dt, speed);
        this.updateRoadblocks(dt, speed);
      }
    }
    this.updateSpikes();

    // --- drive every unit
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.mode === 'disabled' || !u.handle.alive) continue;
      this.driveUnit(u, i, dt);
    }
  }

  // ---------------------------------------------------------------------------
  // Pursuit life cycle
  // ---------------------------------------------------------------------------

  private countInfraction(kind: InfractionKind): void {
    const inf = this.state.infractions;
    if (kind === 'speeding' || kind === 'racing') inf.speeding++;
    else if (kind === 'ramming') inf.ramming++;
    else if (kind === 'property') inf.property++;
    else inf.traffic++;
  }

  private startPursuit(): void {
    const s = this.state;
    if (s.status !== 'idle') return;
    const pst = this.host.player.vehicle.state;
    s.status = 'pursuit';
    s.heat = this.baseHeat;
    s.heatProgress = 0;
    s.bounty = 0;
    s.duration = 0;
    s.evadeProgress = 0;
    s.cooldownProgress = 0;
    s.bustProgress = 0;
    s.unitsDisabled = 0;
    this.spotT = -1;
    this.spawnT = 1.5;
    this.tacticT = 0;
    this.roadblockT = POLICE_TUNING.roadblockMin * (0.6 + 0.5 * this.rng());
    this.heliT = 6;
    this.lastX = pst.x;
    this.lastZ = pst.z;
    this.lastVx = pst.vx;
    this.lastVz = pst.vz;
    this.knownX = pst.x;
    this.knownZ = pst.z;
    this.unseenT = 0;
    this.events.push({ type: 'pursuitStart', heat: s.heat });
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.mode === 'disabled') continue;
      u.leaving = false;
      u.holdT = 0;
      u.mode = 'pursue';
      u.sirenOn = true;
      u.navT = 0;
    }
  }

  private endPursuit(busted: boolean): void {
    const s = this.state;
    const bounty = Math.round(s.bounty);
    if (busted) this.events.push({ type: 'busted', bounty, duration: s.duration, heat: s.heat });
    else this.events.push({ type: 'evaded', bounty, duration: s.duration, heat: s.heat });
    s.status = 'idle';
    s.heat = 0;
    s.heatProgress = 0;
    s.evadeProgress = 0;
    s.cooldownProgress = 0;
    s.bustProgress = 0;
    s.inSight = false;
    this.graceT = busted ? 12 : 8;
    this.spotT = -1;
    this.patrolSpawnT = 20;
    this.removeRoadblocks();
    // units stand down: stop next to the busted player, or drive away and vanish out of sight
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.mode === 'disabled') continue;
      u.mode = 'patrol';
      u.leaving = true;
      u.sirenOn = busted;
      u.holdT = busted ? 8 : 0;
      u.wpN = 0;
      u.patrolTo = -1;
      u.roadblockId = -1;
    }
    if (this.heliPhase === 1) this.heliPhase = 2;
  }

  /** setEnabled(false) / reset(): silently remove everything. */
  private dropEverything(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const h = this.units[i].handle;
      if (h.alive) this.host.despawnVehicle(h);
    }
    this.units.length = 0;
    this.removeRoadblocks();
    this.events.length = 0;
    const s = this.state;
    s.status = 'idle';
    s.heat = 0;
    s.heatProgress = 0;
    s.bounty = 0;
    s.duration = 0;
    s.evadeProgress = 0;
    s.cooldownProgress = 0;
    s.bustProgress = 0;
    s.inSight = false;
    s.unitsEngaged = 0;
    s.unitsDisabled = 0;
    s.heliActive = false;
    s.infractions.speeding = 0;
    s.infractions.ramming = 0;
    s.infractions.property = 0;
    s.infractions.traffic = 0;
    this.helicopter.active = false;
    this.helicopter.seesPlayer = false;
    this.heliPhase = 0;
    this.heliT = 0;
    this.spotT = -1;
    this.graceT = 0;
    this.patrolSpawnT = 2;
    this.wheelsValid = false;
  }

  // ---------------------------------------------------------------------------
  // Units
  // ---------------------------------------------------------------------------

  private isChaser(u: Unit): boolean {
    return u.mode !== 'disabled' && u.mode !== 'roadblock' && !u.leaving;
  }

  private configFor(kind: PoliceKind, heat: number): VehicleConfig {
    const level = heat >= 4 ? 2 : heat >= 3 ? 1 : 0;
    const key = kind + level;
    let c = this.configs.get(key);
    if (!c) {
      const tuning: TuningState = level === 0 ? STOCK_TUNING : maxedTuning(level as 1 | 2);
      c = this.host.buildConfig(POLICE_SPECS[kind], tuning);
      this.configs.set(key, c);
    }
    return c;
  }

  private spawnUnit(kind: PoliceKind, x: number, z: number, heading: number, mode: PoliceMode, speed: number): Unit {
    const heat = this.state.heat > 0 ? this.state.heat : 1;
    const config = this.configFor(kind, heat);
    const handle = this.host.spawnVehicle(config, x, z, heading, { type: 'police', kind });
    handle.disabled = false;
    handle.vehicle.manualGearbox = false;
    handle.vehicle.holdAtLine = false;
    if (speed > 0) handle.vehicle.reset(x, z, heading, speed);
    clearInput(handle.input);
    const u: Unit = {
      handle,
      kind,
      mode,
      sirenOn: mode !== 'patrol',
      seesPlayer: false,
      health: 1,
      config,
      steerMemo: createSteerMemo(config),
      pedal: createPedalState(),
      wp: new Float32Array(MAX_WP * 2),
      wpN: 0,
      wpI: 0,
      navT: 0,
      navNode: -1,
      patrolTo: -1,
      patrolEdge: -1,
      slot: this.units.length,
      stuckT: 0,
      reverseT: 0,
      disabledT: 0,
      notified: false,
      roadblockId: -1,
      leaving: false,
      directOk: false,
      holdT: 0,
      tx: x,
      tz: z,
      startX: x,
      startZ: z,
      lastSide: 1,
      avoidT: 0,
      avoidSide: 0,
      wallCap: 999,
      dist: 999,
      tick: Math.floor(this.rng() * 8),
    };
    this.units.push(u);
    return u;
  }

  private removeUnit(index: number): void {
    const u = this.units[index];
    if (u.handle.alive) this.host.despawnVehicle(u.handle);
    this.units.splice(index, 1);
  }

  private damage(u: Unit, intensity: number, byBreaker: boolean): void {
    if (u.mode === 'disabled') return;
    u.health -= (intensity / 45) * KIND_FRAGILITY[u.kind];
    if (u.health <= 0) this.disable(u, byBreaker);
  }

  private disable(u: Unit, byBreaker: boolean): void {
    if (u.mode === 'disabled') return;
    const s = this.state;
    u.health = 0;
    u.mode = 'disabled';
    u.sirenOn = false;
    u.seesPlayer = false;
    u.disabledT = 0;
    u.handle.disabled = true;
    clearInput(u.handle.input);
    u.handle.input.brake = 1;
    if (s.status !== 'idle') {
      const bounty = KIND_BOUNTY[u.kind] * (s.heat > 0 ? s.heat : 1) * (byBreaker ? 2 : 1);
      s.unitsDisabled++;
      s.bounty += bounty;
      s.heatProgress += 0.18;
      this.events.push({ type: 'unitDisabled', kind: u.kind, bounty, byBreaker });
    }
  }

  /** Not visible from the camera (far away, or behind buildings). */
  private hidden(x: number, z: number): boolean {
    const cam = this.host.getCameraPosition();
    const dx = x - cam.x;
    const dz = z - cam.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 240 * 240) return true;
    if (d2 < 45 * 45) return false;
    return !this.host.world.lineOfSight(cam.x, cam.z, x, z);
  }

  /**
   * Picks a road node between minD and maxD from the player, preferably ahead of its travel
   * direction and hidden from the camera. Returns the node id or -1.
   */
  private pickSpawnNode(minD: number, maxD: number): number {
    const roads = this.host.world.roads;
    const nodes = roads.nodes;
    const pst = this.host.player.vehicle.state;
    // around where the police believe the player is (its real position while idle / in sight)
    const pursuing = this.state.status !== 'idle';
    const cx = pursuing ? this.knownX : pst.x;
    const cz = pursuing ? this.knownZ : pst.z;
    const vx = pursuing ? this.lastVx : pst.vx;
    const vz = pursuing ? this.lastVz : pst.vz;
    const sp = Math.hypot(vx, vz);
    let best = -1;
    let second = -1;
    let bestScore = -1e9;
    let secondScore = -1e9;
    const start = Math.floor(this.rng() * nodes.length);
    for (let k = 0; k < nodes.length; k++) {
      const n = nodes[(start + k) % nodes.length];
      const dx = n.x - cx;
      const dz = n.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minD * minD || d2 > maxD * maxD || n.edges.length === 0) continue;
      let score = this.rng();
      if (sp > 4) score += ((dx * vx + dz * vz) / (Math.sqrt(d2) * sp)) * 1.5;
      if (score > bestScore) {
        second = best;
        secondScore = bestScore;
        best = n.id;
        bestScore = score;
      } else if (score > secondScore) {
        second = n.id;
        secondScore = score;
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      const id = pass === 0 ? best : second;
      if (id < 0) continue;
      const n = nodes[id];
      if (!this.hidden(n.x, n.z)) continue;
      if (this.host.queryBodies(n.x, n.z, 12, this.bodies) > 0) continue;
      return id;
    }
    return -1;
  }

  /** Spawns a unit on a node, facing the first step of the road path toward the player. */
  private spawnAtNode(nodeId: number, kind: PoliceKind, mode: PoliceMode): Unit {
    const roads = this.host.world.roads;
    const pst = this.host.player.vehicle.state;
    const n = roads.nodes[nodeId];
    const pursuing = this.state.status !== 'idle';
    const gx = pursuing ? this.knownX : pst.x;
    const gz = pursuing ? this.knownZ : pst.z;
    let heading = Math.atan2(gx - n.x, gz - n.z);
    const target = roads.nearestNode(gx, gz);
    const path = roads.findPath(nodeId, target.id);
    if (path.length >= 2) {
      const nx = roads.nodes[path[1]];
      heading = Math.atan2(nx.x - n.x, nx.z - n.z);
    } else if (n.edges.length > 0) {
      const e = roads.edges[n.edges[0]];
      const o = roads.nodes[e.a === nodeId ? e.b : e.a];
      heading = Math.atan2(o.x - n.x, o.z - n.z);
    }
    return this.spawnUnit(kind, n.x, n.z, heading, mode, mode === 'patrol' ? 8 : 16);
  }

  // ---------------------------------------------------------------------------
  // Ambient patrols (idle)
  // ---------------------------------------------------------------------------

  private updateAmbient(dt: number): void {
    const T = POLICE_TUNING;
    let patrols = 0;
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.mode === 'disabled') continue;
      const st = u.handle.vehicle.state;
      if (u.leaving) {
        if (u.holdT > 0) continue;
        if (u.dist > 110 && this.hidden(st.x, st.z)) this.removeUnit(i);
        else if (u.dist > T.patrolRecycle) this.removeUnit(i);
        continue;
      }
      if (u.dist > T.patrolRecycle) {
        this.removeUnit(i);
        continue;
      }
      patrols++;
    }
    this.patrolSpawnT -= dt;
    if (patrols < 2 && this.patrolSpawnT <= 0 && this.units.length < T.maxUnits) {
      this.patrolSpawnT = patrols === 0 ? 3 : 14;
      const id = this.pickSpawnNode(T.patrolMin, T.patrolMax);
      if (id >= 0) this.spawnAtNode(id, 'patrol', 'patrol');
      else this.patrolSpawnT = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Reinforcements & tactics (pursuit)
  // ---------------------------------------------------------------------------

  private updateReinforcements(dt: number, engaged: number): void {
    const T = POLICE_TUNING;
    const s = this.state;
    // far-away units are dropped (and replaced)
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u.mode === 'disabled' || u.mode === 'roadblock') continue;
      if (u.dist > T.despawnDist) this.removeUnit(i);
    }
    if (s.status !== 'pursuit') return;
    this.spawnT -= dt;
    const want = T.unitsPerHeat[s.heat];
    if (engaged >= want || this.spawnT > 0 || this.units.length >= T.maxUnits) return;
    this.spawnT = 6.5 - s.heat * 0.9;
    // kind: the most under-represented one for this heat
    let patrol = 0;
    let inter = 0;
    let suv = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!this.isChaser(u)) continue;
      if (u.kind === 'patrol') patrol++;
      else if (u.kind === 'interceptor') inter++;
      else suv++;
    }
    const wantInter = s.heat >= 5 ? 4 : s.heat >= 3 ? 2 : 0;
    const wantSuv = s.heat >= 5 ? 3 : s.heat >= 4 ? 2 : 0;
    let kind: PoliceKind = 'patrol';
    if (inter < wantInter && inter - wantInter <= suv - wantSuv) kind = 'interceptor';
    else if (suv < wantSuv) kind = 'suv';
    else if (patrol >= want - wantInter - wantSuv && inter < wantInter) kind = 'interceptor';
    const id = this.pickSpawnNode(T.spawnMin, T.spawnMax);
    if (id < 0) {
      this.spawnT = 0.7;
      return;
    }
    this.spawnAtNode(id, kind, 'pursue');
  }

  /** Rotates the roles so that units do not all do the same thing. */
  private updateTactics(dt: number, playerSpeed: number): void {
    const s = this.state;
    if (s.status !== 'pursuit') return;
    this.tacticT -= dt;
    if (this.tacticT > 0) return;
    this.tacticT = 5 + 3 * this.rng();
    this.rotation++;
    let near = 0;
    for (let i = 0; i < this.units.length; i++) if (this.isChaser(this.units[i]) && this.units[i].dist < 40) near++;
    const boxIn = playerSpeed < 9 && near >= (s.heat === 1 ? 2 : 3);
    let slot = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!this.isChaser(u)) continue;
      u.slot = slot;
      const r = (slot + this.rotation) % 3;
      slot++;
      let mode: PoliceMode;
      if (boxIn) mode = 'block';
      else if (s.heat <= 1) mode = 'pursue';
      else if (s.heat === 2) mode = r === 0 ? 'pursue' : 'ram';
      else if (u.kind === 'interceptor') mode = r === 0 ? 'block' : s.heat >= 4 && r === 1 ? 'pit' : 'ram';
      else if (u.kind === 'suv') mode = r === 0 ? 'pit' : 'ram';
      else mode = r === 0 ? 'ram' : r === 1 ? 'pursue' : s.heat >= 3 ? 'block' : 'ram';
      u.mode = mode;
    }
  }

  // ---------------------------------------------------------------------------
  // Driving
  // ---------------------------------------------------------------------------

  private driveUnit(u: Unit, index: number, dt: number): void {
    const s = this.state;
    const h = u.handle;
    const st = h.vehicle.state;
    const input = h.input;
    const pst = this.host.player.vehicle.state;
    input.shiftUp = false;
    input.shiftDown = false;
    input.nitro = false;

    if (u.mode === 'roadblock' || u.holdT > 0) {
      if (u.holdT > 0) u.holdT -= dt;
      input.throttle = 0;
      input.steer = 0;
      input.brake = 1;
      input.handbrake = true;
      return;
    }
    input.handbrake = false;

    // power: catch-up when far behind, a little more with heat
    const heat = s.heat;
    let power = 1 + 0.02 * heat;
    if (s.status === 'pursuit' && u.dist > 150) power += 0.3 * (u.dist > 400 ? 1 : (u.dist - 150) / 250);
    h.vehicle.powerScale = power;
    h.vehicle.gripScale = 1 + 0.02 * heat;

    // stuck => reverse out
    const boxing = u.mode === 'block' && u.dist < 14;
    if (u.reverseT > 0) {
      u.reverseT -= dt;
      input.throttle = 0;
      input.brake = 1;
      // swing the nose toward the side of the target while backing up
      input.steer = st.speed > 0.5 ? 0 : -u.lastSide;
      u.steerMemo.last = input.steer;
      if (u.reverseT <= 0) u.pedal.phase = 0;
      return;
    }
    if (Math.abs(st.speed) < 1.5 && !boxing) u.stuckT += dt;
    else u.stuckT = 0;
    if (u.stuckT > 1.5) {
      u.stuckT = 0;
      u.reverseT = 1.6;
      return;
    }

    let tx: number;
    let tz: number;
    let want: number;
    let ramming = false;

    if (u.mode === 'patrol') {
      this.patrolRoute(u);
      const e = u.patrolEdge >= 0 ? this.host.world.roads.edges[u.patrolEdge] : null;
      want = (e ? e.speedLimitKmh / 3.6 : 13) * (u.leaving ? 1.05 : 0.85);
      want = this.followRoute(u, want);
      tx = u.tx;
      tz = u.tz;
    } else {
      // pursuit modes
      const searching = u.mode === 'search';
      const direct = !searching && (u.directOk || u.dist < 26);
      if (direct) {
        u.wpN = 0;
        u.navT = 0;
        const pv = Math.hypot(pst.vx, pst.vz);
        const pfx = Math.sin(pst.heading);
        const pfz = Math.cos(pst.heading);
        const own = st.speed > 12 ? st.speed : 12;
        let lead = u.dist / own;
        if (lead > 1.1) lead = 1.1;
        // relative position in the player's frame
        const rx = st.x - pst.x;
        const rz = st.z - pst.z;
        const along = rx * pfx + rz * pfz;
        const side = -rx * pfz + rz * pfx;
        const pw = this.host.player.vehicle.config.width * 0.5 + u.config.width * 0.5;
        tx = pst.x + pst.vx * lead;
        tz = pst.z + pst.vz * lead;
        want = pv + 14;
        if (u.mode === 'pursue') {
          // tail: sit a few metres behind the bumper
          let close = (u.dist - (5.5 + (pv > 17 ? 3.5 : pv * 0.2))) * 0.5;
          if (close > 12) close = 12;
          want = pv + close;
        } else if (u.mode === 'ram') {
          // draw alongside, then swerve in
          ramming = true;
          if (along < -5) {
            const sd = side >= 0 ? 1 : -1;
            tx += -pfz * sd * (pw + 0.9);
            tz += pfx * sd * (pw + 0.9);
          }
          want = pv + 16;
        } else if (u.mode === 'pit') {
          // front corner beside the player's rear quarter, then steer into it
          const sd = side >= 0 ? 1 : -1;
          const qx = pst.x - pfx * 1.2 + -pfz * sd * (pw + 0.5);
          const qz = pst.z - pfz * 1.2 + pfx * sd * (pw + 0.5);
          const dq = Math.hypot(qx - st.x, qz - st.z);
          ramming = true;
          if (dq > 3.2 || along < -4.5) {
            tx = qx + pst.vx * lead;
            tz = qz + pst.vz * lead;
            want = pv + (along < -1 ? 9 + dq : 2);
          } else {
            tx = pst.x + pfx * 3 + pst.vx * 0.2;
            tz = pst.z + pfz * 3 + pst.vz * 0.2;
            want = pv + 5;
          }
        } else {
          // block: overtake and brake in front; box a slow player in
          if (pv < 9) {
            const a = (u.slot % 4) * (Math.PI / 2) + Math.PI / 4;
            const bx = pst.x + (pfx * Math.cos(a) - pfz * Math.sin(a)) * 5.5;
            const bz = pst.z + (pfz * Math.cos(a) + pfx * Math.sin(a)) * 5.5;
            tx = bx;
            tz = bz;
            const db = Math.hypot(bx - st.x, bz - st.z);
            want = db < 2.5 ? 0 : 3 + db * 0.9;
            ramming = true;
          } else if (along < 7) {
            const sd = side >= 0 ? 1 : -1;
            tx = pst.x + pfx * (14 + pv * 0.5) + -pfz * sd * (along < -4 ? pw + 1 : 0);
            tz = pst.z + pfz * (14 + pv * 0.5) + pfx * sd * (along < -4 ? pw + 1 : 0);
            want = pv + 15;
          } else {
            tx = pst.x + pfx * (along + 12);
            tz = pst.z + pfz * (along + 12);
            want = pv > 8 ? pv - 7 : 1;
          }
        }
        // the player is turning away: be slow enough at its turning point to follow it round
        // (not for head-on rams at high heat)
        if (pv > 3 && !(u.mode === 'ram' && heat >= 4)) {
          let cs = (Math.sin(st.heading) * pst.vx + Math.cos(st.heading) * pst.vz) / pv;
          if (cs < 0.95) {
            if (cs < -0.98) cs = -0.98;
            let radius = 9 / Math.tan(Math.acos(cs) * 0.5);
            if (radius < 5) radius = 5;
            const vc2 = gripAt(u.config, 1, st.speed) * GRAVITY * 0.8 * radius;
            const room = u.dist - 10;
            const lim = Math.sqrt(vc2 + 2 * u.config.brakeDecel * 0.6 * (room > 0 ? room : 0));
            if (lim < want) want = lim;
          }
        }
        if (want < 0) want = 0;
        // heat 1: cautious, no contact
        if (heat <= 1 && u.dist < 8 && want > pv) want = pv;
      } else {
        // road navigation toward the player / the last known position
        u.navT -= dt;
        // (radio contact: chasers home in on the player's road node; searching units only know the last sighting)
        const gx = searching ? this.lastX : this.knownX;
        const gz = searching ? this.lastZ : this.knownZ;
        if (u.navT <= 0 || u.wpN === 0 || u.wpI >= u.wpN) this.planRoute(u, gx, gz, searching);
        want = this.followRoute(u, searching ? 22 : 80);
        tx = u.tx;
        tz = u.tz;
      }
    }
    this.driveToward(u, index, tx, tz, want, ramming, dt);
  }

  /** Low-level control toward a point at a desired speed, with wall / water / body avoidance. */
  private driveToward(u: Unit, index: number, tx: number, tz: number, want: number, ramming: boolean, dt: number): void {
    const world = this.host.world;
    const h = u.handle;
    const st = h.vehicle.state;
    const input = h.input;
    const cfg = u.config;
    const v = st.speed > 0 ? st.speed : 0;
    const fx = Math.sin(st.heading);
    const fz = Math.cos(st.heading);
    const halfW = cfg.width * 0.5;
    const halfL = cfg.length * 0.5;
    const grip = gripAt(cfg, h.vehicle.gripScale, v);
    const aLat = grip * GRAVITY * 0.85;
    const aBrake = cfg.brakeDecel * 0.75;

    // --- static obstacles & water (staggered: every other frame)
    const tlf = (tx - st.x) * fx + (tz - st.z) * fz;
    const tlr = -(tx - st.x) * fz + (tz - st.z) * fx;
    // target beside / behind: we are turning hard on purpose, only watch the nose
    const hardTurn = tlf < Math.abs(tlr) * 0.3;
    if (((u.tick + index) & 1) === 0) {
      const len = hardTurn ? halfL + 3 + v * 0.3 : 6 + v * 0.6;
      let hit = castFeeler(world, st.x, st.z, fx, fz, len, halfW + 0.3, st.y);
      if (hit >= len && world.getSurface(st.x + fx * len, st.z + fz * len) === 'water') hit = len * 0.6;
      if (hit < len) {
        const room = hit - halfL - 1.5;
        u.wallCap = Math.sqrt(2 * aBrake * (room > 0 ? room : 0)) + 2;
        if (!hardTurn) {
          // which side is freer? (right = heading - 0.55: turning right decreases the heading)
          const c = Math.cos(0.55);
          const sn = Math.sin(0.55);
          const rdx = fx * c - fz * sn;
          const rdz = fz * c + fx * sn;
          const ldx = fx * c + fz * sn;
          const ldz = fz * c - fx * sn;
          let right = castFeeler(world, st.x, st.z, rdx, rdz, len, halfW, st.y);
          let left = castFeeler(world, st.x, st.z, ldx, ldz, len, halfW, st.y);
          if (world.getSurface(st.x + rdx * len, st.z + rdz * len) === 'water') right *= 0.3;
          if (world.getSurface(st.x + ldx * len, st.z + ldz * len) === 'water') left *= 0.3;
          // prefer the side of the target when both are similar
          if (Math.abs(right - left) < 1.5) u.avoidSide = tlr >= 0 ? 1 : -1;
          else u.avoidSide = right > left ? 1 : -1;
          u.avoidT = 0.3;
        } else if (u.avoidSide === 0) {
          u.avoidSide = tlr >= 0 ? 1 : -1;
        }
      } else {
        u.wallCap = 999;
      }
    }
    if (u.wallCap < want) want = u.wallCap;
    if (u.avoidT > 0) {
      u.avoidT -= dt;
      // steer around: aim at a point on the free side
      const sd = u.avoidSide;
      tx = st.x + fx * 8 + -fz * sd * 6;
      tz = st.z + fz * 8 + fx * sd * 6;
    } else if (hardTurn && want > 7) {
      want = 7; // U-turn / tight turn: keep it slow so the turning circle stays small
    }
    u.lastSide = tlr >= 0 ? 1 : -1;

    // --- other vehicles in the corridor ahead (never brake for the player when attacking)
    const reach = 8 + v * 0.9;
    const n = this.host.queryBodies(st.x + fx * reach * 0.5, st.z + fz * reach * 0.5, reach * 0.5 + 4, this.bodies);
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i];
      if (b.handle === h) continue;
      if (b.type === 'player' && ramming) continue;
      const dx = b.x - st.x;
      const dz = b.z - st.z;
      const df = dx * fx + dz * fz;
      if (df <= 0) continue;
      const dl = -dx * fz + dz * fx;
      const clear = halfW + b.halfWidth + 0.5;
      if (dl > clear + 1.2 || dl < -(clear + 1.2)) continue;
      const gap = df - halfL - b.halfLength;
      const vb = b.vx * fx + b.vz * fz;
      // nudge the aim away from it
      const sd = dl >= 0 ? -1 : 1;
      const push = (clear + 1.2 - Math.abs(dl)) * 1.5;
      tx += -fz * sd * push;
      tz += fx * sd * push;
      if (dl < clear && dl > -clear) {
        const keep = b.type === 'player' ? 4 : 2.5;
        const lim = (vb > 0 ? vb : 0) + (gap - keep) * 1.1;
        if (lim < want) want = lim;
      }
    }
    if (want < 0) want = 0;

    // --- steering + speed for the arc we are asking for
    input.steer = steerToward(st, cfg, u.steerMemo, tx, tz, 1, aLat, dt);
    // target behind while still fast: brake in a straight line first, then turn on the spot
    if (tlf < 0 && v > 9 && u.avoidT <= 0) {
      input.steer *= 0.25;
      u.steerMemo.last = input.steer;
    }
    const dx = tx - st.x;
    const dz = tz - st.z;
    let k = (2 * (-dx * fz + dz * fx)) / (dx * dx + dz * dz + 1e-6);
    if (k < 0) k = -k;
    const vArc = cornerSpeed(cfg, 0.8, h.vehicle.gripScale, k * 0.8);
    if (vArc < want) want = vArc < 6 ? 6 : vArc;
    const latUse = Math.abs(st.speed * st.yawRate) / (grip * GRAVITY);
    updatePedals(u.pedal, st.speed, want, latUse, dt);
    let throttle = u.pedal.throttle;
    const slip = st.speed > 6 ? Math.abs(Math.atan2(st.lateralSpeed, st.speed)) : 0;
    if (slip > 0.14) {
      const cut = 1 - Math.min(0.85, (slip - 0.14) * 3.2);
      if (throttle > cut) throttle = cut;
    }
    input.throttle = throttle;
    input.brake = u.pedal.brake;
    // rolling backwards while we want to go forward: throttle only
    if (st.speed < -0.5 && want > 1) {
      input.brake = 0;
      input.throttle = 1;
    }
  }

  /**
   * Advances along the waypoints, computes the look-ahead point on the route (u.tx / u.tz) and
   * returns the speed allowed by the upcoming corners.
   */
  private followRoute(u: Unit, want: number): number {
    const st = u.handle.vehicle.state;
    if (u.wpN === 0) {
      u.tx = st.x + Math.sin(st.heading) * 10;
      u.tz = st.z + Math.cos(st.heading) * 10;
      return 8;
    }
    const v = st.speed > 0 ? st.speed : 0;
    const wp = u.wp;
    // projection on the current leg (previous waypoint -> current one); passed => next leg
    let ax = 0;
    let az = 0;
    let bx = 0;
    let bz = 0;
    let t = 0;
    let legLen = 0;
    for (;;) {
      const i = u.wpI * 2;
      ax = u.wpI > 0 ? wp[i - 2] : u.startX;
      az = u.wpI > 0 ? wp[i - 1] : u.startZ;
      bx = wp[i];
      bz = wp[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const l2 = dx * dx + dz * dz;
      legLen = Math.sqrt(l2);
      t = l2 > 0.01 ? ((st.x - ax) * dx + (st.z - az) * dz) / l2 : 1;
      const ex = bx - st.x;
      const ez = bz - st.z;
      if (u.wpI < u.wpN - 1 && (t >= 1 || ex * ex + ez * ez < 25)) {
        u.wpI++;
        continue;
      }
      break;
    }
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    // look-ahead point: walk along the route from the projection
    let remaining = 6 + v * 0.25;
    let px = ax + (bx - ax) * t;
    let pz = az + (bz - az) * t;
    let left = legLen * (1 - t);
    let k = u.wpI;
    for (;;) {
      if (remaining <= left || k >= u.wpN - 1) {
        const f = left > 0.01 ? (remaining < left ? remaining / left : 1) : 1;
        u.tx = px + (wp[k * 2] - px) * f;
        u.tz = pz + (wp[k * 2 + 1] - pz) * f;
        break;
      }
      remaining -= left;
      px = wp[k * 2];
      pz = wp[k * 2 + 1];
      k++;
      left = Math.hypot(wp[k * 2] - px, wp[k * 2 + 1] - pz);
    }
    // corner speed at the next two waypoints
    const aLat = gripAt(u.config, 1, v) * GRAVITY * 0.8;
    const aBrake = u.config.brakeDecel * 0.6;
    let dist = legLen * (1 - t);
    let ix = ax;
    let iz = az;
    for (let c = 0; c < 2; c++) {
      const i = u.wpI + c;
      if (i >= u.wpN - 1) {
        if (u.mode === 'search') {
          // end of a search leg: arrive slowly
          const lim = Math.sqrt(64 + 2 * aBrake * dist);
          if (lim < want) want = lim;
        }
        break;
      }
      const cx = wp[i * 2];
      const cz = wp[i * 2 + 1];
      const d1x = cx - ix;
      const d1z = cz - iz;
      const d2x = wp[i * 2 + 2] - cx;
      const d2z = wp[i * 2 + 3] - cz;
      const la = Math.hypot(d1x, d1z);
      const lb = Math.hypot(d2x, d2z);
      if (la > 0.5 && lb > 0.5) {
        let cs = (d1x * d2x + d1z * d2z) / (la * lb);
        if (cs > 1) cs = 1;
        if (cs < -0.999) cs = -0.999;
        const theta = Math.acos(cs);
        if (theta > 0.06) {
          // sampled curve (short legs, small angle) or a real corner cut with ~9 m of room
          let radius = 9 / Math.tan(theta * 0.5);
          if (theta < 0.35) {
            const r2 = (la < lb ? la : lb) / theta;
            if (r2 > radius) radius = r2;
          }
          const vc = Math.sqrt(aLat * radius);
          const lim = Math.sqrt(vc * vc + 2 * aBrake * (dist > 10 ? dist - 10 : 0));
          if (lim < want) want = lim;
        }
      }
      dist += lb;
      ix = cx;
      iz = cz;
    }
    return want;
  }

  /** Appends the centre line of an edge (travelling from node `from`) to the unit's waypoints. */
  private appendEdge(u: Unit, e: RoadEdge, from: number, lateral: number, skipFirst: boolean): void {
    const pts = e.points;
    const forward = e.a === from;
    const n = pts.length;
    for (let k = skipFirst ? 1 : 0; k < n && u.wpN < MAX_WP; k++) {
      const p = pts[forward ? k : n - 1 - k];
      let x = p.x;
      let z = p.z;
      if (lateral !== 0) {
        // right-hand side of the travel direction
        const q = pts[forward ? (k < n - 1 ? k + 1 : k) : n - 1 - (k < n - 1 ? k + 1 : k)];
        const o = pts[forward ? (k < n - 1 ? k : k - 1) : n - 1 - (k < n - 1 ? k : k - 1)];
        let dx = q.x - o.x;
        let dz = q.z - o.z;
        const l = Math.hypot(dx, dz) || 1;
        dx /= l;
        dz /= l;
        x += -dz * lateral;
        z += dx * lateral;
      }
      u.wp[u.wpN * 2] = x;
      u.wp[u.wpN * 2 + 1] = z;
      u.wpN++;
    }
  }

  /** A* route on the road graph from the unit to a goal (re-planned every ~1.5 s). */
  private planRoute(u: Unit, gx: number, gz: number, searching: boolean): void {
    const roads = this.host.world.roads;
    const st = u.handle.vehicle.state;
    u.navT = 1.5;
    let goal = roads.nearestNode(gx, gz);
    if (searching) {
      // reached the last known position: prowl the neighbouring nodes
      const dx = gx - st.x;
      const dz = gz - st.z;
      if (dx * dx + dz * dz < 45 * 45 && goal.edges.length > 0) {
        const e = roads.edges[goal.edges[(u.slot + this.rotation + Math.floor(this.rng() * 4)) % goal.edges.length]];
        goal = roads.nodes[e.a === goal.id ? e.b : e.a];
        gx = goal.x;
        gz = goal.z;
        u.navT = 5;
      }
    }
    u.wpN = 0;
    u.wpI = 0;
    u.startX = st.x;
    u.startZ = st.z;
    u.navNode = goal.id;
    // start from the end of our own edge that looks best, following the edge geometry up to it
    const hit = roads.nearestRoad(st.x, st.z, 45);
    let fromId: number;
    let otherId = -1;
    if (hit) {
      // the end of the edge in front of us; A* decides whether turning around is worth it
      const e = hit.edge;
      const ahead = Math.sin(st.heading) * hit.dirX + Math.cos(st.heading) * hit.dirZ >= 0;
      fromId = ahead ? e.b : e.a;
      otherId = ahead ? e.a : e.b;
    } else {
      fromId = roads.nearestNode(st.x, st.z).id;
    }
    const path = roads.findPath(fromId, goal.id);
    let k0 = 0;
    if (hit && path.length >= 2 && path[1] === otherId) {
      // the route goes back through our edge: head for its other end directly
      k0 = 1;
      fromId = otherId;
    }
    if (hit) {
      // remaining points of the current edge toward `fromId`
      const e = hit.edge;
      const pts = e.points;
      const towardB = fromId === e.b;
      let acc = 0;
      if (towardB) {
        for (let k = 1; k < pts.length && u.wpN < MAX_WP; k++) {
          acc += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z);
          if (acc > hit.t + 5) {
            u.wp[u.wpN * 2] = pts[k].x;
            u.wp[u.wpN * 2 + 1] = pts[k].z;
            u.wpN++;
          }
        }
      } else {
        acc = e.length;
        for (let k = pts.length - 2; k >= 0 && u.wpN < MAX_WP; k--) {
          acc -= Math.hypot(pts[k].x - pts[k + 1].x, pts[k].z - pts[k + 1].z);
          if (acc < hit.t - 5) {
            u.wp[u.wpN * 2] = pts[k].x;
            u.wp[u.wpN * 2 + 1] = pts[k].z;
            u.wpN++;
          }
        }
      }
    }
    if (u.wpN === 0) {
      const n = roads.nodes[fromId];
      u.wp[0] = n.x;
      u.wp[1] = n.z;
      u.wpN = 1;
    }
    for (let i = k0; i < path.length - 1 && u.wpN < MAX_WP; i++) {
      const e = roads.edgeBetween(path[i], path[i + 1]);
      if (!e) break;
      this.appendEdge(u, e, path[i], 0, true);
    }
    if (u.wpN < MAX_WP) {
      u.wp[u.wpN * 2] = gx;
      u.wp[u.wpN * 2 + 1] = gz;
      u.wpN++;
    }
    this.chamfer(u);
  }

  /** Cuts the sharp corners of a route (two points 9 m before / after the vertex) so they can be driven faster. */
  private chamfer(u: Unit): void {
    const src = u.wp;
    const out = this.scratch;
    const n = u.wpN;
    let m = 0;
    let px = u.startX;
    let pz = u.startZ;
    for (let i = 0; i < n && m < MAX_WP; i++) {
      const x = src[i * 2];
      const z = src[i * 2 + 1];
      if (i < n - 1 && m < MAX_WP - 1) {
        const ax = x - px;
        const az = z - pz;
        const bx = src[i * 2 + 2] - x;
        const bz = src[i * 2 + 3] - z;
        const la = Math.hypot(ax, az);
        const lb = Math.hypot(bx, bz);
        if (lb > 14 && la > 0.5 && (ax * bx + az * bz) / (la * lb) < 0.85) {
          const cOut = lb * 0.5 < 9 ? lb * 0.5 : 9;
          if (la > 5) {
            const cIn = la * 0.6 < 9 ? la * 0.6 : 9;
            out[m * 2] = x - (ax / la) * cIn;
            out[m * 2 + 1] = z - (az / la) * cIn;
            m++;
          }
          out[m * 2] = x + (bx / lb) * cOut;
          out[m * 2 + 1] = z + (bz / lb) * cOut;
          m++;
          px = x;
          pz = z;
          continue;
        }
      }
      out[m * 2] = x;
      out[m * 2 + 1] = z;
      m++;
      px = x;
      pz = z;
    }
    for (let k = 0; k < m * 2; k++) src[k] = out[k];
    u.wpN = m;
  }

  /** Patrol: drive edge after edge on the right-hand side, choosing a new edge at every node. */
  private patrolRoute(u: Unit): void {
    const roads = this.host.world.roads;
    const st = u.handle.vehicle.state;
    if (u.wpN > 0 && u.wpI < u.wpN) {
      const i = (u.wpN - 1) * 2;
      const dx = u.wp[i] - st.x;
      const dz = u.wp[i + 1] - st.z;
      if (dx * dx + dz * dz > 13 * 13) return;
    }
    u.startX = st.x;
    u.startZ = st.z;
    // at (or without) a node: pick the next edge
    const here = u.patrolTo >= 0 ? roads.nodes[u.patrolTo] : roads.nearestNode(st.x, st.z);
    let pick: RoadEdge | null = null;
    let bestScore = -1e9;
    const pst = this.host.player.vehicle.state;
    for (let k = 0; k < here.edges.length; k++) {
      const e = roads.edges[here.edges[k]];
      if (e.id === u.patrolEdge && here.edges.length > 1) continue; // no U-turn unless dead end
      const o = roads.nodes[e.a === here.id ? e.b : e.a];
      // keep going roughly straight, stay away from ramps; leaving units head away from the player
      let score = this.rng() * 1.2;
      score += (Math.sin(st.heading) * (o.x - here.x) + Math.cos(st.heading) * (o.z - here.z)) / (e.length || 1);
      if (e.kind === 'ramp') score -= 3;
      const dp = Math.hypot(o.x - pst.x, o.z - pst.z);
      if (u.leaving) score += dp * 0.01;
      else if (dp > POLICE_TUNING.patrolMax) score -= 1.5;
      if (score > bestScore) {
        bestScore = score;
        pick = e;
      }
    }
    u.wpN = 0;
    u.wpI = 0;
    if (!pick) {
      u.wp[0] = here.x;
      u.wp[1] = here.z;
      u.wpN = 1;
      return;
    }
    u.patrolEdge = pick.id;
    u.patrolTo = pick.a === here.id ? pick.b : pick.a;
    // (the start point of the edge is skipped: we are there)
    this.appendEdge(u, pick, here.id, pick.width / 4, true);
  }

  // ---------------------------------------------------------------------------
  // Roadblocks & spike strips
  // ---------------------------------------------------------------------------

  private updateRoadblocks(dt: number, playerSpeed: number): void {
    const T = POLICE_TUNING;
    const s = this.state;
    const pst = this.host.player.vehicle.state;
    for (let i = this.roadblocks.length - 1; i >= 0; i--) {
      const rb = this.roadblocks[i];
      rb.age += dt;
      const dx = pst.x - rb.x;
      const dz = pst.z - rb.z;
      const past = dx * Math.sin(rb.heading) + dz * Math.cos(rb.heading);
      if (rb.age > T.roadblockLife || past > 260 || dx * dx + dz * dz > 450 * 450) this.removeRoadblock(i);
    }
    if (s.status !== 'pursuit' || s.heat < 3) return;
    this.roadblockT -= dt;
    if (this.roadblockT > 0 || this.roadblocks.length >= 2) return;
    if (playerSpeed < 12 || !this.buildRoadblock()) {
      this.roadblockT = 5;
      return;
    }
    const k = s.heat >= 5 ? 0.6 : 1;
    this.roadblockT = (T.roadblockMin + (T.roadblockMax - T.roadblockMin) * this.rng()) * k;
  }

  /** Follows the player's road ahead (straightest continuation at nodes) and finds a straight spot. */
  private predictSpot(distance: number): boolean {
    const roads = this.host.world.roads;
    const pst = this.host.player.vehicle.state;
    const hit = roads.nearestRoad(pst.x, pst.z, 45);
    if (!hit) return false;
    let edge = hit.edge;
    let dir = pst.vx * hit.dirX + pst.vz * hit.dirZ >= 0 ? 1 : -1;
    let t = hit.t;
    let travelled = 0;
    for (let step = 0; step < 14; step++) {
      const remaining = dir > 0 ? edge.length - t : t;
      if (travelled + remaining >= distance && edge.length >= 70 && edge.kind !== 'ramp') {
        let ts = t + dir * (distance - travelled);
        if (ts < 28) ts = 28;
        else if (ts > edge.length - 28) ts = edge.length - 28;
        // locate the segment
        const pts = edge.points;
        let acc = 0;
        for (let k = 0; k < pts.length - 1; k++) {
          const a = pts[k];
          const b = pts[k + 1];
          const l = Math.hypot(b.x - a.x, b.z - a.z);
          if (acc + l >= ts || k === pts.length - 2) {
            // straight enough here? (long segment, or nearly aligned neighbours)
            let ok = l >= 30;
            if (!ok && k > 0 && k < pts.length - 2) {
              const p = pts[k - 1];
              const q = pts[k + 2];
              const d1x = a.x - p.x;
              const d1z = a.z - p.z;
              const d2x = q.x - b.x;
              const d2z = q.z - b.z;
              const cs = (d1x * d2x + d1z * d2z) / ((Math.hypot(d1x, d1z) || 1) * (Math.hypot(d2x, d2z) || 1));
              ok = cs > 0.97;
            }
            if (!ok) return false;
            const u = l > 0.01 ? (ts - acc) / l : 0;
            this.rbX = a.x + (b.x - a.x) * u;
            this.rbZ = a.z + (b.z - a.z) * u;
            this.rbH = Math.atan2((b.x - a.x) * dir, (b.z - a.z) * dir);
            this.rbEdge = edge;
            return true;
          }
          acc += l;
        }
        return false;
      }
      travelled += remaining;
      // straightest continuation through the node
      const nodeId = dir > 0 ? edge.b : edge.a;
      const node = roads.nodes[nodeId];
      const pts = edge.points;
      const e1 = dir > 0 ? pts[pts.length - 1] : pts[0];
      const e0 = dir > 0 ? pts[pts.length - 2] : pts[1];
      let ax = e1.x - e0.x;
      let az = e1.z - e0.z;
      const al = Math.hypot(ax, az) || 1;
      ax /= al;
      az /= al;
      let next: RoadEdge | null = null;
      let best = -2;
      for (let k = 0; k < node.edges.length; k++) {
        const e = roads.edges[node.edges[k]];
        if (e === edge) continue;
        const q = e.points;
        const fromA = e.a === nodeId;
        const o0 = fromA ? q[0] : q[q.length - 1];
        const o1 = fromA ? q[1] : q[q.length - 2];
        const d = ((o1.x - o0.x) * ax + (o1.z - o0.z) * az) / (Math.hypot(o1.x - o0.x, o1.z - o0.z) || 1);
        if (d > best) {
          best = d;
          next = e;
        }
      }
      if (!next) return false;
      edge = next;
      dir = next.a === nodeId ? 1 : -1;
      t = dir > 0 ? 0 : next.length;
    }
    return false;
  }

  private buildRoadblock(): boolean {
    const T = POLICE_TUNING;
    const s = this.state;
    const world = this.host.world;
    const rng = this.rng;
    let distance = 220 + rng() * 120;
    let found = false;
    for (let attempt = 0; attempt < 3 && !found; attempt++) {
      found = this.predictSpot(distance);
      if (!found) distance = 220 + rng() * 120;
    }
    if (!found || !this.rbEdge) return false;
    const x = this.rbX;
    const z = this.rbZ;
    const h = this.rbH;
    if (!this.hidden(x, z) && Math.hypot(x - this.host.player.vehicle.state.x, z - this.host.player.vehicle.state.z) < 200) return false;
    if (this.host.queryBodies(x, z, 14, this.bodies) > 0) return false;
    // across axis = local +X of the heading: (cos h, -sin h)
    const ax = Math.cos(h);
    const az = -Math.sin(h);
    const span = this.rbEdge.width + 2;
    const gap = 4.8 + rng();
    const half = span * 0.5;
    const room = half - gap * 0.5 - 0.6;
    const gapC = room > 0 ? (rng() * 2 - 1) * room : 0;
    const rb: Block = { id: this.nextBlockId++, x, z, heading: h, barriers: [], spikes: null, colliders: [], age: 0 };
    let cars = 0;
    const maxCars = Math.min(3, T.maxUnits - this.units.length);
    const carKind: PoliceKind = s.heat >= 4 ? 'suv' : 'patrol';
    const carLen = POLICE_SPECS[carKind].dims.length + 0.5;
    // fill both sides of the gap: cars next to the gap, barriers toward the kerbs
    for (let sideIdx = 0; sideIdx < 2; sideIdx++) {
      const sd = sideIdx === 0 ? -1 : 1;
      let from = gapC + sd * gap * 0.5; // edge of the gap
      const end = sd * half;
      let left = Math.abs(end - from);
      while (left >= carLen && cars < maxCars) {
        const c = from + sd * carLen * 0.5;
        // parked across the lanes, nose toward the gap side alternately
        const unit = this.spawnUnit(carKind, x + ax * c, z + az * c, h + (sd > 0 ? Math.PI / 2 : -Math.PI / 2), 'roadblock', 0);
        unit.roadblockId = rb.id;
        unit.handle.input.handbrake = true;
        unit.handle.input.brake = 1;
        cars++;
        from += sd * carLen;
        left -= carLen;
        if (cars >= 2 && left < carLen * 1.6) break;
      }
      while (left > 0.7) {
        const w = left > 4.2 ? 3.6 : left - 0.1;
        const c = from + sd * w * 0.5;
        const bx = x + ax * c;
        const bz = z + az * c;
        rb.barriers.push({ x: bx, z: bz, heading: h, width: w });
        const gy = world.getGroundHeight(bx, bz);
        rb.colliders.push(
          world.addCollider({ shape: 'box', x: bx, z: bz, hx: w * 0.5, hz: 0.25, rot: h, r: Math.hypot(w * 0.5, 0.25), yMin: gy - 0.3, yMax: gy + 1.1, kind: 'roadblock', refId: rb.id }),
        );
        from += sd * w;
        left -= w;
      }
    }
    // not enough room across the road for two cars: park the others just behind the line
    while (cars < 2 && cars < maxCars) {
      const c = gapC + (cars === 0 ? -1 : 1) * (gap * 0.5 + carLen * 0.5);
      const back = 6.5;
      const unit = this.spawnUnit(carKind, x + ax * c + Math.sin(h) * back, z + az * c + Math.cos(h) * back, h + Math.PI / 2, 'roadblock', 0);
      unit.roadblockId = rb.id;
      cars++;
    }
    if (s.heat >= 4) rb.spikes = { x: x + ax * gapC, z: z + az * gapC, heading: h, halfLength: gap * 0.5 - 0.15, active: true };
    this.roadblocks.push(rb);
    this.events.push({ type: 'roadblock', distance: Math.round(distance) });
    return true;
  }

  private removeRoadblock(index: number): void {
    const rb = this.roadblocks[index];
    for (let k = 0; k < rb.colliders.length; k++) this.host.world.removeCollider(rb.colliders[k]);
    rb.colliders.length = 0;
    this.roadblocks.splice(index, 1);
    // its cars join the chase (or stand down when the pursuit is over)
    const pursuing = this.state.status === 'pursuit';
    let engaged = 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (this.isChaser(u) && u.mode !== 'patrol') engaged++;
    }
    const want = POLICE_TUNING.unitsPerHeat[this.state.heat] ?? 0;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (u.roadblockId !== rb.id) continue;
      u.roadblockId = -1;
      if (u.mode !== 'roadblock') continue;
      u.handle.input.handbrake = false;
      if (pursuing && engaged < want) {
        engaged++;
        u.mode = 'pursue';
        u.navT = 0;
      } else {
        u.mode = 'patrol';
        u.leaving = true;
        u.sirenOn = false;
        u.wpN = 0;
        u.patrolTo = -1;
      }
    }
  }

  private removeRoadblocks(): void {
    for (let i = this.roadblocks.length - 1; i >= 0; i--) this.removeRoadblock(i);
  }

  /** Player wheels vs active spike strips (swept between two frames). */
  private updateSpikes(): void {
    const ph = this.host.player;
    const pst = ph.vehicle.state;
    const cfg = ph.vehicle.config;
    const fx = Math.sin(pst.heading);
    const fz = Math.cos(pst.heading);
    const hw = cfg.wheelbase * 0.5;
    const ht = cfg.track * 0.5;
    const now = this.wheelNow;
    // FL, FR, RL, RR — right(h) = (-cos h, sin h) = (-fz, fx)
    for (let w = 0; w < 4; w++) {
      const lf = w < 2 ? hw : -hw;
      const lr = (w & 1) === 0 ? -ht : ht;
      now[w * 2] = pst.x + fx * lf - fz * lr;
      now[w * 2 + 1] = pst.z + fz * lf + fx * lr;
    }
    if (this.wheelsValid && pst.grounded) {
      for (let i = 0; i < this.roadblocks.length; i++) {
        const sp = this.roadblocks[i].spikes;
        if (!sp || !sp.active) continue;
        const ddx = pst.x - sp.x;
        const ddz = pst.z - sp.z;
        if (ddx * ddx + ddz * ddz > 40 * 40) continue;
        const cr = Math.cos(sp.heading);
        const sr = Math.sin(sp.heading);
        for (let w = 0; w < 4 && sp.active; w++) {
          // strip-local: X across the road (cos h, -sin h), Z along it (sin h, cos h)
          const ax = this.wheelPrev[w * 2] - sp.x;
          const az = this.wheelPrev[w * 2 + 1] - sp.z;
          const bx = now[w * 2] - sp.x;
          const bz = now[w * 2 + 1] - sp.z;
          const alx = ax * cr - az * sr;
          const alz = ax * sr + az * cr;
          const blx = bx * cr - bz * sr;
          const blz = bx * sr + bz * cr;
          let hit = false;
          if (Math.abs(blz) < 0.35 && Math.abs(blx) <= sp.halfLength) hit = true;
          else if (alz * blz < 0 && Math.abs(alz - blz) < 12) {
            const t = alz / (alz - blz);
            const cx = alx + (blx - alx) * t;
            hit = Math.abs(cx) <= sp.halfLength;
          }
          if (hit) {
            sp.active = false;
            ph.vehicle.puncture(10);
            this.events.push({ type: 'spikeHit' });
          }
        }
      }
    }
    for (let k = 0; k < 8; k++) this.wheelPrev[k] = now[k];
    this.wheelsValid = true;
  }

  // ---------------------------------------------------------------------------
  // Helicopter
  // ---------------------------------------------------------------------------

  private updateHelicopter(dt: number): void {
    const T = POLICE_TUNING;
    const s = this.state;
    const heli = this.helicopter;
    const world = this.host.world;
    const pst = this.host.player.vehicle.state;
    const wanted = s.status !== 'idle' && s.heat >= 4;
    if (this.heliPhase === 0) {
      heli.active = false;
      heli.seesPlayer = false;
      if (!wanted) return;
      this.heliT -= dt;
      if (this.heliT > 0) return;
      // arrives from ~500 m away
      const a = this.rng() * Math.PI * 2;
      heli.x = pst.x + Math.sin(a) * 500;
      heli.z = pst.z + Math.cos(a) * 500;
      heli.y = world.getGroundHeight(heli.x, heli.z) + T.heliAltitude;
      heli.heading = a + Math.PI;
      heli.spotX = heli.x;
      heli.spotZ = heli.z;
      heli.active = true;
      this.heliVx = -Math.sin(a) * 50;
      this.heliVz = -Math.cos(a) * 50;
      this.heliPhase = 1;
      this.heliT = s.heat >= 5 ? 150 : 70 + 20 * this.rng();
      this.events.push({ type: 'heliInbound' });
      return;
    }
    // flight
    let gx: number;
    let gz: number;
    if (this.heliPhase === 1) {
      this.heliT -= dt;
      if (this.heliT <= 0 || !wanted) this.heliPhase = 2;
      const known = heli.seesPlayer || s.inSight;
      const bx = known ? pst.x : this.lastX;
      const bz = known ? pst.z : this.lastZ;
      // slightly behind the player
      gx = bx - Math.sin(pst.heading) * 18;
      gz = bz - Math.cos(pst.heading) * 18;
    } else {
      // leaving: straight away from the player
      const dx = heli.x - pst.x;
      const dz = heli.z - pst.z;
      const d = Math.hypot(dx, dz) || 1;
      gx = heli.x + (dx / d) * 200;
      gz = heli.z + (dz / d) * 200;
      if (d > 620) {
        heli.active = false;
        heli.seesPlayer = false;
        this.heliPhase = 0;
        this.heliT = 40;
        return;
      }
    }
    let dvx = (gx - heli.x) * 1.1;
    let dvz = (gz - heli.z) * 1.1;
    const dsp = Math.hypot(dvx, dvz);
    if (dsp > T.heliSpeed) {
      dvx *= T.heliSpeed / dsp;
      dvz *= T.heliSpeed / dsp;
    }
    const k = 1 - Math.exp(-dt * 1.4);
    this.heliVx += (dvx - this.heliVx) * k;
    this.heliVz += (dvz - this.heliVz) * k;
    heli.x += this.heliVx * dt;
    heli.z += this.heliVz * dt;
    const wantY = world.getGroundHeight(heli.x, heli.z) + T.heliAltitude;
    heli.y += (wantY - heli.y) * (1 - Math.exp(-dt * 1.2));
    if (Math.hypot(this.heliVx, this.heliVz) > 3) {
      let dh = Math.atan2(this.heliVx, this.heliVz) - heli.heading;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      heli.heading += dh * (1 - Math.exp(-dt * 3));
    }
    const hx = pst.x - heli.x;
    const hz = pst.z - heli.z;
    heli.seesPlayer = this.heliPhase === 1 && hx * hx + hz * hz < T.heliRange * T.heliRange && !world.isInTunnel(pst.x, pst.z);
    const ks = 1 - Math.exp(-dt * 5);
    if (heli.seesPlayer) {
      heli.spotX += (pst.x - heli.spotX) * ks;
      heli.spotZ += (pst.z - heli.spotZ) * ks;
    } else {
      // search pattern around the last known position
      this.heliSweep += dt * 0.9;
      const sx = this.lastX + Math.cos(this.heliSweep) * 26;
      const sz = this.lastZ + Math.sin(this.heliSweep * 1.3) * 26;
      heli.spotX += (sx - heli.spotX) * ks * 0.5;
      heli.spotZ += (sz - heli.spotZ) * ks * 0.5;
    }
  }
}

export function createPoliceSystem(host: AIHost): IPoliceSystem {
  return new PoliceSystem(host);
}
