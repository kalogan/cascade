/**
 * Procedural segmented-rig animator — vanilla three, NO skeleton / AnimationMixer.
 *
 * A reusable, generalised distillation of project-mmo's procedural character
 * animator. It drives a humanoid built from named PIVOT Object3Ds (each tagged
 * `userData[segmentKey]`) by mutating their `.rotation` / `.position` in place
 * every frame — idle breathing, a walk leg/arm swing scaled by speed, and
 * transient one-shot overlays (wave, jump) that play once and auto-clear.
 *
 * Design constraints (carried over from the source technique):
 *   - BIND ONCE: pivots are collected + their rest pose captured at construction.
 *     The per-frame `update` does NO traversal, NO lookups, NO allocation — it
 *     only writes Euler/position numbers on the already-bound nodes.
 *   - DETERMINISTIC: no Math.random / Date.now. An internal clock advances by the
 *     accumulated `dt`, so the same dt sequence always yields the same pose.
 *   - RENDERER-FREE: it only reads/writes Object3D transforms, so it constructs
 *     and runs with no WebGL context (unit-testable in node).
 *
 * Segment naming (a subset is fine — missing segments are simply skipped):
 *   hips, torso, head, armUpperL, armUpperR, legUpperL, legUpperR.
 * Names follow project-mmo's convention (`L`/`R` suffix = left/right).
 */

import type { Object3D } from 'three';

/** Continuous locomotion states. */
export type AnimState = 'idle' | 'walk';

/**
 * Recognised segment names. Any subset may be present on the rig; the animator
 * binds whatever it finds and skips the rest, so a torso-only stub animates too.
 */
export type SegmentName =
  | 'hips'
  | 'torso'
  | 'head'
  | 'armUpperL'
  | 'armUpperR'
  | 'legUpperL'
  | 'legUpperR';

/** The transient one-shot animations this animator implements. */
export type OneShot = 'wave' | 'jump';

/** Fixed one-shot durations (seconds). Deterministic timing — no wall clock. */
export const ONESHOT_DURATION_S: Readonly<Record<OneShot, number>> = Object.freeze({
  wave: 1.1, // raise an arm, oscillate a few times, lower.
  jump: 0.7, // crouch → launch (hips rise) → land-absorb.
});

/** Tunable shapes for the continuous states + one-shots (radians / metres). */
export const ANIM_TUNING = {
  idle: {
    /** Breathing frequency (cycles/sec). */
    breathHz: 0.5,
    /** Torso/head breathing sway (rad). */
    sway: 0.04,
    /** Subtle head counter-nod riding the breath (rad). */
    headNod: 0.02,
  },
  walk: {
    /** Stride frequency (full cycles/sec) at speed01 = 1. One cycle = 2 steps. */
    strideHz: 1.05,
    /** Max thigh swing fore/aft (rad) at speed01 = 1. */
    legSwing: 0.6,
    /** Max shoulder swing (rad) — arms counter the legs (contralateral). */
    armSwing: 0.5,
    /** Forward torso lean into movement (rad) at speed01 = 1. */
    lean: 0.08,
  },
  jump: {
    /** Hips rise at apex (m). */
    rise: 0.25,
    /** Anticipation crouch depth before launch (m). */
    crouch: 0.12,
    /** Knee/thigh raise on the airborne tuck (rad). */
    thighTuck: 0.9,
    /** Arms swing up on launch (rad, forward = negative rot.x). */
    armRaise: 1.0,
  },
  wave: {
    /** Wave-arm (RIGHT) raise toward shoulder/head height (rad, +rot.x = up/back). */
    armRaise: 2.0,
    /** Side-to-side wave swing amplitude at the shoulder (rad about Z). */
    swing: 0.35,
    /** Number of full side-to-side oscillations across the hold window. */
    cycles: 3,
    /** Fraction of the one-shot spent raising the arm before the wave. */
    riseFrac: 0.22,
  },
};

/**
 * The animator returned by {@link createProceduralAnimator}. All methods are
 * cheap; `update` is the hot path and allocates nothing.
 */
export interface ProceduralAnimator {
  /** Current continuous state. */
  readonly state: AnimState;
  /** The currently-playing one-shot, or null when none is active. */
  readonly oneShot: OneShot | null;
  /** Switch the continuous state (idle ⇄ walk). Cheap; snaps the base to rest. */
  setState(state: AnimState): void;
  /**
   * Trigger a transient one-shot. It plays once over its fixed duration on top
   * of idle/walk, then auto-returns. Re-triggering restarts it from phase 0.
   */
  play(oneShot: OneShot): void;
  /**
   * Advance the animation. `dt` = seconds since last frame; `speed01` = 0..1
   * locomotion intensity (scales walk stride + arm swing). Mutates the bound
   * segment transforms in place. Zero allocation on this path.
   */
  update(dt: number, speed01?: number): void;
  /** Restore every bound segment to its captured rest rotation + position. */
  reset(): void;
}

/** Options for {@link createProceduralAnimator}. */
export interface ProceduralAnimatorOptions {
  /** `userData` key tagging a segment pivot. Default `'segment'`. */
  segmentKey?: string;
}

/** A bound segment + its captured rest pose (so update offsets from rest). */
interface BoundSegment {
  node: Object3D;
  restRotX: number;
  restRotY: number;
  restRotZ: number;
  restPosX: number;
  restPosY: number;
  restPosZ: number;
}

/**
 * Create a procedural animator over a segmented humanoid `root`.
 *
 * Binds ONCE: traverses `root`, collects each child Object3D whose
 * `userData[segmentKey]` is set into a map keyed by that value, and captures its
 * rest rotation + position. `update` then writes offsets from those captured
 * rests, and `reset` restores them exactly.
 */
export function createProceduralAnimator(
  root: Object3D,
  opts: ProceduralAnimatorOptions = {},
): ProceduralAnimator {
  const segmentKey = opts.segmentKey ?? 'segment';

  // ── BIND ONCE: collect tagged pivots + capture their rest pose ──────────────
  const segments = new Map<string, BoundSegment>();
  root.traverse((o) => {
    const tag = o.userData[segmentKey];
    if (typeof tag !== 'string' || tag.length === 0) return;
    // First-wins per name (a stable rig has unique names; ignore later dupes).
    if (segments.has(tag)) return;
    segments.set(tag, {
      node: o,
      restRotX: o.rotation.x,
      restRotY: o.rotation.y,
      restRotZ: o.rotation.z,
      restPosX: o.position.x,
      restPosY: o.position.y,
      restPosZ: o.position.z,
    });
  });

  // Resolve the named segments we drive ONCE (no per-frame map lookups). Any
  // missing segment stays null and its writes are skipped.
  const hips = segments.get('hips') ?? null;
  const torso = segments.get('torso') ?? null;
  const head = segments.get('head') ?? null;
  const armUpperL = segments.get('armUpperL') ?? null;
  const armUpperR = segments.get('armUpperR') ?? null;
  const legUpperL = segments.get('legUpperL') ?? null;
  const legUpperR = segments.get('legUpperR') ?? null;

  // ── Mutable animator state ──────────────────────────────────────────────────
  let t = 0; // internal clock (seconds), advanced by accumulated dt.
  let state: AnimState = 'idle';
  let oneShot: OneShot | null = null;
  let oneShotT = 0; // seconds elapsed in the active one-shot.
  let oneShotDur = 0; // fixed duration of the active one-shot.

  /** Restore one bound segment to its captured rest rotation + position. */
  function restRestore(s: BoundSegment | null): void {
    if (!s) return;
    s.node.rotation.set(s.restRotX, s.restRotY, s.restRotZ);
    s.node.position.set(s.restPosX, s.restPosY, s.restPosZ);
  }

  /** Snap all driven segments back to rest (no one-shot state touched). */
  function resetBase(): void {
    restRestore(hips);
    restRestore(torso);
    restRestore(head);
    restRestore(armUpperL);
    restRestore(armUpperR);
    restRestore(legUpperL);
    restRestore(legUpperR);
  }

  // ── Base poses (write absolute = rest + offset, so they're idempotent) ──────

  /** IDLE — subtle torso/head breathing sway driven by a sine of the clock. */
  function updateIdle(): void {
    const I = ANIM_TUNING.idle;
    const breath = Math.sin(t * I.breathHz * Math.PI * 2);
    if (torso) torso.node.rotation.x = torso.restRotX + I.sway * breath;
    if (head) head.node.rotation.x = head.restRotX - I.headNod * breath;
  }

  /**
   * WALK — contralateral leg + arm swing scaled by speed01. Phase advances with
   * the internal clock; left/right are π out of phase, arms counter the legs.
   */
  function updateWalk(s01: number): void {
    const W = ANIM_TUNING.walk;
    const phase = t * W.strideHz * Math.PI * 2;
    const sin = Math.sin(phase);
    const leg = W.legSwing * s01;
    const arm = W.armSwing * s01;
    if (legUpperL) legUpperL.node.rotation.x = legUpperL.restRotX + leg * sin;
    if (legUpperR) legUpperR.node.rotation.x = legUpperR.restRotX - leg * sin;
    // Arms counter the legs (left arm with right leg).
    if (armUpperL) armUpperL.node.rotation.x = armUpperL.restRotX - arm * sin;
    if (armUpperR) armUpperR.node.rotation.x = armUpperR.restRotX + arm * sin;
    // Slight forward lean into the movement.
    if (torso) torso.node.rotation.x = torso.restRotX + W.lean * s01;
  }

  // ── One-shot overlays (run AFTER the base pose; pure functions of p∈[0,1]) ───

  /**
   * WAVE — the RIGHT arm raises (over `riseFrac`), oscillates side-to-side a few
   * times at the shoulder, then lowers in the tail so it returns cleanly to base.
   */
  function overlayWave(p: number): void {
    if (!armUpperR) return;
    const V = ANIM_TUNING.wave;
    // Rise envelope: 0→1 over riseFrac, hold at 1, 1→0 over the last 25%.
    let e: number;
    if (p < V.riseFrac) e = p / V.riseFrac;
    else if (p < 0.75) e = 1;
    else e = 1 - (p - 0.75) / 0.25;
    e = e < 0 ? 0 : e > 1 ? 1 : e;
    // Raise back/up about X, oscillate about Z for the side-to-side wave.
    armUpperR.node.rotation.x = armUpperR.restRotX + V.armRaise * e;
    const swing = Math.sin(p * V.cycles * Math.PI * 2) * V.swing * e;
    armUpperR.node.rotation.z = armUpperR.restRotZ + swing;
  }

  /**
   * JUMP — hips rise/fall over a crouch → launch → airborne → land arc, with a
   * thigh tuck and an arm raise on launch. Layers over the base leg/arm pose.
   */
  function overlayJump(p: number): void {
    const J = ANIM_TUNING.jump;
    let dy: number;
    let tuck: number;
    let arm: number;
    if (p < 0.18) {
      // Anticipate: sink, load the knees a touch.
      const a = p / 0.18;
      dy = -J.crouch * a;
      tuck = J.thighTuck * 0.3 * a;
      arm = -J.armRaise * 0.2 * a;
    } else if (p < 0.4) {
      // Launch: drive up, swing the arms up.
      const a = (p - 0.18) / 0.22;
      dy = -J.crouch * (1 - a) + J.rise * a;
      tuck = J.thighTuck * 0.3 * (1 - a);
      arm = -J.armRaise * (0.2 + 0.8 * a);
    } else if (p < 0.78) {
      // Airborne: hold the apex, tuck the legs up under the body.
      const a = (p - 0.4) / 0.38;
      dy = J.rise;
      tuck = -J.thighTuck * Math.sin(a * Math.PI); // knees up (forward = -x)
      arm = -J.armRaise;
    } else {
      // Land-absorb: drop back, soak with a small crouch, arms down.
      const a = (p - 0.78) / 0.22;
      const soak = Math.sin(a * Math.PI);
      dy = -J.crouch * 0.8 * soak;
      tuck = J.thighTuck * 0.4 * soak;
      arm = -J.armRaise * (1 - a);
    }
    if (hips) hips.node.position.y = hips.restPosY + dy;
    if (legUpperL) legUpperL.node.rotation.x = legUpperL.restRotX + tuck;
    if (legUpperR) legUpperR.node.rotation.x = legUpperR.restRotX + tuck;
    if (armUpperL) armUpperL.node.rotation.x = armUpperL.restRotX + arm;
    if (armUpperR) armUpperR.node.rotation.x = armUpperR.restRotX + arm;
  }

  const animator: ProceduralAnimator = {
    get state(): AnimState {
      return state;
    },
    get oneShot(): OneShot | null {
      return oneShot;
    },

    setState(next: AnimState): void {
      if (next === state) return;
      state = next;
      // Snap the base pose to rest so the switch doesn't carry a stale partial
      // pose. An in-flight one-shot is preserved (it re-overlays next update).
      t = 0;
      resetBase();
    },

    play(shot: OneShot): void {
      // (Re)start from phase 0 — a fresh trigger restarts cleanly.
      oneShot = shot;
      oneShotT = 0;
      oneShotDur = ONESHOT_DURATION_S[shot];
    },

    update(dt: number, speed01 = 1): void {
      // Clamp dt so a stall doesn't fling the pose; ignore negative dt.
      const d = dt > 0.05 ? 0.05 : dt < 0 ? 0 : dt;
      t += d;
      const s01 = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;

      // BASE pose first (idle/walk), then the one-shot overlays on top.
      if (state === 'walk') updateWalk(s01);
      else updateIdle();

      if (oneShot) {
        oneShotT += d;
        const dur = oneShotDur > 0 ? oneShotDur : 1e-3;
        const p = oneShotT / dur;
        if (p >= 1) {
          // Done — clear and snap the one-shot's affected pivots back to base so
          // the next frame returns cleanly to idle/walk.
          oneShot = null;
          oneShotT = 0;
          if (hips) hips.node.position.y = hips.restPosY;
        } else if (oneShot === 'wave') {
          overlayWave(p);
        } else {
          overlayJump(p);
        }
      }
    },

    reset(): void {
      oneShot = null;
      oneShotT = 0;
      t = 0;
      resetBase();
    },
  };

  return animator;
}
