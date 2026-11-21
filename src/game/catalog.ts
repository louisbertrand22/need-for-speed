/* =============================================================================
 * APEX NOCTURNE — static game data: cars, tuning parts, visual options, prices.
 * Pure data + pure functions (no Three.js, no DOM). Shared by physics, models,
 * AI, game modes and UI.
 * ===========================================================================*/
import type {
  CarPhysicsSpec,
  CarSpec,
  CarVisuals,
  PaintFinish,
  PoliceKind,
  TrafficKind,
  TuneLevel,
  TunePart,
  TuningState,
} from '../core/types';

export const GAME_TITLE = 'APEX NOCTURNE';
export const CITY_NAME = 'Port-Sélène';

// -----------------------------------------------------------------------------
// Tuning
// -----------------------------------------------------------------------------

export const TUNE_PARTS: TunePart[] = ['engine', 'turbo', 'transmission', 'suspension', 'brakes', 'tires', 'nitro'];

export const TUNE_LEVEL_NAMES = ['Stock', 'Street', 'Pro', 'Ultimate'] as const;

export const STOCK_TUNING: TuningState = {
  engine: 0,
  turbo: 0,
  transmission: 0,
  suspension: 0,
  brakes: 0,
  tires: 0,
  nitro: 0,
};

export function maxedTuning(level: TuneLevel): TuningState {
  return { engine: level, turbo: level, transmission: level, suspension: level, brakes: level, tires: level, nitro: level };
}

export interface TunePartInfo {
  part: TunePart;
  label: string;
  /** lucide-react icon name suggestion */
  icon: string;
  description: string;
  /** one line per level (Stock → Ultimate) */
  levels: [string, string, string, string];
  /** which stat bars the part mostly affects */
  affects: string;
}

export const TUNE_INFO: Record<TunePart, TunePartInfo> = {
  engine: {
    part: 'engine',
    label: 'Moteur',
    icon: 'Cog',
    description: 'Puissance et couple sur toute la plage de régime.',
    levels: ['Bloc d’origine', 'Admission + échappement sport', 'Arbres à cames, pistons forgés', 'Bloc préparé compétition'],
    affects: 'Vitesse max · Accélération',
  },
  turbo: {
    part: 'turbo',
    label: 'Turbo',
    icon: 'Wind',
    description: 'Suralimentation : gros couple à mi-régime, sifflement et soupape de décharge.',
    levels: ['Pression d’origine', 'Turbo Stage 1', 'Gros turbo + intercooler', 'Bi-turbo haute pression'],
    affects: 'Accélération',
  },
  transmission: {
    part: 'transmission',
    label: 'Transmission',
    icon: 'GitFork',
    description: 'Passages de rapports plus rapides et moins de pertes mécaniques.',
    levels: ['Boîte d’origine', 'Embrayage renforcé', 'Boîte à rapports courts', 'Séquentielle course'],
    affects: 'Accélération · Vitesse max',
  },
  suspension: {
    part: 'suspension',
    label: 'Suspension',
    icon: 'ArrowDownUp',
    description: 'Moins de roulis, train avant plus incisif, voiture plus stable.',
    levels: ['Amortisseurs d’origine', 'Ressorts courts', 'Combinés filetés', 'Suspension course réglable'],
    affects: 'Maniabilité',
  },
  brakes: {
    part: 'brakes',
    label: 'Freins',
    icon: 'Disc3',
    description: 'Distances de freinage raccourcies.',
    levels: ['Freins d’origine', 'Plaquettes sport', 'Disques ventilés 4 pistons', 'Carbone-céramique'],
    affects: 'Freinage',
  },
  tires: {
    part: 'tires',
    label: 'Pneus',
    icon: 'CircleDot',
    description: 'Adhérence latérale et motricité.',
    levels: ['Pneus tourisme', 'Pneus sport', 'Semi-slicks', 'Slicks homologués'],
    affects: 'Maniabilité · Accélération',
  },
  nitro: {
    part: 'nitro',
    label: 'Nitro',
    icon: 'Flame',
    description: 'Capacité de la bouteille de NOS, poussée et vitesse de recharge.',
    levels: ['Kit de base', 'Bouteille 5 kg', 'Double étage', 'Injection directe'],
    affects: 'Nitro',
  },
};

/**
 * Effect of each tuning level (index = TuneLevel). The physics module
 * (buildVehicleConfig) applies exactly these numbers.
 */
export const TUNE_EFFECTS = {
  engine: {
    /** multiplier on stock power & torque */
    power: [1, 1.13, 1.28, 1.48],
    /** added to the stock redline (rpm) */
    redline: [0, 150, 300, 500],
  },
  turbo: {
    /** extra torque fraction at full spool, added on top of the stock aspiration (stock turbo cars already have 0.12) */
    boost: [0, 0.1, 0.2, 0.32],
    /** spool rate multiplier (higher = less lag) */
    spool: [1, 1.1, 1.25, 1.45],
  },
  transmission: {
    /** torque cut per shift (s) */
    shiftTime: [0.34, 0.24, 0.15, 0.07],
    /** drivetrain efficiency */
    efficiency: [0.86, 0.885, 0.91, 0.935],
    /** top speed multiplier (taller final gearing + less loss) */
    topSpeed: [1, 1.025, 1.05, 1.08],
  },
  suspension: {
    /** body roll multiplier */
    roll: [1, 0.8, 0.62, 0.45],
    /** steering response multiplier */
    response: [1, 1.08, 1.17, 1.28],
    /** additive grip bonus (stability) */
    grip: [0, 0.03, 0.06, 0.09],
  },
  brakes: {
    /** braking deceleration multiplier */
    force: [1, 1.15, 1.32, 1.5],
  },
  tires: {
    /** lateral & longitudinal grip multiplier */
    grip: [1, 1.07, 1.14, 1.22],
  },
  nitro: {
    /** seconds of burn for a full bottle */
    capacity: [2.5, 4.0, 5.5, 7.5],
    /** extra acceleration while burning (m/s²) */
    accel: [5.0, 6.5, 8.0, 10.0],
    /** passive refill (fraction of the bottle per second) */
    regen: [0.02, 0.026, 0.033, 0.042],
  },
} as const;

const TIER_PRICE_FACTOR = [0.7, 1, 1.5, 2.2, 3.2];
const PART_PRICE_FACTOR: Record<TunePart, number> = {
  engine: 1.5,
  turbo: 1.3,
  transmission: 1.0,
  suspension: 0.8,
  brakes: 0.7,
  tires: 0.8,
  nitro: 1.1,
};
const LEVEL_BASE_PRICE = [0, 2200, 5500, 11500];

/** Price to go to `level` for one part (levels must be bought in order). */
export function upgradePrice(spec: CarSpec, part: TunePart, level: TuneLevel): number {
  const tier = TIER_PRICE_FACTOR[Math.min(4, Math.max(0, spec.tier - 1))];
  return Math.round((LEVEL_BASE_PRICE[level] * PART_PRICE_FACTOR[part] * tier) / 50) * 50;
}

/** REP level required to buy a given upgrade level. */
export const TUNE_LEVEL_REP: [number, number, number, number] = [1, 1, 4, 8];

// -----------------------------------------------------------------------------
// Visual customisation options
// -----------------------------------------------------------------------------

export interface ColorOption {
  name: string;
  hex: string;
}

export const PAINT_COLORS: ColorOption[] = [
  { name: 'Orange Solaire', hex: '#ff6a00' },
  { name: 'Rouge Magma', hex: '#d1121f' },
  { name: 'Jaune Voltage', hex: '#ffd000' },
  { name: 'Vert Toxique', hex: '#38e01f' },
  { name: 'Vert Racing', hex: '#0b5d3b' },
  { name: 'Cyan Glacier', hex: '#16c8e8' },
  { name: 'Bleu Électrique', hex: '#1447ff' },
  { name: 'Bleu Nuit', hex: '#0a1a4a' },
  { name: 'Violet Nébuleuse', hex: '#7a1fff' },
  { name: 'Rose Néon', hex: '#ff2d95' },
  { name: 'Bordeaux', hex: '#5a0c1c' },
  { name: 'Bronze', hex: '#9a6a34' },
  { name: 'Blanc Nacre', hex: '#f2f4f7' },
  { name: 'Gris Titane', hex: '#6f7783' },
  { name: 'Gris Canon', hex: '#2a2e35' },
  { name: 'Noir Obsidienne', hex: '#0a0b0e' },
];

export const PAINT_FINISHES: { id: PaintFinish; name: string; description: string; price: number }[] = [
  { id: 'metallic', name: 'Métallisée', description: 'Paillettes métalliques et vernis brillant', price: 800 },
  { id: 'pearl', name: 'Nacrée', description: 'Reflets changeants selon l’angle', price: 1800 },
  { id: 'matte', name: 'Mate', description: 'Finition satinée sans reflets', price: 1200 },
];

export const PAINT_COLOR_PRICE = 600;

export const RIM_STYLES: { name: string; price: number }[] = [
  { name: 'Série', price: 0 },
  { name: '5 Branches', price: 900 },
  { name: 'Multibranches', price: 1400 },
  { name: 'Turbine', price: 1900 },
  { name: 'Deep Dish', price: 2400 },
  { name: 'Monobloc Aero', price: 3000 },
];

export const RIM_COLORS: ColorOption[] = [
  { name: 'Argent', hex: '#c9ced6' },
  { name: 'Chrome', hex: '#f4f7fb' },
  { name: 'Anthracite', hex: '#3a3f47' },
  { name: 'Noir', hex: '#0d0e11' },
  { name: 'Or', hex: '#d4a017' },
  { name: 'Bronze', hex: '#8a5a2b' },
  { name: 'Blanc', hex: '#f5f5f5' },
  { name: 'Rouge', hex: '#d1121f' },
  { name: 'Bleu', hex: '#1e5bff' },
];

export const RIM_COLOR_PRICE = 300;

export const SPOILERS: { name: string; price: number }[] = [
  { name: 'Aucun', price: 0 },
  { name: 'Becquet Lip', price: 700 },
  { name: 'Ducktail', price: 1200 },
  { name: 'Aileron GT', price: 2200 },
  { name: 'Aileron Drag XXL', price: 3200 },
];

export const BODY_KITS: { name: string; description: string; price: number }[] = [
  { name: 'Origine', description: 'Carrosserie de série', price: 0 },
  { name: 'Street', description: 'Lame avant, bas de caisse', price: 2500 },
  { name: 'Wide Body', description: 'Ailes élargies, diffuseur', price: 5500 },
  { name: 'Extreme', description: 'Kit large, prises d’air, splitter course', price: 9500 },
];

export const NEON_COLORS: { name: string; hex: string | null }[] = [
  { name: 'Aucun', hex: null },
  { name: 'Cyan', hex: '#00e5ff' },
  { name: 'Violet', hex: '#a020ff' },
  { name: 'Rose', hex: '#ff2d95' },
  { name: 'Vert', hex: '#39ff14' },
  { name: 'Orange', hex: '#ff7a00' },
  { name: 'Rouge', hex: '#ff1a1a' },
  { name: 'Bleu', hex: '#1e5bff' },
  { name: 'Blanc', hex: '#f0f6ff' },
];

export const NEON_PRICE = 1500;

export const WINDOW_TINTS: { name: string; /** 0 = clear … 1 = opaque black */ opacity: number; price: number }[] = [
  { name: 'Claires', opacity: 0.25, price: 0 },
  { name: 'Fumées', opacity: 0.55, price: 400 },
  { name: 'Sombres', opacity: 0.78, price: 700 },
  { name: 'Limo', opacity: 0.94, price: 1000 },
];

export const NITRO_COLORS: ColorOption[] = [
  { name: 'Bleu Classique', hex: '#3aa0ff' },
  { name: 'Violet Plasma', hex: '#b04bff' },
  { name: 'Vert Acide', hex: '#5dff3a' },
  { name: 'Orange Feu', hex: '#ff8a1e' },
  { name: 'Rose', hex: '#ff4fb0' },
  { name: 'Blanc Arctique', hex: '#dff3ff' },
];

export const NITRO_COLOR_PRICE = 500;

/** Cost of going from the saved look to a new look (only changed items are charged). */
export function visualsPrice(current: CarVisuals, next: CarVisuals): number {
  let total = 0;
  if (next.paintColor !== current.paintColor) total += PAINT_COLOR_PRICE;
  if (next.paintFinish !== current.paintFinish) {
    total += PAINT_FINISHES.find((f) => f.id === next.paintFinish)?.price ?? 0;
  }
  if (next.rimStyle !== current.rimStyle) total += RIM_STYLES[next.rimStyle]?.price ?? 0;
  if (next.rimColor !== current.rimColor) total += RIM_COLOR_PRICE;
  if (next.spoiler !== current.spoiler) total += SPOILERS[next.spoiler]?.price ?? 0;
  if (next.bodyKit !== current.bodyKit) total += BODY_KITS[next.bodyKit]?.price ?? 0;
  if (next.neonColor !== current.neonColor && next.neonColor !== null) total += NEON_PRICE;
  if (next.windowTint !== current.windowTint) total += WINDOW_TINTS[next.windowTint]?.price ?? 0;
  if (next.nitroColor !== current.nitroColor) total += NITRO_COLOR_PRICE;
  return total;
}

export function visualsEqual(a: CarVisuals, b: CarVisuals): boolean {
  return (
    a.paintColor === b.paintColor &&
    a.paintFinish === b.paintFinish &&
    a.rimStyle === b.rimStyle &&
    a.rimColor === b.rimColor &&
    a.spoiler === b.spoiler &&
    a.bodyKit === b.bodyKit &&
    a.neonColor === b.neonColor &&
    a.windowTint === b.windowTint &&
    a.nitroColor === b.nitroColor
  );
}

function visuals(paintColor: string, paintFinish: PaintFinish, extra: Partial<CarVisuals> = {}): CarVisuals {
  return {
    paintColor,
    paintFinish,
    rimStyle: 0,
    rimColor: '#c9ced6',
    spoiler: 0,
    bodyKit: 0,
    neonColor: null,
    windowTint: 0,
    nitroColor: '#3aa0ff',
    ...extra,
  };
}

// -----------------------------------------------------------------------------
// Car catalogue (fictional makes & models)
// -----------------------------------------------------------------------------

export const CAR_CATALOG: CarSpec[] = [
  {
    id: 'kaido',
    name: 'Kaido RS-180',
    maker: 'Kaido Motors',
    category: 'tuner',
    categoryLabel: 'Tuner JDM',
    bodyStyle: 'tuner',
    tagline: 'Propulsion légère, la base de tout projet',
    description:
      'Petit coupé japonais à moteur turbo 4 cylindres. Léger, joueur et facile à faire glisser : la voiture idéale pour débuter dans les rues de Port-Sélène.',
    price: 0,
    repLevel: 1,
    tier: 1,
    drivetrain: 'RWD',
    massKg: 1180,
    powerHp: 185,
    torqueNm: 235,
    idleRpm: 900,
    redlineRpm: 7600,
    cylinders: 4,
    aspiration: 'turbo',
    gearRatios: [3.32, 2.05, 1.45, 1.1, 0.88, 0.72],
    topSpeedKmh: 226,
    grip: 1.02,
    agility: 0.74,
    brakeG: 1.0,
    driftBias: 0.72,
    dims: { length: 4.34, width: 1.74, height: 1.28, wheelbase: 2.52, track: 1.5, wheelRadius: 0.31, rideHeight: 0.13 },
    defaultVisuals: visuals('#ff6a00', 'metallic'),
  },
  {
    id: 'volta',
    name: 'Volta Pulse 16V',
    maker: 'Volta',
    category: 'hatch',
    categoryLabel: 'Compacte sportive',
    bodyStyle: 'hatch',
    tagline: 'Traction nerveuse, reine des ruelles',
    description:
      'Compacte à hayon ultra-légère. Sa traction avant mord dans les virages serrés du Quartier Lanterne, mais elle refuse de dériver sans frein à main.',
    price: 16000,
    repLevel: 1,
    tier: 1,
    drivetrain: 'FWD',
    massKg: 1060,
    powerHp: 178,
    torqueNm: 208,
    idleRpm: 950,
    redlineRpm: 7900,
    cylinders: 4,
    aspiration: 'na',
    gearRatios: [3.45, 2.12, 1.52, 1.16, 0.94, 0.78],
    topSpeedKmh: 218,
    grip: 1.07,
    agility: 0.86,
    brakeG: 1.05,
    driftBias: 0.3,
    dims: { length: 3.98, width: 1.72, height: 1.4, wheelbase: 2.48, track: 1.49, wheelRadius: 0.3, rideHeight: 0.14 },
    defaultVisuals: visuals('#ffd000', 'metallic'),
  },
  {
    id: 'brutus',
    name: 'Brutus 427 Outlaw',
    maker: 'Brutus',
    category: 'muscle',
    categoryLabel: 'Muscle Car V8',
    bodyStyle: 'muscle',
    tagline: 'V8 atmosphérique, couple de camion',
    description:
      'Gros coupé américain au V8 de sept litres. Imbattable en ligne droite et en drag, mais lourd : il faut anticiper chaque freinage et doser les gaz en sortie de virage.',
    price: 45000,
    repLevel: 3,
    tier: 2,
    drivetrain: 'RWD',
    massKg: 1690,
    powerHp: 435,
    torqueNm: 590,
    idleRpm: 750,
    redlineRpm: 6400,
    cylinders: 8,
    aspiration: 'na',
    gearRatios: [2.97, 1.92, 1.36, 1.0, 0.8, 0.64],
    topSpeedKmh: 264,
    grip: 0.98,
    agility: 0.52,
    brakeG: 0.95,
    driftBias: 0.88,
    dims: { length: 4.86, width: 1.94, height: 1.36, wheelbase: 2.78, track: 1.6, wheelRadius: 0.35, rideHeight: 0.15 },
    defaultVisuals: visuals('#d1121f', 'metallic'),
  },
  {
    id: 'adler',
    name: 'Adler GT6 Sport',
    maker: 'Adler',
    category: 'euro',
    categoryLabel: 'Coupé Européen',
    bodyStyle: 'coupe',
    tagline: 'Précision allemande, six cylindres turbo',
    description:
      'Coupé grand tourisme équilibré : un châssis précis, un six-en-ligne turbo rageur et une stabilité exemplaire à haute vitesse sur L’Orbitale.',
    price: 72000,
    repLevel: 5,
    tier: 3,
    drivetrain: 'RWD',
    massKg: 1530,
    powerHp: 410,
    torqueNm: 520,
    idleRpm: 800,
    redlineRpm: 7400,
    cylinders: 6,
    aspiration: 'turbo',
    gearRatios: [3.15, 2.02, 1.44, 1.1, 0.88, 0.71],
    topSpeedKmh: 286,
    grip: 1.14,
    agility: 0.7,
    brakeG: 1.12,
    driftBias: 0.52,
    dims: { length: 4.52, width: 1.86, height: 1.3, wheelbase: 2.66, track: 1.57, wheelRadius: 0.34, rideHeight: 0.12 },
    defaultVisuals: visuals('#6f7783', 'metallic'),
  },
  {
    id: 'raijin',
    name: 'Raijin XR Twin-Turbo',
    maker: 'Raijin',
    category: 'gt',
    categoryLabel: 'GT Japonaise AWD',
    bodyStyle: 'gt',
    tagline: 'Quatre roues motrices, bi-turbo',
    description:
      'Monstre technologique à transmission intégrale. Sa motricité catapulte la voiture hors des virages ; plus dure à faire dériver, mais redoutable en sprint.',
    price: 112000,
    repLevel: 7,
    tier: 4,
    drivetrain: 'AWD',
    massKg: 1640,
    powerHp: 555,
    torqueNm: 640,
    idleRpm: 850,
    redlineRpm: 7200,
    cylinders: 6,
    aspiration: 'turbo',
    gearRatios: [3.4, 2.1, 1.5, 1.14, 0.9, 0.72],
    topSpeedKmh: 308,
    grip: 1.2,
    agility: 0.68,
    brakeG: 1.18,
    driftBias: 0.4,
    dims: { length: 4.68, width: 1.9, height: 1.36, wheelbase: 2.74, track: 1.6, wheelRadius: 0.35, rideHeight: 0.12 },
    defaultVisuals: visuals('#1447ff', 'pearl'),
  },
  {
    id: 'tempesta',
    name: 'Veloce Tempesta V12',
    maker: 'Veloce',
    category: 'exotic',
    categoryLabel: 'Supercar Exotique',
    bodyStyle: 'exotic',
    tagline: 'V12 central, hurlement à 8 600 tr/min',
    description:
      'Supercar italienne en coin, moteur V12 atmosphérique en position centrale. Ultra-basse, ultra-large, elle colle à la route tant qu’on la respecte.',
    price: 225000,
    repLevel: 9,
    tier: 5,
    drivetrain: 'RWD',
    massKg: 1490,
    powerHp: 720,
    torqueNm: 700,
    idleRpm: 1000,
    redlineRpm: 8600,
    cylinders: 12,
    aspiration: 'na',
    gearRatios: [3.1, 2.1, 1.56, 1.22, 0.99, 0.82],
    topSpeedKmh: 340,
    grip: 1.28,
    agility: 0.8,
    brakeG: 1.28,
    driftBias: 0.46,
    dims: { length: 4.62, width: 2.02, height: 1.14, wheelbase: 2.7, track: 1.68, wheelRadius: 0.35, rideHeight: 0.1 },
    defaultVisuals: visuals('#ffd000', 'pearl'),
  },
  {
    id: 'spectre',
    name: 'Spectre HX-1',
    maker: 'Spectre Automotive',
    category: 'hyper',
    categoryLabel: 'Hypercar',
    bodyStyle: 'hyper',
    tagline: 'Prototype homologué route, 1 000 ch',
    description:
      'L’aboutissement : monocoque carbone, V8 bi-turbo hybride et aérodynamique active. Réservée aux légendes de Port-Sélène.',
    price: 420000,
    repLevel: 12,
    tier: 5,
    drivetrain: 'AWD',
    massKg: 1400,
    powerHp: 1000,
    torqueNm: 1080,
    idleRpm: 1000,
    redlineRpm: 8300,
    cylinders: 8,
    aspiration: 'turbo',
    gearRatios: [3.2, 2.15, 1.6, 1.24, 1.0, 0.82],
    topSpeedKmh: 378,
    grip: 1.38,
    agility: 0.84,
    brakeG: 1.4,
    driftBias: 0.36,
    dims: { length: 4.7, width: 2.04, height: 1.12, wheelbase: 2.72, track: 1.7, wheelRadius: 0.36, rideHeight: 0.09 },
    defaultVisuals: visuals('#0a0b0e', 'matte', { neonColor: '#a020ff' }),
  },
];

export const STARTER_CAR_ID = 'kaido';
export const STARTING_MONEY = 6000;

export function getCarSpec(id: string): CarSpec {
  return CAR_CATALOG.find((c) => c.id === id) ?? CAR_CATALOG[0];
}

// -----------------------------------------------------------------------------
// Police & traffic
// -----------------------------------------------------------------------------

const POLICE_DIMS_SEDAN = { length: 4.9, width: 1.9, height: 1.46, wheelbase: 2.9, track: 1.6, wheelRadius: 0.34, rideHeight: 0.16 };

export const POLICE_SPECS: Record<PoliceKind, CarPhysicsSpec> = {
  patrol: {
    id: 'police-patrol',
    drivetrain: 'RWD',
    massKg: 1780,
    powerHp: 340,
    torqueNm: 480,
    idleRpm: 800,
    redlineRpm: 6400,
    cylinders: 8,
    aspiration: 'na',
    gearRatios: [3.2, 2.0, 1.42, 1.06, 0.84, 0.68],
    topSpeedKmh: 238,
    grip: 1.05,
    agility: 0.6,
    brakeG: 1.05,
    driftBias: 0.35,
    dims: POLICE_DIMS_SEDAN,
  },
  interceptor: {
    id: 'police-interceptor',
    drivetrain: 'AWD',
    massKg: 1520,
    powerHp: 620,
    torqueNm: 700,
    idleRpm: 900,
    redlineRpm: 7600,
    cylinders: 8,
    aspiration: 'turbo',
    gearRatios: [3.2, 2.1, 1.52, 1.16, 0.93, 0.76],
    topSpeedKmh: 330,
    grip: 1.25,
    agility: 0.78,
    brakeG: 1.25,
    driftBias: 0.3,
    dims: { length: 4.6, width: 1.96, height: 1.22, wheelbase: 2.7, track: 1.64, wheelRadius: 0.35, rideHeight: 0.11 },
  },
  suv: {
    id: 'police-suv',
    drivetrain: 'AWD',
    massKg: 2650,
    powerHp: 520,
    torqueNm: 820,
    idleRpm: 750,
    redlineRpm: 6200,
    cylinders: 8,
    aspiration: 'turbo',
    gearRatios: [3.4, 2.1, 1.46, 1.08, 0.86, 0.7],
    topSpeedKmh: 252,
    grip: 1.08,
    agility: 0.5,
    brakeG: 1.0,
    driftBias: 0.2,
    dims: { length: 5.1, width: 2.04, height: 1.86, wheelbase: 3.0, track: 1.7, wheelRadius: 0.4, rideHeight: 0.24 },
  },
};

export interface TrafficDims {
  length: number;
  width: number;
  height: number;
  mass: number;
  /** relative spawn weight */
  weight: number;
}

export const TRAFFIC_DIMS: Record<TrafficKind, TrafficDims> = {
  sedan: { length: 4.6, width: 1.82, height: 1.44, mass: 1450, weight: 5 },
  hatch: { length: 4.0, width: 1.74, height: 1.48, mass: 1150, weight: 4 },
  taxi: { length: 4.7, width: 1.84, height: 1.5, mass: 1500, weight: 2 },
  pickup: { length: 5.3, width: 1.96, height: 1.8, mass: 2100, weight: 2 },
  van: { length: 5.2, width: 2.0, height: 2.3, mass: 2400, weight: 2 },
  truck: { length: 8.4, width: 2.5, height: 3.4, mass: 9000, weight: 1 },
  bus: { length: 11.0, width: 2.55, height: 3.1, mass: 12000, weight: 0.6 },
};

export const TRAFFIC_KINDS = Object.keys(TRAFFIC_DIMS) as TrafficKind[];

/** Number of body colours available for traffic models (colorIndex ∈ [0, TRAFFIC_COLOR_COUNT)). */
export const TRAFFIC_COLOR_COUNT = 8;

// -----------------------------------------------------------------------------
// Reputation
// -----------------------------------------------------------------------------

/** REP points needed to REACH level i+1 (level 1 = 0 REP). */
export const REP_THRESHOLDS = [0, 400, 1000, 1900, 3100, 4600, 6500, 8800, 11600, 15000, 19000, 24000, 30000, 38000, 48000];

export const MAX_REP_LEVEL = REP_THRESHOLDS.length;

export function repLevelFor(rep: number): number {
  let level = 1;
  for (let i = 0; i < REP_THRESHOLDS.length; i++) if (rep >= REP_THRESHOLDS[i]) level = i + 1;
  return level;
}

export function repLevelBounds(level: number): { floor: number; ceil: number } {
  const i = Math.min(Math.max(level, 1), MAX_REP_LEVEL) - 1;
  const floor = REP_THRESHOLDS[i];
  const ceil = REP_THRESHOLDS[i + 1] ?? floor + 15000;
  return { floor, ceil };
}

export const REP_TITLES = [
  'Inconnu',
  'Débutant',
  'Pilote de quartier',
  'Habitué des runs',
  'Espoir de la rue',
  'Chasseur de chronos',
  'Pilote confirmé',
  'Terreur du périph’',
  'As du bitume',
  'Roi de la glisse',
  'Élite nocturne',
  'Fantôme de l’Orbitale',
  'Mythe urbain',
  'Légende de Port-Sélène',
  'APEX',
];

// -----------------------------------------------------------------------------
// Event mode labels & colours (shared by portals, map and HUD)
// -----------------------------------------------------------------------------

export const MODE_INFO = {
  sprint: { label: 'Sprint', color: '#22e3ff', icon: 'Flag', blurb: 'Course point à point à travers le trafic.' },
  circuit: { label: 'Circuit', color: '#ffb020', icon: 'RefreshCw', blurb: 'Plusieurs tours, checkpoints et classement en direct.' },
  drift: { label: 'Drift', color: '#ff4fa3', icon: 'Tornado', blurb: 'Marque un maximum de points en glisse avant la fin du chrono.' },
  drag: { label: 'Drag', color: '#ff3b30', icon: 'Zap', blurb: 'Ligne droite : boîte manuelle, zone verte et moteur à ménager.' },
  speedtrap: { label: 'Radar', color: '#7dff6a', icon: 'Gauge', blurb: 'Cumule la plus haute vitesse devant les radars.' },
} as const;

export const GARAGE_COLOR = '#b48cff';

export const RIVAL_NAMES = [
  'Vex',
  'Mako',
  'Lynx',
  'Nova K.',
  'Dante R.',
  'Kira',
  'Jett',
  'Rook',
  'Sable',
  'Onyx',
  'Tessa V.',
  'Brask',
  'Zephyr',
  'Nyx',
  'Cobalt',
  'Raze',
];
