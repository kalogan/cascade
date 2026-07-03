/**
 * Runtime CHARACTER clip-player — react-three-fiber.
 *
 * Drop a rigged GLB into a scene and play its named animation clips
 * (`idle/walk/cast/guard/strike/hit`, …). Loads the model via drei `useGLTF`,
 * drives drei `useAnimations` off it, and routes all the state logic — which clip
 * is active, crossfading, and the one-shot→return-to-idle policy — through the
 * PURE {@link createClipMachine} in ./index.ts. That split keeps the decision
 * logic deterministic + unit-testable while this file owns only the three/drei
 * plumbing.
 *
 * The auto-rig may decorate clip names (a `_humanoid` suffix, mixed case); the
 * clip machine resolves requests tolerantly, so a game asks for `"cast"` and the
 * real `Cast_humanoid` action fires. A model with NO clips renders static and
 * every `play` is a safe no-op.
 *
 * Requires the react + @react-three/fiber + @react-three/drei peer deps.
 */

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  type ForwardedRef,
} from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF, useAnimations } from '@react-three/drei';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Group, LoopOnce, LoopRepeat, type AnimationClip } from 'three';
import { createClipMachine, type ClipMachine, type ClipPlayOptions } from './index.js';

/** Imperative handle exposed by {@link AnimatedCharacter} / {@link useCharacterAnimator}. */
export interface CharacterHandle {
  /**
   * Play a clip by LOGICAL name (case-insensitive, `_humanoid`-tolerant). A loop
   * clip runs until replaced; a one-shot (cast/strike/hit…) plays once and
   * auto-returns to idle. Unknown names are a no-op. Returns the resolved real
   * clip name, or null if unresolved / the model has no clips.
   */
  play(name: string, opts?: ClipPlayOptions): string | null;
  /** Every clip name the loaded rig exposes (the real, unresolved names). */
  readonly clips: readonly string[];
  /** The currently-active resolved clip name, or null. */
  readonly current: string | null;
}

/** Props for {@link AnimatedCharacter}. */
export interface AnimatedCharacterProps {
  /** URL of the rigged .glb/.gltf to load (fetched + cached by drei's useGLTF). */
  url: string;
  /**
   * Logical name of the clip to play (case-insensitive, `_humanoid`-tolerant).
   * Changing it crossfades to the new clip. Defaults to the model's `idle`.
   */
  clip?: string;
  /**
   * Auto-return one-shots (cast/strike/hit/guard) to idle when they finish.
   * Default true. Set false to hold the last one-shot pose until re-driven.
   */
  autoIdle?: boolean;
  /** Crossfade duration (seconds) between clips. Default `0.2`. */
  crossFade?: number;
  /**
   * Called once the rig is loaded + wired, with the imperative handle — the
   * escape hatch for driving clips from game logic (`h.play('cast')`) instead of
   * the declarative `clip` prop.
   */
  onReady?: (handle: CharacterHandle) => void;
  /** Cast shadows from every mesh. Default true. */
  castShadow?: boolean;
  /** Receive shadows on every mesh. Default true. */
  receiveShadow?: boolean;
  /** Standard group transform props (position / rotation / scale / …). */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
}

/**
 * Shared engine behind the hook + component. Loads the GLB, clones it with a
 * WORKING skeleton (SkeletonUtils.clone, not scene.clone — skinned meshes need
 * their bones rebound or playback deforms nothing), wires drei `useAnimations`
 * over that clone, and bridges the resulting actions to a pure clip machine.
 *
 * Returns the group ref to mount the clone under, the live handle, and the pure
 * machine (so the caller can read `current`/`clips` or drive it directly).
 */
function useCharacterEngine(
  url: string,
  crossFade: number,
  autoIdle: boolean,
): { ref: React.RefObject<Group | null>; handle: CharacterHandle; scene: Group } {
  const gltf = useGLTF(url);
  const groupRef = useRef<Group>(null);

  // SkeletonUtils.clone so a rigged/skinned mesh keeps a working skeleton (and so
  // multiple instances of one URL don't share + fight over one skeleton). A clip-
  // less static model clones just fine too.
  const scene = useMemo(() => {
    const obj = cloneSkeleton(gltf.scene) as Group;
    obj.traverse((o) => {
      const mesh = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return obj;
  }, [gltf.scene]);

  const animations = gltf.animations as AnimationClip[];
  const { actions, mixer } = useAnimations(animations, groupRef);

  // The PURE machine owns all the decision logic; rebuilt only when the clip set
  // or fade changes (a stable object across normal renders).
  const machine = useMemo<ClipMachine>(() => {
    const m = createClipMachine({
      clips: animations.map((a) => a.name),
      fade: crossFade,
      initial: 'idle',
      idle: 'idle',
    });
    // Feed each clip its real duration so one-shots auto-return on time.
    for (const a of animations) m.setDuration(a.name, a.duration);
    return m;
  }, [animations, crossFade]);

  // Drive drei's actions from the machine's active decision. `driveTo` fades the
  // named action in (and the previous one out), applying loop/clamp. Called both
  // on an imperative play and when tick auto-returns to idle.
  const activeAction = useRef<string | null>(null);
  function driveTo(name: string | null, loop: boolean, fade: number): void {
    if (name === activeAction.current) return;
    const prev = activeAction.current ? actions[activeAction.current] : null;
    const next = name ? actions[name] : null;
    if (next) {
      next.reset();
      next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
      next.clampWhenFinished = !loop;
      next.setEffectiveWeight(1);
      if (prev && prev !== next && fade > 0) prev.crossFadeTo(next, fade, false);
      else if (prev && prev !== next) prev.stop();
      next.play();
    } else if (prev) {
      prev.stop();
    }
    activeAction.current = name;
  }

  // Seed the machine's initial decision into drei once actions exist.
  useEffect(() => {
    const c = machine.current;
    driveTo(c.name, c.loop, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machine, actions]);

  // Step the mixer + let the machine auto-return one-shots each frame.
  useFrame((_, dt) => {
    mixer.update(dt);
    if (!autoIdle) return;
    if (machine.tick(dt)) {
      const c = machine.current;
      driveTo(c.name, c.loop, c.fade);
    }
  });

  const handle = useMemo<CharacterHandle>(
    () => ({
      play(name: string, opts?: ClipPlayOptions): string | null {
        const resolved = machine.play(name, opts);
        if (resolved) {
          const c = machine.current;
          driveTo(c.name, c.loop, c.fade);
        }
        return resolved;
      },
      get clips(): readonly string[] {
        return machine.clips;
      },
      get current(): string | null {
        return machine.current.name;
      },
    }),
    // driveTo closes over stable refs; machine is the only real dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [machine],
  );

  return { ref: groupRef, handle, scene };
}

/**
 * Load a rigged GLB and get the wiring to play its clips — the hook form.
 *
 * Returns `{ ref, clips, play, current }`: mount `ref` on the `<group>` that
 * wraps the model, then call `play('cast')` from game logic. `clips` lists the
 * rig's real clip names; `current` is the active one.
 *
 * ```tsx
 * const { ref, play } = useCharacterAnimator(riggedUrl);
 * useEffect(() => { play('idle'); }, [play]);
 * return <group ref={ref}><primitive object={scene} /></group>;
 * ```
 *
 * Prefer {@link AnimatedCharacter} for the common case (it also mounts the model);
 * reach for the hook when you need the ref on your own group.
 */
export function useCharacterAnimator(url: string): {
  ref: React.RefObject<Group | null>;
  scene: Group;
  clips: readonly string[];
  current: string | null;
  play: CharacterHandle['play'];
} {
  const { ref, handle, scene } = useCharacterEngine(url, 0.2, true);
  return { ref, scene, clips: handle.clips, current: handle.current, play: handle.play };
}

/**
 * Drop-in rigged character with clip playback.
 *
 * ```tsx
 * const charRef = useRef<CharacterHandle>(null);
 * <AnimatedCharacter ref={charRef} url={rigged} clip="idle" />
 * // later, from game logic:
 * charRef.current?.play('cast'); // one-shot; auto-returns to idle
 * ```
 *
 * Loads + mounts the GLB, plays `clip` (crossfading on change), and runs the
 * one-shot→idle policy. `useGLTF` SUSPENDS until the model loads, so render this
 * inside a `<Suspense>` (and ideally a small error boundary — useGLTF THROWS on a
 * failed fetch/parse). A clip-less model renders static; `play` stays a safe
 * no-op. Preload with `AnimatedCharacter.preload(url)`.
 */
export const AnimatedCharacter = forwardRef(function AnimatedCharacter(
  {
    url,
    clip,
    autoIdle = true,
    crossFade = 0.2,
    onReady,
    castShadow = true,
    receiveShadow = true,
    position,
    rotation,
    scale,
  }: AnimatedCharacterProps,
  forwardedRef: ForwardedRef<CharacterHandle>,
): React.JSX.Element {
  const { ref, handle, scene } = useCharacterEngine(url, crossFade, autoIdle);

  // Apply shadow flags to the clone (SkeletonUtils.clone doesn't take our props).
  useMemo(() => {
    scene.traverse((o) => {
      const mesh = o as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
      if (mesh.isMesh) {
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
      }
    });
  }, [scene, castShadow, receiveShadow]);

  // Expose the handle imperatively (ref) and via onReady (callback).
  useImperativeHandle(forwardedRef, () => handle, [handle]);
  useEffect(() => {
    onReady?.(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  // Declarative `clip` prop drives play() whenever it changes.
  useEffect(() => {
    if (clip) handle.play(clip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, handle]);

  return (
    <group ref={ref} position={position} rotation={rotation} scale={scale}>
      <primitive object={scene} />
    </group>
  );
}) as React.ForwardRefExoticComponent<
  AnimatedCharacterProps & React.RefAttributes<CharacterHandle>
> & { preload: (url: string) => void };

/**
 * Warm drei's GLB cache so a character is fetched before first mount. Thin
 * re-export of `useGLTF.preload` so callers don't import drei just to preload.
 */
AnimatedCharacter.preload = (url: string): void => {
  useGLTF.preload(url);
};
