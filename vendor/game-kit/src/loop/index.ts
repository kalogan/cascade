/**
 * loop — engine-agnostic fixed-timestep game loop.
 *
 * THREE-FREE, DOM-optional. The accumulator math (`advance`) is PURE — no RAF, no
 * clock, no side effects — so it unit-tests exhaustively (step count, leftover
 * accumulator, interpolation alpha, spiral-of-death clamp). `createLoop` wraps it
 * on `requestAnimationFrame`; importing it in a no-RAF environment (node / SSR)
 * is safe — `start()` is a silent no-op there and never throws.
 *
 * (Extracted from `render` so 2D games — and any headless sim — get the same
 * tested loop without pulling in `three`. `render` re-exports these for
 * backward compatibility.)
 */

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
 * with the fixed `dt` (seconds); rendering reads the latest `alpha` for
 * interpolation. Importing this in a no-RAF environment is safe: `start()` is a
 * no-op there and never throws.
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

export interface FixedLoopOptions extends CreateLoopOptions {
  /** Pause the loop while the document is hidden (background tab), auto-resuming
   *  on return. Avoids a huge catch-up dt after a long background. Default true. */
  autoPauseHidden?: boolean;
}

export interface FixedLoop extends LoopHandle {
  readonly running: boolean;
}

/**
 * App-runtime loop with separate fixed-step `update` and once-per-frame `render`:
 * `update(dt)` runs 0..maxSteps times per frame at the fixed `dt`; `render(alpha)`
 * runs exactly once with the interpolation factor. This is the standard game loop
 * (sim decoupled from frame rate). Optionally auto-pauses on a hidden tab.
 *
 * Import-safe with no RAF (node / SSR): `start()`/`stop()` are no-ops.
 */
export function createFixedLoop(
  cbs: {
    update: (dt: number) => void;
    /** Once per frame. `alpha` = interpolation factor; `frameDtSec` = the REAL
     *  elapsed wall time this frame (use it for perf metering / non-sim motion). */
    render?: (alpha: number, frameDtSec: number) => void;
  },
  opts: FixedLoopOptions = {},
): FixedLoop {
  const fixedHz = opts.fixedHz ?? 60;
  const fixedDt = 1 / fixedHz;
  const maxSteps = opts.maxSteps ?? 5;
  const autoPauseHidden = opts.autoPauseHidden ?? true;

  const raf = resolveRaf();
  let rafId: number | null = null;
  let running = false;
  let last = 0;
  let accumulator = 0;

  function frame(): void {
    if (!running || !raf) return;
    const t = raf.now() / 1000;
    const frameDt = t - last;
    const result = advance(accumulator, frameDt, fixedDt, maxSteps);
    last = t;
    accumulator = result.accumulator;
    for (let i = 0; i < result.steps; i++) cbs.update(fixedDt);
    cbs.render?.(result.alpha, frameDt);
    rafId = raf.requestAnimationFrame(frame) as number;
  }

  function begin(): void {
    if (running || !raf) return;
    running = true;
    last = raf.now() / 1000;
    accumulator = 0;
    rafId = raf.requestAnimationFrame(frame) as number;
  }
  function end(): void {
    running = false;
    if (raf && rafId != null) {
      raf.cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  // Visibility handling: pause while hidden, resume (with a fresh clock) on return.
  const doc = typeof document !== 'undefined' ? document : null;
  let boundToVisibility = false;
  const onVisibility = (): void => {
    if (!doc) return;
    if (doc.hidden) end();
    else if (wantRunning) begin();
  };
  let wantRunning = false;

  return {
    get running(): boolean {
      return running;
    },
    start(): void {
      wantRunning = true;
      if (autoPauseHidden && doc && !boundToVisibility) {
        doc.addEventListener('visibilitychange', onVisibility);
        boundToVisibility = true;
      }
      if (!doc || !doc.hidden) begin();
    },
    stop(): void {
      wantRunning = false;
      if (boundToVisibility && doc) {
        doc.removeEventListener('visibilitychange', onVisibility);
        boundToVisibility = false;
      }
      end();
    },
  };
}
