/* RoadGraph implementation: spatial hash for nearest-road queries, A* with a binary heap. */
import type { RoadEdge, RoadGraph, RoadHit, RoadNode, Vec2 } from '../../core/types';

/** Road edge with the extra data the generator keeps around. */
export interface CityEdge extends RoadEdge {
  /** cumulative arc-length at each point */
  cum: Float32Array;
  /** ring highway only: arc-length along the ring of points[0] (points run clockwise) */
  ringS0?: number;
}

const CELL = 40;
const ORIGIN = -1360;
const DIM = 68; // 68 * 40 = 2720 m

export class CityRoadGraph implements RoadGraph {
  readonly nodes: RoadNode[];
  readonly edges: CityEdge[];

  // flattened segments
  private segEdge: Int32Array;
  private segIndex: Int32Array;
  private segAx: Float32Array;
  private segAz: Float32Array;
  private segBx: Float32Array;
  private segBz: Float32Array;
  // CSR spatial hash of segments
  private cellStart: Int32Array;
  private cellItems: Int32Array;
  // node hash
  private nodeCellStart: Int32Array;
  private nodeCellItems: Int32Array;
  // A* scratch
  private gScore: Float64Array;
  private fScore: Float64Array;
  private cameFrom: Int32Array;
  private visit: Int32Array;
  private closed: Int32Array;
  private heap: Int32Array;
  private heapSize = 0;
  private searchId = 0;
  private maxSpeed = 1;

  constructor(nodes: RoadNode[], edges: CityEdge[]) {
    this.nodes = nodes;
    this.edges = edges;
    let segCount = 0;
    for (const e of edges) segCount += e.points.length - 1;
    this.segEdge = new Int32Array(segCount);
    this.segIndex = new Int32Array(segCount);
    this.segAx = new Float32Array(segCount);
    this.segAz = new Float32Array(segCount);
    this.segBx = new Float32Array(segCount);
    this.segBz = new Float32Array(segCount);
    const counts = new Int32Array(DIM * DIM);
    let s = 0;
    for (const e of edges) {
      if (e.speedLimitKmh > this.maxSpeed) this.maxSpeed = e.speedLimitKmh;
      for (let i = 0; i + 1 < e.points.length; i++, s++) {
        this.segEdge[s] = e.id;
        this.segIndex[s] = i;
        this.segAx[s] = e.points[i].x;
        this.segAz[s] = e.points[i].z;
        this.segBx[s] = e.points[i + 1].x;
        this.segBz[s] = e.points[i + 1].z;
        this.forSegCells(s, (c) => counts[c]++);
      }
    }
    this.cellStart = new Int32Array(DIM * DIM + 1);
    for (let c = 0; c < DIM * DIM; c++) this.cellStart[c + 1] = this.cellStart[c] + counts[c];
    this.cellItems = new Int32Array(this.cellStart[DIM * DIM]);
    counts.fill(0);
    for (let q = 0; q < segCount; q++) {
      this.forSegCells(q, (c) => {
        this.cellItems[this.cellStart[c] + counts[c]++] = q;
      });
    }
    // nodes
    const nCounts = new Int32Array(DIM * DIM);
    for (const n of nodes) nCounts[this.cellOf(n.x, n.z)]++;
    this.nodeCellStart = new Int32Array(DIM * DIM + 1);
    for (let c = 0; c < DIM * DIM; c++) this.nodeCellStart[c + 1] = this.nodeCellStart[c] + nCounts[c];
    this.nodeCellItems = new Int32Array(nodes.length);
    nCounts.fill(0);
    for (const n of nodes) {
      const c = this.cellOf(n.x, n.z);
      this.nodeCellItems[this.nodeCellStart[c] + nCounts[c]++] = n.id;
    }
    const nn = nodes.length;
    this.gScore = new Float64Array(nn);
    this.fScore = new Float64Array(nn);
    this.cameFrom = new Int32Array(nn);
    this.visit = new Int32Array(nn);
    this.closed = new Int32Array(nn);
    this.heap = new Int32Array(nn * 8 + 16);
  }

  private cellCoord(v: number): number {
    const c = Math.floor((v - ORIGIN) / CELL);
    return c < 0 ? 0 : c >= DIM ? DIM - 1 : c;
  }

  private cellOf(x: number, z: number): number {
    return this.cellCoord(z) * DIM + this.cellCoord(x);
  }

  /** Visits every hash cell overlapped by a segment (conservative for diagonals, which are short). */
  private forSegCells(s: number, fn: (cell: number) => void): void {
    const ax = this.segAx[s];
    const az = this.segAz[s];
    const bx = this.segBx[s];
    const bz = this.segBz[s];
    const i0 = this.cellCoord(Math.min(ax, bx));
    const i1 = this.cellCoord(Math.max(ax, bx));
    const j0 = this.cellCoord(Math.min(az, bz));
    const j1 = this.cellCoord(Math.max(az, bz));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * DIM + i);
  }

  nearestNode(x: number, z: number): RoadNode {
    const ci = this.cellCoord(x);
    const cj = this.cellCoord(z);
    let best = -1;
    let bestD2 = Infinity;
    for (let ring = 0; ring < DIM; ring++) {
      // once a candidate is found, one more ring is enough to guarantee optimality
      if (best >= 0) {
        const reach = (ring - 1) * CELL;
        if (reach > 0 && bestD2 <= reach * reach) break;
      }
      const i0 = ci - ring;
      const i1 = ci + ring;
      const j0 = cj - ring;
      const j1 = cj + ring;
      for (let j = j0; j <= j1; j++) {
        if (j < 0 || j >= DIM) continue;
        const edgeRow = j === j0 || j === j1;
        const step = edgeRow ? 1 : Math.max(1, i1 - i0);
        for (let i = i0; i <= i1; i += step) {
          if (i < 0 || i >= DIM) continue;
          const c = j * DIM + i;
          for (let q = this.nodeCellStart[c]; q < this.nodeCellStart[c + 1]; q++) {
            const n = this.nodes[this.nodeCellItems[q]];
            const d2 = (n.x - x) * (n.x - x) + (n.z - z) * (n.z - z);
            if (d2 < bestD2) {
              bestD2 = d2;
              best = n.id;
            }
          }
        }
      }
    }
    return this.nodes[best >= 0 ? best : 0];
  }

  nearestRoad(x: number, z: number, maxDist = 60): RoadHit | null {
    const ci = this.cellCoord(x);
    const cj = this.cellCoord(z);
    const maxRing = Math.min(DIM, Math.ceil(maxDist / CELL) + 1);
    let bestSeg = -1;
    let bestD2 = maxDist * maxDist;
    let bestT = 0;
    for (let ring = 0; ring <= maxRing; ring++) {
      if (bestSeg >= 0) {
        const reach = (ring - 1) * CELL;
        if (reach > 0 && bestD2 <= reach * reach) break;
      }
      const i0 = ci - ring;
      const i1 = ci + ring;
      const j0 = cj - ring;
      const j1 = cj + ring;
      for (let j = j0; j <= j1; j++) {
        if (j < 0 || j >= DIM) continue;
        const edgeRow = j === j0 || j === j1;
        const step = edgeRow ? 1 : Math.max(1, i1 - i0);
        for (let i = i0; i <= i1; i += step) {
          if (i < 0 || i >= DIM) continue;
          const c = j * DIM + i;
          for (let q = this.cellStart[c]; q < this.cellStart[c + 1]; q++) {
            const s = this.cellItems[q];
            const ax = this.segAx[s];
            const az = this.segAz[s];
            const dx = this.segBx[s] - ax;
            const dz = this.segBz[s] - az;
            const l2 = dx * dx + dz * dz;
            let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + dx * t - x;
            const pz = az + dz * t - z;
            const d2 = px * px + pz * pz;
            if (d2 < bestD2) {
              bestD2 = d2;
              bestSeg = s;
              bestT = t;
            }
          }
        }
      }
    }
    if (bestSeg < 0) return null;
    const edge = this.edges[this.segEdge[bestSeg]];
    const i = this.segIndex[bestSeg];
    const ax = this.segAx[bestSeg];
    const az = this.segAz[bestSeg];
    const dx = this.segBx[bestSeg] - ax;
    const dz = this.segBz[bestSeg] - az;
    const len = Math.sqrt(dx * dx + dz * dz) || 1;
    return {
      edge,
      t: edge.cum[i] + len * bestT,
      x: ax + dx * bestT,
      z: az + dz * bestT,
      dist: Math.sqrt(bestD2),
      dirX: dx / len,
      dirZ: dz / len,
    };
  }

  /**
   * Smallest distance from (x, z) to the centre line of any edge except `excludeEdge`,
   * minus that edge's half width (negative = on its carriageway). Searches up to `reach` metres.
   */
  clearance(x: number, z: number, reach: number, excludeEdge = -1): number {
    const i0 = this.cellCoord(x - reach - 14);
    const i1 = this.cellCoord(x + reach + 14);
    const j0 = this.cellCoord(z - reach - 14);
    const j1 = this.cellCoord(z + reach + 14);
    let best = reach;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * DIM + i;
        for (let q = this.cellStart[c]; q < this.cellStart[c + 1]; q++) {
          const s = this.cellItems[q];
          const eid = this.segEdge[s];
          if (eid === excludeEdge) continue;
          const ax = this.segAx[s];
          const az = this.segAz[s];
          const dx = this.segBx[s] - ax;
          const dz = this.segBz[s] - az;
          const l2 = dx * dx + dz * dz;
          let t = l2 > 1e-9 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = ax + dx * t - x;
          const pz = az + dz * t - z;
          const d = Math.sqrt(px * px + pz * pz) - this.edges[eid].width * 0.5;
          if (d < best) best = d;
        }
      }
    }
    return best;
  }

  // --- A* -------------------------------------------------------------------

  private heapPush(node: number): void {
    const heap = this.heap;
    const f = this.fScore;
    let i = this.heapSize++;
    heap[i] = node;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      const tmp = heap[p];
      heap[p] = heap[i];
      heap[i] = tmp;
      i = p;
    }
  }

  private heapPop(): number {
    const heap = this.heap;
    const f = this.fScore;
    const top = heap[0];
    const last = heap[--this.heapSize];
    if (this.heapSize > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.heapSize && f[heap[l]] < f[heap[m]]) m = l;
        if (r < this.heapSize && f[heap[r]] < f[heap[m]]) m = r;
        if (m === i) break;
        const tmp = heap[m];
        heap[m] = heap[i];
        heap[i] = tmp;
        i = m;
      }
    }
    return top;
  }

  findPath(fromNode: number, toNode: number): number[] {
    const nodes = this.nodes;
    if (fromNode < 0 || toNode < 0 || fromNode >= nodes.length || toNode >= nodes.length) return [];
    if (fromNode === toNode) return [fromNode];
    const id = ++this.searchId;
    const goal = nodes[toNode];
    const hScale = 1 / this.maxSpeed;
    this.heapSize = 0;
    this.gScore[fromNode] = 0;
    this.fScore[fromNode] = Math.hypot(nodes[fromNode].x - goal.x, nodes[fromNode].z - goal.z) * hScale;
    this.visit[fromNode] = id;
    this.cameFrom[fromNode] = -1;
    this.heapPush(fromNode);
    while (this.heapSize > 0) {
      const cur = this.heapPop();
      if (this.closed[cur] === id) continue;
      if (cur === toNode) {
        const out: number[] = [];
        for (let n = cur; n >= 0; n = this.cameFrom[n]) out.push(n);
        out.reverse();
        return out;
      }
      this.closed[cur] = id;
      const g = this.gScore[cur];
      const list = nodes[cur].edges;
      for (let q = 0; q < list.length; q++) {
        const e = this.edges[list[q]];
        const nb = e.a === cur ? e.b : e.a;
        if (this.closed[nb] === id) continue;
        const ng = g + e.length / e.speedLimitKmh;
        if (this.visit[nb] !== id || ng < this.gScore[nb]) {
          this.visit[nb] = id;
          this.gScore[nb] = ng;
          this.cameFrom[nb] = cur;
          this.fScore[nb] = ng + Math.hypot(nodes[nb].x - goal.x, nodes[nb].z - goal.z) * hScale;
          if (this.heapSize < this.heap.length) this.heapPush(nb);
        }
      }
    }
    return [];
  }

  edgeBetween(a: number, b: number): RoadEdge | null {
    const na = this.nodes[a];
    if (!na || !this.nodes[b]) return null;
    let best: CityEdge | null = null;
    for (let q = 0; q < na.edges.length; q++) {
      const e = this.edges[na.edges[q]];
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
        if (!best || e.length / e.speedLimitKmh < best.length / best.speedLimitKmh) best = e;
      }
    }
    return best;
  }

  pathPolyline(nodeIds: number[]): Vec2[] {
    const out: Vec2[] = [];
    if (nodeIds.length === 1) {
      const n = this.nodes[nodeIds[0]];
      if (n) out.push({ x: n.x, z: n.z });
      return out;
    }
    for (let i = 0; i + 1 < nodeIds.length; i++) {
      const e = this.edgeBetween(nodeIds[i], nodeIds[i + 1]);
      if (!e) continue;
      const pts = e.points;
      const forward = e.a === nodeIds[i];
      const n = pts.length;
      for (let k = 0; k < n; k++) {
        const p = pts[forward ? k : n - 1 - k];
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < 1e-3 && Math.abs(last.z - p.z) < 1e-3) continue;
        out.push({ x: p.x, z: p.z });
      }
    }
    return out;
  }
}
