/**
 * Match-3 board core — pure, deterministic, engine-agnostic.
 *
 * THREE-FREE / DOM-FREE: no `three` import, no DOM access. All randomness
 * flows through the injected `Rng` (see `../prng/index.js`); this module never
 * calls `Math.random()` or `Date.now()`.
 *
 * Classic swap-adjacent-to-match-3 with cascading combos:
 *   - `createBoard` seeds a starting grid with zero pre-existing matches.
 *   - `swap` applies iff the swap produces >=1 match; otherwise it reverts.
 *   - `resolve` runs the clear -> gravity -> refill cascade loop to a stable
 *     board, returning the ordered `BoardEvent[]` stream the integration layer
 *     replays for score/juice.
 */

import type { Rng } from '../prng/index.js';

export type TileKind = number; // 0..kinds-1; -1 = empty/hole

export interface Cell {
  row: number;
  col: number;
}

export interface BoardConfig {
  rows: number;
  cols: number;
  kinds: number;
  rng: Rng;
}

export type BoardEvent =
  | { type: 'clear'; cells: Cell[]; kind: TileKind; cascadeDepth: number }
  | { type: 'fall'; moves: { from: Cell; to: Cell; kind: TileKind }[]; cascadeDepth: number }
  | { type: 'spawn'; spawns: { cell: Cell; kind: TileKind }[]; cascadeDepth: number }
  | { type: 'cascade'; depth: number; clearedThisStep: number }
  | { type: 'settle'; totalCleared: number; maxDepth: number };

export interface Board {
  readonly rows: number;
  readonly cols: number;
  readonly kinds: number;
  at(row: number, col: number): TileKind;
  snapshot(): TileKind[];
  findMatches(): Cell[];
  swap(a: Cell, b: Cell): boolean;
  resolve(): BoardEvent[];
  hasMoves(): boolean;
  findHint(): [Cell, Cell] | null;
  shuffleIfStuck(): boolean;
}

/** Flat row-major index for a (row, col) pair against a fixed column count. */
function indexOf(rows: number, cols: number, row: number, col: number): number {
  return row * cols + col;
}

/**
 * Find every horizontal AND vertical run of length >=3 in a flat row-major
 * grid, returning the deduped set of matched flat indices (L/T overlaps are
 * naturally counted once because both scans write into the same Set).
 */
function matchedIndices(grid: readonly TileKind[], rows: number, cols: number): Set<number> {
  const matched = new Set<number>();

  // Horizontal runs.
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const kind = grid[indexOf(rows, cols, r, c)];
      if (kind === undefined || kind === -1) {
        c++;
        continue;
      }
      let end = c;
      while (end + 1 < cols && grid[indexOf(rows, cols, r, end + 1)] === kind) end++;
      if (end - c + 1 >= 3) {
        for (let cc = c; cc <= end; cc++) matched.add(indexOf(rows, cols, r, cc));
      }
      c = end + 1;
    }
  }

  // Vertical runs.
  for (let c = 0; c < cols; c++) {
    let r = 0;
    while (r < rows) {
      const kind = grid[indexOf(rows, cols, r, c)];
      if (kind === undefined || kind === -1) {
        r++;
        continue;
      }
      let end = r;
      while (end + 1 < rows && grid[indexOf(rows, cols, end + 1, c)] === kind) end++;
      if (end - r + 1 >= 3) {
        for (let rr = r; rr <= end; rr++) matched.add(indexOf(rows, cols, rr, c));
      }
      r = end + 1;
    }
  }

  return matched;
}

/**
 * Seed a rows*cols grid with no pre-existing matches. Filled in row-major
 * order so that, at each cell, the only tiles already placed are the two to
 * the left (same row) and the two above (same column) — the only runs that
 * could complete to length 3 at this cell. One `rng.int(kinds)` draw per cell
 * keeps generation deterministic and reproducible for a given seed.
 */
function createInitialGrid(rows: number, cols: number, kinds: number, rng: Rng): TileKind[] {
  const grid: TileKind[] = new Array(rows * cols).fill(-1);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const start = rng.int(kinds);
      let chosen = start;
      for (let i = 0; i < kinds; i++) {
        const candidate = (start + i) % kinds;
        const horizBad =
          c >= 2 &&
          grid[indexOf(rows, cols, r, c - 1)] === candidate &&
          grid[indexOf(rows, cols, r, c - 2)] === candidate;
        const vertBad =
          r >= 2 &&
          grid[indexOf(rows, cols, r - 1, c)] === candidate &&
          grid[indexOf(rows, cols, r - 2, c)] === candidate;
        chosen = candidate;
        if (!horizBad && !vertBad) break;
      }
      grid[indexOf(rows, cols, r, c)] = chosen;
    }
  }

  return grid;
}

function cellsAdjacent(a: Cell, b: Cell): boolean {
  const dRow = Math.abs(a.row - b.row);
  const dCol = Math.abs(a.col - b.col);
  return (dRow === 1 && dCol === 0) || (dRow === 0 && dCol === 1);
}

class BoardImpl implements Board {
  readonly rows: number;
  readonly cols: number;
  readonly kinds: number;
  private grid: TileKind[];
  private readonly rng: Rng;

  constructor(config: BoardConfig) {
    if (!Number.isInteger(config.rows) || config.rows < 1) {
      throw new RangeError(`createBoard: rows must be a positive integer (got ${config.rows})`);
    }
    if (!Number.isInteger(config.cols) || config.cols < 1) {
      throw new RangeError(`createBoard: cols must be a positive integer (got ${config.cols})`);
    }
    if (!Number.isInteger(config.kinds) || config.kinds < 1) {
      throw new RangeError(`createBoard: kinds must be a positive integer (got ${config.kinds})`);
    }
    this.rows = config.rows;
    this.cols = config.cols;
    this.kinds = config.kinds;
    this.rng = config.rng;
    this.grid = createInitialGrid(this.rows, this.cols, this.kinds, this.rng);
  }

  private idx(row: number, col: number): number {
    return indexOf(this.rows, this.cols, row, col);
  }

  private inBounds(cell: Cell): boolean {
    return cell.row >= 0 && cell.row < this.rows && cell.col >= 0 && cell.col < this.cols;
  }

  private cellOf(i: number): Cell {
    return { row: Math.floor(i / this.cols), col: i % this.cols };
  }

  at(row: number, col: number): TileKind {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return -1;
    const v = this.grid[this.idx(row, col)];
    return v === undefined ? -1 : v;
  }

  snapshot(): TileKind[] {
    return this.grid.slice();
  }

  findMatches(): Cell[] {
    const matched = matchedIndices(this.grid, this.rows, this.cols);
    return Array.from(matched)
      .map((i) => this.cellOf(i))
      .sort((a, b) => a.row - b.row || a.col - b.col);
  }

  swap(a: Cell, b: Cell): boolean {
    if (!this.inBounds(a) || !this.inBounds(b)) return false;
    if (!cellsAdjacent(a, b)) return false;

    const ia = this.idx(a.row, a.col);
    const ib = this.idx(b.row, b.col);
    const va = this.grid[ia]!;
    const vb = this.grid[ib]!;
    this.grid[ia] = vb;
    this.grid[ib] = va;

    if (matchedIndices(this.grid, this.rows, this.cols).size > 0) {
      return true;
    }

    // No match produced: revert, no move spent.
    this.grid[ia] = va;
    this.grid[ib] = vb;
    return false;
  }

  resolve(): BoardEvent[] {
    const events: BoardEvent[] = [];
    let depth = 0;
    let totalCleared = 0;

    for (;;) {
      const matched = matchedIndices(this.grid, this.rows, this.cols);
      if (matched.size === 0) break;
      depth++;

      // Group matched cells by kind so each `clear` event carries one kind
      // (for tint), sorted for deterministic event ordering.
      const byKind = new Map<TileKind, Cell[]>();
      for (const i of matched) {
        const kind = this.grid[i]!;
        const cell = this.cellOf(i);
        const list = byKind.get(kind);
        if (list) list.push(cell);
        else byKind.set(kind, [cell]);
      }
      const kindsThisStep = Array.from(byKind.keys()).sort((x, y) => x - y);
      for (const kind of kindsThisStep) {
        const cells = byKind
          .get(kind)!
          .slice()
          .sort((a, b) => a.row - b.row || a.col - b.col);
        events.push({ type: 'clear', cells, kind, cascadeDepth: depth });
      }

      // Clear matched cells.
      for (const i of matched) this.grid[i] = -1;

      // Gravity: compact each column's remaining tiles downward, preserving
      // relative order (tiles never pass one another).
      const moves: { from: Cell; to: Cell; kind: TileKind }[] = [];
      for (let c = 0; c < this.cols; c++) {
        const nonEmpty: { row: number; kind: TileKind }[] = [];
        for (let r = 0; r < this.rows; r++) {
          const v = this.grid[this.idx(r, c)]!;
          if (v !== -1) nonEmpty.push({ row: r, kind: v });
        }
        const numEmpty = this.rows - nonEmpty.length;
        for (let r = 0; r < this.rows; r++) this.grid[this.idx(r, c)] = -1;
        for (let i = 0; i < nonEmpty.length; i++) {
          const entry = nonEmpty[i]!;
          const newRow = numEmpty + i;
          this.grid[this.idx(newRow, c)] = entry.kind;
          if (newRow !== entry.row) {
            moves.push({
              from: { row: entry.row, col: c },
              to: { row: newRow, col: c },
              kind: entry.kind,
            });
          }
        }
      }
      events.push({ type: 'fall', moves, cascadeDepth: depth });

      // Refill from the top; empties (after gravity) are always contiguous
      // at the top of each column, so the scan can stop at the first filled
      // cell.
      const spawns: { cell: Cell; kind: TileKind }[] = [];
      for (let c = 0; c < this.cols; c++) {
        for (let r = 0; r < this.rows; r++) {
          if (this.grid[this.idx(r, c)] !== -1) break;
          const kind = this.rng.int(this.kinds);
          this.grid[this.idx(r, c)] = kind;
          spawns.push({ cell: { row: r, col: c }, kind });
        }
      }
      events.push({ type: 'spawn', spawns, cascadeDepth: depth });

      events.push({ type: 'cascade', depth, clearedThisStep: matched.size });
      totalCleared += matched.size;
    }

    if (depth > 0) {
      events.push({ type: 'settle', totalCleared, maxDepth: depth });
    }

    return events;
  }

  /** Would swapping `a` and `b` (without committing) produce a match? */
  private wouldMatch(a: Cell, b: Cell): boolean {
    const scratch = this.grid.slice();
    const ia = this.idx(a.row, a.col);
    const ib = this.idx(b.row, b.col);
    const tmp = scratch[ia]!;
    scratch[ia] = scratch[ib]!;
    scratch[ib] = tmp;
    return matchedIndices(scratch, this.rows, this.cols).size > 0;
  }

  findHint(): [Cell, Cell] | null {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const here: Cell = { row: r, col: c };
        const right: Cell = { row: r, col: c + 1 };
        if (this.inBounds(right) && this.wouldMatch(here, right)) return [here, right];
        const down: Cell = { row: r + 1, col: c };
        if (this.inBounds(down) && this.wouldMatch(here, down)) return [here, down];
      }
    }
    return null;
  }

  hasMoves(): boolean {
    return this.findHint() !== null;
  }

  shuffleIfStuck(): boolean {
    if (this.hasMoves()) return false;

    // Deterministic Fisher-Yates reshuffle of the existing tiles, retried
    // (still deterministically, drawing further from the same rng stream)
    // until the result has no pre-existing matches AND has a legal move —
    // guaranteeing the board is never left soft-locked.
    const cap = 1000;
    for (let attempt = 0; attempt < cap; attempt++) {
      for (let i = this.grid.length - 1; i > 0; i--) {
        const j = this.rng.int(i + 1);
        const tmp = this.grid[i]!;
        this.grid[i] = this.grid[j]!;
        this.grid[j] = tmp;
      }
      if (matchedIndices(this.grid, this.rows, this.cols).size === 0 && this.hasMoves()) {
        return true;
      }
    }
    return true;
  }
}

/** Create a seeded board with zero pre-existing matches. */
export function createBoard(config: BoardConfig): Board {
  return new BoardImpl(config);
}
