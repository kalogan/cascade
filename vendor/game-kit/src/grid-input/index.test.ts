import { describe, it, expect } from 'vitest';
import { createGridInput, type GridCell } from './index.js';

// A hit-test over a rows×cols grid of unit cells at integer screen coords:
// screen (x=col, y=row). Out-of-range → null.
function gridHit(rows: number, cols: number) {
  return (x: number, y: number): GridCell | null => {
    const col = Math.round(x);
    const row = Math.round(y);
    if (row < 0 || col < 0 || row >= rows || col >= cols) return null;
    return { row, col };
  };
}

function harness() {
  const swaps: [GridCell, GridCell][] = [];
  const selects: GridCell[] = [];
  let deselects = 0;
  let on = true;
  const gi = createGridInput({
    hitTest: gridHit(4, 4),
    onSwap: (a, b) => swaps.push([a, b]),
    onSelect: (c) => selects.push(c),
    onDeselect: () => deselects++,
    enabled: () => on,
  });
  return { gi, swaps, selects, get deselects() { return deselects; }, setEnabled: (v: boolean) => (on = v) };
}

describe('createGridInput', () => {
  it('tap-select then tap adjacent → swaps the two, clears selection', () => {
    const h = harness();
    h.gi.pointerDown(0, 0); // select (0,0)
    expect(h.gi.selected).toEqual({ row: 0, col: 0 });
    expect(h.selects).toHaveLength(1);
    h.gi.pointerUp(0, 0); // selection persists across up
    expect(h.gi.selected).toEqual({ row: 0, col: 0 });
    h.gi.pointerDown(1, 0); // tap adjacent (0,1) → swap
    expect(h.swaps).toEqual([[{ row: 0, col: 0 }, { row: 0, col: 1 }]]);
    expect(h.gi.selected).toBeNull();
  });

  it('tap a NON-adjacent cell re-selects instead of swapping', () => {
    const h = harness();
    h.gi.pointerDown(0, 0); // select (0,0)
    h.gi.pointerDown(2, 2); // (2,2) not adjacent → reselect, no swap
    expect(h.swaps).toHaveLength(0);
    expect(h.gi.selected).toEqual({ row: 2, col: 2 });
    expect(h.selects).toHaveLength(2);
  });

  it('drag from a cell straight onto an adjacent neighbour → swaps', () => {
    const h = harness();
    h.gi.pointerDown(1, 1); // press (1,1)
    h.gi.pointerMove(2, 1); // drag onto (1,2)
    expect(h.swaps).toEqual([[{ row: 1, col: 1 }, { row: 1, col: 2 }]]);
    expect(h.gi.selected).toBeNull();
  });

  it('a drag onto a NON-adjacent / diagonal cell does not swap', () => {
    const h = harness();
    h.gi.pointerDown(1, 1);
    h.gi.pointerMove(2, 2); // diagonal → manhattan 2, no swap
    expect(h.swaps).toHaveLength(0);
    h.gi.pointerMove(3, 1); // two away horizontally → no swap
    expect(h.swaps).toHaveLength(0);
  });

  it('pointerMove without a prior pointerDown does nothing', () => {
    const h = harness();
    h.gi.pointerMove(1, 0);
    expect(h.swaps).toHaveLength(0);
    expect(h.gi.selected).toBeNull();
  });

  it('a tap outside the grid is ignored', () => {
    const h = harness();
    h.gi.pointerDown(99, 99); // out of bounds → null
    expect(h.gi.selected).toBeNull();
    expect(h.selects).toHaveLength(0);
  });

  it('respects the enabled() gate', () => {
    const h = harness();
    h.setEnabled(false);
    h.gi.pointerDown(0, 0);
    expect(h.gi.selected).toBeNull();
    h.setEnabled(true);
    h.gi.pointerDown(0, 0);
    expect(h.gi.selected).toEqual({ row: 0, col: 0 });
  });

  it('clear() drops selection + drag and fires onDeselect', () => {
    const h = harness();
    h.gi.pointerDown(0, 0);
    expect(h.gi.selected).not.toBeNull();
    h.gi.clear();
    expect(h.gi.selected).toBeNull();
    expect(h.deselects).toBe(1);
    // a subsequent move must not swap (drag was cleared)
    h.gi.pointerMove(1, 0);
    expect(h.swaps).toHaveLength(0);
  });

  it('deterministic: identical gesture sequences produce identical swaps', () => {
    const run = () => {
      const h = harness();
      h.gi.pointerDown(0, 0);
      h.gi.pointerDown(1, 0);
      h.gi.pointerDown(2, 2);
      h.gi.pointerMove(2, 3);
      return h.swaps;
    };
    expect(run()).toEqual(run());
  });
});
