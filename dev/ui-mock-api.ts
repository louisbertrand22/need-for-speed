/* Mock GameAPI for the UI playground: animated telemetry, mock map / markers / profile, working actions. */
import type {
  ActionResult,
  CarVisuals,
  EventMode,
  EventSummary,
  GameAPI,
  GameScreen,
  GameSettings,
  GameUiEvent,
  MapData,
  MapMarker,
  MapRoad,
  PerfStats,
  PlayerProfile,
  StandingRow,
  Telemetry,
  TuneLevel,
  TunePart,
  TuningState,
  UIState,
  Vec2,
} from '../src/core/types';
import { DISTRICTS, DISTRICT_RECTS, GARAGE_SPOT, WORLD_BOUNDS, ringPolyline } from '../src/core/layout';
import {
  GARAGE_COLOR,
  MODE_INFO,
  STOCK_TUNING,
  TUNE_EFFECTS,
  TUNE_LEVEL_REP,
  getCarSpec,
  repLevelBounds,
  repLevelFor,
  upgradePrice,
  visualsPrice,
} from '../src/game/catalog';

export interface MockOptions {
  screen: GameScreen;
  mode: EventMode;
  pursuit: boolean;
  map: boolean;
  paused: boolean;
  loading: boolean;
}

export interface MockApi extends GameAPI {
  /** every action call, for tests */
  calls: { name: string; args: unknown[] }[];
  step(dt: number): void;
}

// ----------------------------------------------------------------------------- map

function buildMap(): MapData {
  const roads: MapRoad[] = [];
  const inBay = (x: number, z: number) => x > 660 && z > 660;
  for (let g = -900; g <= 900; g += 150) {
    const kind = g % 450 === 0 ? 'avenue' : 'street';
    const w = kind === 'avenue' ? 18 : 10;
    const h: Vec2[] = [];
    const v: Vec2[] = [];
    for (let t = -1050; t <= 1050; t += 50) {
      if (!inBay(t, g)) h.push({ x: t, z: g });
      if (!inBay(g, t)) v.push({ x: g, z: t });
    }
    if (g > -450) roads.push({ points: h.filter((p) => p.x > -450 || g % 450 === 0), width: w, kind });
    roads.push({ points: g < -450 ? v.filter((p) => Math.abs(p.z) % 450 < 1 || p.z > 9999) : v, width: w, kind });
  }
  const ring = ringPolyline(20);
  roads.push({ points: [...ring, ring[0]], width: 26, kind: 'highway' });
  for (let k = 0; k < 3; k++) {
    const pts: Vec2[] = [];
    for (let t = 0; t <= 60; t++) pts.push({ x: -1040 + t * 9.6 + Math.sin(t * 0.35 + k) * 40, z: -820 + k * 520 + Math.sin(t * 0.22 + k * 2) * 130 });
    roads.push({ points: pts, width: 9, kind: 'hill' });
  }
  const water: Vec2[] = [];
  for (let t = 0; t <= 12; t++) water.push({ x: 700 + Math.sin(t * 0.9) * 40, z: 1300 - t * 52 });
  for (let t = 0; t <= 12; t++) water.push({ x: 700 + t * 50, z: 680 + Math.sin(t) * 30 });
  water.push({ x: 1300, z: 1300 });
  return {
    bounds: WORLD_BOUNDS,
    roads: roads.filter((r) => r.points.length > 1),
    districts: DISTRICT_RECTS.map((d) => ({
      id: d.id,
      name: DISTRICTS[d.id].name,
      color: DISTRICTS[d.id].color,
      polygon: [
        { x: d.rect.minX, z: d.rect.minZ },
        { x: d.rect.maxX, z: d.rect.minZ },
        { x: d.rect.maxX, z: d.rect.maxZ },
        { x: d.rect.minX, z: d.rect.maxZ },
      ],
      labelX: d.id === 'lantern' ? 420 : d.id === 'docks' ? 0 : (d.rect.minX + d.rect.maxX) / 2,
      labelZ: d.id === 'lantern' ? -820 : d.id === 'docks' ? 860 : (d.rect.minZ + d.rect.maxZ) / 2,
    })),
    water: [water],
    tunnels: [[{ x: -1118, z: -520 }, { x: -1082, z: -520 }, { x: -1082, z: 320 }, { x: -1118, z: 320 }]],
    bridges: [[{ x: 760, z: 1082 }, { x: 1082, z: 760 }, { x: 1118, z: 790 }, { x: 790, z: 1118 }]],
  };
}

const EVENT_DEFS: [string, EventMode, EventSummary['district'], number, number, number, number, number][] = [
  // name, mode, district, x, z, difficulty, repLevel, laps
  ['Avenue des Néons', 'sprint', 'downtown', -300, -150, 1, 1, 1],
  ['Traversée des Docks', 'sprint', 'docks', 150, 750, 3, 4, 1],
  ['Boucle Centrale', 'circuit', 'downtown', 300, 300, 2, 1, 3],
  ['Grand Prix Lanterne', 'circuit', 'lantern', 600, -600, 4, 9, 4],
  ['Lacets de Sélène', 'drift', 'hills', -760, -300, 2, 2, 1],
  ['Glisse des Quais', 'drift', 'docks', -150, 900, 4, 8, 1],
  ['Quart de mile', 'drag', 'docks', 450, 600, 2, 1, 1],
  ['Radars de l’Orbitale', 'speedtrap', 'highway', 0, -1100, 3, 3, 1],
  ['Tunnel Express', 'speedtrap', 'highway', -1100, 0, 5, 12, 1],
];

function buildMarkers(repLevel: number): MapMarker[] {
  const out: MapMarker[] = [{ id: 'garage', kind: 'garage', x: GARAGE_SPOT.x, z: GARAGE_SPOT.z, label: 'Garage — QG', color: GARAGE_COLOR, teleportable: true, event: null }];
  EVENT_DEFS.forEach(([name, mode, district, x, z, difficulty, rep, laps], i) => {
    const locked = repLevel < rep;
    const scoreMode = mode === 'drift' || mode === 'speedtrap';
    const event: EventSummary = {
      id: `ev${i}`,
      name,
      mode,
      modeLabel: MODE_INFO[mode].label,
      district,
      description: MODE_INFO[mode].blurb,
      difficulty,
      laps,
      lengthKm: 1.2 + i * 0.45,
      rivals: mode === 'drift' ? 0 : 3,
      repLevelRequired: rep,
      rewardMoney: 1500 * difficulty,
      rewardRep: 120 * difficulty,
      locked,
      record: i % 3 === 0 ? { attempts: 4, wins: 2, completed: true, bestTimeMs: scoreMode ? null : 83450, bestScore: scoreMode ? 45200 : null, medal: i === 0 ? 'gold' : 'silver' } : null,
      targets: mode === 'drift' ? { gold: 60000, silver: 35000, bronze: 15000 } : mode === 'speedtrap' ? { gold: 1100, silver: 950, bronze: 800 } : null,
    };
    out.push({ id: event.id, kind: 'event', x, z, label: name, color: MODE_INFO[mode].color, teleportable: !locked, event });
  });
  out.push({ id: 'breaker:1', kind: 'breaker', x: 300, z: -300, label: 'Château d’eau', color: '#ff5a3c', teleportable: false, event: null });
  out.push({ id: 'breaker:2', kind: 'breaker', x: -150, z: 520, label: 'Station-service', color: '#ff5a3c', teleportable: false, event: null });
  out.push({ id: 'ramp:1', kind: 'ramp', x: 600, z: 150, label: 'Rampe de saut', color: '#ffd000', teleportable: false, event: null });
  return out;
}

// ----------------------------------------------------------------------------- data

const SETTINGS: GameSettings = { transmission: 'auto', masterVolume: 0.8, musicVolume: 0.5, cameraMode: 'chaseNear', mirror: true, quality: 'high', units: 'kmh', speedLines: true, trafficDensity: 0.6 };

function mockProfile(): PlayerProfile {
  return {
    version: 1,
    money: 48250,
    rep: 7300,
    currentCarId: 'kaido',
    garage: {
      kaido: { carId: 'kaido', tuning: { ...STOCK_TUNING, engine: 2, turbo: 1, tires: 1, nitro: 2 }, visuals: { ...getCarSpec('kaido').defaultVisuals, neonColor: '#00e5ff', spoiler: 2 }, heat: 2 },
      volta: { carId: 'volta', tuning: { ...STOCK_TUNING }, visuals: getCarSpec('volta').defaultVisuals, heat: 1 },
    },
    events: {},
    stats: { racesRun: 42, racesWon: 27, pursuitsEvaded: 13, timesBusted: 3, totalBounty: 184500, copsDisabled: 21, breakersUsed: 4, nearMisses: 312, bestDrift: 48750, topSpeedKmh: 287, distanceKm: 412.6, maxHeat: 4, playTimeS: 13320 },
    settings: { ...SETTINGS },
  };
}

function perfStats(carId: string, t: TuningState): PerfStats {
  const s = getCarSpec(carId);
  const pw = TUNE_EFFECTS.engine.power[t.engine] * (1 + TUNE_EFFECTS.turbo.boost[t.turbo] * 0.8);
  const powerHp = Math.round(s.powerHp * pw);
  const top = s.topSpeedKmh * TUNE_EFFECTS.transmission.topSpeed[t.transmission] * Math.cbrt(pw);
  const ratio = powerHp / s.massKg;
  const zero = Math.max(1.9, 1.6 + 0.78 / ratio / TUNE_EFFECTS.tires.grip[t.tires] - t.transmission * 0.12);
  const c = (v: number) => Math.max(4, Math.min(100, v));
  const bars = {
    barTopSpeed: c(((top - 170) / 250) * 100),
    barAcceleration: c(118 - zero * 14),
    barHandling: c(s.grip * TUNE_EFFECTS.tires.grip[t.tires] * 46 + s.agility * 22 + t.suspension * 5),
    barBraking: c(s.brakeG * TUNE_EFFECTS.brakes.force[t.brakes] * 46),
    barNitro: c(22 + t.nitro * 25),
  };
  return {
    powerHp,
    torqueNm: Math.round(s.torqueNm * pw),
    massKg: s.massKg,
    topSpeedKmh: Math.round(top),
    zeroToHundred: zero,
    ...bars,
    rating: c(bars.barTopSpeed * 0.3 + bars.barAcceleration * 0.3 + bars.barHandling * 0.25 + bars.barBraking * 0.1 + bars.barNitro * 0.05),
  };
}

function loopPath(): Vec2[] {
  const pts: Vec2[] = [];
  const C = 450;
  const R = 70;
  const corner = (cx: number, cz: number, a0: number) => {
    for (let i = 0; i <= 10; i++) {
      const a = a0 + (i / 10) * (Math.PI / 2);
      pts.push({ x: cx + Math.cos(a) * R, z: cz + Math.sin(a) * R });
    }
  };
  for (let x = -C + R; x < C - R; x += 10) pts.push({ x, z: -C });
  corner(C - R, -C + R, -Math.PI / 2);
  for (let z = -C + R; z < C - R; z += 10) pts.push({ x: C, z });
  corner(C - R, C - R, 0);
  for (let x = C - R; x > -C + R; x -= 10) pts.push({ x, z: C });
  corner(-C + R, C - R, Math.PI / 2);
  for (let z = C - R; z > -C + R; z -= 10) pts.push({ x: -C, z });
  corner(-C + R, -C + R, Math.PI);
  return pts;
}

// ----------------------------------------------------------------------------- api

export function createMockApi(opts: MockOptions): MockApi {
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(e: GameUiEvent) => void>();
  const calls: MockApi['calls'] = [];
  const mapData = buildMap();
  const path = loopPath();
  let profile = mockProfile();
  let toastId = 1;

  const level = () => repLevelFor(profile.rep);
  const derived = () => {
    const b = repLevelBounds(level());
    return { profile, repLevel: level(), repLevelFloor: b.floor, repLevelCeil: b.ceil, markers: buildMarkers(level()) };
  };
  const eventInfo = (mode: EventMode): UIState['activeEvent'] => ({
    id: `ev-${mode}`,
    name: EVENT_DEFS.find((e) => e[1] === mode)?.[0] ?? 'Épreuve',
    mode,
    modeLabel: MODE_INFO[mode].label,
    laps: mode === 'circuit' ? 3 : 1,
    totalCheckpoints: 9,
    racers: mode === 'drift' ? 1 : 4,
    hint: mode === 'drag' ? 'Passe les rapports dans la zone verte' : mode === 'drift' ? 'Enchaîne les glisses pour faire grimper le multiplicateur' : 'Reste sur le tracé et dose la nitro',
    targets: mode === 'drift' ? { gold: 60000, silver: 35000, bronze: 15000 } : mode === 'speedtrap' ? { gold: 1100, silver: 950, bronze: 800 } : null,
  });
  const standingsFor = (swap: boolean): StandingRow[] => {
    const names = swap ? ['Vex', 'Toi', 'Mako', 'Lynx'] : ['Toi', 'Vex', 'Lynx', 'Mako'];
    return names.map((name, i) => ({ name, position: i + 1, isPlayer: name === 'Toi', detail: i === 0 ? 'Leader' : `+${(i * 1.37).toFixed(2)} s`, finished: false }));
  };

  const racing = opts.screen === 'race' || opts.screen === 'countdown';
  let state: UIState = {
    screen: opts.screen,
    paused: opts.paused,
    mapOpen: opts.map,
    loading: opts.loading,
    loadingLabel: 'Génération de Port-Sélène…',
    ...derived(),
    prompt: opts.screen === 'freeroam' && !opts.pursuit ? { key: 'E', title: 'Entrer dans le garage', subtitle: 'Tuning, peinture et nouvelles voitures', markerId: 'garage', locked: false } : null,
    activeEvent: racing || opts.screen === 'results' ? eventInfo(opts.mode) : null,
    results:
      opts.screen === 'results'
        ? {
            eventId: 'ev2',
            name: 'Boucle Centrale',
            mode: opts.mode,
            modeLabel: MODE_INFO[opts.mode].label,
            won: true,
            completed: true,
            failReason: null,
            position: 1,
            racers: 4,
            timeMs: 163420,
            bestLapMs: 52310,
            score: opts.mode === 'drift' ? 64250 : null,
            scoreLabel: opts.mode === 'drift' ? 'Score de drift' : null,
            medal: opts.mode === 'drift' ? 'gold' : null,
            standings: standingsFor(false).map((r, i) => ({ ...r, detail: `2:4${3 + i}.${420 + i * 137}`, finished: true })),
            rewardMoney: 3000,
            rewardRep: 240,
            bonuses: [
              { label: 'Première victoire', money: 1500, rep: 120 },
              { label: 'Course propre', money: 300, rep: 36 },
              { label: 'Nouveau record', money: 200, rep: 30 },
            ],
            newRecord: true,
            repLevelUp: 8,
            unlocked: ['Raijin XR Twin-Turbo', 'Glisse des Quais'],
          }
        : null,
    busted:
      opts.screen === 'busted'
        ? { fine: 6400, heat: 4, bounty: 28750, durationS: 214, infractions: [{ label: 'Excès de vitesse', count: 12 }, { label: 'Véhicules de police percutés', count: 5 }, { label: 'Dégradations', count: 8 }, { label: 'Conduite dangereuse', count: 3 }] }
        : null,
    toasts: opts.screen === 'freeroam' ? [{ id: toastId++, kind: 'district', title: 'Néon Central', text: 'Gratte-ciels, néons et avenues' }, { id: toastId++, kind: 'reward', title: 'Frôlements ×5', text: '+250 $ · nitro rechargée' }] : [],
    gpsTargetId: opts.screen === 'freeroam' ? 'ev2' : null,
    district: 'downtown',
    garageCarId: 'kaido',
    garagePreview: null,
  };

  const set = (patch: Partial<UIState>) => {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  };
  const commit = () => {
    profile = { ...profile };
    set(derived());
  };
  const emit = (e: GameUiEvent) => eventListeners.forEach((l) => l(e));
  const fail = (reason: string): ActionResult => ({ ok: false, reason });
  const log = (name: string, ...args: unknown[]) => calls.push({ name, args });

  const telemetry: Telemetry = {
    speedKmh: 0,
    rpm: 900,
    redlineRpm: 7600,
    maxRpm: 9000,
    gear: 1,
    manual: opts.mode === 'drag' && racing,
    shiftLight: 'none',
    perfectShiftLo: 6900,
    perfectShiftHi: 7500,
    nitro: 1,
    nitroActive: false,
    turbo: 0,
    engineTemp: 0.3,
    damage: 0.12,
    drifting: false,
    speedFx: 0,
    x: -300,
    z: -450,
    heading: Math.PI / 2,
    blips: [],
    blipCount: 0,
    route: racing ? path : null,
    routeIsGps: false,
    race: {
      active: opts.screen === 'race',
      mode: opts.mode,
      countdown: opts.screen === 'countdown' ? 3 : -1,
      position: 2,
      racers: opts.mode === 'drift' ? 1 : 4,
      lap: 2,
      laps: opts.mode === 'circuit' ? 3 : 1,
      checkpoint: 4,
      checkpoints: 9,
      timeMs: 83000,
      lapTimeMs: 31000,
      bestLapMs: 52310,
      timeLeftMs: opts.mode === 'drift' ? 64000 : -1,
      progress: 0.42,
      wrongWay: false,
      standings: standingsFor(true),
      driftScore: 23400,
      driftCombo: 0,
      driftMultiplier: 1,
      driftAngle: 0,
      driftComboTimer: 0,
      trapTotal: 512,
      trapLast: 247,
      trapsPassed: 2,
      trapsTotal: 5,
      dragDistance: 0,
      dragLength: 402,
    },
    pursuit: { status: opts.pursuit ? 'pursuit' : 'idle', heat: opts.pursuit ? 3 : 0, heatProgress: 0.4, bounty: 12450, evade: 0, cooldown: 0, bust: 0, inSight: opts.pursuit, units: 3, heli: opts.pursuit, durationS: 74 },
    fps: 60,
  };
  for (let i = 0; i < 24; i++) telemetry.blips.push({ kind: 'traffic', x: 0, z: 0, heading: 0 });

  let time = 0;
  let dist = 150;
  let speed = 90;
  let lastTick = 0;
  let swap = true;
  const GEAR_TOP = [0, 62, 104, 148, 192, 236, 290];

  const step = (dt: number) => {
    if (state.paused || state.screen === 'title' || state.screen === 'garage') return;
    time += dt;
    const t = telemetry;
    // powertrain
    const braking = time % 16 > 12.5;
    t.nitroActive = !braking && time % 9 > 6.4 && t.nitro > 0.02;
    speed += (braking ? -55 : (t.nitroActive ? 34 : 17) * (1 - speed / 300)) * dt;
    speed = Math.max(48, speed);
    t.speedKmh = speed;
    let g = 1;
    while (g < 6 && speed > GEAR_TOP[g] * 0.93) g++;
    if (g !== t.gear) {
      if (g > t.gear) emit({ type: 'shift', quality: ['perfect', 'good', 'late', 'early'][Math.floor(time) % 4] as 'perfect' });
      t.gear = g;
    }
    t.rpm = 1500 + ((speed - GEAR_TOP[g - 1] * 0.8) / (GEAR_TOP[g] - GEAR_TOP[g - 1] * 0.8)) * 6300;
    t.shiftLight = t.rpm > 7500 ? 'over' : t.rpm > 6900 ? 'perfect' : t.rpm > 6200 ? 'approach' : 'none';
    t.nitro = Math.max(0, Math.min(1, t.nitro + (t.nitroActive ? -0.4 : 0.09) * dt));
    t.turbo = braking ? 0.1 : Math.min(1, t.turbo + dt);
    t.engineTemp = t.race.mode === 'drag' && t.race.active ? 0.5 + 0.45 * Math.abs(Math.sin(time * 0.4)) : 0.35;
    t.speedFx = Math.max(0, Math.min(1, (speed - 110) / 150 + (t.nitroActive ? 0.3 : 0)));
    // position along the loop
    dist += (speed / 3.6) * dt;
    const f = (dist / 10) % path.length;
    const i0 = Math.floor(f);
    const a = path[i0];
    const b = path[(i0 + 1) % path.length];
    t.x = a.x + (b.x - a.x) * (f - i0);
    t.z = a.z + (b.z - a.z) * (f - i0);
    t.heading = Math.atan2(b.x - a.x, b.z - a.z);
    // blips
    let n = 0;
    const put = (kind: Telemetry['blips'][number]['kind'], ahead: number, side: number, h = t.heading) => {
      const bl = t.blips[n++];
      bl.kind = kind;
      bl.x = t.x + Math.sin(t.heading) * ahead - Math.cos(t.heading) * side;
      bl.z = t.z + Math.cos(t.heading) * ahead + Math.sin(t.heading) * side;
      bl.heading = h;
    };
    for (let k = 0; k < 6; k++) put('traffic', ((k * 97 + time * 20) % 500) - 250, k % 2 ? 150 : -150, 0);
    if (t.race.active) {
      put('rival', 40 + Math.sin(time) * 30, 4);
      put('rival', -60, -4);
      put('checkpoint', 180, 0);
      put('finish', 620, 0);
    }
    if (t.pursuit.status !== 'idle') {
      put('police', -45 + Math.sin(time * 1.3) * 15, 5);
      put('police', -90, -6);
      put('police', -520, 80);
      put('heli', 30 + Math.sin(time) * 40, 50);
      put('roadblock', 260, 0);
      t.pursuit.bounty += 140 * dt;
      t.pursuit.durationS += dt;
      const ph = time % 30;
      t.pursuit.status = ph > 22 ? 'cooldown' : 'pursuit';
      t.pursuit.inSight = ph < 14;
      t.pursuit.bust = Math.max(0, Math.sin(ph * 0.5)) * 0.7;
      t.pursuit.evade = ph > 14 ? Math.min(1, (ph - 14) / 8) : 0;
      t.pursuit.cooldown = ph > 22 ? (ph - 22) / 8 : 0;
      t.pursuit.heatProgress = (time * 0.05) % 1;
    }
    t.blipCount = n;
    // race
    const r = t.race;
    if (r.countdown >= 0) {
      const c = 3 - Math.floor(time / 1.1);
      r.countdown = c < 0 ? -1 : c;
      if (c === 0 && state.screen === 'countdown') {
        r.active = true;
        set({ screen: 'race' });
      }
    }
    if (r.active) {
      r.timeMs += dt * 1000;
      r.lapTimeMs += dt * 1000;
      r.progress = (r.progress + dt * 0.02) % 1;
      r.timeLeftMs = r.mode === 'drift' ? Math.max(0, r.timeLeftMs - dt * 1000) : -1;
      t.drifting = r.mode === 'drift' && time % 7 < 5;
      r.driftAngle = t.drifting ? 28 + Math.sin(time * 3) * 16 : 0;
      r.driftCombo = t.drifting ? r.driftCombo + 900 * dt * r.driftMultiplier : 0;
      r.driftMultiplier = 1 + Math.floor((time % 7) / 1.6);
      r.driftComboTimer = t.drifting ? 1 : 0;
      r.dragDistance = (r.dragDistance + (speed / 3.6) * dt) % 402;
    }
    // periodic events
    const tick = Math.floor(time / 2.5);
    if (tick !== lastTick) {
      lastTick = tick;
      if (r.active) {
        swap = !swap;
        r.standings = standingsFor(swap);
        r.position = swap ? 2 : 1;
        if (r.mode === 'drift') emit({ type: 'driftBank', points: 8450, multiplier: 3 });
        else if (r.mode === 'speedtrap') emit({ type: 'speedtrap', speedKmh: 243, index: 2 });
        else emit({ type: 'checkpoint', index: 5, total: 9, splitMs: r.timeMs });
      } else if (t.pursuit.status !== 'idle') emit(tick % 2 ? { type: 'copDown', bounty: 2500 } : { type: 'heatUp', heat: 4 });
      else emit(tick % 2 ? { type: 'nearMiss', bonus: 150 } : { type: 'jump', airTime: 1.4, distance: 42 });
      if (tick % 4 === 0) emit({ type: 'impact', intensity: 0.6 });
    }
  };

  const api: MockApi = {
    telemetry,
    calls,
    step,
    getState: () => state,
    subscribe: (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    onEvent: (l) => {
      eventListeners.add(l);
      return () => {
        eventListeners.delete(l);
      };
    },
    getMapData: () => mapData,
    getPerfStats: perfStats,
    actions: {
      startGame: () => {
        log('startGame');
        if (!state.loading) set({ screen: 'freeroam' });
      },
      setPaused: (paused) => {
        log('setPaused', paused);
        set({ paused });
      },
      setMapOpen: (open) => {
        log('setMapOpen', open);
        set({ mapOpen: open, paused: false });
      },
      teleportTo: (id) => {
        log('teleportTo', id);
        const m = state.markers.find((x) => x.id === id);
        if (!m || !m.teleportable) return fail('Destination verrouillée');
        telemetry.x = m.x;
        telemetry.z = m.z;
        set({ mapOpen: false, gpsTargetId: null });
        return { ok: true };
      },
      setGpsTarget: (id) => {
        log('setGpsTarget', id);
        const m = id ? state.markers.find((x) => x.id === id) : null;
        telemetry.route = m ? [{ x: telemetry.x, z: telemetry.z }, { x: m.x, z: telemetry.z }, { x: m.x, z: m.z }] : null;
        telemetry.routeIsGps = !!m;
        set({ gpsTargetId: id });
      },
      startEvent: (id) => {
        log('startEvent', id);
        const ev = state.markers.find((x) => x.id === id)?.event;
        if (!ev) return fail('Épreuve inconnue');
        if (ev.locked) return fail(`Niveau REP ${ev.repLevelRequired} requis`);
        time = 0;
        telemetry.race.mode = ev.mode;
        telemetry.race.countdown = 3;
        telemetry.route = path;
        telemetry.routeIsGps = false;
        set({ screen: 'countdown', mapOpen: false, activeEvent: eventInfo(ev.mode) });
        return { ok: true };
      },
      restartEvent: () => {
        log('restartEvent');
        time = 0;
        telemetry.race.countdown = 3;
        telemetry.race.active = false;
        set({ screen: 'countdown', paused: false, results: null });
      },
      exitToFreeRoam: () => {
        log('exitToFreeRoam');
        telemetry.race.active = false;
        telemetry.race.countdown = -1;
        set({ screen: 'freeroam', paused: false, results: null, busted: null, activeEvent: null });
      },
      enterGarage: () => {
        log('enterGarage');
        set({ screen: 'garage', garageCarId: profile.currentCarId });
      },
      exitGarage: () => {
        log('exitGarage');
        set({ screen: 'freeroam', garagePreview: null });
      },
      garageShowCar: (carId) => {
        log('garageShowCar', carId);
        set({ garageCarId: carId, garagePreview: null });
      },
      buyCar: (carId) => {
        log('buyCar', carId);
        const spec = getCarSpec(carId);
        if (profile.garage[carId]) return fail('Tu possèdes déjà cette voiture');
        if (level() < spec.repLevel) return fail(`Niveau REP ${spec.repLevel} requis`);
        if (profile.money < spec.price) return fail('Fonds insuffisants');
        profile.money -= spec.price;
        profile.garage = { ...profile.garage, [carId]: { carId, tuning: { ...STOCK_TUNING }, visuals: spec.defaultVisuals, heat: 1 } };
        commit();
        return { ok: true };
      },
      selectCar: (carId) => {
        log('selectCar', carId);
        if (!profile.garage[carId]) return fail('Voiture non possédée');
        profile.currentCarId = carId;
        commit();
        return { ok: true };
      },
      buyUpgrade: (part: TunePart, lvl: TuneLevel) => {
        log('buyUpgrade', part, lvl);
        const owned = profile.garage[state.garageCarId];
        if (!owned) return fail('Achète d’abord cette voiture');
        if (lvl !== owned.tuning[part] + 1) return fail('Niveau précédent requis');
        if (level() < TUNE_LEVEL_REP[lvl]) return fail(`Niveau REP ${TUNE_LEVEL_REP[lvl]} requis`);
        const price = upgradePrice(getCarSpec(owned.carId), part, lvl);
        if (profile.money < price) return fail('Fonds insuffisants');
        profile.money -= price;
        profile.currentCarId = owned.carId;
        profile.garage = { ...profile.garage, [owned.carId]: { ...owned, tuning: { ...owned.tuning, [part]: lvl } } };
        commit();
        return { ok: true };
      },
      previewVisuals: (v: CarVisuals | null) => {
        log('previewVisuals', v);
        set({ garagePreview: v });
      },
      buyVisuals: (v: CarVisuals) => {
        log('buyVisuals', v);
        const owned = profile.garage[state.garageCarId];
        if (!owned) return fail('Achète d’abord cette voiture');
        const price = visualsPrice(owned.visuals, v);
        if (profile.money < price) return fail('Fonds insuffisants');
        profile.money -= price;
        profile.currentCarId = owned.carId;
        profile.garage = { ...profile.garage, [owned.carId]: { ...owned, visuals: v } };
        commit();
        set({ garagePreview: null });
        return { ok: true };
      },
      updateSettings: (patch) => {
        log('updateSettings', patch);
        profile.settings = { ...profile.settings, ...patch };
        commit();
      },
      resetSave: () => {
        log('resetSave');
        profile = mockProfile();
        profile.money = 6000;
        profile.rep = 0;
        commit();
      },
      playUiSound: (s) => log('playUiSound', s),
    },
  };
  return api;
}
