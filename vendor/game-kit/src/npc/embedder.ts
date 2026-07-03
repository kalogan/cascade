/**
 * NPC memory — EMBEDDINGS + semantic recall (Track A3).
 *
 * Today `buildMemoryView` feeds the brain the LAST N turns. Semantic recall feeds it the
 * most RELEVANT past turns for the current message (plus a few recent), so an NPC surfaces
 * "you asked about the frost orchid last week" even when it's far back in the log.
 *
 * `Embedder` is the seam: `embed(text) → number[]`. Two paths:
 *   • `createHashingEmbedder()` — the LOCAL, zero-dependency default. Feature-hashing over
 *     words + char trigrams → a fixed-dim L2-normalized vector. Deterministic + free. It's
 *     LEXICAL (shared words/sub-words), not a neural model — good for keyword-ish recall.
 *   • A real LOCAL MODEL (e.g. transformers.js all-MiniLM) or an embeddings API is a drop-in
 *     adapter that implements `Embedder` — the same seam, swapped in when you want true
 *     semantic similarity. That choice (a ~25MB model dep) is deliberately left to the game.
 *
 * SERVER-SIDE (or a worker): embedding many turns can be heavy; keep it off the render path.
 */

import type { NpcMemoryTurn } from './memory.js';

/** Maps text to a numeric vector. Injectable — swap the local default for a real model. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

/** FNV-1a 32-bit hash of `str` mixed with `seed` (for feature hashing). */
function fnv1a(str: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Yield hashing FEATURES for a string: whole words + padded char trigrams (sub-word overlap). */
function* features(text: string): Iterable<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length === 0) continue;
    yield `w:${w}`;
    const padded = `#${w}#`;
    for (let i = 0; i + 3 <= padded.length; i++) yield `t:${padded.slice(i, i + 3)}`;
  }
}

export interface HashingEmbedderOptions {
  /** Vector dimension. Default 256 (more = fewer hash collisions, larger vectors). */
  dim?: number;
}

/**
 * The local, deterministic, zero-dependency `Embedder`. Feature-hashes words + char trigrams
 * into a signed, L2-normalized vector. Same text → same vector. Lexical, not neural.
 */
export function createHashingEmbedder(opts: HashingEmbedderOptions = {}): Embedder {
  const dim = opts.dim ?? 256;
  return {
    async embed(text: string): Promise<number[]> {
      const vec = new Float64Array(dim);
      for (const feature of features(text)) {
        const idx = fnv1a(feature, 0) % dim;
        // Signed hashing (a second hash bit picks the sign) reduces collision bias.
        const sign = (fnv1a(feature, 0x9e3779b9) & 1) === 0 ? 1 : -1;
        vec[idx] = (vec[idx] as number) + sign;
      }
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        const x = vec[i] as number;
        norm += x * x;
      }
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < dim; i++) vec[i] = (vec[i] as number) / norm;
      return Array.from(vec);
    },
  };
}

/**
 * OPT-IN adapter point for a REAL embedding model (e.g. transformers.js all-MiniLM, or an
 * embeddings API). Wrap any async `text → number[]` function as an `Embedder` so the game
 * drops it into `createNpcBrain({ embedder })` exactly like the hashing default — same seam.
 *
 * ★ DEPENDENCY DECISION IS THE GAME'S. The kit ships ZERO model deps (the hashing embedder
 * is lexical-only). Pulling a neural model (~25MB for all-MiniLM via transformers.js) is a
 * deliberate, reviewed choice the game makes — never an implicit kit dependency. Example:
 *
 *   // game-owned, after `pnpm add @xenova/transformers`:
 *   import { pipeline } from '@xenova/transformers';
 *   const extract = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
 *   const embedder = createModelEmbedder(async (text) => {
 *     const out = await extract(text, { pooling: 'mean', normalize: true });
 *     return Array.from(out.data as Float32Array);
 *   });
 */
export function createModelEmbedder(embed: (text: string) => Promise<number[]>): Embedder {
  return { embed };
}

/** Cosine similarity of two vectors in [-1, 1] (0 if either is empty/zero). */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface RecallOptions {
  /** How many of the MOST RELEVANT older turns to surface (by cosine). Default 4. */
  k?: number;
  /** How many of the MOST RECENT turns to always include. Default 4. */
  recent?: number;
}

/**
 * Select the turns to feed the brain: the `recent` newest turns ALWAYS, plus the top-`k`
 * older turns most similar to `queryEmbedding`. Returns them in chronological order, deduped.
 * Older turns without an embedding are skipped (they can't be scored). Pure + deterministic.
 */
export function selectRelevantTurns(
  turns: readonly NpcMemoryTurn[],
  queryEmbedding: readonly number[],
  opts: RecallOptions = {},
): NpcMemoryTurn[] {
  const recent = opts.recent ?? 4;
  const k = opts.k ?? 4;
  const n = turns.length;
  const recentStart = Math.max(0, n - recent);

  // Score the OLDER turns (those not already in the recent window) by similarity.
  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < recentStart; i++) {
    const emb = turns[i]?.embedding;
    if (!Array.isArray(emb)) continue;
    scored.push({ index: i, score: cosineSimilarity(queryEmbedding, emb) });
  }
  // Highest score first; tie-break by original order for determinism.
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  const chosen = new Set<number>();
  for (const s of scored.slice(0, k)) chosen.add(s.index);
  for (let i = recentStart; i < n; i++) chosen.add(i);

  return [...chosen]
    .sort((a, b) => a - b)
    .map((i) => turns[i] as NpcMemoryTurn);
}
