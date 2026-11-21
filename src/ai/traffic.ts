/* =============================================================================
 * APEX NOCTURNE — civilian traffic.
 *
 * Lightweight KINEMATIC cars following the lanes of the road graph (right-hand
 * traffic). No IVehicle: the engine draws them from the TrafficCar fields and
 * collides physics vehicles against them as KinematicBody.
 *  - population kept around the focus point (spawn 130–340 m away, biased ahead);
 *  - lane following on edges, quadratic Bézier through junctions, IDM car
 *    following, junction yielding;
 *  - light hits: the driver brakes and eases back onto its lane; hard hits: the
 *    car becomes a sliding wreck, then gets recycled out of sight.
 * No allocation in update() except when a car is spawned.
 * ===========================================================================*/
import type { AIHost, BodyInfo, ITrafficSystem, RoadEdge, RoadGraph, StaticCollider, TrafficCar, TrafficKind } from '../core/types';
import { mulberry32 } from '../core/math';
import { TRAFFIC_COLOR_COUNT, TRAFFIC_DIMS, TRAFFIC_KINDS } from '../game/catalog';
import { circlePenetration, pushOut } from './steering';

/** Tunable constants of the traffic system. */
export const TRAFFIC_TUNING = {
  maxCars: 28,
  spawnMin: 130,
  spawnMax: 340,
  /** minimum spawn distance while the camera has a direct line of sight */
  spawnMinVisible: 190,
  cameraMin: 60,
  bodyClearance: 25,
  recycleDist: 430,
  /** IDM car-following */
  timeGap: 1.3,
  minGap: 2.6,
  accel: 2.1,
  decel: 3.2,
  /** hit intensity (m/s) above which a car is wrecked */
  wreckIntensity: 2.5,
  wreckFriction: 7,
  wreckStay: 10,
  wreckMax: 25,
};

const KIND_SPEED: Record<TrafficKind, number> = { sedan: 1, hatch: 1, taxi: 1.04, pickup: 0.95, van: 0.9, truck: 0.8, bus: 0.76 };
const KIND_WHEELBASE: Record<TrafficKind, number> = { sedan: 2.7, hatch: 2.5, taxi: 2.75, pickup: 3.3, van: 3.2, truck: 5.2, bus: 6.2 };

interface EdgeGeo {
  n: number;
  x: Float64Array;
  z: Float64Array;
  cum: Float32Array;
  /** per-vertex right-hand normals (relative to the a -> b direction) */
  nx: Float32Array;
  nz: Float32Array;
}

interface Car extends TrafficCar {
  /** 0 = on an edge, 1 = crossing a junction (Bézier) */
  phase: number;
  edge: RoadEdge;
  geo: EdgeGeo;
  dir: number;
  laneOff: number;
  t: number;
  seg: number;
  /** t at which the car leaves the edge */
  endT: number;
  next: RoadEdge | null;
  nextDir: number;
  nextLaneOff: number;
  turnSpeed: number;
  /** junction curve */
  node: number;
  prevEdgeId: number;
  bx0: number;
  bz0: number;
  bx1: number;
  bz1: number;
  bx2: number;
  bz2: number;
  bu: number;
  cruise: number;
  wheelbase: number;
  /** pose offset left by a collision, decays to zero */
  offX: number;
  offZ: number;
  offH: number;
  lastX: number;
  lastZ: number;
  lastH: number;
  brakeT: number;
  wreckT: number;
  stoppedT: number;
  blockedT: number;
  leadGap: number;
  leadSpeed: number;
  tick: number;
}

class TrafficSystem implements ITrafficSystem {
  readonly cars: Car[] = [];
  private host: AIHost;
  private rng = mulberry32(0x7aff1c);
  private density = 0.6;
  private nextId = 1;
  private roads: RoadGraph | null = null;
  private geos: (EdgeGeo | undefined)[] = [];
  private nodeRadius = new Float32Array(0);
  /** cars currently inside each junction (3 slots per node) */
  private occ: (Car | null)[] = [];
  private bodies: BodyInfo[] = [];
  private cols: StaticCollider[] = [];
  private px = 0;
  private pz = 0;
  private frame = 0;

  constructor(host: AIHost) {
    this.host = host;
  }

  setDensity(density: number): void {
    this.density = density < 0 ? 0 : density > 1 ? 1 : density;
  }

  clear(): void {
    this.cars.length = 0;
    for (let i = 0; i < this.occ.length; i++) this.occ[i] = null;
  }

  clearAround(x: number, z: number, radius: number): void {
    const r2 = radius * radius;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const dx = c.x - x;
      const dz = c.z - z;
      if (dx * dx + dz * dz <= r2) this.removeAt(i);
    }
  }

  notifyHit(car: TrafficCar, intensity: number): void {
    const c = car as Car;
    if (c.mode === 'wrecked') return;
    if (intensity < TRAFFIC_TUNING.wreckIntensity) {
      // shaken: brake for a moment, keep whatever forward speed is left
      c.brakeT = 0.9;
      const along = c.vx * Math.sin(c.heading) + c.vz * Math.cos(c.heading);
      if (along < c.speed) c.speed = along > 0 ? along : 0;
      return;
    }
    c.mode = 'wrecked';
    c.wreckT = 0;
    c.stoppedT = 0;
    c.brake = 1;
    this.leaveJunction(c);
  }

  update(dt: number, focusX: number, focusZ: number, focusVx: number, focusVz: number): void {
    if (dt <= 0) return;
    this.syncGraph();
    this.frame++;
    const T = TRAFFIC_TUNING;
    const cam = this.host.getCameraPosition();
    const recycle2 = T.recycleDist * T.recycleDist;
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      const dx = c.x - focusX;
      const dz = c.z - focusZ;
      if (dx * dx + dz * dz > recycle2) {
        this.removeAt(i);
        continue;
      }
      if (c.mode === 'wrecked') {
        if (this.updateWreck(c, dt, cam.x, cam.z)) this.removeAt(i);
      } else {
        this.updateDriving(c, dt);
        if (c.blockedT > 25) {
          // hopeless jam: recycle, but never in view
          const cx = c.x - cam.x;
          const cz = c.z - cam.z;
          if (cx * cx + cz * cz > 150 * 150) this.removeAt(i);
        }
      }
    }
    // population
    const target = Math.round(this.density * T.maxCars);
    if (this.cars.length > target) {
      // density lowered: drop the farthest car
      let far = -1;
      let fd = 0;
      for (let i = 0; i < this.cars.length; i++) {
        const c = this.cars[i];
        const d = (c.x - focusX) * (c.x - focusX) + (c.z - focusZ) * (c.z - focusZ);
        if (d > fd) {
          fd = d;
          far = i;
        }
      }
      if (far >= 0 && fd > 90 * 90) this.removeAt(far);
    } else if (this.cars.length < target) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (this.trySpawn(focusX, focusZ, focusVx, focusVz, cam.x, cam.z)) break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Road graph helpers
  // ---------------------------------------------------------------------------

  private syncGraph(): void {
    const roads = this.host.world.roads;
    if (roads === this.roads && this.nodeRadius.length === roads.nodes.length && this.geos.length === roads.edges.length) return;
    this.roads = roads;
    this.geos = new Array<EdgeGeo | undefined>(roads.edges.length);
    this.nodeRadius = new Float32Array(roads.nodes.length);
    this.occ = new Array<Car | null>(roads.nodes.length * 3).fill(null);
    this.cars.length = 0;
    for (let i = 0; i < roads.nodes.length; i++) {
      const node = roads.nodes[i];
      let w = 0;
      for (let k = 0; k < node.edges.length; k++) {
        const e = roads.edges[node.edges[k]];
        if (e.width > w) w = e.width;
      }
      this.nodeRadius[i] = node.edges.length <= 2 ? 5 : w * 0.5 + 3;
    }
  }

  private geoOf(edge: RoadEdge): EdgeGeo {
    let g = this.geos[edge.id];
    if (g) return g;
    const pts = edge.points;
    const n = pts.length;
    g = { n, x: new Float64Array(n), z: new Float64Array(n), cum: new Float32Array(n), nx: new Float32Array(n), nz: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      g.x[i] = pts[i].x;
      g.z[i] = pts[i].z;
      if (i > 0) g.cum[i] = g.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
    }
    for (let i = 0; i < n; i++) {
      const a = i > 0 ? i - 1 : 0;
      const b = i < n - 1 ? i + 1 : n - 1;
      let dx = g.x[b] - g.x[a];
      let dz = g.z[b] - g.z[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l;
      dz /= l;
      // right of (dx, dz) = (-dz, dx)
      g.nx[i] = -dz;
      g.nz[i] = dx;
    }
    this.geos[edge.id] = g;
    return g;
  }

  /** Lane point at distance t along the edge with a signed lateral offset (+ = right of a -> b). Fills px / pz, returns the segment. */
  private edgePoint(g: EdgeGeo, t: number, lateral: number, seg: number): number {
    const last = g.n - 2;
    if (seg > last) seg = last;
    if (seg < 0) seg = 0;
    while (seg < last && g.cum[seg + 1] < t) seg++;
    while (seg > 0 && g.cum[seg] > t) seg--;
    const l = g.cum[seg + 1] - g.cum[seg];
    const u = l > 1e-6 ? (t - g.cum[seg]) / l : 0;
    const nx = g.nx[seg] + (g.nx[seg + 1] - g.nx[seg]) * u;
    const nz = g.nz[seg] + (g.nz[seg + 1] - g.nz[seg]) * u;
    this.px = g.x[seg] + (g.x[seg + 1] - g.x[seg]) * u + nx * lateral;
    this.pz = g.z[seg] + (g.z[seg + 1] - g.z[seg]) * u + nz * lateral;
    return seg;
  }

  private trim(edge: RoadEdge, node: number): number {
    const r = this.nodeRadius[node];
    const m = edge.length * 0.3;
    return r < m ? r : m;
  }

  private laneOffset(edge: RoadEdge, lane: number): number {
    return (lane + 0.5) * (edge.width / (2 * edge.lanes));
  }

  private leaveJunction(c: Car): void {
    if (c.node < 0) return;
    const base = c.node * 3;
    for (let k = 0; k < 3; k++) if (this.occ[base + k] === c) this.occ[base + k] = null;
    c.node = -1;
  }

  private removeAt(i: number): void {
    const c = this.cars[i];
    this.leaveJunction(c);
    this.cars.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // Route choice
  // ---------------------------------------------------------------------------

  /** Chooses the edge taken after the current one and prepares the turn (speed). */
  private planNext(c: Car): void {
    const roads = this.roads!;
    const nodeId = c.dir > 0 ? c.edge.b : c.edge.a;
    const node = roads.nodes[nodeId];
    const g = c.geo;
    // arrival direction
    const i1 = c.dir > 0 ? g.n - 1 : 0;
    const i0 = c.dir > 0 ? g.n - 2 : 1;
    let ax = g.x[i1] - g.x[i0];
    let az = g.z[i1] - g.z[i0];
    const al = Math.hypot(ax, az) || 1;
    ax /= al;
    az /= al;
    const heavy = c.kind === 'bus' || c.kind === 'truck';
    let best: RoadEdge | null = null;
    let bestDot = -2;
    let total = 0;
    for (let pass = 0; pass < 2 && total === 0; pass++) {
      for (let k = 0; k < node.edges.length; k++) {
        const e = roads.edges[node.edges[k]];
        if (e === c.edge) continue;
        // first pass: avoid ramps (and hill roads for heavy vehicles); second pass: anything else
        if (pass === 0 && (e.kind === 'ramp' || (heavy && e.kind === 'hill'))) continue;
        total++;
        const d = this.outDot(e, nodeId, ax, az);
        if (d > bestDot) {
          bestDot = d;
          best = e;
        }
      }
      if (total > 0) {
        // straight on ≈ 60 % when there is a straight continuation
        let pick = best!;
        if (total > 1 && (bestDot < 0.8 || this.rng() > 0.6)) {
          let idx = Math.floor(this.rng() * (bestDot < 0.8 ? total : total - 1));
          for (let k = 0; k < node.edges.length; k++) {
            const e = roads.edges[node.edges[k]];
            if (e === c.edge) continue;
            if (pass === 0 && (e.kind === 'ramp' || (heavy && e.kind === 'hill'))) continue;
            if (bestDot >= 0.8 && e === best) continue;
            if (idx-- === 0) {
              pick = e;
              break;
            }
          }
        }
        this.setNext(c, pick, nodeId, this.outDot(pick, nodeId, ax, az));
        return;
      }
    }
    // dead end: U-turn on the same edge
    c.next = c.edge;
    c.nextDir = -c.dir;
    c.nextLaneOff = c.laneOff;
    c.turnSpeed = 4;
  }

  private outDot(e: RoadEdge, nodeId: number, ax: number, az: number): number {
    const g = this.geoOf(e);
    const fromA = e.a === nodeId;
    const i0 = fromA ? 0 : g.n - 1;
    const i1 = fromA ? 1 : g.n - 2;
    const dx = g.x[i1] - g.x[i0];
    const dz = g.z[i1] - g.z[i0];
    const l = Math.hypot(dx, dz) || 1;
    return (dx * ax + dz * az) / l;
  }

  private setNext(c: Car, e: RoadEdge, nodeId: number, dot: number): void {
    c.next = e;
    c.nextDir = e.a === nodeId ? 1 : -1;
    const lane = Math.floor(this.rng() * e.lanes);
    c.nextLaneOff = this.laneOffset(e, lane);
    const heavy = c.kind === 'bus' || c.kind === 'truck' ? 0.8 : 1;
    // real turns are taken slowly, shallow bends at (almost) cruising speed
    if (dot > 0.93) c.turnSpeed = 99;
    else if (dot > 0.5) c.turnSpeed = (9 + (dot - 0.5) * 20) * heavy;
    else c.turnSpeed = (dot > -0.5 ? 8.5 : 6) * heavy;
  }

  /** May the car enter the junction now? (another car inside on a conflicting movement => no) */
  private junctionFree(c: Car, nodeId: number): boolean {
    const base = nodeId * 3;
    let slots = 0;
    for (let k = 0; k < 3; k++) {
      const o = this.occ[base + k];
      if (!o) {
        slots++;
        continue;
      }
      if (o === c) continue;
      if (o.prevEdgeId === c.edge.id) continue; // same approach: plain car following
      if (c.next && o.prevEdgeId === c.next.id && o.edge.id === c.edge.id) continue; // mirrored movement
      return false;
    }
    return slots > 0;
  }

  private enterJunction(c: Car, nodeId: number): void {
    const g = c.geo;
    // P0: where we are; direction of arrival
    c.seg = this.edgePoint(g, c.t, c.dir * c.laneOff, c.seg);
    const x0 = this.px;
    const z0 = this.pz;
    let d0x = (g.x[c.seg + 1] - g.x[c.seg]) * c.dir;
    let d0z = (g.z[c.seg + 1] - g.z[c.seg]) * c.dir;
    let l = Math.hypot(d0x, d0z) || 1;
    d0x /= l;
    d0z /= l;
    const e = c.next!;
    const ng = this.geoOf(e);
    const startT = c.nextDir > 0 ? this.trim(e, nodeId) : e.length - this.trim(e, nodeId);
    const seg = this.edgePoint(ng, startT, c.nextDir * c.nextLaneOff, c.nextDir > 0 ? 0 : ng.n - 2);
    const x2 = this.px;
    const z2 = this.pz;
    let d2x = (ng.x[seg + 1] - ng.x[seg]) * c.nextDir;
    let d2z = (ng.z[seg + 1] - ng.z[seg]) * c.nextDir;
    l = Math.hypot(d2x, d2z) || 1;
    d2x /= l;
    d2z /= l;
    // control point: intersection of the two lane lines (midpoint when parallel / degenerate)
    let x1 = (x0 + x2) * 0.5;
    let z1 = (z0 + z2) * 0.5;
    const cross = d0x * d2z - d0z * d2x;
    if (e === c.edge) {
      // U-turn: swing out beyond the node
      const reach = c.laneOff * 2 + 5;
      x1 += d0x * reach;
      z1 += d0z * reach;
    } else if (cross > 0.2 || cross < -0.2) {
      const s = ((x2 - x0) * d2z - (z2 - z0) * d2x) / cross;
      const u = ((x2 - x0) * d0z - (z2 - z0) * d0x) / cross;
      if (s > 0.5 && u < -0.5 && s < 80 && u > -80) {
        x1 = x0 + d0x * s;
        z1 = z0 + d0z * s;
      }
    }
    c.bx0 = x0;
    c.bz0 = z0;
    c.bx1 = x1;
    c.bz1 = z1;
    c.bx2 = x2;
    c.bz2 = z2;
    c.bu = 0;
    c.phase = 1;
    c.prevEdgeId = c.edge.id;
    // from now on the car belongs to the next edge
    c.edge = e;
    c.geo = ng;
    c.dir = c.nextDir;
    c.laneOff = c.nextLaneOff;
    c.t = startT;
    c.seg = seg;
    c.endT = c.dir > 0 ? e.length - this.trim(e, e.b) : this.trim(e, e.a);
    c.node = nodeId;
    const base = nodeId * 3;
    for (let k = 0; k < 3; k++) {
      if (!this.occ[base + k]) {
        this.occ[base + k] = c;
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Driving
  // ---------------------------------------------------------------------------

  private updateDriving(c: Car, dt: number): void {
    const T = TRAFFIC_TUNING;
    const world = this.host.world;
    c.tick++;
    // the collision resolver may have moved us: keep the displacement as a decaying offset
    const ex = c.x - c.lastX;
    const ez = c.z - c.lastZ;
    const eh = c.heading - c.lastH;
    if (ex !== 0 || ez !== 0 || eh !== 0) {
      c.offX += ex;
      c.offZ += ez;
      c.offH += eh;
      if (c.offH > 1) c.offH = 1;
      else if (c.offH < -1) c.offH = -1;
    }

    // --- speed limit from the road, the next turn and the junction
    const limit = (c.edge.speedLimitKmh / 3.6) * c.cruise;
    let vMax = limit;
    let stopDist = 1e9;
    if (c.phase === 0) {
      if (!c.next) this.planNext(c);
      const dist = (c.endT - c.t) * c.dir;
      const nodeId = c.dir > 0 ? c.edge.b : c.edge.a;
      if (c.turnSpeed < vMax) {
        const v = Math.sqrt(c.turnSpeed * c.turnSpeed + 2 * 2.2 * (dist > 0 ? dist : 0));
        if (v < vMax) vMax = v;
      }
      if (dist < 45 && !this.junctionFree(c, nodeId)) stopDist = dist - 1.5;
      else if (dist <= 0.2) this.enterJunction(c, nodeId);
    } else if (c.turnSpeed < vMax) {
      vMax = c.turnSpeed;
    }
    if (c.brakeT > 0) {
      c.brakeT -= dt;
      vMax = 0;
    }

    // --- car following (refreshed every other frame)
    const fx = Math.sin(c.heading);
    const fz = Math.cos(c.heading);
    if (((c.tick + c.id) & 1) === 0) {
      const reach = 12 + c.speed * 2.8;
      const n = this.host.queryBodies(c.x + fx * reach * 0.5, c.z + fz * reach * 0.5, reach * 0.5 + 6, this.bodies);
      const kappa = c.speed > 2 ? -c.yawRate / c.speed : 0;
      let gap = 1e9;
      let lead = 0;
      for (let i = 0; i < n; i++) {
        const b = this.bodies[i];
        if (b.traffic === c) continue;
        const dx = b.x - c.x;
        const dz = b.z - c.z;
        const df = dx * fx + dz * fz;
        if (df <= 0) continue;
        // lateral offset relative to our (curving) lane
        const dl = -dx * fz + dz * fx - kappa * df * df * 0.5;
        let cs = Math.sin(b.heading) * fx + Math.cos(b.heading) * fz;
        if (cs < 0) cs = -cs;
        if (cs > 1) cs = 1;
        const sn = Math.sqrt(1 - cs * cs);
        const extLat = b.halfWidth * cs + b.halfLength * sn;
        if (dl > c.halfWidth + extLat + 0.45 || dl < -(c.halfWidth + extLat + 0.45)) continue;
        const g2 = df - c.halfLength - (b.halfLength * cs + b.halfWidth * sn);
        if (g2 < gap) {
          gap = g2;
          lead = b.vx * fx + b.vz * fz;
        }
      }
      c.leadGap = gap;
      c.leadSpeed = lead;
    } else if (c.leadGap < 1e8) {
      c.leadGap -= (c.speed - c.leadSpeed) * dt;
    }

    // --- acceleration (IDM) limited by the speed targets
    const v = c.speed;
    const aMax = T.accel * (c.mass > 5000 ? 0.6 : 1);
    let acc = aMax * (1 - Math.pow(v / (limit > 1 ? limit : 1), 4));
    let gap = c.leadGap;
    let leadV = c.leadSpeed;
    if (stopDist < gap) {
      gap = stopDist;
      leadV = 0;
    }
    if (gap < 1e8) {
      const dv = v - leadV;
      let sStar = T.minGap + v * T.timeGap + (v * dv) / (2 * Math.sqrt(aMax * T.decel));
      if (sStar < T.minGap) sStar = T.minGap;
      const g = gap > 0.3 ? gap : 0.3;
      acc -= aMax * (sStar / g) * (sStar / g);
    }
    const aLim = (vMax - v) / 0.7;
    if (aLim < acc) acc = aLim;
    if (acc < -8) acc = -8;
    let nv = v + acc * dt;
    if (nv < 0) nv = 0;
    c.speed = nv;
    const wantBrake = acc < -0.7 ? (-acc / 4 > 1 ? 1 : -acc / 4) : nv < 0.3 && (gap < 6 || vMax <= 0.01) ? 0.4 : 0;
    c.brake += (wantBrake - c.brake) * (1 - Math.exp(-dt * 10));
    if (nv < 0.5 && limit > 2) c.blockedT += dt;
    else c.blockedT = 0;

    // --- advance along the path
    let px: number;
    let pz: number;
    let ph: number;
    const step = nv * dt;
    if (c.phase === 1) {
      const ax = c.bx1 - c.bx0;
      const az = c.bz1 - c.bz0;
      const bx = c.bx2 - c.bx1;
      const bz = c.bz2 - c.bz1;
      let u = c.bu;
      let tx = ax + (bx - ax) * u;
      let tz = az + (bz - az) * u;
      const len = 2 * Math.hypot(tx, tz);
      u += step / (len > 0.5 ? len : 0.5);
      if (u >= 1) {
        // out of the junction, onto the next edge
        this.leaveJunction(c);
        c.phase = 0;
        c.next = null;
        c.turnSpeed = 99;
        c.t += (u - 1) * len * c.dir;
        u = 1;
      }
      c.bu = u;
      const w0 = (1 - u) * (1 - u);
      const w1 = 2 * (1 - u) * u;
      const w2 = u * u;
      px = c.bx0 * w0 + c.bx1 * w1 + c.bx2 * w2;
      pz = c.bz0 * w0 + c.bz1 * w1 + c.bz2 * w2;
      tx = ax + (bx - ax) * u;
      tz = az + (bz - az) * u;
      ph = Math.atan2(tx, tz);
    } else {
      c.t += step * c.dir;
      if ((c.endT - c.t) * c.dir < 0) c.t = c.endT;
      const lat = c.dir * c.laneOff;
      c.seg = this.edgePoint(c.geo, c.t, lat, c.seg);
      px = this.px;
      pz = this.pz;
      // heading from a short chord ahead (smooth through polyline vertices)
      let ta = c.t + 3 * c.dir;
      if (ta < 0) ta = 0;
      else if (ta > c.edge.length) ta = c.edge.length;
      if (Math.abs(ta - c.t) > 0.5) {
        this.edgePoint(c.geo, ta, lat, c.seg);
        ph = Math.atan2(this.px - px, this.pz - pz);
      } else {
        const g = c.geo;
        ph = Math.atan2((g.x[c.seg + 1] - g.x[c.seg]) * c.dir, (g.z[c.seg + 1] - g.z[c.seg]) * c.dir);
      }
    }

    // --- pose = path pose + decaying collision offset
    const k = Math.exp(-dt * 1.6);
    c.offX *= k;
    c.offZ *= k;
    c.offH *= k;
    const prevH = c.lastH;
    c.x = px + c.offX;
    c.z = pz + c.offZ;
    c.heading = ph + c.offH;
    let dh = c.heading - prevH;
    if (dh > Math.PI) dh -= Math.PI * 2;
    else if (dh < -Math.PI) dh += Math.PI * 2;
    const yaw = dh / dt;
    c.yawRate += ((yaw > 3 ? 3 : yaw < -3 ? -3 : yaw) - c.yawRate) * (1 - Math.exp(-dt * 12));
    c.vx = Math.sin(c.heading) * nv;
    c.vz = Math.cos(c.heading) * nv;
    // front wheels: turning right (yawRate < 0) => positive angle
    let steer = nv > 1 ? Math.atan((-c.yawRate * c.wheelbase) / nv) : 0;
    if (steer > 0.6) steer = 0.6;
    else if (steer < -0.6) steer = -0.6;
    c.steerAngle += (steer - c.steerAngle) * (1 - Math.exp(-dt * 8));
    c.y = world.getGroundHeight(c.x, c.z);
    if (((c.tick + c.id) & 1) === 1) {
      const hb = c.wheelbase * 0.5;
      const sh = Math.sin(c.heading);
      const ch = Math.cos(c.heading);
      const yf = world.getGroundHeight(c.x + sh * hb, c.z + ch * hb);
      const yr = world.getGroundHeight(c.x - sh * hb, c.z - ch * hb);
      const pitch = Math.atan2(yf - yr, c.wheelbase);
      c.pitch += (pitch - c.pitch) * 0.5;
    }
    c.roll = 0;
    c.lastX = c.x;
    c.lastZ = c.z;
    c.lastH = c.heading;
  }

  /** Sliding wreck. Returns true when the car must be recycled. */
  private updateWreck(c: Car, dt: number, camX: number, camZ: number): boolean {
    const T = TRAFFIC_TUNING;
    const world = this.host.world;
    c.wreckT += dt;
    let sp = Math.hypot(c.vx, c.vz);
    if (sp > 0.25) {
      const ns = sp - T.wreckFriction * dt;
      const k = ns > 0 ? ns / sp : 0;
      c.vx *= k;
      c.vz *= k;
      sp *= k;
    } else {
      c.vx = 0;
      c.vz = 0;
      sp = 0;
    }
    c.yawRate *= Math.exp(-dt * 2.6);
    if (sp === 0 && Math.abs(c.yawRate) < 0.05) c.yawRate = 0;
    c.x += c.vx * dt;
    c.z += c.vz * dt;
    c.heading += c.yawRate * dt;
    // keep the wreck out of walls (simple circle test)
    if (sp > 0) {
      const radius = c.halfWidth + 0.35;
      const n = world.queryColliders(c.x, c.z, radius + 0.5, this.cols);
      for (let i = 0; i < n; i++) {
        const col = this.cols[i];
        if (col.soft || col.yMax < c.y + 0.2 || col.yMin > c.y + 2) continue;
        const pen = circlePenetration(col, c.x, c.z, radius);
        if (pen <= 0) continue;
        c.x += pushOut.nx * pen;
        c.z += pushOut.nz * pen;
        const vn = c.vx * pushOut.nx + c.vz * pushOut.nz;
        if (vn < 0) {
          c.vx -= vn * pushOut.nx * 1.2;
          c.vz -= vn * pushOut.nz * 1.2;
        }
      }
    }
    c.speed = c.vx * Math.sin(c.heading) + c.vz * Math.cos(c.heading);
    c.brake = 1;
    c.steerAngle *= Math.exp(-dt * 3);
    c.y = world.getGroundHeight(c.x, c.z);
    c.pitch *= Math.exp(-dt * 4);
    c.lastX = c.x;
    c.lastZ = c.z;
    c.lastH = c.heading;
    if (sp > 0) {
      c.stoppedT = 0;
      return false;
    }
    c.stoppedT += dt;
    if (c.stoppedT > T.wreckMax) return true;
    if (c.stoppedT > T.wreckStay) {
      const dx = c.x - camX;
      const dz = c.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > 170 * 170 || (d2 > 70 * 70 && !world.lineOfSight(camX, camZ, c.x, c.z))) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Spawning
  // ---------------------------------------------------------------------------

  private trySpawn(fx: number, fz: number, fvx: number, fvz: number, camX: number, camZ: number): boolean {
    const T = TRAFFIC_TUNING;
    const roads = this.roads!;
    const rng = this.rng;
    if (roads.edges.length === 0) return false;
    // random point around the focus, biased ahead of its velocity
    const sp = Math.hypot(fvx, fvz);
    const spread = sp > 5 ? Math.PI * 2 - (Math.PI * 2 - 1.7) * (sp > 40 ? 1 : sp / 40) : Math.PI * 2;
    const ang = (sp > 5 ? Math.atan2(fvx, fvz) : 0) + (rng() - 0.5) * spread;
    const dist = T.spawnMin + 10 + rng() * (T.spawnMax - T.spawnMin - 20);
    const hit = roads.nearestRoad(fx + Math.sin(ang) * dist, fz + Math.cos(ang) * dist, 70);
    if (!hit) return false;
    const e = hit.edge;
    if (e.kind === 'ramp' || e.length < 36) return false;
    // more cars on big roads than on small streets
    const accept = e.kind === 'highway' ? 1 : e.kind === 'avenue' ? 0.9 : e.kind === 'street' ? 0.55 : e.kind === 'industrial' ? 0.5 : 0.35;
    if (rng() > accept) return false;
    const dir = rng() < 0.5 ? 1 : -1;
    const ta = this.trim(e, e.a) + 3;
    const tb = e.length - this.trim(e, e.b) - 3;
    if (tb - ta < 6) return false;
    const t = hit.t < ta ? ta : hit.t > tb ? tb : hit.t;
    const lane = Math.floor(rng() * e.lanes);
    const laneOff = this.laneOffset(e, lane);
    const geo = this.geoOf(e);
    const seg = this.edgePoint(geo, t, dir * laneOff, 0);
    const x = this.px;
    const z = this.pz;
    const d2 = (x - fx) * (x - fx) + (z - fz) * (z - fz);
    if (d2 < T.spawnMin * T.spawnMin || d2 > T.spawnMax * T.spawnMax) return false;
    const c2 = (x - camX) * (x - camX) + (z - camZ) * (z - camZ);
    if (c2 < T.cameraMin * T.cameraMin) return false;
    if (c2 < T.spawnMinVisible * T.spawnMinVisible && this.host.world.lineOfSight(camX, camZ, x, z)) return false;
    if (this.host.queryBodies(x, z, T.bodyClearance, this.bodies) > 0) return false;
    // kind (weighted); no heavy vehicles on hill roads or narrow lanes
    const laneWidth = e.width / (2 * e.lanes);
    const noHeavy = e.kind === 'hill' || laneWidth < 3.1;
    let total = 0;
    for (let i = 0; i < TRAFFIC_KINDS.length; i++) {
      const kd = TRAFFIC_KINDS[i];
      if (noHeavy && (kd === 'bus' || kd === 'truck')) continue;
      total += TRAFFIC_DIMS[kd].weight;
    }
    let pick = rng() * total;
    let kind: TrafficKind = 'sedan';
    for (let i = 0; i < TRAFFIC_KINDS.length; i++) {
      const kd = TRAFFIC_KINDS[i];
      if (noHeavy && (kd === 'bus' || kd === 'truck')) continue;
      pick -= TRAFFIC_DIMS[kd].weight;
      if (pick <= 0) {
        kind = kd;
        break;
      }
    }
    const dims = TRAFFIC_DIMS[kind];
    const heading = Math.atan2((geo.x[seg + 1] - geo.x[seg]) * dir, (geo.z[seg + 1] - geo.z[seg]) * dir);
    const cruise = (0.7 + 0.3 * rng()) * KIND_SPEED[kind];
    const speed = (e.speedLimitKmh / 3.6) * (cruise > 1 ? 1 : cruise) * 0.9;
    const car: Car = {
      id: this.nextId++,
      kind,
      colorIndex: Math.floor(rng() * TRAFFIC_COLOR_COUNT) % TRAFFIC_COLOR_COUNT,
      mode: 'driving',
      x,
      y: this.host.world.getGroundHeight(x, z),
      z,
      heading,
      pitch: 0,
      roll: 0,
      speed,
      vx: Math.sin(heading) * speed,
      vz: Math.cos(heading) * speed,
      yawRate: 0,
      steerAngle: 0,
      brake: 0,
      halfLength: dims.length * 0.5,
      halfWidth: dims.width * 0.5,
      mass: dims.mass,
      phase: 0,
      edge: e,
      geo,
      dir,
      laneOff,
      t,
      seg,
      endT: dir > 0 ? e.length - this.trim(e, e.b) : this.trim(e, e.a),
      next: null,
      nextDir: 1,
      nextLaneOff: laneOff,
      turnSpeed: 99,
      node: -1,
      prevEdgeId: -1,
      bx0: 0,
      bz0: 0,
      bx1: 0,
      bz1: 0,
      bx2: 0,
      bz2: 0,
      bu: 0,
      cruise: cruise > 1 ? 1 : cruise,
      wheelbase: KIND_WHEELBASE[kind],
      offX: 0,
      offZ: 0,
      offH: 0,
      lastX: x,
      lastZ: z,
      lastH: heading,
      brakeT: 0,
      wreckT: 0,
      stoppedT: 0,
      blockedT: 0,
      leadGap: 1e9,
      leadSpeed: 0,
      tick: 0,
    };
    this.cars.push(car);
    return true;
  }
}

export function createTrafficSystem(host: AIHost): ITrafficSystem {
  return new TrafficSystem(host);
}
