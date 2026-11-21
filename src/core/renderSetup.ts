/* Shared renderer / post-processing setup so that every preview harness and the
 * game itself display materials with exactly the same tone mapping and bloom. */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Reference look. Emissive "neon" surfaces should reach a luminance well above
 * `bloomThreshold` (emissiveIntensity ≈ 1.5 – 4); ordinary lit surfaces stay below it.
 */
export const RENDER_LOOK = {
  toneMapping: THREE.ACESFilmicToneMapping,
  exposure: 1.1,
  bloomStrength: 0.6,
  bloomRadius: 0.55,
  bloomThreshold: 0.9,
} as const;

export type RenderQuality = 'low' | 'medium' | 'high';

export function createGameRenderer(canvas: HTMLCanvasElement, quality: RenderQuality = 'high'): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: quality === 'low',
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = RENDER_LOOK.toneMapping;
  renderer.toneMappingExposure = RENDER_LOOK.exposure;
  renderer.shadowMap.enabled = false;
  renderer.setPixelRatio(pixelRatioFor(quality));
  return renderer;
}

export function pixelRatioFor(quality: RenderQuality): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  if (quality === 'low') return Math.min(dpr, 1);
  if (quality === 'medium') return Math.min(dpr, 1.25);
  return Math.min(dpr, 1.75);
}

export interface PostFx {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  setScene(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number, pixelRatio: number): void;
  render(dt: number): void;
  dispose(): void;
}

/** HDR composer: scene → bloom → tone mapping / sRGB output. */
export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: RenderQuality = 'high',
): PostFx {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const target = new THREE.WebGLRenderTarget(Math.max(1, size.x * pr), Math.max(1, size.y * pr), {
    type: THREE.HalfFloatType,
    samples: quality === 'high' ? 4 : 2,
  });
  const composer = new EffectComposer(renderer, target);
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * 0.5, size.y * 0.5),
    RENDER_LOOK.bloomStrength,
    RENDER_LOOK.bloomRadius,
    RENDER_LOOK.bloomThreshold,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return {
    composer,
    bloom,
    setScene(s, c) {
      renderPass.scene = s;
      renderPass.camera = c;
    },
    setSize(width, height, pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(width, height);
    },
    render(dt) {
      composer.render(dt);
    },
    dispose() {
      composer.dispose();
      target.dispose();
    },
  };
}
