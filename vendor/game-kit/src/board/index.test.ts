import { describe, it, expect } from 'vitest';
import { createRng, type Rng } from '../prng/index.js';
import { createBoard, type Board, type BoardEvent, type Cell } from './index.js';

/**
 * A scripted Rng for tests that need FULL control over the exact sequence of
 * `int()` draws `createInitialGrid` consumes (one draw per cell, row-major),
 * so a specific tile layout (e.g. a hand-built L/T overlap, or a checkerboard
 * stuck board) can be constructed deterministically. Once the scripted queue
 * is exhausted, calls fall through to a real (still deterministic) Rng so
 * later operations (e.g. `shuffleIfStuck`'s Fisher-Yates) keep working.
 */
function scriptedRng(sequence: number[], fallbackSeed = 0xc0ffee): Rng {
  let i = 0;
  const fallback = createRng(fallbackSeed);
  return {
    next(): number {
      return fallback.next();
    },
    int(maxExclusive: number): number {
      if (i < sequence.length) {
        const v = sequence[i++]!;
        if (v < 0 || v >= maxExclusive) {
          throw new RangeError(`scriptedRng: scripted value ${v} out of range for ${maxExclusive}`);
        }
        return v;
      }
      return fallback.int(maxExclusive);
    },
    range(min: number, max: number): number {
      return fallback.range(min, max);
    },
    pick<T>(arr: readonly T[]): T {
      return fallback.pick(arr);
    },
    fork(salt: number): Rng {
      return fallback.fork(salt);
    },
  };
}

function sortCells(cells: readonly Cell[]): Cell[] {
  return cells.slice().sort((a, b) => a.row - b.row || a.col - b.col);
}

describe('createBoard — determinism & initial state', () => {
  it('same seed produces an identical starting snapshot', () => {
    const a = createBoard({ rows: 6, cols: 6, kinds: 5, rng: createRng(42) });
    const b = createBoard({ rows: 6, cols: 6, kinds: 5, rng: createRng(42) });
    expect(a.snapshot()).toEqual(b.snapshot());
  });

  it('different seeds (very likely) produce different starting snapshots', () => {
    const boards = [1, 2, 3].map((seed) =>
      createBoard({ rows: 6, cols: 6, kinds: 5, rng: createRng(seed) }).snapshot(),
    );
    const allEqual = boards.every((s) => JSON.stringify(s) === JSON.stringify(boards[0]));
    expect(allEqual).toBe(false);
  });

  it('starting board has zero pre-existing matches, across many seeds and sizes', () => {
    const sizes = [
      { rows: 4, cols: 4, kinds: 3 },
      { rows: 6, cols: 6, kinds: 4 },
      { rows: 8, cols: 5, kinds: 5 },
    ];
    for (const size of sizes) {
      for (let seed = 0; seed < 20; seed++) {
        const board = createBoard({ ...size, rng: createRng(seed * 97 + 3) });
        expect(board.findMatches()).toEqual([]);
      }
    }
  });

  it('exposes rows/cols/kinds matching the config', () => {
    const board = createBoard({ rows: 7, cols: 5, kinds: 4, rng: createRng(1) });
    expect(board.rows).toBe(7);
    expect(board.cols).toBe(5);
    expect(board.kinds).toBe(4);
  });

  it('throws on non-positive rows/cols/kinds', () => {
    expect(() => createBoard({ rows: 0, cols: 4, kinds: 3, rng: createRng(1) })).toThrow();
    expect(() => createBoard({ rows: 4, cols: -1, kinds: 3, rng: createRng(1) })).toThrow();
    expect(() => createBoard({ rows: 4, cols: 4, kinds: 0, rng: createRng(1) })).toThrow();
  });
});

describe('at() / snapshot()', () => {
  it('at() returns -1 out of bounds', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: createRng(5) });
    expect(board.at(-1, 0)).toBe(-1);
    expect(board.at(0, -1)).toBe(-1);
    expect(board.at(4, 0)).toBe(-1);
    expect(board.at(0, 4)).toBe(-1);
  });

  it('at() matches the row-major snapshot', () => {
    const board = createBoard({ rows: 4, cols: 5, kinds: 3, rng: createRng(9) });
    const snap = board.snapshot();
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 5; c++) {
        expect(board.at(r, c)).toBe(snap[r * 5 + c]);
      }
    }
  });

  it('snapshot() returns an independent copy each call', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: createRng(9) });
    const s1 = board.snapshot();
    const s2 = board.snapshot();
    expect(s1).toEqual(s2);
    expect(s1).not.toBe(s2);
    s1[0] = 999;
    expect(board.at(0, 0)).not.toBe(999);
  });
});

describe('findMatches() — detection & dedup', () => {
  it('finds a pure horizontal run of 3', () => {
    // Hand-scripted 4x4, kinds=3, match-free at fill time. Swapping (1,2) and
    // (1,3) completes row1 cols0-2 to kind 0 with no vertical side effect.
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    expect(board.findMatches()).toEqual([]);

    const ok = board.swap({ row: 1, col: 2 }, { row: 1, col: 3 });
    expect(ok).toBe(true);

    const matches = sortCells(board.findMatches());
    expect(matches).toEqual([
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ]);
  });

  it('finds a pure vertical run of 3', () => {
    // Transpose of the horizontal fixture above; swap (2,1)/(3,1) completes
    // col1 rows0-2 to kind 0 with no horizontal side effect.
    const seq = [
      0, 0, 1, 2,
      1, 0, 2, 0,
      2, 1, 0, 1,
      0, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    expect(board.findMatches()).toEqual([]);

    const ok = board.swap({ row: 2, col: 1 }, { row: 3, col: 1 });
    expect(ok).toBe(true);

    const matches = sortCells(board.findMatches());
    expect(matches).toEqual([
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ]);
  });

  it('dedupes an L/T overlap (shared corner cell counted once)', () => {
    // Hand-scripted 5x5, kinds=3, match-free at fill time. Swapping (2,2) and
    // (2,3) simultaneously completes row2 cols0-2 (horizontal) AND col2
    // rows0-2 (vertical), sharing cell (2,2). Total distinct cells = 5, not 6.
    const seq = [
      1, 2, 0, 1, 2,
      2, 0, 0, 2, 1,
      0, 0, 1, 0, 2,
      2, 1, 2, 0, 1,
      1, 2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 5, cols: 5, kinds: 3, rng: scriptedRng(seq) });
    expect(board.findMatches()).toEqual([]);

    const ok = board.swap({ row: 2, col: 2 }, { row: 2, col: 3 });
    expect(ok).toBe(true);

    const matches = sortCells(board.findMatches());
    expect(matches).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 2 },
      { row: 2, col: 0 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ]);
    // No duplicate cells in the result (structural dedup guarantee).
    const seen = new Set(matches.map((c) => `${c.row},${c.col}`));
    expect(seen.size).toBe(matches.length);
  });
});

describe('swap()', () => {
  it('reverts a non-matching swap with no state change, and returns false', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    const before = board.snapshot();

    // (0,0)=0 and (0,1)=1: swapping produces no match anywhere.
    const ok = board.swap({ row: 0, col: 0 }, { row: 0, col: 1 });
    expect(ok).toBe(false);
    expect(board.snapshot()).toEqual(before);
  });

  it('is a no-op-equivalent (returns false, no change) when swapping two equal adjacent kinds', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    const before = board.snapshot();
    // (1,0)=0 and (1,1)=0: identical kinds, no match produced.
    const ok = board.swap({ row: 1, col: 0 }, { row: 1, col: 1 });
    expect(ok).toBe(false);
    expect(board.snapshot()).toEqual(before);
  });

  it('rejects non-adjacent swaps (diagonal)', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: createRng(3) });
    const before = board.snapshot();
    expect(board.swap({ row: 0, col: 0 }, { row: 1, col: 1 })).toBe(false);
    expect(board.snapshot()).toEqual(before);
  });

  it('rejects swapping a cell with itself', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: createRng(3) });
    expect(board.swap({ row: 2, col: 2 }, { row: 2, col: 2 })).toBe(false);
  });

  it('rejects out-of-bounds swaps', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: createRng(3) });
    expect(board.swap({ row: -1, col: 0 }, { row: 0, col: 0 })).toBe(false);
    expect(board.swap({ row: 0, col: 0 }, { row: 0, col: 4 })).toBe(false);
  });

  it('keeps a swap that produces a match, returning true', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    expect(board.swap({ row: 1, col: 2 }, { row: 1, col: 3 })).toBe(true);
    expect(board.at(1, 0)).toBe(0);
    expect(board.at(1, 1)).toBe(0);
    expect(board.at(1, 2)).toBe(0);
  });
});

describe('resolve() — cascade engine', () => {
  it('returns [] when there are no pending matches', () => {
    const board = createBoard({ rows: 6, cols: 6, kinds: 5, rng: createRng(11) });
    expect(board.findMatches()).toEqual([]);
    expect(board.resolve()).toEqual([]);
  });

  it('clears matches, leaves gravity with no gaps, and fully refills', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    expect(board.swap({ row: 1, col: 2 }, { row: 1, col: 3 })).toBe(true);

    const events = board.resolve();
    expect(events.length).toBeGreaterThan(0);

    // Fully stable afterward: no gaps, no leftover matches.
    const snap = board.snapshot();
    expect(snap.every((v) => v !== -1)).toBe(true);
    expect(board.findMatches()).toEqual([]);

    // Event stream ends in a settle event.
    const last = events[events.length - 1]!;
    expect(last.type).toBe('settle');
  });

  it('emits clear -> fall -> spawn -> cascade per step, closed by one settle', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    board.swap({ row: 1, col: 2 }, { row: 1, col: 3 });
    const events = board.resolve();

    // Group events by cascadeDepth (settle excluded, it has no cascadeDepth).
    const byDepth = new Map<number, BoardEvent[]>();
    for (const ev of events) {
      if (ev.type === 'settle') continue;
      const depth = 'cascadeDepth' in ev ? ev.cascadeDepth : ev.depth;
      const list = byDepth.get(depth);
      if (list) list.push(ev);
      else byDepth.set(depth, [ev]);
    }

    for (const [, stepEvents] of byDepth) {
      const types = stepEvents.map((e) => e.type);
      // clear(s) first, then exactly one fall, one spawn, one cascade, in order.
      const fallIdx = types.indexOf('fall');
      const spawnIdx = types.indexOf('spawn');
      const cascadeIdx = types.indexOf('cascade');
      expect(fallIdx).toBeGreaterThan(-1);
      expect(spawnIdx).toBeGreaterThan(fallIdx);
      expect(cascadeIdx).toBeGreaterThan(spawnIdx);
      expect(types.filter((t) => t === 'fall').length).toBe(1);
      expect(types.filter((t) => t === 'spawn').length).toBe(1);
      expect(types.filter((t) => t === 'cascade').length).toBe(1);
      // Every event before `fall` must be a `clear`.
      for (let i = 0; i < fallIdx; i++) expect(types[i]).toBe('clear');
    }

    expect(events[events.length - 1]!.type).toBe('settle');
  });

  it('cascadeDepth starts at 1 and settle.maxDepth matches the last cascade depth', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    board.swap({ row: 1, col: 2 }, { row: 1, col: 3 });
    const events = board.resolve();

    const clearEvents = events.filter((e): e is Extract<BoardEvent, { type: 'clear' }> => e.type === 'clear');
    expect(clearEvents[0]!.cascadeDepth).toBe(1);

    const cascadeEvents = events.filter((e): e is Extract<BoardEvent, { type: 'cascade' }> => e.type === 'cascade');
    const depths = cascadeEvents.map((e) => e.depth);
    for (let i = 0; i < depths.length; i++) expect(depths[i]).toBe(i + 1);

    const settle = events[events.length - 1]!;
    expect(settle.type).toBe('settle');
    if (settle.type === 'settle') {
      expect(settle.maxDepth).toBe(depths[depths.length - 1]);
      const totalFromCascades = cascadeEvents.reduce((sum, e) => sum + e.clearedThisStep, 0);
      expect(settle.totalCleared).toBe(totalFromCascades);
    }
  });

  it('fall moves always go straight down within the same column', () => {
    const seq = [
      0, 1, 2, 0,
      0, 0, 1, 0,
      1, 2, 0, 1,
      2, 0, 1, 2,
    ];
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(seq) });
    board.swap({ row: 1, col: 2 }, { row: 1, col: 3 });
    const events = board.resolve();

    for (const ev of events) {
      if (ev.type !== 'fall') continue;
      for (const move of ev.moves) {
        expect(move.to.col).toBe(move.from.col);
        expect(move.to.row).toBeGreaterThan(move.from.row);
      }
    }
  });

  it('spawn events only introduce valid tile kinds within [0, kinds)', () => {
    const board = createBoard({ rows: 6, cols: 6, kinds: 4, rng: createRng(21) });
    const hint = board.findHint();
    expect(hint).not.toBeNull();
    if (!hint) return;
    board.swap(hint[0], hint[1]);
    const events = board.resolve();
    for (const ev of events) {
      if (ev.type !== 'spawn') continue;
      for (const s of ev.spawns) {
        expect(s.kind).toBeGreaterThanOrEqual(0);
        expect(s.kind).toBeLessThan(4);
      }
    }
  });

  it('resolve() is idempotent once stable (second call returns [])', () => {
    const board = createBoard({ rows: 6, cols: 6, kinds: 4, rng: createRng(21) });
    const hint = board.findHint();
    expect(hint).not.toBeNull();
    if (!hint) return;
    board.swap(hint[0], hint[1]);
    board.resolve();
    expect(board.resolve()).toEqual([]);
  });

  it('same seed + same swap produces an identical event stream (determinism)', () => {
    const make = (): Board => {
      const b = createBoard({ rows: 7, cols: 7, kinds: 4, rng: createRng(777) });
      return b;
    };
    const b1 = make();
    const b2 = make();
    const hint1 = b1.findHint();
    const hint2 = b2.findHint();
    expect(hint1).toEqual(hint2);
    expect(hint1).not.toBeNull();
    if (!hint1 || !hint2) return;
    expect(b1.swap(hint1[0], hint1[1])).toBe(true);
    expect(b2.swap(hint2[0], hint2[1])).toBe(true);
    expect(b1.resolve()).toEqual(b2.resolve());
    expect(b1.snapshot()).toEqual(b2.snapshot());
  });

  it('cascades chain with strictly increasing depth (found empirically over many seeds)', () => {
    let found: { events: BoardEvent[] } | null = null;
    for (let seed = 0; seed < 400 && !found; seed++) {
      const board = createBoard({ rows: 8, cols: 8, kinds: 3, rng: createRng(seed * 31 + 7) });
      const hint = board.findHint();
      if (!hint) continue;
      board.swap(hint[0], hint[1]);
      const events = board.resolve();
      const cascadeEvents = events.filter((e): e is Extract<BoardEvent, { type: 'cascade' }> => e.type === 'cascade');
      if (cascadeEvents.length >= 2) {
        found = { events };
      }
    }
    expect(found).not.toBeNull();
    if (!found) return;
    const cascadeEvents = found.events.filter(
      (e): e is Extract<BoardEvent, { type: 'cascade' }> => e.type === 'cascade',
    );
    const depths = cascadeEvents.map((e) => e.depth);
    for (let i = 0; i < depths.length; i++) expect(depths[i]).toBe(i + 1);
    expect(depths.length).toBeGreaterThanOrEqual(2);
  });
});

describe('hasMoves() / findHint() / shuffleIfStuck()', () => {
  it('hasMoves() is true on typical freshly-created boards', () => {
    for (let seed = 0; seed < 15; seed++) {
      const board = createBoard({ rows: 6, cols: 6, kinds: 4, rng: createRng(seed * 13 + 1) });
      expect(board.hasMoves()).toBe(true);
    }
  });

  it('findHint() returns an actually-legal swap', () => {
    for (let seed = 0; seed < 15; seed++) {
      const board = createBoard({ rows: 6, cols: 6, kinds: 4, rng: createRng(seed * 13 + 1) });
      const hint = board.findHint();
      expect(hint).not.toBeNull();
      if (!hint) continue;
      const [a, b] = hint;
      const dRow = Math.abs(a.row - b.row);
      const dCol = Math.abs(a.col - b.col);
      expect(dRow + dCol).toBe(1); // orthogonally adjacent
      expect(board.swap(a, b)).toBe(true); // actually legal
    }
  });

  // Found by brute-force search over seeded fills of a 4x4/kinds=3 grid: this
  // exact layout is match-free AND has no legal swap anywhere (every one of
  // the 24 adjacent pairs was tried; none produces a match when swapped).
  const STUCK_SEQ = [
    0, 2, 1, 0,
    1, 2, 2, 0,
    0, 0, 1, 1,
    2, 0, 2, 1,
  ];

  it('findHint() returns null exactly when hasMoves() is false', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(STUCK_SEQ) });
    expect(board.findMatches()).toEqual([]);
    expect(board.hasMoves()).toBe(false);
    expect(board.findHint()).toBeNull();
  });

  it('shuffleIfStuck() reshuffles a stuck board into one with moves, never soft-locking', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(STUCK_SEQ) });
    expect(board.hasMoves()).toBe(false);

    const reshuffled = board.shuffleIfStuck();
    expect(reshuffled).toBe(true);
    expect(board.findMatches()).toEqual([]); // no matches introduced by the shuffle
    expect(board.hasMoves()).toBe(true); // no longer soft-locked
  });

  it('shuffleIfStuck() preserves the multiset of tile kinds (same tiles, new arrangement)', () => {
    const board = createBoard({ rows: 4, cols: 4, kinds: 3, rng: scriptedRng(STUCK_SEQ) });
    const before = board.snapshot().slice().sort();
    board.shuffleIfStuck();
    const after = board.snapshot().slice().sort();
    expect(after).toEqual(before);
  });

  it('shuffleIfStuck() is a no-op (returns false) when moves already exist', () => {
    const board = createBoard({ rows: 6, cols: 6, kinds: 4, rng: createRng(99) });
    expect(board.hasMoves()).toBe(true);
    const before = board.snapshot();
    expect(board.shuffleIfStuck()).toBe(false);
    expect(board.snapshot()).toEqual(before);
  });
});
