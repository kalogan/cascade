/**
 * Character clip state machine — PURE, THREE-free, deterministic.
 *
 * The state logic behind the r3f `<AnimatedCharacter>` player, extracted here as
 * plain data so it's unit-testable without three, a DOM, or a WebGL context. It
 * knows nothing about AnimationMixer/AnimationAction — it only decides WHICH clip
 * name should be active right now and how to fade into it; the r3f layer then
 * drives drei's `useAnimations` off those decisions.
 *
 * Two jobs the machine owns:
 *   1. NAME RESOLUTION. The auto-rig emits clips named `idle/cast/guard/strike/hit`
 *      (future: `walk`), but a rig can decorate them — a `_humanoid` suffix, mixed
 *      case, stray whitespace. `resolveClipName` matches a requested logical name
 *      against the real clip list tolerantly (case-insensitive, suffix-stripped) so
 *      a game asks for `"cast"` and gets the clip actually named `Cast_humanoid`.
 *   2. ONE-SHOT → RETURN-TO-IDLE. Continuous clips (idle/walk) loop; action clips
 *      (cast/strike/hit/guard) play ONCE and then auto-return to the idle clip. The
 *      machine tracks the active clip + a remaining-time budget and, on `tick`,
 *      flips a finished one-shot back to idle — so a game just calls `play("cast")`
 *      and idle resumes on its own.
 *
 * Determinism: no `Math.random` / `Date.now`. Time only advances through the `dt`
 * fed to `tick`, so a given call sequence always yields the same state — the same
 * property the procedural animator and clip baker guarantee.
 */

/** Clip names that LOOP by default (continuous locomotion / stance). Everything
 * else is treated as a one-shot that auto-returns to idle. Case-insensitive. */
export const LOOPING_CLIPS: readonly string[] = Object.freeze(['idle', 'walk', 'run']);

/** Suffixes the auto-rig may append to a clip's logical name; stripped when
 * resolving so `Cast_humanoid` still matches a request for `cast`. */
export const CLIP_NAME_SUFFIXES: readonly string[] = Object.freeze(['_humanoid', '_armature']);

/** Options for {@link ClipMachine.play}. */
export interface ClipPlayOptions {
  /**
   * Loop this clip. When omitted the machine infers it from the name
   * ({@link LOOPING_CLIPS} loop; every other clip is a one-shot). Pass `true`/
   * `false` to override (e.g. hold `guard` as a loop).
   */
  loop?: boolean;
  /** Crossfade duration (seconds) into this clip. Default {@link ClipMachineOptions.fade}. */
  fade?: number;
  /**
   * Fixed duration (seconds) for a one-shot before it auto-returns to idle. When
   * omitted the r3f layer supplies the clip's real duration via {@link ClipMachine.setDuration};
   * if neither is known the one-shot holds until re-driven.
   */
  duration?: number;
}

/** The active clip decision the r3f layer reads each frame. */
export interface ActiveClip {
  /** The RESOLVED real clip name (as it appears in the clip list), or null if none. */
  readonly name: string | null;
  /** Whether it's looping (continuous) or a one-shot. */
  readonly loop: boolean;
  /** Crossfade to use when the r3f layer switches to this clip (seconds). */
  readonly fade: number;
}

/** The pure clip state machine returned by {@link createClipMachine}. */
export interface ClipMachine {
  /** The currently-active clip decision (resolved name + loop + fade). */
  readonly current: ActiveClip;
  /** The idle clip name this machine returns to (resolved), or null if the rig has none. */
  readonly idle: string | null;
  /** Every clip name the machine knows (the real, unresolved names). */
  readonly clips: readonly string[];
  /**
   * Request a clip by LOGICAL name (case-insensitive, `_humanoid`-tolerant). If
   * it resolves to a real clip the machine switches to it; an unknown name is a
   * no-op (keeps the current clip). Returns the resolved real name, or null when
   * unresolved. A one-shot arms an auto-return-to-idle countdown.
   */
  play(name: string, opts?: ClipPlayOptions): string | null;
  /**
   * Advance the machine by `dt` seconds. When a one-shot's duration elapses the
   * machine auto-switches back to idle. Returns true when `current` CHANGED this
   * tick (so the r3f layer knows to crossfade), false otherwise.
   */
  tick(dt: number): boolean;
  /**
   * Tell the machine the real duration (seconds) of a clip by its logical or real
   * name — used to time a one-shot's auto-return when `play` wasn't given an
   * explicit `duration`. The r3f layer calls this once per clip after load.
   */
  setDuration(name: string, seconds: number): void;
  /** Resolve a logical name to its real clip name (or null). Exposed for callers. */
  resolve(name: string): string | null;
}

/** Options for {@link createClipMachine}. */
export interface ClipMachineOptions {
  /** The rig's clip names (real, possibly suffixed). Order preserved. */
  clips: readonly string[];
  /** Logical name of the clip to start on (default `'idle'`). Resolved tolerantly. */
  initial?: string;
  /** Default crossfade (seconds) when `play` isn't given one. Default `0.2`. */
  fade?: number;
  /** Logical name of the clip one-shots return to (default `'idle'`). */
  idle?: string;
  /** Override which logical names loop. Default {@link LOOPING_CLIPS}. Case-insensitive. */
  loopingClips?: readonly string[];
}

/** Lower-case + trim + strip a known rig suffix → the comparable "logical" key. */
function normalizeClipKey(name: string): string {
  let key = name.trim().toLowerCase();
  for (const suffix of CLIP_NAME_SUFFIXES) {
    if (key.endsWith(suffix)) {
      key = key.slice(0, -suffix.length);
      break;
    }
  }
  return key;
}

/**
 * Create a pure clip state machine over a set of named clips.
 *
 * Resolution is built ONCE: each real clip name is indexed by its normalized key
 * (lower-cased, trimmed, `_humanoid`/`_armature` suffix stripped), first-wins on a
 * collision so a plain `idle` beats a later `idle_humanoid`. `play` then resolves
 * a requested logical name through that index; a one-shot arms a return-to-idle
 * budget that `tick` counts down.
 *
 * With NO clips the machine is inert but safe: `current.name` is null, `play`
 * returns null, `tick` never changes anything — so a static (clip-less) model
 * drops in without special-casing at the call site.
 */
export function createClipMachine(opts: ClipMachineOptions): ClipMachine {
  const clips = [...opts.clips];
  const fadeDefault = opts.fade !== undefined && opts.fade >= 0 ? opts.fade : 0.2;
  const looping = new Set((opts.loopingClips ?? LOOPING_CLIPS).map((n) => n.toLowerCase()));

  // Normalized key → real clip name. First-wins so an exact `idle` isn't shadowed
  // by a later `idle_humanoid`.
  const byKey = new Map<string, string>();
  for (const real of clips) {
    const key = normalizeClipKey(real);
    if (!byKey.has(key)) byKey.set(key, real);
  }

  // Real clip name → duration (seconds), filled by setDuration for one-shot timing.
  const durations = new Map<string, number>();

  function resolve(name: string): string | null {
    return byKey.get(normalizeClipKey(name)) ?? null;
  }

  /** Is a resolved clip a looper? Inferred from its logical key unless overridden. */
  function isLooping(realName: string, override?: boolean): boolean {
    if (override !== undefined) return override;
    return looping.has(normalizeClipKey(realName));
  }

  const idleName = resolve(opts.idle ?? 'idle');

  // ── Mutable state ───────────────────────────────────────────────────────────
  let currentName: string | null = null;
  let currentLoop = true;
  let currentFade = fadeDefault;
  // Remaining seconds before a one-shot auto-returns to idle. Infinity = looping
  // or a one-shot with no known duration (holds until re-driven).
  let remaining = Infinity;

  /** Switch the active clip decision. Returns true if the name actually changed. */
  function switchTo(realName: string | null, loop: boolean, fade: number, dur: number): boolean {
    const changed = realName !== currentName;
    currentName = realName;
    currentLoop = loop;
    currentFade = fade;
    remaining = loop ? Infinity : dur;
    return changed;
  }

  // Seed the initial clip (no crossfade — it's the starting pose).
  const initialResolved = resolve(opts.initial ?? 'idle');
  if (initialResolved) {
    switchTo(initialResolved, isLooping(initialResolved), 0, Infinity);
  }

  const machine: ClipMachine = {
    get current(): ActiveClip {
      return { name: currentName, loop: currentLoop, fade: currentFade };
    },
    get idle(): string | null {
      return idleName;
    },
    get clips(): readonly string[] {
      return clips;
    },

    resolve,

    setDuration(name: string, seconds: number): void {
      const real = resolve(name);
      if (real && Number.isFinite(seconds) && seconds > 0) durations.set(real, seconds);
    },

    play(name: string, playOpts: ClipPlayOptions = {}): string | null {
      const real = resolve(name);
      if (!real) return null; // unknown clip → keep the current one.

      const loop = isLooping(real, playOpts.loop);
      const fade = playOpts.fade !== undefined && playOpts.fade >= 0 ? playOpts.fade : fadeDefault;
      // One-shot duration: explicit opt wins, else the clip's known real duration,
      // else Infinity (hold until re-driven — the r3f layer usually knows it).
      const dur = loop
        ? Infinity
        : playOpts.duration !== undefined && playOpts.duration > 0
          ? playOpts.duration
          : (durations.get(real) ?? Infinity);

      switchTo(real, loop, fade, dur);
      return real;
    },

    tick(dt: number): boolean {
      // Only one-shots with a finite budget count down; loopers ignore dt.
      if (!Number.isFinite(remaining)) return false;
      remaining -= dt > 0 ? dt : 0;
      if (remaining > 0) return false;
      // One-shot finished → return to idle (crossfading with the default fade).
      // If there's no idle clip, go inert but stop counting.
      if (idleName && idleName !== currentName) {
        return switchTo(idleName, isLooping(idleName), fadeDefault, Infinity);
      }
      // No idle to return to: just stop counting so we don't fire every tick.
      remaining = Infinity;
      return false;
    },
  };

  return machine;
}
