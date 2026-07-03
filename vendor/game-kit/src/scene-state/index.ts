/**
 * Table-driven scene/state machine.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * Each state has optional lifecycle hooks:
 *   - enter(): run when the machine transitions INTO the state.
 *   - exit():  run when the machine transitions OUT of the state.
 *   - update(dt): run each tick; may return the name of a state to auto-transition to.
 *
 * transition(name) runs the current state's exit() then the target's enter().
 */

export interface SceneState {
  enter?(): void;
  exit?(): void;
  /** Per-tick update. Return a state name to auto-transition, or void to stay. */
  update?(dt: number): string | void;
}

export type SceneStates = Record<string, SceneState>;

export interface SceneMachine {
  /** The currently active state name. */
  readonly current: string;
  /** Switch to `name`: runs current.exit() then next.enter(). Throws if unknown. */
  transition(name: string): void;
  /** Tick the current state; auto-transitions if update() returns a state name. */
  update(dt: number): void;
}

export function createSceneMachine(states: SceneStates, initial: string): SceneMachine {
  if (!Object.prototype.hasOwnProperty.call(states, initial)) {
    throw new Error(`createSceneMachine: unknown initial state "${initial}"`);
  }

  let current = initial;

  function getState(name: string): SceneState {
    if (!Object.prototype.hasOwnProperty.call(states, name)) {
      throw new Error(`SceneMachine: unknown state "${name}"`);
    }
    return states[name] as SceneState;
  }

  // Enter the initial state.
  getState(current).enter?.();

  const machine: SceneMachine = {
    get current(): string {
      return current;
    },

    transition(name: string): void {
      const next = getState(name); // throws on unknown before any side effects
      const prev = getState(current);
      prev.exit?.();
      current = name;
      next.enter?.();
    },

    update(dt: number): void {
      const result = getState(current).update?.(dt);
      if (typeof result === 'string') {
        machine.transition(result);
      }
    },
  };

  return machine;
}
