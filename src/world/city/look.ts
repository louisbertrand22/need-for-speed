/* Procedural textures, shared materials and the sky dome of Port-Sélène. */
import * as THREE from 'three';
import { ATLAS, BAND_PX, FLOOR_PX } from './batch';
import type { LayerName } from './batch';
import { tileFbm } from './noise';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb: boolean, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// --- facade atlas ---------------------------------------------------------------

const BAND_PALETTES: string[][] = [
  ['#cfe6ff', '#a8d4ff', '#e8f4ff', '#7fd0ff', '#fff4d8'],
  ['#ffe2b0', '#ffd08a', '#fff0d0', '#ffb870', '#ffe9c4'],
  ['#ffcf8a', '#ff9e6a', '#ffd9a0', '#ff7fb0', '#9fe0ff', '#ffc070'],
  ['#9fe8ff', '#d8f4ff', '#7fc8ff', '#c0b0ff'],
];
const PATCH_COLORS = ['#ffa040', '#f0f4ff', '#60e0ff', '#ff5fb0', '#ff3030', '#40ff80', '#ffc040'];

function drawFacades(rng: () => number): { albedo: HTMLCanvasElement; emissive: HTMLCanvasElement } {
  const [ca, a] = canvas(ATLAS, ATLAS);
  const [ce, e] = canvas(ATLAS, ATLAS);
  a.fillStyle = '#8c8c8c';
  a.fillRect(0, 0, ATLAS, ATLAS);
  e.fillStyle = '#000';
  e.fillRect(0, 0, ATLAS, ATLAS);
  const cols = ATLAS / FLOOR_PX;
  for (let band = 0; band < 4; band++) {
    const y0 = band * BAND_PX;
    const pal = BAND_PALETTES[band];
    for (let f = 0; f < BAND_PX / FLOOR_PX; f++) {
      const fy = y0 + f * FLOOR_PX;
      const floorLit = rng();
      for (let cidx = 0; cidx < cols; cidx++) {
        const x = cidx * FLOOR_PX;
        if (band === 3) {
          // glass curtain wall: full-height panes, lit by whole floor strips
          a.fillStyle = '#20262e';
          a.fillRect(x, fy, FLOOR_PX, FLOOR_PX);
          a.fillStyle = '#3a424c';
          a.fillRect(x, fy, 2, FLOOR_PX);
          a.fillRect(x, fy + FLOOR_PX - 3, FLOOR_PX, 3);
          if (floorLit < 0.34 && rng() < 0.8) {
            e.globalAlpha = 0.35 + rng() * 0.5;
            e.fillStyle = pal[Math.floor(rng() * pal.length)];
            e.fillRect(x + 2, fy + 2, FLOOR_PX - 2, FLOOR_PX - 6);
          }
          continue;
        }
        const small = band === 2;
        const wx0 = x + (small ? 7 : 4);
        const ww = FLOOR_PX - (small ? 14 : 8);
        const wy0 = fy + (small ? 7 : 5);
        const wh = FLOOR_PX - (small ? 15 : 12);
        a.fillStyle = '#161b22';
        a.fillRect(wx0, wy0, ww, wh);
        a.fillStyle = '#6e6e6e';
        a.fillRect(x, fy + FLOOR_PX - 2, FLOOR_PX, 2);
        if (small) a.fillRect(wx0 - 2, wy0 + wh, ww + 4, 2);
        const lit = rng() < (band === 2 ? 0.42 : 0.48);
        if (lit) {
          e.globalAlpha = 0.3 + rng() * 0.7;
          e.fillStyle = pal[Math.floor(rng() * pal.length)];
          e.fillRect(wx0, wy0, ww, wh);
          if (rng() < 0.35) {
            // blinds / furniture silhouette
            e.globalAlpha = 1;
            e.fillStyle = 'rgba(0,0,0,0.45)';
            e.fillRect(wx0, wy0, ww, Math.floor(wh * (0.25 + rng() * 0.4)));
          }
        }
      }
    }
  }
  e.globalAlpha = 1;
  // storefront band (rows 768..864): bright shop windows
  for (let x = 0; x < ATLAS; x += 64) {
    a.fillStyle = '#2a2d33';
    a.fillRect(x, 768, 64, 96);
    a.fillStyle = '#0e1116';
    a.fillRect(x + 4, 780, 56, 76);
    const hue = [28, 40, 190, 320, 48, 170, 350, 30][Math.floor(rng() * 8)];
    e.fillStyle = `hsl(${hue}, 85%, ${52 + rng() * 18}%)`;
    e.globalAlpha = 0.55 + rng() * 0.45;
    e.fillRect(x + 4, 780, 56, 76);
    e.globalAlpha = 1;
    e.fillStyle = 'rgba(0,0,0,0.55)';
    for (let k = 0; k < 3; k++) e.fillRect(x + 8 + rng() * 40, 820 + rng() * 20, 6 + rng() * 10, 36);
    e.fillRect(x + 30, 780, 3, 76);
    // header strip
    e.fillStyle = `hsl(${(hue + 150) % 360}, 90%, 60%)`;
    e.fillRect(x + 4, 770, 56, 6);
  }
  // misc band (rows 864..1024): plain | corrugated | slats | emissive patches
  a.fillStyle = '#ffffff';
  a.fillRect(0, 864, 64, 160);
  for (let x = 64; x < 448; x += 8) {
    a.fillStyle = '#b8b8b8';
    a.fillRect(x, 864, 8, 160);
    a.fillStyle = '#7c7c7c';
    a.fillRect(x + 5, 864, 3, 160);
  }
  for (let y = 864; y < 1024; y += 8) {
    a.fillStyle = '#b0b0b0';
    a.fillRect(448, y, 128, 8);
    a.fillStyle = '#6a6a6a';
    a.fillRect(448, y + 6, 128, 2);
  }
  a.fillStyle = '#ffffff';
  a.fillRect(576, 864, 448, 160);
  PATCH_COLORS.forEach((c, i) => {
    e.fillStyle = c;
    e.fillRect(576 + i * 64, 864, 64, 160);
  });
  return { albedo: ca, emissive: ce };
}

// --- signs ------------------------------------------------------------------------

export const BIG_SIGNS = ['KESSLER', 'NOVAÏA', 'HÉLIOS', 'APEX'];
export const WIDE_SIGNS = [
  'NOCTIS', 'PULSAR', 'CAFÉ COMÈTE', 'HÔTEL LUNE', 'ZÉNITH-K', 'ARCADE', 'ONYX BAR', 'CINÉ ÉCLIPSE',
  'RAMEN 24H', 'VOLTA+', 'KARAOKÉ', 'DOCK 7', 'GARAGE QG', 'ORBITALE', 'QUARTZ', 'FRET SÉLÈNE',
];
export const TALL_SIGNS = ['BAR', 'HÔTEL', 'NOVA', 'THÉ', 'LUNE', 'OUVERT', 'SUSHI', 'JEUX', 'DISQUES', 'CLUB', 'TAXI', 'NÉON', '', '', '', ''];

/** UV rectangle [u0, v0, u1, v1] of a sign cell. */
export function bigSignUV(i: number): [number, number, number, number] {
  const cx = (i % 2) * 512;
  const cy = Math.floor(i / 2) * 256;
  return [cx / ATLAS, 1 - (cy + 256) / ATLAS, (cx + 512) / ATLAS, 1 - cy / ATLAS];
}
export function wideSignUV(i: number): [number, number, number, number] {
  const cx = (i % 4) * 256;
  const cy = 512 + Math.floor(i / 4) * 64;
  return [cx / ATLAS, 1 - (cy + 64) / ATLAS, (cx + 256) / ATLAS, 1 - cy / ATLAS];
}
export function tallSignUV(i: number): [number, number, number, number] {
  const cx = i * 64;
  return [cx / ATLAS, 0, (cx + 64) / ATLAS, 256 / ATLAS];
}

function drawSigns(rng: () => number): HTMLCanvasElement {
  const [c, g] = canvas(ATLAS, ATLAS);
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS, ATLAS);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const fit = (text: string, maxW: number, size: number, style = '900') => {
    do {
      g.font = `${style} ${size}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
      size -= 2;
    } while (g.measureText(text).width > maxW && size > 8);
  };
  const neon = (text: string, x: number, y: number) => {
    g.shadowColor = '#fff';
    g.shadowBlur = 10;
    g.fillStyle = '#fff';
    g.fillText(text, x, y);
    g.shadowBlur = 0;
  };
  BIG_SIGNS.forEach((name, i) => {
    const x = (i % 2) * 512;
    const y = Math.floor(i / 2) * 256;
    g.fillStyle = '#16161a';
    g.fillRect(x + 6, y + 6, 500, 244);
    g.strokeStyle = '#fff';
    g.lineWidth = 5;
    g.strokeRect(x + 14, y + 14, 484, 228);
    // abstract logo: rings / bars
    g.lineWidth = 9;
    g.beginPath();
    if (i % 2 === 0) {
      g.arc(x + 256, y + 84, 44, 0.3, Math.PI * 2 - 0.3);
      g.moveTo(x + 226, y + 84);
      g.lineTo(x + 300, y + 84);
    } else {
      g.moveTo(x + 196, y + 120);
      g.lineTo(x + 256, y + 44);
      g.lineTo(x + 316, y + 120);
      g.moveTo(x + 226, y + 120);
      g.lineTo(x + 256, y + 82);
      g.lineTo(x + 286, y + 120);
    }
    g.stroke();
    fit(name, 430, 84);
    neon(name, x + 256, y + 186);
  });
  WIDE_SIGNS.forEach((name, i) => {
    const x = (i % 4) * 256;
    const y = 512 + Math.floor(i / 4) * 64;
    if (rng() < 0.5) {
      g.strokeStyle = '#bbb';
      g.lineWidth = 3;
      g.strokeRect(x + 8, y + 8, 240, 48);
    }
    fit(name, 216, 40, rng() < 0.4 ? 'italic 900' : '900');
    neon(name, x + 128, y + 33);
  });
  TALL_SIGNS.forEach((name, i) => {
    const x = i * 64;
    const y = 768;
    g.strokeStyle = '#ccc';
    g.lineWidth = 3;
    g.strokeRect(x + 8, y + 8, 48, 240);
    if (name) {
      const n = name.length;
      const step = Math.min(44, 220 / n);
      g.font = `900 ${Math.min(40, step * 0.95)}px "Arial Black", Impact, Arial, sans-serif`;
      for (let k = 0; k < n; k++) neon(name[k], x + 32, y + 128 + (k - (n - 1) / 2) * step);
    } else {
      // invented glyph blocks (no real script)
      g.lineWidth = 4;
      g.strokeStyle = '#fff';
      for (let k = 0; k < 5; k++) {
        const gy = y + 22 + k * 44;
        g.beginPath();
        for (let s = 0; s < 4; s++) {
          const horizontal = rng() < 0.5;
          const p = 6 + rng() * 26;
          if (horizontal) {
            g.moveTo(x + 16, gy + p);
            g.lineTo(x + 48, gy + p);
          } else {
            g.moveTo(x + 14 + p, gy + 2);
            g.lineTo(x + 14 + p, gy + 36);
          }
        }
        g.stroke();
      }
    }
  });
  return c;
}

// --- ground: wet asphalt roughness ----------------------------------------------

function drawGroundRoughness(): HTMLCanvasElement {
  const N = 512;
  const [c, g] = canvas(N, N);
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const puddle = tileFbm(u, v, 5, 11, 3);
      const grain = tileFbm(u, v, 64, 23, 2);
      // puddles (mirror-like) where the low-frequency noise is high, drier grainy asphalt elsewhere
      const wet = Math.min(1, Math.max(0, (puddle - 0.47) * 7));
      const rough = (1 - wet) * (0.34 + grain * 0.32) + wet * 0.05;
      const k = (y * N + x) * 4;
      const val = Math.round(rough * 255);
      img.data[k] = val;
      img.data[k + 1] = val;
      img.data[k + 2] = val;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function drawGlow(): HTMLCanvasElement {
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.14)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}

// --- materials ----------------------------------------------------------------------

const FX_GLSL = /* glsl */ `
float neonFx(vec2 fx, float t) {
  float m = fx.y;
  if (m < 0.5) return 1.0;
  if (m < 1.5) return 0.78 + 0.22 * sin(t * 2.4 + fx.x * 6.2832);
  if (m < 2.5) {
    float slow = fract(sin(floor(t * 0.9 + fx.x * 17.0) * 12.9898) * 43758.5453);
    float fast = fract(sin(floor(t * 19.0 + fx.x * 31.0) * 78.233) * 43758.5453);
    return slow > 0.8 ? (fast > 0.45 ? 1.0 : 0.2) : 1.0;
  }
  if (m < 3.5) return step(0.5, fract(t * 0.8 + fx.x)) * 0.94 + 0.06;
  if (m < 4.5) return 0.3 + 0.7 * smoothstep(0.55, 1.0, fract(fx.x - t * 1.5));
  return step(0.5, fract(t * 0.07 + fx.x)) * 0.92 + 0.08;
}
`;

function patchFx(mat: THREE.Material, time: { value: number }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 fx;\nvarying vec2 vFx;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFx = fx;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nvarying vec2 vFx;\n${FX_GLSL}`)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= neonFx(vFx, uTime);');
  };
}

export interface CityLook {
  layers: Record<LayerName, THREE.Material>;
  water: THREE.MeshStandardMaterial;
  time: { value: number };
  sky: THREE.Mesh;
  dispose(): void;
}

export function createLook(rng: () => number, fogColor: number): CityLook {
  const time = { value: 0 };
  const fac = drawFacades(rng);
  const tAlbedo = tex(fac.albedo, true, false);
  const tEmissive = tex(fac.emissive, true, false);
  const tSigns = tex(drawSigns(rng), true, false);
  tSigns.wrapS = THREE.ClampToEdgeWrapping;
  const tRough = tex(drawGroundRoughness(), false, true);
  tRough.anisotropy = 8;
  const tGlow = tex(drawGlow(), true, false);
  tGlow.wrapS = THREE.ClampToEdgeWrapping;

  const mStatic = new THREE.MeshStandardMaterial({
    map: tAlbedo,
    emissiveMap: tEmissive,
    emissive: 0xffffff,
    emissiveIntensity: 1.55,
    roughness: 0.42,
    metalness: 0.35,
    vertexColors: true,
    envMapIntensity: 0.9,
  });
  const mGround = new THREE.MeshStandardMaterial({
    roughnessMap: tRough,
    roughness: 1,
    metalness: 0.0,
    vertexColors: true,
    envMapIntensity: 1.15,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const mMark = new THREE.MeshStandardMaterial({
    roughness: 0.45,
    metalness: 0,
    vertexColors: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const mGlow = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
  patchFx(mGlow, time);
  const mSign = new THREE.MeshBasicMaterial({ map: tSigns, vertexColors: true });
  patchFx(mSign, time);
  const mAdd = new THREE.MeshBasicMaterial({
    map: tGlow,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  // additive surfaces must fade to black in the fog (not to the fog colour)
  mAdd.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <fog_fragment>',
      `#ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
        #else
          float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
        #endif
        gl_FragColor.rgb *= ( 1.0 - fogFactor );
      #endif`,
    );
  };
  const mTerrain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, envMapIntensity: 0.35 });
  const water = new THREE.MeshStandardMaterial({
    color: 0x05080f,
    roughness: 0.12,
    metalness: 0.85,
    roughnessMap: tRough,
    envMapIntensity: 2.2,
  });

  // --- sky dome (drawn first, ignores depth so any camera far plane works)
  const fog = new THREE.Color(fogColor);
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uTime: time, uFog: { value: new THREE.Vector3(fog.r, fog.g, fog.b) } },
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uFog;
      varying vec3 vDir;
      float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
        float a = hash(vec3(i, 1.0)); float b = hash(vec3(i + vec2(1.0, 0.0), 1.0));
        float c = hash(vec3(i + vec2(0.0, 1.0), 1.0)); float d = hash(vec3(i + vec2(1.0, 1.0), 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      void main() {
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 zenith = vec3(0.004, 0.006, 0.022);
        vec3 col = mix(uFog, zenith, pow(h, 0.42));
        // city glow on the horizon, fading out below it so hidden far chunks melt into the haze
        float above = smoothstep(-0.12, 0.02, d.y);
        float glow = exp(-h * 7.0) * above;
        col += vec3(0.085, 0.03, 0.10) * glow * (0.55 + 0.45 * d.x);
        col += vec3(0.07, 0.04, 0.012) * exp(-h * 16.0) * above;
        // stars
        vec3 cell = floor(d * 420.0);
        float s = hash(cell);
        float tw = 0.75 + 0.25 * sin(uTime * 2.0 + s * 90.0);
        col += vec3(0.9, 0.95, 1.0) * step(0.9972, s) * smoothstep(0.08, 0.35, h) * tw * (0.5 + 1.2 * hash(cell + 3.0));
        // moon
        vec3 md = normalize(vec3(-0.45, 0.5, -0.74));
        float m = dot(d, md);
        col += vec3(1.0, 0.98, 0.92) * (smoothstep(0.9991, 0.9994, m) * 2.6 + pow(max(m, 0.0), 260.0) * 0.5 + pow(max(m, 0.0), 24.0) * 0.06);
        // thin drifting clouds
        vec2 cp = d.xz / (d.y + 0.25) * 2.2 + vec2(uTime * 0.006, 0.0);
        float cl = noise(cp) * 0.6 + noise(cp * 2.3) * 0.3 + noise(cp * 5.1) * 0.1;
        col += vec3(0.05, 0.045, 0.085) * smoothstep(0.5, 0.85, cl) * smoothstep(0.0, 0.25, h);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 14), skyMat);
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.matrixAutoUpdate = true;

  const mats = [mStatic, mGround, mMark, mGlow, mSign, mAdd, mTerrain, water, skyMat];
  const textures = [tAlbedo, tEmissive, tSigns, tRough, tGlow];
  return {
    layers: { static: mStatic, ground: mGround, mark: mMark, glow: mGlow, sign: mSign, add: mAdd, terrain: mTerrain },
    water,
    time,
    sky,
    dispose() {
      for (const m of mats) m.dispose();
      for (const t of textures) t.dispose();
      sky.geometry.dispose();
    },
  };
}
