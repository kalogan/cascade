/**
 * Seeded PRNG — mulberry32 algorithm.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * Deterministic: the same seed always produces the same sequence. Never uses
 * Math.random() or Date.now() internally.
 */

export interface Rng {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns an integer in [0, maxExclusive). Throws if maxExclusive < 1. */
  int(maxExclusive: number): number;
  /** Returns an integer in [min, max] inclusive. Throws if min > max. */
  range(min: number, max: number): number;
  /** Picks a random element from a non-empty array. Throws if empty. */
  pick<T>(arr: readonly T[]): T;
  /**
   * Derives a new independent Rng from this one's seed plus a salt.
   * Stable: the same (seed, salt) pair always yields the same child stream,
   * and different salts yield different streams.
   */
  fork(salt: number): Rng;
}

/**
 * mulberry32 — fast, deterministic, good statistical quality.
 * Returns a function producing floats in [0, 1).
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0; // 32-bit unsigned
  return function () {
    s += 0x6d2b79f5;
    let z = s;
    z = Math.imul(z ^ (z >>> 15), z | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000;
  };
}

/**
 * Mix two 32-bit integers into a new well-distributed 32-bit seed.
 * Used by fork() so that (seed, salt) deterministically derives a child seed
 * that differs across salts.
 */
function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (salt >>> 0), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * One entry in a weighted table: a value paired with a non-negative weight.
 * A weight of 0 means "never pick this"; higher weights are proportionally more
 * likely. Weights don't need to sum to 1 — they're normalized internally.
 */
export interface WeightedEntry<T> {
  value: T;
  weight: number;
}

/**
 * Deterministically pick one entry from a weighted table, consuming exactly ONE
 * `rng.next()` draw (so it composes cleanly with the rest of a seeded stream).
 *
 * The probability of an entry is `weight / totalWeight`. This is the non-uniform
 * companion to `Rng.pick` (which is uniform-only) — the anti-sameness primitive
 * the identity module leans on to bias archetype selection.
 *
 * Guards (a table must express a real distribution):
 *   - empty table            → throws
 *   - any non-finite weight   → throws (NaN/Infinity can't define a share)
 *   - any negative weight     → throws (a share can't be negative)
 *   - total weight of 0       → throws (nothing is selectable)
 *
 * Zero-weight entries are allowed as long as SOME entry has positive weight;
 * they're simply never returned.
 */
export function weightedPick<T>(rng: Rng, entries: readonly WeightedEntry<T>[]): T {
  if (entries.length === 0) {
    throw new RangeError('weightedPick: entries is empty');
  }

  let total = 0;
  for (const e of entries) {
    const w = e.weight;
    if (!Number.isFinite(w)) {
      throw new RangeError(`weightedPick: weight must be finite (got ${w})`);
    }
    if (w < 0) {
      throw new RangeError(`weightedPick: weight must be >= 0 (got ${w})`);
    }
    total += w;
  }
  if (total <= 0) {
    throw new RangeError('weightedPick: total weight is 0 — nothing is selectable');
  }

  // One draw scaled into [0, total); walk the cumulative weights.
  let target = rng.next() * total;
  for (const e of entries) {
    target -= e.weight;
    if (target < 0) return e.value;
  }
  // Float rounding can leave `target` at ~0 after the loop; fall back to the last
  // positive-weight entry so we always return a valid (never zero-weight) value.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.weight > 0) return e.value;
  }
  // Unreachable: total > 0 guarantees at least one positive-weight entry.
  throw new RangeError('weightedPick: no positive-weight entry (unreachable)');
}

/**
 * Build a reusable sampler bound to a weighted table. Handy when the SAME table
 * is sampled many times against different rng streams (e.g. one archetype table
 * sampled per-seed). Each call consumes one `rng.next()` draw, exactly like
 * `weightedPick`. The table is validated eagerly on construction.
 */
export function weightedTable<T>(
  entries: readonly WeightedEntry<T>[],
): (rng: Rng) => T {
  // Validate once up-front by sampling shape (reuses weightedPick's guards via a
  // throwaway draw-free check): re-run the same guard logic without a draw.
  if (entries.length === 0) {
    throw new RangeError('weightedTable: entries is empty');
  }
  let total = 0;
  for (const e of entries) {
    if (!Number.isFinite(e.weight)) {
      throw new RangeError(`weightedTable: weight must be finite (got ${e.weight})`);
    }
    if (e.weight < 0) {
      throw new RangeError(`weightedTable: weight must be >= 0 (got ${e.weight})`);
    }
    total += e.weight;
  }
  if (total <= 0) {
    throw new RangeError('weightedTable: total weight is 0 — nothing is selectable');
  }
  const frozen = entries.slice();
  return (rng: Rng): T => weightedPick(rng, frozen);
}

/**
 * Hash an arbitrary string into a well-distributed 32-bit unsigned seed (FNV-1a).
 * Lets callers seed the PRNG from a TOKEN (a name, an id) as readily as a number,
 * without collapsing similar strings to nearby seeds. Empty string → a fixed
 * non-zero constant so it still produces a usable stream.
 */
export function hashStringToSeed(token: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  // Avoid a 0 seed (a degenerate mulberry32 start) for the empty string.
  return (h >>> 0) || 0x9e3779b9;
}

/**
 * Create a seeded Rng from a numeric seed.
 * Same seed → identical sequence, every time.
 */
export function createRng(seed: number): Rng {
  const baseSeed = seed >>> 0;
  const raw = mulberry32(baseSeed);

  const rng: Rng = {
    next(): number {
      return raw();
    },

    int(maxExclusive: number): number {
      if (!Number.isFinite(maxExclusive) || maxExclusive < 1) {
        throw new RangeError(`Rng.int: maxExclusive must be >= 1 (got ${maxExclusive})`);
      }
      return Math.floor(raw() * Math.floor(maxExclusive));
    },

    range(min: number, max: number): number {
      if (min > max) throw new RangeError(`Rng.range: min (${min}) > max (${max})`);
      if (min === max) return min;
      return Math.floor(raw() * (max - min + 1)) + min;
    },

    pick<T>(arr: readonly T[]): T {
      if (arr.length === 0) throw new RangeError('Rng.pick: array is empty');
      const index = Math.floor(raw() * arr.length);
      const item = arr[index];
      if (item === undefined) {
        throw new RangeError('Rng.pick: index out of bounds (unreachable)');
      }
      return item;
    },

    fork(salt: number): Rng {
      return createRng(mixSeed(baseSeed, salt));
    },
  };

  return rng;
}
