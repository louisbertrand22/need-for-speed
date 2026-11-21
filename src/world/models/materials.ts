/* =============================================================================
 * Vehicle materials.
 *
 *  - paint   : MeshPhysicalMaterial (metallic / pearl / matte) + damage scuffs,
 *              dents and rigid "damage part" transforms in the vertex shader
 *  - parts   : one MeshStandardMaterial for everything else that is opaque
 *              (trim, interior, lamps, rims, tyres, liveries): colour comes from
 *              vertex colours x atlas, roughness / metalness / emissive channel
 *              from the `aMat` vertex attribute → 1 draw call per mesh
 *  - glass   : tinted glass whose reflections are not faded by its opacity
 *  - flames, light beams, glow quads
 * ===========================================================================*/
import * as THREE from 'three';
import type { PaintFinish } from '../../core/types';
import { getCrackTexture, getFlakeNormalMap, getPartsAtlas } from './textures';

/** Emissive channels of the parts material (index into `uChan`). */
export const CH = {
  none: 0,
  headL: 1,
  headR: 2,
  tail: 3,
  reverse: 4,
  neon: 5,
  drl: 6,
  red: 7,
  blue: 8,
  amber: 9,
} as const;
export const CHANNEL_COUNT = 10;

/** Damage parts (index into `uPartMat`). */
export const PART = { body: 0, hood: 1, frontBumper: 2, rearBumper: 3 } as const;
export const PART_COUNT = 4;

export interface PartUniforms {
  uPartMat: { value: THREE.Matrix4[] };
}

export function createPartUniforms(): PartUniforms {
  return { uPartMat: { value: Array.from({ length: PART_COUNT }, () => new THREE.Matrix4()) } };
}

const PART_PARS_VERTEX = /* glsl */ `
attribute vec4 aMat;
uniform mat4 uPartMat[${PART_COUNT}];
`;

const PART_NORMAL_VERTEX = /* glsl */ `
#include <beginnormal_vertex>
mat4 apexPartM = uPartMat[int(aMat.w + 0.5)];
objectNormal = mat3(apexPartM) * objectNormal;
`;

const PART_BEGIN_VERTEX = /* glsl */ `
#include <begin_vertex>
transformed = (apexPartM * vec4(transformed, 1.0)).xyz;
`;

const NOISE_GLSL = /* glsl */ `
float apexHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float apexNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(apexHash(i), apexHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(apexHash(i + vec3(0.0, 1.0, 0.0)), apexHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(apexHash(i + vec3(0.0, 0.0, 1.0)), apexHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(apexHash(i + vec3(0.0, 1.0, 1.0)), apexHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

// -----------------------------------------------------------------------------
// Paint
// -----------------------------------------------------------------------------

export interface PaintMaterial extends THREE.MeshPhysicalMaterial {
  userData: {
    uDamage: { value: number };
    uHalfLen: { value: number };
    part: PartUniforms;
    finish: PaintFinish;
  };
}

const _hsl = { h: 0, s: 0, l: 0 };

/** Applies colour + finish to an existing paint material (no shader recompilation unless the finish family changes). */
export function applyPaint(mat: PaintMaterial, color: THREE.ColorRepresentation, finish: PaintFinish): void {
  mat.color.set(color);
  mat.userData.finish = finish;
  const flake = getFlakeNormalMap();
  if (finish === 'metallic') {
    mat.metalness = 0.78;
    mat.roughness = 0.3;
    mat.clearcoat = 1;
    mat.clearcoatRoughness = 0.035;
    mat.normalMap = flake;
    mat.normalScale.set(0.16, 0.16);
    mat.iridescence = 0;
    mat.sheen = 0;
    mat.envMapIntensity = 1.35;
  } else if (finish === 'pearl') {
    mat.metalness = 0.48;
    mat.roughness = 0.24;
    mat.clearcoat = 1;
    mat.clearcoatRoughness = 0.02;
    mat.normalMap = flake;
    mat.normalScale.set(0.07, 0.07);
    mat.iridescence = 1;
    mat.iridescenceIOR = 1.75;
    mat.iridescenceThicknessMinimum = 180;
    mat.iridescenceThicknessMaximum = 520;
    mat.sheen = 0.85;
    mat.sheenRoughness = 0.35;
    // colour flip: hue-shifted, lighter sheen
    mat.color.getHSL(_hsl);
    mat.sheenColor.setHSL((_hsl.h + 0.12) % 1, Math.min(1, _hsl.s * 0.9 + 0.2), Math.min(0.8, _hsl.l * 0.6 + 0.35));
    mat.envMapIntensity = 1.75;
  } else {
    mat.metalness = 0.25;
    mat.roughness = 0.82;
    mat.clearcoat = 0;
    mat.clearcoatRoughness = 0.5;
    mat.normalMap = null;
    mat.iridescence = 0;
    mat.sheen = 0.35;
    mat.sheenRoughness = 0.8;
    mat.sheenColor.copy(mat.color).lerp(new THREE.Color(0xffffff), 0.35);
    mat.envMapIntensity = 1.0;
  }
  mat.needsUpdate = true;
}

export function createPaintMaterial(color: THREE.ColorRepresentation, finish: PaintFinish, halfLength: number): PaintMaterial {
  const mat = new THREE.MeshPhysicalMaterial({ vertexColors: true }) as PaintMaterial;
  const uDamage = { value: 0 };
  const uHalfLen = { value: halfLength };
  const part = createPartUniforms();
  mat.userData = { uDamage, uHalfLen, part, finish };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDamage = uDamage;
    shader.uniforms.uHalfLen = uHalfLen;
    shader.uniforms.uPartMat = part.uPartMat;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${PART_PARS_VERTEX}\nuniform float uDamage;\nuniform float uHalfLen;\nvarying vec3 vApexPos;\n${NOISE_GLSL}`,
      )
      .replace('#include <beginnormal_vertex>', PART_NORMAL_VERTEX)
      .replace(
        '#include <begin_vertex>',
        `${PART_BEGIN_VERTEX}
        vApexPos = position;
        if (uDamage > 0.0) {
          float apexEnds = smoothstep(0.35, 1.0, abs(position.z) / uHalfLen);
          float apexDent = apexNoise(position * 4.3 + 11.7) - 0.5;
          transformed += objectNormal * apexDent * 0.085 * uDamage * (0.25 + 0.75 * apexEnds);
        }`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nuniform float uDamage;\nuniform float uHalfLen;\nvarying vec3 vApexPos;\n${NOISE_GLSL}`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float apexScuff = 0.0;
        float apexScratch = 0.0;
        if (uDamage > 0.0) {
          float apexEnds = smoothstep(0.3, 1.0, abs(vApexPos.z) / uHalfLen);
          float apexN = apexNoise(vApexPos * 3.1) * 0.6 + apexNoise(vApexPos * 9.7 + 5.0) * 0.4 + apexEnds * 0.22;
          float apexTh = 1.12 - uDamage * 0.78;
          apexScuff = smoothstep(apexTh, apexTh + 0.1, apexN);
          float apexS = apexNoise(vec3(vApexPos.x * 30.0, vApexPos.y * 170.0, vApexPos.z * 5.0));
          apexScratch = smoothstep(0.8 - uDamage * 0.14, 0.86 - uDamage * 0.14, apexS) * smoothstep(0.05, 0.4, uDamage);
          vec3 apexPrimer = mix(vec3(0.16, 0.155, 0.15), diffuseColor.rgb * 0.25, 0.35);
          diffuseColor.rgb = mix(diffuseColor.rgb, apexPrimer, apexScuff * 0.92);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.42, 0.44), apexScratch * 0.7);
          diffuseColor.rgb *= 1.0 - 0.28 * uDamage;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.95, max(apexScuff, apexScratch * 0.6));
        roughnessFactor = min(1.0, roughnessFactor + uDamage * 0.14);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor *= 1.0 - 0.85 * apexScuff;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        vec3 apexDn = vec3(0.0);
        if (uDamage > 0.0) {
          apexDn = vec3(apexNoise(vApexPos * 6.1 + 13.1), apexNoise(vApexPos * 6.1 + 71.7), apexNoise(vApexPos * 6.1 + 37.3)) - 0.5;
          apexDn *= uDamage * (0.22 + 0.5 * apexScuff);
          normal = normalize(normal + apexDn);
        }`,
      )
      .replace(
        '#include <clearcoat_normal_fragment_begin>',
        `#include <clearcoat_normal_fragment_begin>
        #ifdef USE_CLEARCOAT
          clearcoatNormal = normalize(clearcoatNormal + apexDn * 0.8);
        #endif`,
      )
      .replace(
        '#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= 1.0 - max(apexScuff, apexScratch);
          material.clearcoatRoughness = min(1.0, material.clearcoatRoughness + uDamage * 0.2);
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'apex-paint-v1';
  applyPaint(mat, color, finish);
  return mat;
}

// -----------------------------------------------------------------------------
// Parts (trim / lamps / wheels / liveries)
// -----------------------------------------------------------------------------

export interface PartsMaterial extends THREE.MeshStandardMaterial {
  userData: {
    /** emissive colour x intensity per channel (linear) */
    chan: THREE.Vector3[];
    /** rim tint */
    tint: THREE.Color;
    part: PartUniforms;
  };
}

export function createPartsMaterial(): PartsMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 1,
    map: getPartsAtlas(),
    alphaTest: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  }) as PartsMaterial;
  const chan = Array.from({ length: CHANNEL_COUNT }, () => new THREE.Vector3());
  const tint = new THREE.Color(1, 1, 1);
  const part = createPartUniforms();
  mat.userData = { chan, tint, part };
  mat.envMapIntensity = 1.25;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uChan = { value: chan };
    shader.uniforms.uTint = { value: tint };
    shader.uniforms.uPartMat = part.uPartMat;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\n${PART_PARS_VERTEX}\nuniform vec3 uChan[${CHANNEL_COUNT}];\nvarying vec3 vApexEmis;\nvarying vec3 vApexSurf;`,
      )
      .replace('#include <beginnormal_vertex>', PART_NORMAL_VERTEX)
      .replace(
        '#include <begin_vertex>',
        `${PART_BEGIN_VERTEX}
        vApexEmis = uChan[int(aMat.z + 0.5)];
        vApexSurf = vec3(abs(aMat.x), aMat.y, step(aMat.x, 0.0));`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform vec3 uTint;\nvarying vec3 vApexEmis;\nvarying vec3 vApexSurf;`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), uTint, vApexSurf.z);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        roughnessFactor *= vApexSurf.x;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor *= vApexSurf.y;`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        #ifdef USE_MAP
          totalEmissiveRadiance += vApexEmis * sampledDiffuseColor.rgb;
        #else
          totalEmissiveRadiance += vApexEmis;
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'apex-parts-v1';
  return mat;
}

/** Sets an emissive channel to colour x intensity. */
export function setChannel(mat: PartsMaterial, channel: number, color: THREE.Color, intensity: number): void {
  mat.userData.chan[channel].set(color.r * intensity, color.g * intensity, color.b * intensity);
}

// -----------------------------------------------------------------------------
// Glass
// -----------------------------------------------------------------------------

export interface GlassMaterial extends THREE.MeshPhysicalMaterial {
  userData: { uCrack: { value: number } };
}

export function createGlassMaterial(opacity: number): GlassMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0x05080b,
    roughness: 0.04,
    metalness: 0,
    ior: 1.9,
    transparent: true,
    opacity,
    depthWrite: false,
    premultipliedAlpha: true,
  }) as GlassMaterial;
  mat.envMapIntensity = 1.5;
  const uCrack = { value: 0 };
  const uCrackMap = { value: getCrackTexture() };
  mat.userData = { uCrack };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCrack = uCrack;
    shader.uniforms.uCrackMap = uCrackMap;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vApexUv;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvApexUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCrack;\nuniform sampler2D uCrackMap;\nvarying vec2 vApexUv;')
      .replace(
        '#include <opaque_fragment>',
        `float apexA = diffuseColor.a;
        vec3 apexRgb = (outgoingLight - totalSpecular) * apexA + totalSpecular;
        if (uCrack > 0.0) {
          float apexC = texture2D(uCrackMap, vApexUv * 1.35).r;
          float apexK = smoothstep(1.0 - uCrack, 1.0 - uCrack * 0.55, apexC + uCrack * 0.35) * min(1.0, uCrack * 1.6);
          apexRgb += vec3(0.22, 0.24, 0.26) * apexK;
          apexA = max(apexA, apexK * 0.8);
        }
        gl_FragColor = vec4(apexRgb, apexA);`,
      )
      .replace('#include <premultiplied_alpha_fragment>', '')
      .replace(
        '#include <fog_fragment>',
        `#ifdef USE_FOG
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
          #else
            float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
          #endif
          gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor * gl_FragColor.a, fogFactor );
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => 'apex-glass-v1';
  return mat;
}

// -----------------------------------------------------------------------------
// Nitro flames
// -----------------------------------------------------------------------------

export interface FlameMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uColor: { value: THREE.Color };
    uTime: { value: number };
    uPower: { value: number };
  };
}

/**
 * Geometry convention: `position` = base ring point (flame grows toward local -Z),
 * `aFlame` = (t along the flame 0..1, layer 0 core / 1 plume, phase, nominal length).
 */
export function createFlameMaterial(color: THREE.ColorRepresentation): FlameMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uTime: { value: 0 },
      uPower: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aFlame;
      uniform float uTime;
      uniform float uPower;
      varying vec2 vFlame;
      void main() {
        float ph = aFlame.z;
        float flick = 0.72 + 0.2 * sin(uTime * 61.0 + ph * 7.0) + 0.14 * sin(uTime * 37.0 + ph * 3.1) * sin(uTime * 23.0 + ph);
        float len = aFlame.w * flick * uPower;
        vec3 p = position;
        p.z -= aFlame.x * len;
        float wob = sin(uTime * 43.0 + ph * 5.0 + aFlame.x * 6.0) * 0.012 * aFlame.x;
        p.x += wob;
        p.y += wob * 0.7;
        vFlame = aFlame.xy;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uPower;
      varying vec2 vFlame;
      void main() {
        float t = vFlame.x;
        float fade = pow(1.0 - t, 1.6);
        vec3 core = mix(vec3(1.0), uColor, 0.25) * 5.5;
        vec3 plume = uColor * 2.6;
        vec3 col = mix(core, plume, vFlame.y) * fade * uPower;
        gl_FragColor = vec4(col, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    fog: false,
  }) as unknown as FlameMaterial;
}

// -----------------------------------------------------------------------------
// Additive light beams / pools with per-vertex alpha
// -----------------------------------------------------------------------------

export interface BeamMaterial extends THREE.ShaderMaterial {
  uniforms: {
    uColor: { value: THREE.Color };
    uIntensity: { value: number };
  };
}

/** Additive material: brightness = `aAlpha` vertex attribute x uIntensity, optional view-angle softening for cones. */
export function createBeamMaterial(color: THREE.ColorRepresentation, intensity: number, soft = false): BeamMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uIntensity: { value: intensity },
    },
    vertexShader: /* glsl */ `
      attribute float aAlpha;
      varying float vAlpha;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vAlpha = aAlpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying float vAlpha;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float a = vAlpha * uIntensity;
        ${soft ? 'float f = abs(dot(normalize(vN), normalize(vV))); a *= f * f;' : ''}
        gl_FragColor = vec4(uColor * a, 1.0);
      }`,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    transparent: true,
    side: THREE.DoubleSide,
    fog: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  }) as unknown as BeamMaterial;
}
