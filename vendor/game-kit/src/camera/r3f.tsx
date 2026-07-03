/**
 * Camera controllers — react-three-fiber variant.
 *
 * Thin hooks wrapping the vanilla controllers (createOrbitCamera /
 * createChaseCamera / createFirstPersonCamera). Each hook grabs the active
 * `useThree().camera`, builds the controller once via `useMemo`, then drives it
 * every frame from `useFrame`. The hooks supply input/target via getter
 * callbacks so the parent never has to re-render to push new state.
 *
 * The controllers require a PerspectiveCamera; we guard at construction so a
 * misconfigured <Canvas/> (orthographic) fails loudly rather than silently.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  createOrbitCamera,
  createChaseCamera,
  createFirstPersonCamera,
  resolveGameCameraOptions,
  resolveEyeHeight,
  groundMoveDelta,
  topDownEyePosition,
  type OrbitCamera,
  type OrbitCameraOptions,
  type ChaseCamera,
  type ChaseCameraOptions,
  type FirstPersonCamera,
  type FirstPersonCameraOptions,
  type CameraInput,
  type GameCameraMode,
  type GameCameraOptions,
  type BoundsConstraint,
} from './index.js';
import { createInputMap } from '../input/index.js';
import type { Vec3 } from '../math/index.js';

/** Narrow the active scene camera to a PerspectiveCamera, or throw. */
function asPerspective(camera: THREE.Camera): THREE.PerspectiveCamera {
  if (!(camera instanceof THREE.PerspectiveCamera)) {
    throw new Error(
      'game-kit/r3f camera hooks require a PerspectiveCamera; the active <Canvas/> camera is not one.',
    );
  }
  return camera;
}

/**
 * Drive a third-person orbit-follow camera over the active scene camera.
 *
 * `getTarget` returns the current follow point each frame; `getInput` returns
 * the frame's {@link CameraInput} (drag / zoom). Returns the underlying
 * {@link OrbitCamera} for imperative calls (setAngles / dolly).
 */
export function useOrbitCamera(
  getTarget: () => Vec3,
  getInput?: () => CameraInput,
  opts?: OrbitCameraOptions,
): OrbitCamera {
  const camera = useThree((s) => s.camera);
  const controller = useMemo(
    () => createOrbitCamera(asPerspective(camera), opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera],
  );
  useFrame(() => {
    controller.update(getTarget(), getInput?.());
  });
  return controller;
}

/**
 * Drive a third-person chase camera (auto-yaws behind the target) over the
 * active scene camera. `getHeading` returns the direction the target faces each
 * frame. Returns the underlying {@link ChaseCamera}.
 */
export function useChaseCamera(
  getTarget: () => Vec3,
  getHeading: () => number,
  getInput?: () => CameraInput,
  opts?: ChaseCameraOptions,
): ChaseCamera {
  const camera = useThree((s) => s.camera);
  const controller = useMemo(
    () => createChaseCamera(asPerspective(camera), opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera],
  );
  useFrame(() => {
    controller.update(getTarget(), getHeading(), getInput?.());
  });
  return controller;
}

/**
 * Drive a first-person camera over the active scene camera. `getInput` returns
 * the frame's {@link CameraInput} (look delta + move axes); the hook feeds the
 * real per-frame `dt` from `useFrame`. Returns the underlying
 * {@link FirstPersonCamera} for imperative calls (setPosition).
 */
export function useFirstPersonCamera(
  getInput: () => CameraInput,
  opts?: FirstPersonCameraOptions,
): FirstPersonCamera {
  const camera = useThree((s) => s.camera);
  const controller = useMemo(
    () => createFirstPersonCamera(asPerspective(camera), opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [camera],
  );
  useFrame((_, dt) => {
    controller.update(dt, getInput());
  });
  return controller;
}

// ── Unified GameCamera — pick a mode, get camera + controls wired ─────────────
//
// `useGameCamera({ mode, ... })` / `<GameCamera mode ... />` is the one-call API:
// name a mode and it wires BOTH the camera and its controls. The DOM input
// plumbing (pointer-lock lifecycle, held-key WASD via the kit input map, mouse
// look/orbit/zoom accumulation) is HARVESTED from GYRE's hand-built player.tsx
// and shared across all three modes so no game hand-wires it again.

/**
 * The per-frame input shape `useCameraInput` (below) produces and every mode's
 * `useFrame` drains. Any object matching this shape can stand in for the
 * built-in pointer-lock/keyboard rig — see {@link GameCameraProps.inputOverride}.
 * `touch/r3f.tsx`'s `TouchControls` `onReady` callback hands back exactly this.
 */
export interface GameCameraIO {
  /** Accumulated look delta since the last drain, `[dx, dy]`, then reset. */
  drainLook(): [number, number];
  /** Current move axes `[strafe, forward]`, each typically in [-1, 1]. */
  moveAxes(): [number, number];
  /** Accumulated zoom/dolly delta since the last drain, then reset. */
  drainZoom(): number;
  /** True while the user is actively dragging to orbit (third/topdown). */
  isDragging(): boolean;
}

/** Props/args for {@link useGameCamera} / {@link GameCamera}. */
export interface GameCameraProps {
  /** Which built-in mode to run. */
  mode: GameCameraMode;
  /**
   * Follow/pivot point.
   * - "third"/"topdown": the point the camera follows (required to move it).
   * - "first": optional spawn XZ (Y is forced to `eyeHeight`); read once on mount.
   */
  target?: Vec3;
  /**
   * Movement constraint applied AFTER integration ("first"/"topdown"): given the
   * new `[x, z]`, return the corrected `[x, z]`. Use {@link aabbBounds} /
   * {@link cylinderBounds} or supply your own. This is GYRE's collision hook,
   * lifted into the kit.
   */
  bounds?: BoundsConstraint;
  /** Tunables (moveSpeed, lookSensitivity, distance/zoom, eyeHeight, ...). */
  options?: GameCameraOptions;
  /**
   * Called once with a live getter for the camera world position — handy for
   * first-person games that need the eye position (e.g. audio listeners).
   */
  onReady?: (getPos: () => THREE.Vector3) => void;
  /**
   * OPT-IN: an alternate {@link GameCameraIO} used INSTEAD of the built-in
   * `useCameraInput` pointer-lock/keyboard rig — e.g. `TouchControls`' `onReady`
   * io (`touch/r3f.tsx`), for mobile. When omitted (the default), behavior is
   * EXACTLY the existing pointer-lock/keyboard/drag/wheel rig, unchanged. When
   * provided, its io fully REPLACES the built-in rig's output for this
   * instance (the two sources are mutually exclusive per `GameCamera`, no
   * merging) — `useCameraInput` still mounts (Rules of Hooks) but its DOM
   * listeners simply go unread.
   */
  inputOverride?: GameCameraIO;
}

/** Handle returned by {@link useGameCamera} for imperative teleports. */
export interface GameCameraHandle {
  /** The mode this instance is running. */
  mode: GameCameraMode;
  /** Teleport the camera / target to `p`. */
  setPosition(p: Vec3): void;
}

/**
 * Shared DOM input rig: pointer-lock mouse-look + held-key WASD (via the kit
 * input map). `lockOnClick` requests pointer lock on canvas click (first-person)
 * — third/top-down use free drag-to-orbit and pass `false`. Returns per-frame
 * getters the modes drain: `drainLook()` (accumulated `[dx, dy]`, zeroed),
 * `moveAxes()` (`[strafe, forward]`), `drainZoom()` and `isDragging()`.
 */
function useCameraInput(lockOnClick: boolean) {
  const input = useMemo(
    () =>
      createInputMap([
        { id: 'forward', default: 'w' },
        { id: 'back', default: 's' },
        { id: 'left', default: 'a' },
        { id: 'right', default: 'd' },
      ]),
    [],
  );
  const held = useRef<Set<string>>(new Set());
  const look = useRef<[number, number]>([0, 0]);
  const zoom = useRef(0);
  const locked = useRef(false);
  const dragging = useRef(false);

  useEffect(() => {
    const dom = document.querySelector('canvas');

    const onKeyDown = (e: KeyboardEvent) => {
      const action = input.actionFor(e.key);
      if (action) held.current.add(action);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = input.actionFor(e.key);
      if (action) held.current.delete(action);
    };
    const onMouseMove = (e: MouseEvent) => {
      // Pointer-lock look (first-person) OR drag-to-orbit (third/topdown).
      if (lockOnClick ? locked.current : dragging.current) {
        look.current[0] += e.movementX;
        look.current[1] += e.movementY;
      }
    };
    const onLockChange = () => {
      locked.current = document.pointerLockElement === dom;
      if (!locked.current) held.current.clear(); // drop keys when focus leaves
    };
    const onCanvasClick = () => {
      if (lockOnClick) dom?.requestPointerLock?.();
    };
    const onDown = () => {
      if (!lockOnClick) dragging.current = true;
    };
    const onUp = () => {
      dragging.current = false;
    };
    const onWheel = (e: WheelEvent) => {
      zoom.current += e.deltaY;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onUp);
    document.addEventListener('pointerlockchange', onLockChange);
    dom?.addEventListener('click', onCanvasClick);
    dom?.addEventListener('mousedown', onDown);
    dom?.addEventListener('wheel', onWheel, { passive: true });

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onUp);
      document.removeEventListener('pointerlockchange', onLockChange);
      dom?.removeEventListener('click', onCanvasClick);
      dom?.removeEventListener('mousedown', onDown);
      dom?.removeEventListener('wheel', onWheel);
    };
  }, [input, lockOnClick]);

  return {
    /** Accumulated look delta, drained (zeroed) so a still frame passes none. */
    drainLook(): [number, number] {
      const dx = look.current[0];
      const dy = look.current[1];
      look.current[0] = 0;
      look.current[1] = 0;
      return [dx, dy];
    },
    /** Current WASD axes `[strafe, forward]`, each in {-1, 0, 1}. */
    moveAxes(): [number, number] {
      const h = held.current;
      const strafe = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
      const forward = (h.has('forward') ? 1 : 0) - (h.has('back') ? 1 : 0);
      return [strafe, forward];
    },
    /** Accumulated wheel delta, drained. */
    drainZoom(): number {
      const z = zoom.current;
      zoom.current = 0;
      return z;
    },
    /** True while the user is dragging to orbit (third/topdown). */
    isDragging(): boolean {
      return dragging.current;
    },
  };
}

/**
 * The one-call camera + controls hook. Name a `mode`; it grabs the active scene
 * camera, wires the mode's controls, and drives it every frame. Returns a
 * {@link GameCameraHandle} for imperative teleports.
 *
 * - **first**  — pointer-lock mouse-look + WASD at a fixed eye height, with the
 *   optional `bounds` collision hook (harvested from GYRE's player.tsx).
 * - **third**  — orbit-follow `target`: drag to orbit (yaw/pitch), scroll to
 *   zoom, smoothed follow (wraps {@link createOrbitCamera}).
 * - **topdown** — camera straight down over `target`; WASD pans the target on
 *   the XZ plane; no pitch. `bounds` constrains the target.
 */
export function useGameCamera(props: GameCameraProps): GameCameraHandle {
  const { mode, options, bounds, inputOverride } = props;
  const camera = useThree((s) => s.camera);
  const resolved = useMemo(() => resolveGameCameraOptions(options), [options]);
  // Keep the live moveSpeed in a ref so the FP controller (created once) can read the
  // CURRENT value each frame — lets a game vary speed at runtime (sprint) without
  // recreating the controller (which would reset look).
  const moveSpeedRef = useRef(resolved.moveSpeed);
  moveSpeedRef.current = resolved.moveSpeed;
  // Same live-getter treatment for eyeHeight: keep the RAW option (number OR
  // getter) in a ref and resolve it fresh every frame in useFrame below — a
  // floor-aware `layout` locomotion's `elevation()` changes every frame from
  // walking (not from a React re-render), so this must be read directly,
  // never memoized. `resolved.eyeHeight` (a one-time snapshot) still seeds
  // the initial placement effect below.
  const eyeHeightOptRef = useRef(options?.eyeHeight);
  eyeHeightOptRef.current = options?.eyeHeight;
  // DEFAULT UNCHANGED: `useCameraInput` (pointer-lock/keyboard) is the io source
  // unless the caller opts into `inputOverride` (e.g. TouchControls), in which
  // case the built-in rig is skipped entirely — no merging of the two sources.
  // With an override, lockOnClick is ALSO suppressed: a canvas tap on a touch
  // device must not request pointer lock.
  const builtinIo = useCameraInput(mode === 'first' && !inputOverride);
  const io: GameCameraIO = inputOverride ?? builtinIo;

  // Keep the latest prop getters in refs so useFrame never restarts on rerender.
  const targetRef = useRef(props.target);
  targetRef.current = props.target;
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  // ── first-person: reuse the vanilla FP controller, then constrain ──────────
  const fp = useMemo<FirstPersonCamera | null>(() => {
    if (mode !== 'first') return null;
    return createFirstPersonCamera(asPerspective(camera), {
      lookSensitivity: resolved.lookSensitivity,
      invertY: resolved.invertY,
      pitchLimit: resolved.pitchLimit,
      moveSpeed: () => moveSpeedRef.current, // live (sprint) — read per frame
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, mode]);

  // ── third-person: reuse the vanilla orbit controller ───────────────────────
  const orbit = useMemo<OrbitCamera | null>(() => {
    if (mode !== 'third') return null;
    return createOrbitCamera(asPerspective(camera), {
      distance: resolved.distance,
      minDistance: resolved.minZoom,
      maxDistance: resolved.maxZoom,
      lookYOffset: resolved.lookYOffset,
      followRate: resolved.followRate,
      dragSensitivity: resolved.dragSensitivity,
      zoomSensitivity: resolved.zoomSensitivity,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, mode]);

  // ── top-down: internal target the camera looks straight down at ────────────
  // Seeded from `target` on mount; WASD pans it, then `bounds` constrains it.
  const groundTarget = useRef<[number, number, number]>([0, 0, 0]);

  // Initial placement: eye height (first) / seed the top-down target.
  useEffect(() => {
    const t = targetRef.current;
    if (mode === 'first') {
      const x = t ? t[0] : camera.position.x;
      const z = t ? t[2] : camera.position.z;
      camera.position.set(x, resolveEyeHeight(eyeHeightOptRef.current), z);
    } else if (mode === 'topdown') {
      groundTarget.current = t ? [t[0], t[1], t[2]] : [0, 0, 0];
    }
    props.onReady?.(() => camera.position);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  useFrame((_, dt) => {
    if (mode === 'first' && fp) {
      const move = io.moveAxes();
      fp.update(dt, { lookDelta: io.drainLook(), move });
      // Post-move constraints: eye height (live — re-resolved every frame so
      // a getter tracks e.g. stair elevation) + optional collision hook.
      camera.position.y = resolveEyeHeight(eyeHeightOptRef.current);
      const c = boundsRef.current;
      if (c) {
        const [x, z] = c(camera.position.x, camera.position.z);
        camera.position.x = x;
        camera.position.z = z;
      }
      return;
    }

    if (mode === 'third' && orbit) {
      const t = targetRef.current ?? [0, 0, 0];
      orbit.update(t, { lookDelta: io.drainLook(), zoom: io.drainZoom(), dragging: io.isDragging() });
      return;
    }

    if (mode === 'topdown') {
      const g = groundTarget.current;
      const ext = targetRef.current;
      if (ext) {
        // FOLLOW: the game drives the target directly (WASD ignored).
        g[0] = ext[0];
        g[1] = ext[1];
        g[2] = ext[2];
      } else {
        // PAN: WASD moves the target on the XZ plane (yaw 0 → screen-up is −Z),
        // then the bounds hook constrains it.
        const [dx, dz] = groundMoveDelta(0, io.moveAxes(), resolved.moveSpeed, dt);
        let nx = g[0] + dx;
        let nz = g[2] + dz;
        const c = boundsRef.current;
        if (c) {
          const [cx, cz] = c(nx, nz);
          nx = cx;
          nz = cz;
        }
        g[0] = nx;
        g[2] = nz;
      }
      const [ex, ey, ez] = topDownEyePosition(g as unknown as Vec3, resolved.height);
      camera.position.set(ex, ey, ez);
      camera.lookAt(g[0], g[1], g[2]);
    }
  });

  return {
    mode,
    setPosition(p: Vec3): void {
      if (mode === 'topdown') {
        groundTarget.current = [p[0], p[1], p[2]];
      } else if (mode === 'first') {
        camera.position.set(p[0], resolveEyeHeight(eyeHeightOptRef.current), p[2]);
      } else {
        camera.position.set(p[0], p[1], p[2]);
      }
    },
  };
}

/**
 * Declarative form of {@link useGameCamera}. Drop `<GameCamera mode="first" />`
 * (or "third"/"topdown") inside a `<Canvas>` and the camera + its controls are
 * wired. Renders nothing.
 */
export function GameCamera(props: GameCameraProps): null {
  useGameCamera(props);
  return null;
}
