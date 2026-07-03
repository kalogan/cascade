// game-kit/npc-transformers — OPTIONAL real-model NPC embedder (Track A3).
//
// The core kit ships ZERO model deps: `createHashingEmbedder()` (in ../npc/embedder.ts)
// is lexical-only. This sub-entry is the OPT-IN neural path: it produces true semantic
// embeddings via transformers.js (`@xenova/transformers`, ~25MB) and wraps them through
// the kit's existing `createModelEmbedder` adapter into the same `Embedder` seam.
//
// WHY A SEPARATE SUB-ENTRY: `@xenova/transformers` is declared as an OPTIONAL peer
// dependency — it is NOT installed by the kit. A game that wants neural recall runs
// `pnpm add @xenova/transformers` and imports `game-kit/npc-transformers`; everyone else
// pays nothing. To keep `tsc --noEmit` GREEN with the package ABSENT, we never `import`
// it statically. Instead we `await import('@xenova/transformers')` at CALL time behind a
// minimal LOCAL type shim (below) that declares only the `pipeline` signature we use.
// Importing THIS file pulls in nothing but `../npc/embedder.js` — the heavy dep is loaded
// lazily, on first embed, and only if the caller actually opts in.
//
// SERVER-SIDE (or a worker): model inference is heavy; keep it off the render path.

import { createModelEmbedder, type Embedder } from '../npc/embedder.js';

// --- Local type shim for `@xenova/transformers` --------------------------------------
// We declare ONLY the surface we use so this file type-checks without the package
// present. The real module is loaded at runtime via `await import(...)`. If the shape
// drifts, the runtime cast below is the single point that would need revisiting.

/** Tensor-like result of a feature-extraction call: `.data` is the flat embedding. */
interface FeatureExtractionOutput {
  data: Float32Array | number[];
}

/** Options accepted by the feature-extraction pipeline call. */
interface FeatureExtractionCallOptions {
  pooling?: 'none' | 'mean' | 'cls';
  normalize?: boolean;
}

/** The callable pipeline returned by `pipeline('feature-extraction', ...)`. */
type FeatureExtractionPipeline = (
  text: string,
  options?: FeatureExtractionCallOptions,
) => Promise<FeatureExtractionOutput>;

/** Minimal shape of the `@xenova/transformers` module we depend on. */
interface TransformersModule {
  pipeline(
    task: 'feature-extraction',
    model: string,
  ): Promise<FeatureExtractionPipeline>;
}

/**
 * The optional-dep specifier, held in a value so TypeScript treats the `import()` below
 * as DYNAMIC (yielding `any`) instead of statically resolving `@xenova/transformers` —
 * which would raise TS2307 whenever the package is absent (i.e. always, by default).
 * This is what keeps `tsc --noEmit` GREEN without the dep installed; the real shape is
 * recovered by casting to `TransformersModule` at the call site.
 */
const TRANSFORMERS_MODULE = '@xenova/transformers';

// -------------------------------------------------------------------------------------

export interface TransformersEmbedderOptions {
  /**
   * Hugging Face model id for feature-extraction. Default 'Xenova/all-MiniLM-L6-v2'
   * (384-dim, the standard small sentence-embedding model in transformers.js).
   */
  model?: string;
  /** Pooling strategy passed to the pipeline. Default 'mean' (sentence embedding). */
  pooling?: 'none' | 'mean' | 'cls';
  /** L2-normalize the output vector. Default true (recommended for cosine recall). */
  normalize?: boolean;
}

/**
 * Build an `Embedder` backed by a REAL transformers.js feature-extraction model.
 *
 * OPT-IN: requires `@xenova/transformers` to be installed in the game (it's an optional
 * peer dep of the kit — see package.json). The model + pipeline are loaded LAZILY on the
 * first `embed(...)` call and cached for the lifetime of the returned embedder, so the
 * ~25MB dep is never touched at import time and only paid for when actually used.
 *
 *   // game-owned, after `pnpm add @xenova/transformers`:
 *   import { createTransformersEmbedder } from 'game-kit/npc-transformers';
 *   const embedder = createTransformersEmbedder();           // all-MiniLM-L6-v2
 *   const brain = createNpcBrain({ embedder });
 *
 * Drops into `createNpcBrain({ embedder })` exactly like the hashing default — same seam.
 */
export function createTransformersEmbedder(
  opts: TransformersEmbedderOptions = {},
): Embedder {
  const model = opts.model ?? 'Xenova/all-MiniLM-L6-v2';
  const pooling = opts.pooling ?? 'mean';
  const normalize = opts.normalize ?? true;

  // Lazily-resolved pipeline, shared across calls. The dynamic import is what keeps the
  // dep optional + out of the import graph until the first embed.
  let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

  function getPipeline(): Promise<FeatureExtractionPipeline> {
    if (pipelinePromise === undefined) {
      pipelinePromise = (async () => {
        // Cast through the local shim — the package has no types bundled here, and we
        // deliberately don't take a static `@types`/import dependency on it.
        const mod = (await import(
          /* webpackIgnore: true */ /* @vite-ignore */ TRANSFORMERS_MODULE
        )) as unknown as TransformersModule;
        return mod.pipeline('feature-extraction', model);
      })();
    }
    return pipelinePromise;
  }

  return createModelEmbedder(async (text: string): Promise<number[]> => {
    const extract = await getPipeline();
    const out = await extract(text, { pooling, normalize });
    return Array.from(out.data as ArrayLike<number>);
  });
}
