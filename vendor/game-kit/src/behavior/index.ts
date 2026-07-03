/**
 * NPC behavior runtime (Track B2) — deterministic walking over a `Pathfinder`.
 *
 * Distilled from Wayfinders' `tickNpcBehavior`: an NPC picks a goal WITHIN its bounds, asks
 * the pathfinder for a route, and walks it; on arrival it idles, then picks again. Bounds:
 *   • `wander`/`region` — a goal anywhere in a disc around an anchor;
 *   • `patrol`          — cycle through a fixed list of waypoints.
 *
 * Seeded + deterministic: goal selection uses the injected kit `Rng`, motion uses the `dt`
 * the caller passes — no clock, no Math.random — so the same seed yields the same trajectory.
 * THREE-free: positions are plain `[x, z]`. The game renders the synced position; this layer
 * never touches a renderer. The LLM never drives it — movement stays pure + authoritative.
 */

import type { Pathfinder, Vec2 } from '../nav/index.js';
import type { Rng } from '../prng/index.js';
// TYPE-ONLY import from the server-side firewall schema. `NpcEmoteName` is erased at compile
// time (verbatim `import type`), so this THREE-free / zod-free client module NEVER pulls the
// zod-dependent `npc/schema` into a client bundle — it only borrows the bounded emote NAMES
// the firewall already validated. No value import here is deliberate (see requestGoTo): the
// defensive re-clamp is a local component-wise clamp, so we don't drag `clampToNavBounds`
// (and thus zod) into the client behavior module.
import type { NavBounds, NpcEmoteName } from '../npc/schema.js';

export * from './follow.js';
export * from './utility.js';

/** Where an NPC is allowed to roam. */
export type BehaviorBounds =
  | { kind: 'wander'; anchor: Vec2; radius: number }
  /** `region` behaves like `wander` for v1 (a disc around the anchor). */
  | { kind: 'region'; anchor: Vec2; radius: number }
  | { kind: 'patrol'; waypoints: Vec2[] };

export interface NpcBehaviorOptions {
  /** The route provider (e.g. a `createGridNav`). */
  pathfinder: Pathfinder;
  /** The roam bounds. */
  bounds: BehaviorBounds;
  /** Seeded RNG for goal selection (e.g. `createRng(seed)`). */
  rng: Rng;
  /** Starting world position. Default: the anchor (wander/region) or first waypoint (patrol). */
  start?: Vec2;
  /** Movement speed in world units per second. Default 2. */
  speed?: number;
  /** Distance at which a waypoint counts as reached. Default 0.15. */
  arriveRadius?: number;
  /** Seconds to pause at a goal before choosing the next. Default 0.6. */
  idleSeconds?: number;
  /** Random-goal attempts before giving up a tick (wander/region). Default 8. */
  goalAttempts?: number;
  /**
   * OPT-IN (Track B5): walkable bounds the runtime re-clamps a `requestGoTo`/`onIntent` `goTo`
   * target into (defence in depth over the firewall's own clamp). Omit ⇒ requested goals are
   * accepted verbatim (still finite-checked). Does NOT affect wander/patrol goal selection, so a
   * behavior that never receives a request is byte-for-byte unchanged.
   */
  navBounds?: NavBounds;
  /** OPT-IN (Track B5): default lifetime (seconds) of an `emote`. Default 2. */
  emoteSeconds?: number;
}

export type BehaviorPhase = 'idle' | 'walking';

/**
 * A transient, bounded emote the consumer may render. Set by an admitted `emote` intent (via
 * {@link NpcBehavior.emote} / {@link NpcBehavior.onIntent}); it drives NO movement. It expires
 * on its own after `emoteSeconds`, so a stale gesture never sticks. `name` is constrained to the
 * firewall's `NpcEmoteName` enum — the model can never invent a gesture.
 */
export interface NpcEmoteState {
  name: NpcEmoteName;
  /** Seconds of emote time remaining; counts down each tick, then the emote clears. */
  remaining: number;
}

export interface NpcBehaviorState {
  /** Current world position `[x, z]`. */
  position: Vec2;
  phase: BehaviorPhase;
  /** The current destination, or null while idle with none chosen. */
  goal: Vec2 | null;
  /** The active transient emote, or null. Advisory + movement-free (see {@link NpcEmoteState}). */
  emote: NpcEmoteState | null;
}

// ── Gated reasoning→behavior bridge (Track B5) — the OPT-IN goal-request surface ──
//
// These are the SHAPES `parseReasoningResponse(raw, { allowMovement:true, navBounds })` already
// validated + clamped in the firewall. We restate them locally (rather than import z.infer types
// from the OFF-LIMITS server schema) so this client module has zero coupling to zod. `onIntent`
// accepts exactly these; anything else is ignored, so a caller can forward a whole parsed intent
// list without a switch and non-movement intents (say/setMood/…) are simply no-ops here.

/** An already-parsed + clamped `goTo` (the firewall's shape). */
export interface AdmittedGoToIntent {
  kind: 'goTo';
  target: Vec2;
}

/** An already-parsed `emote` (the firewall's shape). */
export interface AdmittedEmoteIntent {
  kind: 'emote';
  name: NpcEmoteName;
}

/** The movement intents this runtime consumes. Any other `{ kind }` is ignored by `onIntent`. */
export type AdmittedBehaviorIntent = AdmittedGoToIntent | AdmittedEmoteIntent;

export interface RequestGoToOptions {
  /**
   * Walkable bounds to DEFENSIVELY re-clamp `target` into, component-wise. The firewall already
   * clamps when it parsed the intent; passing the same bounds here is belt-and-suspenders — the
   * runtime never trusts that the caller clamped, so a target outside these bounds is pulled back
   * in rather than pathed to as-is. Omit to accept `target` verbatim (still finite-checked).
   */
  navBounds?: NavBounds;
}

export interface NpcBehavior {
  readonly position: Vec2;
  /** A snapshot of the current state (no side effects). */
  state(): NpcBehaviorState;
  /** Advance the simulation by `dtSeconds` and return the new state. */
  tick(dtSeconds: number): NpcBehaviorState;
  /**
   * OPT-IN (Track B5): request a new pathfinding DESTINATION — the model proposes, the
   * deterministic pathfinder disposes. `target` must be the ALREADY-clamped value from the
   * firewall; the runtime re-clamps defensively when `opts.navBounds` is given and REJECTS a
   * non-finite target (returns false, state unchanged). On acceptance the NPC re-plans a route
   * to `target` on the next goal boundary and, once reached, resumes its normal wander/patrol.
   * The model NEVER writes a position — this only swaps the destination the pathfinder routes to.
   * Returns true if the request was accepted.
   */
  requestGoTo(target: Vec2, opts?: RequestGoToOptions): boolean;
  /**
   * OPT-IN (Track B5): set the transient bounded {@link NpcEmoteState}. Drives NO movement.
   * `durationSeconds` overrides the behavior's default `emoteSeconds` for this one gesture.
   */
  emote(name: NpcEmoteName, durationSeconds?: number): void;
  /**
   * OPT-IN (Track B5): forward an already-parsed movement intent from the firewall. Dispatches
   * `goTo`→{@link requestGoTo} (re-clamped into the behavior's own `navBounds`, if configured)
   * and `emote`→{@link emote}. Any other intent kind is IGNORED, so a consumer can pipe a whole
   * `parseReasoningResponse(...)` list through without filtering. Returns true if it was applied.
   */
  onIntent(intent: AdmittedBehaviorIntent): boolean;
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a[0] - b[0];
  const dz = a[1] - b[1];
  return Math.hypot(dx, dz);
}

/** Both components finite? The firewall already checks this; the runtime never trusts it. */
function isFiniteVec(v: Vec2): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]);
}

/**
 * Defensive, component-wise clamp of a world point into `bounds` — the same rule the firewall's
 * `clampToNavBounds` applies, restated locally so this THREE/zod-free module never value-imports
 * the server schema. Belt-and-suspenders: even a caller that skipped the firewall clamp can only
 * ever steer the NPC to an in-bounds destination.
 */
function clampVec(target: Vec2, bounds: NavBounds): Vec2 {
  return [
    Math.min(Math.max(target[0], bounds.minX), bounds.maxX),
    Math.min(Math.max(target[1], bounds.minZ), bounds.maxZ),
  ];
}

/** Default start: a wander/region anchor, or the first patrol waypoint, or the origin. */
function defaultStart(bounds: BehaviorBounds): Vec2 {
  if (bounds.kind === 'patrol') {
    const first = bounds.waypoints[0];
    return first ? [first[0], first[1]] : [0, 0];
  }
  return [bounds.anchor[0], bounds.anchor[1]];
}

export function createNpcBehavior(opts: NpcBehaviorOptions): NpcBehavior {
  const { pathfinder, bounds, rng } = opts;
  const speed = opts.speed ?? 2;
  const arriveRadius = opts.arriveRadius ?? 0.15;
  const idleSeconds = opts.idleSeconds ?? 0.6;
  const goalAttempts = opts.goalAttempts ?? 8;
  const navBounds = opts.navBounds;
  const emoteSeconds = opts.emoteSeconds ?? 2;

  let position: Vec2 = opts.start ? [opts.start[0], opts.start[1]] : defaultStart(bounds);
  let phase: BehaviorPhase = 'idle';
  let idleTimer = 0; // 0 ⇒ choose a goal on the first tick
  let goal: Vec2 | null = null;
  let path: Vec2[] = [];
  let pathIndex = 0;
  let patrolIndex = 0;
  // Track B5 (opt-in): a pending requested destination the pathfinder should route to NEXT,
  // and the transient emote. Both null/empty by default ⇒ a behavior with no requests is
  // byte-for-byte the B2 runtime.
  let requestedGoal: Vec2 | null = null;
  let emote: NpcEmoteState | null = null;

  /** Choose the next destination + route. Returns true if a walkable route was found. */
  function beginNextGoal(): boolean {
    // Track B5: a requested (already-clamped) destination pre-empts the normal wander/patrol pick
    // for ONE goal. The pathfinder still computes the route — the request only names the target,
    // never a position. If the target is unroutable it's dropped and we fall through to normal
    // selection, so a bad request can never wedge the NPC.
    if (requestedGoal) {
      const target: Vec2 = [requestedGoal[0], requestedGoal[1]];
      requestedGoal = null;
      const route = pathfinder.findPath(position, target);
      if (route && route.length > 0) {
        goal = target;
        path = route;
        pathIndex = 0;
        return true;
      }
      // fall through to normal goal selection when the requested target is unreachable.
    }

    if (bounds.kind === 'patrol') {
      const wp = bounds.waypoints[patrolIndex];
      if (!wp) return false;
      patrolIndex = (patrolIndex + 1) % bounds.waypoints.length;
      const route = pathfinder.findPath(position, [wp[0], wp[1]]);
      if (!route || route.length === 0) return false;
      goal = [wp[0], wp[1]];
      path = route;
      pathIndex = 0;
      return true;
    }

    // wander / region: sample a point in the disc around the anchor (uniform area).
    const anchor = bounds.anchor;
    const radius = bounds.radius;
    for (let attempt = 0; attempt < goalAttempts; attempt++) {
      const angle = rng.next() * Math.PI * 2;
      const r = radius * Math.sqrt(rng.next());
      const candidate: Vec2 = [anchor[0] + Math.cos(angle) * r, anchor[1] + Math.sin(angle) * r];
      const route = pathfinder.findPath(position, candidate);
      if (route && route.length > 0) {
        goal = candidate;
        path = route;
        pathIndex = 0;
        return true;
      }
    }
    return false;
  }

  function advance(dtSeconds: number): void {
    // Track B5: age out a transient emote. Independent of movement — an emote never moves the NPC.
    if (emote) {
      const remaining = emote.remaining - dtSeconds;
      emote = remaining > 0 ? { name: emote.name, remaining } : null;
    }

    if (phase === 'idle') {
      idleTimer -= dtSeconds;
      if (idleTimer > 0) return;
      if (beginNextGoal()) {
        phase = 'walking';
      } else {
        idleTimer = idleSeconds; // no route — wait and retry next idle window
      }
      return;
    }

    // walking: consume `speed * dt` of travel along the remaining waypoints.
    let remaining = speed * dtSeconds;
    while (remaining > 0 && pathIndex < path.length) {
      const target = path[pathIndex] as Vec2;
      const d = dist(position, target);
      if (d <= arriveRadius || d <= remaining) {
        position = [target[0], target[1]];
        remaining -= Math.max(d, 0);
        pathIndex++;
      } else {
        const step = remaining / d;
        position = [
          position[0] + (target[0] - position[0]) * step,
          position[1] + (target[1] - position[1]) * step,
        ];
        remaining = 0;
      }
    }

    if (pathIndex >= path.length) {
      phase = 'idle';
      idleTimer = idleSeconds;
    }
  }

  return {
    get position(): Vec2 {
      return [position[0], position[1]];
    },
    state(): NpcBehaviorState {
      return {
        position: [position[0], position[1]],
        phase,
        goal: goal ? [goal[0], goal[1]] : null,
        emote: emote ? { name: emote.name, remaining: emote.remaining } : null,
      };
    },
    tick(dtSeconds: number): NpcBehaviorState {
      if (dtSeconds > 0) advance(dtSeconds);
      return this.state();
    },
    requestGoTo(target: Vec2, reqOpts?: RequestGoToOptions): boolean {
      // Copy first so a later caller mutation can't reach into our state.
      let next: Vec2 = [target[0], target[1]];
      // SAFETY NET: reject a non-finite target outright (state unchanged) — the firewall already
      // drops these, but the runtime never assumes the caller ran the firewall.
      if (!isFiniteVec(next)) return false;
      // DEFENSIVE re-clamp: prefer the per-call bounds, else the behavior's configured bounds.
      const bounds = reqOpts?.navBounds ?? navBounds;
      if (bounds) next = clampVec(next, bounds);
      // Record the destination and force an immediate re-plan on the next tick: drop the current
      // route + idle window so the pathfinder redirects to `next` right away. Position is NOT
      // touched here — only the pathfinder moves the NPC, and only toward this new destination.
      requestedGoal = next;
      path = [];
      pathIndex = 0;
      phase = 'idle';
      idleTimer = 0;
      return true;
    },
    emote(name: NpcEmoteName, durationSeconds?: number): void {
      const remaining = durationSeconds ?? emoteSeconds;
      // A non-positive duration means "no emote" — clear rather than store a dead gesture.
      emote = remaining > 0 ? { name, remaining } : null;
    },
    onIntent(intent: AdmittedBehaviorIntent): boolean {
      if (intent.kind === 'goTo') return this.requestGoTo(intent.target);
      if (intent.kind === 'emote') {
        this.emote(intent.name);
        return true;
      }
      return false;
    },
  };
}
