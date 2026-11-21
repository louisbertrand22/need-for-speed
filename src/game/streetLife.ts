/* "Street life" scoring that runs whenever the player drives: near misses,
 * slipstream, jumps, free-roam drift combos, speeding reports, district banners
 * and lifetime stats. */
import { clamp, damp } from '../core/math';
import { DISTRICTS } from '../core/layout';
import type {
  CityWorld,
  DistrictId,
  IGameAudio,
  IPoliceSystem,
  ITrafficSystem,
  VehicleEvent,
  VehicleHandle,
} from '../core/types';
import type { Progression } from './gameModes';
import type { UIStore } from './store';

export interface StreetContext {
  world: CityWorld;
  player: VehicleHandle;
  handles: VehicleHandle[];
  traffic: ITrafficSystem;
  police: IPoliceSystem;
  store: UIStore;
  audio: IGameAudio;
  progression: Progression;
}

const COMBO_GRACE = 1.5;

export class StreetLife {
  /** game time of the last collision involving the player (set by the engine) */
  lastCollisionTime = -10;

  private readonly ctx: StreetContext;
  private readonly prevAlong = new Map<number, number>();
  private readonly seen = new Set<number>();
  private slowTimer = 0;
  private draftTime = 0;
  private jumpX = 0;
  private jumpZ = 0;
  private district: DistrictId | null = null;
  // free-roam drift combo
  private combo = 0;
  private comboGrace = 0;
  private comboTime = 0;

  constructor(ctx: StreetContext) {
    this.ctx = ctx;
  }

  /** Forget transient state (teleport, event start). */
  reset(): void {
    this.prevAlong.clear();
    this.combo = 0;
    this.comboGrace = 0;
    this.comboTime = 0;
    this.ctx.player.vehicle.draft = 0;
  }

  onPlayerEvent(e: VehicleEvent, inEvent: boolean): void {
    const { ctx } = this;
    const st = ctx.player.vehicle.state;
    if (e.type === 'jump') {
      this.jumpX = st.x;
      this.jumpZ = st.z;
    } else if (e.type === 'landing' && e.airTime > 0.65) {
      const distance = Math.hypot(st.x - this.jumpX, st.z - this.jumpZ);
      if (distance > 8) {
        ctx.store.emit({ type: 'jump', airTime: e.airTime, distance });
        ctx.player.vehicle.addNitro(0.1);
        if (!inEvent) ctx.progression.addRep(Math.round(clamp(distance * 0.6, 5, 60)));
      }
    } else if (e.type === 'impact' && e.intensity > 4 && this.combo > 0) {
      if (this.combo > 400) ctx.store.emit({ type: 'driftLost', points: Math.round(this.combo) });
      this.combo = 0;
      this.comboTime = 0;
    }
  }

  update(dt: number, time: number, inEvent: boolean, freeRoam: boolean): void {
    const { ctx } = this;
    const v = ctx.player.vehicle;
    const st = v.state;
    const stats = ctx.progression.profile.stats;
    const sinH = Math.sin(st.heading);
    const cosH = Math.cos(st.heading);
    const speed = Math.hypot(st.vx, st.vz);

    // ---- lifetime stats
    stats.distanceKm += (speed * dt) / 1000;
    stats.playTimeS += dt;
    if (st.speedKmh > stats.topSpeedKmh) stats.topSpeedKmh = Math.round(st.speedKmh);
    ctx.progression.touch();

    // ---- near misses & slipstream against traffic
    let draft = 0;
    this.seen.clear();
    const halfW = v.config.width * 0.5;
    for (const car of ctx.traffic.cars) {
      const rx = car.x - st.x;
      const rz = car.z - st.z;
      const d2 = rx * rx + rz * rz;
      if (d2 > 45 * 45) continue;
      const along = rx * sinH + rz * cosH;
      const lateral = -rx * cosH + rz * sinH;
      this.seen.add(car.id);
      const prev = this.prevAlong.get(car.id);
      this.prevAlong.set(car.id, along);
      const carAlongSpeed = car.vx * sinH + car.vz * cosH;
      if (
        prev !== undefined &&
        prev > 0 &&
        along <= 0 &&
        car.mode === 'driving' &&
        Math.abs(lateral) < halfW + car.halfWidth + 1.7 &&
        speed > 22 &&
        st.speed - carAlongSpeed > 9 &&
        time - this.lastCollisionTime > 0.9
      ) {
        const oncoming = carAlongSpeed < -3;
        const bonus = oncoming ? 20 : 10;
        v.addNitro(oncoming ? 0.12 : 0.07);
        stats.nearMisses++;
        ctx.audio.playUi('nearMiss');
        ctx.store.emit({ type: 'nearMiss', bonus });
        if (!inEvent) ctx.progression.addRep(bonus);
      }
      // slipstream behind a vehicle going the same way
      if (along > 4 && along < 30 && Math.abs(lateral) < 1.9 && carAlongSpeed > 10) {
        draft = Math.max(draft, 1 - (along - 4) / 26);
      }
    }
    if (this.prevAlong.size > this.seen.size + 8) {
      for (const id of this.prevAlong.keys()) if (!this.seen.has(id)) this.prevAlong.delete(id);
    }
    for (const h of ctx.handles) {
      if (h === ctx.player || !h.alive) continue;
      const o = h.vehicle.state;
      const rx = o.x - st.x;
      const rz = o.z - st.z;
      const along = rx * sinH + rz * cosH;
      const lateral = -rx * cosH + rz * sinH;
      const alongSpeed = o.vx * sinH + o.vz * cosH;
      if (along > 4 && along < 30 && Math.abs(lateral) < 1.9 && alongSpeed > 10) {
        draft = Math.max(draft, 1 - (along - 4) / 26);
      }
    }
    if (speed < 25) draft = 0;
    v.draft = damp(v.draft, draft, 3, dt);
    if (v.draft > 0.35) {
      v.addNitro(0.035 * dt * v.draft);
      this.draftTime += dt;
      if (this.draftTime > 2.5) {
        this.draftTime = -6;
        ctx.store.emit({ type: 'banner', title: 'ASPIRATION', subtitle: 'Nitro en recharge', tone: 'info' });
      }
    } else if (this.draftTime > 0) {
      this.draftTime = 0;
    } else if (this.draftTime < 0) {
      this.draftTime = Math.min(0, this.draftTime + dt);
    }

    // ---- free-roam drift combos (events have their own scoring)
    if (freeRoam) {
      if (st.drifting && st.grounded && st.speedKmh > 35) {
        const rate = 220 * clamp(st.driftAngleDeg / 30, 0.4, 2.2) * clamp(st.speedKmh / 80, 0.3, 2.6);
        this.comboTime += dt;
        this.combo += rate * dt * (1 + Math.floor(this.comboTime / 2.6) * 0.5);
        this.comboGrace = COMBO_GRACE;
      } else if (this.combo > 0) {
        this.comboGrace -= dt;
        if (this.comboGrace <= 0) {
          const points = Math.round(this.combo);
          if (points >= 600) {
            ctx.store.emit({ type: 'driftBank', points, multiplier: 1 + Math.floor(this.comboTime / 2.6) });
            ctx.audio.playUi('driftBank');
            ctx.progression.addRep(Math.round(clamp(points / 220, 2, 90)));
            if (points > stats.bestDrift) stats.bestDrift = points;
          }
          this.combo = 0;
          this.comboTime = 0;
        }
      }
    }

    // ---- slow checks (2 Hz)
    this.slowTimer -= dt;
    if (this.slowTimer <= 0) {
      this.slowTimer = 0.5;
      if (freeRoam) {
        const hit = ctx.world.roads.nearestRoad(st.x, st.z, 30);
        const limit = hit ? hit.edge.speedLimitKmh : 60;
        if (st.speedKmh > limit + 55) ctx.police.reportInfraction('speeding', clamp((st.speedKmh - limit) / 120, 0.2, 1));
      }
      const d = ctx.world.districtAt(st.x, st.z);
      if (d !== this.district) {
        const first = this.district === null;
        this.district = d;
        ctx.store.set({ district: d });
        if (freeRoam && !first) ctx.store.toast('district', DISTRICTS[d].name, DISTRICTS[d].tagline, 4);
      }
    }
  }
}
