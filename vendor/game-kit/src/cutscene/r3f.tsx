/**
 * Cutscene — react-three-fiber shell.
 *
 * A thin `<CutscenePlayer/>` wrapping the vanilla `createCutscenePlayer`. Each
 * `useFrame` tick it steps the pure core and, while `active`, drives the
 * default scene camera's position + lookAt directly from the resolved frame.
 * Ramps and events are just forwarded to the consumer via callbacks — the
 * shell never touches fog, lights, or any other scene object itself, and it
 * renders nothing (no letterbox/caption DOM, no audio; the game owns those).
 *
 * SKIP / PROGRESS HANDLE: forward a ref to reach the running player from OUTSIDE
 * the Canvas — a DOM "Skip" chip calls `ref.current?.skipAll()`, a progress bar
 * reads `ref.current?.progress`. Before this, consumers that needed a real skip
 * (GYRE's endings + the school eclipse) had to bypass this shell and hand-roll
 * `createCutscenePlayer` + their own `useFrame` just to hold the player instance;
 * the ref removes that duplication (see `CutsceneShellHandle`). `onProgress` is
 * the same value pushed each frame for consumers that would rather subscribe than
 * poll. Skipping still fires every remaining event in authored order before
 * `onDone` (the pure core's documented `skipAll` contract).
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  createCutscenePlayer,
  type CutsceneSequence,
  type CutsceneFrame,
  type CutsceneEvent,
} from './index.js';

/**
 * The imperative handle exposed via `<CutscenePlayer ref>`. A curated subset of
 * the pure {@link import('./index.js').CutscenePlayer} — deliberately WITHOUT
 * `step`, since the shell's `useFrame` owns stepping (a consumer stepping too
 * would double-advance the sequence). Skip/progress are all a DOM control needs.
 */
export interface CutsceneShellHandle {
  /** Fire the current shot's remaining events (in order), then jump to the next shot. */
  skipShot(): void;
  /** Fire every remaining event across every remaining shot (in order), then finish. */
  skipAll(): void;
  /** True once every shot has finished. */
  readonly done: boolean;
  /** Overall progress through the whole sequence, 0..1. */
  readonly progress: number;
}

/** Props for {@link CutscenePlayer}. */
export interface CutscenePlayerProps {
  /** The authored sequence to play. */
  sequence: CutsceneSequence;
  /** Called every step with the resolved frame (camera + ramps + events). */
  onFrame?: (frame: CutsceneFrame) => void;
  /** Called once per event, in order, as each fires. */
  onEvent?: (event: CutsceneEvent) => void;
  /** Called each step with overall progress 0..1 (after the step advances it). */
  onProgress?: (progress: number) => void;
  /** Called once when the sequence finishes (including via `skipAll`). */
  onDone?: () => void;
  /** While true, the player steps and drives the scene camera. Default true. */
  active?: boolean;
}

/**
 * Drive an authored {@link CutsceneSequence}. Drop `<CutscenePlayer sequence=.../>`
 * inside a `<Canvas>`:
 *
 * ```tsx
 * const player = useRef<CutsceneShellHandle>(null);
 * <CutscenePlayer
 *   ref={player}
 *   sequence={endingMontage}
 *   onFrame={(f) => applyRamps(f.ramps)} // game maps ramps onto fog/lights
 *   onEvent={(e) => { if (e.name === 'clip') playClip(e.data); }}
 *   onDone={() => setScene('creditsRoll')}
 * />
 * // …and, from a DOM control OUTSIDE the Canvas:
 * <button onClick={() => player.current?.skipAll()}>Skip</button>
 * ```
 *
 * Renders nothing. While `active` (default true), each `useFrame` tick steps
 * the pure core and writes the resolved camera pose onto the active scene
 * camera. Ramps and events are forwarded as-is — the game decides what they mean.
 */
export const CutscenePlayer = forwardRef<CutsceneShellHandle, CutscenePlayerProps>(
  function CutscenePlayer(props, ref): null {
    const { sequence, onFrame, onEvent, onProgress, onDone, active = true } = props;
    const camera = useThree((s) => s.camera);

    const player = useMemo(
      () => createCutscenePlayer(sequence),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [sequence],
    );

    // Curated skip/progress handle — the shell owns `step`, so it's omitted.
    // Getters delegate live to the memoized player so `done`/`progress` are
    // never stale reads of a snapshot.
    useImperativeHandle(
      ref,
      (): CutsceneShellHandle => ({
        skipShot: () => player.skipShot(),
        skipAll: () => player.skipAll(),
        get done() {
          return player.done;
        },
        get progress() {
          return player.progress;
        },
      }),
      [player],
    );

    // Keep the latest callbacks in refs so useFrame never restarts on rerender.
    const onFrameRef = useRef(onFrame);
    onFrameRef.current = onFrame;
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;
    const onProgressRef = useRef(onProgress);
    onProgressRef.current = onProgress;
    const onDoneRef = useRef(onDone);
    onDoneRef.current = onDone;

    const donePosted = useRef(false);

    // Reset the "done" latch if the sequence identity changes.
    useEffect(() => {
      donePosted.current = false;
    }, [sequence]);

    useFrame((_, dt) => {
      if (!active || donePosted.current) return;

      const frame = player.step(dt);

      if (active && frame.camera) {
        camera.position.set(frame.camera.pos[0], frame.camera.pos[1], frame.camera.pos[2]);
        camera.lookAt(frame.camera.lookAt[0], frame.camera.lookAt[1], frame.camera.lookAt[2]);
      }

      onFrameRef.current?.(frame);
      for (const event of frame.events) {
        onEventRef.current?.(event);
      }
      onProgressRef.current?.(player.progress);

      if (frame.done && !donePosted.current) {
        donePosted.current = true;
        onDoneRef.current?.();
      }
    });

    return null;
  },
);
