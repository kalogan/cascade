/**
 * Vanilla-three render bootstrap + a fixed-timestep loop.
 *
 * `createRenderer` mints a WebGLRenderer + Scene with the flags proven across two
 * shipped games (storm-break-hockey ThreeSetup, deceive-me-daddy): pixelRatio
 * capped ≤2, ACES tone mapping, PCF soft shadows on. Antialias defaults OFF so a
 * post-fx composer (which does its own AA via a pass) isn't double-paying for it.
 *
 * `createLoop` is a fixed-timestep accumulator loop on requestAnimationFrame. The
 * accumulator math is factored into the pure, RAF-free `advance` helper so it can
 * be unit-tested exhaustively (step count, leftover accumulator, render alpha, and
 * the spiral-of-death clamp). The loop guards for a no-RAF env so importing this
 * module never throws under node / SSR.
 *
 * three-dependent: imports three (renderer/scene). The `advance` helper is pure.
 */

import * as THREE from 'three';

export interface CreateRendererOptions {
  /** Existing canvas to render into. Omit to let three create one. */
  canvas?: HTMLCanvasElement;
  /** MSAA on the default framebuffer. Default false — post-fx does its own AA. */
  antialias?: boolean;
  /** Upper bound for devicePixelRatio. Default 2 (retina without melting the GPU). */
  pixelRatioCap?: number;
  /** Tone mapping operator. Default ACESFilmicToneMapping. */
  toneMapping?: THREE.ToneMapping;
  /** Shadow map filtering. Default PCFSoftShadowMap. */
  shadowMapType?: THREE.ShadowMapType;
  /** Scene clear / background colour as a hex int. Default 0x000000. */
  clearColor?: number;
}

export interface RenderContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  /** Resize the drawing buffer (re-applies the pixel-ratio cap). */
  setSize(w: number, h: number): void;
  /** Release GPU resources held by the renderer. */
  dispose(): void;
}

/**
 * Build a WebGLRenderer + Scene with shipped-game defaults.
 *
 * Defaults: antialias false, pixelRatio capped ≤2, ACESFilmicToneMapping,
 * PCFSoftShadowMap, shadows enabled.
 */
export function createRenderer(opts: CreateRendererOptions = {}): RenderContext {
  const renderer = new THREE.WebGLRenderer({
    canvas: opts.canvas,
    antialias: opts.antialias ?? false,
  });

  const cap = opts.pixelRatioCap ?? 2;
  const dpr =
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { devicePixelRatio?: number }).devicePixelRatio === 'number'
      ? (globalThis as { devicePixelRatio: number }).devicePixelRatio
      : 1;
  renderer.setPixelRatio(Math.min(dpr, cap));

  renderer.toneMapping = opts.toneMapping ?? THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = opts.shadowMapType ?? THREE.PCFSoftShadowMap;
  renderer.setClearColor(opts.clearColor ?? 0x000000);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(opts.clearColor ?? 0x000000);

  return {
    renderer,
    scene,
    setSize(w: number, h: number): void {
      // false → don't write inline width/height styles onto the canvas; let the
      // host page own layout (matches the ThreeSetup pattern of styling separately).
      renderer.setSize(w, h, false);
      renderer.setPixelRatio(Math.min(dpr, cap));
    },
    dispose(): void {
      renderer.dispose();
    },
  };
}

// The fixed-timestep loop is now the engine-agnostic `loop` module (three-free).
// Re-exported here for backward compatibility — callers importing `advance` /
// `createLoop` from `render` keep working.
export {
  advance,
  createLoop,
  type AdvanceResult,
  type LoopHandle,
  type CreateLoopOptions,
} from '../loop/index.js';
