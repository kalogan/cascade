/**
 * grid-input — reusable tap/drag input for grid games (Match-3, sliding puzzles).
 *
 * THREE-FREE, DOM-FREE. The kit's `touch` module is shaped for a virtual-stick /
 * look shooter; grids want a different gesture set, and this is its reusable home:
 *
 *   • tap a cell to select it, then tap an ADJACENT cell to swap the two;
 *   • or drag from a cell straight onto an adjacent cell to swap (no second tap);
 *   • selection persists across pointer-up so the tap-tap flow works.
 *
 * The caller owns the geometry (`hitTest` maps a screen point → cell or null) and
 * the effects (`onSwap`/`onSelect`); this module owns only the gesture state
 * machine. Pure: no wall-clock, no randomness — same call sequence, same behaviour.
 */

export interface GridCell {
  row: number;
  col: number;
}

export interface GridInputOptions {
  /** Map a screen point to an in-bounds cell, or null if outside the grid. */
  hitTest: (x: number, y: number) => GridCell | null;
  /** Two orthogonally-adjacent cells the player wants to swap. */
  onSwap: (a: GridCell, b: GridCell) => void;
  /** A cell became selected (drive a highlight / select sfx). */
  onSelect?: (cell: GridCell) => void;
  /** The selection was cleared. */
  onDeselect?: () => void;
  /** Gate input (e.g. while the board is animating). Default: always enabled. */
  enabled?: () => boolean;
}

export interface GridInput {
  /** The currently selected cell (for the caller to highlight), or null. */
  readonly selected: GridCell | null;
  pointerDown(x: number, y: number): void;
  pointerMove(x: number, y: number): void;
  pointerUp(x: number, y: number): void;
  /** Drop any selection / in-progress drag (e.g. on level change). */
  clear(): void;
}

const orthAdjacent = (a: GridCell, b: GridCell): boolean =>
  Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;

const same = (a: GridCell, b: GridCell): boolean => a.row === b.row && a.col === b.col;

export function createGridInput(opts: GridInputOptions): GridInput {
  const enabled = opts.enabled ?? (() => true);
  let selected: GridCell | null = null;
  let dragStart: GridCell | null = null;

  const deselect = (): void => {
    if (selected) {
      selected = null;
      opts.onDeselect?.();
    }
  };

  return {
    get selected(): GridCell | null {
      return selected;
    },

    pointerDown(x: number, y: number): void {
      if (!enabled()) return;
      const c = opts.hitTest(x, y);
      if (!c) return;
      // Second tap on a neighbour of the selected cell → swap.
      if (selected && orthAdjacent(selected, c)) {
        const from = selected;
        selected = null;
        dragStart = null;
        opts.onSwap(from, c);
        return;
      }
      // Otherwise (re)select this cell and arm a possible drag from it.
      selected = c;
      dragStart = c;
      opts.onSelect?.(c);
    },

    pointerMove(x: number, y: number): void {
      if (!enabled() || !dragStart) return;
      const c = opts.hitTest(x, y);
      // Drag straight onto an orthogonal neighbour of the start cell → swap.
      if (c && !same(c, dragStart) && orthAdjacent(dragStart, c)) {
        const from = dragStart;
        dragStart = null;
        selected = null;
        opts.onSwap(from, c);
      }
    },

    pointerUp(_x: number, _y: number): void {
      // End the drag but KEEP the selection so the tap-select-then-tap-neighbour
      // flow still works after lifting the finger.
      dragStart = null;
    },

    clear(): void {
      dragStart = null;
      deselect();
    },
  };
}
