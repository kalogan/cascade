/**
 * Pure math / interpolation / easing helpers, plus a tiny vec3 toolkit.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 * All functions are pure: no internal state, no Math.random, no Date.now.
 */

/** Clamp `v` into the inclusive range [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Linear interpolation from `a` to `b` by `t` (t is not clamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Inverse of lerp: the fraction `v` is between `a` and `b`.
 * Returns 0 when a === b to avoid division by zero.
 */
export function inverseLerp(a: number, b: number, v: number): number {
  if (a === b) return 0;
  return (v - a) / (b - a);
}

/** Remap `v` from the [inMin, inMax] range onto [outMin, outMax]. */
export function remap(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  return lerp(outMin, outMax, inverseLerp(inMin, inMax, v));
}

/**
 * Frame-rate-independent exponential approach toward `target`.
 *
 * Moves `current` a fraction of the remaining distance each step such that the
 * result is invariant to frame rate: larger `dt` (or `lambda`) converges faster.
 * `lambda` is the decay rate (per second); `dt` is the elapsed time in seconds.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

/**
 * Hermite smoothstep: 0 below edge0, 1 above edge1, smooth S-curve between.
 * Returns 0 if edge0 === edge1 and x < edge0, else 1 (degenerate edge case).
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Quadratic ease-in-out over t in [0, 1]. */
export function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Cubic ease-out over t in [0, 1]. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/** An immutable 3-component vector tuple. */
export type Vec3 = readonly [number, number, number];

/** Tiny vec3 toolkit operating on readonly tuples; every op returns a new tuple. */
export const vec3 = {
  /** Component-wise sum a + b. */
  add(a: Vec3, b: Vec3): Vec3 {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },

  /** Component-wise difference a - b. */
  sub(a: Vec3, b: Vec3): Vec3 {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },

  /** Scalar multiply a * s. */
  scale(a: Vec3, s: number): Vec3 {
    return [a[0] * s, a[1] * s, a[2] * s];
  },

  /** Euclidean length |a|. */
  length(a: Vec3): number {
    return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  },

  /**
   * Unit vector in the direction of `a`.
   * Guards zero length: returns [0, 0, 0] rather than dividing by zero.
   */
  normalize(a: Vec3): Vec3 {
    const len = vec3.length(a);
    if (len === 0) return [0, 0, 0];
    return [a[0] / len, a[1] / len, a[2] / len];
  },
} as const;
