/* Core (non visual) data of the city: heightfield, road plan, road graph, ground model. */
import type { Vec2 } from '../../core/types';
import { Heightfield, RING_CORE, ringCarveFilter } from './terrain';
import { buildRoadPlan, hillHeights } from './roadPlan';
import type { RoadPlan } from './roadPlan';
import { CityRoadGraph } from './roadGraph';
import type { CityEdge } from './roadGraph';
import { GroundModel } from './ground';

/** Flat pad carved into the hills (villa, lookout, water tower...). */
export interface PadDef {
  x: number;
  z: number;
  radius: number;
  /** pad height: taken from the nearest hill road when omitted */
  h?: number;
}

export interface CityCore {
  seed: number;
  hf: Heightfield;
  plan: RoadPlan;
  graph: CityRoadGraph;
  ground: GroundModel;
  /** resolved pads (h filled) */
  pads: Required<PadDef>[];
}

export function buildCore(seed: number, makePads: (graph: CityRoadGraph) => PadDef[]): CityCore {
  const hf = new Heightfield(seed);
  const plan = buildRoadPlan(hf);
  const graph = new CityRoadGraph(plan.nodes, plan.edges);

  // hill roads flatten the terrain across their width + shoulders
  for (const e of plan.edges) {
    if (e.kind !== 'hill') continue;
    const heights = hillHeights.get(e)!;
    hf.carvePolyline(e.points, heights, e.width / 2 + 2.6);
  }
  // the ring corridor stays at road level (the tunnel stretch becomes a trench)
  for (const e of plan.edges) {
    if (e.kind !== 'highway') continue;
    let run: Vec2[] = [];
    const flush = () => {
      if (run.length > 1) hf.carvePolyline(run, new Float32Array(run.length), RING_CORE, ringCarveFilter);
      run = [];
    };
    for (let i = 0; i < e.points.length; i++) {
      const p = e.points[i];
      const near = p.x < -380 || (i + 1 < e.points.length && e.points[i + 1].x < -380) || (i > 0 && e.points[i - 1].x < -380);
      if (near) run.push(p);
      else flush();
    }
    flush();
  }
  // pads
  const resolved: Required<PadDef>[] = [];
  for (const p of makePads(graph)) {
    let h = p.h;
    if (h === undefined) {
      const hit = graph.nearestRoad(p.x, p.z, 80);
      h = hf.sampleNatural(p.x, p.z);
      if (hit && hit.edge.kind === 'hill') {
        const edge = hit.edge as CityEdge;
        const hh = hillHeights.get(edge)!;
        // height of the road at the closest point
        let i = 0;
        while (i + 2 < edge.points.length && edge.cum[i + 1] < hit.t) i++;
        const span = edge.cum[i + 1] - edge.cum[i] || 1;
        const t = Math.min(1, Math.max(0, (hit.t - edge.cum[i]) / span));
        h = hh[i] + (hh[i + 1] - hh[i]) * t;
      }
    }
    hf.carveDisc(p.x, p.z, p.radius, h);
    resolved.push({ x: p.x, z: p.z, radius: p.radius, h });
  }
  hf.finishCarve();

  const ground = new GroundModel(hf);
  return { seed, hf, plan, graph, ground, pads: resolved };
}
