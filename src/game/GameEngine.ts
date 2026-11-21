/* =============================================================================
 * APEX NOCTURNE — game engine
 * -----------------------------------------------------------------------------
 * Owns the renderer, the fixed-step simulation loop (120 Hz physics decoupled
 * from rendering and from the React HUD), every runtime system (world, physics
 * vehicles, AI, particles, audio) and the GameAPI bridge consumed by the UI.
 * ===========================================================================*/
import * as THREE from 'three';
import { GARAGE_SPOT } from '../core/layout';
import { angleDiff, clamp, damp, smoothstep } from '../core/math';
import { createGameRenderer, createPostFx, pixelRatioFor } from '../core/renderSetup';
import type { PostFx, RenderQuality } from '../core/renderSetup';
import { MIRROR_RECT } from '../core/types';
import type {
  AIHost,
  ActionResult,
  AudioFrame,
  BodyInfo,
  BlipKind,
  CarModel,
  CarVisuals,
  CheckpointModel,
  CityWorld,
  CollisionResult,
  GameAPI,
  GameActions,
  GameSettings,
  GarageScene,
  HelicopterModel,
  IGameAudio,
  IParticleSystem,
  IPoliceSystem,
  IRaceAI,
  ISkidMarks,
  ITrafficSystem,
  MapMarker,
  PortalModel,
  SirenSource,
  SpawnPoint,
  TrafficCar,
  TuneLevel,
  TunePart,
  TuningState,
  UiSound,
  VehicleConfig,
  VehicleHandle,
  VehicleTag,
  VehicleVisualState,
} from '../core/types';
import { createPoliceSystem, createRaceAI } from '../ai/aiDrivers';
import { createTrafficSystem } from '../ai/traffic';
import { createGameAudio } from '../audio/engineSound';
import {
  buildVehicleConfig,
  createVehicle,
  estimateStats,
  resolveVehiclePair,
  resolveVehicleVsBody,
} from '../physics/vehiclePhysics';
import { generateCity } from '../world/cityGenerator';
import {
  createCheckpoint,
  createParticleSystem,
  createPortal,
  createRoadBarrier,
  createSkidMarks,
  createSpikeStrip,
} from '../world/effects';
import { createNightEnvironment } from '../world/environment';
import { createGarageScene } from '../world/garageScene';
import { createCarModel, createHelicopterModel, createPoliceModel, createTrafficModel } from '../world/vehicleModels';
import { CameraRig } from './cameraRig';
import { GARAGE_COLOR, MODE_INFO, getCarSpec } from './catalog';
import { EVENT_DEFS, buildEvent, eventSummary, routeBetween } from './events';
import type { BuiltEvent } from './events';
import { Progression, RaceSession, activeEventInfo } from './gameModes';
import type { SessionHost } from './gameModes';
import { InputManager, makeDriveInput } from './input';
import { UIStore, createTelemetry } from './store';
import { StreetLife } from './streetLife';

const STEP = 1 / 120;
const MAX_STEPS = 10;
const PROMPT_RADIUS = 9;

interface PortalEntry {
  marker: MapMarker;
  model: PortalModel;
  heading: number;
}

interface TrafficVisual {
  model: CarModel;
  key: string;
}

interface RoadblockVisual {
  groups: THREE.Object3D[];
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export class GameEngine {
  readonly api: GameAPI;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private postFx: PostFx | null = null;
  private quality: RenderQuality;
  private readonly scene = new THREE.Scene();
  private readonly rig: CameraRig;
  private readonly store: UIStore;
  private readonly telemetry = createTelemetry();
  private readonly progression: Progression;
  private readonly input = new InputManager();
  private readonly audio: IGameAudio = createGameAudio();

  private ready = false;
  private disposed = false;
  private raf = 0;
  private lastNow = 0;
  private time = 0;
  private realTime = 0;
  private accumulator = 0;
  private fps = 60;
  private width = 0;
  private height = 0;

  // world & systems (created in init)
  private world!: CityWorld;
  private particles!: IParticleSystem;
  private skids!: ISkidMarks;
  private raceAI!: IRaceAI;
  private police!: IPoliceSystem;
  private traffic!: ITrafficSystem;
  private aiHost!: AIHost;
  private sessionHost!: SessionHost;
  private streetLife!: StreetLife;
  private heli!: HelicopterModel;

  // vehicles
  private readonly handles: VehicleHandle[] = [];
  private readonly models = new Map<number, CarModel>();
  private playerHandle!: VehicleHandle;
  private playerCarKey = '';
  private nextHandleId = 1;
  private readonly trafficVisuals = new Map<number, TrafficVisual>();
  private readonly trafficPool = new Map<string, CarModel[]>();
  private readonly trafficSeen = new Set<number>();
  private readonly roadblockVisuals = new Map<number, RoadblockVisual>();
  private readonly hitTimes = new Map<number, number>();

  // events
  private readonly builtEvents = new Map<string, BuiltEvent>();
  private portals: PortalEntry[] = [];
  private readonly checkpointPool: { model: CheckpointModel; width: number }[] = [];
  private session: RaceSession | null = null;
  private sessionGatesVersion = -1;
  private gpsTimer = 0;
  private pendingShiftUp = false;
  private pendingShiftDown = false;
  private heatDecayTimer = 0;
  private destructibleTimer = 0;
  private offRoadTimer = 0;
  private autopilot = false;
  private autopilotStuck = 0;

  // garage
  private garage: GarageScene | null = null;
  private garageModel: CarModel | null = null;
  private garageModelCar = '';
  private garageYaw = 0.7;
  private garagePitch = 0.22;
  private garageDist = 6.2;
  private garageIdle = 0;
  private dragging = false;
  private dragX = 0;
  private dragY = 0;
  private readonly garagePose: VehicleVisualState = {
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
    pitch: 0,
    roll: 0,
    speed: 0,
    steerAngle: 0.3,
    brake: 0,
    gear: 1,
    nitroActive: false,
    damage: 0,
    wheelSlip: 0,
  };

  // mirror
  private readonly mirrorTarget: THREE.WebGLRenderTarget;
  private readonly mirrorScene = new THREE.Scene();
  private readonly mirrorOrtho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mirrorFrame = 0;

  // scratch
  private readonly v3a = new THREE.Vector3();
  private readonly v3b = new THREE.Vector3();
  private readonly exhaustBuf: THREE.Vector3[] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly sirens: SirenSource[] = [];
  private readonly sirenPool: SirenSource[] = [
    { distance: 0, pan: 0, approach: 0 },
    { distance: 0, pan: 0, approach: 0 },
    { distance: 0, pan: 0, approach: 0 },
  ];
  private readonly camPos2 = { x: 0, z: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.progression = new Progression((p) => {
      this.store.setProfile(p);
      if (this.ready) this.refreshMarkers();
    });
    this.store = new UIStore(this.progression.profile);

    const params = new URLSearchParams(window.location.search);
    const q = params.get('quality');
    this.quality = q === 'low' || q === 'medium' || q === 'high' ? q : this.progression.profile.settings.quality;

    this.renderer = createGameRenderer(canvas, this.quality);
    this.renderer.setClearColor(0x05060d, 1);
    this.width = Math.max(1, canvas.clientWidth);
    this.height = Math.max(1, canvas.clientHeight);
    this.renderer.setSize(this.width, this.height, false);
    this.rig = new CameraRig(this.width / this.height);
    this.rig.mode = this.progression.profile.settings.cameraMode;

    this.mirrorTarget = new THREE.WebGLRenderTarget(640, Math.round(640 / MIRROR_RECT.aspect), {
      type: THREE.HalfFloatType,
    });
    const quad = new THREE.PlaneGeometry(2, 2);
    const uv = quad.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); // horizontal flip = real mirror
    this.mirrorScene.add(
      new THREE.Mesh(quad, new THREE.MeshBasicMaterial({ map: this.mirrorTarget.texture, depthTest: false, depthWrite: false })),
    );

    this.api = {
      telemetry: this.telemetry,
      getState: this.store.get,
      subscribe: this.store.subscribe,
      onEvent: this.store.onEvent,
      getMapData: () => (this.ready ? this.world.mapData : null),
      getPerfStats: (carId: string, tuning: TuningState) => estimateStats(getCarSpec(carId), tuning),
      actions: this.createActions(),
    };

    canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('beforeunload', this.onUnload);

    (window as unknown as { __apex?: unknown }).__apex = this.createDebugApi();

    this.lastNow = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    window.setTimeout(() => {
      void this.init();
    }, 30);
  }

  // ===========================================================================
  // Initialisation
  // ===========================================================================

  private async init(): Promise<void> {
    try {
      this.store.set({ loading: true, loadingLabel: 'Génération de Port-Sélène…' });
      await nextFrame();
      await nextFrame();

      this.world = generateCity(20260521);
      if (this.disposed) return;
      this.scene.add(this.world.group);
      this.scene.background = new THREE.Color(this.world.fogColor);
      this.scene.fog = new THREE.FogExp2(this.world.fogColor, this.world.fogDensity);

      this.store.set({ loadingLabel: 'Allumage des néons…' });
      await nextFrame();
      this.scene.environment = createNightEnvironment(this.renderer);
      this.particles = createParticleSystem();
      this.skids = createSkidMarks();
      this.scene.add(this.particles.object, this.skids.object);

      this.store.set({ loadingLabel: 'Préparation des véhicules…' });
      await nextFrame();
      this.createPlayer();
      this.aiHost = {
        world: this.world,
        player: this.playerHandle,
        spawnVehicle: this.spawnVehicle,
        despawnVehicle: this.despawnVehicle,
        queryBodies: this.queryBodies,
        buildConfig: buildVehicleConfig,
        getCameraPosition: () => this.camPos2,
      };
      this.traffic = createTrafficSystem(this.aiHost);
      this.raceAI = createRaceAI(this.aiHost);
      this.police = createPoliceSystem(this.aiHost);
      this.police.setEnabled(false);
      this.heli = createHelicopterModel();
      this.scene.add(this.heli.group);
      this.sessionHost = {
        world: this.world,
        ai: this.aiHost,
        raceAI: this.raceAI,
        traffic: this.traffic,
        store: this.store,
        telemetry: this.telemetry,
        audio: this.audio,
        progression: this.progression,
        placePlayer: (x, z, heading) => this.placePlayer(x, z, heading),
      };
      this.streetLife = new StreetLife({
        world: this.world,
        player: this.playerHandle,
        handles: this.handles,
        traffic: this.traffic,
        police: this.police,
        store: this.store,
        audio: this.audio,
        progression: this.progression,
      });

      this.store.set({ loadingLabel: 'Tracé des épreuves…' });
      await nextFrame();
      for (const def of EVENT_DEFS) this.builtEvents.set(def.id, buildEvent(this.world, def));
      this.createPortals();

      this.applyQuality(this.quality);
      this.applySettings(this.progression.profile.settings);
      this.traffic.setDensity(this.progression.profile.settings.trafficDensity);
      this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);

      this.ready = true;
      this.refreshMarkers();
      this.store.set({ loading: false, loadingLabel: '' });
    } catch (err) {
      console.error('[APEX NOCTURNE] initialisation failed', err);
      this.store.set({ loadingLabel: 'Erreur d’initialisation — consulte la console' });
    }
  }

  private createPlayer(): void {
    const car = this.progression.currentCar;
    const spec = getCarSpec(car.carId);
    const config = buildVehicleConfig(spec, car.tuning);
    const vehicle = createVehicle(config, this.world);
    this.playerHandle = {
      id: this.nextHandleId++,
      vehicle,
      input: makeDriveInput(),
      tag: { type: 'player' },
      alive: true,
      disabled: false,
    };
    this.handles.push(this.playerHandle);
    this.buildPlayerModel();
    this.audio.setEngineProfile(config.cylinders, config.aspiration, config.redlineRpm);
  }

  private buildPlayerModel(): void {
    const car = this.progression.currentCar;
    const spec = getCarSpec(car.carId);
    const old = this.models.get(this.playerHandle.id);
    if (old) {
      this.scene.remove(old.group);
      old.dispose();
    }
    const model = createCarModel(spec, car.visuals, { realHeadlights: true, detail: 'high' });
    model.setHeadlights(true);
    this.scene.add(model.group);
    this.models.set(this.playerHandle.id, model);
    this.playerCarKey = JSON.stringify([car.carId, car.tuning, car.visuals]);
  }

  /** Re-create the player's physics config and model after garage changes. */
  private syncPlayerCar(): void {
    const car = this.progression.currentCar;
    const key = JSON.stringify([car.carId, car.tuning, car.visuals]);
    if (key === this.playerCarKey) return;
    const spec = getCarSpec(car.carId);
    const config = buildVehicleConfig(spec, car.tuning);
    this.playerHandle.vehicle.setConfig(config);
    this.playerHandle.vehicle.repair();
    this.audio.setEngineProfile(config.cylinders, config.aspiration, config.redlineRpm);
    this.buildPlayerModel();
  }

  private createPortals(): void {
    const add = (marker: MapMarker, kind: Parameters<typeof createPortal>[0], heading: number) => {
      const model = createPortal(kind);
      model.group.position.set(marker.x, this.world.getGroundHeight(marker.x, marker.z), marker.z);
      model.group.rotation.y = heading;
      this.scene.add(model.group);
      this.portals.push({ marker, model, heading });
    };
    add(
      {
        id: 'garage',
        kind: 'garage',
        x: GARAGE_SPOT.x,
        z: GARAGE_SPOT.z,
        label: 'Garage — QG',
        color: GARAGE_COLOR,
        teleportable: true,
        event: null,
      },
      'garage',
      GARAGE_SPOT.heading,
    );
    for (const built of this.builtEvents.values()) {
      const d = built.def;
      add(
        {
          id: d.id,
          kind: 'event',
          x: built.start.x,
          z: built.start.z,
          label: d.name,
          color: MODE_INFO[d.mode].color,
          teleportable: true,
          event: null,
        },
        d.mode,
        built.start.heading,
      );
    }
  }

  /** Rebuild the marker list (locks, records) and publish it. */
  private refreshMarkers(): void {
    const level = this.progression.repLevel;
    const markers: MapMarker[] = [];
    for (const p of this.portals) {
      if (p.marker.kind === 'event') {
        const built = this.builtEvents.get(p.marker.id)!;
        const summary = eventSummary(built, this.progression.eventRecord(p.marker.id), level);
        p.marker = { ...p.marker, event: summary, teleportable: !summary.locked };
        p.model.setLocked(summary.locked);
      }
      markers.push(p.marker);
    }
    for (const b of this.world.pursuitBreakers) {
      markers.push({ id: `breaker:${b.id}`, kind: 'breaker', x: b.x, z: b.z, label: b.name, color: '#ff5a3c', teleportable: false, event: null });
    }
    for (const r of this.world.ramps) {
      markers.push({ id: `ramp:${r.id}`, kind: 'ramp', x: r.x, z: r.z, label: 'Rampe de saut', color: '#ffd000', teleportable: false, event: null });
    }
    this.store.set({ markers });
  }

  // ===========================================================================
  // AI host services
  // ===========================================================================

  private spawnVehicle = (config: VehicleConfig, x: number, z: number, heading: number, tag: VehicleTag): VehicleHandle => {
    const vehicle = createVehicle(config, this.world);
    vehicle.reset(x, z, heading, 0);
    const handle: VehicleHandle = {
      id: this.nextHandleId++,
      vehicle,
      input: makeDriveInput(),
      tag,
      alive: true,
      disabled: false,
    };
    let model: CarModel;
    if (tag.type === 'police') model = createPoliceModel(tag.kind);
    else if (tag.type === 'rival') model = createCarModel(getCarSpec(tag.carId), tag.visuals, { detail: 'high' });
    else model = createCarModel(getCarSpec(this.progression.currentCar.carId), this.progression.currentCar.visuals);
    model.setHeadlights(true);
    model.sync(vehicle.state, 0);
    this.scene.add(model.group);
    this.models.set(handle.id, model);
    this.handles.push(handle);
    return handle;
  };

  private despawnVehicle = (handle: VehicleHandle): void => {
    if (!handle.alive || handle === this.playerHandle) return;
    handle.alive = false;
    const i = this.handles.indexOf(handle);
    if (i >= 0) this.handles.splice(i, 1);
    const model = this.models.get(handle.id);
    if (model) {
      this.scene.remove(model.group);
      model.dispose();
      this.models.delete(handle.id);
    }
    this.hitTimes.delete(handle.id);
    for (let w = 0; w < 4; w++) this.skids.end(handle.id * 4 + w);
  };

  private queryBodies = (x: number, z: number, radius: number, out: BodyInfo[]): number => {
    let n = 0;
    const r2 = radius * radius;
    for (const h of this.handles) {
      if (!h.alive) continue;
      const s = h.vehicle.state;
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz > r2) continue;
      let b = out[n];
      if (!b) {
        b = { type: 'player', x: 0, z: 0, vx: 0, vz: 0, heading: 0, halfLength: 2, halfWidth: 1, handle: null, traffic: null };
        out[n] = b;
      }
      b.type = h.tag.type;
      b.x = s.x;
      b.z = s.z;
      b.vx = s.vx;
      b.vz = s.vz;
      b.heading = s.heading;
      b.halfLength = h.vehicle.config.length * 0.5;
      b.halfWidth = h.vehicle.config.width * 0.5;
      b.handle = h;
      b.traffic = null;
      n++;
    }
    for (const c of this.traffic.cars) {
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz > r2) continue;
      let b = out[n];
      if (!b) {
        b = { type: 'traffic', x: 0, z: 0, vx: 0, vz: 0, heading: 0, halfLength: 2, halfWidth: 1, handle: null, traffic: null };
        out[n] = b;
      }
      b.type = 'traffic';
      b.x = c.x;
      b.z = c.z;
      b.vx = c.vx;
      b.vz = c.vz;
      b.heading = c.heading;
      b.halfLength = c.halfLength;
      b.halfWidth = c.halfWidth;
      b.handle = null;
      b.traffic = c;
      n++;
    }
    return n;
  };

  // ===========================================================================
  // Player placement
  // ===========================================================================

  private placePlayer(x: number, z: number, heading: number): void {
    const v = this.playerHandle.vehicle;
    v.reset(x, z, heading, 0);
    v.events.length = 0;
    for (let w = 0; w < 4; w++) this.skids.end(this.playerHandle.id * 4 + w);
    if (this.traffic) this.traffic.clearAround(x, z, 28);
    if (this.streetLife) this.streetLife.reset();
    this.rig.snap();
    this.accumulator = 0;
    this.offRoadTimer = 0;
  }

  /** Put the car back on the nearest road (or on the race route), facing the right way. */
  private respawnOnRoad(): void {
    const st = this.playerHandle.vehicle.state;
    let pose: SpawnPoint | null = null;
    if (this.session && !this.session.done) pose = this.session.getRespawnPose();
    if (!pose) {
      const hit = this.world.roads.nearestRoad(st.x, st.z, 600);
      if (hit) {
        let h = Math.atan2(hit.dirX, hit.dirZ);
        if (Math.abs(angleDiff(st.heading, h)) > Math.PI / 2) h += Math.PI;
        // right-hand lane of the chosen direction
        const off = hit.edge.width * 0.25;
        pose = { x: hit.x - Math.cos(h) * off, z: hit.z + Math.sin(h) * off, heading: h };
      } else {
        pose = GARAGE_SPOT;
      }
    }
    this.placePlayer(pose.x, pose.z, pose.heading);
  }

  // ===========================================================================
  // Actions (UI → engine)
  // ===========================================================================

  private createActions(): GameActions {
    const fail = (reason: string): ActionResult => ({ ok: false, reason });
    return {
      startGame: () => {
        if (!this.ready || this.store.get().screen !== 'title') return;
        void this.audio.resume();
        this.enterFreeRoam();
        this.store.emit({ type: 'banner', title: 'Port-Sélène', subtitle: 'Les rues t’appartiennent', tone: 'info' });
      },
      setPaused: (paused: boolean) => this.setPaused(paused),
      setMapOpen: (open: boolean) => {
        const s = this.store.get();
        if (open && s.screen !== 'freeroam') return;
        this.store.set({ mapOpen: open, paused: false });
        this.audio.setPaused(false);
      },
      teleportTo: (markerId: string) => {
        const s = this.store.get();
        if (s.screen !== 'freeroam') return fail('Indisponible pour le moment');
        if (this.police.state.status !== 'idle') return fail('Impossible pendant une poursuite');
        const portal = this.portals.find((p) => p.marker.id === markerId);
        if (!portal) return fail('Destination inconnue');
        if (!portal.marker.teleportable) return fail('Destination verrouillée');
        const built = this.builtEvents.get(markerId);
        if (built) {
          const pt = built.route.pointAt(built.startS - 6);
          this.placePlayer(pt.x, pt.z, built.route.headingAt(built.startS - 6));
        } else {
          this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);
        }
        this.police.reset();
        this.world.resetDestructibles();
        this.store.set({ mapOpen: false, gpsTargetId: null });
        this.telemetry.route = null;
        return { ok: true };
      },
      setGpsTarget: (markerId: string | null) => {
        this.store.set({ gpsTargetId: markerId });
        this.gpsTimer = 0;
        if (!markerId && !this.session) this.telemetry.route = null;
      },
      startEvent: (eventId: string) => {
        const s = this.store.get();
        if (!this.ready) return fail('Chargement en cours');
        if (s.screen !== 'freeroam') return fail('Indisponible pour le moment');
        return this.beginEvent(eventId);
      },
      restartEvent: () => {
        const id = this.session?.def.id;
        if (!id) return;
        this.endSession(true);
        this.beginEvent(id);
      },
      exitToFreeRoam: () => {
        const s = this.store.get();
        if (s.screen === 'busted') {
          this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);
          this.playerHandle.vehicle.repair();
        }
        this.endSession(true);
        this.enterFreeRoam();
      },
      enterGarage: () => this.enterGarage(),
      exitGarage: () => this.exitGarage(),
      garageShowCar: (carId: string) => {
        this.store.set({ garageCarId: getCarSpec(carId).id, garagePreview: null });
        this.refreshGarageModel();
      },
      buyCar: (carId: string) => {
        const r = this.progression.buyCar(carId);
        if (r.ok) {
          this.store.set({ garageCarId: carId, garagePreview: null });
          this.refreshGarageModel();
        }
        return r;
      },
      selectCar: (carId: string) => {
        const r = this.progression.selectCar(carId);
        if (r.ok) {
          this.store.set({ garageCarId: carId, garagePreview: null });
          this.refreshGarageModel();
        }
        return r;
      },
      buyUpgrade: (part: TunePart, level: TuneLevel) => {
        const s = this.store.get();
        if (s.screen === 'garage' && s.garageCarId !== this.progression.profile.currentCarId) {
          if (!this.progression.profile.garage[s.garageCarId]) return fail('Achète d’abord cette voiture');
          this.progression.selectCar(s.garageCarId);
        }
        return this.progression.buyUpgrade(part, level);
      },
      previewVisuals: (visuals: CarVisuals | null) => {
        this.store.set({ garagePreview: visuals });
        this.refreshGarageModel();
      },
      buyVisuals: (visuals: CarVisuals) => {
        const s = this.store.get();
        if (s.garageCarId !== this.progression.profile.currentCarId) {
          if (!this.progression.profile.garage[s.garageCarId]) return fail('Achète d’abord cette voiture');
          this.progression.selectCar(s.garageCarId);
        }
        const r = this.progression.buyVisuals(visuals);
        if (r.ok) {
          this.store.set({ garagePreview: null });
          this.refreshGarageModel();
        }
        return r;
      },
      updateSettings: (patch: Partial<GameSettings>) => {
        this.progression.updateSettings(patch);
        this.applySettings(this.progression.profile.settings);
      },
      resetSave: () => {
        this.endSession(true);
        this.progression.reset();
        this.store.set({ garageCarId: this.progression.profile.currentCarId, garagePreview: null, gpsTargetId: null });
        if (this.ready) {
          this.syncPlayerCar();
          this.police.reset();
          this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);
          if (this.store.get().screen !== 'title') this.enterFreeRoam();
          this.refreshGarageModel();
        }
        this.store.toast('info', 'Sauvegarde réinitialisée', 'Nouvelle carrière à Port-Sélène');
      },
      playUiSound: (sound: UiSound) => this.audio.playUi(sound),
    };
  }

  private setPaused(paused: boolean): void {
    const s = this.store.get();
    const pausable = s.screen === 'freeroam' || s.screen === 'countdown' || s.screen === 'race';
    if (paused && !pausable) return;
    this.store.set({ paused, mapOpen: paused ? false : s.mapOpen });
    this.audio.setPaused(paused);
  }

  private applySettings(settings: GameSettings): void {
    this.audio.setMasterVolume(settings.masterVolume);
    this.audio.setMusicVolume(settings.musicVolume);
    this.rig.mode = settings.cameraMode;
    const params = new URLSearchParams(window.location.search);
    if (!params.get('quality') && settings.quality !== this.quality) this.applyQuality(settings.quality);
    if (this.ready) {
      if (!this.session) {
        this.traffic.setDensity(settings.trafficDensity);
        this.playerHandle.vehicle.manualGearbox = settings.transmission === 'manual';
      } else if (this.session.def.mode !== 'drag') {
        this.playerHandle.vehicle.manualGearbox = settings.transmission === 'manual';
      }
    }
  }

  private applyQuality(quality: RenderQuality): void {
    this.quality = quality;
    this.renderer.setPixelRatio(pixelRatioFor(quality));
    this.renderer.setSize(this.width, this.height, false);
    if (this.postFx) {
      this.postFx.dispose();
      this.postFx = null;
    }
    if (quality !== 'low') {
      this.postFx = createPostFx(this.renderer, this.scene, this.rig.camera, quality);
      this.postFx.setSize(this.width, this.height, this.renderer.getPixelRatio());
    }
  }

  private enterFreeRoam(): void {
    const settings = this.progression.profile.settings;
    this.store.set({
      screen: 'freeroam',
      paused: false,
      mapOpen: false,
      activeEvent: null,
      results: null,
      busted: null,
      prompt: null,
    });
    this.input.setEnabled(true);
    this.audio.setPaused(false);
    this.audio.setEngineActive(true);
    this.audio.setMusicMood('cruise');
    this.traffic.setDensity(settings.trafficDensity);
    this.playerHandle.vehicle.manualGearbox = settings.transmission === 'manual';
    this.playerHandle.vehicle.holdAtLine = false;
    this.police.setBaseHeat(this.progression.currentCar.heat);
    this.police.setEnabled(true);
    this.rig.snap();
  }

  private beginEvent(eventId: string): ActionResult {
    const built = this.builtEvents.get(eventId);
    if (!built) return { ok: false, reason: 'Épreuve inconnue' };
    if (this.progression.repLevel < built.def.repLevel) {
      return { ok: false, reason: `Niveau REP ${built.def.repLevel} requis` };
    }
    if (this.police.state.status !== 'idle') return { ok: false, reason: 'Sème d’abord la police !' };
    this.endSession(false);
    this.police.setEnabled(false);
    this.world.resetDestructibles();
    this.playerHandle.vehicle.manualGearbox = this.progression.profile.settings.transmission === 'manual';
    this.session = new RaceSession(this.sessionHost, built);
    this.session.begin();
    this.sessionGatesVersion = -1;
    this.store.set({
      screen: 'countdown',
      paused: false,
      mapOpen: false,
      prompt: null,
      results: null,
      gpsTargetId: null,
      activeEvent: activeEventInfo(built),
    });
    this.input.setEnabled(true);
    this.audio.setPaused(false);
    this.audio.setEngineActive(true);
    this.audio.setMusicMood('race');
    return { ok: true };
  }

  private endSession(abandon: boolean): void {
    if (!this.session) return;
    if (abandon && !this.session.done) this.session.abandon();
    this.session.dispose();
    this.session = null;
    this.sessionGatesVersion = -1;
    for (const c of this.checkpointPool) c.model.setLook('hidden');
    this.store.set({ activeEvent: null });
  }

  // ---------------------------------------------------------------- garage

  private enterGarage(): void {
    const s = this.store.get();
    if (!this.ready || s.screen !== 'freeroam') return;
    if (this.police.state.status !== 'idle') {
      this.store.toast('police', 'Garage fermé', 'Sème d’abord la police !');
      this.audio.playUi('error');
      return;
    }
    if (!this.garage) this.garage = createGarageScene(this.renderer);
    this.police.setEnabled(false);
    this.playerHandle.vehicle.repair();
    this.store.set({
      screen: 'garage',
      prompt: null,
      mapOpen: false,
      paused: false,
      garageCarId: this.progression.profile.currentCarId,
      garagePreview: null,
    });
    this.garageYaw = 0.7;
    this.garagePitch = 0.22;
    this.garageDist = 6.2;
    this.garageIdle = 10;
    this.refreshGarageModel();
    this.audio.setEngineActive(false);
    this.audio.setMusicMood('garage');
    this.input.setEnabled(false);
    this.progression.setCarHeat(1);
  }

  private exitGarage(): void {
    if (this.store.get().screen !== 'garage') return;
    this.store.set({ garagePreview: null });
    this.syncPlayerCar();
    this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);
    this.world.resetDestructibles();
    this.enterFreeRoam();
    this.progression.flush();
  }

  /** Make the turntable show `garageCarId` with the preview (or saved / default) look. */
  private refreshGarageModel(): void {
    if (!this.garage) return;
    const s = this.store.get();
    const spec = getCarSpec(s.garageCarId);
    const owned = this.progression.profile.garage[spec.id];
    const visuals = s.garagePreview ?? owned?.visuals ?? spec.defaultVisuals;
    if (!this.garageModel || this.garageModelCar !== spec.id) {
      if (this.garageModel) {
        this.garage.carAnchor.remove(this.garageModel.group);
        this.garageModel.dispose();
      }
      this.garageModel = createCarModel(spec, visuals, { detail: 'high' });
      this.garageModel.setHeadlights(true);
      this.garage.carAnchor.add(this.garageModel.group);
      this.garageModelCar = spec.id;
    } else {
      this.garageModel.setVisuals(visuals);
    }
    this.garage.setAccentColor(new THREE.Color(visuals.neonColor ?? visuals.paintColor).getHex());
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (this.store.get().screen !== 'garage') return;
    this.dragging = true;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.garageIdle = 0;
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging) return;
    const dx = e.clientX - this.dragX;
    const dy = e.clientY - this.dragY;
    this.dragX = e.clientX;
    this.dragY = e.clientY;
    this.garageYaw -= dx * 0.006;
    this.garagePitch = clamp(this.garagePitch + dy * 0.004, 0.04, 1.1);
    this.garageIdle = 0;
  };

  private onPointerUp = (): void => {
    this.dragging = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (this.store.get().screen !== 'garage' || !this.garage) return;
    this.garageDist = clamp(this.garageDist + e.deltaY * 0.004, this.garage.minDistance, this.garage.maxDistance);
    this.garageIdle = 0;
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      this.audio.setPaused(true);
      const s = this.store.get();
      if (s.screen === 'race' || s.screen === 'countdown' || s.screen === 'freeroam') this.setPaused(true);
      this.progression.flush();
    } else if (!this.store.get().paused) {
      this.audio.setPaused(false);
    }
  };

  private onUnload = (): void => {
    this.progression.flush();
  };

  // ===========================================================================
  // Main loop
  // ===========================================================================

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dtReal = clamp((now - this.lastNow) / 1000, 0.0005, 0.1);
    this.lastNow = now;
    this.realTime += dtReal;
    this.fps = damp(this.fps, 1 / dtReal, 2, dtReal);
    this.telemetry.fps = this.fps;
    this.store.tick(dtReal);
    this.resizeIfNeeded();
    if (!this.ready) {
      this.renderer.clear();
      return;
    }
    this.handleActions();
    const s = this.store.get();
    const simulating = !s.paused && !s.mapOpen && s.screen !== 'garage';
    const dt = simulating ? Math.min(dtReal, 1 / 15) : 0;
    if (simulating) this.simulate(dt);
    this.updateVisuals(dtReal, dt);
    this.render(dtReal);
    this.progression.update(dtReal);
  };

  private resizeIfNeeded(): void {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
    if (this.postFx) this.postFx.setSize(w, h, this.renderer.getPixelRatio());
  }

  private handleActions(): void {
    const actions = this.input.consumeActions();
    if (actions.length === 0) return;
    let interacted = false;
    for (const a of actions) {
      const s = this.store.get();
      const driving = (s.screen === 'freeroam' || s.screen === 'countdown' || s.screen === 'race') && !s.paused && !s.mapOpen;
      switch (a) {
        case 'pause':
          if (s.mapOpen) this.store.set({ mapOpen: false });
          else this.setPaused(!s.paused);
          break;
        case 'map':
          if (s.screen === 'freeroam' && !s.paused) this.api.actions.setMapOpen(!s.mapOpen);
          break;
        case 'interact':
          if (driving && s.screen === 'freeroam' && s.prompt) {
            interacted = true;
            this.interact(s.prompt.markerId);
          }
          break;
        case 'shiftUp':
          if (driving && !interacted) this.pendingShiftUp = true;
          break;
        case 'shiftDown':
          if (driving) this.pendingShiftDown = true;
          break;
        case 'camera':
          if (driving) {
            const mode = this.rig.cycleMode();
            this.rig.snap();
            this.progression.updateSettings({ cameraMode: mode });
          }
          break;
        case 'mirror':
          if (driving) this.progression.updateSettings({ mirror: !this.progression.profile.settings.mirror });
          break;
        case 'reset':
          if (driving && s.screen !== 'countdown') this.respawnOnRoad();
          break;
        case 'gearbox':
          if (driving && this.session?.def.mode !== 'drag') {
            const next = this.progression.profile.settings.transmission === 'manual' ? 'auto' : 'manual';
            this.progression.updateSettings({ transmission: next });
            this.applySettings(this.progression.profile.settings);
            this.store.toast('info', next === 'manual' ? 'Boîte manuelle' : 'Boîte automatique', next === 'manual' ? 'A / E pour passer les rapports' : '');
          }
          break;
        default:
          break;
      }
    }
  }

  private interact(markerId: string): void {
    if (markerId === 'garage') {
      this.enterGarage();
      return;
    }
    const r = this.beginEvent(markerId);
    if (!r.ok) {
      this.audio.playUi('error');
      this.store.toast('warning', 'Épreuve indisponible', r.reason ?? '');
    }
  }

  // ---------------------------------------------------------------- simulate

  private simulate(dt: number): void {
    this.time += dt;
    const s = this.store.get();
    const driving = s.screen === 'freeroam' || s.screen === 'countdown' || s.screen === 'race';
    const pin = this.playerHandle.input;
    if (driving) {
      this.input.readDrive(pin);
      if (this.debugInputActive) Object.assign(pin, this.debugInput);
      if (this.autopilot) this.driveAutopilot();
    } else {
      // parked / coasting to a stop: never hold the brake at standstill (it would select reverse)
      const rolling = this.playerHandle.vehicle.state.speed > 1.5;
      pin.throttle = 0;
      pin.brake = rolling ? 0.7 : 0;
      pin.steer = 0;
      pin.handbrake = !rolling;
      pin.nitro = false;
    }
    pin.shiftUp = this.pendingShiftUp;
    pin.shiftDown = this.pendingShiftDown;
    this.pendingShiftUp = false;
    this.pendingShiftDown = false;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= STEP && steps < MAX_STEPS) {
      this.stepPhysics();
      this.accumulator -= STEP;
      steps++;
      pin.shiftUp = false;
      pin.shiftDown = false;
    }
    if (steps === MAX_STEPS) this.accumulator = 0;

    this.processVehicleEvents(s.screen === 'freeroam');

    const pst = this.playerHandle.vehicle.state;
    this.traffic.update(dt, pst.x, pst.z, pst.vx, pst.vz);
    if (this.session) this.session.update(dt);
    this.police.update(dt);
    this.processPursuitEvents();
    if (driving) this.streetLife.update(dt, this.time, this.session !== null, s.screen === 'freeroam');
    if (s.screen === 'freeroam') this.updateFreeRoam(dt);
    this.updateSessionState();
    this.checkPlayerBounds(dt);

    for (const h of this.handles) h.vehicle.events.length = 0;
  }

  private stepPhysics(): void {
    const handles = this.handles;
    const pin = this.playerHandle.input;
    if (this.session) this.session.modifyInput(pin);

    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      if (h.disabled) {
        h.input.throttle = 0;
        h.input.brake = h.vehicle.state.speed > 1.5 ? 1 : 0;
        h.input.handbrake = true;
        h.input.nitro = false;
      }
      h.vehicle.update(STEP, h.input);
    }

    // vehicle ↔ vehicle
    for (let i = 0; i < handles.length; i++) {
      const a = handles[i];
      const sa = a.vehicle.state;
      for (let j = i + 1; j < handles.length; j++) {
        const b = handles[j];
        const sb = b.vehicle.state;
        const dx = sa.x - sb.x;
        const dz = sa.z - sb.z;
        if (dx * dx + dz * dz > 64) continue;
        const res = resolveVehiclePair(a.vehicle, b.vehicle);
        if (res) this.onVehicleCollision(a, b, res);
      }
    }

    // vehicle ↔ kinematic traffic
    const cars = this.traffic.cars;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      const sh = h.vehicle.state;
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        const dx = sh.x - c.x;
        const dz = sh.z - c.z;
        const reach = c.halfLength + 4.5;
        if (dx * dx + dz * dz > reach * reach) continue;
        const res = resolveVehicleVsBody(h.vehicle, c);
        if (res) this.onTrafficCollision(h, c, res);
      }
    }
  }

  private onVehicleCollision(a: VehicleHandle, b: VehicleHandle, res: CollisionResult): void {
    const player = a === this.playerHandle ? a : b === this.playerHandle ? b : null;
    if (!player) return;
    const other = player === a ? b : a;
    this.streetLife.lastCollisionTime = this.time;
    if (other.tag.type === 'police' && res.intensity > 1) {
      const last = this.hitTimes.get(other.id) ?? -10;
      if (this.time - last > 0.25) {
        this.hitTimes.set(other.id, this.time);
        this.police.notifyPoliceHit(other, res.intensity);
        if (res.intensity > 3) this.police.reportInfraction('ramming', clamp(res.intensity / 12, 0.2, 1));
      }
    }
  }

  private onTrafficCollision(h: VehicleHandle, car: TrafficCar, res: CollisionResult): void {
    const key = -car.id - 1;
    const last = this.hitTimes.get(key) ?? -10;
    if (this.time - last < 0.2) return;
    this.hitTimes.set(key, this.time);
    this.traffic.notifyHit(car, res.intensity);
    if (h === this.playerHandle) {
      this.streetLife.lastCollisionTime = this.time;
      if (res.intensity > 3) this.police.reportInfraction('traffic', clamp(res.intensity / 14, 0.2, 1));
    }
  }

  private processVehicleEvents(freeRoam: boolean): void {
    const cam = this.rig.camera.position;
    for (const h of this.handles) {
      const events = h.vehicle.events;
      if (events.length === 0) continue;
      const isPlayer = h === this.playerHandle;
      const st = h.vehicle.state;
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        switch (e.type) {
          case 'impact': {
            const dist = Math.hypot(e.x - cam.x, e.z - cam.z);
            if (dist < 160) {
              const count = Math.min(36, 5 + Math.round(e.intensity * 2.4));
              this.particles.sparks(e.x, e.y + 0.4, e.z, e.nx, 0.6, e.nz, e.collider ? count : count >> 1, 4 + e.intensity * 0.5);
            }
            if (isPlayer) {
              this.audio.playImpact(e.intensity, true);
              this.rig.addShake(clamp(e.intensity / 14, 0.05, 1));
              this.store.emit({ type: 'impact', intensity: clamp(e.intensity / 20, 0, 1) });
            } else if (dist < 70 && e.intensity > 2.5) {
              this.audio.playImpact(e.intensity * (1 - dist / 70) * 0.6, true);
            }
            break;
          }
          case 'softHit': {
            const c = e.collider;
            if (c.kind === 'breaker') {
              if (isPlayer) this.tryBreaker(String(c.refId), e.speedKmh);
            } else {
              this.world.hitProp(c, st.vx, st.vz);
              this.particles.debris(c.x, st.y + 0.6, c.z, 5, 0x3a3f47, 2.5);
              if (isPlayer) {
                this.audio.playImpact(3, false);
                this.rig.addShake(0.12);
                if (freeRoam) this.police.reportInfraction('property', 0.25);
              }
            }
            break;
          }
          case 'landing':
            if (isPlayer) {
              this.audio.playLanding(e.intensity);
              this.rig.addShake(clamp(e.intensity / 9, 0.1, 1));
            }
            if (e.intensity > 3) {
              this.particles.sparks(st.x, st.y + 0.15, st.z, 0, 1, 0, 14, 5);
              this.particles.dust(st.x, st.y + 0.2, st.z, st.vx * 0.2, 1, st.vz * 0.2, 0.8);
            }
            break;
          case 'shift':
            if (isPlayer) {
              this.audio.playShift(e.quality);
              if (e.quality !== 'auto') {
                this.store.emit({ type: 'shift', quality: e.quality });
                if (e.quality === 'perfect') this.audio.playUi('perfectShift');
                else if (e.quality !== 'good') this.audio.playUi('badShift');
              }
            }
            break;
          case 'launch':
            if (isPlayer) {
              this.store.emit({ type: 'launch', quality: e.quality });
              if (e.quality === 'perfect') this.audio.playUi('perfectShift');
            }
            break;
          case 'blowoff':
            if (isPlayer) this.audio.playBlowOff();
            break;
          case 'backfire': {
            const model = this.models.get(h.id);
            if (model) {
              const n = model.getExhaustPositions(this.exhaustBuf);
              const sinH = Math.sin(st.heading);
              const cosH = Math.cos(st.heading);
              for (let k = 0; k < n; k++) {
                const p = this.exhaustBuf[k];
                this.particles.flame(p.x, p.y, p.z, st.vx - sinH * 5, 0.4, st.vz - cosH * 5, 0xffa040, 0.5);
              }
            }
            if (isPlayer) this.audio.playBackfire();
            break;
          }
          case 'nitroStart':
            if (isPlayer) {
              this.audio.playNitro(true);
              this.store.emit({ type: 'nitro', active: true });
              this.rig.addShake(0.25);
            }
            break;
          case 'nitroEnd':
            if (isPlayer) {
              this.audio.playNitro(false);
              this.store.emit({ type: 'nitro', active: false });
            }
            break;
          case 'engineBlown':
            this.particles.explosion(st.x + Math.sin(st.heading) * 1.4, st.y + 0.9, st.z + Math.cos(st.heading) * 1.4, 0.6);
            if (isPlayer) this.store.toast('warning', 'Moteur cassé !', 'Trop longtemps dans la zone rouge');
            break;
          case 'puncture':
            if (isPlayer) this.store.toast('police', 'Pneus crevés !', 'Herse franchie — adhérence réduite');
            break;
          default:
            break;
        }
        if (isPlayer) {
          this.streetLife.onPlayerEvent(e, this.session !== null);
          if (this.session) this.session.onPlayerEvent(e);
        }
      }
    }
  }

  private tryBreaker(id: string, speedKmh: number): void {
    const breaker = this.world.pursuitBreakers.find((b) => b.id === id);
    if (!breaker || breaker.state !== 'intact') return;
    if (speedKmh < breaker.minSpeedKmh) {
      this.store.toast('info', breaker.name, `Percute-le à plus de ${Math.round(breaker.minSpeedKmh)} km/h pour le faire tomber`, 3);
      return;
    }
    const st = this.playerHandle.vehicle.state;
    const speed = Math.hypot(st.vx, st.vz) || 1;
    if (!this.world.triggerBreaker(id, st.vx / speed, st.vz / speed)) return;
    const gy = this.world.getGroundHeight(breaker.danger.x, breaker.danger.z);
    if (breaker.kind === 'gasstation') {
      this.particles.explosion(breaker.x, gy + 2, breaker.z, 2.6);
      this.particles.explosion(breaker.danger.x, gy + 2.5, breaker.danger.z, 3.2);
      this.particles.debris(breaker.danger.x, gy + 3, breaker.danger.z, 40, 0x2b2f36, 9);
    } else if (breaker.kind === 'watertower') {
      this.particles.splash(breaker.x, gy + 9, breaker.z, 3.2);
      this.particles.splash(breaker.danger.x, gy + 1, breaker.danger.z, 3.5);
      this.particles.debris(breaker.x, gy + 6, breaker.z, 30, 0x5a4634, 7);
    } else {
      this.particles.debris(breaker.danger.x, gy + 6, breaker.danger.z, 60, 0x6a6f78, 9);
      this.particles.dust(breaker.danger.x, gy + 1, breaker.danger.z, 0, 2, 0, 1);
      this.particles.sparks(breaker.danger.x, gy + 4, breaker.danger.z, 0, 1, 0, 30, 8);
    }
    this.audio.playCollapse();
    this.rig.addShake(0.9);
    this.store.emit({ type: 'breaker', name: breaker.name });
    this.progression.profile.stats.breakersUsed++;
    this.progression.touch();
    this.destructibleTimer = 75;
  }

  private processPursuitEvents(): void {
    const events = this.police.events;
    if (events.length === 0) return;
    const prog = this.progression;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      switch (e.type) {
        case 'spotted':
          this.audio.playUi('spotted');
          this.store.toast('police', 'Repéré !', 'Une patrouille t’a dans le viseur', 3);
          break;
        case 'pursuitStart':
          this.audio.setMusicMood('pursuit');
          this.audio.playUi('heatUp');
          this.store.emit({ type: 'pursuit', phase: 'start' });
          this.store.set({ gpsTargetId: null });
          break;
        case 'heatUp':
          this.audio.playUi('heatUp');
          this.store.emit({ type: 'heatUp', heat: e.heat });
          if (e.heat > prog.profile.stats.maxHeat) prog.profile.stats.maxHeat = e.heat;
          break;
        case 'unitDisabled':
          this.store.emit({ type: 'copDown', bounty: e.bounty });
          prog.profile.stats.copsDisabled++;
          prog.touch();
          break;
        case 'roadblock':
          this.audio.playUi('radio');
          this.store.toast('police', 'Barrage droit devant !', `À ${Math.round(e.distance / 10) * 10} m — cherche la brèche`, 4);
          break;
        case 'spikeHit':
          this.audio.playImpact(6, true);
          break;
        case 'heliInbound':
          this.audio.playUi('radio');
          this.store.toast('police', 'Hélicoptère en approche', 'Les tunnels te cachent du projecteur', 4.5);
          break;
        case 'cooldownStart':
          this.store.emit({ type: 'pursuit', phase: 'cooldown' });
          break;
        case 'lostCooldown':
          this.store.emit({ type: 'pursuit', phase: 'resumed' });
          break;
        case 'evaded': {
          const money = Math.round((e.bounty * 0.35) / 10) * 10;
          const rep = Math.round(e.bounty / 25);
          prog.profile.stats.pursuitsEvaded++;
          prog.profile.stats.totalBounty += Math.round(e.bounty);
          prog.profile.money += money;
          prog.addRep(rep);
          prog.setCarHeat(Math.max(1, e.heat - 1));
          this.police.setBaseHeat(prog.currentCar.heat);
          this.audio.playUi('evaded');
          this.audio.setMusicMood('cruise');
          this.store.emit({ type: 'pursuit', phase: 'evaded' });
          this.store.toast('reward', 'Poursuite semée !', `Prime ${Math.round(e.bounty).toLocaleString('fr-FR')} · +${money.toLocaleString('fr-FR')} $ · +${rep} REP`, 6);
          this.destructibleTimer = 40;
          this.heatDecayTimer = 0;
          break;
        }
        case 'busted': {
          const fine = Math.min(prog.profile.money, 400 * e.heat + Math.round(prog.profile.money * 0.06));
          prog.profile.stats.timesBusted++;
          prog.profile.money -= fine;
          prog.setCarHeat(1);
          prog.commit();
          const inf = this.police.state.infractions;
          this.audio.playUi('busted');
          this.audio.setMusicMood('none');
          this.store.emit({ type: 'pursuit', phase: 'busted' });
          this.store.set({
            screen: 'busted',
            prompt: null,
            mapOpen: false,
            busted: {
              fine,
              heat: e.heat,
              bounty: Math.round(e.bounty),
              durationS: e.duration,
              infractions: [
                { label: 'Excès de vitesse', count: Math.round(inf.speeding) },
                { label: 'Collisions avec la police', count: Math.round(inf.ramming) },
                { label: 'Dégradations', count: Math.round(inf.property) },
                { label: 'Accrochages avec des civils', count: Math.round(inf.traffic) },
              ],
            },
          });
          this.police.setEnabled(false);
          break;
        }
        default:
          break;
      }
    }
    events.length = 0;
  }

  private updateFreeRoam(dt: number): void {
    const st = this.playerHandle.vehicle.state;
    const s = this.store.get();

    // interaction prompt: nearest portal in range
    let best: PortalEntry | null = null;
    let bestD = PROMPT_RADIUS;
    for (const p of this.portals) {
      const d = Math.hypot(p.marker.x - st.x, p.marker.z - st.z);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const pursuit = this.police.state.status !== 'idle';
    if (best && !pursuit && st.speedKmh < 110) {
      if (!s.prompt || s.prompt.markerId !== best.marker.id) {
        const ev = best.marker.event;
        this.store.set({
          prompt: {
            key: 'E',
            title: ev ? `${ev.modeLabel} — ${ev.name}` : 'Entrer dans le garage',
            subtitle: ev
              ? ev.locked
                ? `Niveau REP ${ev.repLevelRequired} requis`
                : `${ev.lengthKm.toLocaleString('fr-FR')} km · ${ev.rewardMoney.toLocaleString('fr-FR')} $ · +${ev.rewardRep} REP`
              : 'Tuning, peinture et nouvelles voitures',
            markerId: best.marker.id,
            locked: !!ev && ev.locked,
          },
        });
      }
    } else if (s.prompt) {
      this.store.set({ prompt: null });
    }
    for (const p of this.portals) p.model.setHighlighted(p === best);

    // GPS route
    if (s.gpsTargetId) {
      this.gpsTimer -= dt;
      const target = s.markers.find((m) => m.id === s.gpsTargetId);
      if (!target) {
        this.store.set({ gpsTargetId: null });
        this.telemetry.route = null;
      } else if (Math.hypot(target.x - st.x, target.z - st.z) < 28) {
        this.store.set({ gpsTargetId: null });
        this.telemetry.route = null;
        this.store.toast('info', 'Destination atteinte', target.label, 3);
      } else if (this.gpsTimer <= 0) {
        this.gpsTimer = 1.5;
        this.telemetry.route = routeBetween(this.world, { x: st.x, z: st.z }, { x: target.x, z: target.z });
        this.telemetry.routeIsGps = true;
      }
    }

    // wanted level slowly cools down while driving clean
    if (!pursuit) {
      this.heatDecayTimer += dt;
      if (this.heatDecayTimer > 150 && this.progression.currentCar.heat > 1) {
        this.heatDecayTimer = 0;
        this.progression.setCarHeat(this.progression.currentCar.heat - 1);
        this.police.setBaseHeat(this.progression.currentCar.heat);
      }
      if (this.destructibleTimer > 0) {
        this.destructibleTimer -= dt;
        if (this.destructibleTimer <= 0) this.world.resetDestructibles();
      }
    }
  }

  private updateSessionState(): void {
    const session = this.session;
    if (!session) return;
    if (session.done && session.results && this.store.get().screen !== 'results') {
      if (session.results.failReason === 'Abandon') return;
      this.store.set({ screen: 'results', results: session.results, paused: false, mapOpen: false });
      this.audio.setMusicMood('menu');
      this.input.setEnabled(false);
    }
  }

  private checkPlayerBounds(dt: number): void {
    const st = this.playerHandle.vehicle.state;
    const b = this.world.bounds;
    const out = st.x < b.minX + 4 || st.x > b.maxX - 4 || st.z < b.minZ + 4 || st.z > b.maxZ - 4;
    const drowned = st.surface === 'water' && st.grounded;
    if (out || drowned || !isFinite(st.x) || !isFinite(st.z)) {
      this.offRoadTimer += dt;
      if (this.offRoadTimer > (out ? 0.1 : 1.2)) {
        if (!isFinite(st.x) || !isFinite(st.z)) this.placePlayer(GARAGE_SPOT.x, GARAGE_SPOT.z, GARAGE_SPOT.heading);
        else this.respawnOnRoad();
        this.store.toast('info', 'Voiture replacée sur la route', '', 2.5);
      }
    } else {
      this.offRoadTimer = 0;
    }
  }

  /** Debug / attract autopilot: follows the current race route. */
  private driveAutopilot(): void {
    const session = this.session;
    if (!session || session.done) return;
    const pin = this.playerHandle.input;
    const st = this.playerHandle.vehicle.state;
    const route = session.built.route;
    const s = session.playerRouteS;
    const speed = Math.abs(st.speed);
    const look = 5 + speed * 0.36;
    const target = route.pointAt(s + look);
    const desired = Math.atan2(target.x - st.x, target.z - st.z);
    const err = angleDiff(st.heading, desired);
    pin.steer = clamp(-err * 2.6 - st.yawRate * 0.12, -1, 1);
    // speed plan: slowest upcoming corner, reachable with a conservative braking rate
    let vmax = 95;
    for (let d = 4; d < 40 + speed * 3.2; d += 6) {
      const k = Math.abs(route.curvatureAt(s + d, 12));
      const corner = Math.sqrt(7 / Math.max(k, 1e-4));
      vmax = Math.min(vmax, Math.sqrt(corner * corner + 2 * 5 * Math.max(0, d - 8)));
    }
    if (speed < vmax - 1.5) {
      pin.throttle = Math.abs(err) > 0.5 ? 0.5 : 1;
      pin.brake = 0;
    } else if (speed > vmax + 0.5) {
      pin.throttle = 0;
      pin.brake = 1;
    } else {
      pin.throttle = 0.15;
      pin.brake = 0;
    }
    // stuck against something: put the car back on the route
    this.autopilotStuck = speed < 1 && this.store.get().screen === 'race' ? this.autopilotStuck + 1 / 60 : 0;
    if (this.autopilotStuck > 2.5) {
      this.autopilotStuck = 0;
      this.respawnOnRoad();
    }
    pin.handbrake = false;
    pin.nitro = false;
    if (session.def.mode === 'drag' && st.rpm > this.playerHandle.vehicle.config.perfectShiftLo + 100 && st.gear < 6 && !st.shifting) {
      this.pendingShiftUp = true;
    }
  }

  // ===========================================================================
  // Visual update
  // ===========================================================================

  private updateVisuals(dtReal: number, dt: number): void {
    const s = this.store.get();
    const camera = this.rig.camera;

    if (s.screen === 'garage' && this.garage) {
      this.garageIdle += dtReal;
      if (this.garageIdle > 3.5 && !this.dragging) this.garageYaw += dtReal * 0.16;
      this.garage.update(dtReal, this.realTime);
      if (this.garageModel) this.garageModel.sync(this.garagePose, dtReal);
      this.rig.updateGarage(this.garage.orbitTarget, this.garageYaw, this.garagePitch, this.garageDist);
      this.audio.update(dtReal, this.audioFrame());
      this.writeTelemetry(dtReal);
      return;
    }

    const pv = this.playerHandle.vehicle;
    const pst = pv.state;

    // --- physics vehicles
    for (const h of this.handles) {
      const model = this.models.get(h.id);
      if (!model) continue;
      const st = h.vehicle.state;
      model.sync(st, dt);
      if (dt > 0) this.emitVehicleFx(h, model, dt);
    }

    // --- police
    this.sirens.length = 0;
    for (const u of this.police.units) {
      const model = this.models.get(u.handle.id);
      if (!model) continue;
      model.setSiren(u.sirenOn);
      if (u.sirenOn && this.sirens.length < 3) {
        const us = u.handle.vehicle.state;
        const rx = us.x - camera.position.x;
        const rz = us.z - camera.position.z;
        const dist = Math.hypot(rx, rz);
        if (dist < 380) {
          const src = this.sirenPool[this.sirens.length];
          // camera right vector on the ground plane
          camera.getWorldDirection(this.v3a);
          const rightX = -this.v3a.z;
          const rightZ = this.v3a.x;
          src.distance = dist;
          src.pan = dist > 1 ? clamp((rx * rightX + rz * rightZ) / dist, -1, 1) : 0;
          src.approach = dist > 1 ? -((us.vx - pst.vx) * rx + (us.vz - pst.vz) * rz) / dist : 0;
          this.sirens.push(src);
        }
      }
    }
    this.audio.setSirens(this.sirens);
    this.syncRoadblocks();
    const heliState = this.police.helicopter;
    this.heli.sync(heliState, dt, (x, z) => this.world.getGroundHeight(x, z));
    if (heliState.active) {
      const hd = Math.hypot(heliState.x - camera.position.x, heliState.z - camera.position.z);
      this.audio.setHelicopter(clamp(1 - hd / 320, 0, 1));
    } else {
      this.audio.setHelicopter(0);
    }

    // --- traffic
    this.syncTraffic(dt);

    // --- gates / portals
    this.syncCheckpoints();
    const showPortals = !this.session;
    for (const p of this.portals) {
      const g = p.model.group;
      const near = Math.abs(g.position.x - pst.x) < 520 && Math.abs(g.position.z - pst.z) < 520;
      g.visible = showPortals && near;
      if (g.visible) p.model.update(dtReal, this.realTime);
    }
    for (const c of this.checkpointPool) if (c.model.group.visible) c.model.update(dtReal, this.realTime);

    // --- camera
    const cfg = pv.config;
    if (s.screen === 'title') {
      this.rig.updateOrbit(dtReal, this.realTime, 0, 55, 0, 420, 110, 0.035);
    } else if (s.screen === 'results' || s.screen === 'busted') {
      this.rig.updateOrbit(dtReal, this.realTime, pst.x, pst.y + 0.8, pst.z, 7.5, 1.6, 0.35);
    } else {
      this.rig.updateDrive(dtReal, pst, cfg, this.world, this.input.lookBack, pst.nitroActive);
    }
    this.camPos2.x = camera.position.x;
    this.camPos2.z = camera.position.z;

    // --- world, particles
    this.world.update(dt, this.time, camera.position);
    this.particles.update(dt, camera);
    this.skids.update(dt);

    // --- audio & HUD
    this.audio.update(dtReal, this.audioFrame());
    this.writeTelemetry(dtReal);
  }

  private audioFrame(): AudioFrame {
    const v = this.playerHandle.vehicle;
    const st = v.state;
    const f = this._audioFrame;
    f.rpm = st.rpm;
    f.redlineRpm = v.config.redlineRpm;
    f.throttle = st.throttle;
    f.speed = Math.hypot(st.vx, st.vz);
    f.turbo = st.turbo;
    f.nitroActive = st.nitroActive;
    f.wheelSlip = st.wheelSlip;
    f.surface = st.surface;
    f.grounded = st.grounded;
    f.inTunnel = this.world.isInTunnel(st.x, st.z);
    f.engineBlown = st.engineBlown;
    return f;
  }

  private readonly _audioFrame: AudioFrame = {
    rpm: 900,
    redlineRpm: 7000,
    throttle: 0,
    speed: 0,
    turbo: 0,
    nitroActive: false,
    wheelSlip: 0,
    surface: 'asphalt',
    grounded: true,
    inTunnel: false,
    engineBlown: false,
  };

  private emitVehicleFx(h: VehicleHandle, model: CarModel, dt: number): void {
    const st = h.vehicle.state;
    const cam = this.rig.camera.position;
    const dx = st.x - cam.x;
    const dz = st.z - cam.z;
    if (dx * dx + dz * dz > 220 * 220) return;
    const hard = st.surface === 'asphalt' || st.surface === 'concrete';
    const slip = st.wheelSlip;
    const trail = h.tag.type !== 'police';
    for (let w = 2; w < 4; w++) {
      const id = h.id * 4 + w;
      if (st.grounded && slip > 0.3 && hard) {
        const p = model.getWheelPosition(w, this.v3b);
        if (Math.random() < slip * dt * 55) {
          this.particles.tireSmoke(p.x, p.y + 0.15, p.z, st.vx * 0.25, 0.6 + slip, st.vz * 0.25, clamp(slip, 0.3, 1));
        }
        if (trail) this.skids.add(id, p.x, p.y + 0.03, p.z, 0.26, clamp((slip - 0.25) * 1.4, 0.2, 1));
      } else {
        if (trail) this.skids.end(id);
        if (st.grounded && !hard && Math.abs(st.speed) > 7 && Math.random() < dt * 30) {
          const p = model.getWheelPosition(w, this.v3b);
          this.particles.dust(p.x, p.y + 0.2, p.z, st.vx * 0.3, 1, st.vz * 0.3, clamp(Math.abs(st.speed) / 30, 0.3, 1));
        }
      }
    }
    if ((h.disabled || st.damage > 0.75 || st.engineBlown) && Math.random() < dt * 14) {
      this.particles.engineSmoke(st.x + Math.sin(st.heading) * 1.5, st.y + 0.9, st.z + Math.cos(st.heading) * 1.5, h.disabled ? 1 : 0.6);
    }
  }

  private syncTraffic(dt: number): void {
    const seen = this.trafficSeen;
    seen.clear();
    for (const car of this.traffic.cars) {
      seen.add(car.id);
      const key = `${car.kind}:${car.colorIndex}`;
      let vis = this.trafficVisuals.get(car.id);
      if (vis && vis.key !== key) {
        this.releaseTrafficVisual(vis);
        vis = undefined;
      }
      if (!vis) {
        const pool = this.trafficPool.get(key);
        const model = pool && pool.length > 0 ? pool.pop()! : createTrafficModel(car.kind, car.colorIndex);
        model.setHeadlights(true);
        model.group.visible = true;
        if (!model.group.parent) this.scene.add(model.group);
        vis = { model, key };
        this.trafficVisuals.set(car.id, vis);
      }
      vis.model.sync(car, dt);
      if (car.mode === 'wrecked' && dt > 0 && Math.random() < dt * 8) {
        this.particles.engineSmoke(car.x + Math.sin(car.heading) * 1.4, car.y + 1, car.z + Math.cos(car.heading) * 1.4, 0.5);
      }
    }
    if (this.trafficVisuals.size !== seen.size) {
      for (const [id, vis] of this.trafficVisuals) {
        if (seen.has(id)) continue;
        this.releaseTrafficVisual(vis);
        this.trafficVisuals.delete(id);
        this.hitTimes.delete(-id - 1);
      }
    }
  }

  private releaseTrafficVisual(vis: TrafficVisual): void {
    vis.model.group.visible = false;
    let pool = this.trafficPool.get(vis.key);
    if (!pool) {
      pool = [];
      this.trafficPool.set(vis.key, pool);
    }
    pool.push(vis.model);
  }

  private syncRoadblocks(): void {
    const blocks = this.police.roadblocks;
    if (blocks.length === 0 && this.roadblockVisuals.size === 0) return;
    for (const rb of blocks) {
      let vis = this.roadblockVisuals.get(rb.id);
      if (!vis) {
        vis = { groups: [] };
        for (const b of rb.barriers) {
          const g = createRoadBarrier(b.width);
          g.position.set(b.x, this.world.getGroundHeight(b.x, b.z), b.z);
          // the barrier runs along its local X axis; `heading` is the direction of the road it blocks
          g.rotation.y = b.heading;
          this.scene.add(g);
          vis.groups.push(g);
        }
        if (rb.spikes) {
          const g = createSpikeStrip(rb.spikes.halfLength * 2);
          g.position.set(rb.spikes.x, this.world.getGroundHeight(rb.spikes.x, rb.spikes.z) + 0.02, rb.spikes.z);
          g.rotation.y = rb.spikes.heading;
          this.scene.add(g);
          vis.groups.push(g);
        }
        this.roadblockVisuals.set(rb.id, vis);
      }
    }
    if (this.roadblockVisuals.size !== blocks.length) {
      for (const [id, vis] of this.roadblockVisuals) {
        if (blocks.some((b) => b.id === id)) continue;
        for (const g of vis.groups) {
          this.scene.remove(g);
          const dispose = g.userData.dispose as (() => void) | undefined;
          if (dispose) dispose();
        }
        this.roadblockVisuals.delete(id);
      }
    }
  }

  private syncCheckpoints(): void {
    const session = this.session;
    if (!session) return;
    if (session.gatesVersion === this.sessionGatesVersion) return;
    this.sessionGatesVersion = session.gatesVersion;
    const gates = session.gates;
    for (let i = 0; i < gates.length; i++) {
      const g = gates[i];
      let entry = this.checkpointPool[i];
      if (!entry || Math.abs(entry.width - g.width) > 0.5) {
        if (entry) {
          this.scene.remove(entry.model.group);
          entry.model.dispose();
        }
        entry = { model: createCheckpoint(g.width), width: g.width };
        this.checkpointPool[i] = entry;
        this.scene.add(entry.model.group);
      }
      entry.model.group.position.set(g.x, this.world.getGroundHeight(g.x, g.z), g.z);
      entry.model.group.rotation.y = g.heading;
      entry.model.setLook(g.look);
    }
    for (let i = gates.length; i < this.checkpointPool.length; i++) this.checkpointPool[i].model.setLook('hidden');
  }

  // ---------------------------------------------------------------- telemetry

  private putBlip(kind: BlipKind, x: number, z: number, heading: number): void {
    const t = this.telemetry;
    let b = t.blips[t.blipCount];
    if (!b) {
      b = { kind, x, z, heading };
      t.blips[t.blipCount] = b;
    }
    b.kind = kind;
    b.x = x;
    b.z = z;
    b.heading = heading;
    t.blipCount++;
  }

  private writeTelemetry(dt: number): void {
    const t = this.telemetry;
    const v = this.playerHandle.vehicle;
    const st = v.state;
    const cfg = v.config;
    t.speedKmh = st.speedKmh;
    t.rpm = st.rpm;
    t.redlineRpm = cfg.redlineRpm;
    t.maxRpm = Math.ceil((cfg.revLimitRpm + 200) / 1000) * 1000;
    t.gear = st.gear;
    t.manual = v.manualGearbox;
    t.perfectShiftLo = cfg.perfectShiftLo;
    t.perfectShiftHi = cfg.perfectShiftHi;
    if (v.manualGearbox && st.gear > 0 && st.gear < cfg.gearRatios.length) {
      if (st.rpm > cfg.perfectShiftHi) t.shiftLight = 'over';
      else if (st.rpm >= cfg.perfectShiftLo) t.shiftLight = 'perfect';
      else if (st.rpm >= cfg.perfectShiftLo - cfg.redlineRpm * 0.07) t.shiftLight = 'approach';
      else t.shiftLight = 'none';
    } else if (v.manualGearbox && st.rpm > cfg.redlineRpm) {
      t.shiftLight = 'over';
    } else {
      t.shiftLight = 'none';
    }
    t.nitro = st.nitro;
    t.nitroActive = st.nitroActive;
    t.turbo = st.turbo;
    t.engineTemp = st.engineTemp;
    t.damage = st.damage;
    t.drifting = st.drifting;
    const fxTarget = smoothstep(130, 330, st.speedKmh) * 0.65 + (st.nitroActive ? 0.45 : 0);
    t.speedFx = damp(t.speedFx, clamp(fxTarget, 0, 1), 5, dt);
    t.x = st.x;
    t.z = st.z;
    t.heading = st.heading;

    // minimap blips
    t.blipCount = 0;
    if (this.session) t.blipCount = this.session.writeBlips(t, t.blipCount);
    for (const u of this.police.units) {
      if (!u.handle.alive || u.mode === 'disabled') continue;
      const us = u.handle.vehicle.state;
      this.putBlip('police', us.x, us.z, us.heading);
    }
    for (const rb of this.police.roadblocks) this.putBlip('roadblock', rb.x, rb.z, rb.heading);
    const heli = this.police.helicopter;
    if (heli.active) this.putBlip('heli', heli.x, heli.z, heli.heading);
    for (const c of this.traffic.cars) {
      const dx = c.x - st.x;
      const dz = c.z - st.z;
      if (dx * dx + dz * dz < 300 * 300) this.putBlip('traffic', c.x, c.z, c.heading);
    }

    // pursuit
    const ps = this.police.state;
    const tp = t.pursuit;
    tp.status = ps.status;
    tp.heat = ps.status === 'idle' ? this.progression.currentCar.heat : ps.heat;
    tp.heatProgress = ps.heatProgress;
    tp.bounty = ps.bounty;
    tp.evade = ps.evadeProgress;
    tp.cooldown = ps.cooldownProgress;
    tp.bust = ps.bustProgress;
    tp.inSight = ps.inSight;
    tp.units = ps.unitsEngaged;
    tp.heli = ps.heliActive;
    tp.durationS = ps.duration;
  }

  // ===========================================================================
  // Render
  // ===========================================================================

  private render(dt: number): void {
    const s = this.store.get();
    const renderer = this.renderer;
    const camera = this.rig.camera;
    const inGarage = s.screen === 'garage' && this.garage !== null;
    const scene = inGarage ? this.garage!.scene : this.scene;
    const driving = s.screen === 'freeroam' || s.screen === 'countdown' || s.screen === 'race';
    const mirror = driving && !s.mapOpen && this.progression.profile.settings.mirror;

    if (mirror && (this.mirrorFrame++ & 1) === 0) {
      renderer.setRenderTarget(this.mirrorTarget);
      renderer.clear();
      renderer.render(this.scene, this.rig.mirrorCamera);
      renderer.setRenderTarget(null);
    }

    renderer.setViewport(0, 0, this.width, this.height);
    renderer.setScissorTest(false);
    if (this.postFx) {
      this.postFx.setScene(scene, camera);
      this.postFx.render(dt);
    } else {
      renderer.render(scene, camera);
    }

    if (mirror) {
      const w = Math.min(MIRROR_RECT.maxWidth, this.width * MIRROR_RECT.widthFrac);
      const h = w / MIRROR_RECT.aspect;
      const x = (this.width - w) / 2;
      const y = this.height - MIRROR_RECT.top - h;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.setScissorTest(true);
      renderer.render(this.mirrorScene, this.mirrorOrtho);
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, this.width, this.height);
      renderer.autoClear = autoClear;
    }
  }

  // ===========================================================================
  // Debug hooks (window.__apex) — used by automated checks, harmless in production
  // ===========================================================================

  private createDebugApi() {
    return {
      api: () => this.api,
      ready: () => this.ready,
      player: () => this.playerHandle?.vehicle.state,
      playerVehicle: () => this.playerHandle?.vehicle,
      world: () => this.world,
      police: () => this.police,
      traffic: () => this.traffic,
      session: () => this.session,
      handles: () => this.handles,
      renderInfo: () => ({ calls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles }),
      setAutopilot: (on: boolean) => {
        this.autopilot = on;
      },
      teleport: (x: number, z: number, heading = 0) => this.placePlayer(x, z, heading),
      /** Run the simulation without rendering. */
      fastForward: (seconds: number) => {
        const n = Math.round(seconds * 60);
        for (let i = 0; i < n; i++) {
          const s = this.store.get();
          if (s.paused || s.mapOpen || s.screen === 'garage') break;
          this.simulate(1 / 60);
        }
      },
      addMoney: (n: number) => this.progression.addMoney(n),
      addRep: (n: number) => this.progression.addRep(n),
      setInput: (patch: Partial<{ throttle: number; brake: number; steer: number; handbrake: boolean; nitro: boolean }>) => {
        Object.assign(this.debugInput, patch);
        this.debugInputActive = true;
      },
      clearInput: () => {
        this.debugInputActive = false;
      },
    };
  }

  private debugInputActive = false;
  private readonly debugInput = { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.progression.flush();
    this.input.dispose();
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('beforeunload', this.onUnload);
    this.audio.dispose();
    if (this.ready) {
      for (const m of this.models.values()) m.dispose();
      for (const v of this.trafficVisuals.values()) v.model.dispose();
      for (const pool of this.trafficPool.values()) for (const m of pool) m.dispose();
      for (const p of this.portals) p.model.dispose();
      for (const c of this.checkpointPool) c.model.dispose();
      this.heli.dispose();
      this.particles.dispose();
      this.skids.dispose();
      this.world.dispose();
    }
    if (this.garageModel) this.garageModel.dispose();
    if (this.garage) this.garage.dispose();
    if (this.postFx) this.postFx.dispose();
    this.mirrorTarget.dispose();
    this.renderer.dispose();
  }
}
