/* Road plan of Port-Sélène: the ring highway, the city grid, the hill roads.
 * Produces the nodes / edges of the RoadGraph plus the height profile of the hill roads. */
import type { DistrictId, RoadKind, RoadNode, Vec2 } from '../../core/types';
import { BRIDGE, RING, districtAt } from '../../core/layout';
import type { CityEdge } from './roadGraph';
import type { Heightfield } from './terrain';

export const ROAD_SPECS: Record<RoadKind, { width: number; lanes: number; limit: number }> = {
  street: { width: 12, lanes: 1, limit: 60 },
  avenue: { width: 20, lanes: 2, limit: 90 },
  industrial: { width: 16, lanes: 1, limit: 70 },
  hill: { width: 11.5, lanes: 1, limit: 80 },
  highway: { width: RING.width, lanes: RING.lanes, limit: RING.speedLimitKmh },
  ramp: { width: 10, lanes: 1, limit: 60 },
};

/** Axis-aligned road piece of the city grid. */
export interface GridLine {
  vertical: boolean;
  /** x of a vertical line / z of a horizontal one */
  c: number;
  a: number;
  b: number;
  kind: RoadKind;
}

// ---------------------------------------------------------------------------
// Ring geometry (arc-length parameterisation, clockwise from the west end of the north side)
// ---------------------------------------------------------------------------

const RH = RING.half;
const RR = RING.cornerRadius;
const RS = RH - RR; // 780
const STRAIGHT = 2 * RS;
const ARC = (Math.PI / 2) * RR;
export const RING_LENGTH = 4 * (STRAIGHT + ARC);

export interface RingPose {
  x: number;
  z: number;
  /** unit travel direction (clockwise) */
  dx: number;
  dz: number;
}

/** Point of the ring centre line at arc-length s. */
export function ringPose(s: number, out: RingPose = { x: 0, z: 0, dx: 0, dz: 0 }): RingPose {
  s = ((s % RING_LENGTH) + RING_LENGTH) % RING_LENGTH;
  const side = Math.min(3, Math.floor(s / (STRAIGHT + ARC)));
  const u = s - side * (STRAIGHT + ARC);
  // side 0 = north (heading east), 1 = east (south), 2 = south (west), 3 = west (north)
  let lx: number;
  let lz: number;
  let ldx: number;
  let ldz: number;
  if (u <= STRAIGHT) {
    lx = -RS + u;
    lz = -RH;
    ldx = 1;
    ldz = 0;
  } else {
    const a = -Math.PI / 2 + (u - STRAIGHT) / RR;
    lx = RS + Math.cos(a) * RR;
    lz = -RS + Math.sin(a) * RR;
    ldx = -Math.sin(a);
    ldz = Math.cos(a);
  }
  // rotate the local frame clockwise (on the map) by side * 90°: (x, z) -> (-z, x)
  for (let k = 0; k < side; k++) {
    const tx = -lz;
    lz = lx;
    lx = tx;
    const tdx = -ldz;
    ldz = ldx;
    ldx = tdx;
  }
  out.x = lx;
  out.z = lz;
  out.dx = ldx;
  out.dz = ldz;
  return out;
}

/** Arc-length of the ring point closest to (x, z) (exact for points on the ring). */
export function ringArcLength(x: number, z: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let side = 0; side < 4; side++) {
    // bring the point into the local frame of this side (inverse rotation: (x, z) -> (z, -x))
    let lx = x;
    let lz = z;
    for (let k = 0; k < side; k++) {
      const t = lz;
      lz = -lx;
      lx = t;
    }
    // straight part
    const u = Math.max(0, Math.min(STRAIGHT, lx + RS));
    let d = Math.hypot(lx - (-RS + u), lz + RH);
    if (d < bestD) {
      bestD = d;
      best = side * (STRAIGHT + ARC) + u;
    }
    // arc part
    let a = Math.atan2(lz + RS, lx - RS);
    if (a < -Math.PI / 2) a = -Math.PI / 2;
    if (a > 0) a = a > Math.PI / 2 ? -Math.PI / 2 : 0;
    d = Math.hypot(lx - (RS + Math.cos(a) * RR), lz - (-RS + Math.sin(a) * RR));
    if (d < bestD) {
      bestD = d;
      best = side * (STRAIGHT + ARC) + STRAIGHT + (a + Math.PI / 2) * RR;
    }
  }
  return best;
}

/** Signed lateral offset from the ring centre line: > 0 = outside the ring, < 0 = inside. */
export function ringLateral(x: number, z: number): number {
  const ax = Math.abs(x);
  const az = Math.abs(z);
  if (ax > RS && az > RS) return Math.hypot(ax - RS, az - RS) - RR;
  return Math.max(ax, az) - RH;
}

// --- bridge -----------------------------------------------------------------

/** Arc-length where the bridge deck starts (east side, BRIDGE.approach before the SE arc). */
export const BRIDGE_S0 = STRAIGHT + ARC + STRAIGHT - BRIDGE.approach;
export const BRIDGE_LEN = BRIDGE.approach * 2 + ARC;
const BRIDGE_RAMP = 350;

/** Deck height at distance u along the bridge (0..BRIDGE_LEN); 0 outside. */
export function bridgeDeckHeight(u: number): number {
  if (u <= 0 || u >= BRIDGE_LEN) return 0;
  const a = Math.min(1, u / BRIDGE_RAMP);
  const b = Math.min(1, (BRIDGE_LEN - u) / BRIDGE_RAMP);
  return BRIDGE.deckHeight * (a * a * (3 - 2 * a)) * (b * b * (3 - 2 * b));
}

/** Distance along the bridge of a point near its deck, or -1 when not in the bridge corner. */
export function bridgeU(x: number, z: number): number {
  if (x < RS - BRIDGE.approach - 1 || z < RS - BRIDGE.approach - 1) return -1;
  if (x > RS && z > RS) {
    const a = Math.atan2(z - RS, x - RS);
    return BRIDGE.approach + a * RR;
  }
  if (z <= RS) return z - (RS - BRIDGE.approach);
  return BRIDGE.approach + ARC + (RS - x);
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface HillNodeDef {
  key: string;
  x: number;
  z: number;
}

export interface HillRoadDef {
  from: string;
  to: string;
  /** intermediate waypoints: [x, z, filletRadius?] */
  way: (readonly [number, number, number?])[];
}

/** Hill junctions. Gates (on x = -450) and ring junctions are regular graph nodes. */
export const HILL_NODES: HillNodeDef[] = [
  { key: 'gateE', x: -450, z: 0 },
  { key: 'gateN', x: -450, z: -600 },
  { key: 'gateS', x: -450, z: 600 },
  { key: 'summit', x: -892, z: -110 },
  { key: 'crestN', x: -876, z: -392 },
  { key: 'crestS', x: -888, z: 300 },
  { key: 'forkN', x: -506, z: -610 },
  { key: 'forkS', x: -504, z: 594 },
  { key: 'ringNW', x: -600, z: -1100 },
  { key: 'ringSW', x: -600, z: 1100 },
];

export const HILL_ROADS: HillRoadDef[] = [
  // east climb: five legs, four hairpins
  {
    from: 'gateE',
    to: 'summit',
    way: [
      [-512, 0, 46],
      [-584, 158, 25],
      [-654, -52, 25],
      [-748, 158, 26],
      [-806, -62, 26],
      [-846, -104, 60],
    ],
  },
  // crest road, north part
  { from: 'summit', to: 'crestN', way: [[-906, -200, 70], [-868, -300, 70]] },
  // crest road, south part
  { from: 'summit', to: 'crestS', way: [[-866, -20, 80], [-890, 95, 80], [-864, 200, 80]] },
  // north descent: hairpins down the east face
  {
    from: 'crestN',
    to: 'forkN',
    way: [
      [-872, -480, 90],
      [-866, -592, 24],
      [-762, -428, 24],
      [-692, -604, 24],
      [-604, -472, 24],
      [-548, -620, 42],
    ],
  },
  { from: 'forkN', to: 'gateN', way: [] },
  { from: 'forkN', to: 'ringNW', way: [[-510, -700, 40], [-596, -800, 60], [-660, -905, 60], [-600, -1010, 55]] },
  // south descent
  {
    from: 'crestS',
    to: 'forkS',
    way: [
      [-894, 392, 90],
      [-886, 492, 24],
      [-772, 352, 24],
      [-702, 524, 24],
      [-622, 384, 24],
      [-546, 580, 44],
    ],
  },
  { from: 'forkS', to: 'gateS', way: [] },
  { from: 'forkS', to: 'ringSW', way: [[-506, 684, 40], [-590, 792, 60], [-652, 900, 60], [-600, 1006, 55]] },
  // west balcony above the tunnel
  {
    from: 'crestN',
    to: 'crestS',
    way: [
      [-962, -386, 40],
      [-1012, -310, 60],
      [-1034, -150, 90],
      [-990, -10, 80],
      [-1036, 140, 80],
      [-1004, 262, 60],
      [-950, 304, 40],
    ],
  },
];

/** City grid lines (see the master plan in core/layout.ts). */
export function gridLines(): GridLine[] {
  const L: GridLine[] = [];
  const V = (x: number, a: number, b: number, kind: RoadKind = 'street') => L.push({ vertical: true, c: x, a, b, kind });
  const H = (z: number, a: number, b: number, kind: RoadKind = 'street') => L.push({ vertical: false, c: z, a, b, kind });
  // north-south
  V(-450, -1100, 450);
  V(-450, 450, 1100, 'industrial');
  V(-300, -900, -750);
  V(-300, -600, 450); // gap between z = -750 and -600
  V(-150, -900, 450);
  V(-150, 450, 900, 'industrial');
  V(0, -1100, 1100, 'avenue');
  V(150, -900, -450);
  V(150, -300, 450); // gap between z = -450 and -300
  V(300, -900, 450);
  V(300, 450, 1100, 'industrial');
  V(450, -1100, 450);
  V(600, -900, 450);
  V(600, 450, 900, 'industrial');
  V(750, -900, 150);
  V(750, 300, 450); // gap between z = 150 and 300
  V(750, 450, 600, 'industrial');
  V(900, -900, 450);
  V(900, 450, 836, 'industrial'); // ends on the north pier
  // east-west
  H(-900, -450, 900);
  H(-750, -450, 150);
  H(-750, 300, 900); // gap between x = 150 and 300
  H(-600, -450, 900);
  H(-450, -450, 1100);
  H(-300, -450, 900);
  H(-150, -450, 900);
  H(0, -450, 1100, 'avenue');
  H(150, -450, 900);
  H(300, -450, -300);
  H(300, -150, 900); // gap between x = -300 and -150
  H(450, -450, 1100);
  H(600, 300, 900, 'industrial');
  H(750, -450, 600, 'industrial');
  H(900, -450, 856, 'industrial'); // ends on the west pier
  return L;
}

/** Extra nodes forced on grid lines (where hill roads join the x = -450 street). */
const GRID_SPLITS: Vec2[] = [{ x: -450, z: 600 }];

/** Diagonal streets: [x0, z0, x1, z1]. */
export const DIAGONALS: (readonly [number, number, number, number])[] = [
  [600, -600, 750, -750],
  [750, -750, 900, -900],
];

/** Ring junctions (besides the hill ones): where grid lines reach the ring. */
export interface RoadPlan {
  nodes: RoadNode[];
  edges: CityEdge[];
  lines: GridLine[];
  /** hill node key -> node id */
  hillNodes: Record<string, number>;
  /** ring junction nodes: arc-length + half width of the joining road */
  ringJunctions: { s: number; node: number; halfWidth: number }[];
}

function polyLength(points: Vec2[]): { cum: Float32Array; length: number } {
  const cum = new Float32Array(points.length);
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    acc += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    cum[i] = acc;
  }
  return { cum, length: acc };
}

/** Straight legs joined by circular fillets (tangent-arc-tangent), sampled finely. */
export function filletPath(way: (readonly [number, number, number?])[], defaultR: number): Vec2[] {
  const n = way.length;
  const out: Vec2[] = [{ x: way[0][0], z: way[0][1] }];
  const pushLine = (x: number, z: number) => {
    const last = out[out.length - 1];
    const len = Math.hypot(x - last.x, z - last.z);
    if (len < 0.05) return;
    const k = Math.max(1, Math.ceil(len / 7));
    for (let i = 1; i <= k; i++) out.push({ x: last.x + ((x - last.x) * i) / k, z: last.z + ((z - last.z) * i) / k });
  };
  // tangent lengths, limited so that neighbouring fillets never overlap
  const T: number[] = new Array(n).fill(0);
  const R: number[] = new Array(n).fill(0);
  const TH: number[] = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const ux = way[i][0] - way[i - 1][0];
    const uz = way[i][1] - way[i - 1][1];
    const vx = way[i + 1][0] - way[i][0];
    const vz = way[i + 1][1] - way[i][1];
    const lu = Math.hypot(ux, uz);
    const lv = Math.hypot(vx, vz);
    const cos = Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv)));
    const th = Math.acos(cos);
    TH[i] = th;
    R[i] = way[i][2] ?? defaultR;
    T[i] = th < 1e-3 ? 0 : R[i] * Math.tan(th / 2);
  }
  const T0 = T.slice();
  for (let i = 1; i < n - 1; i++) {
    if (T[i] === 0) continue;
    const lu = Math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]);
    const lv = Math.hypot(way[i + 1][0] - way[i][0], way[i + 1][1] - way[i][1]);
    const availU = i === 1 ? lu - 1 : lu * (T0[i] / (T0[i] + T0[i - 1] || 1));
    const availV = i === n - 2 ? lv - 1 : lv * (T0[i] / (T0[i] + T0[i + 1] || 1));
    const tMax = Math.max(0.5, Math.min(availU, availV));
    if (T[i] > tMax) {
      T[i] = tMax;
      R[i] = tMax / Math.tan(TH[i] / 2);
    }
  }
  for (let i = 1; i < n - 1; i++) {
    const bx = way[i][0];
    const bz = way[i][1];
    if (T[i] === 0) {
      pushLine(bx, bz);
      continue;
    }
    let ux = bx - way[i - 1][0];
    let uz = bz - way[i - 1][1];
    let vx = way[i + 1][0] - bx;
    let vz = way[i + 1][1] - bz;
    const lu = Math.hypot(ux, uz);
    const lv = Math.hypot(vx, vz);
    ux /= lu;
    uz /= lu;
    vx /= lv;
    vz /= lv;
    const p1x = bx - ux * T[i];
    const p1z = bz - uz * T[i];
    pushLine(p1x, p1z);
    // turn side: cross(u, v) in the XZ plane
    const cross = ux * vz - uz * vx;
    const sgn = cross >= 0 ? 1 : -1;
    // normal pointing to the arc centre
    const nx = -uz * sgn;
    const nz = ux * sgn;
    const cx = p1x + nx * R[i];
    const cz = p1z + nz * R[i];
    const a0 = Math.atan2(p1z - cz, p1x - cx);
    const steps = Math.max(2, Math.ceil((R[i] * TH[i]) / 4.5));
    for (let k = 1; k <= steps; k++) {
      const a = a0 + (sgn * TH[i] * k) / steps;
      out.push({ x: cx + Math.cos(a) * R[i], z: cz + Math.sin(a) * R[i] });
    }
  }
  pushLine(way[n - 1][0], way[n - 1][1]);
  const last = out[out.length - 1];
  last.x = way[n - 1][0];
  last.z = way[n - 1][1];
  return out;
}

export function buildRoadPlan(hf: Heightfield): RoadPlan {
  const nodes: RoadNode[] = [];
  const edges: CityEdge[] = [];
  const nodeKeys = new Map<string, number>();
  const key = (x: number, z: number) => `${Math.round(x * 10)}:${Math.round(z * 10)}`;
  const nodeAt = (x: number, z: number): number => {
    const k = key(x, z);
    let id = nodeKeys.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ id, x, z, edges: [] });
      nodeKeys.set(k, id);
    }
    return id;
  };
  const addEdge = (a: number, b: number, points: Vec2[], kind: RoadKind, district?: DistrictId, limit?: number): CityEdge => {
    const spec = ROAD_SPECS[kind];
    const { cum, length } = polyLength(points);
    const mid = points[points.length >> 1];
    const mx = points.length === 2 ? (points[0].x + points[1].x) / 2 : mid.x;
    const mz = points.length === 2 ? (points[0].z + points[1].z) / 2 : mid.z;
    const d = district ?? districtAt(mx, mz);
    const e: CityEdge = {
      id: edges.length,
      a,
      b,
      points,
      length,
      width: spec.width,
      lanes: spec.lanes,
      kind,
      district: d,
      speedLimitKmh: limit ?? (kind === 'street' && d === 'downtown' ? 70 : spec.limit),
      cum,
    };
    edges.push(e);
    nodes[a].edges.push(e.id);
    nodes[b].edges.push(e.id);
    return e;
  };

  // --- city grid ------------------------------------------------------------
  const lines = gridLines();
  const covers = (l: GridLine, v: number) => v >= l.a - 1e-6 && v <= l.b + 1e-6;
  for (const l of lines) {
    const stops: number[] = [l.a, l.b];
    for (const o of lines) {
      if (o.vertical === l.vertical) continue;
      if (covers(l, o.c) && covers(o, l.c)) stops.push(o.c);
    }
    for (const s of GRID_SPLITS) {
      if (l.vertical && Math.abs(s.x - l.c) < 1e-6 && covers(l, s.z)) stops.push(s.z);
      if (!l.vertical && Math.abs(s.z - l.c) < 1e-6 && covers(l, s.x)) stops.push(s.x);
    }
    for (const d of DIAGONALS) {
      for (const [dx, dz] of [
        [d[0], d[1]],
        [d[2], d[3]],
      ]) {
        if (l.vertical && Math.abs(dx - l.c) < 1e-6 && covers(l, dz)) stops.push(dz);
        if (!l.vertical && Math.abs(dz - l.c) < 1e-6 && covers(l, dx)) stops.push(dx);
      }
    }
    stops.sort((p, q) => p - q);
    let prev = stops[0];
    for (let i = 1; i < stops.length; i++) {
      const cur = stops[i];
      if (cur - prev < 1) continue;
      const ax = l.vertical ? l.c : prev;
      const az = l.vertical ? prev : l.c;
      const bx = l.vertical ? l.c : cur;
      const bz = l.vertical ? cur : l.c;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      // the spurs reaching the ring belong to the district they come from
      let district = districtAt(mx, mz);
      if (district === 'highway') district = districtAt(mx * 0.9, mz * 0.9);
      addEdge(nodeAt(ax, az), nodeAt(bx, bz), [{ x: ax, z: az }, { x: bx, z: bz }], l.kind, district);
      prev = cur;
    }
  }
  for (const d of DIAGONALS) {
    addEdge(nodeAt(d[0], d[1]), nodeAt(d[2], d[3]), [{ x: d[0], z: d[1] }, { x: d[2], z: d[3] }], 'street', 'lantern');
  }

  // --- hill roads -----------------------------------------------------------
  const hillNodes: Record<string, number> = {};
  for (const hn of HILL_NODES) hillNodes[hn.key] = nodeAt(hn.x, hn.z);
  const hillEdges: CityEdge[] = [];
  for (const def of HILL_ROADS) {
    const a = nodes[hillNodes[def.from]];
    const b = nodes[hillNodes[def.to]];
    const way: (readonly [number, number, number?])[] = [[a.x, a.z], ...def.way, [b.x, b.z]];
    const pts = filletPath(way, 30);
    hillEdges.push(addEdge(a.id, b.id, pts, 'hill', 'hills'));
  }

  // --- ring highway -----------------------------------------------------------
  const ringJunctions: { s: number; node: number; halfWidth: number }[] = [];
  for (const n of nodes) {
    if (Math.abs(ringLateral(n.x, n.z)) < 0.5) {
      let hw = 6;
      for (const eid of n.edges) hw = Math.max(hw, edges[eid].width / 2);
      ringJunctions.push({ s: ringArcLength(n.x, n.z), node: n.id, halfWidth: hw });
    }
  }
  ringJunctions.sort((p, q) => p.s - q.s);
  const corner = STRAIGHT + ARC;
  const pose: RingPose = { x: 0, z: 0, dx: 0, dz: 0 };
  for (let i = 0; i < ringJunctions.length; i++) {
    const j0 = ringJunctions[i];
    const j1 = ringJunctions[(i + 1) % ringJunctions.length];
    const s0 = j0.s;
    const s1 = j1.s > s0 ? j1.s : j1.s + RING_LENGTH;
    // breakpoints: ends + every straight/arc boundary in between
    const breaks: number[] = [s0];
    for (let k = Math.floor(s0 / corner) - 1; k <= Math.ceil(s1 / corner) + 1; k++) {
      for (const b of [k * corner, k * corner + STRAIGHT]) if (b > s0 + 0.5 && b < s1 - 0.5) breaks.push(b);
    }
    breaks.push(s1);
    breaks.sort((p, q) => p - q);
    const pts: Vec2[] = [{ x: nodes[j0.node].x, z: nodes[j0.node].z }];
    for (let k = 0; k + 1 < breaks.length; k++) {
      const b0 = breaks[k];
      const b1 = breaks[k + 1];
      const midU = (((b0 + b1) / 2) % corner + corner) % corner;
      const isArc = midU > STRAIGHT;
      const step = isArc ? 10.5 : 40;
      const cnt = Math.max(1, Math.ceil((b1 - b0) / step));
      for (let q = 1; q <= cnt; q++) {
        const s = b0 + ((b1 - b0) * q) / cnt;
        ringPose(s, pose);
        pts.push({ x: pose.x, z: pose.z });
      }
    }
    const last = pts[pts.length - 1];
    last.x = nodes[j1.node].x;
    last.z = nodes[j1.node].z;
    const e = addEdge(j0.node, j1.node, pts, 'highway', 'highway');
    e.ringS0 = s0;
  }

  solveHillProfiles(hf, nodes, hillEdges);

  return { nodes, edges, lines, hillNodes, ringJunctions };
}

/** Height profile (per point) of every hill edge, filled by solveHillProfiles. */
export const hillHeights = new WeakMap<CityEdge, Float32Array>();

/**
 * Smooth height profiles for the hill roads: follow the natural terrain, shared
 * heights at junctions, gradient limited to ~11.5 %, flat pads around junctions.
 */
function solveHillProfiles(hf: Heightfield, nodes: RoadNode[], hillEdges: CityEdge[]): void {
  const MAX_GRADE = 0.112;
  const PAD = 9;
  // variables
  const h: number[] = [];
  const h0: number[] = [];
  const pinned: boolean[] = [];
  const nodeVar = new Map<number, number>();
  const varOf: Int32Array[] = [];
  const newVar = (x: number, z: number, pin: boolean): number => {
    const v = h.length;
    const nat = pin ? 0 : hf.sampleNatural(x, z);
    h.push(nat);
    h0.push(nat);
    pinned.push(pin);
    return v;
  };
  for (const e of hillEdges) {
    for (const nid of [e.a, e.b]) {
      if (nodeVar.has(nid)) continue;
      const n = nodes[nid];
      const flat = n.x >= -456 || Math.abs(ringLateral(n.x, n.z)) < 1;
      nodeVar.set(nid, newVar(n.x, n.z, flat));
    }
  }
  for (const e of hillEdges) {
    const n = e.points.length;
    const vars = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      if (e.cum[i] <= PAD) vars[i] = nodeVar.get(e.a)!;
      else if (e.length - e.cum[i] <= PAD) vars[i] = nodeVar.get(e.b)!;
      else vars[i] = newVar(e.points[i].x, e.points[i].z, false);
    }
    varOf.push(vars);
  }
  // node variables start at the mean natural height of their pad
  const acc = new Float64Array(h.length);
  const cnt = new Int32Array(h.length);
  hillEdges.forEach((e, q) => {
    const vars = varOf[q];
    for (let i = 0; i < vars.length; i++) {
      acc[vars[i]] += hf.sampleNatural(e.points[i].x, e.points[i].z);
      cnt[vars[i]]++;
    }
  });
  for (let v = 0; v < h.length; v++) {
    if (!pinned[v] && cnt[v] > 1) {
      h[v] = acc[v] / cnt[v];
      h0[v] = h[v];
    }
  }
  const slopePass = () => {
    for (let q = 0; q < hillEdges.length; q++) {
      const e = hillEdges[q];
      const vars = varOf[q];
      for (let i = 0; i + 1 < vars.length; i++) {
        const a = vars[i];
        const b = vars[i + 1];
        if (a === b) continue;
        const ds = e.cum[i + 1] - e.cum[i];
        const maxD = MAX_GRADE * ds;
        const d = h[b] - h[a];
        const over = Math.abs(d) - maxD;
        if (over <= 0) continue;
        const wa = pinned[a] ? 0 : 1;
        const wb = pinned[b] ? 0 : 1;
        if (wa + wb === 0) continue;
        const corr = (over * Math.sign(d)) / (wa + wb);
        h[a] += corr * wa;
        h[b] -= corr * wb;
      }
    }
  };
  for (let it = 0; it < 500; it++) {
    for (let q = 0; q < hillEdges.length; q++) {
      const vars = varOf[q];
      for (let i = 1; i + 1 < vars.length; i++) {
        const v = vars[i];
        if (pinned[v] || v === vars[i - 1] || v === vars[i + 1]) continue;
        const avg = (h[vars[i - 1]] + h[vars[i + 1]]) * 0.5;
        h[v] += (avg - h[v]) * 0.5 + (h0[v] - h[v]) * 0.012;
      }
    }
    slopePass();
  }
  for (let it = 0; it < 200; it++) slopePass();
  hillEdges.forEach((e, q) => {
    const vars = varOf[q];
    const out = new Float32Array(vars.length);
    for (let i = 0; i < vars.length; i++) out[i] = h[vars[i]];
    hillHeights.set(e, out);
  });
}
