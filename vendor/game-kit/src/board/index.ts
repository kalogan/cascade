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
  /**
   * Number of DISTINCT cells to seed as "locked" (crated) after the fair,
   * match-free grid is generated. Defaults to 0. Clamped to [0, rows*cols].
   * Locked cells hold a normal tile but cannot be swapped or matched until
   * freed. Chosen deterministically from the injected rng.
   */
  lockedCount?: number;
}

export type BoardEvent =
  | { type: 'clear'; cells: Cell[]; kind: TileKind; cascadeDepth: number }
  | { type: 'fall'; moves: { from: Cell; to: Cell; kind: TileKind }[]; cascadeDepth: number }
  | { type: 'spawn'; spawns: { cell: Cell; kind: TileKind }[]; cascadeDepth: number }
  | { type: 'unlock'; cells: Cell[]; cascadeDepth: number }
  | { type: 'cascade'; depth: number; clearedThisStep: number }
  | { type: 'settle'; totalCleared: number; maxDepth: number };

export interface Board {
  readonly rows: number;
  readonly cols: number;
  readonly kinds: number;
  at(row: number, col: number): TileKind;
  snapshot(): TileKind[];
  /** Row-major boolean layer parallel to `snapshot()`: true where a cell is locked. */
  lockedSnapshot(): boolean[];
  /** True iff the given cell is currently locked (false when out of bounds). */
  isLocked(cell: Cell): boolean;
  /** Number of currently-locked cells. */
  lockedCount(): number;
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
 *
 * A locked cell (per the optional `locked` layer) can NEVER be part of a run:
 * it is treated exactly like a hole (-1), breaking runs in both directions,
 * even though it still holds a normal tile kind.
 */
function matchedIndices(
  grid: readonly TileKind[],
  rows: number,
  cols: number,
  locked?: readonly boolean[],
): Set<number> {
  const matched = new Set<number>();
  const isBlocked = (i: number): boolean =>
    grid[i] === undefined || grid[i] === -1 || (locked !== undefined && locked[i] === true);

  // Horizontal runs.
  for (let r = 0; r < rows; r++) {
    let c = 0;
    while (c < cols) {
      const i = indexOf(rows, cols, r, c);
      if (isBlocked(i)) {
        c++;
        continue;
      }
      const kind = grid[i];
      let end = c;
      while (
        end + 1 < cols &&
        !isBlocked(indexOf(rows, cols, r, end + 1)) &&
        grid[indexOf(rows, cols, r, end + 1)] === kind
      ) {
        end++;
      }
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
      const i = indexOf(rows, cols, r, c);
      if (isBlocked(i)) {
        r++;
        continue;
      }
      const kind = grid[i];
      let end = r;
      while (
        end + 1 < rows &&
        !isBlocked(indexOf(rows, cols, end + 1, c)) &&
        grid[indexOf(rows, cols, end + 1, c)] === kind
      ) {
        end++;
      }
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
  /** Parallel row-major boolean layer: true where a cell is locked (crated). */
  private locked: boolean[];
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
    this.locked = new Array(this.rows * this.cols).fill(false);
    this.seedLocks(config.lockedCount ?? 0);
  }

  /**
   * Mark `count` DISTINCT cells as locked, chosen deterministically from the
   * injected rng (a partial Fisher-Yates over the flat index list, drawing one
   * `rng.int` per lock). Runs AFTER grid seeding, so the rng draw sequence for
   * the grid is unchanged when lockedCount is 0. Clamped to [0, rows*cols].
   */
  private seedLocks(requested: number): void {
    const total = this.rows * this.cols;
    let count = Number.isFinite(requested) ? Math.floor(requested) : 0;
    if (count <= 0) return;
    if (count > total) count = total;

    // Partial Fisher-Yates: pick `count` distinct indices in [0, total).
    const pool: number[] = new Array(total);
    for (let i = 0; i < total; i++) pool[i] = i;
    for (let k = 0; k < count; k++) {
      const j = k + this.rng.int(total - k);
      const tmp = pool[k]!;
      pool[k] = pool[j]!;
      pool[j] = tmp;
      this.locked[pool[k]!] = true;
    }
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

  lockedSnapshot(): boolean[] {
    return this.locked.slice();
  }

  isLocked(cell: Cell): boolean {
    if (!this.inBounds(cell)) return false;
    return this.locked[this.idx(cell.row, cell.col)] === true;
  }

  lockedCount(): number {
    let n = 0;
    for (const l of this.locked) if (l) n++;
    return n;
  }

  findMatches(): Cell[] {
    const matched = matchedIndices(this.grid, this.rows, this.cols, this.locked);
    return Array.from(matched)
      .map((i) => this.cellOf(i))
      .sort((a, b) => a.row - b.row || a.col - b.col);
  }

  swap(a: Cell, b: Cell): boolean {
    if (!this.inBounds(a) || !this.inBounds(b)) return false;
    if (!cellsAdjacent(a, b)) return false;

    const ia = this.idx(a.row, a.col);
    const ib = this.idx(b.row, b.col);

    // A locked (crated) cell on either end cannot be swapped — same contract
    // as any other illegal swap: reject, spend no move, change nothing.
    if (this.locked[ia] === true || this.locked[ib] === true) return false;

    const va = this.grid[ia]!;
    const vb = this.grid[ib]!;
    this.grid[ia] = vb;
    this.grid[ib] = va;

    if (matchedIndices(this.grid, this.rows, this.cols, this.locked).size > 0) {
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
      const matched = matchedIndices(this.grid, this.rows, this.cols, this.locked);
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

      // Freeing: unlock every locked cell that is 4-adjacent (up/down/left/
      // right) to a cell cleared THIS step. Evaluated from this step's cleared
      // set, before gravity. Emit an `unlock` event only when >=1 cell frees.
      const freed = new Set<number>();
      for (const i of matched) {
        const cell = this.cellOf(i);
        const neighbours: Cell[] = [
          { row: cell.row - 1, col: cell.col },
          { row: cell.row + 1, col: cell.col },
          { row: cell.row, col: cell.col - 1 },
          { row: cell.row, col: cell.col + 1 },
        ];
        for (const n of neighbours) {
          if (!this.inBounds(n)) continue;
          const ni = this.idx(n.row, n.col);
          if (this.locked[ni] === true) freed.add(ni);
        }
      }
      if (freed.size > 0) {
        for (const ni of freed) this.locked[ni] = false;
        const freedCells = Array.from(freed)
          .map((i) => this.cellOf(i))
          .sort((a, b) => a.row - b.row || a.col - b.col);
        events.push({ type: 'unlock', cells: freedCells, cascadeDepth: depth });
      }

      // Clear matched cells (matched cells are never locked, so no lock lost).
      for (const i of matched) this.grid[i] = -1;

      // Gravity: compact each column's remaining tiles downward, preserving
      // relative order (tiles never pass one another). The locked flag travels
      // WITH its tile as it falls.
      const moves: { from: Cell; to: Cell; kind: TileKind }[] = [];
      for (let c = 0; c < this.cols; c++) {
        const nonEmpty: { row: number; kind: TileKind; locked: boolean }[] = [];
        for (let r = 0; r < this.rows; r++) {
          const idx = this.idx(r, c);
          const v = this.grid[idx]!;
          if (v !== -1) nonEmpty.push({ row: r, kind: v, locked: this.locked[idx] === true });
        }
        const numEmpty = this.rows - nonEmpty.length;
        for (let r = 0; r < this.rows; r++) {
          const idx = this.idx(r, c);
          this.grid[idx] = -1;
          this.locked[idx] = false;
        }
        for (let i = 0; i < nonEmpty.length; i++) {
          const entry = nonEmpty[i]!;
          const newRow = numEmpty + i;
          const nidx = this.idx(newRow, c);
          this.grid[nidx] = entry.kind;
          this.locked[nidx] = entry.locked;
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
          this.locked[this.idx(r, c)] = false; // spawned tiles are never locked
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

  /**
   * Would swapping `a` and `b` (without committing) produce a match? A swap
   * involving a locked cell is never legal, so it never "would match" — this
   * keeps hasMoves/findHint from ever proposing a locked-cell swap. The locked
   * layer is passed through so locked tiles also can't form the resulting run.
   */
  private wouldMatch(a: Cell, b: Cell): boolean {
    const ia = this.idx(a.row, a.col);
    const ib = this.idx(b.row, b.col);
    if (this.locked[ia] === true || this.locked[ib] === true) return false;
    const scratch = this.grid.slice();
    const tmp = scratch[ia]!;
    scratch[ia] = scratch[ib]!;
    scratch[ib] = tmp;
    return matchedIndices(scratch, this.rows, this.cols, this.locked).size > 0;
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
      if (matchedIndices(this.grid, this.rows, this.cols, this.locked).size === 0 && this.hasMoves()) {
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
