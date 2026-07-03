/**
 * Skeletal clip player + procedural→clip baker — three's AnimationMixer / AnimationClip.
 *
 * Two complementary halves, both renderer-free (AnimationMixer + AnimationClip read/write
 * Object3D transforms only — no WebGL context, so they construct and run in node):
 *
 *   1. createClipPlayer — a thin, crossfading wrapper over THREE.AnimationMixer. Drives a
 *      set of named AnimationClips on a root, crossfading from the current action to the
 *      requested one over `fade` seconds, and steps the mixer from accumulated dt.
 *
 *   2. bakeClips / nameNodes — a generalisation of project-mmo's `bakeAnimation`. Crucible's
 *      creatures/characters are animated PROCEDURALLY (no skeleton, no clips): an animator
 *      mutates tagged pivots' `rotation`/`position` each frame. To ship that motion as clips
 *      we SAMPLE the procedural drive at a FIXED rate over each state's cycle and freeze the
 *      per-node transforms into quaternion + position keyframe tracks.
 *
 * glTF/clip channels bind to nodes BY NAME, so before baking every animated node must carry
 * a UNIQUE, non-empty `.name` (else tracks bind to nothing, or to the wrong node when two
 * share a name) — that's `nameNodes`'s job.
 *
 * Determinism: baking uses a FIXED dt (no Date.now / Math.random), so a given state always
 * bakes identical clips. The same property the procedural animator guarantees, carried into
 * the sampled output.
 */

import {
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  LoopRepeat,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type AnimationAction,
  type KeyframeTrack,
  type Object3D,
} from 'three';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Skeletal clip player
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link ClipPlayer.play}. */
export interface PlayOptions {
  /** Crossfade duration (seconds) from the current action to this one. Default `0.2`. */
  fade?: number;
  /** Loop the clip (`LoopRepeat`). When false it plays once and clamps. Default `true`. */
  loop?: boolean;
}

/** A crossfading player over a set of named clips. Returned by {@link createClipPlayer}. */
export interface ClipPlayer {
  /**
   * Crossfade from the currently-playing action to the clip named `name` over
   * `opts.fade` seconds. Re-playing the active clip is a no-op (keeps it running).
   * Throws if no clip with that name exists.
   */
  play(name: string, opts?: PlayOptions): void;
  /** Fade out + stop the named action (or every action when `name` is omitted). */
  stop(name?: string): void;
  /** Advance the mixer by `dt` seconds. Drives whatever actions are active. */
  update(dt: number): void;
  /** The names of every clip this player knows, in the order supplied. */
  names(): string[];
}

/**
 * Create a clip player wrapping a fresh `THREE.AnimationMixer` over `root`.
 *
 * Each clip is pre-resolved to an `AnimationAction` ONCE at construction (no per-play
 * lookups beyond a map get). `play` crossfades the previous action out while fading the
 * new one in, so transitions are smooth rather than popping.
 */
export function createClipPlayer(root: Object3D, clips: readonly AnimationClip[]): ClipPlayer {
  const mixer = new AnimationMixer(root);

  // Resolve each clip to an action ONCE, keyed by clip name. Preserve supply order for
  // `names()` (a Map preserves insertion order in JS).
  const actions = new Map<string, AnimationAction>();
  for (const clip of clips) {
    if (actions.has(clip.name)) continue; // first-wins on duplicate names
    actions.set(clip.name, mixer.clipAction(clip));
  }

  // The action currently faded in (null until the first play / after a full stop).
  let current: AnimationAction | null = null;
  let currentName: string | null = null;

  const player: ClipPlayer = {
    play(name: string, opts: PlayOptions = {}): void {
      const next = actions.get(name);
      if (!next) throw new Error(`createClipPlayer: no clip named '${name}'`);

      const fade = opts.fade !== undefined && opts.fade > 0 ? opts.fade : 0;
      const loop = opts.loop ?? true;

      // Re-playing the active clip keeps it running (just refresh its loop mode).
      if (current === next && currentName === name) {
        next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
        next.clampWhenFinished = !loop;
        return;
      }

      next.enabled = true;
      next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      next.reset();

      if (current && current !== next && fade > 0) {
        // Smooth handoff: previous fades out as the new one fades in.
        next.setEffectiveWeight(1);
        current.crossFadeTo(next, fade, false);
        next.play();
      } else {
        if (current && current !== next) current.stop();
        next.setEffectiveWeight(1);
        next.play();
      }

      current = next;
      currentName = name;
    },

    stop(name?: string): void {
      if (name === undefined) {
        // Stop everything; clear the active pointer.
        for (const action of actions.values()) action.stop();
        current = null;
        currentName = null;
        return;
      }
      const action = actions.get(name);
      if (!action) throw new Error(`createClipPlayer: no clip named '${name}'`);
      action.stop();
      if (action === current) {
        current = null;
        currentName = null;
      }
    },

    update(dt: number): void {
      // Guard against negative dt; the mixer treats dt as elapsed seconds.
      mixer.update(dt > 0 ? dt : 0);
    },

    names(): string[] {
      return [...actions.keys()];
    },
  };

  return player;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Procedural → clip baker
// ─────────────────────────────────────────────────────────────────────────────

/** Default sampling rate (frames/sec). 30fps reads smoothly for low-poly motion. */
export const DEFAULT_BAKE_FPS = 30;

/**
 * One procedural state to bake into a clip. `setup` runs ONCE before the sample loop (put
 * the rig into its starting pose / state); `advance(dt, frame)` runs each frame to drive
 * the procedural motion exactly as the live scene's per-frame tick would.
 */
export interface BakeState {
  /** Clip name (e.g. 'idle' / 'walk' / 'attack'). */
  name: string;
  /** Cycle duration (seconds), sampled at `fps`. */
  durationSec: number;
  /** Sampling rate for this state (frames/sec). Default {@link DEFAULT_BAKE_FPS}. */
  fps?: number;
  /** Put the rig into its starting state once, before sampling. */
  setup?: () => void;
  /** Advance the procedural motion one frame. `dt` is the fixed step; `frame` is 0-based. */
  advance: (dt: number, frame: number) => void;
}

/** Options for {@link bakeClips} and {@link nameNodes}. */
export interface BakeOptions {
  /** `userData` key tagging an animated node. Default `'segment'`. */
  segmentKey?: string;
}

/** An animated node we sample: the live node plus the per-frame buffers we fill. */
interface SampledNode {
  node: Object3D;
  quats: number[]; // flat [x,y,z,w, …] per frame
  positions: number[]; // flat [x,y,z, …] per frame
}

/** Reusable scratch (avoid per-frame allocation in the sample loop). */
const _q = /*@__PURE__*/ new Quaternion();
const _p = /*@__PURE__*/ new Vector3();

/**
 * Collect the nodes a procedural animator drives: the root plus every descendant tagged
 * `userData[segmentKey]`. When NO node carries the tag we fall back to every NAMED child
 * (so an already-named rig with no segment tags still bakes). Deduped, traversal order
 * stable.
 */
function collectNodes(root: Object3D, segmentKey: string): Object3D[] {
  const out: Object3D[] = [];
  const seen = new Set<Object3D>();
  const add = (o: Object3D): void => {
    if (!seen.has(o)) {
      seen.add(o);
      out.push(o);
    }
  };
  add(root);
  let tagged = false;
  root.traverse((o) => {
    if (o.userData[segmentKey] !== undefined) {
      tagged = true;
      add(o);
    }
  });
  if (!tagged) {
    // No tags at all — bake every named child instead so a plain named rig works.
    root.traverse((o) => {
      if (o !== root && o.name !== '') add(o);
    });
  }
  return out;
}

/** True if exactly one node in the list carries `name` (so it's a safe unique binding). */
function oneOwner(nodes: readonly Object3D[], name: string): boolean {
  let count = 0;
  for (const n of nodes) {
    if (n.name === name) {
      count++;
      if (count > 1) return false;
    }
  }
  return count === 1;
}

/**
 * Ensure every animated node under `root` carries a UNIQUE, non-empty `.name` so clip /
 * glTF tracks bind deterministically. A node keeps an existing name only when it's already
 * unique within the set; otherwise (empty or duplicate) we derive `${tag}_${i}` from its
 * `userData[segmentKey]` tag (falling back to `'node'`) and bump the index until unused.
 *
 * Animated nodes are those tagged `userData[segmentKey]`; if NONE are tagged we name every
 * named child instead (matching the {@link bakeClips} fallback). Runs on the SAME objects
 * that get baked / exported — mutating `.name` in place.
 */
export function nameNodes(root: Object3D, segmentKey = 'segment'): void {
  const nodes = collectNodes(root, segmentKey);
  const used = new Set<string>();
  // Seed with already-unique names so we neither reassign nor collide with them.
  for (const n of nodes) {
    if (n.name !== '' && oneOwner(nodes, n.name)) used.add(n.name);
  }
  let counter = 0;
  for (const n of nodes) {
    if (n.name !== '' && oneOwner(nodes, n.name)) continue;
    const tag = n.userData[segmentKey];
    const base = typeof tag === 'string' && tag.length > 0 ? tag : 'node';
    let candidate = `${base}_${counter++}`;
    while (used.has(candidate)) candidate = `${base}_${counter++}`;
    n.name = candidate;
    used.add(candidate);
  }
}

/**
 * Bake procedural motion into `THREE.AnimationClip[]` — one clip per state.
 *
 * For each state we reset the per-node buffers, run `setup()` once, then step at a FIXED
 * dt (`1 / fps`) for `round(durationSec * fps)` frames, calling `advance(dt, frame)` and
 * recording each animated node's local quaternion (x,y,z,w) + position (x,y,z) per frame.
 * We emit a track only for nodes whose value actually changes across the cycle (a still
 * node adds no channel — leaner clips, no dead tracks that would pin a node). Track names
 * bind by node name, so call {@link nameNodes} first.
 *
 * Deterministic: fixed dt, no wall clock — a given state bakes identical clips every run.
 */
export function bakeClips(
  root: Object3D,
  states: readonly BakeState[],
  opts: BakeOptions = {},
): AnimationClip[] {
  const segmentKey = opts.segmentKey ?? 'segment';
  const nodes = collectNodes(root, segmentKey);
  const clips: AnimationClip[] = [];

  for (const state of states) {
    const fps = state.fps !== undefined && state.fps > 0 ? state.fps : DEFAULT_BAKE_FPS;
    const dt = 1 / fps;
    const frames = Math.max(1, Math.round(state.durationSec * fps));
    const sampled: SampledNode[] = nodes.map((node) => ({ node, quats: [], positions: [] }));

    state.setup?.();
    for (let f = 0; f < frames; f++) {
      state.advance(dt, f);
      for (const s of sampled) {
        s.node.quaternion.normalize();
        _q.copy(s.node.quaternion);
        _p.copy(s.node.position);
        s.quats.push(_q.x, _q.y, _q.z, _q.w);
        s.positions.push(_p.x, _p.y, _p.z);
      }
    }

    // Absolute time stamps (seconds) per sampled frame.
    const times = new Float32Array(frames);
    for (let f = 0; f < frames; f++) times[f] = f * dt;

    const tracks: KeyframeTrack[] = [];
    for (const s of sampled) {
      const name = s.node.name;
      if (name === '') continue; // unnamed → binds to nothing; nameNodes prevents this
      if (changes(s.quats, 4)) {
        tracks.push(
          new QuaternionKeyframeTrack(`${name}.quaternion`, times.slice(), Float32Array.from(s.quats)),
        );
      }
      if (changes(s.positions, 3)) {
        tracks.push(
          new VectorKeyframeTrack(`${name}.position`, times.slice(), Float32Array.from(s.positions)),
        );
      }
    }

    clips.push(new AnimationClip(state.name, state.durationSec, tracks));
  }

  return clips;
}

/**
 * Does a flat keyframe buffer (`stride` floats/frame) vary across frames? Compares each
 * frame's component against the FIRST frame's; a tiny epsilon ignores float noise from the
 * per-frame `quaternion.normalize()`. Pruning constant tracks keeps clips lean and avoids
 * channels that pin a node to a single value (which can fight other animations).
 */
function changes(buf: readonly number[], stride: number): boolean {
  if (buf.length <= stride) return false;
  const EPS = 1e-5;
  for (let i = stride; i < buf.length; i++) {
    const base = buf[i % stride] ?? 0;
    const cur = buf[i] ?? 0;
    if (Math.abs(cur - base) > EPS) return true;
  }
  return false;
}
