import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIFFICULTY,
  difficultyForLevel,
  initRun,
  runReducer,
  totalLevels,
  type DifficultyParams,
  type RunState,
} from "./index.js";

describe("DEFAULT_DIFFICULTY", () => {
  it("shapes a 3-world x 3-level (9-level) run", () => {
    expect(DEFAULT_DIFFICULTY.worlds).toBe(3);
    expect(DEFAULT_DIFFICULTY.levelsPerWorld).toBe(3);
    expect(totalLevels()).toBe(9);
  });

  it("widens kinds from 4 (world 1) to 6 (world 3), clamped at maxKinds", () => {
    expect(DEFAULT_DIFFICULTY.baseKinds).toBe(4);
    expect(DEFAULT_DIFFICULTY.maxKinds).toBe(6);
    expect(difficultyForLevel(0).tileKinds).toBe(4);
    expect(difficultyForLevel(8).tileKinds).toBe(6);
  });

  it("uses a fixed portrait board", () => {
    expect(DEFAULT_DIFFICULTY.boardW).toBe(7);
    expect(DEFAULT_DIFFICULTY.boardH).toBe(8);
  });
});

describe("totalLevels", () => {
  it("is worlds * levelsPerWorld for defaults", () => {
    expect(totalLevels(DEFAULT_DIFFICULTY)).toBe(9);
  });

  it("respects custom params", () => {
    const params: DifficultyParams = { ...DEFAULT_DIFFICULTY, worlds: 5, levelsPerWorld: 4 };
    expect(totalLevels(params)).toBe(20);
  });
});

describe("difficultyForLevel — curve shape", () => {
  it("is deterministic: same index + params -> identical config", () => {
    const a = difficultyForLevel(4);
    const b = difficultyForLevel(4);
    expect(a).toEqual(b);
  });

  it("first level (index 0) is world 1, levelInWorld 1", () => {
    const cfg = difficultyForLevel(0);
    expect(cfg.index).toBe(0);
    expect(cfg.world).toBe(1);
    expect(cfg.levelInWorld).toBe(1);
  });

  it("last level (index 8) is world 3, levelInWorld 3", () => {
    const cfg = difficultyForLevel(8);
    expect(cfg.index).toBe(8);
    expect(cfg.world).toBe(3);
    expect(cfg.levelInWorld).toBe(3);
  });

  it("maps world/levelInWorld correctly across all 9 default levels", () => {
    const expected = [
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 1],
      [2, 2],
      [2, 3],
      [3, 1],
      [3, 2],
      [3, 3],
    ];
    for (let i = 0; i < 9; i++) {
      const cfg = difficultyForLevel(i);
      expect([cfg.world, cfg.levelInWorld]).toEqual(expected[i]);
    }
  });

  it("tileKinds is non-decreasing across the run", () => {
    let prev = -Infinity;
    for (let i = 0; i < totalLevels(); i++) {
      const cfg = difficultyForLevel(i);
      expect(cfg.tileKinds).toBeGreaterThanOrEqual(prev);
      prev = cfg.tileKinds;
    }
  });

  it("tileKinds clamps at maxKinds even with aggressive growth", () => {
    const params: DifficultyParams = { ...DEFAULT_DIFFICULTY, kindsGrowthPerWorld: 10, maxKinds: 6 };
    const cfg = difficultyForLevel(8, params);
    expect(cfg.tileKinds).toBe(6);
  });

  it("scoreTarget strictly increases across the run (real squeeze by world 3)", () => {
    let prev = -Infinity;
    for (let i = 0; i < totalLevels(); i++) {
      const cfg = difficultyForLevel(i);
      expect(cfg.scoreTarget).toBeGreaterThan(prev);
      prev = cfg.scoreTarget;
    }
    // World 1 is gently winnable; world 3 is a real squeeze.
    const world1 = difficultyForLevel(0);
    const world3 = difficultyForLevel(8);
    expect(world3.scoreTarget).toBeGreaterThan(world1.scoreTarget * 2);
  });

  it("moveBudget is non-increasing across the run (tighter over time)", () => {
    let prev = Infinity;
    for (let i = 0; i < totalLevels(); i++) {
      const cfg = difficultyForLevel(i);
      expect(cfg.moveBudget).toBeLessThanOrEqual(prev);
      prev = cfg.moveBudget;
    }
    expect(difficultyForLevel(8).moveBudget).toBeLessThan(difficultyForLevel(0).moveBudget);
  });

  it("obstacleDensity grows per world (small nudge)", () => {
    expect(difficultyForLevel(0).obstacleDensity).toBe(0);
    expect(difficultyForLevel(3).obstacleDensity).toBeCloseTo(0.05);
    expect(difficultyForLevel(6).obstacleDensity).toBeCloseTo(0.1);
  });

  it("floors/clamps negative or fractional indices to 0", () => {
    expect(difficultyForLevel(-5)).toEqual(difficultyForLevel(0));
    expect(difficultyForLevel(2.9).index).toBe(2);
  });
});

describe("initRun", () => {
  it("defaults to level 0, phase 'ready', preloaded target/moves", () => {
    const state = initRun();
    const cfg = difficultyForLevel(0);
    expect(state.phase).toBe("ready");
    expect(state.levelIndex).toBe(0);
    expect(state.score).toBe(0);
    expect(state.movesLeft).toBe(cfg.moveBudget);
    expect(state.scoreTarget).toBe(cfg.scoreTarget);
    expect(state.stars).toBe(0);
    expect(state.won).toBe(false);
  });

  it("initializes an arbitrary level with that level's config", () => {
    const state = initRun(5);
    const cfg = difficultyForLevel(5);
    expect(state.levelIndex).toBe(5);
    expect(state.movesLeft).toBe(cfg.moveBudget);
    expect(state.scoreTarget).toBe(cfg.scoreTarget);
  });
});

describe("runReducer — start", () => {
  it("enters 'playing' and loads scoreTarget + moveBudget as movesLeft", () => {
    const ready = initRun(2);
    const started = runReducer(ready, { type: "start", levelIndex: 2 });
    const cfg = difficultyForLevel(2);
    expect(started.phase).toBe("playing");
    expect(started.levelIndex).toBe(2);
    expect(started.score).toBe(0);
    expect(started.movesLeft).toBe(cfg.moveBudget);
    expect(started.scoreTarget).toBe(cfg.scoreTarget);
  });
});

describe("runReducer — score", () => {
  it("accumulates score without winning when below target", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const next = runReducer(state, { type: "score", delta: 50 });
    expect(next.phase).toBe("playing");
    expect(next.score).toBe(50);
    expect(next.won).toBe(false);
  });

  it("wins when score reaches the target, with sensible stars", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const target = state.scoreTarget;
    const won = runReducer(state, { type: "score", delta: target, movesSpent: 1 });
    expect(won.phase).toBe("won");
    expect(won.won).toBe(true);
    expect(won.stars).toBeGreaterThanOrEqual(1);
    expect(won.stars).toBeLessThanOrEqual(3);
  });

  it("awards 3 stars for a win with most moves remaining", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const won = runReducer(state, { type: "score", delta: state.scoreTarget, movesSpent: 1 });
    expect(won.stars).toBe(3);
  });

  it("awards fewer stars for a win with few moves remaining", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const almostOutOfMoves = state.movesLeft - 1;
    const won = runReducer(state, {
      type: "score",
      delta: state.scoreTarget,
      movesSpent: almostOutOfMoves,
    });
    expect(won.stars).toBe(1);
  });

  it("loses when moves are spent to 0 without reaching the target", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const lost = runReducer(state, {
      type: "score",
      delta: 1,
      movesSpent: state.movesLeft,
    });
    expect(lost.phase).toBe("lost");
    expect(lost.won).toBe(false);
    expect(lost.movesLeft).toBe(0);
  });

  it("is a no-op when the run is not 'playing'", () => {
    const ready = initRun(0);
    const unchanged = runReducer(ready, { type: "score", delta: 100 });
    expect(unchanged).toEqual(ready);
  });
});

describe("runReducer — spend-move", () => {
  it("decrements movesLeft while playing", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const next = runReducer(state, { type: "spend-move" });
    expect(next.movesLeft).toBe(state.movesLeft - 1);
    expect(next.phase).toBe("playing");
  });

  it("loses when movesLeft hits 0 and score is below target", () => {
    let state: RunState = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const totalMoves = state.movesLeft;
    for (let i = 0; i < totalMoves; i++) {
      state = runReducer(state, { type: "spend-move" });
    }
    expect(state.phase).toBe("lost");
    expect(state.movesLeft).toBe(0);
    expect(state.won).toBe(false);
  });

  it("is a no-op when the run is not 'playing'", () => {
    const ready = initRun(0);
    const unchanged = runReducer(ready, { type: "spend-move" });
    expect(unchanged).toEqual(ready);
  });
});

describe("runReducer — advance", () => {
  it("moves from 'won' to the next level 'ready'", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const won = runReducer(state, { type: "score", delta: state.scoreTarget });
    const advanced = runReducer(won, { type: "advance" });
    const cfg = difficultyForLevel(1);
    expect(advanced.phase).toBe("ready");
    expect(advanced.levelIndex).toBe(1);
    expect(advanced.movesLeft).toBe(cfg.moveBudget);
    expect(advanced.scoreTarget).toBe(cfg.scoreTarget);
  });

  it("clamps at the last level", () => {
    const lastIndex = totalLevels() - 1;
    const state = runReducer(initRun(lastIndex), { type: "start", levelIndex: lastIndex });
    const won = runReducer(state, { type: "score", delta: state.scoreTarget });
    const advanced = runReducer(won, { type: "advance" });
    expect(advanced.levelIndex).toBe(lastIndex);
    expect(advanced.phase).toBe("ready");
  });

  it("is a no-op when the run has not been won", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const unchanged = runReducer(state, { type: "advance" });
    expect(unchanged).toEqual(state);
  });
});

describe("runReducer — retry", () => {
  it("resets a lost run to 'ready' on the same level", () => {
    let state: RunState = runReducer(initRun(3), { type: "start", levelIndex: 3 });
    const totalMoves = state.movesLeft;
    for (let i = 0; i < totalMoves; i++) {
      state = runReducer(state, { type: "spend-move" });
    }
    expect(state.phase).toBe("lost");
    const retried = runReducer(state, { type: "retry" });
    expect(retried.phase).toBe("ready");
    expect(retried.levelIndex).toBe(3);
    expect(retried.score).toBe(0);
  });

  it("resets a won run to 'ready' on the same level", () => {
    const state = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    const won = runReducer(state, { type: "score", delta: state.scoreTarget });
    const retried = runReducer(won, { type: "retry" });
    expect(retried.phase).toBe("ready");
    expect(retried.levelIndex).toBe(0);
    expect(retried.won).toBe(false);
  });

  it("is a no-op when the run is 'ready' or 'playing'", () => {
    const ready = initRun(0);
    expect(runReducer(ready, { type: "retry" })).toEqual(ready);

    const playing = runReducer(ready, { type: "start", levelIndex: 0 });
    expect(runReducer(playing, { type: "retry" })).toEqual(playing);
  });
});

describe("runReducer — determinism", () => {
  it("same (state, action, params) always yields the same next state", () => {
    const state = runReducer(initRun(1), { type: "start", levelIndex: 1 });
    const action = { type: "score" as const, delta: 10, movesSpent: 1 };
    const a = runReducer(state, action);
    const b = runReducer(state, action);
    expect(a).toEqual(b);
  });
});
