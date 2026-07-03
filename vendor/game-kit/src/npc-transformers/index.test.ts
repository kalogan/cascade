// Unit tests for the OPTIONAL transformers.js embedder sub-entry.
//
// These tests deliberately require NEITHER the `@xenova/transformers` package NOR a
// model download. They cover the two things that can be tested purely:
//   1. The `createModelEmbedder` wiring: a stub `embed` fn yields a valid `Embedder`
//      (right dims, normalized vector preserved verbatim through the adapter).
//   2. The lazy-load contract: importing `./index.ts` and CONSTRUCTING the embedder
//      must NOT touch `@xenova/transformers`. The dep is only reached on first `embed`,
//      which we never call here — so the suite passes with the package absent.

import { describe, expect, it } from 'vitest';
import { createModelEmbedder, type Embedder } from '../npc/embedder.js';
import { createTransformersEmbedder } from './index.js';

describe('createModelEmbedder wiring (stub embed fn)', () => {
  it('wraps an async text→number[] fn into a valid Embedder', async () => {
    // A fixed, already-normalized 4-dim vector standing in for a real model output.
    const stub = [0.5, 0.5, 0.5, 0.5];
    const embedder: Embedder = createModelEmbedder(async () => [...stub]);

    const vec = await embedder.embed('the frost orchid blooms at dusk');

    expect(Array.isArray(vec)).toBe(true);
    expect(vec).toHaveLength(stub.length);
    expect(vec).toEqual(stub);

    // The stub is unit-norm; confirm the adapter passes it through untouched.
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('is async and returns a fresh array per call', async () => {
    const embedder = createModelEmbedder(async (text) => [text.length]);
    const a = await embedder.embed('ab');
    const b = await embedder.embed('abcd');
    expect(a).toEqual([2]);
    expect(b).toEqual([4]);
  });
});

describe('createTransformersEmbedder lazy-load contract', () => {
  it('constructs without importing/resolving @xenova/transformers', () => {
    // If construction eagerly pulled the (absent) dep, this would throw. The module is
    // loaded only inside embed(), via `await import(...)`, which we do not call here.
    const embedder = createTransformersEmbedder();
    expect(typeof embedder.embed).toBe('function');
  });

  it('exposes the Embedder shape (single embed method)', () => {
    const embedder: Embedder = createTransformersEmbedder({
      model: 'Xenova/all-MiniLM-L6-v2',
    });
    expect(Object.keys(embedder)).toEqual(['embed']);
  });
});
