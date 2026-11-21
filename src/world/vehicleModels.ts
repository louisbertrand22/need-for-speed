/* =============================================================================
 * APEX NOCTURNE — procedural vehicle models (player / rival cars, police,
 * civilian traffic, police helicopter). 100 % generated in code.
 *
 * Local frame of every model: +Z = front, +Y = up, +X = the vehicle's LEFT.
 * ===========================================================================*/
import * as THREE from 'three';
import type {
  CarDimensions,
  CarModel,
  CarModelOptions,
  CarSpec,
  CarVisuals,
  HelicopterModel,
  HelicopterState,
  PoliceKind,
  TrafficKind,
  VehicleVisualState,
} from '../core/types';
import { POLICE_SPECS, TRAFFIC_COLOR_COUNT, TRAFFIC_DIMS, WINDOW_TINTS } from '../game/catalog';
import { clamp, damp, smoothstep } from '../core/math';
import { buildBody, disposeBody, SEG, type BodyBuilder, type BodyDef, type BodyDetail, type BodyGeometry } from './models/carBody';
import { BODY_DEFS, POLICE_DEFS, TRAFFIC_DEFS, trafficDims } from './models/carStyles';
import { GeoBuilder, RefCache, trs, type P3 } from './models/geo';
import {
  applyPaint,
  CH,
  createBeamMaterial,
  createFlameMaterial,
  createGlassMaterial,
  createPaintMaterial,
  createPartsMaterial,
  PART,
  setChannel,
  type BeamMaterial,
  type FlameMaterial,
  type GlassMaterial,
  type PaintMaterial,
  type PartsMaterial,
} from './models/materials';
import { atlasRect, getBlobShadowTexture, getGlowTexture, getNeonPoolTexture } from './models/textures';
import { addWheel, buildCaliperGeometry, buildWheelGeometry } from './models/wheels';

// -----------------------------------------------------------------------------
// Shared resources
// -----------------------------------------------------------------------------

const bodyCache = new RefCache<BodyGeometry>(disposeBody);
const wheelCache = new RefCache<THREE.BufferGeometry>((g) => g.dispose());

let unitQuad: THREE.PlaneGeometry | null = null;
/** 1 x 1 quad lying on the ground (XZ plane, +Y normal). Shared, never disposed. */
function groundQuad(): THREE.PlaneGeometry {
  if (!unitQuad) {
    unitQuad = new THREE.PlaneGeometry(1, 1);
    unitQuad.rotateX(-Math.PI / 2);
  }
  return unitQuad;
}

let shadowMaterial: THREE.MeshBasicMaterial | null = null;
function blobShadowMaterial(): THREE.MeshBasicMaterial {
  if (!shadowMaterial) {
    shadowMaterial = new THREE.MeshBasicMaterial({
      map: getBlobShadowTexture(),
      color: 0x000000,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  }
  return shadowMaterial;
}

function makeShadow(width: number, length: number): THREE.Mesh {
  const m = new THREE.Mesh(groundQuad(), blobShadowMaterial());
  m.scale.set(width * 1.3, 1, length * 1.16);
  m.position.y = 0.02;
  m.renderOrder = -2;
  return m;
}

const C_HEAD = new THREE.Color(1, 0.93, 0.8);
const C_TAIL = new THREE.Color(1, 0.04, 0.02);
const C_WHITE = new THREE.Color(1, 1, 1);
const C_DRL = new THREE.Color(0.8, 0.9, 1);
const C_RED = new THREE.Color(1, 0.02, 0.02);
const C_BLUE = new THREE.Color(0.05, 0.2, 1);
const C_AMBER = new THREE.Color(1, 0.62, 0.1);
const _col = new THREE.Color();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Additive beam cones from the lamps + a light pool on the road (one mesh, per-vertex brightness). */
function buildBeamGeometry(lamps: readonly P3[], zNose: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const alpha: number[] = [];
  const idx: number[] = [];
  // cones
  const seg = 10;
  const len = 8;
  for (const l of lamps) {
    const base = pos.length / 3;
    pos.push(l[0], l[1], l[2]);
    nor.push(0, 0, -1);
    alpha.push(0.1);
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const cx = Math.cos(a);
      const sy = Math.sin(a);
      pos.push(l[0] + cx * 1.5, Math.max(0.06, l[1] - 0.45 + sy * 0.75), l[2] + len);
      nor.push(cx, sy, -0.15);
      alpha.push(0);
    }
    for (let i = 0; i < seg; i++) idx.push(base, base + 1 + i, base + 2 + i);
  }
  // pool
  const nx = 8;
  const nz = 12;
  const base = pos.length / 3;
  const z0 = zNose + 0.6;
  for (let j = 0; j <= nz; j++) {
    const u = j / nz;
    const z = z0 + u * 26;
    const half = 1.4 + u * 6;
    for (let i = 0; i <= nx; i++) {
      const t = (i / nx) * 2 - 1;
      pos.push(t * half, 0.05, z);
      nor.push(0, 1, 0);
      const edge = i === 0 || i === nx || j === 0 || j === nz ? 0 : 1;
      alpha.push(edge * Math.exp(-t * t * 3.2) * (1 - t * t) * (1 - t * t) * smoothstep(0, 0.2, u) * Math.pow(1 - u, 1.6) * 0.5);
    }
  }
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const a = base + j * (nx + 1) + i;
      idx.push(a, a + nx + 1, a + 1, a + 1, a + nx + 1, a + nx + 2);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alpha, 1));
  g.setIndex(idx);
  return g;
}

/** Flame cones (core + plume) for every exhaust tip; see createFlameMaterial for the attribute layout. */
function buildFlameGeometry(tips: readonly P3[], radius: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const fl: number[] = [];
  const idx: number[] = [];
  const seg = 8;
  tips.forEach((tip, ti) => {
    for (let layer = 0; layer < 2; layer++) {
      const r = radius * (layer === 0 ? 0.55 : 1.15);
      const length = layer === 0 ? 0.7 : 1.25;
      const base = pos.length / 3;
      const rings = [0, 0.3, 0.65, 1];
      const widths = [1, 1.25, 0.75, 0];
      for (let k = 0; k < rings.length; k++)
        for (let i = 0; i <= seg; i++) {
          const a = (i / seg) * Math.PI * 2;
          pos.push(tip[0] + Math.cos(a) * r * widths[k], tip[1] + Math.sin(a) * r * widths[k], tip[2]);
          fl.push(rings[k], layer, ti * 2.7 + layer, length);
        }
      for (let k = 0; k < rings.length - 1; k++)
        for (let i = 0; i < seg; i++) {
          const a = base + k * (seg + 1) + i;
          idx.push(a, a + seg + 1, a + 1, a + 1, a + seg + 1, a + seg + 2);
        }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aFlame', new THREE.Float32BufferAttribute(fl, 4));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.4, tips[0]?.[2] ?? 0), 3);
  return g;
}

// -----------------------------------------------------------------------------
// Car model (player, rivals, police)
// -----------------------------------------------------------------------------

interface CarParams {
  key: string;
  def: BodyDef;
  dims: CarDimensions;
  visuals: CarVisuals;
  detail: 'high' | 'low';
  realHeadlights: boolean;
  exhaustCount: number;
  police: PoliceKind | null;
}

const POLICE_VISUALS: CarVisuals = {
  paintColor: '#ffffff',
  paintFinish: 'metallic',
  rimStyle: 0,
  rimColor: '#1a1b1e',
  spoiler: 0,
  bodyKit: 0,
  neonColor: null,
  windowTint: 2,
  nitroColor: '#3aa0ff',
};

function policeExtras(kind: PoliceKind): (b: BodyBuilder) => void {
  return (b) => {
    const s = b.s;
    const p = b.parts;
    const zRoof = s.zOf(b.def.roofF + (b.def.roofR - b.def.roofF) * (kind === 'suv' ? 0.25 : 0.45));
    const c = s.section(zRoof);
    const half = c.wg1 * 0.78;
    const y = s.topY(zRoof, half * 0.6) + 0.015;
    p.setPart(PART.body).channel(CH.none);
    // light bar
    p.paint(0x08080a, 0.5, 0.2);
    p.box(0, y + 0.02, zRoof, half * 2.1, 0.04, 0.3);
    p.color(0x5a0a0a).surface(0.2, 0.2).channel(CH.red);
    p.box(half * 0.56, y + 0.085, zRoof, half * 0.86, 0.1, 0.24);
    p.color(0x0a1a5a).channel(CH.blue);
    p.box(-half * 0.56, y + 0.085, zRoof, half * 0.86, 0.1, 0.24);
    p.color(0xd8dce4).channel(CH.drl);
    p.box(0, y + 0.08, zRoof, half * 0.2, 0.09, 0.22);
    p.channel(CH.none);
    // liveries: POLICE on the doors, PSPD on the rear quarters, unit number on the roof
    const zDoorA = s.zCowl - 0.3;
    const zDoorB = s.zOf(b.def.pillars[b.def.pillars.length - 1] ?? b.def.sideGlassEnd) - 0.1;
    const cd = s.section((zDoorA + zDoorB) / 2);
    const yMid = cd.yb + (cd.ys - cd.yb) * 0.52;
    const hText = Math.min(0.2, (cd.ys - cd.yb) * 0.3);
    const lenText = Math.min(zDoorA - zDoorB, hText * 4.6);
    const zc = (zDoorA + zDoorB) / 2;
    p.color(0xffffff).surface(0.5, 0);
    let from = p.triangleCount;
    b.rect('side', p, zc + lenText / 2, yMid - hText / 2, zc - lenText / 2, yMid + hText / 2, { nu: 6, nv: 2, tex: 'police', off: 0.004 });
    let r = atlasRect('police');
    p.mirrorX(from, (u, v) => [r.u0 + r.u1 - u, v]);
    const zq = s.axleZ[1] - 0.05;
    const cq = s.section(zq);
    const yq = cq.yb + (cq.ys - cq.yb) * 0.9;
    if (yq - 0.07 > s.axleY + s.archR + 0.02) {
      from = p.triangleCount;
      b.rect('side', p, zq + 0.24, yq - 0.07, zq - 0.24, yq + 0.05, { nu: 4, nv: 1, tex: 'pspd', off: 0.004 });
      r = atlasRect('pspd');
      p.mirrorX(from, (u, v) => [r.u0 + r.u1 - u, v]);
    }
    const zNum = zRoof - 0.55;
    if (zNum > s.zRoofR + 0.25) b.rect('top', p, 0.3, zNum - 0.16, -0.3, zNum + 0.16, { nu: 4, nv: 2, tex: 'unit', off: 0.004 });
    // push bar (SUV)
    if (kind === 'suv') {
      p.paint(0x101114, 0.4, 0.6).setPart(PART.frontBumper);
      const zb = s.zNose + 0.05;
      const cn = s.section(s.zNose - 0.3);
      const y0 = cn.yb + 0.05;
      const y1 = cn.ys - 0.05;
      for (const x of [0.36, -0.36]) p.box(x, (y0 + y1) / 2, zb, 0.07, y1 - y0, 0.07);
      for (const yy of [y0 + 0.08, (y0 + y1) / 2, y1 - 0.06]) p.box(0, yy, zb, 1.15, 0.06, 0.06);
    }
  };
}

class CarModelImpl implements CarModel {
  readonly group = new THREE.Group();
  readonly length: number;
  readonly width: number;
  readonly height: number;

  private readonly params: CarParams;
  private visuals: CarVisuals;
  private readonly body = new THREE.Group();
  private readonly paint: PaintMaterial;
  private readonly parts: PartsMaterial;
  private readonly glass: GlassMaterial;
  private paintMesh: THREE.Mesh | null = null;
  private glassMesh: THREE.Mesh | null = null;
  private partsMesh: THREE.Mesh | null = null;
  private bodyKey = '';
  private geo: BodyGeometry | null = null;
  private wheelKeys: string[] = [];
  private readonly wheelPivots: THREE.Group[] = [];
  private readonly wheelSpins: THREE.Group[] = [];
  private caliperGeos: THREE.BufferGeometry[] = [];
  private readonly shadow: THREE.Mesh;
  private neonPool: THREE.Mesh | null = null;
  private neonMat: THREE.MeshBasicMaterial | null = null;
  private beams: THREE.Mesh | null = null;
  private beamMat: BeamMaterial | null = null;
  private flames: THREE.Mesh | null = null;
  private flameMat: FlameMaterial | null = null;
  private readonly spots: THREE.SpotLight[] = [];
  private readonly sirenSprites: THREE.Sprite[] = [];
  private sirenMats: THREE.SpriteMaterial[] = [];
  private headlightsOn = true;
  private sirenOn = false;
  private spin = 0;
  private time = 0;
  private damage = -1;
  private nitro = 0;
  private readonly neonColor = new THREE.Color();

  constructor(params: CarParams) {
    this.params = params;
    this.visuals = { ...params.visuals };
    this.length = params.dims.length;
    this.width = params.dims.width;
    this.height = params.dims.height;
    this.paint = createPaintMaterial(params.visuals.paintColor, params.visuals.paintFinish, this.length / 2);
    this.parts = createPartsMaterial();
    this.parts.userData.part.uPartMat.value = this.paint.userData.part.uPartMat.value;
    this.glass = createGlassMaterial(0.5);
    if (params.police) {
      this.paint.metalness = 0.35;
      this.paint.roughness = 0.32;
    }
    this.group.add(this.body);
    this.shadow = makeShadow(this.width, this.length);
    this.group.add(this.shadow);
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      const spin = new THREE.Group();
      pivot.add(spin);
      this.group.add(pivot);
      this.wheelPivots.push(pivot);
      this.wheelSpins.push(spin);
    }
    if (params.realHeadlights) {
      for (let i = 0; i < 2; i++) {
        const l = new THREE.SpotLight(0xfff0d8, 0, 68, 0.5, 0.75, 1.5);
        l.castShadow = false;
        this.group.add(l);
        this.group.add(l.target);
        this.spots.push(l);
      }
    }
    if (params.police) {
      const tex = getGlowTexture();
      for (const c of [C_RED, C_BLUE]) {
        const m = new THREE.SpriteMaterial({ map: tex, color: c.clone().multiplyScalar(4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
        const sp = new THREE.Sprite(m);
        sp.scale.setScalar(3.4);
        sp.visible = false;
        this.group.add(sp);
        this.sirenSprites.push(sp);
        this.sirenMats.push(m);
      }
    }
    this.rebuildBody();
    this.rebuildWheels();
    this.applyLook();
    this.applyDamage(0);
    this.updateLamps(0, false);
  }

  // ---------------------------------------------------------------------------

  private rebuildBody(): void {
    const p = this.params;
    const v = this.visuals;
    const key = `${p.key}|${v.bodyKit}|${v.spoiler}|${p.detail}`;
    if (key === this.bodyKey) return;
    const def = p.def;
    const geo = bodyCache.acquire(key, () =>
      buildBody(def, p.dims, {
        detail: p.detail as BodyDetail,
        kit: v.bodyKit,
        spoiler: v.spoiler,
        exhaustCount: p.exhaustCount,
        interior: p.detail === 'high',
        livery: p.police
          ? (() => {
              const zA = p.dims.length / 2 - def.cowl * p.dims.length - 0.05;
              const zB = p.dims.length / 2 - (def.pillars[def.pillars.length - 1] ?? def.sideGlassEnd) * p.dims.length - 0.3;
              return (seg: number, z: number) => (seg === SEG.side && z < zA && z > zB ? 0xf2f3f5 : 0x0b0c10);
            })()
          : undefined,
        extraParts: p.police ? policeExtras(p.police) : undefined,
      }),
    );
    if (this.bodyKey) bodyCache.release(this.bodyKey);
    this.bodyKey = key;
    this.geo = geo;
    if (!this.paintMesh) {
      this.paintMesh = new THREE.Mesh(geo.paint, this.paint);
      this.partsMesh = new THREE.Mesh(geo.parts, this.parts);
      this.body.add(this.paintMesh, this.partsMesh);
    } else {
      this.paintMesh.geometry = geo.paint;
      (this.partsMesh as THREE.Mesh).geometry = geo.parts;
    }
    if (geo.glass) {
      if (!this.glassMesh) {
        this.glassMesh = new THREE.Mesh(geo.glass, this.glass);
        this.glassMesh.renderOrder = 2;
        this.body.add(this.glassMesh);
      } else this.glassMesh.geometry = geo.glass;
    }
    const m = geo.metrics;
    // beams
    this.beams?.geometry.dispose();
    if (!this.beams) {
      this.beamMat = createBeamMaterial(C_HEAD, 0, true);
      this.beams = new THREE.Mesh(buildBeamGeometry(m.headlights, this.length / 2), this.beamMat);
      this.beams.frustumCulled = false;
      this.beams.renderOrder = 3;
      this.group.add(this.beams);
    } else this.beams.geometry = buildBeamGeometry(m.headlights, this.length / 2);
    // flames
    this.flames?.geometry.dispose();
    const flameGeo = buildFlameGeometry(m.exhausts, p.def.exhaust.radius);
    if (!this.flames) {
      this.flameMat = createFlameMaterial(this.visuals.nitroColor);
      this.flames = new THREE.Mesh(flameGeo, this.flameMat);
      this.flames.visible = false;
      this.flames.renderOrder = 4;
      this.body.add(this.flames);
    } else this.flames.geometry = flameGeo;
    // real lights
    for (let i = 0; i < this.spots.length; i++) {
      const h = m.headlights[i] ?? m.headlights[0];
      this.spots[i].position.set(h[0] * 0.8, h[1] + 0.05, h[2] - 0.1);
      this.spots[i].target.position.set(h[0] * 0.5, h[1] - 1.5, h[2] + 30);
    }
    for (let i = 0; i < this.sirenSprites.length; i++) {
      this.sirenSprites[i].position.set((i === 0 ? 1 : -1) * m.roofHalfW * 0.5, m.roofY + 0.2, m.roofZ);
    }
  }

  private rebuildWheels(): void {
    const geo = this.geo as BodyGeometry;
    const m = geo.metrics;
    const p = this.params;
    const style = this.visuals.rimStyle;
    const newKeys: string[] = [];
    const geos: THREE.BufferGeometry[] = [];
    for (let k = 0; k < 2; k++) {
      const key = `${m.wheelRadius.toFixed(3)}|${m.tyreW[k].toFixed(3)}|${m.rimRatio}|${style}|${p.detail}`;
      newKeys.push(key);
      geos.push(wheelCache.acquire(key, () => buildWheelGeometry(m.wheelRadius, m.tyreW[k], m.rimRatio, style, p.detail)));
    }
    for (const k of this.wheelKeys) wheelCache.release(k);
    this.wheelKeys = newKeys;
    for (const g of this.caliperGeos) g.dispose();
    this.caliperGeos = [];
    if (p.detail === 'high') for (let k = 0; k < 2; k++) this.caliperGeos.push(buildCaliperGeometry(m.wheelRadius, m.tyreW[k], m.rimRatio, m.caliper, style === 4));
    for (let i = 0; i < 4; i++) {
      const axle = i < 2 ? 0 : 1;
      const left = i % 2 === 0;
      const pivot = this.wheelPivots[i];
      const spin = this.wheelSpins[i];
      pivot.position.set((left ? 1 : -1) * m.wheelX[axle], m.wheelRadius, m.axleZ[axle]);
      let mesh = spin.children[0] as THREE.Mesh | undefined;
      if (!mesh) {
        mesh = new THREE.Mesh(geos[axle], this.parts);
        if (!left) mesh.rotation.y = Math.PI;
        spin.add(mesh);
      } else mesh.geometry = geos[axle];
      let cal = pivot.children[1] as THREE.Mesh | undefined;
      if (this.caliperGeos.length) {
        if (!cal) {
          cal = new THREE.Mesh(this.caliperGeos[axle], this.parts);
          if (!left) cal.rotation.y = Math.PI;
          pivot.add(cal);
        } else cal.geometry = this.caliperGeos[axle];
      }
    }
  }

  /** Paint / rims / neon / tint / nitro colour (no geometry). */
  private applyLook(): void {
    const v = this.visuals;
    if (!this.params.police) applyPaint(this.paint, v.paintColor, v.paintFinish);
    this.parts.userData.tint.set(v.rimColor);
    this.glass.opacity = WINDOW_TINTS[clamp(v.windowTint, 0, WINDOW_TINTS.length - 1)].opacity;
    this.flameMat?.uniforms.uColor.value.set(v.nitroColor);
    if (v.neonColor) {
      this.neonColor.set(v.neonColor);
      setChannel(this.parts, CH.neon, this.neonColor, 3.2);
      if (!this.neonPool) {
        this.neonMat = new THREE.MeshBasicMaterial({
          map: getNeonPoolTexture(),
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -3,
        });
        this.neonPool = new THREE.Mesh(groundQuad(), this.neonMat);
        this.neonPool.scale.set(this.width + 1.7, 1, this.length + 1.5);
        this.neonPool.position.y = 0.035;
        this.neonPool.renderOrder = -1;
        this.group.add(this.neonPool);
      }
      (this.neonMat as THREE.MeshBasicMaterial).color.copy(this.neonColor).multiplyScalar(0.85);
      this.neonPool.visible = true;
    } else {
      setChannel(this.parts, CH.neon, C_WHITE, 0);
      if (this.neonPool) this.neonPool.visible = false;
    }
    setChannel(this.parts, CH.drl, C_DRL, 1.8);
  }

  private applyDamage(d: number): void {
    if (Math.abs(d - this.damage) < 0.004) return;
    this.damage = d;
    const m = (this.geo as BodyGeometry).metrics;
    const mats = this.paint.userData.part.uPartMat.value;
    this.paint.userData.uDamage.value = d;
    this.glass.userData.uCrack.value = smoothstep(0.22, 0.9, d);
    // hood ajar
    const th = 0.17 * smoothstep(0.3, 1, d);
    mats[PART.hood].makeTranslation(m.hoodPivot[0], m.hoodPivot[1], m.hoodPivot[2]).multiply(_m1.makeRotationX(-th)).multiply(_m2.makeTranslation(-m.hoodPivot[0], -m.hoodPivot[1], -m.hoodPivot[2]));
    // bumpers hanging
    const df = smoothstep(0.15, 0.9, d);
    const pf = m.frontBumperPivot;
    mats[PART.frontBumper]
      .makeTranslation(pf[0], pf[1] - 0.03 * df, pf[2] + 0.02 * df)
      .multiply(_m1.makeRotationFromEuler(new THREE.Euler(0.04 * df, 0.05 * df, 0.085 * df)))
      .multiply(_m2.makeTranslation(-pf[0], -pf[1], -pf[2]));
    const dr = smoothstep(0.4, 1, d);
    const pr = m.rearBumperPivot;
    mats[PART.rearBumper]
      .makeTranslation(pr[0], pr[1] - 0.03 * dr, pr[2] - 0.02 * dr)
      .multiply(_m1.makeRotationFromEuler(new THREE.Euler(-0.03 * dr, 0.04 * dr, 0.08 * dr)))
      .multiply(_m2.makeTranslation(-pr[0], -pr[1], -pr[2]));
    // body skew
    this.body.rotation.set(0.006 * d, 0.012 * d, 0.014 * d);
  }

  private updateLamps(brake: number, reverse: boolean): void {
    const on = this.headlightsOn;
    const d = Math.max(0, this.damage);
    let l = on ? 5.5 : 0.1;
    let r = l;
    if (this.sirenOn) {
      const ph = (this.time * 2.4) % 1;
      l = ph < 0.5 ? 7 : 1.2;
      r = ph < 0.5 ? 1.2 : 7;
    }
    if (d > 0.8) r = 0;
    else if (d > 0.5 && on) r *= Math.sin(this.time * 37) * Math.sin(this.time * 13.7) > 0.1 ? 1 : 0.08;
    setChannel(this.parts, CH.headL, C_HEAD, l);
    setChannel(this.parts, CH.headR, C_HEAD, r);
    setChannel(this.parts, CH.tail, C_TAIL, (on ? 1.3 : 0.25) + brake * 5.5);
    setChannel(this.parts, CH.reverse, C_WHITE, reverse ? 3.5 : 0);
    if (this.beamMat) this.beamMat.uniforms.uIntensity.value = on ? (this.spots.length ? 0.06 : 0.16) : 0;
    if (this.beams) this.beams.visible = on;
    for (let i = 0; i < this.spots.length; i++) this.spots[i].intensity = on ? (i === 1 && d > 0.8 ? 0 : 420) : 0;
    if (this.params.police) {
      let red = 0.15;
      let blue = 0.15;
      if (this.sirenOn) {
        const ph = (this.time * 2.4) % 1;
        const flash = (ph * 4) % 1 < 0.55 ? 1 : 0.1;
        red = ph < 0.5 ? flash : 0.06;
        blue = ph >= 0.5 ? flash : 0.06;
      }
      setChannel(this.parts, CH.red, C_RED, red * 9);
      setChannel(this.parts, CH.blue, C_BLUE, blue * 11);
      for (let i = 0; i < 2; i++) {
        const lvl = i === 0 ? red : blue;
        this.sirenSprites[i].visible = this.sirenOn;
        this.sirenMats[i].color.copy(i === 0 ? C_RED : C_BLUE).multiplyScalar(0.4 + lvl * 4.5);
        this.sirenSprites[i].scale.setScalar(1.6 + lvl * 2.6);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // CarModel
  // ---------------------------------------------------------------------------

  sync(state: VehicleVisualState, dt: number): void {
    this.time += dt;
    const g = this.group;
    g.position.set(state.x, state.y, state.z);
    g.rotation.set(-state.pitch, state.heading, state.roll, 'YXZ');
    const R = this.params.dims.wheelRadius;
    this.spin = (this.spin + (state.speed / R) * dt) % (Math.PI * 2);
    for (let i = 0; i < 4; i++) {
      this.wheelSpins[i].rotation.x = this.spin;
      if (i < 2) this.wheelPivots[i].rotation.y = -state.steerAngle;
    }
    this.applyDamage(clamp(state.damage ?? 0, 0, 1));
    this.updateLamps(clamp(state.brake, 0, 1), state.gear === -1);
    // nitro flames
    this.nitro = damp(this.nitro, state.nitroActive ? 1 : 0, state.nitroActive ? 22 : 12, dt);
    if (this.flames && this.flameMat) {
      this.flames.visible = this.nitro > 0.03;
      this.flameMat.uniforms.uTime.value = this.time;
      this.flameMat.uniforms.uPower.value = this.nitro;
    }
  }

  setVisuals(visuals: CarVisuals): void {
    if (this.params.police) return;
    const prev = this.visuals;
    this.visuals = { ...visuals };
    const bodyChanged = prev.bodyKit !== visuals.bodyKit || prev.spoiler !== visuals.spoiler;
    if (bodyChanged) {
      this.rebuildBody();
      const d = this.damage;
      this.damage = -1;
      this.applyDamage(Math.max(0, d));
    }
    if (bodyChanged || prev.rimStyle !== visuals.rimStyle) this.rebuildWheels();
    this.applyLook();
  }

  setHeadlights(on: boolean): void {
    this.headlightsOn = on;
    this.updateLamps(0, false);
  }

  setSiren(on: boolean): void {
    if (!this.params.police) return;
    this.sirenOn = on;
    this.updateLamps(0, false);
  }

  getExhaustPositions(out: THREE.Vector3[]): number {
    const ex = (this.geo as BodyGeometry).metrics.exhausts;
    this.group.updateWorldMatrix(true, false);
    const n = Math.min(2, ex.length);
    for (let i = 0; i < n; i++) {
      if (!out[i]) out[i] = new THREE.Vector3();
      out[i].set(ex[i][0], ex[i][1], ex[i][2]).applyMatrix4(this.group.matrixWorld);
    }
    return n;
  }

  getWheelPosition(index: number, out: THREE.Vector3): THREE.Vector3 {
    const p = this.wheelPivots[clamp(index | 0, 0, 3)].position;
    this.group.updateWorldMatrix(true, false);
    return out.set(p.x, 0, p.z).applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    this.group.removeFromParent();
    if (this.bodyKey) bodyCache.release(this.bodyKey);
    for (const k of this.wheelKeys) wheelCache.release(k);
    for (const g of this.caliperGeos) g.dispose();
    this.beams?.geometry.dispose();
    this.flames?.geometry.dispose();
    this.paint.dispose();
    this.parts.dispose();
    this.glass.dispose();
    this.beamMat?.dispose();
    this.flameMat?.dispose();
    this.neonMat?.dispose();
    for (const m of this.sirenMats) m.dispose();
    for (const l of this.spots) l.dispose();
    this.bodyKey = '';
    this.wheelKeys = [];
    this.caliperGeos = [];
  }
}

export function createCarModel(spec: CarSpec, visuals: CarVisuals, opts: CarModelOptions = {}): CarModel {
  return new CarModelImpl({
    key: `car:${spec.id}`,
    def: BODY_DEFS[spec.bodyStyle] ?? BODY_DEFS.tuner,
    dims: spec.dims,
    visuals,
    detail: opts.detail ?? 'high',
    realHeadlights: !!opts.realHeadlights,
    exhaustCount: spec.cylinders >= 6 ? 2 : 1,
    police: null,
  });
}

export function createPoliceModel(kind: PoliceKind): CarModel {
  return new CarModelImpl({
    key: `police:${kind}`,
    def: POLICE_DEFS[kind],
    dims: POLICE_SPECS[kind].dims,
    visuals: POLICE_VISUALS,
    detail: 'low',
    realHeadlights: false,
    exhaustCount: 2,
    police: kind,
  });
}

// -----------------------------------------------------------------------------
// Civilian traffic: one merged mesh (body + glass + lamps + wheels) + blob shadow
// -----------------------------------------------------------------------------

const TRAFFIC_COLORS = [0x8d9299, 0x2c2f36, 0xd4d4ce, 0x1d2c4d, 0x5a1f22, 0x1f3d2f, 0x6b5a45, 0x101114];

function trafficExtras(kind: TrafficKind, length: number, fullHeight: number): (b: BodyBuilder) => void {
  return (b) => {
    const s = b.s;
    const p = b.parts;
    p.setPart(PART.body).channel(CH.none);
    // wheels (static, merged)
    const R = b.dims.wheelRadius;
    const axles: number[] = [s.axleZ[0], s.axleZ[1]];
    if (kind === 'truck') axles.push(s.axleZ[1] + R * 2.3);
    axles.forEach((z, i) => {
      const k = i === 0 ? 0 : 1;
      for (const side of [1, -1]) {
        p.setTransform(trs(side * s.wheelX[k], R, z, 0, side > 0 ? 0 : Math.PI, 0));
        addWheel(p, R, s.tyreW[k], 0.62, 0, 'traffic');
      }
    });
    p.setTransform(null);
    p.channel(CH.none).setPart(PART.body);
    if (kind === 'taxi') {
      const z = s.zOf(b.def.roofF + (b.def.roofR - b.def.roofF) * 0.4);
      const y = s.topY(z, 0);
      const r = atlasRect('taxi');
      p.paint(0x111111, 0.6, 0);
      p.box(0, y + 0.07, z, 0.5, 0.14, 0.16);
      p.color(0xffffff).surface(0.4, 0).channel(CH.amber);
      p.quad([-0.24, y + 0.01, z + 0.082], [0.24, y + 0.01, z + 0.082], [0.24, y + 0.13, z + 0.082], [-0.24, y + 0.13, z + 0.082], [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]);
      p.quad([0.24, y + 0.01, z - 0.082], [-0.24, y + 0.01, z - 0.082], [-0.24, y + 0.13, z - 0.082], [0.24, y + 0.13, z - 0.082], [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]);
      p.channel(CH.none);
      // checker band along the doors
      const zA = s.zCowl - 0.1;
      const zB = s.zOf(b.def.sideGlassEnd);
      const c = s.section((zA + zB) / 2);
      const yb = c.yb + (c.ys - c.yb) * 0.62;
      b.mirrored(() => b.rect('side', p, zA, yb, zB, yb + 0.1, { nu: 4, nv: 1, tex: 'checker', off: 0.004 }));
    }
    if (kind === 'truck') {
      // cargo box behind the cab + chassis
      const z0 = s.zOf(0.215);
      const z1 = -length / 2 + 0.05;
      const y0 = s.ride + 0.42;
      const hw = s.halfW;
      p.paint(0xd9dde3, 0.6, 0.1);
      p.box(0, (y0 + fullHeight) / 2, (z0 + z1) / 2, hw * 2, fullHeight - y0, z0 - z1);
      const r = atlasRect('truckA');
      p.color(0xffffff).surface(0.6, 0.1);
      const ya = y0 + 0.25;
      const yb2 = fullHeight - 0.3;
      const zA = z0 - 0.5;
      const zB = z1 + 0.5;
      p.quad([hw + 0.004, ya, zA], [hw + 0.004, ya, zB], [hw + 0.004, yb2, zB], [hw + 0.004, yb2, zA], [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]);
      p.quad([-hw - 0.004, ya, zB], [-hw - 0.004, ya, zA], [-hw - 0.004, yb2, zA], [-hw - 0.004, yb2, zB], [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]);
      // rear lamps on the box
      p.color(0x7a0a0a).surface(0.2, 0.2).channel(CH.tail);
      for (const x of [hw * 0.8, -hw * 0.8]) p.box(x, y0 + 0.1, z1 - 0.01, 0.3, 0.12, 0.04);
      p.channel(CH.none);
    }
    if (kind === 'bus') {
      const r = atlasRect('busSign');
      const c = s.section(s.zNose - 0.5);
      const y = c.yt - 0.42;
      const z = s.zNose + 0.012;
      p.color(0xffffff).surface(0.5, 0).channel(CH.amber);
      p.quad([-0.8, y, z], [0.8, y, z], [0.8, y + 0.28, z], [-0.8, y + 0.28, z], [r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]);
      p.channel(CH.none);
    }
  };
}

class TrafficModelImpl implements CarModel {
  readonly group = new THREE.Group();
  readonly length: number;
  readonly width: number;
  readonly height: number;
  private readonly key: string;
  private readonly mat: PartsMaterial;
  private readonly geo: BodyGeometry;
  private headlightsOn = true;
  private lastBrake = -1;

  constructor(kind: TrafficKind, colorIndex: number) {
    const td = TRAFFIC_DIMS[kind];
    this.length = td.length;
    this.width = td.width;
    this.height = td.height;
    const ci = ((colorIndex % TRAFFIC_COLOR_COUNT) + TRAFFIC_COLOR_COUNT) % TRAFFIC_COLOR_COUNT;
    const color = kind === 'taxi' ? 0xe0b000 : kind === 'bus' ? [0x2a5fa8, 0xb03a2e, 0xd8d8d2, 0x2e7d5b][ci % 4] : TRAFFIC_COLORS[ci % TRAFFIC_COLORS.length];
    this.key = `traffic:${kind}|${kind === 'taxi' ? 0 : ci}`;
    const bodyH = kind === 'truck' ? 2.55 : td.height;
    const dims = trafficDims(kind, td.length, td.width, bodyH);
    this.geo = bodyCache.acquire(this.key, () =>
      buildBody(TRAFFIC_DEFS[kind], dims, {
        detail: 'traffic',
        kit: 0,
        spoiler: 0,
        interior: false,
        exhaustCount: 1,
        livery: () => color,
        mergePaint: [0.36, 0.4],
        extraParts: trafficExtras(kind, td.length, td.height),
      }),
    );
    this.mat = createPartsMaterial();
    const mesh = new THREE.Mesh(this.geo.parts, this.mat);
    this.group.add(mesh);
    this.group.add(makeShadow(this.width, this.length));
    setChannel(this.mat, CH.drl, C_DRL, 1.2);
    setChannel(this.mat, CH.amber, C_AMBER, 2.2);
    this.apply(0, false);
  }

  private apply(brake: number, reverse: boolean): void {
    const on = this.headlightsOn;
    setChannel(this.mat, CH.headL, C_HEAD, on ? 4.5 : 0.1);
    setChannel(this.mat, CH.headR, C_HEAD, on ? 4.5 : 0.1);
    setChannel(this.mat, CH.tail, C_TAIL, (on ? 1.2 : 0.25) + brake * 5);
    setChannel(this.mat, CH.reverse, C_WHITE, reverse ? 3 : 0);
    this.lastBrake = brake;
  }

  sync(state: VehicleVisualState): void {
    this.group.position.set(state.x, state.y, state.z);
    this.group.rotation.set(-state.pitch, state.heading, state.roll, 'YXZ');
    const brake = clamp(state.brake, 0, 1);
    if (Math.abs(brake - this.lastBrake) > 0.02) this.apply(brake, state.gear === -1);
  }

  setVisuals(): void {}

  setHeadlights(on: boolean): void {
    this.headlightsOn = on;
    this.apply(Math.max(0, this.lastBrake), false);
  }

  setSiren(): void {}

  getExhaustPositions(out: THREE.Vector3[]): number {
    const ex = this.geo.metrics.exhausts[0];
    if (!ex) return 0;
    this.group.updateWorldMatrix(true, false);
    if (!out[0]) out[0] = new THREE.Vector3();
    out[0].set(ex[0], ex[1], ex[2]).applyMatrix4(this.group.matrixWorld);
    return 1;
  }

  getWheelPosition(index: number, out: THREE.Vector3): THREE.Vector3 {
    const m = this.geo.metrics;
    const axle = index < 2 ? 0 : 1;
    this.group.updateWorldMatrix(true, false);
    return out.set((index % 2 === 0 ? 1 : -1) * m.wheelX[axle], 0, m.axleZ[axle]).applyMatrix4(this.group.matrixWorld);
  }

  dispose(): void {
    this.group.removeFromParent();
    bodyCache.release(this.key);
    this.mat.dispose();
  }
}

export function createTrafficModel(kind: TrafficKind, colorIndex: number): CarModel {
  return new TrafficModelImpl(kind, colorIndex);
}

// -----------------------------------------------------------------------------
// Police helicopter
// -----------------------------------------------------------------------------

class HelicopterImpl implements HelicopterModel {
  /** Root: stays at the world origin (the craft, its light target and its beam move inside it). */
  readonly group = new THREE.Group();
  private readonly craft = new THREE.Group();
  private readonly rotor = new THREE.Group();
  private readonly tailRotor = new THREE.Group();
  private readonly mat: PartsMaterial;
  private readonly rotorMat: THREE.MeshBasicMaterial;
  private readonly coneMat: BeamMaterial;
  private readonly spotMat: THREE.MeshBasicMaterial;
  private readonly light: THREE.SpotLight;
  private readonly cone: THREE.Mesh;
  private readonly pool: THREE.Mesh;
  private readonly geos: THREE.BufferGeometry[] = [];
  private time = 0;
  private lastX = 0;
  private lastZ = 0;
  private vx = 0;
  private vz = 0;
  private hasPrev = false;

  constructor() {
    const b = new GeoBuilder();
    // fuselage + cockpit glass
    b.paint(0x0c1020, 0.4, 0.4);
    b.addGeometry(new THREE.SphereGeometry(1, 14, 10), trs(0, 0, 0.4, 0, 0, 0, 1.05, 1.0, 2.5));
    b.paint(0x2a3440, 0.06, 0.95);
    b.addGeometry(new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42), trs(0, 0.08, 1.15, Math.PI / 2 - 0.25, 0, 0, 0.98, 1.75, 0.95));
    // white band + engine hump
    b.paint(0xe8eaee, 0.45, 0.2);
    b.box(0, -0.25, 0.2, 2.14, 0.22, 2.2);
    b.paint(0x0c1020, 0.4, 0.4);
    b.addGeometry(new THREE.SphereGeometry(1, 10, 8), trs(0, 0.85, -0.4, 0, 0, 0, 0.6, 0.45, 1.5));
    // tail boom, fin, stabiliser
    b.addGeometry(new THREE.CylinderGeometry(0.34, 0.14, 5.2, 8), trs(0, 0.35, -4.3, Math.PI / 2, 0, 0));
    b.hexa(
      [
        [-0.05, 0.3, -7.1],
        [0.05, 0.3, -7.1],
        [0.05, 0.3, -6.3],
        [-0.05, 0.3, -6.3],
      ],
      [
        [-0.04, 1.7, -7.5],
        [0.04, 1.7, -7.5],
        [0.04, 1.7, -7.0],
        [-0.04, 1.7, -7.0],
      ],
    );
    b.box(0, 0.45, -5.9, 1.9, 0.06, 0.5);
    // skids
    b.paint(0x18191c, 0.5, 0.6);
    for (const x of [0.95, -0.95]) {
      b.tube(
        [
          [x, -1.55, 1.9],
          [x, -1.6, 1.2],
          [x, -1.6, -1.4],
        ],
        0.05,
        5,
      );
      for (const z of [0.9, -0.9]) b.tube([[x * 0.7, -0.8, z], [x, -1.6, z]], 0.04, 5);
    }
    // mast + searchlight pod
    b.addGeometry(new THREE.CylinderGeometry(0.09, 0.09, 0.6, 6), trs(0, 1.45, -0.2));
    b.paint(0x202226, 0.4, 0.6);
    b.addGeometry(new THREE.CylinderGeometry(0.2, 0.26, 0.34, 10), trs(0, -1.12, 1.5));
    b.color(0xf0f4ff).surface(0.2, 0.2).channel(CH.headL);
    b.addGeometry(new THREE.CircleGeometry(0.24, 10), trs(0, -1.3, 1.5, Math.PI / 2, 0, 0));
    // navigation lights: red (left), green (right), white strobe (tail)
    b.color(0xffffff).channel(CH.red);
    b.addGeometry(new THREE.SphereGeometry(0.08, 6, 5), trs(1.08, -0.1, 0.5));
    b.channel(CH.amber);
    b.addGeometry(new THREE.SphereGeometry(0.08, 6, 5), trs(-1.08, -0.1, 0.5));
    b.channel(CH.drl);
    b.addGeometry(new THREE.SphereGeometry(0.09, 6, 5), trs(0, 1.75, -7.3));
    b.addGeometry(new THREE.SphereGeometry(0.09, 6, 5), trs(0, -1.02, -0.6));
    const bodyGeo = b.build({ crease: 50 });
    this.geos.push(bodyGeo);
    this.mat = createPartsMaterial();
    this.craft.add(new THREE.Mesh(bodyGeo, this.mat));

    // rotors: blur disc + two blades
    this.rotorMat = new THREE.MeshBasicMaterial({ color: 0x15181d, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    const disc = new THREE.CircleGeometry(5.6, 28);
    disc.rotateX(-Math.PI / 2);
    const blades = new THREE.BoxGeometry(11.2, 0.04, 0.32);
    this.geos.push(disc, blades);
    this.rotor.add(new THREE.Mesh(disc, this.rotorMat), new THREE.Mesh(blades, this.rotorMat));
    this.rotor.position.set(0, 1.78, -0.2);
    const tdisc = new THREE.CircleGeometry(0.95, 16);
    tdisc.rotateY(Math.PI / 2);
    this.geos.push(tdisc);
    this.tailRotor.add(new THREE.Mesh(tdisc, this.rotorMat));
    this.tailRotor.position.set(0.14, 1.25, -7.2);
    this.craft.add(this.rotor, this.tailRotor);
    this.group.add(this.craft);

    // searchlight: one real spot + visible cone + ground pool
    this.light = new THREE.SpotLight(0xdfe9ff, 0, 0, 0.17, 0.55, 2);
    this.light.castShadow = false;
    this.group.add(this.light, this.light.target);
    const cone = new THREE.CylinderGeometry(0.12, 1, 1, 20, 4, true);
    cone.translate(0, -0.5, 0);
    const pa = cone.getAttribute('position');
    const alpha = new Float32Array(pa.count);
    for (let i = 0; i < pa.count; i++) alpha[i] = 0.22 * Math.pow(1 + pa.getY(i), 2) + 0.035;
    cone.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    this.geos.push(cone);
    this.coneMat = createBeamMaterial(0xcfe0ff, 1, true);
    this.cone = new THREE.Mesh(cone, this.coneMat);
    this.cone.frustumCulled = false;
    this.cone.renderOrder = 5;
    this.spotMat = new THREE.MeshBasicMaterial({ map: getGlowTexture(), color: new THREE.Color(0.55, 0.62, 0.75), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -4 });
    this.pool = new THREE.Mesh(groundQuad(), this.spotMat);
    this.pool.renderOrder = 1;
    this.group.add(this.cone, this.pool);
    this.group.visible = false;
  }

  sync(state: HelicopterState, dt: number, getGroundHeight: (x: number, z: number) => number): void {
    this.group.visible = state.active;
    if (!state.active) {
      this.light.intensity = 0;
      this.hasPrev = false;
      return;
    }
    this.time += dt;
    if (this.hasPrev && dt > 1e-4) {
      this.vx = damp(this.vx, (state.x - this.lastX) / dt, 3, dt);
      this.vz = damp(this.vz, (state.z - this.lastZ) / dt, 3, dt);
    }
    this.lastX = state.x;
    this.lastZ = state.z;
    this.hasPrev = true;
    // tilt into the motion
    const sh = Math.sin(state.heading);
    const ch = Math.cos(state.heading);
    const fwd = this.vx * sh + this.vz * ch;
    const lat = -this.vx * ch + this.vz * sh;
    this.craft.position.set(state.x, state.y, state.z);
    this.craft.rotation.set(clamp(fwd * 0.012, -0.3, 0.3), state.heading, clamp(lat * 0.012, -0.3, 0.3), 'YXZ');
    this.rotor.rotation.y += dt * 38;
    this.tailRotor.rotation.x += dt * 60;
    // lights
    const blink = (this.time * 1.2) % 1 < 0.12 ? 1 : 0;
    setChannel(this.mat, CH.red, C_RED, 4);
    setChannel(this.mat, CH.amber, _col.setRGB(0.05, 1, 0.15), 4);
    setChannel(this.mat, CH.drl, C_WHITE, blink * 9);
    setChannel(this.mat, CH.headL, C_DRL, 7);
    // searchlight
    const gy = getGroundHeight(state.spotX, state.spotZ);
    _v.set(0, -1.3, 1.5).applyEuler(this.craft.rotation).add(this.craft.position);
    this.light.position.copy(_v);
    this.light.target.position.set(state.spotX, gy, state.spotZ);
    this.light.intensity = state.seesPlayer ? 26000 : 17000;
    const dx = state.spotX - _v.x;
    const dy = gy - _v.y;
    const dz = state.spotZ - _v.z;
    const dist = Math.max(1, Math.hypot(dx, dy, dz));
    const rad = dist * Math.tan(0.17) * 0.9;
    this.cone.position.copy(_v);
    this.cone.quaternion.setFromUnitVectors(_v.set(0, -1, 0), _v2.set(dx / dist, dy / dist, dz / dist));
    this.cone.scale.set(rad, dist, rad);
    this.coneMat.uniforms.uIntensity.value = state.seesPlayer ? 1.25 : 0.85;
    this.pool.position.set(state.spotX, gy + 0.09, state.spotZ);
    this.pool.scale.set(rad * 3.2, 1, rad * 3.2);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
    this.rotorMat.dispose();
    this.coneMat.dispose();
    this.spotMat.dispose();
    this.light.dispose();
  }
}

export function createHelicopterModel(): HelicopterModel {
  return new HelicopterImpl();
}
