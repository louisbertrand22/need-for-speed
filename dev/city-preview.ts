/* 3D preview of the generated city.
 * URL: /dev/city-preview.html?x=&y=&z=&tx=&ty=&tz=&fov=&quality=high|medium|low
 * Console: __city (the CityWorld), __stats(), __assert(), __cam(x, y, z, tx, ty, tz). */
import * as THREE from 'three';
import { createGameRenderer, createPostFx, pixelRatioFor } from '../src/core/renderSetup';
import type { RenderQuality } from '../src/core/renderSetup';
import { generateCity } from '../src/world/cityGenerator';
import type { CityDebug } from '../src/world/cityGenerator';
import type { CityWorld } from '../src/core/types';
import { runCityAssertions } from './city-tests';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);
const quality = (params.get('quality') ?? 'high') as RenderQuality;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const renderer = createGameRenderer(canvas, quality);
renderer.setSize(window.innerWidth, window.innerHeight, false);

const t0 = performance.now();
const world = generateCity() as CityWorld & { debug: CityDebug };
const genMs = performance.now() - t0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(world.fogColor);
scene.fog = new THREE.FogExp2(world.fogColor, world.fogDensity);
scene.add(world.group);

// stand-in night environment: a dark room with a few emissive coloured panels
{
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color(0x05060c);
  const panel = (color: number, x: number, y: number, z: number, w: number, h: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    envScene.add(m);
  };
  panel(0x2040ff, 0, 30, 0, 60, 60);
  panel(0xff3090, 40, 6, 0, 30, 10);
  panel(0x20d0ff, -40, 8, 10, 30, 12);
  panel(0xffa030, 0, 5, 40, 40, 8);
  panel(0xb080ff, 10, 7, -40, 30, 10);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

const camera = new THREE.PerspectiveCamera(num('fov', 62), window.innerWidth / window.innerHeight, 0.25, 2600);
const target = new THREE.Vector3();
function setCam(x: number, y: number, z: number, tx: number, ty: number, tz: number): void {
  camera.position.set(x, y, z);
  target.set(tx, ty, tz);
  camera.lookAt(target);
}
setCam(num('x', 60), num('y', 3), num('z', 150), num('tx', 200), num('ty', 6), num('tz', 150));

const post = quality === 'low' ? null : createPostFx(renderer, scene, camera, quality);
post?.setSize(window.innerWidth, window.innerHeight, pixelRatioFor(quality));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  post?.setSize(window.innerWidth, window.innerHeight, pixelRatioFor(quality));
});

const clock = new THREE.Clock();
let time = 0;
let frames = 0;
let updateMs = 0;
let lastInfo = { calls: 0, triangles: 0 };
renderer.info.autoReset = false;
function frame(): void {
  const dt = Math.min(0.1, clock.getDelta());
  time += dt;
  const u0 = performance.now();
  world.update(dt, time, camera.position);
  updateMs = updateMs * 0.9 + (performance.now() - u0) * 0.1;
  renderer.info.reset();
  if (post) post.render(dt);
  else renderer.render(scene, camera);
  lastInfo = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles };
  frames++;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

Object.assign(window, {
  __city: world,
  __cam: setCam,
  __frames: () => frames,
  __stats: () => ({
    generationMs: Math.round(genMs),
    timings: world.debug.timings,
    calls: lastInfo.calls,
    triangles: lastInfo.triangles,
    geometries: renderer.info.memory.geometries,
    textures: renderer.info.memory.textures,
    updateMs: Math.round(updateMs * 1000) / 1000,
    tiles: world.debug.tileCount,
    props: world.debug.propCount,
    lamps: world.debug.lampCount,
    nodes: world.roads.nodes.length,
    edges: world.roads.edges.length,
    roadKm: Math.round(world.roads.edges.reduce((s, e) => s + e.length, 0)) / 1000,
  }),
  __assert: () => runCityAssertions(world),
  __ready: true,
});
