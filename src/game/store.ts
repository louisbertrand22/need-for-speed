/* UI bridge store: low-frequency immutable UIState snapshots, the mutable Telemetry
 * object, transient UI events and toasts. No React dependency. */
import type { GameUiEvent, PlayerProfile, Telemetry, Toast, ToastKind, UIState } from '../core/types';
import { STARTER_CAR_ID, repLevelBounds, repLevelFor } from './catalog';

export function createTelemetry(): Telemetry {
  return {
    speedKmh: 0,
    rpm: 900,
    redlineRpm: 7000,
    maxRpm: 8000,
    gear: 1,
    manual: false,
    shiftLight: 'none',
    perfectShiftLo: 6000,
    perfectShiftHi: 6800,
    nitro: 1,
    nitroActive: false,
    turbo: 0,
    engineTemp: 0,
    damage: 0,
    drifting: false,
    speedFx: 0,
    x: 0,
    z: 0,
    heading: 0,
    blips: [],
    blipCount: 0,
    route: null,
    routeIsGps: false,
    race: {
      active: false,
      mode: 'sprint',
      countdown: -1,
      position: 1,
      racers: 1,
      lap: 1,
      laps: 1,
      checkpoint: 0,
      checkpoints: 0,
      timeMs: 0,
      lapTimeMs: 0,
      bestLapMs: 0,
      timeLeftMs: -1,
      progress: 0,
      wrongWay: false,
      standings: [],
      driftScore: 0,
      driftCombo: 0,
      driftMultiplier: 1,
      driftAngle: 0,
      driftComboTimer: 0,
      trapTotal: 0,
      trapLast: 0,
      trapsPassed: 0,
      trapsTotal: 0,
      dragDistance: 0,
      dragLength: 0,
    },
    pursuit: {
      status: 'idle',
      heat: 0,
      heatProgress: 0,
      bounty: 0,
      evade: 0,
      cooldown: 0,
      bust: 0,
      inSight: false,
      units: 0,
      heli: false,
      durationS: 0,
    },
    fps: 60,
  };
}

interface ToastEntry {
  toast: Toast;
  expires: number;
}

export class UIStore {
  private state: UIState;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(e: GameUiEvent) => void>();
  private toastEntries: ToastEntry[] = [];
  private nextToastId = 1;
  private clock = 0;

  constructor(profile: PlayerProfile) {
    const level = repLevelFor(profile.rep);
    const bounds = repLevelBounds(level);
    this.state = {
      screen: 'title',
      paused: false,
      mapOpen: false,
      loading: true,
      loadingLabel: 'Initialisation…',
      profile,
      repLevel: level,
      repLevelFloor: bounds.floor,
      repLevelCeil: bounds.ceil,
      markers: [],
      prompt: null,
      activeEvent: null,
      results: null,
      busted: null,
      toasts: [],
      gpsTargetId: null,
      district: 'downtown',
      garageCarId: profile.currentCarId || STARTER_CAR_ID,
      garagePreview: null,
    };
  }

  get = (): UIState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  onEvent = (listener: (e: GameUiEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  /** Publish a new snapshot (no-op when nothing actually changes). */
  set(patch: Partial<UIState>): void {
    let changed = false;
    for (const k in patch) {
      const key = k as keyof UIState;
      if (patch[key] !== this.state[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Publish a fresh copy of the profile (and derived REP level fields). */
  setProfile(profile: PlayerProfile): void {
    const level = repLevelFor(profile.rep);
    const bounds = repLevelBounds(level);
    this.set({
      profile: { ...profile },
      repLevel: level,
      repLevelFloor: bounds.floor,
      repLevelCeil: bounds.ceil,
    });
  }

  emit(e: GameUiEvent): void {
    for (const l of this.eventListeners) l(e);
  }

  toast(kind: ToastKind, title: string, text = '', ttl = 4.5): void {
    const toast: Toast = { id: this.nextToastId++, kind, title, text };
    this.toastEntries.push({ toast, expires: this.clock + ttl });
    if (this.toastEntries.length > 5) this.toastEntries.shift();
    this.set({ toasts: this.toastEntries.map((t) => t.toast) });
  }

  /** Advance the toast clock (real time, also while paused). */
  tick(dt: number): void {
    this.clock += dt;
    if (this.toastEntries.length === 0) return;
    const before = this.toastEntries.length;
    this.toastEntries = this.toastEntries.filter((t) => t.expires > this.clock);
    if (this.toastEntries.length !== before) this.set({ toasts: this.toastEntries.map((t) => t.toast) });
  }
}
