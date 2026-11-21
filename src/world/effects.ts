/* =============================================================================
 * APEX NOCTURNE — visual effects: pooled particles, skid marks, event portals,
 * checkpoints, spike strips and police barriers. 100 % procedural.
 * ===========================================================================*/
import * as THREE from 'three';
import type { CheckpointLook, CheckpointModel, IParticleSystem, ISkidMarks, PortalKind, PortalModel } from '../core/types';
import { GARAGE_COLOR, MODE_INFO } from '../game/catalog';
import { GeoBuilder, trs } from './models/geo';
import { createBeamMaterial, type BeamMaterial } from './models/materials';
import { canvasTexture, FONTS } from './models/textures';

// -----------------------------------------------------------------------------
// Particles: instanced camera-facing quads, CPU simulation in ring buffers
// -----------------------------------------------------------------------------

const PARTICLE_VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iData; // size, alpha, streak, hardness
attribute vec3 iColor;
varying vec2 vUv;
varying vec4 vCol;
varying float vHard;
varying float vDepth;
void main() {
  vec4 mv = viewMatrix * vec4(iPos, 1.0);
  vec2 corner = position.xy;
  vec2 off = corner * iData.x;
  if (iData.z > 0.0) {
    vec3 vv = (viewMatrix * vec4(iVel, 0.0)).xyz;
    float l = length(vv.xy);
    vec2 dir = l > 1e-4 ? vv.xy / l : vec2(1.0, 0.0);
    float len = iData.x * (1.0 + iData.z * length(vv));
    off = dir * corner.x * len + vec2(-dir.y, dir.x) * corner.y * iData.x;
  }
  mv.xy += off;
  vUv = corner * 2.0;
  vCol = vec4(iColor, iData.y);
  vHard = iData.w;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FRAG = (additive: boolean): string => /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
varying float vHard;
varying float vDepth;
#ifdef USE_FOG
  uniform vec3 fogColor;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float soft = pow(1.0 - d, 1.5);
  float hard = smoothstep(1.0, 0.75, d);
  float a = mix(soft, hard, vHard) * vCol.a;
  vec3 col = vCol.rgb;
  float fogF = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogF = 1.0 - exp(-fogDensity * fogDensity * vDepth * vDepth);
    #else
      fogF = smoothstep(fogNear, fogFar, vDepth);
    #endif
  #endif
  ${additive ? 'gl_FragColor = vec4(col * a * (1.0 - fogF), 1.0);' : '#ifdef USE_FOG\n col = mix(col, fogColor, fogF);\n#endif\n gl_FragColor = vec4(col, a);'}
}`;

/** Per-particle simulation stride. */
const PS = 20;
// px py pz vx vy vz age life s0 s1 r g b a grav drag floor streak hard bounces

class ParticleLayer {
  readonly mesh: THREE.Mesh;
  private readonly cap: number;
  private readonly sim: Float32Array;
  private head = 0;
  private live = 0;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aData: THREE.InstancedBufferAttribute;
  private readonly aCol: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;

  constructor(capacity: number, additive: boolean) {
    this.cap = capacity;
    this.sim = new Float32Array(capacity * PS);
    for (let i = 0; i < capacity; i++) this.sim[i * PS + 7] = -1;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.aData = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    for (const a of [this.aPos, this.aVel, this.aData, this.aCol]) a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iVel', this.aVel);
    geo.setAttribute('iData', this.aData);
    geo.setAttribute('iColor', this.aCol);
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG(additive),
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 9 : 8;
  }

  emit(
    x: number, y: number, z: number, vx: number, vy: number, vz: number,
    life: number, s0: number, s1: number, r: number, g: number, b: number, a: number,
    grav: number, drag: number, floor: number, streak: number, hard: number,
  ): void {
    const o = this.head * PS;
    this.head = (this.head + 1) % this.cap;
    const s = this.sim;
    s[o] = x; s[o + 1] = y; s[o + 2] = z;
    s[o + 3] = vx; s[o + 4] = vy; s[o + 5] = vz;
    s[o + 6] = 0; s[o + 7] = life;
    s[o + 8] = s0; s[o + 9] = s1;
    s[o + 10] = r; s[o + 11] = g; s[o + 12] = b; s[o + 13] = a;
    s[o + 14] = grav; s[o + 15] = drag; s[o + 16] = floor; s[o + 17] = streak; s[o + 18] = hard; s[o + 19] = 0;
  }

  update(dt: number): void {
    const s = this.sim;
    const pos = this.aPos.array as Float32Array;
    const vel = this.aVel.array as Float32Array;
    const dat = this.aData.array as Float32Array;
    const col = this.aCol.array as Float32Array;
    let n = 0;
    for (let i = 0; i < this.cap; i++) {
      const o = i * PS;
      const life = s[o + 7];
      if (life <= 0) continue;
      const age = s[o + 6] + dt;
      if (age >= life) {
        s[o + 7] = -1;
        continue;
      }
      s[o + 6] = age;
      const k = Math.max(0, 1 - s[o + 15] * dt);
      s[o + 3] *= k;
      s[o + 4] = s[o + 4] * k - s[o + 14] * dt;
      s[o + 5] *= k;
      s[o] += s[o + 3] * dt;
      s[o + 1] += s[o + 4] * dt;
      s[o + 2] += s[o + 5] * dt;
      if (s[o + 1] < s[o + 16] && s[o + 4] < 0) {
        if (s[o + 19] < 1) {
          s[o + 1] = s[o + 16];
          s[o + 4] *= -0.42;
          s[o + 3] *= 0.6;
          s[o + 5] *= 0.6;
          s[o + 19] = 1;
        } else {
          s[o + 1] = s[o + 16];
          s[o + 3] = s[o + 4] = s[o + 5] = 0;
        }
      }
      const t = age / life;
      const fadeIn = t < 0.08 ? t / 0.08 : 1;
      const p3 = n * 3;
      pos[p3] = s[o]; pos[p3 + 1] = s[o + 1]; pos[p3 + 2] = s[o + 2];
      vel[p3] = s[o + 3]; vel[p3 + 1] = s[o + 4]; vel[p3 + 2] = s[o + 5];
      col[p3] = s[o + 10]; col[p3 + 1] = s[o + 11]; col[p3 + 2] = s[o + 12];
      const p4 = n * 4;
      dat[p4] = s[o + 8] + (s[o + 9] - s[o + 8]) * Math.sqrt(t);
      dat[p4 + 1] = s[o + 13] * fadeIn * (1 - t) * (1 - t * 0.5);
      dat[p4 + 2] = s[o + 17];
      dat[p4 + 3] = s[o + 18];
      n++;
    }
    if (n > 0 || this.live > 0) {
      for (const a of [this.aPos, this.aVel, this.aData, this.aCol]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, n) * a.itemSize);
        a.needsUpdate = true;
      }
    }
    this.live = n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) this.sim[i * PS + 7] = -1;
    this.live = 0;
    this.geo.instanceCount = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

class ParticleSystem implements IParticleSystem {
  readonly object = new THREE.Group();
  private readonly soft = new ParticleLayer(2200, false);
  private readonly glow = new ParticleLayer(1600, true);
  private seed = 0x2f6e2b1;

  constructor() {
    this.object.add(this.soft.mesh, this.glow.mesh);
  }

  /** allocation-free PRNG, [0, 1) */
  private rnd(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) | 0;
    return (this.seed >>> 8) / 16777216;
  }

  /** [-1, 1) */
  private sr(): number {
    return this.rnd() * 2 - 1;
  }

  tireSmoke(x: number, y: number, z: number, vx: number, vy: number, vz: number, intensity: number): void {
    const k = Math.min(1, Math.max(0, intensity));
    const g = 0.62 + this.rnd() * 0.2;
    this.soft.emit(x + this.sr() * 0.12, y + 0.08, z + this.sr() * 0.12, vx * 0.3 + this.sr() * 0.6, vy * 0.3 + 0.5 + this.rnd() * 0.6, vz * 0.3 + this.sr() * 0.6,
      1.0 + this.rnd() * 1.4, 0.35, 1.5 + k * 1.6, g, g, g * 1.03, 0.12 + 0.26 * k, -0.5, 1.4, -1e9, 0, 0);
  }

  dust(x: number, y: number, z: number, vx: number, vy: number, vz: number, intensity: number): void {
    const k = Math.min(1, Math.max(0, intensity));
    this.soft.emit(x + this.sr() * 0.15, y + 0.06, z + this.sr() * 0.15, vx * 0.35 + this.sr() * 0.8, vy * 0.3 + 0.4 + this.rnd() * 0.8, vz * 0.35 + this.sr() * 0.8,
      0.9 + this.rnd() * 1.0, 0.3, 1.2 + k * 1.3, 0.36, 0.3, 0.23, 0.14 + 0.26 * k, -0.15, 1.6, -1e9, 0, 0);
  }

  engineSmoke(x: number, y: number, z: number, intensity: number): void {
    const k = Math.min(1, Math.max(0, intensity));
    const g = 0.04 + this.rnd() * 0.05;
    this.soft.emit(x + this.sr() * 0.15, y, z + this.sr() * 0.15, this.sr() * 0.4, 1.2 + this.rnd() * 1.0, this.sr() * 0.4,
      1.5 + this.rnd() * 1.0, 0.3, 1.3 + k * 1.2, g, g, g, 0.25 + 0.4 * k, -0.6, 0.7, -1e9, 0, 0);
  }

  sparks(x: number, y: number, z: number, nx: number, ny: number, nz: number, count: number, speed = 7): void {
    const n = Math.min(60, count | 0);
    for (let i = 0; i < n; i++) {
      const sp = speed * (0.35 + this.rnd() * 0.9);
      const h = 0.75 + this.rnd() * 0.25;
      this.glow.emit(x, y, z, nx * sp + this.sr() * speed * 0.45, ny * sp + this.rnd() * speed * 0.45, nz * sp + this.sr() * speed * 0.45,
        0.35 + this.rnd() * 0.6, 0.06, 0.03, 4.2, 2.6 * h, 0.9 * h, 1, 14, 0.4, y - 0.3, 0.035, 0);
    }
  }

  flame(x: number, y: number, z: number, vx: number, vy: number, vz: number, color: number, size: number): void {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    const w = 0.35;
    this.glow.emit(x, y, z, vx + this.sr() * 0.5, vy + this.sr() * 0.5, vz + this.sr() * 0.5,
      0.12 + this.rnd() * 0.16, size, size * 0.2, (r * r + w) * 2.6, (g * g + w) * 2.6, (b * b + w) * 2.6, 0.9, -1.5, 1.5, -1e9, 0, 0);
  }

  debris(x: number, y: number, z: number, count: number, color: number, spread: number): void {
    const r = Math.pow(((color >> 16) & 255) / 255, 2.2);
    const g = Math.pow(((color >> 8) & 255) / 255, 2.2);
    const b = Math.pow((color & 255) / 255, 2.2);
    const n = Math.min(80, count | 0);
    for (let i = 0; i < n; i++) {
      const sh = 0.6 + this.rnd() * 0.5;
      this.soft.emit(x + this.sr() * spread * 0.3, y + this.rnd() * spread * 0.3, z + this.sr() * spread * 0.3, this.sr() * spread * 2.2, 2 + this.rnd() * spread * 2.4, this.sr() * spread * 2.2,
        1.0 + this.rnd() * 0.9, 0.08 + this.rnd() * 0.16, 0.08, r * sh, g * sh, b * sh, 1.6, 12, 0.3, -1e9, 0, 1);
    }
  }

  explosion(x: number, y: number, z: number, scale: number): void {
    const s = Math.max(0.3, scale);
    for (let i = 0; i < 18; i++) {
      const h = this.rnd();
      this.glow.emit(x + this.sr() * s, y + this.rnd() * s, z + this.sr() * s, this.sr() * 5 * s, 2 + this.rnd() * 6 * s, this.sr() * 5 * s,
        0.45 + this.rnd() * 0.5, 1.2 * s, 3.4 * s, 3.6, 1.3 + h * 1.2, 0.25 + h * 0.3, 0.75, -2, 1.8, -1e9, 0, 0);
    }
    for (let i = 0; i < 16; i++) {
      const g = 0.03 + this.rnd() * 0.05;
      this.soft.emit(x + this.sr() * s, y + this.rnd() * s * 1.5, z + this.sr() * s, this.sr() * 2.5 * s, 3 + this.rnd() * 5 * s, this.sr() * 2.5 * s,
        2.0 + this.rnd() * 1.6, 1.4 * s, 5 * s, g, g, g, 0.6, -1.2, 0.8, -1e9, 0, 0);
    }
    this.sparks(x, y + 0.3, z, 0, 1, 0, 40, 11 * Math.sqrt(s));
  }

  splash(x: number, y: number, z: number, scale: number): void {
    const s = Math.max(0.3, scale);
    const up = 7 * Math.sqrt(s);
    for (let i = 0; i < 46; i++) {
      this.soft.emit(x + this.sr() * 0.4 * s, y, z + this.sr() * 0.4 * s, this.sr() * 3.2 * s, up * (0.5 + this.rnd()), this.sr() * 3.2 * s,
        1.0 + this.rnd() * 0.9, 0.14 * s, 0.34 * s, 0.75, 0.86, 1.0, 0.55, 10, 0.25, -1e9, 0.02, 0.25);
    }
    for (let i = 0; i < 10; i++) {
      this.soft.emit(x + this.sr() * s, y + this.rnd() * s, z + this.sr() * s, this.sr() * 2 * s, 1 + this.rnd() * 2, this.sr() * 2 * s,
        1.4 + this.rnd() * 0.8, 0.8 * s, 3 * s, 0.7, 0.8, 0.9, 0.22, 0.4, 1.2, -1e9, 0, 0);
    }
  }

  update(dt: number, _camera: THREE.Camera): void {
    const step = Math.min(dt, 0.1);
    this.soft.update(step);
    this.glow.update(step);
  }

  clear(): void {
    this.soft.clear();
    this.glow.clear();
  }

  dispose(): void {
    this.object.removeFromParent();
    this.soft.dispose();
    this.glow.dispose();
  }
}

export function createParticleSystem(): IParticleSystem {
  return new ParticleSystem();
}

// -----------------------------------------------------------------------------
// Skid marks: ring buffer of independent quads
// -----------------------------------------------------------------------------

interface Trail {
  active: boolean;
  hasEdge: boolean;
  x: number;
  y: number;
  z: number;
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  a: number;
}

class SkidMarks implements ISkidMarks {
  readonly object: THREE.Mesh;
  private readonly max = 3000;
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aCol: THREE.BufferAttribute;
  private readonly trails = new Map<number, Trail>();
  private head = 0;
  private dirty = false;

  constructor() {
    const n = this.max;
    this.pos = new Float32Array(n * 12);
    this.col = new Float32Array(n * 16);
    const idx = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3);
    this.aCol = new THREE.BufferAttribute(this.col, 4);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aCol.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('color', this.aCol);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.object = new THREE.Mesh(geo, mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = -3;
  }

  add(trailId: number, x: number, y: number, z: number, width: number, intensity: number): void {
    let t = this.trails.get(trailId);
    if (!t) {
      t = { active: false, hasEdge: false, x: 0, y: 0, z: 0, lx: 0, lz: 0, rx: 0, rz: 0, a: 0 };
      this.trails.set(trailId, t);
    }
    const a = Math.min(1, Math.max(0, intensity)) * 0.62;
    if (!t.active) {
      t.active = true;
      t.hasEdge = false;
      t.x = x;
      t.y = y;
      t.z = z;
      t.a = a;
      return;
    }
    const dx = x - t.x;
    const dz = z - t.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < 0.09) return;
    if (d2 > 16) {
      // teleport: restart the strip
      t.hasEdge = false;
      t.x = x;
      t.y = y;
      t.z = z;
      t.a = a;
      return;
    }
    const d = Math.sqrt(d2);
    const nx = (-dz / d) * width * 0.5;
    const nz = (dx / d) * width * 0.5;
    if (!t.hasEdge) {
      t.lx = t.x + nx;
      t.lz = t.z + nz;
      t.rx = t.x - nx;
      t.rz = t.z - nz;
      t.hasEdge = true;
    }
    const q = this.head;
    this.head = (this.head + 1) % this.max;
    const p = this.pos;
    const o = q * 12;
    const y0 = t.y + 0.025;
    const y1 = y + 0.025;
    p[o] = t.lx; p[o + 1] = y0; p[o + 2] = t.lz;
    p[o + 3] = t.rx; p[o + 4] = y0; p[o + 5] = t.rz;
    p[o + 6] = x - nx; p[o + 7] = y1; p[o + 8] = z - nz;
    p[o + 9] = x + nx; p[o + 10] = y1; p[o + 11] = z + nz;
    const c = this.col;
    const co = q * 16;
    for (let k = 0; k < 4; k++) {
      c[co + k * 4] = 0.012;
      c[co + k * 4 + 1] = 0.012;
      c[co + k * 4 + 2] = 0.014;
      c[co + k * 4 + 3] = k < 2 ? t.a : a;
    }
    t.lx = x + nx;
    t.lz = z + nz;
    t.rx = x - nx;
    t.rz = z - nz;
    t.x = x;
    t.y = y;
    t.z = z;
    t.a = a;
    this.dirty = true;
  }

  end(trailId: number): void {
    const t = this.trails.get(trailId);
    if (t) t.active = false;
  }

  update(_dt: number): void {
    if (!this.dirty) return;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
    this.dirty = false;
  }

  clear(): void {
    this.col.fill(0);
    this.pos.fill(0);
    this.head = 0;
    for (const t of this.trails.values()) t.active = false;
    this.dirty = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}

export function createSkidMarks(): ISkidMarks {
  return new SkidMarks();
}

// -----------------------------------------------------------------------------
// Portals
// -----------------------------------------------------------------------------

const sharedGeo = new Map<string, THREE.BufferGeometry>();
function shared(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = sharedGeo.get(key);
  if (!g) {
    g = make();
    sharedGeo.set(key, g);
  }
  return g;
}

/** Vertical soft light column (unit radius / unit height, aAlpha fading upward). */
function beamColumn(): THREE.BufferGeometry {
  return shared('beamColumn', () => {
    const g = new THREE.CylinderGeometry(0.7, 1, 1, 18, 6, true);
    g.translate(0, 0.5, 0);
    const p = g.getAttribute('position');
    const a = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) a[i] = Math.pow(1 - p.getY(i), 2.2);
    g.setAttribute('aAlpha', new THREE.BufferAttribute(a, 1));
    return g;
  });
}

function iconGeometry(kind: PortalKind | 'lock'): THREE.BufferGeometry {
  return shared(`icon:${kind}`, () => {
    const b = new GeoBuilder();
    const bright = 0xffffff;
    const dim = 0x2a2a2a;
    b.color(bright);
    switch (kind) {
      case 'sprint': {
        b.box(-0.75, -0.1, 0, 0.07, 2.0, 0.07);
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 5; i++) {
            b.color((i + j) % 2 ? dim : bright);
            const wave = Math.sin(i * 0.9) * 0.07;
            b.box(-0.58 + i * 0.28, 0.75 - j * 0.28, wave, 0.28, 0.28, 0.03);
          }
        break;
      }
      case 'circuit': {
        for (const rot of [0, Math.PI]) {
          b.addGeometry(new THREE.TorusGeometry(0.8, 0.075, 6, 20, 2.3), trs(0, 0, 0, 0, 0, rot + 0.3));
          const a = rot + 0.3;
          b.addGeometry(new THREE.ConeGeometry(0.2, 0.42, 8), trs(Math.cos(a) * 0.8, Math.sin(a) * 0.8, 0, 0, 0, a + Math.PI));
        }
        break;
      }
      case 'drift': {
        b.addGeometry(new THREE.TorusGeometry(0.5, 0.2, 8, 22), trs(0, 0, 0));
        b.color(dim);
        b.addGeometry(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 12), trs(0, 0, 0, Math.PI / 2, 0, 0));
        b.color(bright);
        for (let k = 0; k < 3; k++) b.addGeometry(new THREE.TorusGeometry(0.98 + k * 0.02, 0.045, 5, 12, 1.25), trs(0, 0, 0, 0, 0, (k / 3) * Math.PI * 2));
        break;
      }
      case 'drag': {
        b.color(dim);
        b.box(0, -0.15, 0, 0.14, 1.9, 0.12);
        b.box(0, 0.86, 0, 0.6, 0.16, 0.14);
        for (let j = 0; j < 4; j++)
          for (const x of [-0.26, 0.26]) {
            b.color(j === 3 ? 0x66ff66 : bright);
            b.addGeometry(new THREE.SphereGeometry(0.15, 10, 8), trs(x, 0.5 - j * 0.36, 0));
          }
        break;
      }
      case 'speedtrap': {
        b.box(0, 0.25, 0, 0.9, 0.55, 0.5);
        b.color(dim);
        b.addGeometry(new THREE.CylinderGeometry(0.2, 0.24, 0.3, 12), trs(0, 0.25, 0.38, Math.PI / 2, 0, 0));
        b.box(0, -0.6, 0, 0.1, 1.2, 0.1);
        b.color(bright);
        b.box(0, 0.58, 0.05, 1.0, 0.06, 0.62);
        for (let k = 0; k < 2; k++) b.addGeometry(new THREE.TorusGeometry(0.75 + k * 0.3, 0.035, 5, 14, 1.2), trs(0, 0.25, 0.3, 0, -Math.PI / 2, -0.6));
        break;
      }
      case 'garage': {
        // spanner: handle + open jaw + ring end
        const m = trs(0, 0, 0, 0, 0, -0.7);
        b.setTransform(m);
        b.box(0, 0, 0, 0.2, 1.3, 0.09);
        b.addGeometry(new THREE.TorusGeometry(0.26, 0.085, 6, 16), trs(0, -0.85, 0));
        b.box(-0.2, 0.86, 0, 0.14, 0.46, 0.09);
        b.box(0.2, 0.86, 0, 0.14, 0.46, 0.09);
        b.box(0, 0.66, 0, 0.5, 0.16, 0.09);
        b.setTransform(null);
        break;
      }
      default: {
        // padlock
        b.box(0, -0.25, 0, 1.0, 0.8, 0.3);
        b.addGeometry(new THREE.TorusGeometry(0.33, 0.085, 8, 16, Math.PI), trs(0, 0.15, 0));
        b.box(-0.33, 0.1, 0, 0.17, 0.2, 0.17);
        b.box(0.33, 0.1, 0, 0.17, 0.2, 0.17);
        b.color(dim);
        b.addGeometry(new THREE.CylinderGeometry(0.1, 0.1, 0.34, 10), trs(0, -0.2, 0, Math.PI / 2, 0, 0));
        break;
      }
    }
    return b.build({ crease: 40, mat: false, uv: false });
  });
}

const LOCKED_COLOR = new THREE.Color(0.75, 0.2, 0.17);

class Portal implements PortalModel {
  readonly group = new THREE.Group();
  private readonly base: THREE.Color;
  private readonly neon: THREE.MeshBasicMaterial;
  private readonly ring: THREE.MeshBasicMaterial;
  private readonly iconMat: THREE.MeshBasicMaterial;
  private readonly beam: BeamMaterial;
  private readonly icon: THREE.Mesh;
  private readonly lock: THREE.Mesh;
  private readonly spin = new THREE.Group();
  private locked = false;
  private highlighted = false;
  private phase = 0;

  constructor(kind: PortalKind) {
    this.base = new THREE.Color(kind === 'garage' ? GARAGE_COLOR : MODE_INFO[kind].color);
    this.neon = new THREE.MeshBasicMaterial({ fog: false });
    this.ring = new THREE.MeshBasicMaterial({ transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.iconMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92, fog: false });
    this.beam = createBeamMaterial(this.base, 0.3, true);
    // arch (7 m wide) + inner arch + feet
    const arch = shared('portalArch', () => {
      const b = new GeoBuilder();
      b.addGeometry(new THREE.TorusGeometry(3.5, 0.1, 8, 40, Math.PI), trs(0, 0.5, 0));
      b.addGeometry(new THREE.TorusGeometry(3.15, 0.045, 6, 36, Math.PI), trs(0, 0.5, 0));
      for (const x of [-3.5, 3.5]) b.box(x, 0.25, 0, 0.2, 0.5, 0.2);
      for (const x of [-3.15, 3.15]) b.box(x, 0.25, 0, 0.09, 0.5, 0.09);
      return b.build({ mat: false, uv: false, color: false });
    });
    this.group.add(new THREE.Mesh(arch, this.neon));
    const feet = shared('portalFeet', () => {
      const b = new GeoBuilder();
      for (const x of [-3.35, 3.35]) b.box(x, 0.09, 0, 0.9, 0.18, 0.7);
      return b.build({ mat: false, uv: false, color: false });
    });
    this.group.add(new THREE.Mesh(feet, sharedDarkMaterial()));
    // ground ring
    const ringGeo = shared('portalRing', () => {
      const b = new GeoBuilder();
      b.addGeometry(new THREE.RingGeometry(3.25, 3.7, 56), trs(0, 0.05, 0, -Math.PI / 2, 0, 0));
      b.addGeometry(new THREE.RingGeometry(2.2, 2.3, 48), trs(0, 0.05, 0, -Math.PI / 2, 0, 0));
      for (let k = 0; k < 8; k++) b.addGeometry(new THREE.PlaneGeometry(0.14, 0.7), trs(0, 0.05, 0, 0, (k / 8) * Math.PI * 2, 0).multiply(trs(0, 0, 2.78, -Math.PI / 2, 0, 0)));
      return b.build({ mat: false, uv: false, color: false });
    });
    const ringMesh = new THREE.Mesh(ringGeo, this.ring);
    ringMesh.renderOrder = -1;
    this.group.add(ringMesh);
    // far-visible light beam
    const col = new THREE.Mesh(beamColumn(), this.beam);
    col.scale.set(1.3, 75, 1.3);
    col.renderOrder = 6;
    this.group.add(col);
    // holographic icon
    this.icon = new THREE.Mesh(iconGeometry(kind), this.iconMat);
    this.lock = new THREE.Mesh(iconGeometry('lock'), this.iconMat);
    this.lock.visible = false;
    this.spin.position.y = 2.35;
    this.spin.add(this.icon, this.lock);
    this.group.add(this.spin);
    this.update(0, 0);
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.icon.visible = !locked;
    this.lock.visible = locked;
  }

  setHighlighted(on: boolean): void {
    this.highlighted = on;
  }

  update(dt: number, time: number): void {
    const speed = this.highlighted ? 7 : 2.4;
    this.phase += dt * speed;
    const pulse = 0.78 + 0.22 * Math.sin(this.phase + time * 0.001);
    const gain = (this.highlighted ? 1.3 : 1) * pulse * (this.locked ? 0.7 : 1);
    const c = this.locked ? LOCKED_COLOR : this.base;
    this.neon.color.copy(c).multiplyScalar(1.45 * gain);
    this.ring.color.copy(c).multiplyScalar(0.6 * gain);
    this.iconMat.color.copy(c).multiplyScalar(1.25 * gain);
    this.beam.uniforms.uColor.value.copy(c);
    this.beam.uniforms.uIntensity.value = (this.locked ? 0.08 : 0.16) * gain;
    this.spin.rotation.y += dt * (this.highlighted ? 2.6 : 1.1);
    this.spin.position.y = 2.35 + Math.sin(this.phase * 0.5) * 0.08;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.neon.dispose();
    this.ring.dispose();
    this.iconMat.dispose();
    this.beam.dispose();
  }
}

let darkMat: THREE.MeshStandardMaterial | null = null;
function sharedDarkMaterial(): THREE.MeshStandardMaterial {
  if (!darkMat) darkMat = new THREE.MeshStandardMaterial({ color: 0x0c0d10, roughness: 0.6, metalness: 0.5 });
  return darkMat;
}

export function createPortal(kind: PortalKind): PortalModel {
  return new Portal(kind);
}

// -----------------------------------------------------------------------------
// Checkpoints
// -----------------------------------------------------------------------------

let chevronTex: THREE.CanvasTexture | null = null;
function chevronTexture(): THREE.CanvasTexture {
  if (!chevronTex) {
    chevronTex = canvasTexture(
      128,
      128,
      (ctx, w, h) => {
        ctx.clearRect(0, 0, w, h);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 15;
        ctx.lineJoin = 'miter';
        for (const y0 of [16, 80]) {
          ctx.beginPath();
          ctx.moveTo(10, y0 + 38);
          ctx.lineTo(64, y0);
          ctx.lineTo(118, y0 + 38);
          ctx.stroke();
        }
      },
      { repeat: true },
    );
  }
  return chevronTex;
}

let checkerTex: THREE.CanvasTexture | null = null;
function checkerTexture(): THREE.CanvasTexture {
  if (!checkerTex) {
    checkerTex = canvasTexture(
      64,
      64,
      (ctx) => {
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) {
            ctx.fillStyle = (i + j) % 2 ? '#0a0a0a' : '#ffffff';
            ctx.fillRect(i * 32, j * 32, 32, 32);
          }
      },
      { repeat: true },
    );
    checkerTex.magFilter = THREE.NearestFilter;
  }
  return checkerTex;
}

const LOOK_COLOR: Record<Exclude<CheckpointLook, 'hidden'>, THREE.Color> = {
  next: new THREE.Color(0x2ff0ff),
  upcoming: new THREE.Color(0x5a4bff),
  finish: new THREE.Color(0xffd35a),
  speedtrap: new THREE.Color(MODE_INFO.speedtrap.color),
};

class Checkpoint implements CheckpointModel {
  readonly group = new THREE.Group();
  private look: CheckpointLook = 'upcoming';
  private readonly neon = new THREE.MeshBasicMaterial({ fog: false });
  private readonly curtain: BeamMaterial;
  private readonly chevMat: THREE.MeshBasicMaterial;
  private readonly bannerMat: THREE.MeshBasicMaterial;
  private readonly flashMat = new THREE.MeshBasicMaterial({ fog: false });
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly chevrons: THREE.Mesh;
  private readonly banner: THREE.Mesh;
  private readonly gantry: THREE.Group;
  private readonly curtainMesh: THREE.Mesh;

  constructor(width: number) {
    const hw = width / 2;
    const H = 4.6;
    // pylons + top beam
    const b = new GeoBuilder();
    for (const x of [-hw, hw]) {
      b.addGeometry(new THREE.CylinderGeometry(0.13, 0.17, H, 10), trs(x, H / 2, 0));
      b.addGeometry(new THREE.CylinderGeometry(0.3, 0.36, 0.3, 10), trs(x, 0.15, 0));
    }
    b.box(0, H, 0, width + 0.3, 0.12, 0.12);
    const frame = b.build({ mat: false, uv: false, color: false });
    this.geos.push(frame);
    this.group.add(new THREE.Mesh(frame, this.neon));
    // light curtain
    const cg = new THREE.PlaneGeometry(width, H, 1, 4);
    cg.translate(0, H / 2, 0);
    const cp = cg.getAttribute('position');
    const ca = new Float32Array(cp.count);
    for (let i = 0; i < cp.count; i++) ca[i] = 0.03 + 0.2 * Math.pow(1 - cp.getY(i) / H, 2);
    cg.setAttribute('aAlpha', new THREE.BufferAttribute(ca, 1));
    this.geos.push(cg);
    this.curtain = createBeamMaterial(0xffffff, 1, false);
    this.curtainMesh = new THREE.Mesh(cg, this.curtain);
    this.curtainMesh.renderOrder = 6;
    this.group.add(this.curtainMesh);
    // chevrons on the road (pointing along +Z)
    const chev = new THREE.PlaneGeometry(width * 0.8, 6);
    chev.rotateX(-Math.PI / 2);
    const uv = chev.getAttribute('uv');
    const rep = Math.max(1, Math.round((width * 0.8) / 2.4));
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * 2.5);
    chev.translate(0, 0.06, 0);
    this.geos.push(chev);
    this.chevMat = new THREE.MeshBasicMaterial({ map: chevronTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, fog: false });
    this.chevrons = new THREE.Mesh(chev, this.chevMat);
    this.chevrons.renderOrder = -1;
    this.group.add(this.chevrons);
    // finish banner
    const bg = new THREE.PlaneGeometry(width, 1.0);
    const buv = bg.getAttribute('uv');
    for (let i = 0; i < buv.count; i++) buv.setXY(i, buv.getX(i) * Math.round(width / 0.5) * 0.5, buv.getY(i));
    bg.translate(0, H - 0.6, 0);
    this.geos.push(bg);
    this.bannerMat = new THREE.MeshBasicMaterial({ map: checkerTexture(), side: THREE.DoubleSide, fog: false });
    this.bannerMat.color.setScalar(1.25);
    this.banner = new THREE.Mesh(bg, this.bannerMat);
    this.group.add(this.banner);
    // speed-trap gantry: truss, two cameras, flash
    this.gantry = new THREE.Group();
    const gb = new GeoBuilder();
    gb.color(0x1a1c20);
    gb.box(0, H + 0.4, 0, width + 0.6, 0.1, 0.5);
    gb.box(0, H + 0.75, 0, width + 0.6, 0.1, 0.5);
    for (let x = -hw; x <= hw + 0.01; x += Math.max(1, width / 8)) gb.box(x, H + 0.58, 0, 0.07, 0.36, 0.07);
    for (const x of [-hw * 0.45, hw * 0.45]) {
      gb.color(0x2c2f36);
      gb.box(x, H + 0.12, -0.1, 0.5, 0.34, 0.6);
      gb.color(0x050506);
      gb.addGeometry(new THREE.CylinderGeometry(0.11, 0.13, 0.2, 10), trs(x, H + 0.1, -0.46, Math.PI / 2, 0, 0));
    }
    const gg = gb.build({ mat: false, uv: false });
    this.geos.push(gg);
    this.gantry.add(new THREE.Mesh(gg, sharedGantryMaterial()));
    const fg = new THREE.SphereGeometry(0.2, 10, 8);
    fg.translate(0, H + 0.12, -0.2);
    this.geos.push(fg);
    this.gantry.add(new THREE.Mesh(fg, this.flashMat));
    this.group.add(this.gantry);
    this.setLook('upcoming');
  }

  setLook(look: CheckpointLook): void {
    this.look = look;
    this.group.visible = look !== 'hidden';
    this.chevrons.visible = look === 'next';
    this.banner.visible = look === 'finish';
    this.gantry.visible = look === 'speedtrap';
    this.update(0, 0);
  }

  update(_dt: number, time: number): void {
    const look = this.look;
    if (look === 'hidden') return;
    const c = LOOK_COLOR[look];
    const pulse = 0.8 + 0.2 * Math.sin(time * 5);
    const gain = look === 'next' ? 2.8 * pulse : look === 'upcoming' ? 0.55 : look === 'finish' ? 2.2 : 2.0 * pulse;
    this.neon.color.copy(c).multiplyScalar(gain);
    this.curtain.uniforms.uColor.value.copy(c);
    this.curtain.uniforms.uIntensity.value = look === 'upcoming' ? 0.35 : 1.1 * pulse;
    if (look === 'next') {
      this.chevMat.color.copy(c).multiplyScalar(1.2 * pulse);
      // shared scrolling offset: chevrons flow toward +Z
      chevronTexture().offset.y = (time * 0.9) % 1;
    }
    if (look === 'speedtrap') {
      const f = (time * 1.6) % 1 < 0.08 ? 9 : 0.35;
      this.flashMat.color.setRGB(f, f, f * 1.1);
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.neon.dispose();
    this.curtain.dispose();
    this.chevMat.dispose();
    this.bannerMat.dispose();
    this.flashMat.dispose();
  }
}

let gantryMat: THREE.MeshStandardMaterial | null = null;
function sharedGantryMaterial(): THREE.MeshStandardMaterial {
  if (!gantryMat) gantryMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.6 });
  return gantryMat;
}

export function createCheckpoint(width: number): CheckpointModel {
  return new Checkpoint(width);
}

// -----------------------------------------------------------------------------
// Spike strip & police barrier
// -----------------------------------------------------------------------------

/** Flat strip of spikes along local X, centred on the origin. `group.userData.dispose()` frees it. */
export function createSpikeStrip(length: number): THREE.Group {
  const group = new THREE.Group();
  const b = new GeoBuilder();
  b.color(0x111214);
  b.box(0, 0.015, 0, length, 0.03, 0.34);
  b.color(0xb8bcc4);
  const n = Math.max(2, Math.round(length / 0.12));
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + ((i + 0.5) * length) / n;
    for (const z of [-0.09, 0.09]) b.addGeometry(new THREE.ConeGeometry(0.022, 0.085, 4), trs(x + (z > 0 ? 0.03 : -0.03), 0.07, z));
  }
  const geo = b.build({ mat: false, uv: false });
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.85 });
  group.add(new THREE.Mesh(geo, mat));
  group.userData.dispose = (): void => {
    geo.dispose();
    mat.dispose();
  };
  return group;
}

let barrierTex: THREE.CanvasTexture | null = null;
function barrierTexture(): THREE.CanvasTexture {
  if (!barrierTex) {
    barrierTex = canvasTexture(512, 64, (ctx, w, h) => {
      ctx.fillStyle = '#f2f3f5';
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#173a9c';
      for (let x = -h; x < w; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x + 32, h);
        ctx.lineTo(x + 32 + h, 0);
        ctx.lineTo(x + h, 0);
        ctx.fill();
      }
      ctx.fillStyle = '#f2f3f5';
      ctx.fillRect(w / 2 - 110, 8, 220, h - 16);
      ctx.fillStyle = '#0c1433';
      ctx.font = `900 40px ${FONTS.display}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('POLICE', w / 2, h / 2 + 2);
    });
  }
  return barrierTex;
}

const lampA = new THREE.MeshBasicMaterial({ fog: false });
const lampB = new THREE.MeshBasicMaterial({ fog: false });
function animateBarrierLamps(): void {
  const t = performance.now() * 0.001;
  const ph = (t * 1.8) % 1;
  const a = ph < 0.5 ? ((ph * 6) % 1 < 0.6 ? 1 : 0.15) : 0.05;
  const bb = ph >= 0.5 ? ((ph * 6) % 1 < 0.6 ? 1 : 0.15) : 0.05;
  lampA.color.setRGB(6 * a, 3.2 * a, 0.3 * a);
  lampB.color.setRGB(7 * bb, 0.25 * bb, 0.2 * bb);
}

/** Police barrier along local X (striped boards, A-frame legs, flashing amber / red lamps). */
export function createRoadBarrier(width: number): THREE.Group {
  const group = new THREE.Group();
  const b = new GeoBuilder();
  b.color(0x1a1c20);
  for (const x of [-width / 2 + 0.25, width / 2 - 0.25]) {
    b.hexa(
      [
        [x - 0.05, 0, -0.36],
        [x + 0.05, 0, -0.36],
        [x + 0.05, 0, -0.28],
        [x - 0.05, 0, -0.28],
      ],
      [
        [x - 0.05, 1.12, -0.04],
        [x + 0.05, 1.12, -0.04],
        [x + 0.05, 1.12, 0.04],
        [x - 0.05, 1.12, 0.04],
      ],
    );
    b.hexa(
      [
        [x - 0.05, 0, 0.28],
        [x + 0.05, 0, 0.28],
        [x + 0.05, 0, 0.36],
        [x - 0.05, 0, 0.36],
      ],
      [
        [x - 0.05, 1.12, -0.04],
        [x + 0.05, 1.12, -0.04],
        [x + 0.05, 1.12, 0.04],
        [x - 0.05, 1.12, 0.04],
      ],
    );
  }
  const legs = b.build({ mat: false, uv: false });
  const legMat = sharedGantryMaterial();
  group.add(new THREE.Mesh(legs, legMat));
  // boards
  const boardMat = new THREE.MeshStandardMaterial({ map: barrierTexture(), roughness: 0.6, metalness: 0.1, side: THREE.DoubleSide, emissive: 0x202630, emissiveMap: barrierTexture() });
  const board = new THREE.BoxGeometry(width, 0.3, 0.04);
  const top = new THREE.Mesh(board, boardMat);
  top.position.y = 0.95;
  const low = new THREE.Mesh(board, boardMat);
  low.position.y = 0.5;
  low.scale.y = 0.7;
  group.add(top, low);
  // lamps
  const lamp = new THREE.SphereGeometry(0.1, 10, 8);
  const l1 = new THREE.Mesh(lamp, lampA);
  l1.position.set(-width / 2 + 0.25, 1.24, 0);
  const l2 = new THREE.Mesh(lamp, lampB);
  l2.position.set(width / 2 - 0.25, 1.24, 0);
  l1.onBeforeRender = animateBarrierLamps;
  group.add(l1, l2);
  group.userData.dispose = (): void => {
    legs.dispose();
    board.dispose();
    lamp.dispose();
    boardMat.dispose();
  };
  return group;
}
