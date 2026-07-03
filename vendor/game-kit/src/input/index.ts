/**
 * Keybind / action mapper — pure, framework-agnostic.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * The consumer wires real DOM keydown events to this map: on keydown, look up
 * `actionFor(event.key)` to find which action (if any) the pressed key triggers.
 * Binding is one-key-per-action and one-action-per-key (a bijection over the
 * bound keys), so re-binding to a key already taken by another action SWAPS the
 * two actions' keys rather than leaving a key double-mapped.
 *
 * Keys are normalized to lowercase so 'A' and 'a' are the same binding.
 */

export interface InputMapAction {
  /** Stable action identifier (e.g. 'jump', 'fire'). */
  id: string;
  /** Default key for this action (normalized to lowercase on load). */
  default: string;
}

export type BindResult = 'ok' | 'swapped' | 'unknown';

export interface InputMap {
  /**
   * Bind `key` to `actionId`.
   * - 'unknown' if the action id was not declared.
   * - 'swapped' if `key` was already bound to a DIFFERENT action: the two
   *   actions exchange keys (the other action takes this action's old key).
   * - 'ok' otherwise (key was free, or already this action's key).
   */
  bind(actionId: string, key: string): BindResult;
  /** The key currently bound to an action, or undefined if action unknown. */
  keyFor(actionId: string): string | undefined;
  /** The action currently triggered by a key, or undefined if unbound. */
  actionFor(key: string): string | undefined;
  /** Restore every action to its declared default key. */
  reset(): void;
  /** Snapshot of the current binds as `{ actionId: key }`. */
  toJSON(): Record<string, string>;
  /** Load persisted binds; entries for unknown actions are ignored. */
  fromJSON(map: Record<string, string>): void;
}

/** Normalize a key token so 'A' and 'a' collapse to one binding. */
function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/**
 * Create an input map from a list of declared actions and their defaults.
 * Action ids must be unique; later duplicates overwrite earlier defaults.
 */
export function createInputMap(actions: ReadonlyArray<InputMapAction>): InputMap {
  /** actionId → normalized default key, the source of truth for reset(). */
  const defaults = new Map<string, string>();
  for (const a of actions) {
    defaults.set(a.id, normalizeKey(a.default));
  }

  /** actionId → currently bound key. */
  const actionToKey = new Map<string, string>();
  /** key → actionId (inverse of actionToKey, kept in sync). */
  const keyToAction = new Map<string, string>();

  function clearBindings(): void {
    actionToKey.clear();
    keyToAction.clear();
  }

  /** Assign key→action both directions without any swap logic. */
  function assign(actionId: string, key: string): void {
    actionToKey.set(actionId, key);
    keyToAction.set(key, actionId);
  }

  function applyDefaults(): void {
    clearBindings();
    for (const [actionId, key] of defaults) {
      assign(actionId, key);
    }
  }

  applyDefaults();

  const map: InputMap = {
    bind(actionId: string, key: string): BindResult {
      if (!defaults.has(actionId)) return 'unknown';

      const normalized = normalizeKey(key);
      const current = actionToKey.get(actionId);

      // No-op: already bound to this exact key.
      if (current === normalized) return 'ok';

      const occupant = keyToAction.get(normalized);

      if (occupant !== undefined && occupant !== actionId) {
        // SWAP: the occupant takes this action's old key.
        if (current !== undefined) {
          assign(occupant, current);
        } else {
          // This action had no key (shouldn't happen for declared actions, but
          // guard anyway): the occupant loses its mapping cleanly.
          actionToKey.delete(occupant);
        }
        assign(actionId, normalized);
        return 'swapped';
      }

      // Key is free (or somehow self-mapped): move this action onto it and
      // release the action's previous key from the inverse index.
      if (current !== undefined && keyToAction.get(current) === actionId) {
        keyToAction.delete(current);
      }
      assign(actionId, normalized);
      return 'ok';
    },

    keyFor(actionId: string): string | undefined {
      return actionToKey.get(actionId);
    },

    actionFor(key: string): string | undefined {
      return keyToAction.get(normalizeKey(key));
    },

    reset(): void {
      applyDefaults();
    },

    toJSON(): Record<string, string> {
      const out: Record<string, string> = {};
      for (const [actionId, key] of actionToKey) {
        out[actionId] = key;
      }
      return out;
    },

    fromJSON(persisted: Record<string, string>): void {
      // Start from defaults so any actions absent from `persisted` keep theirs,
      // then apply each known entry through bind() so swaps stay consistent.
      applyDefaults();
      for (const actionId of Object.keys(persisted)) {
        if (!defaults.has(actionId)) continue; // ignore unknown actions
        const key = persisted[actionId];
        if (typeof key !== 'string') continue;
        map.bind(actionId, key);
      }
    },
  };

  return map;
}
