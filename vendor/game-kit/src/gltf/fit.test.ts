import { describe, it, expect } from 'vitest';
// Pure auto-fit math harvested from GYRE's per-GLB Box3 normalize + feet-on-floor.
// No three / DOM / WebGL needed — this is plain arithmetic.
import { computeGltfFit } from './index.js';

describe('computeGltfFit', () => {
  it('scales a model to the target height', () => {
    // A 2u-tall model normalized to 1.8u → scale 0.9.
    const fit = computeGltfFit({ minY: 0, sizeY: 2 }, 1.8);
    expect(fit.scale).toBeCloseTo(0.9, 10);
  });

  it('scales UP a short model to the target height', () => {
    // A 0.5u model to 3.4u (GYRE's looming Hollow) → scale 6.8.
    const fit = computeGltfFit({ minY: 0, sizeY: 0.5 }, 3.4);
    expect(fit.scale).toBeCloseTo(6.8, 10);
  });

  it('seats feet on the floor: scaled minY lands at 0', () => {
    // Model whose lowest point is -1 in its own units, scaled ×2 → offset +2 so
    // the scaled floor (-1 × 2 = -2) lands at 0.
    const fit = computeGltfFit({ minY: -1, sizeY: 2 }, 4); // scale = 4/2 = 2
    expect(fit.scale).toBeCloseTo(2, 10);
    expect(fit.positionY).toBeCloseTo(2, 10);
    // Verify the invariant directly: scaledMinY + positionY === 0.
    const scaledMinY = -1 * fit.scale;
    expect(scaledMinY + fit.positionY).toBeCloseTo(0, 10);
  });

  it('handles a model authored with its feet already at y=0 (minY=0)', () => {
    const fit = computeGltfFit({ minY: 0, sizeY: 1.8 }, 1.8);
    expect(fit.scale).toBeCloseTo(1, 10);
    expect(fit.positionY).toBeCloseTo(0, 10);
  });

  it('handles a model whose origin is at its center (minY negative half-height)', () => {
    // 2u model centered on origin → minY -1. Target 2u → scale 1, lift +1.
    const fit = computeGltfFit({ minY: -1, sizeY: 2 }, 2);
    expect(fit.scale).toBeCloseTo(1, 10);
    expect(fit.positionY).toBeCloseTo(1, 10);
  });

  it('falls back to scale 1 for a zero-height (flat) model — no divide-by-zero', () => {
    const fit = computeGltfFit({ minY: 0, sizeY: 0 }, 1.8);
    expect(fit.scale).toBe(1);
    expect(fit.positionY).toBe(0);
  });

  it('falls back to scale 1 for a NaN / non-finite height', () => {
    expect(computeGltfFit({ minY: 0, sizeY: NaN }, 1.8).scale).toBe(1);
    expect(computeGltfFit({ minY: 0, sizeY: Infinity }, 1.8).scale).toBe(1);
  });

  it('still seats the floor when falling back to scale 1', () => {
    // Degenerate height but a non-zero minY → lift by -minY (scale 1).
    const fit = computeGltfFit({ minY: -0.3, sizeY: 0 }, 1.8);
    expect(fit.scale).toBe(1);
    expect(fit.positionY).toBeCloseTo(0.3, 10);
  });
});
