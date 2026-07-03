/**
 * Cutscene — minimal deterministic core for authored cinematic sequences.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 * Reference feel: the SMT Nocturne intro — authored camera moves while the
 * environment ramps into darkness. A `CutsceneSequence` is a list of `Shot`s;
 * each shot carries an optional authored camera path (keyframed position +
 * lookAt), named numeric "ramps" (the game maps names like "fogDensity" or
 * "keyLight" onto its own scene — this module never touches THREE objects),
 * and one-shot `events` (clip names, captions, audio stings — the GAME acts on
 * them; the module only fires them at the right time).
 *
 * `createCutscenePlayer(seq)` returns a tiny stepper: call `step(dt)` every
 * frame to get a `CutsceneFrame` — the resolved camera pose, the current value
 * of every ramp, and any events that fired THIS step. Deterministic: the same
 * sequence stepped with the same `dt` series always produces identical frames
 * (no wall-clock reads, no Math.random).
 *
 * MINIMAL BY DESIGN: no letterbox/caption rendering, no audio, no scene
 * mutation. Those are the consumer's job (see ./r3f.tsx for the thin r3f
 * shell that forwards frames to the game).
 */

// ── Easing ───────────────────────────────────────────────────────────────────

/** Named easing curves available on a {@link CameraKey} / {@link RampKey}. */
export type EaseName = 'linear' | 'easeInOutQuad' | 'easeOutCubic';

function easeLinear(t: number): number {
  return t;
}

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const EASE_FNS: Record<EaseName, (t: number) => number> = {
  linear: easeLinear,
  easeInOutQuad,
  easeOutCubic,
};

/** Apply a named ease (default `'linear'`) to `t` in [0, 1]. */
function applyEase(t: number, ease?: EaseName): number {
  const fn = ease ? EASE_FNS[ease] : easeLinear;
  return fn(t);
}

function clamp01(t: number): number {
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerp3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ── Authored data ────────────────────────────────────────────────────────────

/**
 * A single authored camera pose at time `t` (seconds within the shot).
 * `ease` (default `'linear'`) shapes the segment FROM this key TO the next one.
 */
export interface CameraKey {
  t: number;
  pos: [number, number, number];
  lookAt: [number, number, number];
  ease?: EaseName;
}

/** A single authored value at time `t` (seconds within the shot) on a {@link RampTrack}. */
export interface RampKey {
  t: number;
  value: number;
  ease?: EaseName;
}

/** A named numeric ramp — e.g. "fogDensity", "keyLight". The game owns the meaning. */
export interface RampTrack {
  keys: RampKey[];
}

/** A one-shot trigger fired at time `t` (seconds within the shot). Fired exactly once. */
export interface CutsceneEvent {
  t: number;
  name: string;
  data?: unknown;
}

/** One beat of a cutscene: a duration, an optional camera path, ramps, and events. */
export interface Shot {
  duration: number;
  camera?: CameraKey[];
  ramps?: Record<string, RampTrack>;
  events?: CutsceneEvent[];
}

/** An ordered list of {@link Shot}s — the whole authored cutscene. */
export interface CutsceneSequence {
  shots: Shot[];
}

// ── Playback ─────────────────────────────────────────────────────────────────

/** The resolved state for a single `step()` call. */
export interface CutsceneFrame {
  /** Interpolated camera pose, or `null` if the current shot has no camera track. */
  camera: { pos: [number, number, number]; lookAt: [number, number, number] } | null;
  /** Every ramp's current value, keyed by name (ramps with no keys are omitted). */
  ramps: Record<string, number>;
  /** Events that fired during THIS step, in order. Empty most frames. */
  events: CutsceneEvent[];
  /** Index of the shot this frame belongs to (last shot's index once done). */
  shotIndex: number;
  /** True once every shot has finished and no more frames will change. */
  done: boolean;
}

/** Stepper returned by {@link createCutscenePlayer}. */
export interface CutscenePlayer {
  /** Advance by `dt` seconds and return the resolved frame. */
  step(dt: number): CutsceneFrame;
  /** Fire the rest of the current shot's remaining events (in order), then jump to the next shot. */
  skipShot(): void;
  /** Fire every remaining event across every remaining shot (in order), then finish. */
  skipAll(): void;
  /** True once every shot has finished. */
  readonly done: boolean;
  /** Overall progress through the whole sequence, 0..1. */
  readonly progress: number;
}

/** Sample a {@link CameraKey}[] track at local time `t`, clamping before/after the track's range. */
function sampleCameraTrack(
  keys: CameraKey[],
  t: number,
): { pos: [number, number, number]; lookAt: [number, number, number] } | null {
  if (keys.length === 0) return null;
  const first = keys[0]!;
  if (t <= first.t) return { pos: first.pos, lookAt: first.lookAt };
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return { pos: last.pos, lookAt: last.lookAt };

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const local = span === 0 ? 0 : (t - a.t) / span;
      const eased = applyEase(clamp01(local), b.ease);
      return { pos: lerp3(a.pos, b.pos, eased), lookAt: lerp3(a.lookAt, b.lookAt, eased) };
    }
  }
  // Unreachable given the bounds checks above, but keep TS satisfied.
  return { pos: last.pos, lookAt: last.lookAt };
}

/** Sample a {@link RampTrack} at local time `t`, clamping before/after the track's range. */
function sampleRampTrack(track: RampTrack, t: number): number | null {
  const keys = track.keys;
  if (keys.length === 0) return null;
  const first = keys[0]!;
  if (t <= first.t) return first.value;
  const last = keys[keys.length - 1]!;
  if (t >= last.t) return last.value;

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      const local = span === 0 ? 0 : (t - a.t) / span;
      const eased = applyEase(clamp01(local), b.ease);
      return lerp(a.value, b.value, eased);
    }
  }
  return last.value;
}

/** Resolve every ramp in a shot at local time `t` into a plain `{ name: value }` map. */
function sampleRamps(shot: Shot, t: number): Record<string, number> {
  const out: Record<string, number> = {};
  const ramps = shot.ramps;
  if (!ramps) return out;
  for (const name of Object.keys(ramps)) {
    const track = ramps[name]!;
    const v = sampleRampTrack(track, t);
    if (v !== null) out[name] = v;
  }
  return out;
}

/**
 * Create a deterministic cutscene stepper for `seq`. Call `step(dt)` every
 * frame; the returned {@link CutscenePlayer} tracks the current shot and local
 * time internally, so the same `dt` series always yields identical frames.
 */
export function createCutscenePlayer(seq: CutsceneSequence): CutscenePlayer {
  const shots = seq.shots;
  let shotIndex = 0;
  let localT = 0;
  let firedCount = 0; // events fired so far WITHIN the current shot, in authored order
  let finished = shots.length === 0;

  // Total duration, for overall progress. A zero-duration sequence is 100% done.
  let totalDuration = 0;
  for (const s of shots) totalDuration += Math.max(0, s.duration);

  // Elapsed time across FINISHED shots only (for progress); current shot's
  // contribution is added from localT (clamped to its duration) on read.
  let elapsedBeforeCurrent = 0;

  // Events queued by skipShot()/skipAll() (fired "now" per the contract) but not
  // yet observable — step()'s return is the only channel, so they're surfaced
  // as the leading events of the very next step() call.
  const pendingEvents: CutsceneEvent[] = [];

  function currentShot(): Shot | null {
    return shotIndex >= 0 && shotIndex < shots.length ? shots[shotIndex]! : null;
  }

  /** Remaining events of `shot` (from `firedCount` on) with t <= uptoT, in order. */
  function collectDueEvents(shot: Shot, uptoT: number): CutsceneEvent[] {
    const events = shot.events;
    if (!events || events.length === 0) return [];
    const due: CutsceneEvent[] = [];
    for (let i = firedCount; i < events.length; i++) {
      const ev = events[i]!;
      if (ev.t <= uptoT) {
        due.push(ev);
        firedCount++;
      } else {
        break; // events are consumed in authored order — stop at the first not-yet-due
      }
    }
    return due;
  }

  /** Mark every remaining event of the current shot as fired and return them, in order. */
  function drainRemainingEvents(): CutsceneEvent[] {
    const shot = currentShot();
    if (!shot) return [];
    const events = shot.events ?? [];
    const remaining = events.slice(firedCount);
    firedCount = events.length;
    return remaining;
  }

  function advanceToNextShot(): void {
    const shot = currentShot();
    if (shot) elapsedBeforeCurrent += Math.max(0, shot.duration);
    shotIndex++;
    localT = 0;
    firedCount = 0;
    if (shotIndex >= shots.length) finished = true;
  }

  function frameFor(events: CutsceneEvent[]): CutsceneFrame {
    const shot = currentShot();
    if (finished || !shot) {
      const lastIndex = shots.length === 0 ? 0 : shots.length - 1;
      return { camera: null, ramps: {}, events, shotIndex: lastIndex, done: true };
    }
    return {
      camera: shot.camera ? sampleCameraTrack(shot.camera, localT) : null,
      ramps: sampleRamps(shot, localT),
      events,
      shotIndex,
      done: false,
    };
  }

  return {
    step(dt: number): CutsceneFrame {
      const leading = pendingEvents.splice(0, pendingEvents.length);

      if (finished || shots.length === 0) {
        return frameFor(leading);
      }

      const shot = currentShot()!;
      const shotIndexBefore = shotIndex;
      localT += Math.max(0, dt);
      const duration = Math.max(0, shot.duration);

      // Fire everything due up to (clamped) localT before deciding to advance,
      // so a shot's final events always fire even if dt overshoots the boundary.
      const clampedT = Math.min(localT, duration);
      const fired = collectDueEvents(shot, clampedT);
      const camera = shot.camera ? sampleCameraTrack(shot.camera, clampedT) : null;
      const ramps = sampleRamps(shot, clampedT);

      const isLastShot = shotIndexBefore === shots.length - 1;
      if (localT >= duration) {
        advanceToNextShot();
      }
      // If this step just completed the FINAL shot, report done:true on this same
      // frame (it still carries that shot's final camera/ramps) rather than
      // requiring one more no-op step to observe completion.
      const done = finished && isLastShot;

      return { camera, ramps, events: [...leading, ...fired], shotIndex: shotIndexBefore, done };
    },

    skipShot(): void {
      if (finished || !currentShot()) return;
      pendingEvents.push(...drainRemainingEvents());
      advanceToNextShot();
    },

    skipAll(): void {
      while (!finished && currentShot()) {
        pendingEvents.push(...drainRemainingEvents());
        advanceToNextShot();
      }
    },

    get done(): boolean {
      return finished;
    },

    get progress(): number {
      if (totalDuration <= 0) return 1;
      const shot = currentShot();
      const currentContribution = shot ? Math.min(localT, Math.max(0, shot.duration)) : 0;
      return clamp01((elapsedBeforeCurrent + currentContribution) / totalDuration);
    },
  };
}
