/**
 * Post-processing pipeline — vanilla three.
 *
 * Wraps an EffectComposer with RenderPass → UnrealBloomPass → OutputPass.
 * Bloom defaults (strength 0.8 / radius 0.6 / threshold 0.4) are in the same
 * ballpark as the shipped storm-break-hockey rig (0.70 / 0.38 / 0.18), tuned a
 * little softer/wider for a general-purpose default.
 *
 * An r3f variant lives in ./r3f.tsx (a <PostFx/> component using
 * @react-three/postprocessing). It consumes the shared BLOOM_DEFAULTS below so
 * vanilla + r3f never drift.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/**
 * Default bloom values, shared between the vanilla `createPostFx` and the r3f
 * `<PostFx/>` so the two never drift.
 */
export const BLOOM_DEFAULTS = {
  strength: 0.8,
  radius: 0.6,
  threshold: 0.4,
} as const;

/**
 * "moody" bloom profile — the postfx companion to the lighting `MOODY` preset.
 *
 * Distilled from storm-break-hockey's play-scene UnrealBloomPass
 * (src/render/ThreeSetup.js): strength 0.70 / radius 0.38 / threshold 0.18.
 * The tight radius keeps the glow close to its source, and the LOW luminance
 * threshold lets bright emissive surfaces punch through an otherwise dark scene
 * without washing out the deep shadows the moody lighting rig relies on.
 */
export const BLOOM_MOODY = {
  strength: 0.7,
  radius: 0.38,
  threshold: 0.18,
} as const;

/** Named bloom presets, keyed by name. `default` is the general-purpose look. */
export const BLOOM_PRESETS = {
  default: BLOOM_DEFAULTS,
  moody: BLOOM_MOODY,
} as const;

export type PostFxPreset = keyof typeof BLOOM_PRESETS;

export interface PostFxOptions {
  /**
   * Named bloom preset to seed values from. Defaults to "default" (the
   * general-purpose look) so existing callers are unaffected. "moody" selects
   * the tight-radius, low-threshold `BLOOM_MOODY` profile. Explicit `bloom`
   * fields still override the chosen preset.
   */
  preset?: PostFxPreset;
  bloom?: {
    strength?: number;
    radius?: number;
    threshold?: number;
  };
}

export interface PostFx {
  /** Render the scene through the composer. */
  render(): void;
  /** Resize the composer's render targets. */
  setSize(width: number, height: number): void;
  /** Dispose the composer and free GPU resources. */
  dispose(): void;
  /** The underlying bloom pass, for runtime tweaks (e.g. spiking strength). */
  readonly bloomPass: UnrealBloomPass;
  /** The underlying composer, for advanced callers. */
  readonly composer: EffectComposer;
}

export function createPostFx(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  opts: PostFxOptions = {},
): PostFx {
  const size = renderer.getSize(new THREE.Vector2());
  const width = size.x || 1;
  const height = size.y || 1;

  const composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const base = BLOOM_PRESETS[opts.preset ?? 'default'];
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    opts.bloom?.strength ?? base.strength,
    opts.bloom?.radius ?? base.radius,
    opts.bloom?.threshold ?? base.threshold,
  );
  composer.addPass(bloomPass);

  // OutputPass handles tone mapping + color-space conversion as the final pass.
  const outputPass = new OutputPass();
  composer.addPass(outputPass);

  composer.setSize(width, height);

  return {
    get bloomPass() {
      return bloomPass;
    },
    get composer() {
      return composer;
    },
    render(): void {
      composer.render();
    },
    setSize(w: number, h: number): void {
      composer.setSize(w, h);
      bloomPass.setSize(w, h);
    },
    dispose(): void {
      composer.dispose();
    },
  };
}
