/* Event catalogue of Port-Sélène and route construction on the road graph. */
import { PolylinePath } from '../core/path';
import type {
  CityWorld,
  DistrictId,
  EventMode,
  EventRecord,
  EventSummary,
  LandmarkId,
  RoadEdge,
  SpawnPoint,
  Vec2,
} from '../core/types';
import { MODE_INFO } from './catalog';

export type Waypoint = LandmarkId | Vec2;

export interface EventDef {
  id: string;
  name: string;
  mode: EventMode;
  district: DistrictId;
  description: string;
  /** 1..5 */
  difficulty: number;
  repLevel: number;
  /** laps for closed routes, 1 otherwise */
  laps: number;
  rivals: number;
  /** route control points; the first one is the start grid */
  waypoints: Waypoint[];
  closed: boolean;
  /** civilian traffic density during the event (0..1) */
  traffic: number;
  /** drift: time limit (s) */
  timeLimit?: number;
  /** drift score / speed-trap total targets */
  targets?: { gold: number; silver: number; bronze: number };
  /** speedtrap: number of radars */
  traps?: number;
}

const p = (x: number, z: number): Vec2 => ({ x, z });

export const EVENT_DEFS: EventDef[] = [
  // ----------------------------------------------------------------- level 1
  {
    id: 'circuit-central',
    name: 'Boucle Centrale',
    mode: 'circuit',
    district: 'downtown',
    description: 'Trois tours autour du cœur de Néon Central. Quatre angles droits, zéro excuse.',
    difficulty: 1,
    repLevel: 1,
    laps: 3,
    rivals: 3,
    waypoints: [p(-30, -150), p(150, -150), p(150, 150), p(-150, 150), p(-150, -150)],
    closed: true,
    traffic: 0.25,
  },
  {
    id: 'sprint-neon-rush',
    name: 'Néon Rush',
    mode: 'sprint',
    district: 'downtown',
    description: 'Du nord du centre-ville jusqu’aux docks, en slalomant dans le trafic.',
    difficulty: 1,
    repLevel: 1,
    laps: 1,
    rivals: 3,
    waypoints: [p(-300, -390), p(-300, -150), p(150, -150), p(150, 300), p(300, 300), p(300, 720)],
    closed: false,
    traffic: 0.5,
  },
  {
    id: 'drift-docks',
    name: 'Glisse des Quais',
    mode: 'drift',
    district: 'docks',
    description: 'Les larges aires bétonnées des docks : idéal pour apprendre à tenir une glisse.',
    difficulty: 1,
    repLevel: 1,
    laps: 1,
    rivals: 0,
    waypoints: [p(-60, 600), p(300, 600), p(300, 900), p(-300, 900), p(-300, 600)],
    closed: true,
    traffic: 0,
    timeLimit: 80,
    targets: { gold: 26000, silver: 14000, bronze: 6000 },
  },
  // ----------------------------------------------------------------- level 2
  {
    id: 'drag-orbitale',
    name: 'Run de l’Orbitale Nord',
    mode: 'drag',
    district: 'highway',
    description: 'Ligne droite sur le périphérique. Boîte manuelle : passe chaque rapport dans la zone verte.',
    difficulty: 2,
    repLevel: 2,
    laps: 1,
    rivals: 3,
    waypoints: [p(-700, -1100), p(170, -1100)],
    closed: false,
    traffic: 0,
  },
  {
    id: 'trap-boulevard',
    name: 'Radars du Boulevard',
    mode: 'speedtrap',
    district: 'downtown',
    description: 'Le grand boulevard est-ouest puis l’Orbitale : flashe les radars le plus vite possible.',
    difficulty: 2,
    repLevel: 2,
    laps: 1,
    rivals: 3,
    waypoints: [p(-400, 0), p(600, 0), 'ringEast', p(1100, -500)],
    closed: false,
    traffic: 0.35,
    traps: 4,
    targets: { gold: 760, silver: 660, bronze: 560 },
  },
  {
    id: 'sprint-lanterne',
    name: 'Ruelles Lanterne',
    mode: 'sprint',
    district: 'lantern',
    description: 'Un sprint nerveux entre les enseignes du Quartier Lanterne.',
    difficulty: 2,
    repLevel: 2,
    laps: 1,
    rivals: 3,
    waypoints: ['lanternPlaza', p(600, -600), p(600, -300), p(900, -300), p(900, 150), p(600, 150), p(600, 390)],
    closed: false,
    traffic: 0.5,
  },
  // ----------------------------------------------------------------- level 3
  {
    id: 'circuit-docks',
    name: 'Anneau des Docks',
    mode: 'circuit',
    district: 'docks',
    description: 'Un circuit rapide entre entrepôts et conteneurs. Attention aux semi-remorques.',
    difficulty: 2,
    repLevel: 3,
    laps: 3,
    rivals: 4,
    waypoints: [p(-60, 600), p(300, 600), p(300, 900), p(-300, 900), p(-300, 600)],
    closed: true,
    traffic: 0.3,
  },
  {
    id: 'trap-orbitale',
    name: 'Flash Orbitale',
    mode: 'speedtrap',
    district: 'highway',
    description: 'La moitié est du périphérique, pont compris. Garde ta nitro pour les radars.',
    difficulty: 3,
    repLevel: 3,
    laps: 1,
    rivals: 3,
    waypoints: [p(60, -1100), p(1100, -200), 'bridgeMid', p(120, 1100)],
    closed: false,
    traffic: 0.4,
    traps: 5,
    targets: { gold: 1250, silver: 1100, bronze: 950 },
  },
  // ----------------------------------------------------------------- level 4
  {
    id: 'drift-touge',
    name: 'Touge des Hauts',
    mode: 'drift',
    district: 'hills',
    description: 'La montée des Hauts-de-Sélène, épingle après épingle. Enchaîne les glisses jusqu’au sommet.',
    difficulty: 3,
    repLevel: 4,
    laps: 1,
    rivals: 0,
    waypoints: ['hillsEastGate', 'hillsSummit'],
    closed: false,
    traffic: 0,
    timeLimit: 120,
    targets: { gold: 42000, silver: 24000, bronze: 11000 },
  },
  {
    id: 'sprint-descente',
    name: 'Descente des Crêtes',
    mode: 'sprint',
    district: 'hills',
    description: 'Du sommet jusqu’aux docks : freinages tardifs et précipices.',
    difficulty: 3,
    repLevel: 4,
    laps: 1,
    rivals: 3,
    waypoints: ['hillsSummit', 'hillsSouthGate', 'docksGate'],
    closed: false,
    traffic: 0.2,
  },
  // ----------------------------------------------------------------- level 5-6
  {
    id: 'circuit-lanterne',
    name: 'Circuit des Lanternes',
    mode: 'circuit',
    district: 'lantern',
    description: 'Trois tours serrés dans le quartier est. Les murs ne pardonnent pas.',
    difficulty: 3,
    repLevel: 5,
    laps: 3,
    rivals: 4,
    waypoints: [p(690, -750), p(900, -750), p(900, -300), p(600, -300), p(600, -750)],
    closed: true,
    traffic: 0.3,
  },
  {
    id: 'drag-boulevard',
    name: 'Duel du Boulevard Sud',
    mode: 'drag',
    district: 'docks',
    description: 'Le boulevard nord-sud, du centre jusqu’au périphérique. Quatre voies, quatre fous furieux.',
    difficulty: 4,
    repLevel: 6,
    laps: 1,
    rivals: 3,
    waypoints: [p(0, 190), p(0, 1040)],
    closed: false,
    traffic: 0,
  },
  {
    id: 'sprint-orbitale',
    name: 'Traversée Orbitale',
    mode: 'sprint',
    district: 'highway',
    description: 'Trois quarts de périphérique à fond, tunnel et pont compris.',
    difficulty: 4,
    repLevel: 6,
    laps: 1,
    rivals: 4,
    waypoints: [p(1100, 100), 'bridgeMid', 'ringSouth', 'tunnelMid', p(-300, -1100)],
    closed: false,
    traffic: 0.5,
  },
  // ----------------------------------------------------------------- level 7+
  {
    id: 'drift-carrefours',
    name: 'Carrefours Néon',
    mode: 'drift',
    district: 'downtown',
    description: 'Un pâté de maisons, quatre carrefours : fais fumer les pneus sous les gratte-ciels.',
    difficulty: 4,
    repLevel: 7,
    laps: 1,
    rivals: 0,
    waypoints: [p(-60, -300), p(150, -300), p(150, -150), p(-150, -150), p(-150, -300)],
    closed: true,
    traffic: 0,
    timeLimit: 90,
    targets: { gold: 60000, silver: 36000, bronze: 18000 },
  },
  {
    id: 'trap-cretes',
    name: 'Radars des Crêtes',
    mode: 'speedtrap',
    district: 'hills',
    description: 'Des radars posés à la sortie des courbes de montagne. Du courage, et des freins.',
    difficulty: 4,
    repLevel: 8,
    laps: 1,
    rivals: 3,
    waypoints: ['hillsNorthGate', 'hillsSummit', 'hillsSouthGate'],
    closed: false,
    traffic: 0.1,
    traps: 4,
    targets: { gold: 640, silver: 540, bronze: 440 },
  },
  {
    id: 'sprint-baie-sommet',
    name: 'De la Baie au Sommet',
    mode: 'sprint',
    district: 'docks',
    description: 'Toute la ville d’est en ouest : des quais jusqu’au point de vue des Hauts.',
    difficulty: 5,
    repLevel: 9,
    laps: 1,
    rivals: 4,
    waypoints: ['docksPier', 'docksGate', p(0, 300), 'downtownCore', p(-300, 0), 'hillsEastGate', 'hillsSummit'],
    closed: false,
    traffic: 0.55,
  },
  {
    id: 'circuit-orbitale',
    name: 'Grand Prix de l’Orbitale',
    mode: 'circuit',
    district: 'highway',
    description: 'Deux tours complets du périphérique. Le rendez-vous des légendes de Port-Sélène.',
    difficulty: 5,
    repLevel: 10,
    laps: 2,
    rivals: 5,
    waypoints: [p(60, -1100), 'ringEast', 'bridgeMid', 'ringSouth', 'tunnelMid'],
    closed: true,
    traffic: 0.45,
  },
];

export const REWARD_MONEY = [1500, 2600, 4200, 6500, 10000];
export const REWARD_REP = [130, 210, 330, 480, 700];

// -----------------------------------------------------------------------------
// Route construction
// -----------------------------------------------------------------------------

export interface GateDef {
  /** arc-length on the route */
  s: number;
  x: number;
  z: number;
  heading: number;
  width: number;
}

export interface BuiltEvent {
  def: EventDef;
  route: PolylinePath;
  /** arc-length of the start / finish line (the grid sits just behind it) */
  startS: number;
  /** race distance from the start line (all laps) */
  lengthM: number;
  /** length of one lap (closed) or of the whole run (open), from the start line */
  lapLength: number;
  /** start line pose — also the position of the event portal */
  start: SpawnPoint;
  /** checkpoints of one lap, in order; the last one is the finish / lap line */
  gates: GateDef[];
  /** speed-trap positions (arc-length) */
  traps: GateDef[];
  /** half of the narrowest road width along the route */
  halfWidth: number;
}

export function resolveWaypoint(world: CityWorld, wp: Waypoint): Vec2 {
  if (typeof wp === 'string') {
    const l = world.landmarks[wp];
    return { x: l.x, z: l.z };
  }
  return wp;
}

/** Sub-section of a polyline between two arc-lengths (reversed when s0 > s1). */
function slicePolyline(points: Vec2[], s0: number, s1: number): Vec2[] {
  const path = new PolylinePath(points, false);
  const lo = Math.max(0, Math.min(s0, s1));
  const hi = Math.min(path.length, Math.max(s0, s1));
  const out: Vec2[] = [path.pointAt(lo)];
  for (let i = 0; i < path.points.length; i++) {
    if (path.cum[i] > lo + 1e-3 && path.cum[i] < hi - 1e-3) out.push({ x: path.points[i].x, z: path.points[i].z });
  }
  out.push(path.pointAt(hi));
  if (s0 > s1) out.reverse();
  return out;
}

function pathCost(world: CityWorld, nodes: number[]): number {
  let cost = 0;
  for (let i = 0; i + 1 < nodes.length; i++) {
    const e = world.roads.edgeBetween(nodes[i], nodes[i + 1]);
    if (!e) return Infinity;
    cost += e.length / Math.max(20, e.speedLimitKmh);
  }
  return cost;
}

function edgeCost(e: RoadEdge, len: number): number {
  return len / Math.max(20, e.speedLimitKmh);
}

/** Fastest drivable polyline between two arbitrary points snapped on the road network. */
export function routeBetween(world: CityWorld, a: Vec2, b: Vec2): Vec2[] {
  const roads = world.roads;
  const ha = roads.nearestRoad(a.x, a.z, 400);
  const hb = roads.nearestRoad(b.x, b.z, 400);
  if (!ha || !hb) {
    const na = roads.nearestNode(a.x, a.z);
    const nb = roads.nearestNode(b.x, b.z);
    return roads.pathPolyline(roads.findPath(na.id, nb.id));
  }
  if (ha.edge.id === hb.edge.id) return slicePolyline(ha.edge.points, ha.t, hb.t);

  let best: { cost: number; nodes: number[]; fromA: boolean; toA: boolean } | null = null;
  for (const fromA of [true, false]) {
    for (const toA of [true, false]) {
      const n0 = fromA ? ha.edge.a : ha.edge.b;
      const n1 = toA ? hb.edge.a : hb.edge.b;
      const nodes = roads.findPath(n0, n1);
      if (nodes.length === 0) continue;
      // reject paths that immediately double back over the partial edges
      if (nodes.length > 1) {
        if (nodes[1] === (fromA ? ha.edge.b : ha.edge.a) && roads.edgeBetween(nodes[0], nodes[1])?.id === ha.edge.id) continue;
        const k = nodes.length - 1;
        if (nodes[k - 1] === (toA ? hb.edge.b : hb.edge.a) && roads.edgeBetween(nodes[k - 1], nodes[k])?.id === hb.edge.id) continue;
      }
      const cost =
        edgeCost(ha.edge, fromA ? ha.t : ha.edge.length - ha.t) +
        pathCost(world, nodes) +
        edgeCost(hb.edge, toA ? hb.t : hb.edge.length - hb.t);
      if (!best || cost < best.cost) best = { cost, nodes, fromA, toA };
    }
  }
  if (!best) {
    const na = roads.nearestNode(a.x, a.z);
    const nb = roads.nearestNode(b.x, b.z);
    return roads.pathPolyline(roads.findPath(na.id, nb.id));
  }
  const out: Vec2[] = [];
  const push = (pts: Vec2[]) => {
    for (const q of pts) {
      const last = out[out.length - 1];
      if (!last || Math.hypot(last.x - q.x, last.z - q.z) > 0.05) out.push(q);
    }
  };
  push(slicePolyline(ha.edge.points, ha.t, best.fromA ? 0 : ha.edge.length));
  push(roads.pathPolyline(best.nodes));
  push(slicePolyline(hb.edge.points, best.toA ? 0 : hb.edge.length, hb.t));
  return out;
}

/** Drop the intermediate points of straight runs so corner fillets can use the full straight length. */
export function simplifyCollinear(points: Vec2[], closed: boolean): Vec2[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    // the first point is the start grid (and the last one the finish of open routes): always kept
    if (i === 0 || (!closed && i === n - 1)) {
      out.push(points[i]);
      continue;
    }
    const prev = out.length > 0 ? out[out.length - 1] : points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const ax = cur.x - prev.x;
    const az = cur.z - prev.z;
    const bx = next.x - cur.x;
    const bz = next.z - cur.z;
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    if (Math.abs(Math.atan2(cross, dot)) > 0.008) out.push(cur);
  }
  return out.length >= 2 ? out : points.slice();
}

/** Replace sharp polyline corners by short arcs (quadratic Bézier fillets). */
export function roundCorners(points: Vec2[], radius: number, closed: boolean): Vec2[] {
  const n = points.length;
  if (n < 3) return points.slice();
  const out: Vec2[] = [];
  const first = closed ? 0 : 1;
  const last = closed ? n - 1 : n - 2;
  if (!closed) out.push(points[0]);
  for (let i = first; i <= last; i++) {
    const prev = points[(i - 1 + n) % n];
    const cur = points[i];
    const next = points[(i + 1) % n];
    const ax = cur.x - prev.x;
    const az = cur.z - prev.z;
    const bx = next.x - cur.x;
    const bz = next.z - cur.z;
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-3 || lb < 1e-3) continue;
    const cos = Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb)));
    const theta = Math.acos(cos);
    if (theta < 0.3) {
      out.push(cur);
      continue;
    }
    const t = Math.min(radius * Math.tan(theta / 2), la * 0.45, lb * 0.45);
    const p0 = { x: cur.x - (ax / la) * t, z: cur.z - (az / la) * t };
    const p2 = { x: cur.x + (bx / lb) * t, z: cur.z + (bz / lb) * t };
    const steps = 7;
    for (let k = 0; k <= steps; k++) {
      const u = k / steps;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * u * (1 - u);
      const w2 = u * u;
      out.push({ x: p0.x * w0 + cur.x * w1 + p2.x * w2, z: p0.z * w0 + cur.z * w1 + p2.z * w2 });
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

const GRID_LENGTH = 46;

function gateAt(world: CityWorld, route: PolylinePath, s: number): GateDef {
  const pt = route.pointAt(s);
  const hit = world.roads.nearestRoad(pt.x, pt.z, 40);
  return { s: route.norm(s), x: pt.x, z: pt.z, heading: route.headingAt(s), width: (hit ? hit.edge.width : 14) + 3 };
}

export function buildEvent(world: CityWorld, def: EventDef): BuiltEvent {
  const wps = def.waypoints.map((w) => resolveWaypoint(world, w));
  const raw: Vec2[] = [];
  const legs = def.closed ? wps.length : wps.length - 1;
  for (let i = 0; i < legs; i++) {
    const leg = routeBetween(world, wps[i], wps[(i + 1) % wps.length]);
    for (const q of leg) {
      const last = raw[raw.length - 1];
      if (!last || Math.hypot(last.x - q.x, last.z - q.z) > 0.05) raw.push(q);
    }
  }
  if (def.closed && raw.length > 2) {
    const a = raw[0];
    const b = raw[raw.length - 1];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 0.5) raw.pop();
  }
  const rounded = roundCorners(simplifyCollinear(raw, def.closed), def.mode === 'drag' ? 0 : 11, def.closed);
  const pts = PolylinePath.resample(rounded, 5, def.closed);
  const route = new PolylinePath(pts, def.closed);

  const startS = Math.min(GRID_LENGTH, route.length * 0.2);
  const lapLength = def.closed ? route.length : route.length - startS - 2;
  const lengthM = def.closed ? route.length * def.laps : lapLength;

  // checkpoints of one lap
  const gates: GateDef[] = [];
  const spacingTarget = def.mode === 'drag' ? 1e9 : 230;
  const count = Math.max(1, Math.round(lapLength / spacingTarget));
  for (let i = 1; i <= count; i++) {
    const s = startS + (lapLength * i) / count;
    gates.push(gateAt(world, route, def.closed ? s : Math.min(s, route.length - 2)));
  }

  // speed traps on the straightest spots
  const traps: GateDef[] = [];
  if (def.mode === 'speedtrap') {
    const n = def.traps ?? 4;
    for (let i = 0; i < n; i++) {
      const base = startS + (lapLength * (i + 0.75)) / n;
      let bestS = base;
      let bestScore = Infinity;
      for (let k = -9; k <= 9; k++) {
        const s = base + k * 12;
        if (s < startS + 120 || s > route.length - 30) continue;
        let score = 0;
        for (let back = 0; back <= 90; back += 15) score = Math.max(score, Math.abs(route.curvatureAt(s - back, 20)));
        score += Math.abs(k) * 0.0002;
        if (score < bestScore) {
          bestScore = score;
          bestS = s;
        }
      }
      traps.push(gateAt(world, route, bestS));
    }
    traps.sort((a, b) => a.s - b.s);
  }

  let halfWidth = 100;
  for (let s = 0; s < route.length; s += 40) {
    const q = route.pointAt(s);
    const hit = world.roads.nearestRoad(q.x, q.z, 30);
    if (hit) halfWidth = Math.min(halfWidth, hit.edge.width * 0.5);
  }
  if (halfWidth > 50) halfWidth = 6;

  const sp = route.pointAt(startS);
  return {
    def,
    route,
    startS,
    lengthM,
    lapLength,
    start: { x: sp.x, z: sp.z, heading: route.headingAt(startS) },
    gates,
    traps,
    halfWidth,
  };
}

export function eventSummary(built: BuiltEvent, record: EventRecord | null, repLevel: number): EventSummary {
  const d = built.def;
  return {
    id: d.id,
    name: d.name,
    mode: d.mode,
    modeLabel: MODE_INFO[d.mode].label,
    district: d.district,
    description: d.description,
    difficulty: d.difficulty,
    laps: d.laps,
    lengthKm: Math.round(built.lengthM / 10) / 100,
    rivals: d.rivals,
    repLevelRequired: d.repLevel,
    rewardMoney: REWARD_MONEY[d.difficulty - 1],
    rewardRep: REWARD_REP[d.difficulty - 1],
    locked: repLevel < d.repLevel,
    record,
    targets: d.targets ?? null,
  };
}
