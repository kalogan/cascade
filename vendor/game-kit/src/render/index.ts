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

/** Result of one `advance` call: how many fixed steps to run + the new state. */
export interface AdvanceResult {
  /** Number of fixed steps to simulate this frame (clamped to maxSteps). */
  steps: number;
  /** Leftover accumulator (sub-step time carried into the next frame), in seconds. */
  accumulator: number;
  /** Interpolation factor in [0, 1) for rendering between the last two sim states. */
  alpha: number;
}

/**
 * PURE fixed-timestep accumulator step — no RAF, no clock, no side effects.
 *
 * Add the frame's elapsed time to the accumulator, then drain it in whole
 * `fixedDtSec` chunks. Returns the number of steps to run, the leftover
 * accumulator, and the render `alpha` (leftover / fixedDt, in [0, 1)).
 *
 * Spiral-of-death guard: if the accumulator demands more than `maxSteps` steps
 * (e.g. after a long stall or a background-tab freeze), the step count is clamped
 * to `maxSteps` and the unconsumed time is DROPPED so the sim doesn't fall further
 * behind every frame. `alpha` is still computed from the (clamped) leftover.
 *
 * @param accumulatorSec  carried-over time from prior frames, in seconds (≥ 0)
 * @param frameDtSec      this frame's elapsed wall time, in seconds (≥ 0)
 * @param fixedDtSec      fixed simulation step size, in seconds (> 0)
 * @param maxSteps        max steps per call before clamping. Default 5.
 */
export function advance(
  accumulatorSec: number,
  frameDtSec: number,
  fixedDtSec: number,
  maxSteps = 5,
): AdvanceResult {
  if (!(fixedDtSec > 0)) {
    throw new Error('advance: fixedDtSec must be > 0');
  }

  // Guard against NaN / negative frame deltas (e.g. a clock that went backwards).
  const frame = frameDtSec > 0 ? frameDtSec : 0;
  let acc = (accumulatorSec > 0 ? accumulatorSec : 0) + frame;

  let steps = Math.floor(acc / fixedDtSec);

  if (steps > maxSteps) {
    // Spiral-of-death clamp: run at most maxSteps and discard the backlog so we
    // don't accumulate an ever-growing debt. Keep a sub-step remainder for alpha.
    steps = maxSteps;
    acc = acc % fixedDtSec;
  } else {
    acc -= steps * fixedDtSec;
  }

  // alpha is the fractional progress toward the next step, always in [0, 1).
  const alpha = acc / fixedDtSec;

  return { steps, accumulator: acc, alpha };
}

export interface LoopHandle {
  /** Begin ticking on requestAnimationFrame. Idempotent. */
  start(): void;
  /** Stop ticking and cancel any pending frame. Idempotent. */
  stop(): void;
}

export interface CreateLoopOptions {
  /** Fixed simulation frequency in Hz. Default 60. */
  fixedHz?: number;
  /** Max fixed steps per frame before the spiral-of-death clamp. Default 5. */
  maxSteps?: number;
}

interface RafLike {
  requestAnimationFrame(cb: (t: number) => number | void): number;
  cancelAnimationFrame(id: number): void;
  now(): number;
}

/** Resolve RAF + a clock from the host, or null when neither exists (node / SSR). */
function resolveRaf(): RafLike | null {
  const g = globalThis as {
    requestAnimationFrame?: (cb: (t: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
    performance?: { now(): number };
  };
  if (typeof g.requestAnimationFrame !== 'function') return null;
  const caf =
    typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(g) : () => {};
  const now =
    g.performance && typeof g.performance.now === 'function'
      ? g.performance.now.bind(g.performance)
      : () => Date.now();
  return {
    requestAnimationFrame: g.requestAnimationFrame.bind(g),
    cancelAnimationFrame: caf,
    now,
  };
}

/**
 * A fixed-timestep RAF loop. `step(dt, alpha)` is called `steps` times per frame
 * with the fixed `dt` (seconds), then once more is NOT made — rendering reads the
 * latest `alpha` from the final call's argument. (Most callers run sim in `step`
 * and render using `alpha` for interpolation.)
 *
 * Importing this module in a no-RAF environment is safe: `start()` is a no-op
 * there and never throws, so the loop can be constructed under node / SSR.
 */
export function createLoop(
  step: (dt: number, alpha: number) => void,
  opts: CreateLoopOptions = {},
): LoopHandle {
  const fixedHz = opts.fixedHz ?? 60;
  const fixedDt = 1 / fixedHz;
  const maxSteps = opts.maxSteps ?? 5;

  const raf = resolveRaf();
  let rafId: number | null = null;
  let running = false;
  let last = 0;
  let accumulator = 0;

  function frame(): void {
    if (!running || !raf) return;
    const t = raf.now() / 1000; // ms → s
    const frameDt = t - last;
    last = t;

    const result = advance(accumulator, frameDt, fixedDt, maxSteps);
    accumulator = result.accumulator;
    for (let i = 0; i < result.steps; i++) {
      step(fixedDt, result.alpha);
    }

    rafId = raf.requestAnimationFrame(frame) as number;
  }

  return {
    start(): void {
      if (running || !raf) return; // no-RAF env: silently no-op (import-safe).
      running = true;
      last = raf.now() / 1000;
      accumulator = 0;
      rafId = raf.requestAnimationFrame(frame) as number;
    },
    stop(): void {
      running = false;
      if (raf && rafId != null) {
        raf.cancelAnimationFrame(rafId);
        rafId = null;
      }
    },
  };
}
