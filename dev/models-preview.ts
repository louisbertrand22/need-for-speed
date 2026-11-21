/* Preview harness for the procedural models and effects.
 *   ?view=cars | car | police | traffic | heli | effects | portals | garage
 *   car: &id=kaido&paint=ff6a00&finish=metallic|pearl|matte&kit=0..3&spoiler=0..4&rims=0..5&rimColor=c9ced6
 *        &neon=00e5ff&tint=0..3&nitro=1&brake=1&damage=0.5&lights=0|1&real=1&detail=low&steer=0.3
 *   &cam=34|front|side|rear|top|r34   &dist=7   &scene=garage (car view inside the showroom)
 * window.__ready becomes true once a few frames are rendered; window.__stats lists triangles / draw calls. */
import * as THREE from 'three';
import { createGameRenderer, createPostFx } from '../src/core/renderSetup';
import type { CarModel, CarVisuals, PortalKind, TrafficKind, VehicleVisualState } from '../src/core/types';
import { CAR_CATALOG, getCarSpec } from '../src/game/catalog';
import { createCheckpoint, createParticleSystem, createPortal, createRoadBarrier, createSkidMarks, createSpikeStrip } from '../src/world/effects';
import { createNightEnvironment } from '../src/world/environment';
import { createGarageScene } from '../src/world/garageScene';
import { createCarModel, createHelicopterModel, createPoliceModel, createTrafficModel } from '../src/world/vehicleModels';

const q = new URLSearchParams(location.search);
const view = q.get('view') ?? 'cars';
const num = (k: string, d: number): number => (q.has(k) ? Number(q.get(k)) : d);

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = createGameRenderer(canvas, 'high');
renderer.setPixelRatio(1);
renderer.setSize(window.innerWidth, window.innerHeight, false);
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.2, 800);

let scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060d);
scene.fog = new THREE.FogExp2(0x070812, 0.004);
scene.environment = createNightEnvironment(renderer);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.3, metalness: 0.1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);
scene.add(new THREE.HemisphereLight(0x8fa4d0, 0x101014, 0.3));
for (const [x, z] of [
  [-7, 6],
  [8, -5],
]) {
  const l = new THREE.PointLight(0xffd9a8, 110, 60, 1.6);
  l.position.set(x, 8, z);
  scene.add(l);
}

const stats: { name: string; calls: number; triangles: number }[] = [];
const tmpScene = new THREE.Scene();
const tmpCam = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
tmpCam.position.set(20, 15, 25);
tmpCam.lookAt(0, 1, 0);
function measure(name: string, obj: THREE.Object3D): void {
  tmpScene.add(obj);
  renderer.info.reset();
  renderer.render(tmpScene, tmpCam);
  stats.push({ name, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
  tmpScene.remove(obj);
}

const state = (x: number, z: number, heading: number, extra: Partial<VehicleVisualState> = {}): VehicleVisualState => ({
  x,
  y: 0,
  z,
  heading,
  pitch: 0,
  roll: 0,
  speed: 0,
  steerAngle: 0,
  brake: 0,
  ...extra,
});

const updaters: ((dt: number, t: number) => void)[] = [];
let target = new THREE.Vector3(0, 0.6, 0);
let dist = num('dist', 7.5);

function visualsFromQuery(base: CarVisuals): CarVisuals {
  return {
    ...base,
    paintColor: q.has('paint') ? `#${q.get('paint')}` : base.paintColor,
    paintFinish: (q.get('finish') as CarVisuals['paintFinish']) ?? base.paintFinish,
    rimStyle: num('rims', base.rimStyle),
    rimColor: q.has('rimColor') ? `#${q.get('rimColor')}` : base.rimColor,
    spoiler: num('spoiler', base.spoiler),
    bodyKit: num('kit', base.bodyKit),
    neonColor: q.has('neon') ? `#${q.get('neon')}` : base.neonColor,
    windowTint: num('tint', base.windowTint),
  };
}

if (view === 'cars') {
  CAR_CATALOG.forEach((spec, i) => {
    const v = visualsFromQuery({ ...spec.defaultVisuals, rimStyle: i % 6, spoiler: i % 5, bodyKit: i % 4 });
    const m = createCarModel(spec, v, { detail: (q.get('detail') as 'high' | 'low') ?? 'high' });
    measure(`car:${spec.id}`, m.group);
    scene.add(m.group);
    const s = state((i - 3) * 2.9, 0, num('heading', 0.5), { steerAngle: 0.25, brake: num('brake', 0), nitroActive: q.get('nitro') === '1', damage: num('damage', 0) });
    m.setHeadlights(q.get('lights') !== '0');
    updaters.push((dt) => m.sync(s, dt));
  });
  dist = num('dist', 19);
} else if (view === 'car') {
  const spec = getCarSpec(q.get('id') ?? 'kaido');
  const v = visualsFromQuery(spec.defaultVisuals);
  const m = createCarModel(spec, v, { detail: (q.get('detail') as 'high' | 'low') ?? 'high', realHeadlights: q.get('real') === '1' });
  measure(`car:${spec.id}`, m.group);
  const s = state(0, 0, 0, { steerAngle: num('steer', 0), brake: num('brake', 0), nitroActive: q.get('nitro') === '1', damage: num('damage', 0), gear: q.get('reverse') === '1' ? -1 : 1 });
  m.setHeadlights(q.get('lights') !== '0');
  if (q.get('scene') === 'garage') {
    const g = createGarageScene(renderer);
    g.carAnchor.add(m.group);
    if (v.neonColor) g.setAccentColor(new THREE.Color(v.neonColor).getHex());
    scene = g.scene;
    target = g.orbitTarget.clone();
    updaters.push((dt, t) => g.update(dt, t));
  } else scene.add(m.group);
  updaters.push((dt) => m.sync(s, dt));
  dist = num('dist', 6.4);
} else if (view === 'police') {
  (['patrol', 'interceptor', 'suv'] as const).forEach((kind, i) => {
    const m = createPoliceModel(kind);
    measure(`police:${kind}`, m.group);
    scene.add(m.group);
    m.setSiren(q.get('siren') !== '0');
    const s = state((i - 1) * 3.4, 0, 0.5);
    updaters.push((dt) => m.sync(s, dt));
  });
  dist = num('dist', 12);
} else if (view === 'traffic') {
  const kinds: TrafficKind[] = ['sedan', 'hatch', 'taxi', 'pickup', 'van', 'truck', 'bus'];
  let x = -13;
  kinds.forEach((kind, i) => {
    const m: CarModel = createTrafficModel(kind, i);
    measure(`traffic:${kind}`, m.group);
    scene.add(m.group);
    x += m.width / 2 + 0.9;
    const s = state(x, 0, 0.5, { brake: i % 2 });
    x += m.width / 2 + 0.9;
    updaters.push((dt) => m.sync(s, dt));
  });
  dist = num('dist', 26);
  target.set(-1, 1.2, 0);
} else if (view === 'heli') {
  const h = createHelicopterModel();
  scene.add(h.group);
  const hs = { active: true, x: 0, y: 14, z: 0, heading: 0.6, spotX: 6, spotZ: 5, seesPlayer: true };
  updaters.push((dt, t) => {
    hs.x = Math.sin(t * 0.4) * 2;
    h.sync(hs, dt, () => 0);
  });
  updaters.push(() => {
    if (stats.length === 0) {
      renderer.info.reset();
      const vis = ground.visible;
      ground.visible = false;
      renderer.render(scene, camera);
      ground.visible = vis;
      stats.push({ name: 'helicopter', calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
    }
  });
  dist = num('dist', 34);
  target.set(2, 8, 2);
} else if (view === 'effects') {
  const ps = createParticleSystem();
  const sk = createSkidMarks();
  scene.add(ps.object, sk.object);
  for (let i = 0; i < 60; i++) {
    const a = i * 0.05;
    sk.add(0, -9 + i * 0.33, 0, 4 + Math.sin(a) * 2, 0.24, 0.9);
    sk.add(1, -9 + i * 0.33, 0, 5.5 + Math.sin(a) * 2, 0.24, 0.6);
  }
  let acc = 0;
  updaters.push((dt, t) => {
    acc += dt;
    for (let k = 0; k < 3; k++) {
      ps.tireSmoke(-9, 0, 0, 0, 0, -2, 0.9);
      ps.dust(-6, 0, 0, 0, 0, -2, 0.9);
      ps.engineSmoke(-3, 0.8, 0, 0.9);
      ps.flame(0, 0.5, 0, 0, 0, -6, 0x3aa0ff, 0.35);
    }
    ps.sparks(3, 0.3, 0, 0.3, 0.6, 0, 6, 8);
    if (acc > 0.5) {
      acc = 0;
      ps.debris(6, 0.5, 0, 14, 0x8a6a4a, 1.2);
      ps.splash(9, 0, -1, 1);
      ps.explosion(-1, 0, -9, 1.2);
    }
    ps.update(dt, camera);
    sk.update(dt);
    void t;
  });
  dist = num('dist', 24);
  target.set(0, 1.6, -2);
} else if (view === 'portals') {
  const kinds: PortalKind[] = ['sprint', 'circuit', 'drift', 'drag', 'speedtrap', 'garage'];
  kinds.forEach((kind, i) => {
    const p = createPortal(kind);
    p.group.position.set((i - 3) * 8.5, 0, -6);
    if (i === 1) p.setHighlighted(true);
    scene.add(p.group);
    updaters.push((dt, t) => p.update(dt, t));
  });
  const locked = createPortal('sprint');
  locked.setLocked(true);
  locked.group.position.set(3 * 8.5, 0, -6);
  scene.add(locked.group);
  updaters.push((dt, t) => locked.update(dt, t));
  (['next', 'upcoming', 'finish', 'speedtrap'] as const).forEach((look, i) => {
    const c = createCheckpoint(9);
    c.setLook(look);
    c.group.position.set((i - 1.5) * 12, 0, 8);
    scene.add(c.group);
    updaters.push((dt, t) => c.update(dt, t));
  });
  const spikes = createSpikeStrip(6);
  spikes.position.set(-8, 0, 16);
  const barrier = createRoadBarrier(4);
  barrier.position.set(6, 0, 16);
  scene.add(spikes, barrier);
  dist = num('dist', 56);
  target.set(0, 3, 4);
} else if (view === 'garage') {
  const g = createGarageScene(renderer);
  const spec = getCarSpec(q.get('id') ?? 'raijin');
  const m = createCarModel(spec, visualsFromQuery(spec.defaultVisuals), { detail: 'high' });
  g.carAnchor.add(m.group);
  const s = state(0, 0, 0);
  updaters.push((dt, t) => {
    m.sync(s, dt);
    g.update(dt, t);
  });
  scene = g.scene;
  target = g.orbitTarget.clone();
  dist = num('dist', 7.5);
}

const cam = q.get('cam') ?? '34';
const dirs: Record<string, [number, number, number]> = {
  '34': [0.62, 0.3, 0.72],
  r34: [-0.62, 0.32, -0.72],
  front: [0, 0.14, 1],
  rear: [0, 0.16, -1],
  side: [1, 0.1, 0.02],
  top: [0.01, 1, 0.01],
};
const d = new THREE.Vector3(...(dirs[cam] ?? dirs['34'])).normalize();
camera.position.copy(target).addScaledVector(d, dist);
camera.lookAt(target);

const post = createPostFx(renderer, scene, camera, 'high');
post.setSize(window.innerWidth, window.innerHeight, 1);
let frames = 0;
let last = performance.now();
let time = 0;
const info = document.getElementById('info') as HTMLDivElement;
function frame(): void {
  const now = performance.now();
  const dt = Math.min(0.05, Math.max(0.016, (now - last) / 1000));
  last = now;
  time += dt;
  for (const u of updaters) u(dt, time);
  post.render(dt);
  frames++;
  if (frames === num('frames', 6)) {
    (window as unknown as { __stats: unknown }).__stats = stats;
    (window as unknown as { __ready: boolean }).__ready = true;
    info.textContent = stats.map((s) => `${s.name}: ${s.triangles} tris, ${s.calls} calls`).join('\n');
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
