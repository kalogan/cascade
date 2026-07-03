/**
 * Nav + pathfinding (Track B1) — a walkable grid + A*.
 *
 * Distilled from the nav layer that drives Wayfinders' deterministic NPCs: a grid of
 * walkable/blocked cells over the XZ plane, with A* routing between cells. Pure, THREE-free,
 * deterministic (a given grid + start + goal always yields the same path), so it unit-tests
 * exhaustively and the behavior layer (B2) consumes it through the `Pathfinder` seam.
 *
 * Coordinates: the game works in world XZ (`Vec2 = [x, z]`); the grid maps world↔cell via an
 * `origin` (world position of cell 0,0's centre) + `cellSize`. `findPath` takes/returns world
 * points (cell centres); `findCellPath` is the raw cell-space A* underneath.
 */

/** A world-space point on the XZ plane: `[x, z]`. */
export type Vec2 = [number, number];
/** A grid cell coordinate: `[col, row]`. */
export type Cell = [number, number];

/** The seam the behavior layer depends on — world XZ in, world-XZ waypoints out (or null). */
export interface Pathfinder {
  findPath(start: Vec2, goal: Vec2): Vec2[] | null;
}

export interface GridNavOptions {
  /** Grid width in cells. */
  width: number;
  /** Grid height in cells. */
  height: number;
  /** True if cell (cx, cy) can be walked. Called during search; keep it cheap. */
  isWalkable: (cx: number, cy: number) => boolean;
  /** World units per cell. Default 1. */
  cellSize?: number;
  /** World XZ of cell (0,0)'s centre. Default [0, 0]. */
  origin?: Vec2;
  /** Allow diagonal moves (8-connectivity, no corner-cutting). Default true. */
  diagonal?: boolean;
}

export interface GridNav extends Pathfinder {
  readonly width: number;
  readonly height: number;
  readonly cellSize: number;
  inBounds(cx: number, cy: number): boolean;
  isWalkable(cx: number, cy: number): boolean;
  worldToCell(p: Vec2): Cell;
  cellToWorld(c: Cell): Vec2;
  /** Raw cell-space A*: a list of cells from start to goal inclusive, or null if unreachable. */
  findCellPath(start: Cell, goal: Cell): Cell[] | null;
}

const SQRT2 = Math.SQRT2;

/** Create a grid pathfinder. */
export function createGridNav(opts: GridNavOptions): GridNav {
  const width = opts.width;
  const height = opts.height;
  const cellSize = opts.cellSize ?? 1;
  const originX = opts.origin?.[0] ?? 0;
  const originZ = opts.origin?.[1] ?? 0;
  const diagonal = opts.diagonal ?? true;
  const walkAt = opts.isWalkable;

  const inBounds = (cx: number, cy: number): boolean =>
    cx >= 0 && cy >= 0 && cx < width && cy < height;
  const isWalkable = (cx: number, cy: number): boolean => inBounds(cx, cy) && walkAt(cx, cy);

  const worldToCell = (p: Vec2): Cell => [
    Math.round((p[0] - originX) / cellSize),
    Math.round((p[1] - originZ) / cellSize),
  ];
  const cellToWorld = (c: Cell): Vec2 => [originX + c[0] * cellSize, originZ + c[1] * cellSize];

  // 4- or 8-neighbourhood. Diagonals only when BOTH shared orthogonals are open (no cut).
  const ORTHO: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  const DIAG: ReadonlyArray<readonly [number, number]> = [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ];

  function findCellPath(start: Cell, goal: Cell): Cell[] | null {
    const [sx, sy] = start;
    const [gx, gy] = goal;
    if (!isWalkable(sx, sy) || !isWalkable(gx, gy)) return null;

    const size = width * height;
    const idx = (cx: number, cy: number): number => cy * width + cx;
    const goalIdx = idx(gx, gy);

    const gScore = new Float64Array(size).fill(Infinity);
    const fScore = new Float64Array(size).fill(Infinity);
    const hScore = new Float64Array(size).fill(0);
    const cameFrom = new Int32Array(size).fill(-1);
    const closed = new Uint8Array(size);

    const heuristic = (cx: number, cy: number): number => {
      const dx = Math.abs(cx - gx);
      const dy = Math.abs(cy - gy);
      // Octile when diagonals allowed; Manhattan otherwise.
      return diagonal ? Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy) : dx + dy;
    };

    // Lazy-deletion binary min-heap of cell indices, keyed by f then h then index.
    const heap: number[] = [];
    const less = (a: number, b: number): boolean => {
      const fa = fScore[a] as number;
      const fb = fScore[b] as number;
      if (fa !== fb) return fa < fb;
      const ha = hScore[a] as number;
      const hb = hScore[b] as number;
      if (ha !== hb) return ha < hb;
      return a < b;
    };
    const push = (i: number): void => {
      heap.push(i);
      let c = heap.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (less(heap[c] as number, heap[p] as number)) {
          [heap[c], heap[p]] = [heap[p] as number, heap[c] as number];
          c = p;
        } else break;
      }
    };
    const pop = (): number => {
      const top = heap[0] as number;
      const last = heap.pop() as number;
      if (heap.length > 0) {
        heap[0] = last;
        let p = 0;
        for (;;) {
          const l = 2 * p + 1;
          const r = l + 1;
          let m = p;
          if (l < heap.length && less(heap[l] as number, heap[m] as number)) m = l;
          if (r < heap.length && less(heap[r] as number, heap[m] as number)) m = r;
          if (m === p) break;
          [heap[p], heap[m]] = [heap[m] as number, heap[p] as number];
          p = m;
        }
      }
      return top;
    };

    const startIdx = idx(sx, sy);
    gScore[startIdx] = 0;
    hScore[startIdx] = heuristic(sx, sy);
    fScore[startIdx] = hScore[startIdx];
    push(startIdx);

    while (heap.length > 0) {
      const current = pop();
      if (closed[current]) continue; // stale heap entry
      if (current === goalIdx) return reconstruct(cameFrom, current, width);
      closed[current] = 1;

      const cx = current % width;
      const cy = (current - cx) / width;

      const relax = (nx: number, ny: number, cost: number): void => {
        if (!isWalkable(nx, ny)) return;
        const ni = idx(nx, ny);
        if (closed[ni]) return;
        const tentative = (gScore[current] as number) + cost;
        if (tentative < (gScore[ni] as number)) {
          cameFrom[ni] = current;
          gScore[ni] = tentative;
          hScore[ni] = heuristic(nx, ny);
          fScore[ni] = tentative + hScore[ni];
          push(ni);
        }
      };

      for (const [dx, dy] of ORTHO) relax(cx + dx, cy + dy, 1);
      if (diagonal) {
        for (const [dx, dy] of DIAG) {
          // No corner-cutting: both orthogonal cells the diagonal "squeezes" past must be open.
          if (!isWalkable(cx + dx, cy) || !isWalkable(cx, cy + dy)) continue;
          relax(cx + dx, cy + dy, SQRT2);
        }
      }
    }

    return null; // goal unreachable
  }

  return {
    width,
    height,
    cellSize,
    inBounds,
    isWalkable,
    worldToCell,
    cellToWorld,
    findCellPath,
    findPath(start: Vec2, goal: Vec2): Vec2[] | null {
      const cellPath = findCellPath(worldToCell(start), worldToCell(goal));
      if (!cellPath) return null;
      return cellPath.map((c) => cellToWorld(c));
    },
  };
}

/** Walk `cameFrom` back from `current` to the start and return the cell path (start → goal). */
function reconstruct(cameFrom: Int32Array, current: number, width: number): Cell[] {
  const cells: Cell[] = [];
  let node = current;
  while (node !== -1) {
    const cx = node % width;
    const cy = (node - cx) / width;
    cells.push([cx, cy]);
    node = cameFrom[node] as number;
  }
  cells.reverse();
  return cells;
}
