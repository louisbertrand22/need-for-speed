/* =============================================================================
 * APEX NOCTURNE — shared contracts
 * -----------------------------------------------------------------------------
 * Every module (physics, audio, world, vehicle models, AI, game modes, UI) codes
 * against the interfaces of this file. DO NOT change it without coordinating:
 * it is the integration contract between independently developed modules.
 *
 * CONVENTIONS
 *  - Units: metres, seconds, radians, kilograms, newtons. Speeds are m/s unless a
 *    field name ends with `Kmh`.
 *  - World axes: +X = east, +Y = up, +Z = south. Top-down maps draw X to the
 *    right and Z downwards.
 *  - Heading `h` (yaw): forward(h) = (sin h, 0, cos h), right(h) = (-cos h, 0, sin h).
 *    A 3D model whose FRONT points to its local +Z is oriented with
 *    `object.rotation.y = h`. heading of a direction (dx, dz) = atan2(dx, dz).
 *  - Steering input: -1 = full left, +1 = full right. Turning right DECREASES
 *    the heading (yawRate < 0); turning left increases it.
 *  - No TypeScript `enum`s (string unions only); use `import type` for types.
 * ===========================================================================*/
import type * as THREE from 'three';
import type { PolylinePath } from './path';

// -----------------------------------------------------------------------------
// Basics
// -----------------------------------------------------------------------------

export interface Vec2 {
  x: number;
  z: number;
}

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SpawnPoint {
  x: number;
  z: number;
  heading: number;
}

// -----------------------------------------------------------------------------
// World / city
// -----------------------------------------------------------------------------

export type DistrictId = 'downtown' | 'lantern' | 'docks' | 'hills' | 'highway';

export type SurfaceType = 'asphalt' | 'concrete' | 'dirt' | 'grass' | 'water';

export type RoadKind = 'street' | 'avenue' | 'highway' | 'hill' | 'industrial' | 'ramp';

export interface RoadNode {
  id: number; // === index in RoadGraph.nodes
  x: number;
  z: number;
  /** ids of the edges touching this node */
  edges: number[];
}

export interface RoadEdge {
  id: number; // === index in RoadGraph.edges
  a: number; // node id at points[0]
  b: number; // node id at points[points.length - 1]
  /** Centre line from node a to node b, endpoints included, spacing <= 20 m on curves. */
  points: Vec2[];
  length: number;
  /** Full drivable width (m), both directions together. */
  width: number;
  /** Lanes per direction (1..3). Right-hand traffic. */
  lanes: number;
  kind: RoadKind;
  district: DistrictId;
  speedLimitKmh: number;
}

export interface RoadHit {
  edge: RoadEdge;
  /** distance along the edge from node a (m) */
  t: number;
  /** closest point on the centre line */
  x: number;
  z: number;
  /** unsigned distance from the query point to the centre line */
  dist: number;
  /** unit direction of the edge (a -> b) at that point */
  dirX: number;
  dirZ: number;
}

export interface RoadGraph {
  readonly nodes: RoadNode[];
  readonly edges: RoadEdge[];
  /** Closest node (always returns one). */
  nearestNode(x: number, z: number): RoadNode;
  /** Closest point on any road centre line within maxDist (default 60 m), else null. */
  nearestRoad(x: number, z: number, maxDist?: number): RoadHit | null;
  /**
   * Fastest route (A*, cost = length / speedLimit) between two nodes.
   * Returns node ids including both ends ([from] when from === to, [] if unreachable —
   * the graph MUST be a single connected component so this never happens in practice).
   */
  findPath(fromNode: number, toNode: number): number[];
  /** Concatenates the edge centre lines along a node path (in travel order, no duplicate points). */
  pathPolyline(nodeIds: number[]): Vec2[];
  /** The edge joining two adjacent nodes, or null. */
  edgeBetween(a: number, b: number): RoadEdge | null;
}

export type ColliderKind = 'building' | 'wall' | 'barrier' | 'pillar' | 'prop' | 'breaker' | 'roadblock';

/**
 * Static obstacle on the XZ plane with a vertical span.
 * Box local axes follow the heading convention: local +Z -> (sin rot, cos rot),
 * local +X -> (cos rot, -sin rot).
 */
export interface StaticCollider {
  /** unique id assigned by the world */
  id: number;
  shape: 'box' | 'circle';
  x: number;
  z: number;
  /** box half-extents along its local X / Z axes (0 for circles) */
  hx: number;
  hz: number;
  /** box yaw (0 for circles) */
  rot: number;
  /** circle radius; for boxes: bounding radius = hypot(hx, hz) */
  r: number;
  /** vertical span (world Y). A vehicle whose base y is above yMax flies over it. */
  yMin: number;
  yMax: number;
  kind: ColliderKind;
  /**
   * Soft colliders never block: the vehicle drives through, loses a little speed and the
   * physics emits a `softHit` event (knock-over props, pursuit-breaker weak points).
   */
  soft?: boolean;
  /** id of the prop / pursuit breaker / roadblock this collider belongs to */
  refId?: string | number;
}

export interface PhysicsEnvironment {
  /** Height (world Y) of the drivable surface under (x, z). Single-valued, continuous except at ramp ends. */
  getGroundHeight(x: number, z: number): number;
  getSurface(x: number, z: number): SurfaceType;
  /**
   * Writes every collider whose bounding circle intersects the query circle into
   * out[0..n-1] and returns n (does not shrink `out`). Must not allocate.
   */
  queryColliders(x: number, z: number, radius: number, out: StaticCollider[]): number;
}

export type BreakerKind = 'watertower' | 'gasstation' | 'scaffold';

/** Destructible "brise-poursuite" structure. Live object: fields are mutated by the world. */
export interface PursuitBreaker {
  id: string;
  kind: BreakerKind;
  /** French display name */
  name: string;
  /** position of the weak point (a soft collider of kind 'breaker' with refId === id sits here) */
  x: number;
  z: number;
  /** minimum impact speed to bring it down */
  minSpeedKmh: number;
  /** area crushed by the debris */
  danger: { x: number; z: number; radius: number };
  state: 'intact' | 'collapsing' | 'destroyed';
  /** true only during the short window (≈0.3 s → 2.5 s after the trigger) while debris crush vehicles */
  dangerActive: boolean;
}

export interface RampInfo {
  id: string;
  x: number;
  z: number;
  heading: number; // travel direction going UP the ramp
  length: number;
  width: number;
  height: number;
}

export type LandmarkId =
  | 'garage'
  | 'downtownCore'
  | 'lanternPlaza'
  | 'docksGate'
  | 'docksPier'
  | 'hillsSummit'
  | 'hillsEastGate'
  | 'hillsNorthGate'
  | 'hillsSouthGate'
  | 'ringNorth'
  | 'ringEast'
  | 'ringSouth'
  | 'tunnelMid'
  | 'bridgeMid';

export interface MapRoad {
  points: Vec2[];
  width: number;
  kind: RoadKind;
}

/** Static 2D data for the minimap / world map. */
export interface MapData {
  bounds: Rect;
  roads: MapRoad[];
  districts: { id: DistrictId; name: string; color: string; polygon: Vec2[]; labelX: number; labelZ: number }[];
  /** water polygons */
  water: Vec2[][];
  /** footprints of notable structures (bridge deck, tunnel) for map decoration */
  tunnels: Vec2[][];
  bridges: Vec2[][];
}

export interface CityWorld extends PhysicsEnvironment {
  /** Everything visual. Add to the scene once. */
  readonly group: THREE.Group;
  readonly bounds: Rect;
  readonly roads: RoadGraph;
  readonly mapData: MapData;
  /** Every landmark lies ON a road centre line (within 2 m) with a heading along the road. */
  readonly landmarks: Record<LandmarkId, SpawnPoint>;
  readonly pursuitBreakers: PursuitBreaker[];
  readonly ramps: RampInfo[];
  /** Suggested scene fog (THREE.FogExp2) */
  readonly fogColor: number;
  readonly fogDensity: number;

  districtAt(x: number, z: number): DistrictId;
  /** true when no building / wall blocks the straight segment (police vision, 2D test). */
  lineOfSight(x1: number, z1: number, x2: number, z2: number): boolean;
  /** true while (x, z) is inside the highway tunnel (audio reverb, lighting). */
  isInTunnel(x: number, z: number): boolean;

  /** Dynamic colliders (police roadblocks...). The world assigns the id. */
  addCollider(c: Omit<StaticCollider, 'id'>): StaticCollider;
  removeCollider(c: StaticCollider): void;

  /** Knock a soft prop away (called by the engine on a `softHit` event of kind 'prop'). */
  hitProp(collider: StaticCollider, vx: number, vz: number): void;
  /** Bring a pursuit breaker down; (dirX, dirZ) = travel direction of the car. Returns false if not intact. */
  triggerBreaker(id: string, dirX: number, dirZ: number): boolean;
  /** Rebuild every destroyed breaker / knocked prop. */
  resetDestructibles(): void;

  /**
   * Per-frame animation (neon flicker, collapse animations, sky follows the camera,
   * pooled street lights relocation...). `focus` = camera position.
   */
  update(dt: number, time: number, focus: THREE.Vector3): void;
  dispose(): void;
}

// -----------------------------------------------------------------------------
// Cars: catalogue specs, tuning, visuals
// -----------------------------------------------------------------------------

export type Drivetrain = 'FWD' | 'RWD' | 'AWD';
export type Aspiration = 'na' | 'turbo';
export type CarCategory = 'tuner' | 'hatch' | 'muscle' | 'euro' | 'gt' | 'exotic' | 'hyper';
/** Silhouette family for the procedural model builder (one distinct shape per value). */
export type BodyStyle = 'tuner' | 'hatch' | 'muscle' | 'coupe' | 'gt' | 'exotic' | 'hyper';

export interface CarDimensions {
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  rideHeight: number;
}

/** Physical description of a stock vehicle (input of buildVehicleConfig). */
export interface CarPhysicsSpec {
  id: string;
  drivetrain: Drivetrain;
  massKg: number;
  /** stock peak power (metric hp) and torque */
  powerHp: number;
  torqueNm: number;
  idleRpm: number;
  redlineRpm: number;
  cylinders: number;
  aspiration: Aspiration;
  /** forward gear ratios (6 gears); the final drive is derived so that topSpeedKmh is reached in top gear */
  gearRatios: number[];
  /** stock top speed target (km/h) — drives the aero drag */
  topSpeedKmh: number;
  /** stock peak lateral grip (g) on dry asphalt */
  grip: number;
  /** 0..1 steering sharpness / agility */
  agility: number;
  /** stock braking deceleration (g) */
  brakeG: number;
  /** 0..1 how eagerly the rear steps out (drift friendliness) */
  driftBias: number;
  dims: CarDimensions;
}

export interface CarSpec extends CarPhysicsSpec {
  name: string;
  maker: string;
  category: CarCategory;
  categoryLabel: string;
  bodyStyle: BodyStyle;
  tagline: string;
  description: string;
  price: number;
  /** REP level required to buy */
  repLevel: number;
  /** 1..5 price tier (upgrade cost multiplier) */
  tier: number;
  defaultVisuals: CarVisuals;
}

export type TunePart = 'engine' | 'turbo' | 'transmission' | 'suspension' | 'brakes' | 'tires' | 'nitro';
/** 0 = Stock, 1 = Street, 2 = Pro, 3 = Ultimate */
export type TuneLevel = 0 | 1 | 2 | 3;
export type TuningState = Record<TunePart, TuneLevel>;

export type PaintFinish = 'metallic' | 'pearl' | 'matte';

export interface CarVisuals {
  /** '#rrggbb' */
  paintColor: string;
  paintFinish: PaintFinish;
  /** index into RIM_STYLES (catalog.ts) */
  rimStyle: number;
  rimColor: string;
  /** index into SPOILERS (0 = none) */
  spoiler: number;
  /** index into BODY_KITS (0 = stock) */
  bodyKit: number;
  /** under-glow colour, null = off */
  neonColor: string | null;
  /** index into WINDOW_TINTS */
  windowTint: number;
  /** nitro flame colour */
  nitroColor: string;
}

/** Fully resolved physical parameters of one vehicle (spec + tuning). Produced by buildVehicleConfig. */
export interface VehicleConfig {
  specId: string;
  // chassis
  mass: number;
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  track: number;
  wheelRadius: number;
  cgHeight: number;
  /** static share of the weight on the front axle (0..1) */
  frontWeight: number;
  drivetrain: Drivetrain;
  // engine
  cylinders: number;
  aspiration: Aspiration;
  idleRpm: number;
  redlineRpm: number;
  /** hard limiter (slightly above the redline) */
  revLimitRpm: number;
  peakTorqueNm: number;
  peakPowerHp: number;
  /** [rpm, torque Nm] points, linearly interpolated (turbo excluded) */
  torqueCurve: [number, number][];
  // forced induction
  /** extra torque fraction at full spool (0 = no turbo) */
  turboBoost: number;
  /** spool-up rate (1/s) */
  turboSpool: number;
  // transmission
  gearRatios: number[];
  reverseRatio: number;
  finalDrive: number;
  /** torque cut duration during a shift (s) */
  shiftTime: number;
  efficiency: number;
  autoUpRpm: number;
  autoDownRpm: number;
  /** "perfect shift" window (manual gearbox / drag) */
  perfectShiftLo: number;
  perfectShiftHi: number;
  // nitro
  /** seconds of continuous burn for a full tank */
  nitroCapacity: number;
  /** extra forward acceleration while burning (m/s²) at low speed; fades toward top speed */
  nitroAccel: number;
  /** passive refill: fraction of the tank per second */
  nitroRegen: number;
  // resistance / aero
  /** F_drag = dragCoef · v² (N) */
  dragCoef: number;
  /** F_roll = rollCoef · m · g (N) */
  rollCoef: number;
  /** extra grip per (m/s)² : mu += downforce · v² */
  downforce: number;
  // tyres
  gripFront: number;
  gripRear: number;
  driftBias: number;
  // brakes
  /** max braking deceleration (m/s²) on dry asphalt */
  brakeDecel: number;
  // steering / suspension
  /** max front wheel angle at standstill (rad) */
  maxSteer: number;
  /** steering response (higher = sharper turn-in) */
  steerResponse: number;
  /** visual body roll (rad per g of lateral accel) */
  bodyRoll: number;
  /** visual body pitch (rad per g of longitudinal accel) */
  bodyPitch: number;
  // estimates, filled by buildVehicleConfig (used by AI and UI)
  /** m/s */
  estTopSpeed: number;
  /** s */
  estZeroToHundred: number;
}

/** Figures shown in the garage. Bars are 0..100. */
export interface PerfStats {
  powerHp: number;
  torqueNm: number;
  massKg: number;
  topSpeedKmh: number;
  zeroToHundred: number;
  barTopSpeed: number;
  barAcceleration: number;
  barHandling: number;
  barBraking: number;
  barNitro: number;
  /** overall rating 0..100 */
  rating: number;
}

// -----------------------------------------------------------------------------
// Vehicle physics
// -----------------------------------------------------------------------------

export interface DriveInput {
  /** 0..1 */
  throttle: number;
  /** 0..1 (when nearly stopped with brake held and no throttle, the car reverses) */
  brake: number;
  /** -1 (left) .. +1 (right), raw (keyboard = -1/0/+1; the physics smooths it) */
  steer: number;
  handbrake: boolean;
  nitro: boolean;
  /** edge-triggered: true for exactly one physics step per key press */
  shiftUp: boolean;
  shiftDown: boolean;
}

export type ShiftQuality = 'perfect' | 'good' | 'early' | 'late' | 'auto';

export interface VehicleState {
  // --- pose (x, z = centre of the car on the ground plane, y = height of the wheel contact plane)
  x: number;
  y: number;
  z: number;
  heading: number;
  /** body pitch (rad, + = nose up) and roll (rad, + = leaning to the car's right), slope + weight transfer */
  pitch: number;
  roll: number;
  // --- motion (world frame)
  vx: number;
  vy: number;
  vz: number;
  yawRate: number;
  /** signed speed along the heading (m/s, < 0 in reverse) */
  speed: number;
  /** signed lateral speed (m/s, > 0 = sliding toward the car's right) */
  lateralSpeed: number;
  /** horizontal speed magnitude in km/h (>= 0) */
  speedKmh: number;
  /** body-frame accelerations (m/s²), smoothed — camera & visuals */
  accelLong: number;
  accelLat: number;
  // --- powertrain
  rpm: number;
  /** -1 = reverse, 0 = neutral, 1..6 */
  gear: number;
  shifting: boolean;
  /** applied (post-assist) pedal positions 0..1 and smoothed steering -1..1 */
  throttle: number;
  brake: number;
  steer: number;
  /** front wheel angle (rad, > 0 = wheels turned to the right) */
  steerAngle: number;
  handbrake: boolean;
  /** tank level 0..1 */
  nitro: number;
  nitroActive: boolean;
  /** turbo spool 0..1 */
  turbo: number;
  /** 0..1 — reaches 1 = engine blown (sustained rev limiter / over-rev, mostly in drag racing) */
  engineTemp: number;
  engineBlown: boolean;
  // --- tyres / drift
  /** signed slip angle at the centre of gravity (rad), 0 at low speed */
  slipAngle: number;
  drifting: boolean;
  /** |slip angle| in degrees while drifting, else 0 */
  driftAngleDeg: number;
  /** duration of the current drift (s) */
  driftTime: number;
  /** 0..1 overall tyre squeal / smoke intensity (lateral + wheelspin + lock-up) */
  wheelSlip: number;
  punctured: boolean;
  // --- contact
  grounded: boolean;
  /** seconds since the car left the ground (0 when grounded) */
  airTime: number;
  surface: SurfaceType;
  /** accumulated visual damage 0..1 */
  damage: number;
}

export type VehicleEvent =
  | { type: 'shift'; gear: number; quality: ShiftQuality; rpm: number }
  | { type: 'launch'; quality: ShiftQuality; rpm: number }
  | { type: 'blowoff' }
  | { type: 'backfire' }
  | { type: 'nitroStart' }
  | { type: 'nitroEnd' }
  | {
      type: 'impact';
      /** world contact point */
      x: number;
      y: number;
      z: number;
      /** contact normal pointing away from the obstacle (toward this car) */
      nx: number;
      nz: number;
      /** normal relative speed absorbed (m/s) */
      intensity: number;
      /** static collider hit, or null for vehicle/vehicle and vehicle/body impacts */
      collider: StaticCollider | null;
    }
  | { type: 'softHit'; collider: StaticCollider; speedKmh: number }
  | { type: 'jump' }
  | { type: 'landing'; intensity: number; airTime: number }
  | { type: 'engineBlown' }
  | { type: 'puncture' }
  | { type: 'driftStart' }
  | { type: 'driftEnd'; duration: number; maxAngleDeg: number };

/**
 * One simulated car. Implemented by `VehiclePhysics` (src/physics/vehiclePhysics.ts).
 * `update` integrates one fixed step (the engine calls it at 120 Hz) including
 * ground following, jumps and collisions against the static world.
 */
export interface IVehicle {
  readonly state: VehicleState;
  readonly config: VehicleConfig;
  /** Events raised during update(); the engine reads then clears (`events.length = 0`) every frame. */
  readonly events: VehicleEvent[];

  /** true = manual 6-speed (shiftUp / shiftDown inputs), false = automatic. */
  manualGearbox: boolean;
  /**
   * Start-line hold: the car is locked in place, the throttle revs the engine freely
   * (launch RPM). When set back to false a `launch` event reports the launch quality.
   */
  holdAtLine: boolean;
  /** Engine power multiplier (AI rubber-banding, damage). Default 1. */
  powerScale: number;
  /** Tyre grip multiplier (AI skill, wet patches). Default 1. */
  gripScale: number;
  /** 0..1 slipstream strength: reduces aero drag by up to ~35 %. Default 0. Set every frame by the engine. */
  draft: number;

  update(dt: number, input: DriveInput): void;
  /** Teleport: place the car on the ground at (x, z), zero spin, forward speed `speed` (m/s, default 0). */
  reset(x: number, z: number, heading: number, speed?: number): void;
  /** Swap the configuration (garage upgrade) keeping the pose. */
  setConfig(config: VehicleConfig): void;
  /** Add (or remove) nitro, as a fraction of the tank. */
  addNitro(fraction: number): void;
  /**
   * Apply a world-space impulse (N·s) at a world point (defaults to the centre of gravity):
   * changes linear velocity and yaw rate.
   */
  applyImpulse(jx: number, jz: number, px?: number, pz?: number): void;
  /** Spike strip: heavy grip / top-speed penalty for `duration` seconds. */
  puncture(duration: number): void;
  /** Repair damage, cool the engine, refill nitro (garage / event restart). */
  repair(): void;
}

/** Simple rigid body used for kinematic traffic in collision tests. Mutated by the resolver. */
export interface KinematicBody {
  x: number;
  z: number;
  heading: number;
  vx: number;
  vz: number;
  yawRate: number;
  halfLength: number;
  halfWidth: number;
  mass: number;
}

export interface CollisionResult {
  /** world contact point */
  x: number;
  y: number;
  z: number;
  /** contact normal from B toward A */
  nx: number;
  nz: number;
  /** closing speed along the normal before the impact (m/s) */
  intensity: number;
}

/*
 * src/physics/vehiclePhysics.ts MUST export:
 *
 *   export class VehiclePhysics implements IVehicle
 *   export function createVehicle(config: VehicleConfig, env: PhysicsEnvironment): IVehicle
 *   export function buildVehicleConfig(spec: CarPhysicsSpec, tuning: TuningState): VehicleConfig
 *   export function estimateStats(spec: CarPhysicsSpec, tuning: TuningState): PerfStats
 *   export function resolveVehiclePair(a: IVehicle, b: IVehicle): CollisionResult | null
 *   export function resolveVehicleVsBody(v: IVehicle, body: KinematicBody): CollisionResult | null
 *
 * The two resolvers separate the bodies, exchange impulses (mass-weighted), push an
 * `impact` event on each IVehicle (collider: null) and add damage.
 */

// -----------------------------------------------------------------------------
// Audio (src/audio/engineSound.ts)
// -----------------------------------------------------------------------------

export interface AudioFrame {
  rpm: number;
  redlineRpm: number;
  /** 0..1 */
  throttle: number;
  /** m/s (>= 0) */
  speed: number;
  /** 0..1 */
  turbo: number;
  nitroActive: boolean;
  /** 0..1 tyre squeal intensity */
  wheelSlip: number;
  surface: SurfaceType;
  grounded: boolean;
  inTunnel: boolean;
  engineBlown: boolean;
}

export type UiSound =
  | 'hover'
  | 'click'
  | 'back'
  | 'buy'
  | 'error'
  | 'countdown'
  | 'go'
  | 'checkpoint'
  | 'lap'
  | 'finish'
  | 'win'
  | 'lose'
  | 'nearMiss'
  | 'perfectShift'
  | 'badShift'
  | 'driftBank'
  | 'heatUp'
  | 'spotted'
  | 'busted'
  | 'evaded'
  | 'speedtrap'
  | 'unlock'
  | 'radio';

export interface SirenSource {
  /** distance to the listener (m) */
  distance: number;
  /** -1 (left) .. +1 (right) */
  pan: number;
  /** closing speed toward the listener (m/s), for a slight doppler */
  approach: number;
}

/** Procedural Web Audio synthesiser. Implemented by `GameAudio` (src/audio/engineSound.ts). */
export interface IGameAudio {
  /** Must be called from a user gesture; creates / resumes the AudioContext. Safe to call repeatedly. */
  resume(): Promise<void>;
  /** Pause / resume all sound (pause menu, hidden tab). */
  setPaused(paused: boolean): void;
  setMasterVolume(v: number): void;
  setMusicVolume(v: number): void;
  /** Engine character of the player car (cylinder count → firing harmonics, turbo whistle...). */
  setEngineProfile(cylinders: number, aspiration: Aspiration, redlineRpm: number): void;
  /** Called every rendered frame with the player car telemetry. */
  update(dt: number, frame: AudioFrame): void;
  /** Engine loop audible or not (false in menus / garage idle uses low volume). */
  setEngineActive(active: boolean): void;
  /** Up to 3 nearest sirens; pass an empty array to silence them. */
  setSirens(sources: SirenSource[]): void;
  /** Helicopter rotor loop, 0 = off, 1 = overhead. */
  setHelicopter(level: number): void;
  /** One-shots */
  playShift(quality: ShiftQuality): void;
  playBlowOff(): void;
  playBackfire(): void;
  playNitro(start: boolean): void;
  /** intensity = closing speed in m/s */
  playImpact(intensity: number, metal?: boolean): void;
  playLanding(intensity: number): void;
  playCollapse(): void;
  playUi(sound: UiSound): void;
  /** Procedural background music: 'menu' | 'cruise' | 'race' | 'pursuit' | 'none' (cross-fades). */
  setMusicMood(mood: MusicMood): void;
  dispose(): void;
}

export type MusicMood = 'none' | 'menu' | 'garage' | 'cruise' | 'race' | 'pursuit';

/*
 * src/audio/engineSound.ts MUST export:
 *   export class GameAudio implements IGameAudio
 *   export function createGameAudio(): IGameAudio
 */

// -----------------------------------------------------------------------------
// Visual models (src/world/vehicleModels.ts, effects.ts, garageScene.ts, environment.ts)
// -----------------------------------------------------------------------------

/** Subset of VehicleState needed to draw a vehicle (VehicleState and TrafficCar both satisfy it). */
export interface VehicleVisualState {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
  /** signed forward speed (m/s) — wheel spin */
  speed: number;
  /** front wheel angle (rad, > 0 = right) */
  steerAngle: number;
  /** 0..1 — brake lights */
  brake: number;
  /** optional extras */
  gear?: number;
  nitroActive?: boolean;
  damage?: number;
  wheelSlip?: number;
}

export type PoliceKind = 'patrol' | 'interceptor' | 'suv';
export type TrafficKind = 'sedan' | 'hatch' | 'taxi' | 'pickup' | 'van' | 'truck' | 'bus';

export interface CarModelOptions {
  /** add two real THREE.SpotLight headlights (player car only — lights are expensive) */
  realHeadlights?: boolean;
  /** 'low' = fewer segments / no interior (traffic, distant rivals) */
  detail?: 'high' | 'low';
}

export interface CarModel {
  /** Root. Origin = centre of the car on the ground, front = local +Z. The engine adds it to a scene. */
  readonly group: THREE.Group;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /**
   * Apply a pose: sets group position / rotation (heading, pitch, roll), spins and steers the
   * wheels, drives brake / reverse lights, nitro exhaust flames, damage look, siren flashing.
   */
  sync(state: VehicleVisualState, dt: number): void;
  /** Live re-paint / re-kit (garage preview). No-op for police & traffic models. */
  setVisuals(visuals: CarVisuals): void;
  setHeadlights(on: boolean): void;
  /** Police only (no-op otherwise). */
  setSiren(on: boolean): void;
  /** World positions of the exhaust tips; fills `out`, returns the count (1 or 2). */
  getExhaustPositions(out: THREE.Vector3[]): number;
  /** World position of a wheel contact patch. index: 0 FL, 1 FR, 2 RL, 3 RR. */
  getWheelPosition(index: number, out: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

export interface HelicopterState {
  active: boolean;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** ground point lit by the searchlight */
  spotX: number;
  spotZ: number;
  seesPlayer: boolean;
}

export interface HelicopterModel {
  readonly group: THREE.Group;
  /** Positions the helicopter, spins rotors, aims the searchlight (a real SpotLight + visible cone). */
  sync(state: HelicopterState, dt: number, getGroundHeight: (x: number, z: number) => number): void;
  dispose(): void;
}

export interface IParticleSystem {
  /** Add to the scene once. */
  readonly object: THREE.Object3D;
  /** Tyre smoke puff (white/grey, grows and fades). intensity 0..1 */
  tireSmoke(x: number, y: number, z: number, vx: number, vy: number, vz: number, intensity: number): void;
  /** Bright additive sparks bouncing with gravity. (nx, ny, nz) = main spray direction. */
  sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed?: number): void;
  /** Additive flame puffs (nitro exhaust, backfire). color = 0xRRGGBB */
  flame(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, size: number): void;
  /** Dust / dirt kicked up off-road. */
  dust(x: number, y: number, z: number, vx: number, vy: number, vz: number, intensity: number): void;
  /** Solid debris chunks (collapse, crashes). */
  debris(x: number, y: number, z: number, count: number, color: number, spread: number): void;
  /** Fireball + smoke column (gas station, wrecks). */
  explosion(x: number, y: number, z: number, scale: number): void;
  /** Water jet / splash (water tower). */
  splash(x: number, y: number, z: number, scale: number): void;
  /** Dark smoke for wrecked / damaged engines. */
  engineSmoke(x: number, y: number, z: number, intensity: number): void;
  update(dt: number, camera: THREE.Camera): void;
  clear(): void;
  dispose(): void;
}

export interface ISkidMarks {
  readonly object: THREE.Object3D;
  /**
   * Extend the trail of one wheel. `trailId` is unique per wheel (vehicleId * 4 + wheelIndex).
   * Call every frame while the wheel is sliding; call `end(trailId)` when it stops.
   */
  add(trailId: number, x: number, y: number, z: number, width: number, intensity: number): void;
  end(trailId: number): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}

export type PortalKind = EventMode | 'garage';

export interface PortalModel {
  /** Neon gate + rotating holographic icon + light pool. Origin on the ground. */
  readonly group: THREE.Group;
  setLocked(locked: boolean): void;
  /** Player is inside the trigger radius. */
  setHighlighted(on: boolean): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

export type CheckpointLook = 'next' | 'upcoming' | 'finish' | 'speedtrap' | 'hidden';

export interface CheckpointModel {
  /** Two light pillars + arch spanning `width`, local +Z = travel direction. Origin on the ground. */
  readonly group: THREE.Group;
  setLook(look: CheckpointLook): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface GarageScene {
  /** Stand-alone showroom scene with its own lighting and environment. */
  readonly scene: THREE.Scene;
  /** Parent for the displayed car model (origin = centre of the turntable, y = floor). */
  readonly carAnchor: THREE.Group;
  /** Point the orbit camera looks at. */
  readonly orbitTarget: THREE.Vector3;
  /** Suggested orbit limits */
  readonly minDistance: number;
  readonly maxDistance: number;
  /** Tints the accent lighting to match the car under-glow / paint (optional eye-candy). */
  setAccentColor(color: number): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/*
 * src/world/vehicleModels.ts MUST export:
 *   export function createCarModel(spec: CarSpec, visuals: CarVisuals, opts?: CarModelOptions): CarModel
 *   export function createPoliceModel(kind: PoliceKind): CarModel
 *   export function createTrafficModel(kind: TrafficKind, colorIndex: number): CarModel
 *   export function createHelicopterModel(): HelicopterModel
 *
 * src/world/effects.ts MUST export:
 *   export function createParticleSystem(): IParticleSystem
 *   export function createSkidMarks(): ISkidMarks
 *   export function createPortal(kind: PortalKind): PortalModel
 *   export function createCheckpoint(width: number): CheckpointModel
 *   export function createSpikeStrip(length: number): THREE.Group          // origin centre, strip along local X
 *   export function createRoadBarrier(width: number): THREE.Group         // police barrier with flashing lamps, along local X
 *
 * src/world/garageScene.ts MUST export:
 *   export function createGarageScene(renderer: THREE.WebGLRenderer): GarageScene
 *
 * src/world/environment.ts MUST export:
 *   export function createNightEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture  // PMREM env map (night city reflections)
 *
 * src/world/cityGenerator.ts MUST export:
 *   export function generateCity(seed?: number): CityWorld
 */

// -----------------------------------------------------------------------------
// AI (src/ai/aiDrivers.ts, src/ai/traffic.ts)
// -----------------------------------------------------------------------------

export type VehicleTag =
  | { type: 'player' }
  | { type: 'rival'; name: string; carId: string; visuals: CarVisuals }
  | { type: 'police'; kind: PoliceKind };

/** A physics vehicle registered with the engine (which steps it, resolves collisions and draws it). */
export interface VehicleHandle {
  readonly id: number;
  readonly vehicle: IVehicle;
  /** Controls applied by the engine at every physics step. The owner (AI) mutates it in place. */
  readonly input: DriveInput;
  readonly tag: VehicleTag;
  /** false once despawned */
  alive: boolean;
  /** wrecked / immobilised (engine shows smoke, AI stops driving it) */
  disabled: boolean;
}

export interface TrafficCar extends KinematicBody, VehicleVisualState {
  id: number;
  kind: TrafficKind;
  colorIndex: number;
  /** 'driving' = following its lane; 'wrecked' = knocked out by a collision, sliding to a stop */
  mode: 'driving' | 'wrecked';
}

export interface BodyInfo {
  type: 'player' | 'rival' | 'police' | 'traffic';
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  halfLength: number;
  halfWidth: number;
  handle: VehicleHandle | null;
  traffic: TrafficCar | null;
}

/** Services the engine offers to the AI systems. */
export interface AIHost {
  readonly world: CityWorld;
  readonly player: VehicleHandle;
  /** Create + register a physics vehicle (the engine creates the 3D model from the tag). */
  spawnVehicle(config: VehicleConfig, x: number, z: number, heading: number, tag: VehicleTag): VehicleHandle;
  despawnVehicle(handle: VehicleHandle): void;
  /** Every dynamic body (player, rivals, police, traffic) within `radius`; fills out[0..n-1], returns n. */
  queryBodies(x: number, z: number, radius: number, out: BodyInfo[]): number;
  buildConfig(spec: CarPhysicsSpec, tuning: TuningState): VehicleConfig;
  /** Current camera position — spawn / despawn things out of sight. */
  getCameraPosition(): Vec2;
}

// --- race rivals ---

export interface RivalSetup {
  name: string;
  config: VehicleConfig;
  tag: VehicleTag;
  /** 0..1 — cornering speed, line precision, reaction */
  skill: number;
  /** 0..1 — blocking, late braking, nitro usage */
  aggression: number;
  x: number;
  z: number;
  heading: number;
  /** preferred lateral offset from the route centre line (m, + = right). Drag racing: the lane. */
  laneOffset: number;
}

export interface RaceAIContext {
  mode: EventMode;
  /** Route centre line. `route.closed` for circuits. */
  route: PolylinePath;
  /** usable half width around the route (m) */
  halfWidth: number;
  /** number of laps (1 for point-to-point) */
  laps: number;
  /** 0..1 strength of the catch-up / slow-down assistance */
  rubberBand: number;
}

export interface RivalDriver {
  readonly handle: VehicleHandle;
  readonly name: string;
  readonly skill: number;
  /** Distance travelled along the route since the start, laps included (m). Maintained by the AI. */
  progress: number;
  /** Set by the game mode when the rival crosses the finish line: the AI then slows down and parks. */
  finished: boolean;
  /** top speed seen (speed-trap bookkeeping is done by the game mode) */
  wrecked: boolean;
}

export interface IRaceAI {
  readonly rivals: RivalDriver[];
  /** Spawns the rivals through the host and holds them at the line (`holdAtLine = true`). */
  setup(ctx: RaceAIContext, rivals: RivalSetup[]): void;
  /** true = green light (release the cars), false = hold. */
  setRacing(go: boolean): void;
  /**
   * Per-frame driving update.
   * @param playerProgress distance travelled by the player along the route, laps included (m)
   */
  update(dt: number, playerProgress: number): void;
  /** Despawns every rival. */
  clear(): void;
}

// --- police ---

export type PoliceMode = 'patrol' | 'pursue' | 'ram' | 'pit' | 'block' | 'roadblock' | 'search' | 'disabled';

export interface PoliceUnit {
  readonly handle: VehicleHandle;
  readonly kind: PoliceKind;
  mode: PoliceMode;
  sirenOn: boolean;
  /** this unit currently has eyes on the player (vision cone + line of sight) */
  seesPlayer: boolean;
  /** 1 → 0; at 0 the unit is wrecked (mode 'disabled') */
  health: number;
}

export interface Roadblock {
  id: number;
  x: number;
  z: number;
  /** direction of the blocked road (the player's expected travel direction) */
  heading: number;
  /** barrier segments (visual + collider registered by the police system) */
  barriers: { x: number; z: number; heading: number; width: number }[];
  /** spike strip covering the gap, or null */
  spikes: { x: number; z: number; heading: number; halfLength: number; active: boolean } | null;
}

export type PursuitStatus = 'idle' | 'pursuit' | 'cooldown';

export interface PursuitState {
  status: PursuitStatus;
  /** 1..5 (0 while idle with no wanted level) */
  heat: number;
  /** 0..1 progress toward the next heat level */
  heatProgress: number;
  /** accumulated bounty of the current pursuit */
  bounty: number;
  /** seconds since the pursuit started */
  duration: number;
  /** 0..1 — pursuit: fills while no unit sees the player; at 1 the pursuit enters cooldown */
  evadeProgress: number;
  /** 0..1 — cooldown: fills while hidden; at 1 the player has escaped */
  cooldownProgress: number;
  /** 0..1 — fills while the player is (nearly) stopped next to police; at 1 = busted */
  bustProgress: number;
  /** any unit (or the helicopter) currently sees the player */
  inSight: boolean;
  /** units actively engaged */
  unitsEngaged: number;
  unitsDisabled: number;
  heliActive: boolean;
  /** infractions summary for the busted / evaded screens */
  infractions: { speeding: number; ramming: number; property: number; traffic: number };
}

export type InfractionKind = 'speeding' | 'ramming' | 'property' | 'traffic' | 'racing';

export type PursuitEvent =
  | { type: 'spotted'; reason: InfractionKind }
  | { type: 'pursuitStart'; heat: number }
  | { type: 'heatUp'; heat: number }
  | { type: 'unitDisabled'; kind: PoliceKind; bounty: number; byBreaker: boolean }
  | { type: 'roadblock'; distance: number }
  | { type: 'spikeHit' }
  | { type: 'heliInbound' }
  | { type: 'cooldownStart' }
  | { type: 'lostCooldown' }
  | { type: 'evaded'; bounty: number; duration: number; heat: number }
  | { type: 'busted'; bounty: number; duration: number; heat: number };

export interface IPoliceSystem {
  readonly state: PursuitState;
  readonly units: PoliceUnit[];
  readonly roadblocks: Roadblock[];
  readonly helicopter: HelicopterState;
  /** Raised during update(); the engine reads then clears every frame. */
  readonly events: PursuitEvent[];
  /**
   * false = no police at all (garage, drag / drift events): despawns everything and silently
   * drops any pursuit. true = ambient patrols + pursuits.
   */
  setEnabled(enabled: boolean): void;
  /** Starting wanted level for the next pursuit (1..5), e.g. restored from the save. */
  setBaseHeat(heat: number): void;
  update(dt: number): void;
  /** The engine reports what the player does; the police only react if a unit witnesses it or a pursuit is on. */
  reportInfraction(kind: InfractionKind, severity?: number): void;
  /** The engine reports a collision between the player and a police vehicle (intensity m/s). */
  notifyPoliceHit(handle: VehicleHandle, intensity: number): void;
  /** Drop everything immediately (teleport, event start). */
  reset(): void;
}

// --- civilian traffic ---

export interface ITrafficSystem {
  readonly cars: readonly TrafficCar[];
  /** 0..1 target density (0 = none). */
  setDensity(density: number): void;
  /** Spawns / recycles cars around the focus point (ahead of its velocity), drives them along road lanes. */
  update(dt: number, focusX: number, focusZ: number, focusVx: number, focusVz: number): void;
  /** The engine resolved a collision that involved this car (its vx / vz / yawRate were changed). */
  notifyHit(car: TrafficCar, intensity: number): void;
  /** Remove every car closer than `radius` to a point (event start grid, teleport). */
  clearAround(x: number, z: number, radius: number): void;
  clear(): void;
}

/*
 * src/ai/aiDrivers.ts MUST export:
 *   export function createRaceAI(host: AIHost): IRaceAI
 *   export function createPoliceSystem(host: AIHost): IPoliceSystem
 * src/ai/traffic.ts MUST export:
 *   export function createTrafficSystem(host: AIHost): ITrafficSystem
 */

// -----------------------------------------------------------------------------
// Game state, progression, UI bridge
// -----------------------------------------------------------------------------

export type EventMode = 'sprint' | 'circuit' | 'drift' | 'drag' | 'speedtrap';

export type CameraMode = 'chaseNear' | 'chaseFar' | 'hood';

export type GameScreen = 'title' | 'freeroam' | 'garage' | 'countdown' | 'race' | 'results' | 'busted';

export interface GameSettings {
  transmission: 'auto' | 'manual';
  masterVolume: number; // 0..1
  musicVolume: number; // 0..1
  cameraMode: CameraMode;
  mirror: boolean;
  quality: 'low' | 'medium' | 'high';
  units: 'kmh' | 'mph';
  speedLines: boolean;
  trafficDensity: number; // 0..1
}

export interface OwnedCar {
  carId: string;
  tuning: TuningState;
  visuals: CarVisuals;
  /** wanted level attached to this car (1..5) */
  heat: number;
}

export type Medal = 'gold' | 'silver' | 'bronze';

export interface EventRecord {
  attempts: number;
  wins: number;
  completed: boolean;
  bestTimeMs: number | null;
  bestScore: number | null;
  medal: Medal | null;
}

export interface PlayerStats {
  racesRun: number;
  racesWon: number;
  pursuitsEvaded: number;
  timesBusted: number;
  totalBounty: number;
  copsDisabled: number;
  breakersUsed: number;
  nearMisses: number;
  bestDrift: number;
  topSpeedKmh: number;
  distanceKm: number;
  maxHeat: number;
  playTimeS: number;
}

export interface PlayerProfile {
  version: number;
  money: number;
  /** total REP points */
  rep: number;
  currentCarId: string;
  garage: Record<string, OwnedCar>;
  events: Record<string, EventRecord>;
  stats: PlayerStats;
  settings: GameSettings;
}

/** What the UI needs to know about an event (map, portals, results). */
export interface EventSummary {
  id: string;
  name: string;
  mode: EventMode;
  modeLabel: string;
  district: DistrictId;
  description: string;
  /** 1..5 */
  difficulty: number;
  laps: number;
  lengthKm: number;
  rivals: number;
  repLevelRequired: number;
  rewardMoney: number;
  rewardRep: number;
  locked: boolean;
  record: EventRecord | null;
  /** drift / speedtrap targets (gold, silver, bronze) when relevant */
  targets: { gold: number; silver: number; bronze: number } | null;
}

export type MarkerKind = 'garage' | 'event' | 'breaker' | 'ramp';

export interface MapMarker {
  id: string;
  kind: MarkerKind;
  x: number;
  z: number;
  label: string;
  /** '#rrggbb' accent */
  color: string;
  /** fast-travel allowed (garage + unlocked events, only in free roam with no active pursuit) */
  teleportable: boolean;
  event: EventSummary | null;
}

export interface InteractionPrompt {
  /** key label, e.g. 'E' */
  key: string;
  title: string;
  subtitle: string;
  /** marker concerned */
  markerId: string;
  locked: boolean;
}

export interface ActiveEventInfo {
  id: string;
  name: string;
  mode: EventMode;
  modeLabel: string;
  laps: number;
  totalCheckpoints: number;
  racers: number;
  /** short instruction shown at the start, e.g. "Passe les rapports dans la zone verte" */
  hint: string;
  targets: { gold: number; silver: number; bronze: number } | null;
}

export interface StandingRow {
  name: string;
  position: number;
  isPlayer: boolean;
  /** already formatted: gap ("+1.24 s"), score ("12 450 pts"), speed ("845 km/h")... */
  detail: string;
  finished: boolean;
}

export interface EventResults {
  eventId: string;
  name: string;
  mode: EventMode;
  modeLabel: string;
  won: boolean;
  /** finished the event (false = abandoned / engine blown / totalled) */
  completed: boolean;
  failReason: string | null;
  position: number;
  racers: number;
  timeMs: number;
  bestLapMs: number | null;
  /** drift points / cumulated trap speed, else null */
  score: number | null;
  scoreLabel: string | null;
  medal: Medal | null;
  standings: StandingRow[];
  rewardMoney: number;
  rewardRep: number;
  bonuses: { label: string; money: number; rep: number }[];
  newRecord: boolean;
  /** new REP level reached, else null */
  repLevelUp: number | null;
  /** names of cars / events unlocked by this result */
  unlocked: string[];
}

export interface BustedInfo {
  fine: number;
  heat: number;
  bounty: number;
  durationS: number;
  infractions: { label: string; count: number }[];
}

export type ToastKind = 'info' | 'reward' | 'warning' | 'police' | 'drift' | 'nitro' | 'unlock' | 'district';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  text: string;
}

/** Low-frequency UI state. Immutable snapshots: a new object is published on every change. */
export interface UIState {
  screen: GameScreen;
  paused: boolean;
  mapOpen: boolean;
  /** engine still generating the city (title screen shows a loader) */
  loading: boolean;
  loadingLabel: string;
  profile: PlayerProfile;
  repLevel: number;
  /** REP points at the start of the current level / needed for the next one */
  repLevelFloor: number;
  repLevelCeil: number;
  markers: MapMarker[];
  prompt: InteractionPrompt | null;
  activeEvent: ActiveEventInfo | null;
  results: EventResults | null;
  busted: BustedInfo | null;
  toasts: Toast[];
  /** id of the marker targeted by the GPS, or null */
  gpsTargetId: string | null;
  district: DistrictId;
  /** garage: car shown on the turntable (may be a car that is not owned) */
  garageCarId: string;
  /** garage: unsaved visual preview currently displayed, or null */
  garagePreview: CarVisuals | null;
}

export type BlipKind =
  | 'rival'
  | 'police'
  | 'heli'
  | 'traffic'
  | 'roadblock'
  | 'checkpoint'
  | 'finish'
  | 'speedtrap';

export interface MapBlip {
  kind: BlipKind;
  x: number;
  z: number;
  heading: number;
}

export type ShiftLight = 'none' | 'approach' | 'perfect' | 'over';

/**
 * High-frequency data, mutated IN PLACE by the engine every frame.
 * UI components must read it inside their own requestAnimationFrame loop and
 * update the DOM imperatively (refs / canvas) — never through React state at 60 Hz.
 */
export interface Telemetry {
  // car
  speedKmh: number;
  rpm: number;
  redlineRpm: number;
  maxRpm: number;
  /** -1 R, 0 N, 1..6 */
  gear: number;
  manual: boolean;
  shiftLight: ShiftLight;
  perfectShiftLo: number;
  perfectShiftHi: number;
  nitro: number;
  nitroActive: boolean;
  turbo: number;
  engineTemp: number;
  damage: number;
  drifting: boolean;
  /** 0..1 intensity of the speed effect (speed lines / vignette) */
  speedFx: number;
  // position
  x: number;
  z: number;
  heading: number;
  // minimap dynamic content
  blips: MapBlip[];
  blipCount: number;
  /** current race route or GPS route to draw (null = none). The array reference changes when the route changes. */
  route: Vec2[] | null;
  routeIsGps: boolean;
  // race
  race: {
    active: boolean;
    mode: EventMode;
    /** 3, 2, 1, 0 = GO (shown ~1 s), -1 = none */
    countdown: number;
    position: number;
    racers: number;
    lap: number;
    laps: number;
    checkpoint: number;
    checkpoints: number;
    timeMs: number;
    lapTimeMs: number;
    bestLapMs: number;
    /** drift event countdown, else -1 */
    timeLeftMs: number;
    /** 0..1 progress along the whole event */
    progress: number;
    wrongWay: boolean;
    /** standings, refreshed ~5 Hz (array reference replaced on refresh) */
    standings: StandingRow[];
    // drift
    driftScore: number;
    driftCombo: number;
    driftMultiplier: number;
    driftAngle: number;
    /** 0..1 time left before the combo is banked */
    driftComboTimer: number;
    // speedtrap
    trapTotal: number;
    trapLast: number;
    trapsPassed: number;
    trapsTotal: number;
    // drag
    dragDistance: number;
    dragLength: number;
  };
  // pursuit
  pursuit: {
    status: PursuitStatus;
    heat: number;
    heatProgress: number;
    bounty: number;
    evade: number;
    cooldown: number;
    bust: number;
    inSight: boolean;
    units: number;
    heli: boolean;
    durationS: number;
  };
  fps: number;
}

/** Transient UI events (flash effects, pop-ups). */
export type GameUiEvent =
  | { type: 'nearMiss'; bonus: number }
  | { type: 'shift'; quality: ShiftQuality }
  | { type: 'launch'; quality: ShiftQuality }
  | { type: 'checkpoint'; index: number; total: number; splitMs: number }
  | { type: 'lap'; lap: number; laps: number; lapTimeMs: number; best: boolean }
  | { type: 'driftBank'; points: number; multiplier: number }
  | { type: 'driftLost'; points: number }
  | { type: 'wallBonus' }
  | { type: 'speedtrap'; speedKmh: number; index: number }
  | { type: 'impact'; intensity: number }
  | { type: 'nitro'; active: boolean }
  | { type: 'jump'; airTime: number; distance: number }
  | { type: 'heatUp'; heat: number }
  | { type: 'pursuit'; phase: 'start' | 'cooldown' | 'resumed' | 'evaded' | 'busted' }
  | { type: 'copDown'; bounty: number }
  | { type: 'breaker'; name: string }
  | { type: 'banner'; title: string; subtitle: string; tone: 'info' | 'good' | 'bad' | 'police' };

export interface ActionResult {
  ok: boolean;
  /** French message when ok === false (e.g. "Fonds insuffisants") */
  reason?: string;
}

export interface GameActions {
  /** Title screen → free roam. MUST be called from a click / key handler (unlocks audio). */
  startGame(): void;
  setPaused(paused: boolean): void;
  setMapOpen(open: boolean): void;
  /** Fast travel to a teleportable marker. */
  teleportTo(markerId: string): ActionResult;
  setGpsTarget(markerId: string | null): void;
  /** Start an event immediately (from the map or the prompt). */
  startEvent(eventId: string): ActionResult;
  restartEvent(): void;
  /** Abandon the current event / close the results or busted screen → free roam. */
  exitToFreeRoam(): void;
  // garage
  enterGarage(): void;
  exitGarage(): void;
  /** Show a car on the turntable (owned or not). */
  garageShowCar(carId: string): void;
  buyCar(carId: string): ActionResult;
  /** Make an owned car the current car. */
  selectCar(carId: string): ActionResult;
  buyUpgrade(part: TunePart, level: TuneLevel): ActionResult;
  /** Live preview on the turntable; null restores the saved look. */
  previewVisuals(visuals: CarVisuals | null): void;
  /** Pay for and save the given look for the current car. */
  buyVisuals(visuals: CarVisuals): ActionResult;
  // misc
  updateSettings(patch: Partial<GameSettings>): void;
  resetSave(): void;
  playUiSound(sound: UiSound): void;
}

/** Bridge between the game engine and the React UI. */
export interface GameAPI {
  /** Mutable high-frequency data (see Telemetry). Same object for the whole session. */
  readonly telemetry: Telemetry;
  getState(): UIState;
  /** Subscribe to UIState changes (compatible with React.useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  /** Transient events. Returns the unsubscribe function. */
  onEvent(listener: (e: GameUiEvent) => void): () => void;
  /** Static map data (null until the city is generated). */
  getMapData(): MapData | null;
  /** Performance figures for a car + tuning (garage stat bars, upgrade previews). */
  getPerfStats(carId: string, tuning: TuningState): PerfStats;
  readonly actions: GameActions;
}

/**
 * The rear-view mirror is rendered by the engine straight into the WebGL canvas
 * (scissor viewport); the HUD only draws a frame around the same rectangle:
 * horizontally centred, `MIRROR_RECT.top` CSS px from the top,
 * width = min(maxWidth, viewportWidth * widthFrac), height = width / aspect.
 */
export const MIRROR_RECT = { widthFrac: 0.26, maxWidth: 440, aspect: 4.2, top: 14 } as const;
