/**
 * Camera controllers — vanilla three.
 *
 * Three standalone controllers, each a factory that wraps a
 * THREE.PerspectiveCamera and mutates it in place each frame. No React, no
 * WebGL, no DOM event wiring — the consumer feeds a plain `CameraInput` filled
 * from whatever real input source it has (pointer events, gamepad, touch).
 *
 * The feel is distilled from three shipped games:
 *   - project-mmo CameraController — orbit-follow: clamped distance + clamped
 *     elevation, spherical → cartesian, lerp position + lookAt (zero per-frame
 *     allocation via module-scope Vector3 temps).
 *   - storm-break-hockey ChaseCamera — chase orbit that auto-yaws toward the
 *     target's heading when the player isn't dragging.
 *   - woodturning-studio FPSCamera — Euler 'YXZ' yaw/pitch from a look delta
 *     (pitch clamped to avoid flip) + camera-relative WASD translation.
 *
 * THREE-DEPENDENT: imports three (PerspectiveCamera, Vector3, Euler).
 *
 * r3f wrappers are a future TODO — these factories are the shared core they'd
 * consume so vanilla + r3f never drift.
 *
 * NO-ALLOC: every controller pre-allocates its Vector3 / Euler scratch at
 * factory scope and mutates them in place inside `update`. Nothing is allocated
 * per frame.
 */

import * as THREE from 'three';

// ── Shared types ─────────────────────────────────────────────────────────────

// Re-use math's Vec3 (don't re-export — the barrel exports one `Vec3`, from math).
import type { Vec3 } from '../math/index.js';

/**
 * Frame input for a camera controller. The consumer fills the fields it has
 * from real events; every field is optional so a still frame can pass `{}`.
 */
export interface CameraInput {
  /** Look delta in pixels `[dx, dy]` (e.g. pointer move / mouse movement). */
  lookDelta?: [number, number];
  /** Movement axes `[strafe, forward]`, each in [-1, 1] (e.g. WASD / stick). */
  move?: [number, number];
  /** Zoom/dolly delta (e.g. wheel deltaY); + zooms out, − zooms in. */
  zoom?: number;
  /** True while the user is actively dragging to orbit (suppresses auto-yaw). */
  dragging?: boolean;
}

const DEG2RAD = Math.PI / 180;
const TWO_PI = Math.PI * 2;

/** Clamp `v` to [min, max]. */
function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * Frame-rate-independent lerp alpha for an exponential approach. Given a
 * per-second smoothing rate, returns the alpha to use for a step of `dt`
 * seconds so the feel is stable regardless of frame rate.
 */
function easeAlpha(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

// ── Orbit camera ─────────────────────────────────────────────────────────────

/** Tunables for {@link createOrbitCamera}. */
export interface OrbitCameraOptions {
  /** Starting azimuth (yaw around Y), radians. Default 0 (behind target, +Z). */
  azimuth?: number;
  /** Starting elevation (pitch above the XZ plane), radians. Default 25°. */
  elevation?: number;
  /** Starting orbit distance. Clamped to [minDistance, maxDistance]. Default 12. */
  distance?: number;
  /** Closest the camera may orbit. Default 3. */
  minDistance?: number;
  /** Farthest the camera may orbit. Default 20. */
  maxDistance?: number;
  /** Lower elevation clamp, radians. Default 10°. */
  minElevation?: number;
  /** Upper elevation clamp, radians. Default 80°. */
  maxElevation?: number;
  /** Drag sensitivity, radians per pixel. Default 0.006. */
  dragSensitivity?: number;
  /** Zoom sensitivity, distance units per zoom unit. Default 0.008. */
  zoomSensitivity?: number;
  /** Position/lookAt smoothing rate per second. Default 12 (~0.12/frame @60). */
  followRate?: number;
  /** Look target Y offset above the pivot (look slightly above feet). Default 1.2. */
  lookYOffset?: number;
}

/** Orbit-follow camera. See {@link createOrbitCamera}. */
export interface OrbitCamera {
  /**
   * Advance one frame: apply `input` (drag → az/el, zoom → distance), then ease
   * the camera toward the spherical goal around `targetPos` and lookAt it.
   */
  update(targetPos: Vec3, input?: CameraInput): void;
  /** Set azimuth + elevation directly (elevation is clamped). */
  setAngles(az: number, el: number): void;
  /** Move the orbit distance by `delta` (clamped to [min, max]). */
  dolly(delta: number): void;
}

/**
 * Create a third-person orbit-follow camera over `camera`.
 *
 * Orbits `targetPos` at a clamped distance, with an azimuth (free) and a
 * clamped elevation. Each `update` applies input, recomputes the spherical
 * goal, and lerps the camera position + lookAt toward it. Zero per-frame
 * allocation — Vector3 temps are pre-allocated below.
 */
export function createOrbitCamera(
  camera: THREE.PerspectiveCamera,
  opts: OrbitCameraOptions = {},
): OrbitCamera {
  const minDistance = opts.minDistance ?? 3;
  const maxDistance = opts.maxDistance ?? 20;
  const minElevation = opts.minElevation ?? 10 * DEG2RAD;
  const maxElevation = opts.maxElevation ?? 80 * DEG2RAD;
  const dragSensitivity = opts.dragSensitivity ?? 0.006;
  const zoomSensitivity = opts.zoomSensitivity ?? 0.008;
  const followRate = opts.followRate ?? 12;
  const lookYOffset = opts.lookYOffset ?? 1.2;

  let azimuth = opts.azimuth ?? 0;
  let elevation = clamp(opts.elevation ?? 25 * DEG2RAD, minElevation, maxElevation);
  let distance = clamp(opts.distance ?? 12, minDistance, maxDistance);

  // Pre-allocated temps — mutated in place each frame (no per-frame alloc).
  const _desired = new THREE.Vector3();
  const _lookAt = new THREE.Vector3();

  return {
    update(targetPos: Vec3, input: CameraInput = {}): void {
      // Apply drag → azimuth/elevation (clamped).
      const look = input.lookDelta;
      if (look) {
        azimuth -= look[0] * dragSensitivity;
        elevation = clamp(elevation + look[1] * dragSensitivity, minElevation, maxElevation);
      }
      // Apply zoom → distance (clamped).
      if (input.zoom) {
        distance = clamp(distance + input.zoom * zoomSensitivity, minDistance, maxDistance);
      }

      // Spherical → cartesian (az = yaw around Y, el = pitch above XZ plane).
      const px = targetPos[0];
      const py = targetPos[1];
      const pz = targetPos[2];
      const cosEl = Math.cos(elevation);
      _desired.set(
        px + distance * cosEl * Math.sin(azimuth),
        py + distance * Math.sin(elevation),
        pz + distance * Math.cos(azimuth) * cosEl,
      );

      // Ease toward the goal (frame-rate independent). dt unknown here, so use a
      // fixed alpha approximating followRate at ~60 Hz; consumers wanting strict
      // dt-independence can pass small consistent steps.
      const alpha = easeAlpha(followRate, 1 / 60);
      camera.position.lerp(_desired, alpha);

      _lookAt.set(px, py + lookYOffset, pz);
      camera.lookAt(_lookAt);
    },

    setAngles(az: number, el: number): void {
      azimuth = az;
      elevation = clamp(el, minElevation, maxElevation);
    },

    dolly(delta: number): void {
      distance = clamp(distance + delta, minDistance, maxDistance);
    },
  };
}

// ── Chase camera ─────────────────────────────────────────────────────────────

/** Tunables for {@link createChaseCamera}. Extends the orbit options. */
export interface ChaseCameraOptions extends OrbitCameraOptions {
  /** Auto-yaw rate toward the target heading when not dragging, per second. Default 2.4. */
  autoYawRate?: number;
}

/** Chase camera — orbit that auto-yaws behind the target. See {@link createChaseCamera}. */
export interface ChaseCamera {
  /**
   * Advance one frame. Like the orbit update, but when the user is NOT dragging,
   * azimuth eases toward `targetHeading` so the camera stays behind the target.
   */
  update(targetPos: Vec3, targetHeading: number, input?: CameraInput): void;
}

/**
 * Create a third-person chase camera over `camera`.
 *
 * Identical orbit framing to {@link createOrbitCamera}, plus: when the user is
 * not dragging (`input.dragging` falsy), the azimuth gently rotates toward
 * `targetHeading` (the direction the target faces) along the shortest arc, so
 * the camera never drifts to a corner on sharp turns. Zero per-frame alloc.
 */
export function createChaseCamera(
  camera: THREE.PerspectiveCamera,
  opts: ChaseCameraOptions = {},
): ChaseCamera {
  const minDistance = opts.minDistance ?? 3;
  const maxDistance = opts.maxDistance ?? 20;
  const minElevation = opts.minElevation ?? 10 * DEG2RAD;
  const maxElevation = opts.maxElevation ?? 80 * DEG2RAD;
  const dragSensitivity = opts.dragSensitivity ?? 0.006;
  const zoomSensitivity = opts.zoomSensitivity ?? 0.008;
  const followRate = opts.followRate ?? 12;
  const lookYOffset = opts.lookYOffset ?? 1.2;
  const autoYawRate = opts.autoYawRate ?? 2.4;

  let azimuth = opts.azimuth ?? 0;
  let elevation = clamp(opts.elevation ?? 25 * DEG2RAD, minElevation, maxElevation);
  let distance = clamp(opts.distance ?? 12, minDistance, maxDistance);

  const _desired = new THREE.Vector3();
  const _lookAt = new THREE.Vector3();

  return {
    update(targetPos: Vec3, targetHeading: number, input: CameraInput = {}): void {
      const look = input.lookDelta;
      if (look) {
        azimuth -= look[0] * dragSensitivity;
        elevation = clamp(elevation + look[1] * dragSensitivity, minElevation, maxElevation);
      }
      if (input.zoom) {
        distance = clamp(distance + input.zoom * zoomSensitivity, minDistance, maxDistance);
      }

      // Auto-yaw toward the target heading when the player isn't orbiting.
      if (!input.dragging) {
        // Shortest-arc difference wrapped to (-π, π].
        let diff = (targetHeading - azimuth) % TWO_PI;
        if (diff > Math.PI) diff -= TWO_PI;
        else if (diff <= -Math.PI) diff += TWO_PI;
        azimuth += diff * easeAlpha(autoYawRate, 1 / 60);
      }

      const px = targetPos[0];
      const py = targetPos[1];
      const pz = targetPos[2];
      const cosEl = Math.cos(elevation);
      _desired.set(
        px + distance * cosEl * Math.sin(azimuth),
        py + distance * Math.sin(elevation),
        pz + distance * Math.cos(azimuth) * cosEl,
      );

      camera.position.lerp(_desired, easeAlpha(followRate, 1 / 60));

      _lookAt.set(px, py + lookYOffset, pz);
      camera.lookAt(_lookAt);
    },
  };
}

// ── First-person camera ──────────────────────────────────────────────────────

/** Tunables for {@link createFirstPersonCamera}. */
export interface FirstPersonCameraOptions {
  /** Starting yaw (around Y), radians. Default 0 (looking −Z). */
  yaw?: number;
  /** Starting pitch (around X), radians. Default 0 (level). */
  pitch?: number;
  /** Look sensitivity, radians per pixel of `lookDelta`. Default 0.0025. */
  lookSensitivity?: number;
  /** If true, vertical look is inverted. Default false. */
  invertY?: boolean;
  /** Pitch clamp magnitude, radians. Default ~85°. */
  pitchLimit?: number;
  /**
   * Movement speed in units per second. Default 2.2. Pass a GETTER (`() => number`)
   * to vary speed at runtime (e.g. a sprint toggle) without recreating the controller.
   */
  moveSpeed?: number | (() => number);
}

/** First-person camera. See {@link createFirstPersonCamera}. */
export interface FirstPersonCamera {
  /**
   * Advance one frame over `dt` seconds: rotate yaw/pitch from `input.lookDelta`
   * (pitch clamped), then translate the camera by camera-relative `input.move`.
   */
  update(dt: number, input: CameraInput): void;
  /** Teleport the camera to `p` (does not change yaw/pitch). */
  setPosition(p: Vec3): void;
}

/**
 * Create a first-person camera over `camera`.
 *
 * `lookDelta` accumulates into yaw (around Y) and pitch (around X), pitch
 * clamped to ±`pitchLimit` so the view never flips. Orientation is written via
 * a single Euler 'YXZ' quaternion. `move` translates the camera relative to its
 * current yaw on the XZ plane (no vertical drift). Zero per-frame allocation.
 */
export function createFirstPersonCamera(
  camera: THREE.PerspectiveCamera,
  opts: FirstPersonCameraOptions = {},
): FirstPersonCamera {
  const lookSensitivity = opts.lookSensitivity ?? 0.0025;
  const invertY = opts.invertY ?? false;
  const pitchLimit = opts.pitchLimit ?? 85 * DEG2RAD;
  // moveSpeed may be a live getter (sprint) — resolve it PER FRAME below.
  const staticSpeed = typeof opts.moveSpeed === "number" ? opts.moveSpeed : 2.2;
  const getMoveSpeed: () => number =
    typeof opts.moveSpeed === "function" ? opts.moveSpeed : () => staticSpeed;

  let yaw = opts.yaw ?? 0;
  let pitch = clamp(opts.pitch ?? 0, -pitchLimit, pitchLimit);

  // Pre-allocated scratch — mutated in place each frame (no per-frame alloc).
  const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const _forward = new THREE.Vector3();
  const _right = new THREE.Vector3();

  return {
    update(dt: number, input: CameraInput): void {
      // ── Look: accumulate yaw/pitch, clamp pitch ──────────────────────────
      const look = input.lookDelta;
      if (look) {
        const ySign = invertY ? -1 : 1;
        yaw -= look[0] * lookSensitivity;
        pitch -= look[1] * lookSensitivity * ySign;
        pitch = clamp(pitch, -pitchLimit, pitchLimit);
      }
      _euler.set(pitch, yaw, 0, 'YXZ');
      camera.quaternion.setFromEuler(_euler);

      // ── Move: camera-relative on the XZ plane ────────────────────────────
      const move = input.move;
      if (move && (move[0] !== 0 || move[1] !== 0)) {
        const strafe = move[0];
        const forward = move[1];
        // Forward on the XZ plane from yaw (yaw=0 → −Z). Allocation-free.
        const sinY = Math.sin(yaw);
        const cosY = Math.cos(yaw);
        _forward.set(-sinY, 0, -cosY);
        // Right = forward × +Y projected to XZ → (-fz, 0, fx).
        _right.set(-_forward.z, 0, _forward.x);

        const dist = getMoveSpeed() * dt;
        camera.position.x += (_forward.x * forward + _right.x * strafe) * dist;
        camera.position.z += (_forward.z * forward + _right.z * strafe) * dist;
      }
    },

    setPosition(p: Vec3): void {
      camera.position.set(p[0], p[1], p[2]);
    },
  };
}

// ── Unified GameCamera config (pure, THREE-free, unit-testable) ───────────────
//
// The three controllers above are the shared vanilla core. The r3f layer
// (./r3f.tsx) exposes a single `<GameCamera mode … />` / `useGameCamera({ mode
// … })` that picks one of three modes and wires BOTH the camera and its
// controls so a game just names a mode:
//
//   - "first"   — pointer-lock mouse-look + WASD at a fixed eye height, with an
//                 optional bounds/collision hook. Harvested from GYRE's
//                 hand-built player.tsx (pointer-lock lifecycle, pitch clamp,
//                 WASD, eye height, cylinder/AABB collision).
//   - "third"   — chase/orbit camera following a target: mouse-orbit + scroll
//                 zoom + smoothed follow (wraps createOrbitCamera).
//   - "topdown" — 2D top-down: camera straight down over a target on the XZ
//                 plane, WASD pans the target on the ground, no pitch.
//
// The helpers below are the PURE pieces (no three, no DOM) that both the r3f
// layer and the test consume, so the math never drifts from the wiring.

/** Which of the three built-in camera modes to run. */
export type GameCameraMode = 'first' | 'third' | 'topdown';

/**
 * Options shared across every mode. Every field is optional; each mode reads
 * only the ones it cares about and falls back to a sensible default.
 */
export interface GameCameraOptions {
  /** WASD/stick movement speed, units per second. Default 2.2 (`first`/`topdown`). */
  moveSpeed?: number;
  /** Mouse-look sensitivity, radians per pixel. Default 0.0025 (`first`). */
  lookSensitivity?: number;
  /** Invert vertical look. Default false. */
  invertY?: boolean;

  // ── first-person ──
  /**
   * Camera eye height, held every frame (no vertical drift within a frame).
   * Default 1.7. Pass a GETTER (`() => number`) to vary height at runtime —
   * e.g. a floor-aware `layout` locomotion's `elevation() + eyeOffset` on a
   * multi-floor level (stairs) — read fresh every frame without recreating
   * the FP controller (same live-getter treatment as `moveSpeed`).
   */
  eyeHeight?: number | (() => number);
  /** Pitch clamp magnitude, radians. Default ~85°. */
  pitchLimit?: number;

  // ── third-person orbit/chase ──
  /** Orbit distance from the target. Clamped to [minZoom, maxZoom]. Default 12. */
  distance?: number;
  /** Closest the camera may zoom. Default 3. */
  minZoom?: number;
  /** Farthest the camera may zoom. Default 20. */
  maxZoom?: number;
  /** Look target Y offset above the pivot. Default 1.2. */
  lookYOffset?: number;
  /** Position/lookAt smoothing rate per second. Default 12. */
  followRate?: number;
  /** Orbit drag sensitivity, radians per pixel. Default 0.006. */
  dragSensitivity?: number;
  /** Zoom sensitivity, distance units per wheel unit. Default 0.008. */
  zoomSensitivity?: number;

  // ── top-down ──
  /** Height of the top-down camera above the ground plane. Default 20. */
  height?: number;
}

/** All GameCamera options with defaults filled in — the resolved config. */
export interface ResolvedGameCameraOptions {
  moveSpeed: number;
  lookSensitivity: number;
  invertY: boolean;
  eyeHeight: number;
  pitchLimit: number;
  distance: number;
  minZoom: number;
  maxZoom: number;
  lookYOffset: number;
  followRate: number;
  dragSensitivity: number;
  zoomSensitivity: number;
  height: number;
}

/**
 * Fill every {@link GameCameraOptions} field with its default. Pure: same input
 * → same output, no state. `minZoom`/`maxZoom` are kept ordered and `distance`
 * is clamped into that range so downstream orbit math never sees an inverted or
 * out-of-range window.
 */
export function resolveGameCameraOptions(
  opts: GameCameraOptions = {},
): ResolvedGameCameraOptions {
  const minZoom = opts.minZoom ?? 3;
  const maxZoom = opts.maxZoom ?? 20;
  const lo = Math.min(minZoom, maxZoom);
  const hi = Math.max(minZoom, maxZoom);
  return {
    moveSpeed: opts.moveSpeed ?? 2.2,
    lookSensitivity: opts.lookSensitivity ?? 0.0025,
    invertY: opts.invertY ?? false,
    eyeHeight: resolveEyeHeight(opts.eyeHeight),
    pitchLimit: opts.pitchLimit ?? 85 * DEG2RAD,
    distance: clamp(opts.distance ?? 12, lo, hi),
    minZoom: lo,
    maxZoom: hi,
    lookYOffset: opts.lookYOffset ?? 1.2,
    followRate: opts.followRate ?? 12,
    dragSensitivity: opts.dragSensitivity ?? 0.006,
    zoomSensitivity: opts.zoomSensitivity ?? 0.008,
    height: opts.height ?? 20,
  };
}

/**
 * Resolve an {@link GameCameraOptions.eyeHeight} value (number, getter, or
 * omitted) to a single number — the getter is invoked once here for the
 * "resolved snapshot" (initial placement / static callers). Default 1.7.
 * The r3f `useGameCamera` layer reads the RAW `options.eyeHeight` again, per
 * frame, via a ref (see r3f.tsx) so a getter stays live without recreating
 * the FP controller — this function is the shared resolution the ref falls
 * back to when no getter is supplied.
 */
export function resolveEyeHeight(eyeHeight: number | (() => number) | undefined): number {
  if (typeof eyeHeight === 'function') return eyeHeight();
  return eyeHeight ?? 1.7;
}

/**
 * Clamp a first-person pitch to ±`limit` radians so the view never flips past
 * straight up/down. Pure mirror of the clamp inside {@link createFirstPersonCamera}.
 */
export function clampPitch(pitch: number, limit: number = 85 * DEG2RAD): number {
  const l = Math.abs(limit);
  return clamp(pitch, -l, l);
}

/**
 * Third-person orbit offset from a target: given azimuth (yaw around Y),
 * elevation (pitch above the XZ plane) and distance, return the camera position
 * `[x, y, z]` that orbits `target`. Same spherical→cartesian mapping the orbit
 * controller integrates, exposed as a pure function for tests / static rigs.
 */
export function orbitOffset(
  target: Vec3,
  azimuth: number,
  elevation: number,
  distance: number,
): [number, number, number] {
  const cosEl = Math.cos(elevation);
  return [
    target[0] + distance * cosEl * Math.sin(azimuth),
    target[1] + distance * Math.sin(elevation),
    target[2] + distance * Math.cos(azimuth) * cosEl,
  ];
}

/**
 * Top-down camera eye position: straight up over the target on the XZ plane at
 * `height`. No pitch — the camera looks down −Y at the target.
 */
export function topDownEyePosition(target: Vec3, height: number): [number, number, number] {
  return [target[0], target[1] + height, target[2]];
}

/**
 * Camera-relative ground movement on the XZ plane from a yaw and WASD axes.
 * `move` is `[strafe, forward]` each in [-1, 1]; returns the `[dx, dz]` delta to
 * add for `dt` seconds at `speed`. yaw=0 faces −Z (matches the FP controller).
 * Pure — shared by first-person and top-down so both walk identically.
 */
export function groundMoveDelta(
  yaw: number,
  move: [number, number],
  speed: number,
  dt: number,
): [number, number] {
  const strafe = move[0];
  const forward = move[1];
  if (strafe === 0 && forward === 0) return [0, 0];
  const sinY = Math.sin(yaw);
  const cosY = Math.cos(yaw);
  // forward = (-sinY, -cosY); right = (-forward.z, forward.x) = (cosY, -sinY).
  const fx = -sinY;
  const fz = -cosY;
  const rx = -fz; // = cosY
  const rz = fx; // = -sinY
  const dist = speed * dt;
  return [(fx * forward + rx * strafe) * dist, (fz * forward + rz * strafe) * dist];
}

/**
 * A collision/bounds constraint the game supplies so first-person / top-down
 * movement stays inside its level. Given the position the controller just
 * integrated, return the corrected `[x, z]` (Y is owned by the mode: eye height
 * for first, target Y for top-down). Return the input unchanged to allow it.
 *
 * This is the exact hook GYRE's player.tsx open-coded (cylinder clamp inside the
 * room's outer wall, outside the central Coil) — now a first-class kit concept.
 */
export type BoundsConstraint = (x: number, z: number) => [number, number];

/** Axis-aligned rectangle on the XZ plane, for {@link aabbBounds}. */
export interface AABBBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/**
 * A {@link BoundsConstraint} that clamps movement into an axis-aligned rectangle
 * on the ground plane (the common "keep the player inside the room" case).
 */
export function aabbBounds(b: AABBBounds): BoundsConstraint {
  const minX = Math.min(b.minX, b.maxX);
  const maxX = Math.max(b.minX, b.maxX);
  const minZ = Math.min(b.minZ, b.maxZ);
  const maxZ = Math.max(b.minZ, b.maxZ);
  return (x, z) => [clamp(x, minX, maxX), clamp(z, minZ, maxZ)];
}

/**
 * A {@link BoundsConstraint} keeping movement inside a circle of `radius`
 * centered at (`cx`, `cz`) on the XZ plane — the cylinder-collision pattern
 * harvested from GYRE (keep the player inside the room's inradius). Optionally
 * also keep them OUTSIDE an inner "hole" of `innerRadius` (e.g. a pit / drop).
 */
export function cylinderBounds(
  radius: number,
  cx = 0,
  cz = 0,
  innerRadius = 0,
): BoundsConstraint {
  const outer = Math.abs(radius);
  const inner = Math.abs(innerRadius);
  return (x, z) => {
    const dx = x - cx;
    const dz = z - cz;
    const r = Math.hypot(dx, dz);
    // Push back inside the outer wall.
    if (r > outer) {
      if (r === 0) return [cx + outer, cz];
      const s = outer / r;
      return [cx + dx * s, cz + dz * s];
    }
    // Push back out of the inner hole.
    if (inner > 0 && r < inner) {
      if (r === 0) return [cx + inner, cz]; // degenerate: nudge along +X
      const s = inner / r;
      return [cx + dx * s, cz + dz * s];
    }
    return [x, z];
  };
}
