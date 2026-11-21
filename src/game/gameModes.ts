/* =============================================================================
 * Game modes & progression
 *  - Progression: money ($), reputation (REP), garage ownership, localStorage save
 *  - RaceSession: the five event modes (sprint, circuit, drift, drag, speed-trap)
 * ===========================================================================*/
import { clamp, clamp01, angleDiff, formatTime, mulberry32, lerp } from '../core/math';
import type { PathProjection } from '../core/path';
import type {
  AIHost,
  ActionResult,
  ActiveEventInfo,
  CarVisuals,
  CityWorld,
  DriveInput,
  EventRecord,
  EventResults,
  GameSettings,
  IGameAudio,
  IRaceAI,
  ITrafficSystem,
  Medal,
  OwnedCar,
  PlayerProfile,
  PlayerStats,
  RivalSetup,
  SpawnPoint,
  StandingRow,
  StaticCollider,
  Telemetry,
  TuneLevel,
  TunePart,
  TuningState,
  VehicleEvent,
  VehicleHandle,
} from '../core/types';
import {
  CAR_CATALOG,
  MODE_INFO,
  PAINT_COLORS,
  RIM_COLORS,
  RIVAL_NAMES,
  STARTER_CAR_ID,
  STARTING_MONEY,
  STOCK_TUNING,
  TUNE_LEVEL_REP,
  TUNE_PARTS,
  getCarSpec,
  repLevelFor,
  upgradePrice,
  visualsEqual,
  visualsPrice,
} from './catalog';
import { EVENT_DEFS, REWARD_MONEY, REWARD_REP } from './events';
import type { BuiltEvent, GateDef } from './events';
import type { UIStore } from './store';

// -----------------------------------------------------------------------------
// Save game
// -----------------------------------------------------------------------------

const SAVE_KEY = 'apex-nocturne-save-v1';
const SAVE_VERSION = 1;
/** lifetime stats change every frame: they are written at most this often (seconds) */
const SAVE_DELAY = 5;

export function defaultSettings(): GameSettings {
  return {
    transmission: 'auto',
    masterVolume: 0.8,
    musicVolume: 0.5,
    cameraMode: 'chaseNear',
    mirror: true,
    quality: 'high',
    units: 'kmh',
    speedLines: true,
    trafficDensity: 0.6,
  };
}

function defaultStats(): PlayerStats {
  return {
    racesRun: 0,
    racesWon: 0,
    pursuitsEvaded: 0,
    timesBusted: 0,
    totalBounty: 0,
    copsDisabled: 0,
    breakersUsed: 0,
    nearMisses: 0,
    bestDrift: 0,
    topSpeedKmh: 0,
    distanceKm: 0,
    maxHeat: 0,
    playTimeS: 0,
  };
}

function newOwnedCar(carId: string): OwnedCar {
  const spec = getCarSpec(carId);
  return { carId: spec.id, tuning: { ...STOCK_TUNING }, visuals: { ...spec.defaultVisuals }, heat: 1 };
}

export function defaultProfile(): PlayerProfile {
  return {
    version: SAVE_VERSION,
    money: STARTING_MONEY,
    rep: 0,
    currentCarId: STARTER_CAR_ID,
    garage: { [STARTER_CAR_ID]: newOwnedCar(STARTER_CAR_ID) },
    events: {},
    stats: defaultStats(),
    settings: defaultSettings(),
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && isFinite(v) ? v : fallback;
}

/** Rebuilds a valid profile from whatever was stored (tolerates old / corrupted saves). */
function sanitizeProfile(raw: unknown): PlayerProfile {
  const base = defaultProfile();
  if (!isObject(raw)) return base;
  base.money = Math.max(0, num(raw.money, base.money));
  base.rep = Math.max(0, num(raw.rep, 0));

  if (isObject(raw.garage)) {
    const garage: Record<string, OwnedCar> = {};
    for (const spec of CAR_CATALOG) {
      const rc = raw.garage[spec.id];
      if (!isObject(rc)) continue;
      const car = newOwnedCar(spec.id);
      if (isObject(rc.tuning)) {
        for (const part of TUNE_PARTS) car.tuning[part] = clamp(Math.round(num(rc.tuning[part], 0)), 0, 3) as TuneLevel;
      }
      if (isObject(rc.visuals)) car.visuals = { ...car.visuals, ...(rc.visuals as Partial<CarVisuals>) };
      car.heat = clamp(Math.round(num(rc.heat, 1)), 1, 5);
      garage[spec.id] = car;
    }
    if (Object.keys(garage).length > 0) base.garage = garage;
  }
  const current = typeof raw.currentCarId === 'string' ? raw.currentCarId : STARTER_CAR_ID;
  base.currentCarId = base.garage[current] ? current : Object.keys(base.garage)[0];

  if (isObject(raw.events)) {
    for (const def of EVENT_DEFS) {
      const re = raw.events[def.id];
      if (!isObject(re)) continue;
      base.events[def.id] = {
        attempts: Math.max(0, num(re.attempts, 0)),
        wins: Math.max(0, num(re.wins, 0)),
        completed: re.completed === true,
        bestTimeMs: typeof re.bestTimeMs === 'number' ? re.bestTimeMs : null,
        bestScore: typeof re.bestScore === 'number' ? re.bestScore : null,
        medal: re.medal === 'gold' || re.medal === 'silver' || re.medal === 'bronze' ? re.medal : null,
      };
    }
  }
  if (isObject(raw.stats)) {
    const stats = base.stats as unknown as Record<string, number>;
    for (const k of Object.keys(stats)) stats[k] = Math.max(0, num(raw.stats[k], 0));
  }
  if (isObject(raw.settings)) {
    const s = raw.settings;
    const d = base.settings;
    d.transmission = s.transmission === 'manual' ? 'manual' : 'auto';
    d.masterVolume = clamp01(num(s.masterVolume, d.masterVolume));
    d.musicVolume = clamp01(num(s.musicVolume, d.musicVolume));
    d.cameraMode = s.cameraMode === 'chaseFar' || s.cameraMode === 'hood' ? s.cameraMode : 'chaseNear';
    d.mirror = s.mirror !== false;
    d.quality = s.quality === 'low' || s.quality === 'medium' ? s.quality : 'high';
    d.units = s.units === 'mph' ? 'mph' : 'kmh';
    d.speedLines = s.speedLines !== false;
    d.trafficDensity = clamp01(num(s.trafficDensity, d.trafficDensity));
  }
  return base;
}

export function loadProfile(): PlayerProfile {
  try {
    const text = window.localStorage.getItem(SAVE_KEY);
    if (!text) return defaultProfile();
    return sanitizeProfile(JSON.parse(text));
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile: PlayerProfile): void {
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(profile));
  } catch {
    /* storage unavailable (private mode / quota): the game simply runs without persistence */
  }
}

// -----------------------------------------------------------------------------
// Progression
// -----------------------------------------------------------------------------

export interface RepGain {
  levelUp: number | null;
  unlocked: string[];
}

export class Progression {
  profile: PlayerProfile;
  private dirty = false;
  private saveTimer = 0;

  constructor(private readonly onChange: (p: PlayerProfile) => void) {
    this.profile = loadProfile();
  }

  get currentCar(): OwnedCar {
    return this.profile.garage[this.profile.currentCarId];
  }

  get repLevel(): number {
    return repLevelFor(this.profile.rep);
  }

  /** Publish the profile to the UI and save almost immediately. */
  commit(): void {
    this.dirty = true;
    this.saveTimer = Math.max(this.saveTimer, SAVE_DELAY - 0.25);
    this.onChange(this.profile);
  }

  /** Stats change very often: mark dirty without republishing to the UI. */
  touch(): void {
    this.dirty = true;
  }

  /** Debounced persistence, called every frame. */
  update(dt: number): void {
    if (!this.dirty) return;
    this.saveTimer += dt;
    if (this.saveTimer >= SAVE_DELAY) this.flush();
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.saveTimer = 0;
    saveProfile(this.profile);
  }

  reset(): void {
    const settings = this.profile.settings;
    this.profile = defaultProfile();
    this.profile.settings = settings;
    this.commit();
    this.flush();
  }

  addMoney(amount: number): void {
    this.profile.money = Math.max(0, Math.round(this.profile.money + amount));
    this.commit();
  }

  addRep(amount: number): RepGain {
    const before = this.repLevel;
    this.profile.rep = Math.max(0, Math.round(this.profile.rep + amount));
    const after = this.repLevel;
    const unlocked: string[] = [];
    if (after > before) {
      for (let lvl = before + 1; lvl <= after; lvl++) {
        for (const car of CAR_CATALOG) if (car.repLevel === lvl) unlocked.push(car.name);
        for (const ev of EVENT_DEFS) if (ev.repLevel === lvl) unlocked.push(`${MODE_INFO[ev.mode].label} · ${ev.name}`);
      }
    }
    this.commit();
    return { levelUp: after > before ? after : null, unlocked };
  }

  updateSettings(patch: Partial<GameSettings>): void {
    this.profile.settings = { ...this.profile.settings, ...patch };
    this.commit();
  }

  buyCar(carId: string): ActionResult {
    const spec = CAR_CATALOG.find((c) => c.id === carId);
    if (!spec) return { ok: false, reason: 'Voiture inconnue' };
    if (this.profile.garage[carId]) return { ok: false, reason: 'Tu possèdes déjà cette voiture' };
    if (this.repLevel < spec.repLevel) return { ok: false, reason: `Niveau REP ${spec.repLevel} requis` };
    if (this.profile.money < spec.price) return { ok: false, reason: 'Fonds insuffisants' };
    this.profile.money -= spec.price;
    this.profile.garage = { ...this.profile.garage, [carId]: newOwnedCar(carId) };
    this.profile.currentCarId = carId;
    this.commit();
    return { ok: true };
  }

  selectCar(carId: string): ActionResult {
    if (!this.profile.garage[carId]) return { ok: false, reason: 'Voiture non possédée' };
    this.profile.currentCarId = carId;
    this.commit();
    return { ok: true };
  }

  buyUpgrade(part: TunePart, level: TuneLevel): ActionResult {
    const car = this.currentCar;
    const spec = getCarSpec(car.carId);
    const current = car.tuning[part];
    if (level <= current) return { ok: false, reason: 'Amélioration déjà installée' };
    if (level !== current + 1) return { ok: false, reason: 'Installe d’abord le niveau précédent' };
    if (this.repLevel < TUNE_LEVEL_REP[level]) return { ok: false, reason: `Niveau REP ${TUNE_LEVEL_REP[level]} requis` };
    const price = upgradePrice(spec, part, level);
    if (this.profile.money < price) return { ok: false, reason: 'Fonds insuffisants' };
    this.profile.money -= price;
    const tuning: TuningState = { ...car.tuning, [part]: level };
    this.profile.garage = { ...this.profile.garage, [car.carId]: { ...car, tuning } };
    this.commit();
    return { ok: true };
  }

  buyVisuals(visuals: CarVisuals): ActionResult {
    const car = this.currentCar;
    if (visualsEqual(car.visuals, visuals)) return { ok: false, reason: 'Aucune modification' };
    const price = visualsPrice(car.visuals, visuals);
    if (this.profile.money < price) return { ok: false, reason: 'Fonds insuffisants' };
    this.profile.money -= price;
    this.profile.garage = { ...this.profile.garage, [car.carId]: { ...car, visuals: { ...visuals } } };
    this.commit();
    return { ok: true };
  }

  setCarHeat(heat: number): void {
    const car = this.currentCar;
    const h = clamp(Math.round(heat), 1, 5);
    if (car.heat === h) return;
    this.profile.garage = { ...this.profile.garage, [car.carId]: { ...car, heat: h } };
    this.commit();
  }

  eventRecord(id: string): EventRecord | null {
    return this.profile.events[id] ?? null;
  }
}

// -----------------------------------------------------------------------------
// Race session
// -----------------------------------------------------------------------------

export interface SessionHost {
  world: CityWorld;
  ai: AIHost;
  raceAI: IRaceAI;
  traffic: ITrafficSystem;
  store: UIStore;
  telemetry: Telemetry;
  audio: IGameAudio;
  progression: Progression;
  /** Teleport the player (resets the vehicle and snaps the camera). */
  placePlayer(x: number, z: number, heading: number): void;
}

export type SessionPhase = 'countdown' | 'racing' | 'finishing' | 'done';

export interface GateVisual extends GateDef {
  look: 'next' | 'upcoming' | 'finish' | 'speedtrap' | 'hidden';
}

interface Racer {
  name: string;
  isPlayer: boolean;
  handle: VehicleHandle;
  /** unwrapped arc-length along the route */
  u: number;
  lastS: number;
  finished: boolean;
  finishTimeMs: number;
  /** speed-trap bookkeeping */
  trapIndex: number;
  trapTotal: number;
  proj: PathProjection;
}

const RIVAL_POOLS: string[][] = [
  ['kaido', 'volta'],
  ['kaido', 'volta', 'brutus'],
  ['brutus', 'adler', 'kaido'],
  ['adler', 'raijin', 'brutus'],
  ['raijin', 'tempesta', 'spectre'],
];
const RIVAL_TUNING: TuneLevel[][] = [
  [0, 0],
  [0, 1],
  [1, 2],
  [2, 2],
  [2, 3],
];
const RIVAL_SKILL: [number, number][] = [
  [0.42, 0.62],
  [0.5, 0.7],
  [0.6, 0.8],
  [0.7, 0.88],
  [0.8, 0.97],
];
const RUBBER_BAND = [0.75, 0.65, 0.55, 0.5, 0.42];

const DRIFT_BASE_RATE = 260; // points per second at 30° / 80 km/h
const COMBO_GRACE = 1.6; // seconds without drifting before the combo is banked

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function activeEventInfo(built: BuiltEvent): ActiveEventInfo {
  const d = built.def;
  const hints: Record<string, string> = {
    sprint: 'Franchis la ligne d’arrivée en tête.',
    circuit: `Termine les ${d.laps} tours en première position.`,
    drift: 'Glisse le plus longtemps possible : angle, vitesse et enchaînements font grimper le multiplicateur.',
    drag: 'Monte en régime pour le départ, puis passe chaque rapport (E) dans la zone verte. Surveille la température !',
    speedtrap: 'Passe devant chaque radar le plus vite possible : c’est le cumul des vitesses qui compte.',
  };
  return {
    id: d.id,
    name: d.name,
    mode: d.mode,
    modeLabel: MODE_INFO[d.mode].label,
    laps: d.laps,
    totalCheckpoints: built.gates.length * d.laps,
    racers: d.rivals + 1,
    hint: hints[d.mode],
    targets: d.targets ?? null,
  };
}

export class RaceSession {
  readonly built: BuiltEvent;
  phase: SessionPhase = 'countdown';
  /** Checkpoint / trap gates to display. `gatesVersion` changes whenever looks change. */
  gates: GateVisual[] = [];
  gatesVersion = 0;
  results: EventResults | null = null;
  /** true once `results` has been produced and rewards were granted */
  get done(): boolean {
    return this.phase === 'done';
  }

  private readonly host: SessionHost;
  private readonly racers: Racer[] = [];
  private player!: Racer;
  private countdown = 3.4;
  private lastCountdownShown = 4;
  private goFlash = 0;
  private timeMs = 0;
  private lapStartMs = 0;
  private bestLapMs = 0;
  private lap = 1;
  private gateIndex = 0; // index in built.gates of the next gate (within the lap)
  private gatesPassed = 0;
  private gateAlong = -1;
  private finishOrder = 0;
  private firstFinishMs = -1;
  private standingsTimer = 0;
  private wrongWayTimer = 0;
  private finishTimer = 0;
  private failReason: string | null = null;
  private impacts = 0;
  private perfectLaunch = false;
  private perfectShifts = 0;
  private savedManual = false;
  private laneOffset = 0;
  // drift
  private driftScore = 0;
  private driftCombo = 0;
  private driftMult = 1;
  private driftComboTime = 0;
  private driftGrace = 0;
  private driftLastSign = 0;
  private wallBonusTimer = 0;
  private bestCombo = 0;
  private readonly colliderBuf: StaticCollider[] = [];

  constructor(host: SessionHost, built: BuiltEvent) {
    this.host = host;
    this.built = built;
  }

  get def() {
    return this.built.def;
  }

  // ---------------------------------------------------------------- setup

  begin(): void {
    const { host, built } = this;
    const def = built.def;
    const route = built.route;
    const record = host.progression.eventRecord(def.id);
    const rng = mulberry32(hashString(def.id) + (record?.attempts ?? 0) * 7919);

    host.raceAI.clear();
    host.traffic.setDensity(def.traffic * host.progression.profile.settings.trafficDensity * 1.4);
    host.traffic.clearAround(built.start.x, built.start.z, 140);

    // --- grid slots (behind the start line)
    const n = def.rivals + 1;
    const slots: { s: number; offset: number }[] = [];
    if (def.mode === 'drag') {
      const laneW = Math.min(5, (built.halfWidth * 2 - 3) / 4);
      const lanes = [-1.5, -0.5, 0.5, 1.5].map((k) => k * laneW);
      const order = [1, 2, 0, 3];
      for (let i = 0; i < n; i++) slots.push({ s: built.startS - 4, offset: lanes[order[i % 4]] });
    } else {
      const col = Math.min(2.7, built.halfWidth * 0.45);
      for (let i = 0; i < n; i++) {
        const row = Math.floor(i / 2);
        slots.push({ s: built.startS - 5 - row * 9, offset: i % 2 === 0 ? -col : col });
      }
    }
    const slotPose = (slot: { s: number; offset: number }) => {
      const pt = route.pointAt(slot.s);
      const h = route.headingAt(slot.s);
      // right(h) = (-cos h, sin h)
      return { x: pt.x - Math.cos(h) * slot.offset, z: pt.z + Math.sin(h) * slot.offset, heading: h };
    };

    // --- player: last slot on the grid (first lane in drag)
    const playerSlot = def.mode === 'drag' ? slots[0] : slots[n - 1];
    const pp = slotPose(playerSlot);
    host.placePlayer(pp.x, pp.z, pp.heading);
    const pv = host.ai.player.vehicle;
    pv.repair();
    this.savedManual = pv.manualGearbox;
    if (def.mode === 'drag') pv.manualGearbox = true;
    pv.holdAtLine = true;
    this.laneOffset = playerSlot.offset;
    this.player = this.makeRacer('Toi', true, host.ai.player);
    this.racers.push(this.player);

    // --- rivals
    if (def.rivals > 0) {
      const tier = def.difficulty - 1;
      const pool = RIVAL_POOLS[tier];
      const names = RIVAL_NAMES.slice();
      const setups: RivalSetup[] = [];
      const rivalSlots = def.mode === 'drag' ? slots.slice(1) : slots.slice(0, n - 1);
      for (let i = 0; i < def.rivals; i++) {
        const spec = getCarSpec(pool[Math.floor(rng() * pool.length)]);
        const level = RIVAL_TUNING[tier][rng() < 0.5 ? 0 : 1];
        const tuning: TuningState = {
          engine: level,
          turbo: level,
          transmission: level,
          suspension: level,
          brakes: level,
          tires: level,
          nitro: level,
        };
        const t = def.rivals > 1 ? 1 - i / (def.rivals - 1) : 1;
        const [lo, hi] = RIVAL_SKILL[tier];
        const skill = lerp(lo, hi, t) + (rng() - 0.5) * 0.04;
        const name = names.splice(Math.floor(rng() * names.length), 1)[0];
        const visuals: CarVisuals = {
          ...spec.defaultVisuals,
          paintColor: PAINT_COLORS[Math.floor(rng() * PAINT_COLORS.length)].hex,
          paintFinish: rng() < 0.5 ? 'metallic' : rng() < 0.6 ? 'pearl' : 'matte',
          rimStyle: Math.floor(rng() * 6),
          rimColor: RIM_COLORS[Math.floor(rng() * RIM_COLORS.length)].hex,
          spoiler: Math.min(4, Math.floor(rng() * (2 + tier))),
          bodyKit: Math.min(3, Math.floor(rng() * (1 + tier))),
          neonColor: rng() < 0.45 ? ['#00e5ff', '#ff2d95', '#39ff14', '#a020ff', '#ff7a00'][Math.floor(rng() * 5)] : null,
          windowTint: Math.floor(rng() * 4),
        };
        const pose = slotPose(rivalSlots[i]);
        setups.push({
          name,
          config: host.ai.buildConfig(spec, tuning),
          tag: { type: 'rival', name, carId: spec.id, visuals },
          skill: clamp(skill, 0.2, 0.99),
          aggression: clamp(0.3 + rng() * 0.6, 0, 1),
          x: pose.x,
          z: pose.z,
          heading: pose.heading,
          laneOffset: rivalSlots[i].offset,
        });
      }
      host.raceAI.setup(
        {
          mode: def.mode,
          route,
          halfWidth: built.halfWidth,
          laps: def.closed ? def.laps : 1,
          rubberBand: def.mode === 'drag' ? 0.25 : RUBBER_BAND[tier],
        },
        setups,
      );
      host.raceAI.setRacing(false);
      for (const r of host.raceAI.rivals) this.racers.push(this.makeRacer(r.name, false, r.handle));
    }

    if (built.gates.length > 0) this.gateAlong = this.gateAlongOf(built.gates[0]);
    this.refreshGates();
    this.writeStaticTelemetry();
    this.updateStandings(true);
  }

  private makeRacer(name: string, isPlayer: boolean, handle: VehicleHandle): Racer {
    const st = handle.vehicle.state;
    const proj = this.built.route.project(st.x, st.z, this.built.startS - 20, 60);
    return {
      name,
      isPlayer,
      handle,
      u: proj.s,
      lastS: proj.s,
      finished: false,
      finishTimeMs: 0,
      trapIndex: 0,
      trapTotal: 0,
      proj,
    };
  }

  private writeStaticTelemetry(): void {
    const r = this.host.telemetry.race;
    const def = this.def;
    r.active = true;
    r.mode = def.mode;
    r.countdown = 3;
    r.position = this.racers.length;
    r.racers = this.racers.length;
    r.lap = 1;
    r.laps = def.laps;
    r.checkpoint = 0;
    r.checkpoints = this.built.gates.length * def.laps;
    r.timeMs = 0;
    r.lapTimeMs = 0;
    r.bestLapMs = 0;
    r.timeLeftMs = def.mode === 'drift' ? (def.timeLimit ?? 90) * 1000 : -1;
    r.progress = 0;
    r.wrongWay = false;
    r.driftScore = 0;
    r.driftCombo = 0;
    r.driftMultiplier = 1;
    r.driftAngle = 0;
    r.driftComboTimer = 0;
    r.trapTotal = 0;
    r.trapLast = 0;
    r.trapsPassed = 0;
    r.trapsTotal = this.built.traps.length;
    r.dragDistance = 0;
    r.dragLength = this.built.lengthM;
    this.host.telemetry.route = this.built.route.points;
    this.host.telemetry.routeIsGps = false;
  }

  private refreshGates(): void {
    const { built } = this;
    const def = built.def;
    const out: GateVisual[] = [];
    const lastLap = this.lap >= def.laps;
    if (def.mode !== 'drift' || !def.closed) {
      for (let i = 0; i < built.gates.length; i++) {
        const g = built.gates[i];
        const isLine = i === built.gates.length - 1;
        let look: GateVisual['look'] = 'hidden';
        if (i === this.gateIndex) look = isLine && lastLap ? 'finish' : 'next';
        else if (i === this.gateIndex + 1) look = isLine && lastLap ? 'finish' : 'upcoming';
        else if (isLine && lastLap) look = 'finish';
        if (def.mode === 'drag') look = 'finish';
        out.push({ ...g, look });
      }
    }
    for (let i = 0; i < built.traps.length; i++) {
      out.push({ ...built.traps[i], look: i >= (this.player?.trapIndex ?? 0) ? 'speedtrap' : 'hidden' });
    }
    this.gates = out;
    this.gatesVersion++;
  }

  // ---------------------------------------------------------------- input

  /** Called before every physics step with the player's input. */
  modifyInput(input: DriveInput): void {
    const def = this.def;
    if (this.phase === 'finishing' || this.phase === 'done') {
      // coast to a stop; never hold the brake at standstill (the gearbox would select reverse)
      const rolling = this.host.ai.player.vehicle.state.speed > 1.5;
      input.throttle = 0;
      input.nitro = false;
      input.brake = rolling ? 0.6 : 0;
      input.handbrake = !rolling;
      if (def.mode === 'drag') input.steer = this.laneSteer();
      return;
    }
    if (def.mode === 'drag') {
      input.steer = this.laneSteer();
      input.handbrake = false;
      if (this.phase === 'racing') input.brake = 0; // no reversing on the strip
    }
  }

  /** Lane-keeping steering for drag racing. */
  private laneSteer(): number {
    const st = this.host.ai.player.vehicle.state;
    const route = this.built.route;
    const proj = route.project(st.x, st.z, this.player.lastS, 40, this.player.proj);
    const lateral = proj.side - this.laneOffset; // > 0: too far right
    const headingErr = angleDiff(route.headingAt(proj.s), st.heading); // > 0: pointing left of the lane
    return clamp(-0.28 * lateral + 2.6 * headingErr - 0.15 * st.yawRate, -1, 1);
  }

  onPlayerEvent(e: VehicleEvent): void {
    if (this.phase !== 'racing' && this.phase !== 'countdown') return;
    switch (e.type) {
      case 'impact':
        if (e.intensity > 3.5) {
          this.impacts++;
          if (this.def.mode === 'drift' && this.driftCombo > 0 && e.intensity > 4.5) this.loseCombo();
        }
        break;
      case 'launch':
        if (e.quality === 'perfect') this.perfectLaunch = true;
        break;
      case 'shift':
        if (e.quality === 'perfect') this.perfectShifts++;
        break;
      case 'engineBlown':
        if (this.phase === 'racing') this.fail('Moteur cassé !');
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- update

  update(dt: number): void {
    const { host } = this;
    const race = host.telemetry.race;

    if (this.phase === 'countdown') {
      this.countdown -= dt;
      const shown = Math.ceil(this.countdown - 0.4);
      if (shown !== this.lastCountdownShown && shown >= 1 && shown <= 3) {
        this.lastCountdownShown = shown;
        race.countdown = shown;
        host.audio.playUi('countdown');
      }
      if (this.countdown <= 0.4) {
        this.phase = 'racing';
        race.countdown = 0;
        this.goFlash = 1.1;
        host.audio.playUi('go');
        host.ai.player.vehicle.holdAtLine = false;
        host.raceAI.setRacing(true);
        host.store.set({ screen: 'race' });
      }
      this.trackRacers();
      return;
    }

    if (this.goFlash > 0) {
      this.goFlash -= dt;
      if (this.goFlash <= 0) race.countdown = -1;
    }

    if (this.phase === 'racing') {
      this.timeMs += dt * 1000;
      race.timeMs = this.timeMs;
      race.lapTimeMs = this.timeMs - this.lapStartMs;
    }

    this.trackRacers();
    host.raceAI.update(dt, this.player.u);

    if (this.phase === 'racing') {
      this.updatePlayerGates();
      this.updateWrongWay(dt);
      if (this.def.mode === 'drift') this.updateDrift(dt);
      if (this.def.mode === 'speedtrap') this.updateTrapDecay(dt);
      if (this.def.mode === 'drag') race.dragDistance = clamp(this.player.u - this.built.startS, 0, this.built.lengthM);
      this.checkTimeouts();
    }

    this.standingsTimer -= dt;
    if (this.standingsTimer <= 0) this.updateStandings(false);

    if (this.phase === 'finishing') {
      this.finishTimer -= dt;
      if (this.finishTimer <= 0) this.conclude();
    }
  }

  /** Signed distance of the player along a gate's travel direction (< 0 = before the gate). */
  private gateAlongOf(g: GateDef): number {
    const st = this.host.ai.player.vehicle.state;
    return (st.x - g.x) * Math.sin(g.heading) + (st.z - g.z) * Math.cos(g.heading);
  }

  private finishDistance(): number {
    return this.built.startS + this.built.lengthM;
  }

  private trackRacers(): void {
    const route = this.built.route;
    const L = route.length;
    for (const r of this.racers) {
      const st = r.handle.vehicle.state;
      const hintWindow = r.isPlayer ? 140 : 90;
      let proj = route.project(st.x, st.z, r.lastS, hintWindow, r.proj);
      if (proj.dist > this.built.halfWidth + 45) {
        // lost around the hint: look for the car anywhere on the route
        proj = route.project(st.x, st.z, undefined, 0, r.proj);
        if (proj.dist > this.built.halfWidth + 25) continue; // really off the route: freeze progress
      }
      let ds = proj.s - r.lastS;
      if (route.closed) {
        if (ds > L / 2) ds -= L;
        else if (ds < -L / 2) ds += L;
      }
      r.u += ds;
      r.lastS = proj.s;

      if (this.phase !== 'racing' || r.finished) continue;

      // speed traps
      if (this.def.mode === 'speedtrap') {
        const traps = this.built.traps;
        while (r.trapIndex < traps.length && r.u >= traps[r.trapIndex].s) {
          const speed = st.speedKmh;
          r.trapTotal += speed;
          r.trapIndex++;
          if (r.isPlayer) {
            const race = this.host.telemetry.race;
            race.trapLast = speed;
            race.trapTotal = r.trapTotal;
            race.trapsPassed = r.trapIndex;
            this.host.audio.playUi('speedtrap');
            this.host.store.emit({ type: 'speedtrap', speedKmh: speed, index: r.trapIndex });
            this.refreshGates();
          }
        }
      }

      // rivals finish by distance; the player finishes through the gates
      if (!r.isPlayer && this.def.mode !== 'drift' && r.u >= this.finishDistance()) {
        r.finished = true;
        r.finishTimeMs = this.timeMs;
        this.finishOrder++;
        if (this.firstFinishMs < 0) {
          this.firstFinishMs = this.timeMs;
          if (this.def.mode !== 'drag') {
            this.host.store.emit({
              type: 'banner',
              title: `${r.name} a franchi la ligne`,
              subtitle: 'Termine dans les 40 secondes !',
              tone: 'bad',
            });
          }
        }
        const rival = this.host.raceAI.rivals.find((x) => x.handle === r.handle);
        if (rival) rival.finished = true;
      }
    }
  }

  private updatePlayerGates(): void {
    const { built, player } = this;
    const def = built.def;
    const race = this.host.telemetry.race;
    const gates = built.gates;
    const totalGates = gates.length * def.laps;

    if (def.mode === 'drift' && def.closed) {
      race.progress = clamp01(this.timeMs / ((def.timeLimit ?? 90) * 1000));
      return;
    }

    // unwrapped position of the next gate
    const lapsDone = this.lap - 1;
    const g = gates[this.gateIndex];
    const isLine = this.gateIndex === gates.length - 1;
    const gateU = def.closed
      ? lapsDone * built.route.length + (isLine ? built.startS + built.route.length : g.s)
      : g.s;

    // a gate is validated by physically crossing its plane (no shortcut through side streets)
    const along = this.gateAlongOf(g);
    const st = player.handle.vehicle.state;
    const lateral = -(st.x - g.x) * Math.cos(g.heading) + (st.z - g.z) * Math.sin(g.heading);
    const crossed = this.gateAlong < 0 && along >= 0 && Math.abs(lateral) < g.width * 0.5 + 8;
    this.gateAlong = along;
    if (crossed) {
      player.u = Math.max(player.u, gateU);
      this.gatesPassed++;
      race.checkpoint = this.gatesPassed;
      if (isLine) {
        const lapMs = this.timeMs - this.lapStartMs;
        const best = this.bestLapMs === 0 || lapMs < this.bestLapMs;
        if (best) this.bestLapMs = lapMs;
        race.bestLapMs = this.bestLapMs;
        if (this.lap >= def.laps) {
          this.finishPlayer();
          return;
        }
        this.lap++;
        this.lapStartMs = this.timeMs;
        race.lap = this.lap;
        this.gateIndex = 0;
        this.host.audio.playUi('lap');
        this.host.store.emit({ type: 'lap', lap: this.lap, laps: def.laps, lapTimeMs: lapMs, best });
      } else {
        this.gateIndex++;
        this.host.audio.playUi('checkpoint');
        this.host.store.emit({ type: 'checkpoint', index: this.gatesPassed, total: totalGates, splitMs: this.timeMs });
      }
      this.gateAlong = this.gateAlongOf(gates[this.gateIndex]);
      this.refreshGates();
    } else if (player.u > gateU) {
      // progress cannot run past a gate that was not crossed
      player.u = gateU;
    }
    race.progress = clamp01((player.u - built.startS) / built.lengthM);
  }

  private updateWrongWay(dt: number): void {
    const st = this.host.ai.player.vehicle.state;
    const race = this.host.telemetry.race;
    if (this.def.mode === 'drift' && this.def.closed) {
      race.wrongWay = false;
      return;
    }
    const routeHeading = this.built.route.headingAt(this.player.lastS);
    const wrong = Math.abs(angleDiff(routeHeading, st.heading)) > 2.0 && st.speed > 6;
    this.wrongWayTimer = wrong ? this.wrongWayTimer + dt : 0;
    race.wrongWay = this.wrongWayTimer > 1.2;
  }

  private checkTimeouts(): void {
    const def = this.def;
    const race = this.host.telemetry.race;
    if (def.mode === 'drift') {
      const left = (def.timeLimit ?? 90) * 1000 - this.timeMs;
      race.timeLeftMs = Math.max(0, left);
      if (left <= 0) this.finishPlayer();
      return;
    }
    if (this.firstFinishMs >= 0 && def.mode !== 'drag') {
      const left = 40000 - (this.timeMs - this.firstFinishMs);
      race.timeLeftMs = Math.max(0, left);
      if (left <= 0) this.fail('Temps écoulé');
    } else if (def.mode === 'drag' && this.firstFinishMs >= 0 && this.timeMs - this.firstFinishMs > 12000) {
      this.fail('Temps écoulé');
    }
  }

  // ---------------------------------------------------------------- drift

  private updateDrift(dt: number): void {
    const st = this.host.ai.player.vehicle.state;
    const race = this.host.telemetry.race;
    this.wallBonusTimer -= dt;
    const drifting = st.drifting && st.grounded && st.speedKmh > 30;
    if (drifting) {
      const angle = clamp(st.driftAngleDeg / 30, 0.4, 2.2);
      const speed = clamp(st.speedKmh / 80, 0.3, 2.6);
      let rate = DRIFT_BASE_RATE * angle * speed;
      // wall proximity bonus: a solid obstacle within reach of the tail
      const reach = 3.4;
      const tx = st.x - Math.sin(st.heading) * 1.6;
      const tz = st.z - Math.cos(st.heading) * 1.6;
      const count = this.host.world.queryColliders(tx, tz, reach, this.colliderBuf);
      let near = false;
      for (let i = 0; i < count; i++) {
        const c = this.colliderBuf[i];
        if (c.soft || c.yMax < st.y + 0.4) continue;
        if (distanceToCollider(c, tx, tz) < 2.3) {
          near = true;
          break;
        }
      }
      if (near) {
        rate *= 1.6;
        if (this.wallBonusTimer <= 0) {
          this.wallBonusTimer = 2.5;
          this.driftCombo += 250;
          this.host.store.emit({ type: 'wallBonus' });
        }
      }
      this.driftCombo += rate * dt;
      this.driftComboTime += dt;
      this.driftGrace = COMBO_GRACE;
      // chaining left/right transitions bumps the multiplier
      const sign = st.slipAngle > 0 ? 1 : -1;
      if (this.driftLastSign !== 0 && sign !== this.driftLastSign && st.driftAngleDeg > 14) {
        this.driftMult = Math.min(6, this.driftMult + 1);
      }
      this.driftLastSign = sign;
      const timeMult = 1 + Math.floor(this.driftComboTime / 2.6);
      if (timeMult > this.driftMult) this.driftMult = Math.min(6, timeMult);
    } else if (this.driftCombo > 0) {
      this.driftGrace -= dt;
      if (this.driftGrace <= 0) this.bankCombo();
    }
    race.driftScore = this.driftScore;
    race.driftCombo = this.driftCombo;
    race.driftMultiplier = this.driftMult;
    race.driftAngle = drifting ? st.driftAngleDeg : 0;
    race.driftComboTimer = this.driftCombo > 0 ? clamp01(this.driftGrace / COMBO_GRACE) : 0;
  }

  private bankCombo(): void {
    if (this.driftCombo <= 0) return;
    const points = Math.round(this.driftCombo * this.driftMult);
    this.driftScore += points;
    this.bestCombo = Math.max(this.bestCombo, points);
    if (points >= 200) {
      this.host.store.emit({ type: 'driftBank', points, multiplier: this.driftMult });
      this.host.audio.playUi('driftBank');
    }
    this.resetCombo();
  }

  private loseCombo(): void {
    const points = Math.round(this.driftCombo * this.driftMult);
    if (points >= 200) this.host.store.emit({ type: 'driftLost', points });
    this.resetCombo();
  }

  private resetCombo(): void {
    this.driftCombo = 0;
    this.driftMult = 1;
    this.driftComboTime = 0;
    this.driftGrace = 0;
    this.driftLastSign = 0;
    this.host.telemetry.race.driftScore = this.driftScore;
  }

  // ------------------------------------------------------------ speed trap

  private updateTrapDecay(dt: number): void {
    if (this.firstFinishMs < 0) return;
    for (const r of this.racers) {
      if (!r.finished) r.trapTotal = Math.max(0, r.trapTotal - 6 * dt);
    }
    this.host.telemetry.race.trapTotal = this.player.trapTotal;
  }

  // ------------------------------------------------------------- standings

  private rankValue(r: Racer): number {
    if (this.def.mode === 'speedtrap') return r.trapTotal;
    if (r.finished) return 1e9 - r.finishTimeMs;
    return r.u;
  }

  private sortedRacers(): Racer[] {
    return this.racers.slice().sort((a, b) => this.rankValue(b) - this.rankValue(a));
  }

  private updateStandings(force: boolean): void {
    this.standingsTimer = 0.2;
    const race = this.host.telemetry.race;
    const def = this.def;
    if (def.mode === 'drift') {
      race.position = 1;
      race.racers = 1;
      if (force) race.standings = [];
      return;
    }
    const sorted = this.sortedRacers();
    const leader = sorted[0];
    const rows: StandingRow[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const r = sorted[i];
      let detail = '';
      if (def.mode === 'speedtrap') detail = `${Math.round(r.trapTotal)} km/h`;
      else if (r.finished) detail = formatTime(r.finishTimeMs);
      else if (i === 0) detail = 'Leader';
      else detail = `+${Math.max(0, Math.round(leader.u - r.u))} m`;
      rows.push({ name: r.name, position: i + 1, isPlayer: r.isPlayer, detail, finished: r.finished });
      if (r.isPlayer) race.position = i + 1;
    }
    race.racers = sorted.length;
    race.standings = rows;
  }

  // ---------------------------------------------------------------- finish

  private finishPlayer(): void {
    if (this.phase !== 'racing') return;
    if (this.def.mode === 'drift') this.bankCombo();
    this.player.finished = true;
    this.player.finishTimeMs = this.timeMs;
    this.finishOrder++;
    if (this.firstFinishMs < 0) this.firstFinishMs = this.timeMs;
    this.phase = 'finishing';
    this.finishTimer = 2.6;
    this.updateStandings(true);
    this.host.audio.playUi('finish');
    this.host.store.emit({ type: 'banner', title: 'TERMINÉ !', subtitle: formatTime(this.timeMs), tone: 'good' });
    this.host.telemetry.race.timeLeftMs = -1;
    this.gates = this.gates.map((g) => ({ ...g, look: 'hidden' }));
    this.gatesVersion++;
  }

  private fail(reason: string): void {
    if (this.phase !== 'racing') return;
    this.failReason = reason;
    this.phase = 'finishing';
    this.finishTimer = 2.2;
    this.host.audio.playUi('lose');
    this.host.store.emit({ type: 'banner', title: reason, subtitle: 'Épreuve terminée', tone: 'bad' });
  }

  /** Abandon: produce a "not completed" result immediately (no reward). */
  abandon(): void {
    if (this.phase === 'done') return;
    this.failReason = 'Abandon';
    this.conclude();
  }

  private conclude(): void {
    if (this.phase === 'done') return;
    this.phase = 'done';
    const { host, built } = this;
    const def = built.def;
    const prog = host.progression;
    const completed = this.failReason === null;

    const sorted = this.sortedRacers();
    let position = sorted.indexOf(this.player) + 1;
    if (!completed) position = sorted.length;

    // --- score & medal
    let score: number | null = null;
    let scoreLabel: string | null = null;
    let medal: Medal | null = null;
    if (def.mode === 'drift') {
      score = Math.round(this.driftScore);
      scoreLabel = 'points';
    } else if (def.mode === 'speedtrap') {
      score = Math.round(this.player.trapTotal);
      scoreLabel = 'km/h cumulés';
    }
    if (completed && def.targets && score !== null) {
      if (score >= def.targets.gold) medal = 'gold';
      else if (score >= def.targets.silver) medal = 'silver';
      else if (score >= def.targets.bronze) medal = 'bronze';
    }
    const won = completed && (def.mode === 'drift' ? medal !== null : position === 1);

    // --- record
    const prev = prog.eventRecord(def.id);
    const record: EventRecord = prev
      ? { ...prev }
      : { attempts: 0, wins: 0, completed: false, bestTimeMs: null, bestScore: null, medal: null };
    const firstWin = won && record.wins === 0;
    record.attempts++;
    let newRecord = false;
    if (completed) {
      if (score !== null) {
        if (record.bestScore === null || score > record.bestScore) {
          newRecord = record.bestScore !== null;
          record.bestScore = score;
        }
      } else if (record.bestTimeMs === null || this.timeMs < record.bestTimeMs) {
        newRecord = record.bestTimeMs !== null;
        record.bestTimeMs = Math.round(this.timeMs);
      }
      const rank: Record<string, number> = { bronze: 1, silver: 2, gold: 3 };
      if (medal && (!record.medal || rank[medal] > rank[record.medal])) record.medal = medal;
    }
    if (won) {
      record.wins++;
      record.completed = true;
    }
    prog.profile.events = { ...prog.profile.events, [def.id]: record };
    prog.profile.stats.racesRun++;
    if (won) prog.profile.stats.racesWon++;
    if (def.mode === 'drift') prog.profile.stats.bestDrift = Math.max(prog.profile.stats.bestDrift, this.bestCombo);

    // --- rewards
    const baseMoney = REWARD_MONEY[def.difficulty - 1];
    const baseRep = REWARD_REP[def.difficulty - 1];
    let factor = 0;
    if (completed) {
      if (def.mode === 'drift') factor = medal === 'gold' ? 1 : medal === 'silver' ? 0.6 : medal === 'bronze' ? 0.35 : 0.05;
      else factor = position === 1 ? 1 : position === 2 ? 0.4 : position === 3 ? 0.2 : 0.05;
    }
    if (won && !firstWin) factor *= 0.5;
    const rewardMoney = Math.round((baseMoney * factor) / 10) * 10;
    const rewardRep = Math.round(baseRep * factor);
    const bonuses: { label: string; money: number; rep: number }[] = [];
    if (firstWin) bonuses.push({ label: 'Première victoire', money: Math.round(baseMoney * 0.5), rep: Math.round(baseRep * 0.5) });
    if (completed && won && this.impacts === 0 && def.mode !== 'drag') {
      bonuses.push({ label: 'Course propre', money: Math.round(baseMoney * 0.1), rep: Math.round(baseRep * 0.15) });
    }
    if (completed && this.perfectLaunch) bonuses.push({ label: 'Départ parfait', money: 150, rep: 20 });
    if (completed && def.mode === 'drag' && this.perfectShifts >= 3) {
      bonuses.push({ label: `${this.perfectShifts} passages parfaits`, money: 100 * this.perfectShifts, rep: 12 * this.perfectShifts });
    }
    if (completed && def.mode === 'speedtrap' && medal) {
      const k = medal === 'gold' ? 0.3 : medal === 'silver' ? 0.18 : 0.08;
      bonuses.push({ label: `Médaille ${medalName(medal)}`, money: Math.round(baseMoney * k), rep: Math.round(baseRep * k) });
    }
    if (newRecord) bonuses.push({ label: 'Nouveau record', money: 200, rep: 30 });

    let totalMoney = rewardMoney;
    let totalRep = rewardRep;
    for (const b of bonuses) {
      totalMoney += b.money;
      totalRep += b.rep;
    }
    prog.profile.money += totalMoney;
    const gain = prog.addRep(totalRep);
    prog.flush();

    // --- standings for the results screen
    const standings: StandingRow[] = sorted.map((r, i) => {
      let detail: string;
      if (def.mode === 'speedtrap') detail = `${Math.round(r.trapTotal)} km/h`;
      else if (def.mode === 'drift') detail = `${Math.round(this.driftScore).toLocaleString('fr-FR')} pts`;
      else if (r.finished) detail = formatTime(r.finishTimeMs);
      else detail = 'Non classé';
      return { name: r.name, position: i + 1, isPlayer: r.isPlayer, detail, finished: r.finished };
    });

    this.results = {
      eventId: def.id,
      name: def.name,
      mode: def.mode,
      modeLabel: MODE_INFO[def.mode].label,
      won,
      completed,
      failReason: this.failReason,
      position,
      racers: sorted.length,
      timeMs: this.timeMs,
      bestLapMs: def.closed && this.bestLapMs > 0 ? this.bestLapMs : null,
      score,
      scoreLabel,
      medal,
      standings,
      rewardMoney,
      rewardRep,
      bonuses,
      newRecord,
      repLevelUp: gain.levelUp,
      unlocked: gain.unlocked,
    };
    host.audio.playUi(won ? 'win' : 'lose');
  }

  // ---------------------------------------------------------------- misc

  /** Arc-length of the player's projection on the route (autopilot, respawn). */
  get playerRouteS(): number {
    return this.player.lastS;
  }

  /** Where to put the player back on track (R key, out of bounds). */
  getRespawnPose(): SpawnPoint {
    const route = this.built.route;
    const s = this.player.lastS;
    const pt = route.pointAt(s);
    return { x: pt.x, z: pt.z, heading: route.headingAt(s) };
  }

  /** Rivals' and checkpoint blips for the minimap. Returns the new blip count. */
  writeBlips(t: Telemetry, count: number): number {
    const put = (kind: 'rival' | 'checkpoint' | 'finish' | 'speedtrap', x: number, z: number, heading: number) => {
      let b = t.blips[count];
      if (!b) {
        b = { kind, x, z, heading };
        t.blips[count] = b;
      }
      b.kind = kind;
      b.x = x;
      b.z = z;
      b.heading = heading;
      count++;
    };
    for (const r of this.racers) {
      if (r.isPlayer) continue;
      const st = r.handle.vehicle.state;
      put('rival', st.x, st.z, st.heading);
    }
    for (const g of this.gates) {
      if (g.look === 'next') put('checkpoint', g.x, g.z, g.heading);
      else if (g.look === 'finish') put('finish', g.x, g.z, g.heading);
      else if (g.look === 'speedtrap') put('speedtrap', g.x, g.z, g.heading);
    }
    return count;
  }

  dispose(): void {
    const pv = this.host.ai.player.vehicle;
    pv.holdAtLine = false;
    pv.manualGearbox = this.savedManual;
    this.host.raceAI.clear();
    const race = this.host.telemetry.race;
    race.active = false;
    race.countdown = -1;
    race.wrongWay = false;
    race.standings = [];
    race.timeLeftMs = -1;
    this.host.telemetry.route = null;
    this.gates = [];
    this.gatesVersion++;
  }
}

function medalName(m: Medal): string {
  return m === 'gold' ? 'd’or' : m === 'silver' ? 'd’argent' : 'de bronze';
}

/** Distance from a point to the surface of a collider (0 when inside). */
export function distanceToCollider(c: StaticCollider, x: number, z: number): number {
  const dx = x - c.x;
  const dz = z - c.z;
  if (c.shape === 'circle') return Math.max(0, Math.hypot(dx, dz) - c.r);
  const cos = Math.cos(c.rot);
  const sin = Math.sin(c.rot);
  // world → box local: local X axis = (cos, -sin), local Z axis = (sin, cos)
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  const ox = Math.max(0, Math.abs(lx) - c.hx);
  const oz = Math.max(0, Math.abs(lz) - c.hz);
  return Math.hypot(ox, oz);
}
