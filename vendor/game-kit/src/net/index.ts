/**
 * Net — transport-agnostic netcode abstraction.
 *
 * THREE-FREE and dependency-free: no colyseus, no sockets. This is the seam
 * that game code talks to. A Colyseus (or WebSocket/WebRTC) adapter is a future
 * add that simply implements `RoomClient<S>`.
 *
 * Ships with `createLocalRoom` — an in-memory loopback room useful for tests,
 * single-player, and offline development — plus the pure `patchState` helper.
 */

/** A connected room from the client's point of view. Transport-agnostic. */
export interface RoomClient<S> {
  /** Current authoritative state snapshot. */
  readonly state: S;
  /**
   * Subscribe to state changes. Returns a disposer that unsubscribes.
   * The handler fires with the new state whenever state changes.
   */
  onState(fn: (s: S) => void): () => void;
  /** Send a typed message to the server/room. */
  send(type: string, payload?: unknown): void;
  /**
   * Subscribe to messages of a given type. Returns a disposer that
   * unsubscribes just that handler.
   */
  onMessage(type: string, fn: (payload: unknown) => void): () => void;
  /** Leave the room: drop all subscriptions and stop all callbacks. */
  leave(): void;
}

/**
 * A local, in-memory RoomClient. Extends RoomClient with `setState` so a test
 * or single-player host can drive state directly. `send` fans out synchronously
 * to matching `onMessage` handlers — a true loopback.
 */
export interface LocalRoom<S> extends RoomClient<S> {
  /** Update state (value or updater) and fan out to onState subscribers. */
  setState(next: S | ((prev: S) => S)): void;
}

/**
 * Immutably merge `patch` into `state`, returning a new object. Pure: never
 * mutates either argument. A shallow merge — nested objects are replaced, not
 * deep-merged.
 */
export function patchState<S>(state: S, patch: Partial<S>): S {
  return { ...state, ...patch };
}

/**
 * Create an in-memory loopback room seeded with `initial` state.
 *
 * `send(type, payload)` synchronously invokes every `onMessage(type)` handler.
 * `setState` updates `state` and notifies every `onState` subscriber. `leave`
 * clears all subscriptions so no further callbacks fire.
 */
export function createLocalRoom<S>(initial: S): LocalRoom<S> {
  let state = initial;
  let open = true;

  const stateSubs = new Set<(s: S) => void>();
  // type → set of handlers
  const messageSubs = new Map<string, Set<(payload: unknown) => void>>();

  const room: LocalRoom<S> = {
    get state(): S {
      return state;
    },

    onState(fn: (s: S) => void): () => void {
      if (!open) return () => {};
      stateSubs.add(fn);
      return () => {
        stateSubs.delete(fn);
      };
    },

    onMessage(type: string, fn: (payload: unknown) => void): () => void {
      if (!open) return () => {};
      let handlers = messageSubs.get(type);
      if (handlers === undefined) {
        handlers = new Set();
        messageSubs.set(type, handlers);
      }
      handlers.add(fn);
      return () => {
        const set = messageSubs.get(type);
        if (set !== undefined) {
          set.delete(fn);
          if (set.size === 0) messageSubs.delete(type);
        }
      };
    },

    send(type: string, payload?: unknown): void {
      if (!open) return;
      const handlers = messageSubs.get(type);
      if (handlers === undefined) return;
      // Snapshot so handlers that subscribe/unsubscribe don't disturb iteration.
      for (const fn of [...handlers]) fn(payload);
    },

    setState(next: S | ((prev: S) => S)): void {
      if (!open) return;
      state =
        typeof next === 'function'
          ? (next as (prev: S) => S)(state)
          : next;
      for (const fn of [...stateSubs]) fn(state);
    },

    leave(): void {
      open = false;
      stateSubs.clear();
      messageSubs.clear();
    },
  };

  return room;
}
