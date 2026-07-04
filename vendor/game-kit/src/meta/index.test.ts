import { describe, it, expect, beforeEach } from 'vitest';
import { initMeta, recordResult, createMetaStore, type MetaState } from './index.js';

const win = (levelId: string, score: number, stars: number) => ({ levelId, won: true, score, stars });
const loss = (levelId: string, score = 0) => ({ levelId, won: false, score, stars: 0 });

describe('recordResult (pure)', () => {
  it('does not mutate the input state', () => {
    const s = initMeta();
    const frozen = JSON.stringify(s);
    recordResult(s, win('1', 500, 2));
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it('records a win: best score/stars, cleared, plays, totals', () => {
    const s = recordResult(initMeta(), win('1', 500, 2));
    expect(s.levels['1']).toEqual({ bestScore: 500, bestStars: 2, plays: 1, cleared: true });
    expect(s.totalStars).toBe(2);
    expect(s.levelsCleared).toBe(1);
    expect(s.totalPlays).toBe(1);
    expect(s.totalWins).toBe(1);
    expect(s.currentStreak).toBe(1);
    expect(s.bestStreak).toBe(1);
  });

  it('keeps the best score/stars across plays, never regressing', () => {
    let s = recordResult(initMeta(), win('1', 800, 3));
    s = recordResult(s, win('1', 400, 1)); // worse play
    expect(s.levels['1']!.bestScore).toBe(800);
    expect(s.levels['1']!.bestStars).toBe(3);
    expect(s.levels['1']!.plays).toBe(2);
    expect(s.totalStars).toBe(3); // not double-counted
  });

  it('a loss still records a play + best score but zero stars, and breaks the streak', () => {
    let s = recordResult(initMeta(), win('1', 500, 2));
    s = recordResult(s, loss('1', 700)); // lost but scored higher
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(1);
    expect(s.levels['1']!.bestScore).toBe(700); // best score updates even on a loss
    expect(s.levels['1']!.bestStars).toBe(2); // stars unchanged by a loss
    expect(s.levels['1']!.plays).toBe(2);
    expect(s.totalWins).toBe(1);
  });

  it('tracks win-streak and best-streak across levels', () => {
    let s = initMeta();
    s = recordResult(s, win('1', 100, 1));
    s = recordResult(s, win('2', 100, 1));
    s = recordResult(s, win('3', 100, 1));
    expect(s.currentStreak).toBe(3);
    expect(s.bestStreak).toBe(3);
    s = recordResult(s, loss('4'));
    expect(s.currentStreak).toBe(0);
    expect(s.bestStreak).toBe(3);
    s = recordResult(s, win('4', 100, 1));
    expect(s.currentStreak).toBe(1);
    expect(s.bestStreak).toBe(3); // preserved
  });

  it('aggregates totalStars + levelsCleared across many levels (recomputed, no drift)', () => {
    let s = initMeta();
    s = recordResult(s, win('1', 100, 3));
    s = recordResult(s, win('2', 100, 2));
    s = recordResult(s, win('1', 100, 1)); // replays level 1 lower — must not add stars
    expect(s.totalStars).toBe(3 + 2);
    expect(s.levelsCleared).toBe(2);
  });

  it('clamps stars to 0..3 and floors negatives on score', () => {
    const s = recordResult(initMeta(), win('1', 250, 9));
    expect(s.levels['1']!.bestStars).toBe(3);
    const s2 = recordResult(initMeta(), { levelId: '1', won: true, score: -50, stars: -2 });
    expect(s2.levels['1']!.bestScore).toBe(0);
    expect(s2.levels['1']!.bestStars).toBe(0);
  });

  it('is deterministic: same result sequence yields identical state', () => {
    const seq = [win('1', 300, 2), loss('2'), win('2', 500, 3), win('1', 900, 3)];
    const run = () => seq.reduce((acc, r) => recordResult(acc, r), initMeta());
    expect(run()).toEqual(run());
  });
});

describe('createMetaStore (persisted + observable)', () => {
  let n = 0;
  const freshKey = () => `meta-test-${n++}`;

  beforeEach(() => {
    // isolate localStorage between tests where available
    if (typeof localStorage !== 'undefined') localStorage.clear();
  });

  it('starts empty, then persists across store instances sharing a key', () => {
    const key = freshKey();
    const a = createMetaStore({ key });
    expect(a.get()).toEqual(initMeta());
    a.record(win('1', 500, 2));

    const b = createMetaStore({ key });
    expect(b.get().levels['1']!.bestScore).toBe(500);
    expect(b.get().totalStars).toBe(2);
  });

  it('record returns the new state and notifies subscribers', () => {
    const store = createMetaStore({ key: freshKey() });
    const seen: MetaState[] = [];
    const unsub = store.subscribe((s) => seen.push(s));
    const returned = store.record(win('1', 400, 3));
    expect(returned.totalStars).toBe(3);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(returned);
    unsub();
    store.record(win('2', 100, 1));
    expect(seen).toHaveLength(1); // no longer notified
  });

  it('reset wipes progression and notifies', () => {
    const store = createMetaStore({ key: freshKey() });
    store.record(win('1', 400, 3));
    let last: MetaState | null = null;
    store.subscribe((s) => (last = s));
    store.reset();
    expect(store.get()).toEqual(initMeta());
    expect(last).toEqual(initMeta());
  });
});
