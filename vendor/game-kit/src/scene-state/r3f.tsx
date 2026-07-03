/**
 * Scene machine — react-three-fiber / React wrapper.
 *
 * The pure {@link createSceneMachine} (./index.ts) is THREE-free and REACT-free:
 * it owns the state table but has no React hook, so a renderer that wants the
 * tree to re-render on a transition has to hand-wire a setter into the state
 * hooks. GYRE did exactly this by hand in src/main.tsx — it built the machine in
 * a ref and called `setRoom(...)` inside each state's `enter()`/`update()`.
 *
 * {@link useSceneMachine} harvests that bridge: it builds the machine ONCE and
 * mirrors the active state name into React state automatically, so consumers get
 * `[current, machine]` and never touch setState plumbing. The pure machine is
 * unchanged — this only wraps it.
 *
 * Requires the react peer dep (and typically @react-three/fiber's useFrame to
 * call `machine.update(dt)` each frame, though that's the caller's job).
 */

import { useRef, useState } from 'react';
import { createSceneMachine, type SceneMachine, type SceneStates } from './index.js';

/**
 * Build a scene machine once and mirror its current state into React state.
 *
 * Returns `[current, machine]`:
 *   • `current` — the active state name, kept in React state so the component
 *     re-renders whenever the machine transitions (including auto-transitions
 *     from `update(dt)` returning a state name).
 *   • `machine` — the underlying {@link SceneMachine}; call `machine.update(dt)`
 *     each frame (e.g. from useFrame) and `machine.transition(name)` on events.
 *
 * The mirroring is transparent to your state table: your `enter`/`exit`/`update`
 * hooks run exactly as written; this wrapper additionally observes `current`
 * after each transition/update and syncs React state only when it actually
 * changed (so no redundant re-renders). `config` and `initial` are read once at
 * mount — later prop changes don't rebuild the machine (matching GYRE's build-in-
 * a-ref-once pattern), so pass a stable config.
 */
export function useSceneMachine(
  config: SceneStates,
  initial: string,
): readonly [string, SceneMachine] {
  const [current, setCurrent] = useState(initial);

  // Build the machine once; keep it (and the last-synced name) in refs so the
  // wrapper functions read fresh values without re-subscribing.
  const ref = useRef<{ machine: SceneMachine; synced: string } | null>(null);
  if (ref.current === null) {
    const machine = createSceneMachine(config, initial);

    // Mirror the machine's current name into React state whenever it drifts from
    // what we last pushed. Called after any transition/update.
    const sync = () => {
      const now = machine.current;
      if (now !== ref.current!.synced) {
        ref.current!.synced = now;
        setCurrent(now);
      }
    };

    // Wrap transition/update so every state change flows into React state without
    // the caller wiring setState into their state table (the GYRE hand-bridge).
    const wrapped: SceneMachine = {
      get current(): string {
        return machine.current;
      },
      transition(name: string): void {
        machine.transition(name);
        sync();
      },
      update(dt: number): void {
        machine.update(dt);
        sync();
      },
    };

    ref.current = { machine: wrapped, synced: machine.current };
  }

  return [current, ref.current.machine] as const;
}
