import { describe, it, expect } from 'vitest';
import {
  resolveGameCameraOptions,
  resolveEyeHeight,
  clampPitch,
  orbitOffset,
  topDownEyePosition,
  groundMoveDelta,
  aabbBounds,
  cylinderBounds,
} from './index.js';

// Pure, THREE-free contract for the unified GameCamera config/helpers. These are
// the load-bearing math the r3f `useGameCamera` wiring consumes, so the modes
// stay honest without spinning up a WebGL context.

const DEG = Math.PI / 180;

describe('resolveGameCameraOptions', () => {
  it('fills sensible defaults for an empty config', () => {
    const o = resolveGameCameraOptions();
    expect(o.moveSpeed).toBe(2.2);
    expect(o.eyeHeight).toBe(1.7);
    expect(o.distance).toBe(12);
    expect(o.minZoom).toBe(3);
    expect(o.maxZoom).toBe(20);
    expect(o.height).toBe(20);
    expect(o.pitchLimit).toBeCloseTo(85 * DEG, 6);
  });

  it('orders an inverted zoom window and clamps distance into it', () => {
    const o = resolveGameCameraOptions({ minZoom: 30, maxZoom: 5, distance: 100 });
    expect(o.minZoom).toBe(5);
    expect(o.maxZoom).toBe(30);
    expect(o.distance).toBe(30); // clamped to the (ordered) max
  });

  it('is pure — same input yields an equal result', () => {
    const a = resolveGameCameraOptions({ moveSpeed: 4 });
    const b = resolveGameCameraOptions({ moveSpeed: 4 });
    expect(a).toEqual(b);
  });

  it('resolves a getter eyeHeight to its called value', () => {
    const o = resolveGameCameraOptions({ eyeHeight: () => 2.4 });
    expect(o.eyeHeight).toBe(2.4);
  });
});

describe('resolveEyeHeight', () => {
  it('defaults to 1.7 when omitted', () => {
    expect(resolveEyeHeight(undefined)).toBe(1.7);
  });

  it('passes a plain number through', () => {
    expect(resolveEyeHeight(1.9)).toBe(1.9);
  });

  it('calls a getter fresh every time (live, not memoized)', () => {
    let height = 1.7;
    const getter = () => height;
    expect(resolveEyeHeight(getter)).toBe(1.7);
    height = 3.1; // e.g. locomotion.elevation() changed mid-flight
    expect(resolveEyeHeight(getter)).toBe(3.1);
  });
});

describe('clampPitch', () => {
  it('clamps to the default ±85° and never flips', () => {
    expect(clampPitch(10 * DEG)).toBeCloseTo(10 * DEG, 6);
    expect(clampPitch(200 * DEG)).toBeCloseTo(85 * DEG, 6);
    expect(clampPitch(-200 * DEG)).toBeCloseTo(-85 * DEG, 6);
  });

  it('honors a custom limit (sign-insensitive)', () => {
    expect(clampPitch(3, -1.2)).toBeCloseTo(1.2, 6);
    expect(clampPitch(-3, 1.2)).toBeCloseTo(-1.2, 6);
  });
});

describe('orbitOffset', () => {
  it('sits behind the target (+Z) at azimuth 0, elevation 0', () => {
    const [x, y, z] = orbitOffset([0, 0, 0], 0, 0, 10);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(10, 6);
  });

  it('rises straight up at elevation 90°', () => {
    const [x, y, z] = orbitOffset([1, 2, 3], 0, Math.PI / 2, 8);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(2 + 8, 6);
    expect(z).toBeCloseTo(3, 6);
  });

  it('is offset from the target by exactly `distance`', () => {
    const t: [number, number, number] = [5, -2, 7];
    const p = orbitOffset(t, 1.1, 0.6, 12);
    const d = Math.hypot(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
    expect(d).toBeCloseTo(12, 6);
  });
});

describe('topDownEyePosition', () => {
  it('is straight up over the target by `height`, same XZ', () => {
    expect(topDownEyePosition([4, 1, -3], 20)).toEqual([4, 21, -3]);
  });
});

describe('groundMoveDelta', () => {
  it('walks −Z when pressing forward at yaw 0', () => {
    const [dx, dz] = groundMoveDelta(0, [0, 1], 2, 0.5); // speed*dt = 1 unit
    expect(dx).toBeCloseTo(0, 6);
    expect(dz).toBeCloseTo(-1, 6);
  });

  it('strafes +X (right) at yaw 0', () => {
    const [dx, dz] = groundMoveDelta(0, [1, 0], 2, 0.5);
    expect(dx).toBeCloseTo(1, 6);
    expect(dz).toBeCloseTo(0, 6);
  });

  it('rotates with yaw: forward at yaw 90° heads −X', () => {
    const [dx, dz] = groundMoveDelta(Math.PI / 2, [0, 1], 2, 0.5);
    expect(dx).toBeCloseTo(-1, 6);
    expect(dz).toBeCloseTo(0, 6);
  });

  it('returns zero for no input (no drift)', () => {
    expect(groundMoveDelta(1.23, [0, 0], 99, 1)).toEqual([0, 0]);
  });
});

describe('aabbBounds', () => {
  const clamp = aabbBounds({ minX: -5, maxX: 5, minZ: -3, maxZ: 3 });
  it('passes an inside point unchanged', () => {
    expect(clamp(1, 2)).toEqual([1, 2]);
  });
  it('clamps an outside point onto the rectangle', () => {
    expect(clamp(10, -10)).toEqual([5, -3]);
  });
});

describe('cylinderBounds', () => {
  it('pushes a point back inside the outer wall', () => {
    const c = cylinderBounds(10);
    const [x, z] = c(20, 0);
    expect(Math.hypot(x, z)).toBeCloseTo(10, 6);
    expect(x).toBeCloseTo(10, 6);
  });

  it('passes an inside point through', () => {
    const c = cylinderBounds(10);
    expect(c(3, 4)).toEqual([3, 4]); // r = 5 < 10
  });

  it('keeps a point OUTSIDE the inner hole (GYRE Coil pattern)', () => {
    const c = cylinderBounds(10, 0, 0, 4);
    const [x, z] = c(1, 0); // r = 1 < inner 4 → pushed out to r = 4
    expect(Math.hypot(x, z)).toBeCloseTo(4, 6);
  });

  it('nudges a dead-center point out of the hole along +X', () => {
    const c = cylinderBounds(10, 0, 0, 4);
    expect(c(0, 0)).toEqual([4, 0]);
  });

  it('respects a non-origin center', () => {
    const c = cylinderBounds(2, 100, 100);
    const [x, z] = c(105, 100); // 5 east of center, radius 2
    expect(x).toBeCloseTo(102, 6);
    expect(z).toBeCloseTo(100, 6);
  });
});
