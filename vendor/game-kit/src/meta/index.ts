/**
 * meta — cross-run progression: per-level records, win-streaks, and aggregate
 * stats, on top of the `save` store.
 *
 * THREE-FREE, DOM-FREE. The reducer (`initMeta` / `recordResult`) is PURE and
 * deterministic — same (state, result) always yields the same next state, never
 * touches the wall clock or `Math.random`, and never mutates its inputs. The
 * `createMetaStore` wrapper adds persistence + subscription around it.
 *
 * "Meta" here = what survives across runs (records, streaks, totals), as opposed
 * to `campaign`'s single-run reducer (score/moves within one level).
 */
import { createSaveStore } from '../save/index.js';

export interface LevelRecord {
  /** Best score achieved on this level (updated on any play, win or lose). */
  bestScore: number;
  /** Best stars earned (0..3); only a win yields stars. */
  bestStars: number;
  /** How many times this level has been played. */
  plays: number;
  /** Whether the level has ever been cleared. */
  cleared: boolean;
}

export interface MetaState {
  /** Per-level records, keyed by a caller-chosen level id. */
  levels: Record<string, LevelRecord>;
  /** Sum of `bestStars` across all levels. */
  totalStars: number;
  /** Count of cleared levels. */
  levelsCleared: number;
  /** Consecutive wins; resets to 0 on a loss. */
  currentStreak: number;
  /** Highest `currentStreak` ever reached. */
  bestStreak: number;
  /** Total plays across all levels. */
  totalPlays: number;
  /** Total wins across all levels. */
  totalWins: number;
}

export interface LevelResult {
  levelId: string;
  won: boolean;
  /** Final score for this play (>= 0). */
  score: number;
  /** Stars earned this play (0..3); a loss should pass 0. */
  stars: number;
}

const clampStars = (n: number): number => Math.max(0, Math.min(3, Math.floor(n)));

export function initMeta(): MetaState {
  return {
    levels: {},
    totalStars: 0,
    levelsCleared: 0,
    currentStreak: 0,
    bestStreak: 0,
    totalPlays: 0,
    totalWins: 0,
  };
}

function emptyRecord(): LevelRecord {
  return { bestScore: 0, bestStars: 0, plays: 0, cleared: false };
}

/**
 * Fold one level result into the meta state, returning a fresh state (inputs are
 * never mutated). Aggregates (`totalStars`, `levelsCleared`) are recomputed from
 * the levels map so they can never drift; streak/total counters advance.
 */
export function recordResult(state: MetaState, result: LevelResult): MetaState {
  const stars = clampStars(result.stars);
  const score = Math.max(0, Math.floor(result.score));
  const prev = state.levels[result.levelId] ?? emptyRecord();

  const rec: LevelRecord = {
    bestScore: Math.max(prev.bestScore, score),
    bestStars: Math.max(prev.bestStars, result.won ? stars : 0),
    plays: prev.plays + 1,
    cleared: prev.cleared || result.won,
  };

  const levels = { ...state.levels, [result.levelId]: rec };

  // Recompute aggregates from the map (drift-proof).
  let totalStars = 0;
  let levelsCleared = 0;
  for (const key of Object.keys(levels)) {
    const r = levels[key]!;
    totalStars += r.bestStars;
    if (r.cleared) levelsCleared += 1;
  }

  const currentStreak = result.won ? state.currentStreak + 1 : 0;

  return {
    levels,
    totalStars,
    levelsCleared,
    currentStreak,
    bestStreak: Math.max(state.bestStreak, currentStreak),
    totalPlays: state.totalPlays + 1,
    totalWins: state.totalWins + (result.won ? 1 : 0),
  };
}

export interface MetaStore {
  /** Current meta state (loads persisted, or a fresh state). */
  get(): MetaState;
  /** Record a result, persist, notify subscribers, and return the new state. */
  record(result: LevelResult): MetaState;
  /** Wipe progression back to a fresh state. */
  reset(): void;
  /** Subscribe to changes; returns an unsubscribe fn. */
  subscribe(cb: (state: MetaState) => void): () => void;
}

/**
 * Persisted, observable meta store. Backed by `createSaveStore` (localStorage
 * with an in-memory fallback + checksum/version guard), so a corrupt or
 * version-mismatched blob transparently resets to a fresh state.
 */
export function createMetaStore(opts: { key: string; version?: number }): MetaStore {
  const store = createSaveStore<MetaState>({ key: opts.key, version: opts.version ?? 1 });
  const subs = new Set<(s: MetaState) => void>();

  const get = (): MetaState => store.load() ?? initMeta();

  return {
    get,
    record(result: LevelResult): MetaState {
      const next = recordResult(get(), result);
      store.save(next);
      for (const cb of subs) cb(next);
      return next;
    },
    reset(): void {
      store.clear();
      const fresh = initMeta();
      for (const cb of subs) cb(fresh);
    },
    subscribe(cb: (s: MetaState) => void): () => void {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}
