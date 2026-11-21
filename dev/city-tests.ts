/* Structural assertions on a generated city (run from the preview: window.__assert()). */
import type { CityWorld, StaticCollider } from '../src/core/types';
import { GARAGE_SPOT, WORLD_HALF } from '../src/core/layout';

function contains(c: StaticCollider, x: number, z: number): boolean {
  if (c.shape === 'circle') return Math.hypot(x - c.x, z - c.z) <= c.r;
  const cs = Math.cos(c.rot);
  const sn = Math.sin(c.rot);
  const rx = x - c.x;
  const rz = z - c.z;
  return Math.abs(rx * cs - rz * sn) <= c.hx && Math.abs(rx * sn + rz * cs) <= c.hz;
}

export function runCityAssertions(world: CityWorld): Record<string, unknown> {
  const fails: string[] = [];
  const roads = world.roads;
  const buf: StaticCollider[] = [];
  const nearRamp = (x: number, z: number) => world.ramps.some((r) => Math.hypot(r.x - x, r.z - z) < r.length / 2 + 6);

  // 1. connectivity
  const seen = new Uint8Array(roads.nodes.length);
  const stack = [0];
  seen[0] = 1;
  let reached = 1;
  while (stack.length) {
    const n = roads.nodes[stack.pop()!];
    for (const eid of n.edges) {
      const e = roads.edges[eid];
      const o = e.a === n.id ? e.b : e.a;
      if (!seen[o]) {
        seen[o] = 1;
        reached++;
        stack.push(o);
      }
    }
  }
  if (reached !== roads.nodes.length) fails.push(`graph not connected: ${reached}/${roads.nodes.length}`);

  // 2. edge endpoints
  for (const e of roads.edges) {
    const a = roads.nodes[e.a];
    const b = roads.nodes[e.b];
    const p0 = e.points[0];
    const p1 = e.points[e.points.length - 1];
    if (Math.hypot(p0.x - a.x, p0.z - a.z) > 0.01 || Math.hypot(p1.x - b.x, p1.z - b.z) > 0.01) fails.push(`edge ${e.id} endpoints mismatch`);
    for (let i = 1; i < e.points.length; i++) {
      const d = Math.hypot(e.points[i].x - e.points[i - 1].x, e.points[i].z - e.points[i - 1].z);
      if (e.kind === 'hill' && d > 20.01) fails.push(`edge ${e.id} spacing ${d.toFixed(1)}`);
    }
  }

  // 3. landmarks
  const landmarks: Record<string, string> = {};
  for (const [id, l] of Object.entries(world.landmarks)) {
    const hit = roads.nearestRoad(l.x, l.z, 30);
    landmarks[id] = `${l.x.toFixed(1)}, ${l.z.toFixed(1)}, ${l.heading.toFixed(3)}`;
    if (!hit || hit.dist > 2) fails.push(`landmark ${id} off road (${hit ? hit.dist.toFixed(1) : 'none'})`);
    else {
      const align = Math.abs(Math.sin(l.heading) * hit.dirX + Math.cos(l.heading) * hit.dirZ);
      const node = roads.nearestNode(l.x, l.z);
      if (align < 0.9 && Math.hypot(node.x - l.x, node.z - l.z) > 1) fails.push(`landmark ${id} heading not along the road (${align.toFixed(2)})`);
    }
  }

  // 4. A*
  const nodeOf = (id: keyof CityWorld['landmarks']) => roads.nearestNode(world.landmarks[id].x, world.landmarks[id].z).id;
  const route = roads.findPath(nodeOf('ringNorth'), nodeOf('ringEast'));
  let hwLen = 0;
  let total = 0;
  for (let i = 0; i + 1 < route.length; i++) {
    const e = roads.edgeBetween(route[i], route[i + 1])!;
    total += e.length;
    if (e.kind === 'highway') hwLen += e.length;
  }
  if (route.length < 2 || hwLen / total < 0.9) fails.push(`ringNorth->ringEast does not follow the highway (${(hwLen / total).toFixed(2)})`);
  const far = roads.findPath(nodeOf('hillsSummit'), nodeOf('docksPier'));
  const farPoly = roads.pathPolyline(far);
  if (far.length < 3 || farPoly.length < far.length) fails.push('summit->pier route broken');
  for (let i = 1; i < farPoly.length; i++) {
    if (Math.hypot(farPoly[i].x - farPoly[i - 1].x, farPoly[i].z - farPoly[i - 1].z) < 1e-3) fails.push('duplicate point in pathPolyline');
  }

  // 5. carriageways: no solid collider, no height step (1 m sampling: 0.35 m would be a real discontinuity)
  let blocked = 0;
  let steps = 0;
  let maxStep = 0;
  const examples: string[] = [];
  for (const e of roads.edges) {
    const hw = e.width / 2 - 0.3;
    const lanes: number[] = [];
    for (let o = -hw; o <= hw + 1e-6; o += (2 * hw) / Math.ceil((2 * hw) / 2)) lanes.push(o);
    const prev = new Float64Array(lanes.length).fill(NaN);
    let acc = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      const a = e.points[i];
      const b = e.points[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const dx = (b.x - a.x) / len;
      const dz = (b.z - a.z) / len;
      for (; acc <= len; acc += 1) {
        for (let k = 0; k < lanes.length; k++) {
          const x = a.x + dx * acc - dz * lanes[k];
          const z = a.z + dz * acc + dx * lanes[k];
          const y = world.getGroundHeight(x, z);
          const ramp = nearRamp(x, z);
          if (!Number.isNaN(prev[k]) && Math.abs(y - prev[k]) > 0.35 && !ramp) {
            steps++;
            maxStep = Math.max(maxStep, Math.abs(y - prev[k]));
            if (examples.length < 8) examples.push(`step ${Math.abs(y - prev[k]).toFixed(2)} @ ${x.toFixed(0)},${z.toFixed(0)} edge ${e.id} ${e.kind}`);
          }
          prev[k] = y;
          const n = world.queryColliders(x, z, 0.3, buf);
          for (let q = 0; q < n; q++) {
            const c = buf[q];
            if (c.soft || !contains(c, x, z) || c.yMax < y + 0.2 || c.yMin > y + 2.5 || ramp) continue;
            blocked++;
            if (examples.length < 8) examples.push(`collider ${c.kind} @ ${x.toFixed(0)},${z.toFixed(0)} edge ${e.id} ${e.kind}`);
          }
        }
      }
      acc -= len;
    }
  }
  if (blocked) fails.push(`${blocked} carriageway samples inside a solid collider`);
  if (steps) fails.push(`${steps} height steps > 0.35 m (max ${maxStep.toFixed(2)})`);

  // 6. ground finite everywhere
  let bad = 0;
  for (let z = -WORLD_HALF; z <= WORLD_HALF; z += 13) {
    for (let x = -WORLD_HALF; x <= WORLD_HALF; x += 13) {
      if (!Number.isFinite(world.getGroundHeight(x, z)) || !world.getSurface(x, z)) bad++;
    }
  }
  if (bad) fails.push(`${bad} non finite ground samples`);

  // 7. ramps reachable: straight run from the nearest road to the ramp entry without solid colliders
  for (const r of world.ramps) {
    const ex = r.x - Math.sin(r.heading) * (r.length / 2 + 2);
    const ez = r.z - Math.cos(r.heading) * (r.length / 2 + 2);
    const hit = roads.nearestRoad(ex, ez, 120);
    if (!hit) {
      fails.push(`ramp ${r.id}: no road within 120 m`);
      continue;
    }
    let ok = true;
    const d = Math.hypot(hit.x - ex, hit.z - ez);
    for (let s = 0; s <= d; s += 1) {
      const x = hit.x + ((ex - hit.x) * s) / (d || 1);
      const z = hit.z + ((ez - hit.z) * s) / (d || 1);
      const y = world.getGroundHeight(x, z);
      const n = world.queryColliders(x, z, 1.2, buf);
      for (let q = 0; q < n; q++) if (!buf[q].soft && buf[q].yMax > y + 0.2 && Math.hypot(buf[q].x - x, buf[q].z - z) < buf[q].r + 1 && contains(buf[q], x, z)) ok = false;
    }
    if (!ok) fails.push(`ramp ${r.id} entry blocked from the road`);
    // landing corridor (80 m) must be free of solid colliders
    let clear = true;
    for (let s = r.length / 2 + 1; s < r.length / 2 + 80; s += 2) {
      const x = r.x + Math.sin(r.heading) * s;
      const z = r.z + Math.cos(r.heading) * s;
      const y = world.getGroundHeight(x, z);
      const n = world.queryColliders(x, z, 1.5, buf);
      for (let q = 0; q < n; q++) if (!buf[q].soft && buf[q].yMax > y + 0.3 && contains(buf[q], x, z)) clear = false;
    }
    if (!clear) fails.push(`ramp ${r.id} landing zone obstructed`);
  }

  // 8. breakers
  for (const b of world.pursuitBreakers) {
    const hit = roads.nearestRoad(b.x, b.z, 40);
    if (!hit || hit.dist > 12) fails.push(`breaker ${b.id} weak point ${hit ? hit.dist.toFixed(1) : '?'} m from the road`);
    const dh = roads.nearestRoad(b.danger.x, b.danger.z, 40);
    if (!dh || dh.dist > b.danger.radius) fails.push(`breaker ${b.id} danger circle misses the road`);
    const n = world.queryColliders(b.x, b.z, 0.5, buf);
    let weak = false;
    for (let q = 0; q < n; q++) if (buf[q].kind === 'breaker' && buf[q].soft && buf[q].refId === b.id) weak = true;
    if (!weak) fails.push(`breaker ${b.id} has no soft weak-point collider`);
  }
  // trigger / reset cycle on the first breaker
  if (world.pursuitBreakers.length) {
    const b = world.pursuitBreakers[0];
    const focus = { x: b.x, y: 2, z: b.z } as never;
    const ok1 = world.triggerBreaker(b.id, 1, 0);
    const ok2 = world.triggerBreaker(b.id, 1, 0);
    let sawDanger = false;
    for (let i = 0; i < 180; i++) {
      world.update(1 / 60, i / 60, focus);
      if (b.dangerActive) sawDanger = true;
    }
    if (!ok1 || ok2 || !sawDanger || b.state !== 'destroyed' || b.dangerActive) fails.push(`breaker cycle wrong (${ok1}, ${ok2}, ${sawDanger}, ${b.state})`);
    world.resetDestructibles();
    if (b.state !== 'intact') fails.push('resetDestructibles did not rebuild the breaker');
  }

  // 9. garage collider + soft props + line of sight
  let garage = false;
  const n = world.queryColliders(GARAGE_SPOT.x, GARAGE_SPOT.z, 30, buf);
  for (let q = 0; q < n; q++) if (buf[q].kind === 'building') garage = true;
  if (!garage) fails.push('no building collider near GARAGE_SPOT');
  if (world.lineOfSight(-75, -75, 75, -225)) fails.push('lineOfSight sees through downtown blocks');
  if (!world.lineOfSight(-400, 0, 400, 0)) fails.push('lineOfSight blocked along the avenue');
  if (!world.isInTunnel(-1100, -100) || world.isInTunnel(-1100, 500)) fails.push('isInTunnel wrong');

  return {
    ok: fails.length === 0,
    fails,
    examples,
    nodes: roads.nodes.length,
    edges: roads.edges.length,
    landmarks,
    ramps: world.ramps.map((r) => `${r.id} ${r.x.toFixed(0)},${r.z.toFixed(0)} h=${r.heading.toFixed(2)}`),
    breakers: world.pursuitBreakers.map((b) => `${b.id} ${b.kind} ${b.x.toFixed(0)},${b.z.toFixed(0)}`),
  };
}
