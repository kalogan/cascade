/**
 * Companion follow / steering (Track B3).
 *
 * Distilled from Wayfinders' `tickCompanionFollow`: a reactive steering controller that
 * chases a MOVING target (the owner), arrives without crowding it, and separates from peers.
 * Unlike the behavior runtime (B2, which paths to a fixed goal), this is local steering —
 * compose it with a `Pathfinder` when the follower must also route around walls.
 *
 * Pure + deterministic (no clock, no RNG): position is a function of the per-tick `dt` and
 * the target/peer positions. THREE-free (`[x, z]`). The game renders the synced position.
 */

import type { Vec2 } from '../nav/index.js';

export interface FollowerOptions {
  /** Starting world position. Default [0, 0]. */
  start?: Vec2;
  /** Max movement speed in units/sec. Default 3. */
  speed?: number;
  /** Stop (arrive) once within this distance of the target — don't crowd it. Default 1.5. */
  stopDistance?: number;
  /** Begin slowing within this distance beyond `stopDistance`. Default 3. */
  slowRadius?: number;
  /** Push away from peers within this distance (0 disables). Default 1. */
  separationRadius?: number;
}

export interface FollowerState {
  position: Vec2;
  velocity: Vec2;
}

export interface Follower {
  readonly position: Vec2;
  state(): FollowerState;
  /**
   * Advance one tick: steer toward `target` (arrive), pushing away from any `peers` within
   * the separation radius. Returns the new state.
   */
  tick(dtSeconds: number, target: Vec2, peers?: readonly Vec2[]): FollowerState;
}

function len(x: number, z: number): number {
  return Math.hypot(x, z);
}

export function createFollower(opts: FollowerOptions = {}): Follower {
  const speed = opts.speed ?? 3;
  const stopDistance = opts.stopDistance ?? 1.5;
  const slowRadius = opts.slowRadius ?? 3;
  const separationRadius = opts.separationRadius ?? 1;

  let position: Vec2 = opts.start ? [opts.start[0], opts.start[1]] : [0, 0];
  let velocity: Vec2 = [0, 0];

  function snapshot(): FollowerState {
    return { position: [position[0], position[1]], velocity: [velocity[0], velocity[1]] };
  }

  return {
    get position(): Vec2 {
      return [position[0], position[1]];
    },
    state: snapshot,
    tick(dtSeconds: number, target: Vec2, peers: readonly Vec2[] = []): FollowerState {
      if (dtSeconds <= 0) return snapshot();

      // Arrive steering toward the target.
      const tx = target[0] - position[0];
      const tz = target[1] - position[1];
      const d = len(tx, tz);

      let desiredX = 0;
      let desiredZ = 0;
      if (d > stopDistance) {
        // Ramp speed down inside the slow band so the follower eases in (no jitter).
        const t = Math.min(1, (d - stopDistance) / slowRadius);
        const desiredSpeed = speed * t;
        desiredX = (tx / d) * desiredSpeed;
        desiredZ = (tz / d) * desiredSpeed;
      }

      // Separation: sum repulsion from peers within the separation radius.
      if (separationRadius > 0) {
        for (const peer of peers) {
          const dx = position[0] - peer[0];
          const dz = position[1] - peer[1];
          const pd = len(dx, dz);
          if (pd > 0 && pd < separationRadius) {
            const push = (separationRadius - pd) / separationRadius; // 0..1, stronger when closer
            desiredX += (dx / pd) * speed * push;
            desiredZ += (dz / pd) * speed * push;
          }
        }
      }

      // Clamp the combined steer to max speed.
      const vmag = len(desiredX, desiredZ);
      if (vmag > speed) {
        desiredX = (desiredX / vmag) * speed;
        desiredZ = (desiredZ / vmag) * speed;
      }
      velocity = [desiredX, desiredZ];
      position = [position[0] + desiredX * dtSeconds, position[1] + desiredZ * dtSeconds];

      return snapshot();
    },
  };
}
