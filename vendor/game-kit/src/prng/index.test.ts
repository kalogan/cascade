import { describe, it, expect } from 'vitest';
import {
  createRng,
  weightedPick,
  weightedTable,
  hashStringToSeed,
  type WeightedEntry,
} from './index.js';

// Straight from the vendored game-kit source. mulberry32 + weightedPick are pure
// (no DOM), so this suite needs no stubs.

describe('weightedPick', () => {
  it('is deterministic — same seed yields the same pick sequence', () => {
    const entries: WeightedEntry<string>[] = [
      { value: 'a', weight: 1 },
      { value: 'b', weight: 2 },
      { value: 'c', weight: 3 },
    ];
    const seqOf = (seed: number) => {
      const rng = createRng(seed);
      return Array.from({ length: 20 }, () => weightedPick(rng, entries));
    };
    expect(seqOf(12345)).toEqual(seqOf(12345));
    // Different seeds should (with overwhelming probability) diverge somewhere.
    expect(seqOf(12345)).not.toEqual(seqOf(999));
  });

  it('roughly matches the weight distribution over many samples (fixed seed)', () => {
    const entries: WeightedEntry<string>[] = [
      { value: 'a', weight: 1 }, // ~1/6
      { value: 'b', weight: 2 }, // ~2/6
      { value: 'c', weight: 3 }, // ~3/6
    ];
    const rng = createRng(0xc0ffee);
    const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
    const N = 60_000;
    for (let i = 0; i < N; i++) counts[weightedPick(rng, entries)]!++;

    // Expected shares 1/6, 2/6, 3/6. Assert each within a generous ±2% band.
    expect(counts.a! / N).toBeCloseTo(1 / 6, 1);
    expect(counts.b! / N).toBeCloseTo(2 / 6, 1);
    expect(counts.c! / N).toBeCloseTo(3 / 6, 1);
    // Ordering of shares must always hold: a < b < c.
    expect(counts.a!).toBeLessThan(counts.b!);
    expect(counts.b!).toBeLessThan(counts.c!);
  });

  it('always returns the sole entry of a single-entry table', () => {
    const rng = createRng(7);
    for (let i = 0; i < 100; i++) {
      expect(weightedPick(rng, [{ value: 'only', weight: 5 }])).toBe('only');
    }
  });

  it('never returns a zero-weight entry (but allows it in the table)', () => {
    const entries: WeightedEntry<string>[] = [
      { value: 'never', weight: 0 },
      { value: 'always', weight: 1 },
      { value: 'never2', weight: 0 },
    ];
    const rng = createRng(42);
    for (let i = 0; i < 500; i++) {
      expect(weightedPick(rng, entries)).toBe('always');
    }
  });

  it('throws on an empty table', () => {
    expect(() => weightedPick(createRng(1), [])).toThrow(/empty/);
  });

  it('throws when every weight is zero (nothing selectable)', () => {
    expect(() =>
      weightedPick(createRng(1), [
        { value: 'x', weight: 0 },
        { value: 'y', weight: 0 },
      ]),
    ).toThrow(/total weight is 0/);
  });

  it('throws on a negative weight', () => {
    expect(() =>
      weightedPick(createRng(1), [
        { value: 'x', weight: 1 },
        { value: 'y', weight: -1 },
      ]),
    ).toThrow(/>= 0/);
  });

  it('throws on a non-finite weight (NaN / Infinity)', () => {
    expect(() =>
      weightedPick(createRng(1), [{ value: 'x', weight: Number.NaN }]),
    ).toThrow(/finite/);
    expect(() =>
      weightedPick(createRng(1), [{ value: 'x', weight: Number.POSITIVE_INFINITY }]),
    ).toThrow(/finite/);
  });

  it('consumes exactly one rng draw per pick (composes with the stream)', () => {
    // A weightedPick then a next() must equal a next() (skip) then a next().
    const a = createRng(555);
    weightedPick(a, [{ value: 1, weight: 1 }]);
    const afterPick = a.next();

    const b = createRng(555);
    b.next(); // the single draw weightedPick would have consumed
    const afterSkip = b.next();

    expect(afterPick).toBe(afterSkip);
  });
});

describe('weightedTable', () => {
  it('produces a sampler equivalent to weightedPick on the same rng stream', () => {
    const entries: WeightedEntry<string>[] = [
      { value: 'a', weight: 1 },
      { value: 'b', weight: 4 },
    ];
    const sample = weightedTable(entries);
    const viaTable = Array.from({ length: 30 }, (_i) => sample(createRng(1)));
    const viaPick = Array.from({ length: 30 }, (_i) => weightedPick(createRng(1), entries));
    expect(viaTable).toEqual(viaPick);
  });

  it('validates eagerly on construction', () => {
    expect(() => weightedTable([])).toThrow(/empty/);
    expect(() => weightedTable([{ value: 'x', weight: -2 }])).toThrow(/>= 0/);
    expect(() => weightedTable([{ value: 'x', weight: 0 }])).toThrow(/total weight is 0/);
  });
});

describe('hashStringToSeed', () => {
  it('is deterministic and returns a 32-bit unsigned int', () => {
    const h = hashStringToSeed('gyre');
    expect(h).toBe(hashStringToSeed('gyre'));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('spreads similar tokens to distant seeds (avalanche)', () => {
    expect(hashStringToSeed('gyre')).not.toBe(hashStringToSeed('gyrf'));
    expect(hashStringToSeed('a')).not.toBe(hashStringToSeed('b'));
  });

  it('maps the empty string to a deterministic non-zero seed', () => {
    // The FNV offset basis is itself non-zero, so the empty string is already a
    // usable seed (the internal 0-guard only fires if a hash collapses to 0).
    expect(hashStringToSeed('')).toBe(hashStringToSeed(''));
    expect(hashStringToSeed('')).not.toBe(0);
  });
});
