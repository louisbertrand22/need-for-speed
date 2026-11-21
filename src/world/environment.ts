/* Night-city environment map (PMREM): dark blue-violet sky, a low band of blurred
 * city lights and a soft moon — gives wet asphalt and car paint colourful reflections. */
import * as THREE from 'three';
import { mulberry32 } from '../core/math';

export function createNightEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const scene = new THREE.Scene();
  const disposables: { dispose(): void }[] = [];

  // sky dome with a vertical gradient (vertex colours)
  const sky = new THREE.SphereGeometry(50, 32, 16);
  const pos = sky.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const zenith = new THREE.Color(0.012, 0.014, 0.04);
  const horizon = new THREE.Color(0.07, 0.045, 0.11);
  const ground = new THREE.Color(0.012, 0.012, 0.016);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 50;
    if (h >= 0) c.copy(horizon).lerp(zenith, Math.pow(h, 0.45));
    else c.copy(horizon).multiplyScalar(0.6).lerp(ground, Math.min(1, -h * 6));
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  sky.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const skyMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
  scene.add(new THREE.Mesh(sky, skyMat));
  disposables.push(sky, skyMat);

  // city lights: emissive panels on a ring near the horizon
  const rng = mulberry32(20261121);
  const palette = [
    [0.1, 0.9, 1.0],
    [1.0, 0.15, 0.75],
    [1.0, 0.62, 0.15],
    [1.0, 0.95, 0.85],
    [0.55, 0.3, 1.0],
  ];
  const panel = new THREE.PlaneGeometry(1, 1);
  disposables.push(panel);
  for (let i = 0; i < 46; i++) {
    const az = rng() * Math.PI * 2;
    const elev = -0.02 + rng() * rng() * 0.3;
    const p = palette[Math.floor(rng() * palette.length)];
    const power = 1.5 + rng() * 6;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(p[0] * power, p[1] * power, p[2] * power), side: THREE.DoubleSide });
    disposables.push(mat);
    const m = new THREE.Mesh(panel, mat);
    const r = 40;
    m.position.set(Math.sin(az) * r * Math.cos(elev), Math.sin(elev) * r, Math.cos(az) * r * Math.cos(elev));
    m.lookAt(0, 0, 0);
    m.scale.set(0.8 + rng() * 4.5, 0.5 + rng() * 2.6, 1);
    scene.add(m);
  }
  // a few overhead "street lamp" spots so that horizontal surfaces catch highlights
  for (let i = 0; i < 6; i++) {
    const az = (i / 6) * Math.PI * 2 + 0.4;
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(7, 5.2, 3.2), side: THREE.DoubleSide });
    disposables.push(mat);
    const m = new THREE.Mesh(panel, mat);
    m.position.set(Math.sin(az) * 22, 30, Math.cos(az) * 22);
    m.lookAt(0, 0, 0);
    m.scale.set(2.2, 2.2, 1);
    scene.add(m);
  }
  // moon
  const moonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.4, 3.0), side: THREE.DoubleSide });
  const moon = new THREE.Mesh(new THREE.CircleGeometry(3.2, 24), moonMat);
  moon.position.set(-22, 30, -26);
  moon.lookAt(0, 0, 0);
  scene.add(moon);
  disposables.push(moon.geometry, moonMat);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  for (const d of disposables) d.dispose();
  const tex = target.texture;
  tex.name = 'apex-night-environment';
  // let the owner free the render target together with the texture
  tex.addEventListener('dispose', () => target.dispose());
  return tex;
}
