/* =============================================================================
 * APEX NOCTURNE — garage / showroom scene. Stand-alone THREE.Scene with its own
 * lighting (6 real lights) and its own studio environment map (bright strip
 * lights) so that metallic and pearl paints pop. Floor at y = 0.
 * ===========================================================================*/
import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { GarageScene } from '../core/types';
import { GeoBuilder, trs } from './models/geo';
import { canvasTexture, FONTS } from './models/textures';

const ROOM = 13; // half size (the orbit camera stays within 9 m)
const HEIGHT = 6.4;

const FLOOR_MIRROR_SHADER = {
  name: 'ApexGarageFloor',
  uniforms: {
    color: { value: null },
    tDiffuse: { value: null },
    textureMatrix: { value: null },
  },
  vertexShader: /* glsl */ `
    uniform mat4 textureMatrix;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vUv = textureMatrix * vec4(position, 1.0);
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorld = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 color;
    uniform sampler2D tDiffuse;
    varying vec4 vUv;
    varying vec3 vWorld;
    void main() {
      vec3 base = texture2DProj(tDiffuse, vUv).rgb;
      vec3 v = normalize(cameraPosition - vWorld);
      float fres = 0.16 + 0.84 * pow(1.0 - clamp(v.y, 0.0, 1.0), 3.0);
      float fade = 1.0 - smoothstep(7.0, 12.5, length(vWorld.xz));
      gl_FragColor = vec4(min(base, vec3(2.2)) * color * fres * fade, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

function createStudioEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const studio = new THREE.Scene();
  const trash: { dispose(): void }[] = [];
  const add = (geo: THREE.BufferGeometry, color: THREE.Color, x: number, y: number, z: number, rx = 0, ry = 0): void => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    studio.add(m);
    trash.push(geo, mat);
  };
  add(new THREE.BoxGeometry(40, 20, 40), new THREE.Color(0.012, 0.013, 0.017), 0, 6, 0);
  // overhead strips (run along Z = along the car)
  for (const x of [-5.5, -2, 2, 5.5]) add(new THREE.PlaneGeometry(0.9, 26), new THREE.Color(6, 6.2, 6.8), x, 9, 0, Math.PI / 2);
  for (const z of [-9, 9]) add(new THREE.PlaneGeometry(14, 0.8), new THREE.Color(4.2, 4.2, 4.8), 0, 9, z, Math.PI / 2);
  // side soft boxes + warm / cool accents near the horizon
  add(new THREE.PlaneGeometry(10, 3.5), new THREE.Color(1.1, 1.15, 1.3), -15, 3.5, 0, 0, Math.PI / 2);
  add(new THREE.PlaneGeometry(10, 3.5), new THREE.Color(1.1, 1.15, 1.3), 15, 3.5, 0, 0, Math.PI / 2);
  add(new THREE.PlaneGeometry(8, 1.2), new THREE.Color(1.6, 0.5, 1.2), 0, 1.6, -18);
  add(new THREE.PlaneGeometry(8, 1.2), new THREE.Color(0.3, 1.2, 1.6), 0, 1.6, 18);
  // floor bounce
  add(new THREE.PlaneGeometry(40, 40), new THREE.Color(0.03, 0.03, 0.035), 0, -1, 0, Math.PI / 2);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromScene(studio, 0.02);
  pmrem.dispose();
  for (const t of trash) t.dispose();
  return target;
}

function neonSign(text: string, w: number, h: number, weight = '900', italic = true): THREE.CanvasTexture {
  return canvasTexture(1024, Math.round((1024 * h) / w), (ctx, cw, ch) => {
    ctx.clearRect(0, 0, cw, ch);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = ch * 0.62;
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${FONTS.display}`;
    const tw = ctx.measureText(text).width;
    if (tw > cw * 0.9) size *= (cw * 0.9) / tw;
    ctx.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${FONTS.display}`;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = ch * 0.16;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(text, cw / 2, ch / 2);
    ctx.shadowBlur = ch * 0.05;
    ctx.lineWidth = Math.max(3, size * 0.045);
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(text, cw / 2, ch / 2);
  });
}

export function createGarageScene(renderer: THREE.WebGLRenderer): GarageScene {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030405);
  scene.fog = new THREE.FogExp2(0x05060a, 0.016);
  const envTarget = createStudioEnvironment(renderer);
  scene.environment = envTarget.texture;

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const texs: THREE.Texture[] = [];
  const accentMats: { mat: THREE.MeshBasicMaterial; gain: number }[] = [];
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh => {
    geos.push(geo);
    if (!mats.includes(mat)) mats.push(mat);
    const m = new THREE.Mesh(geo, mat);
    scene.add(m);
    return m;
  };

  // --- floor: lit dark epoxy + additive planar reflection --------------------------------------------
  const floorTex = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#6a6d73';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 2600; i++) {
        const v = 90 + Math.floor(Math.random() * 60);
        ctx.fillStyle = `rgba(${v},${v},${v + 6},0.35)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      ctx.strokeStyle = 'rgba(20,20,24,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(0, 0, w, h);
    },
    { repeat: true },
  );
  floorTex.repeat.set(ROOM / 2, ROOM / 2);
  texs.push(floorTex);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x15171b, map: floorTex, roughness: 0.32, metalness: 0.25, envMapIntensity: 0.35 });
  const floorGeo = new THREE.PlaneGeometry(ROOM * 2, ROOM * 2);
  floorGeo.rotateX(-Math.PI / 2);
  mesh(floorGeo, floorMat);
  const mirrorGeo = new THREE.PlaneGeometry(ROOM * 2, ROOM * 2);
  geos.push(mirrorGeo);
  const mirror = new Reflector(mirrorGeo, { color: 0x6a7080, textureWidth: 1024, textureHeight: 1024, clipBias: 0.002, shader: FLOOR_MIRROR_SHADER, multisample: 2 });
  mirror.rotation.x = -Math.PI / 2;
  mirror.position.y = 0.003;
  const mirrorMat = mirror.material as THREE.ShaderMaterial;
  mirrorMat.transparent = true;
  mirrorMat.blending = THREE.AdditiveBlending;
  mirrorMat.depthWrite = false;
  mirror.renderOrder = -5;
  scene.add(mirror);

  // --- turntable trim --------------------------------------------------------------------------------------
  const metal = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.28, metalness: 1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.6, metalness: 0.4 });
  const ringGeo = new THREE.RingGeometry(3.12, 3.26, 96);
  ringGeo.rotateX(-Math.PI / 2);
  mesh(ringGeo, metal).position.y = 0.008;
  const ledMat = new THREE.MeshBasicMaterial({ fog: false });
  accentMats.push({ mat: ledMat, gain: 1.6 });
  const ledGeo = new THREE.RingGeometry(3.3, 3.345, 96);
  ledGeo.rotateX(-Math.PI / 2);
  mesh(ledGeo, ledMat).position.y = 0.009;
  const tickB = new GeoBuilder();
  for (let k = 0; k < 48; k++) tickB.addGeometry(new THREE.PlaneGeometry(0.03, k % 4 === 0 ? 0.3 : 0.14), trs(0, 0.008, 0, 0, (k / 48) * Math.PI * 2, 0).multiply(trs(0, 0, 3.6, -Math.PI / 2, 0, 0)));
  mesh(tickB.build({ mat: false, uv: false, color: false }), metal);

  // --- walls, ceiling ------------------------------------------------------------------------------------------
  const wallTex = canvasTexture(
    512,
    512,
    (ctx, w, h) => {
      ctx.fillStyle = '#9a9da3';
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 1800; i++) {
        const v = 120 + Math.floor(Math.random() * 60);
        ctx.fillStyle = `rgba(${v},${v},${v},0.25)`;
        ctx.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 5, 1 + Math.random() * 2);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, w, 5);
      ctx.fillRect(0, 0, 5, h);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, h * 0.72, w, 4);
    },
    { repeat: true },
  );
  wallTex.repeat.set(ROOM / 1.5, HEIGHT / 3.2);
  texs.push(wallTex);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x23262c, map: wallTex, roughness: 0.85, metalness: 0.05, envMapIntensity: 0.25 });
  const wallGeo = new THREE.PlaneGeometry(ROOM * 2, HEIGHT);
  geos.push(wallGeo);
  mats.push(wallMat);
  for (let k = 0; k < 4; k++) {
    const w = new THREE.Mesh(wallGeo, wallMat);
    const a = (k / 4) * Math.PI * 2;
    w.position.set(Math.sin(a) * -ROOM, HEIGHT / 2, Math.cos(a) * -ROOM);
    w.rotation.y = a;
    scene.add(w);
  }
  const ceilGeo = new THREE.PlaneGeometry(ROOM * 2, ROOM * 2);
  ceilGeo.rotateX(Math.PI / 2);
  mesh(ceilGeo, dark).position.y = HEIGHT;

  // --- light bars & soft boxes (emissive geometry) ------------------------------------------------------------------
  const barMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.3, 2.4, 2.7), fog: false });
  const softMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.62, 0.66, 0.75), fog: false });
  const lb = new GeoBuilder();
  const hb = new GeoBuilder();
  for (const x of [-4.6, -1.7, 1.7, 4.6]) {
    lb.box(x, HEIGHT - 0.95, 0, 0.22, 0.05, 12);
    hb.box(x, HEIGHT - 0.87, 0, 0.36, 0.12, 12.2);
    for (const z of [-5.5, 0, 5.5]) hb.box(x, HEIGHT - 0.45, z, 0.03, 0.8, 0.03);
  }
  for (const z of [-7.6, 7.6]) {
    lb.box(0, HEIGHT - 0.95, z, 7, 0.05, 0.22);
    hb.box(0, HEIGHT - 0.87, z, 7.2, 0.12, 0.36);
  }
  mesh(lb.build({ mat: false, uv: false, color: false }), barMat);
  mesh(hb.build({ mat: false, uv: false, color: false }), dark);
  const sb = new GeoBuilder();
  for (const sx of [-1, 1]) sb.addGeometry(new THREE.PlaneGeometry(6, 2.2), trs(sx * (ROOM - 0.3), 3.3, 1.5, 0, -sx * Math.PI / 2, 0));
  mesh(sb.build({ mat: false, uv: false, color: false }), softMat);

  // --- workshop furniture: tool chests, tyre racks, roller door, bench ---------------------------------------------------
  const furn = new GeoBuilder();
  const chest = (x: number, z: number, ry: number, color: number): void => {
    furn.setTransform(trs(x, 0, z, 0, ry, 0));
    furn.color(color);
    furn.box(0, 0.62, 0, 1.3, 1.0, 0.6);
    furn.box(0, 1.5, 0, 1.2, 0.7, 0.52);
    furn.color(0x15161a);
    for (let i = 0; i < 5; i++) furn.box(0, 0.24 + i * 0.19, 0.305, 1.2, 0.02, 0.02);
    for (let i = 0; i < 3; i++) furn.box(0, 1.28 + i * 0.2, 0.265, 1.1, 0.02, 0.02);
    furn.color(0xb9bcc2);
    for (let i = 0; i < 5; i++) furn.box(0, 0.33 + i * 0.19, 0.31, 0.5, 0.025, 0.025);
    furn.color(0x0b0b0d);
    for (const wx of [-0.55, 0.55]) furn.box(wx, 0.06, 0, 0.1, 0.12, 0.5);
  };
  chest(-8.5, -ROOM + 0.6, 0, 0xa3151a);
  chest(-6.9, -ROOM + 0.6, 0, 0xa3151a);
  chest(ROOM - 0.6, -5.5, -Math.PI / 2, 0x1a3f9a);
  chest(-ROOM + 0.6, 6.5, Math.PI / 2, 0xa3151a);
  // work bench
  furn.setTransform(trs(8, 0, -ROOM + 0.7, 0, 0, 0));
  furn.color(0x3a2d22);
  furn.box(0, 0.92, 0, 3.4, 0.08, 0.8);
  furn.color(0x15161a);
  for (const wx of [-1.6, 1.6]) for (const wz of [-0.32, 0.32]) furn.box(wx, 0.45, wz, 0.08, 0.9, 0.08);
  furn.box(0, 0.3, 0, 3.2, 0.04, 0.7);
  furn.color(0x8a8d92);
  furn.box(-0.9, 1.06, 0, 0.5, 0.2, 0.3);
  furn.box(0.7, 1.0, 0.1, 0.3, 0.08, 0.4);
  // tyre racks
  const rack = (x: number, z: number, ry: number): void => {
    furn.setTransform(trs(x, 0, z, 0, ry, 0));
    furn.color(0x1a1c20);
    for (const sx of [-1.25, 1.25]) furn.box(sx, 1.3, 0, 0.07, 2.6, 0.5);
    for (const y of [0.5, 1.4, 2.3]) furn.box(0, y - 0.36, 0, 2.5, 0.05, 0.5);
    furn.color(0x070708);
    for (const y of [0.5, 1.4, 2.3])
      for (let i = 0; i < 4; i++) furn.addGeometry(new THREE.TorusGeometry(0.24, 0.115, 8, 16), trs(-0.9 + i * 0.6, y, 0, 0, 0.2, 0));
  };
  rack(-ROOM + 0.5, -4.5, Math.PI / 2);
  rack(ROOM - 0.5, 4.8, -Math.PI / 2);
  // roller door (ribbed) on the back wall + frame
  furn.setTransform(trs(1.5, 0, -ROOM + 0.08, 0, 0, 0));
  furn.color(0x2b2e34);
  for (let i = 0; i < 22; i++) furn.box(0, 0.1 + i * 0.2, i % 2 ? 0.02 : 0, 5.6, 0.19, 0.05);
  furn.color(0xc2a21a);
  furn.box(-2.95, 2.25, 0.03, 0.22, 4.5, 0.14);
  furn.box(2.95, 2.25, 0.03, 0.22, 4.5, 0.14);
  furn.box(0, 4.6, 0.03, 6.1, 0.24, 0.14);
  furn.setTransform(null);
  // floor hazard stripes in front of the door
  const furnMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.45, envMapIntensity: 0.5 });
  mesh(furn.build({ mat: false, uv: false }), furnMat);

  // --- neon signage ---------------------------------------------------------------------------------------------------------
  const signs: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; gain: number; flicker: number }[] = [];
  const sign = (text: string, w: number, h: number, x: number, y: number, z: number, ry: number, gain: number, accent: boolean, flicker = 0): void => {
    const tex = neonSign(text, w, h);
    texs.push(tex);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const g = new THREE.PlaneGeometry(w, h);
    const m = mesh(g, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    if (accent) accentMats.push({ mat, gain });
    else mat.color.setRGB(gain, gain * 0.95, gain * 0.85);
    signs.push({ mesh: m, mat, gain, flicker });
  };
  sign('APEX', 6.5, 2.0, -5.2, 4.4, -ROOM + 0.12, 0, 1.7, true);
  sign('NOCTURNE GARAGE', 6, 0.8, -5.2, 2.95, -ROOM + 0.12, 0, 1.5, false, 1);
  sign('ATELIER SÉLÈNE', 5.5, 0.9, ROOM - 0.12, 4.6, -1, -Math.PI / 2, 1.9, true);
  sign('TURBO · NOS · DYNO', 5.5, 0.7, -ROOM + 0.12, 4.7, 0.5, Math.PI / 2, 1.6, false);
  sign('KAIDO SPEED SHOP', 5, 0.8, 4, 4.9, ROOM - 0.12, Math.PI, 1.7, true);

  // --- real lights (6) ----------------------------------------------------------------------------------------------------------
  const hemi = new THREE.HemisphereLight(0x9fb4d8, 0x0a0a0c, 0.22);
  const key = new THREE.SpotLight(0xffffff, 70, 22, 0.75, 0.8, 1.6);
  key.position.set(0.5, HEIGHT - 0.6, 2.5);
  key.target.position.set(0, 0.4, 0);
  const fillL = new THREE.PointLight(0xbfd4ff, 22, 22, 1.7);
  fillL.position.set(-6.5, 3.2, 4.5);
  const fillR = new THREE.PointLight(0xffe2c4, 18, 22, 1.7);
  fillR.position.set(6.5, 3.0, -3.5);
  const rim = new THREE.PointLight(0xffffff, 24, 20, 1.7);
  rim.position.set(0, 2.6, -7.5);
  const accent = new THREE.PointLight(0xffffff, 10, 14, 1.8);
  accent.position.set(-5.2, 3.6, -ROOM + 1.6);
  scene.add(hemi, key, key.target, fillL, fillR, rim, accent);

  const carAnchor = new THREE.Group();
  scene.add(carAnchor);

  const accentColor = new THREE.Color();
  const setAccentColor = (color: number): void => {
    accentColor.set(color);
    // keep the accent readable even for very dark colours
    const hsl = { h: 0, s: 0, l: 0 };
    accentColor.getHSL(hsl);
    accentColor.setHSL(hsl.h, Math.min(1, hsl.s * 0.9 + 0.1), Math.max(0.5, Math.min(0.62, hsl.l)));
    for (const a of accentMats) a.mat.color.copy(accentColor).multiplyScalar(a.gain);
    rim.color.copy(accentColor).lerp(new THREE.Color(1, 1, 1), 0.45);
    accent.color.copy(accentColor);
  };
  setAccentColor(0xb48cff);

  return {
    scene,
    carAnchor,
    orbitTarget: new THREE.Vector3(0, 0.6, 0),
    minDistance: 3.5,
    maxDistance: 9,
    setAccentColor,
    update(_dt: number, time: number): void {
      for (const s of signs) {
        if (s.flicker <= 0) continue;
        const f = Math.sin(time * 41) * Math.sin(time * 17.3) > 0.72 ? 0.35 : 1;
        s.mat.color.setRGB(s.gain * f, s.gain * 0.95 * f, s.gain * 0.85 * f);
      }
    },
    dispose(): void {
      mirror.dispose();
      (mirror.material as THREE.Material).dispose();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
      metal.dispose();
      for (const t of texs) t.dispose();
      envTarget.dispose();
      key.dispose();
      fillL.dispose();
      fillR.dispose();
      rim.dispose();
      accent.dispose();
      hemi.dispose();
      scene.environment = null;
    },
  };
}
