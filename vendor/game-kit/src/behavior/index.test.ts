import { describe, it, expect } from 'vitest';
// Straight from the vendored game-kit source (vitest resolves from disk, so no tsconfig path
// aliases needed here). The behavior runtime is THREE/zod-free, so this suite needs no stubs.
import {
  createNpcBehavior,
  type NpcBehavior,
  type NpcBehaviorState,
  type AdmittedBehaviorIntent,
} from './index.js';
import { createGridNav } from '../nav/index.js';
import { createRng } from '../prng/index.js';
import { navBoundsFromGrid, clampToNavBounds, type NavBounds } from '../npc/schema.js';

// ── Track B5: the OPT-IN reasoning→behavior movement bridge ──────────────────
//
// The firewall (`parseReasoningResponse`) already validates + clamps a `goTo`; this suite covers
// the RUNTIME side of the bridge. Contract:
//   • DEFAULT / no requests — the behavior is byte-for-byte the B2 wander/patrol runtime.
//   • requestGoTo(target)   — redirects the pathfinder's DESTINATION to `target`; the pathfinder
//                             still owns frame-to-frame motion (the model never writes a position).
//   • the runtime never trusts the caller clamped — it re-clamps defensively + rejects non-finite.
//   • emote                 — sets a transient, bounded, movement-free gesture that ages out.

// A fully-walkable 10×10 grid over world XZ [0..9]×[0..9] (cellSize 1, origin 0,0).
function openGrid(width = 10, height = 10) {
  return createGridNav({ width, height, isWalkable: () => true });
}

// Drive the sim to completion (or a tick cap) and return the final state.
function runToRest(b: NpcBehavior, dt = 0.1, maxTicks = 2000): NpcBehaviorState {
  let s = b.state();
  for (let i = 0; i < maxTicks; i++) {
    s = b.tick(dt);
    if (s.phase === 'idle' && s.goal && s.emote === null) {
      // arrived at a goal and no emote pending — good enough resting point for assertions.
      const d = Math.hypot(s.position[0] - s.goal[0], s.position[1] - s.goal[1]);
      if (d < 0.2) return s;
    }
  }
  return s;
}

describe('createNpcBehavior — default is byte-for-byte the B2 runtime (no requests)', () => {
  it('produces an identical trajectory with and without the B5 fields present', () => {
    const mk = () =>
      createNpcBehavior({
        pathfinder: openGrid(),
        bounds: { kind: 'wander', anchor: [5, 5], radius: 3 },
        rng: createRng(1234),
        start: [5, 5],
      });

    const a = mk();
    const b = mk();
    const trailA: [number, number][] = [];
    const trailB: [number, number][] = [];
    for (let i = 0; i < 200; i++) {
      trailA.push([...a.tick(0.1).position]);
      trailB.push([...b.tick(0.1).position]);
    }
    // Same seed + same dt ⇒ identical path. (Guards that the additive B5 state never perturbs
    // the deterministic wander selection.)
    expect(trailA).toEqual(trailB);
  });

  it('exposes an inert emote field (null) when never requested', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'patrol', waypoints: [[1, 1], [8, 8]] },
      rng: createRng(7),
    });
    expect(b.state().emote).toBeNull();
    b.tick(0.5);
    expect(b.state().emote).toBeNull();
  });
});

describe('requestGoTo — redirects the pathfinder destination to the (clamped) target', () => {
  it('paths to a requested in-bounds target and arrives there', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [1, 1], radius: 1 },
      rng: createRng(42),
      start: [1, 1],
      speed: 4,
    });

    const target: [number, number] = [8, 8];
    expect(b.requestGoTo(target)).toBe(true);
    // The requested goal pre-empts wander selection on the very next tick.
    const s = b.tick(0.001);
    expect(s.goal).toEqual(target);

    const rest = runToRest(b, 0.1);
    expect(rest.goal).toEqual(target);
    expect(Math.hypot(rest.position[0] - 8, rest.position[1] - 8)).toBeLessThan(0.2);
  });

  it('the model never writes a position — requestGoTo does NOT move the NPC by itself', () => {
    const start: [number, number] = [3, 3];
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [3, 3], radius: 1 },
      rng: createRng(9),
      start,
    });
    // Requesting a far target must not teleport the NPC — position only changes on tick().
    b.requestGoTo([9, 9]);
    expect(b.position).toEqual(start);
  });

  it('a later requestGoTo overrides an earlier one (re-plans to the newest target)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [0, 0], radius: 1 },
      rng: createRng(3),
      start: [0, 0],
      speed: 4,
    });
    b.requestGoTo([9, 0]);
    b.tick(0.2); // start heading toward [9,0]
    b.requestGoTo([0, 9]); // change our mind
    const s = b.tick(0.001);
    expect(s.goal).toEqual([0, 9]);
    const rest = runToRest(b, 0.1);
    expect(Math.hypot(rest.position[0] - 0, rest.position[1] - 9)).toBeLessThan(0.2);
  });

  it('resumes normal wander after reaching a requested goal (request is one-shot)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 2 },
      rng: createRng(11),
      start: [5, 5],
      speed: 6,
      idleSeconds: 0.1,
    });
    b.requestGoTo([9, 9]);
    runToRest(b, 0.1);
    // Keep ticking; the next goal is a wander pick (inside the anchor disc), not [9,9] again.
    let sawWanderGoal = false;
    for (let i = 0; i < 200; i++) {
      const s = b.tick(0.1);
      if (s.goal && !(s.goal[0] === 9 && s.goal[1] === 9)) {
        // a wander goal lies within the radius-2 disc around [5,5].
        expect(Math.hypot(s.goal[0] - 5, s.goal[1] - 5)).toBeLessThanOrEqual(2.0001);
        sawWanderGoal = true;
        break;
      }
    }
    expect(sawWanderGoal).toBe(true);
  });
});

describe('requestGoTo — SAFETY: re-clamps defensively + rejects non-finite', () => {
  const bounds: NavBounds = { minX: 0, maxX: 9, minZ: 0, maxZ: 9 };

  it('re-clamps an out-of-bounds target with per-call navBounds (never paths to it as-is)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [1, 1], radius: 1 },
      rng: createRng(5),
      start: [1, 1],
    });
    // Simulate a caller that did NOT clamp: a wildly out-of-bounds target.
    expect(b.requestGoTo([999, -999], { navBounds: bounds })).toBe(true);
    const s = b.tick(0.001);
    // The runtime clamped it into the walkable box, matching the firewall's clampToNavBounds.
    expect(s.goal).toEqual(clampToNavBounds([999, -999], bounds));
    expect(s.goal).toEqual([9, 0]);
  });

  it('re-clamps using the behavior-level navBounds when no per-call bounds given', () => {
    const grid = openGrid();
    const b = createNpcBehavior({
      pathfinder: grid,
      bounds: { kind: 'wander', anchor: [1, 1], radius: 1 },
      rng: createRng(5),
      start: [1, 1],
      navBounds: navBoundsFromGrid(grid),
    });
    b.requestGoTo([100, 100]);
    const s = b.tick(0.001);
    expect(s.goal).toEqual([9, 9]); // clamped to the grid's walkable corner
  });

  it('accepts an ALREADY-clamped firewall target verbatim (the intended path)', () => {
    const grid = openGrid();
    const nav = navBoundsFromGrid(grid);
    const clamped = clampToNavBounds([12, 7], nav); // what the firewall would hand us: [9, 7]
    const b = createNpcBehavior({
      pathfinder: grid,
      bounds: { kind: 'wander', anchor: [1, 1], radius: 1 },
      rng: createRng(5),
      start: [1, 1],
      navBounds: nav,
    });
    b.requestGoTo(clamped);
    expect(b.tick(0.001).goal).toEqual([9, 7]);
  });

  it('rejects a non-finite target (returns false, state unchanged)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [2, 2], radius: 1 },
      rng: createRng(8),
      start: [2, 2],
    });
    const before = b.state();
    expect(b.requestGoTo([Number.NaN, 5])).toBe(false);
    expect(b.requestGoTo([Number.POSITIVE_INFINITY, 5])).toBe(false);
    // No pending request recorded — the next tick picks a normal wander goal, not the bad one.
    const s = b.tick(0.001);
    expect(s.goal).not.toEqual([Number.NaN, 5]);
    expect(before.position).toEqual([2, 2]);
  });
});

describe('emote — transient, bounded, movement-free', () => {
  it('sets a bounded gesture that a consumer can read', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 1 },
      rng: createRng(1),
      start: [5, 5],
      emoteSeconds: 1,
    });
    b.emote('wave');
    const s = b.state();
    expect(s.emote?.name).toBe('wave');
    expect(s.emote?.remaining).toBe(1);
  });

  it('does NOT move the NPC (emote is movement-free)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [4, 4], radius: 0.0001 }, // effectively no wander
      rng: createRng(1),
      start: [4, 4],
    });
    const before: [number, number] = [...b.position];
    b.emote('nod');
    // The emote itself moves nothing; only tick() (via the pathfinder) can.
    expect(b.position).toEqual(before);
  });

  it('ages out after its lifetime and clears', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 1 },
      rng: createRng(1),
      start: [5, 5],
      emoteSeconds: 0.5,
    });
    b.emote('point');
    b.tick(0.3);
    expect(b.state().emote?.remaining).toBeCloseTo(0.2, 6);
    b.tick(0.3); // total 0.6 > 0.5 lifetime
    expect(b.state().emote).toBeNull();
  });

  it('a non-positive duration clears rather than storing a dead gesture', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 1 },
      rng: createRng(1),
      start: [5, 5],
    });
    b.emote('wave');
    b.emote('shrug', 0);
    expect(b.state().emote).toBeNull();
  });
});

describe('onIntent — forwards an already-parsed firewall intent', () => {
  it('dispatches goTo → requestGoTo (with behavior navBounds re-clamp)', () => {
    const grid = openGrid();
    const b = createNpcBehavior({
      pathfinder: grid,
      bounds: { kind: 'wander', anchor: [1, 1], radius: 1 },
      rng: createRng(2),
      start: [1, 1],
      navBounds: navBoundsFromGrid(grid),
    });
    // An out-of-bounds goTo (as if the firewall clamp were skipped) is still pulled in-bounds.
    const intent: AdmittedBehaviorIntent = { kind: 'goTo', target: [50, 50] };
    expect(b.onIntent(intent)).toBe(true);
    expect(b.tick(0.001).goal).toEqual([9, 9]);
  });

  it('dispatches emote → emote', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 1 },
      rng: createRng(2),
      start: [5, 5],
    });
    expect(b.onIntent({ kind: 'emote', name: 'shrug' })).toBe(true);
    expect(b.state().emote?.name).toBe('shrug');
  });

  it('ignores a non-movement intent kind (returns false, no-op)', () => {
    const b = createNpcBehavior({
      pathfinder: openGrid(),
      bounds: { kind: 'wander', anchor: [5, 5], radius: 1 },
      rng: createRng(2),
      start: [5, 5],
    });
    // A say/setMood/etc. forwarded here is simply not our concern — no throw, no state change.
    const alien = { kind: 'say', text: 'hi' } as unknown as AdmittedBehaviorIntent;
    expect(b.onIntent(alien)).toBe(false);
    expect(b.state().emote).toBeNull();
  });
});
