/**
 * Fixed-timestep loop — react-three-fiber variant.
 *
 * A `useFixedLoop` hook that runs a fixed-timestep simulation inside r3f's own
 * render loop. r3f already owns requestAnimationFrame (via <Canvas/>), so rather
 * than minting a second RAF loop we hook `useFrame` and reuse the SAME pure
 * `advance` accumulator helper the vanilla `createLoop` uses — so the vanilla and
 * r3f loops share identical step/clamp/alpha math and never drift.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { advance } from './index.js';

/** Options for {@link useFixedLoop}. */
export interface UseFixedLoopOptions {
  /** Fixed simulation frequency in Hz. Default 60. */
  fixedHz?: number;
  /** Max fixed steps per frame before the spiral-of-death clamp. Default 5. */
  maxSteps?: number;
}

/**
 * Run `step(dt, alpha)` at a fixed timestep inside the r3f frame loop.
 *
 * Each rendered frame, the frame's elapsed time is added to an accumulator and
 * drained in whole `1 / fixedHz` chunks; `step` is called once per fixed
 * sub-step with the fixed `dt` and the render `alpha` (fractional progress
 * toward the next step, in [0, 1)) — interpolate visuals with `alpha` for smooth
 * motion between sim states.
 *
 * The spiral-of-death clamp (from the shared {@link advance} helper) drops
 * backlog beyond `maxSteps` after a stall, so the sim never falls further behind.
 */
export function useFixedLoop(
  step: (dt: number, alpha: number) => void,
  opts: UseFixedLoopOptions = {},
): void {
  const fixedHz = opts.fixedHz ?? 60;
  const fixedDt = 1 / fixedHz;
  const maxSteps = opts.maxSteps ?? 5;

  const accumulator = useRef(0);

  useFrame((_, frameDt) => {
    const result = advance(accumulator.current, frameDt, fixedDt, maxSteps);
    accumulator.current = result.accumulator;
    for (let i = 0; i < result.steps; i++) {
      step(fixedDt, result.alpha);
    }
  });
}
