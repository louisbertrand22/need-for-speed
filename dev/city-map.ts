/* 2D debug plan of the generated city (terrain shading, roads, colliders, ramps, breakers).
 * URL: /dev/city-map.html?cx=0&cz=0&span=2700&size=1300&colliders=1 */
import { generateCity } from '../src/world/cityGenerator';
import type { CityDebug } from '../src/world/cityGenerator';
import type { CityWorld, StaticCollider } from '../src/core/types';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const cx = num('cx', 0);
const cz = num('cz', 0);
const span = num('span', 2700);
const size = num('size', 1300);
const showColliders = num('colliders', 0) > 0;

const t0 = performance.now();
const world = generateCity() as CityWorld & { debug: CityDebug };
const genMs = performance.now() - t0;
const dbg = world.debug;

const canvas = document.getElementById('map') as HTMLCanvasElement;
canvas.width = size;
canvas.height = size;
const g = canvas.getContext('2d')!;
const scale = size / span;
const sx = (x: number) => (x - cx) * scale + size / 2;
const sz = (z: number) => (z - cz) * scale + size / 2;

// terrain / surface raster
const img = g.createImageData(size, size);
for (let py = 0; py < size; py++) {
  for (let px = 0; px < size; px++) {
    const x = cx + (px - size / 2) / scale;
    const z = cz + (py - size / 2) / scale;
    const h = world.getGroundHeight(x, z);
    const hx = world.getGroundHeight(x + 2, z) - h;
    const hz = world.getGroundHeight(x, z + 2) - h;
    const shade = Math.max(0.25, Math.min(1.6, 1 - hx * 0.9 - hz * 0.5));
    const surf = world.getSurface(x, z);
    let r = 18;
    let gg = 20;
    let b = 26;
    if (surf === 'water') {
      r = 8;
      gg = 24;
      b = 52;
    } else if (surf === 'grass') {
      r = 20 + h * 0.9;
      gg = 46 + h * 1.1;
      b = 26 + h * 0.5;
    } else if (surf === 'dirt') {
      r = 44 + h * 0.8;
      gg = 38 + h * 0.7;
      b = 30 + h * 0.5;
    } else if (surf === 'concrete') {
      r = 44;
      gg = 46;
      b = 52;
    } else if (surf === 'asphalt') {
      r = 26;
      gg = 26;
      b = 30;
    }
    // contour lines every 10 m
    const contour = h > 1 && Math.abs((h % 10) - 5) > 4.8 ? 0.6 : 1;
    const k = (py * size + px) * 4;
    img.data[k] = Math.min(255, r * shade * contour);
    img.data[k + 1] = Math.min(255, gg * shade * contour);
    img.data[k + 2] = Math.min(255, b * shade * contour);
    img.data[k + 3] = 255;
  }
}
g.putImageData(img, 0, 0);

// roads
const kindColor: Record<string, string> = {
  street: '#8a8f9c',
  avenue: '#d8dce8',
  highway: '#b48cff',
  hill: '#7dff6a',
  industrial: '#ffb020',
  ramp: '#ff00ff',
};
g.lineCap = 'round';
g.lineJoin = 'round';
for (const e of world.roads.edges) {
  g.strokeStyle = kindColor[e.kind];
  g.globalAlpha = 0.55;
  g.lineWidth = Math.max(1, e.width * scale);
  g.beginPath();
  e.points.forEach((p, i) => (i ? g.lineTo(sx(p.x), sz(p.z)) : g.moveTo(sx(p.x), sz(p.z))));
  g.stroke();
}
g.globalAlpha = 1;
g.fillStyle = '#fff';
for (const n of world.roads.nodes) g.fillRect(sx(n.x) - 1, sz(n.z) - 1, 2, 2);

// colliders
if (showColliders) {
  const drawCollider = (c: StaticCollider) => {
    g.strokeStyle = c.soft ? '#ff0' : c.kind === 'building' ? '#4cf' : c.kind === 'wall' ? '#f84' : c.kind === 'barrier' ? '#f4f' : c.kind === 'breaker' ? '#f00' : '#6f6';
    g.lineWidth = 1;
    g.beginPath();
    if (c.shape === 'circle') {
      g.arc(sx(c.x), sz(c.z), Math.max(1, c.r * scale), 0, Math.PI * 2);
    } else {
      const cs = Math.cos(c.rot);
      const sn = Math.sin(c.rot);
      const pts = [
        [-c.hx, -c.hz],
        [c.hx, -c.hz],
        [c.hx, c.hz],
        [-c.hx, c.hz],
      ].map(([lx, lz]) => [c.x + lx * cs + lz * sn, c.z - lx * sn + lz * cs]);
      pts.forEach(([x, z], i) => (i ? g.lineTo(sx(x), sz(z)) : g.moveTo(sx(x), sz(z))));
      g.closePath();
    }
    g.stroke();
  };
  for (const c of dbg.allColliders()) drawCollider(c);
}

// ramps / breakers / landmarks
g.font = '11px monospace';
for (const r of world.ramps) {
  g.strokeStyle = '#ffd000';
  g.lineWidth = 2;
  const fx = Math.sin(r.heading);
  const fz = Math.cos(r.heading);
  g.beginPath();
  g.moveTo(sx(r.x - (fx * r.length) / 2), sz(r.z - (fz * r.length) / 2));
  g.lineTo(sx(r.x + (fx * r.length) / 2 + fx * 30), sz(r.z + (fz * r.length) / 2 + fz * 30));
  g.stroke();
  g.fillStyle = '#ffd000';
  g.fillText(r.id, sx(r.x) + 4, sz(r.z) - 4);
}
for (const b of world.pursuitBreakers) {
  g.strokeStyle = '#ff5a3c';
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(sx(b.danger.x), sz(b.danger.z), b.danger.radius * scale, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#ff5a3c';
  g.fillRect(sx(b.x) - 2, sz(b.z) - 2, 4, 4);
  g.fillText(b.id, sx(b.x) + 4, sz(b.z) + 12);
}
for (const [id, l] of Object.entries(world.landmarks)) {
  g.fillStyle = '#22e3ff';
  g.beginPath();
  g.arc(sx(l.x), sz(l.z), 3, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#22e3ff';
  g.beginPath();
  g.moveTo(sx(l.x), sz(l.z));
  g.lineTo(sx(l.x + Math.sin(l.heading) * 25), sz(l.z + Math.cos(l.heading) * 25));
  g.stroke();
  g.fillText(id, sx(l.x) + 5, sz(l.z) - 5);
}

document.getElementById('info')!.textContent = `gen ${genMs.toFixed(0)} ms  nodes ${world.roads.nodes.length}  edges ${world.roads.edges.length}`;

/** Per hill edge: length, min radius, max gradient, max cut / fill against the natural terrain. */
function hillStats() {
  const out: Record<string, number | string>[] = [];
  for (const e of world.roads.edges) {
    if (e.kind !== 'hill') continue;
    let minR = Infinity;
    let maxGrade = 0;
    let maxCut = 0;
    let maxFill = 0;
    let hMax = 0;
    const pts = e.points;
    for (let i = 2; i + 2 < pts.length; i++) {
      const a = pts[i - 2];
      const b = pts[i];
      const c = pts[i + 2];
      const ab = Math.hypot(b.x - a.x, b.z - a.z);
      const bc = Math.hypot(c.x - b.x, c.z - b.z);
      const ca = Math.hypot(a.x - c.x, a.z - c.z);
      const area = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)) / 2;
      if (area > 1e-6) minR = Math.min(minR, (ab * bc * ca) / (4 * area));
    }
    for (let i = 0; i + 1 < pts.length; i++) {
      const h0 = world.getGroundHeight(pts[i].x, pts[i].z);
      const h1 = world.getGroundHeight(pts[i + 1].x, pts[i + 1].z);
      const ds = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      if (ds > 0.5) maxGrade = Math.max(maxGrade, Math.abs(h1 - h0) / ds);
      const nat = dbg.naturalHeight(pts[i].x, pts[i].z);
      maxCut = Math.max(maxCut, nat - h0);
      maxFill = Math.max(maxFill, h0 - nat);
      hMax = Math.max(hMax, h0);
    }
    const na = world.roads.nodes[e.a];
    const nb = world.roads.nodes[e.b];
    out.push({
      id: e.id,
      from: `${na.x},${na.z}`,
      to: `${nb.x},${nb.z}`,
      length: Math.round(e.length),
      minR: Math.round(minR * 10) / 10,
      maxGradePct: Math.round(maxGrade * 1000) / 10,
      maxCut: Math.round(maxCut * 10) / 10,
      maxFill: Math.round(maxFill * 10) / 10,
      hMax: Math.round(hMax * 10) / 10,
    });
  }
  return out;
}

Object.assign(window, { __city: world, __hillStats: hillStats, __ready: true });
