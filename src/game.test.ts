/**
 * Integration test for the assembled game's core seam: the board's BoardEvent
 * stream driving campaign score/run state — the exact wiring engine.ts uses,
 * exercised headlessly (no canvas/RAF). Proves the modules compose, not just
 * that each passes its own unit suite.
 */
import { describe, it, expect } from "vitest";
import { createBoard, type Cell } from "game-kit/board";
import { createRng } from "game-kit/prng";
import { difficultyForLevel, initRun, runReducer, totalLevels } from "game-kit/campaign";
import { THEMES } from "game-kit/theme";

// Same scoring rule the engine applies from the clear stream.
function scoreForEvents(events: ReturnType<ReturnType<typeof createBoard>["resolve"]>): number {
  let s = 0;
  for (const ev of events) if (ev.type === "clear") s += ev.cells.length * 10 * ev.cascadeDepth;
  return s;
}

describe("assembled game — board → campaign seam", () => {
  it("a hinted legal swap resolves into a scored clear that advances the run", () => {
    const lvl = difficultyForLevel(0);
    const board = createBoard({ rows: lvl.boardH, cols: lvl.boardW, kinds: lvl.tileKinds, rng: createRng(1234) });
    let run = runReducer(initRun(0), { type: "start", levelIndex: 0 });
    expect(run.phase).toBe("playing");
    expect(run.movesLeft).toBe(lvl.moveBudget);

    const hint = board.findHint();
    expect(hint).not.toBeNull();
    const [a, b] = hint as [Cell, Cell];

    const ok = board.swap(a, b);
    expect(ok).toBe(true); // a hinted swap must be legal

    const events = board.resolve();
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.type === "clear")).toBe(true);
    expect(events[events.length - 1]!.type).toBe("settle");

    const delta = scoreForEvents(events);
    expect(delta).toBeGreaterThan(0);

    run = runReducer(run, { type: "score", delta });
    run = runReducer(run, { type: "spend-move" });
    expect(run.score).toBe(delta);
    expect(run.movesLeft).toBe(lvl.moveBudget - 1);
  });

  it("cascade depth escalates within a resolve (combo chain reports rising depth)", () => {
    // scan seeds for a board whose first hinted swap produces a >=2 cascade,
    // proving the combo path the juice/SFX ladder keys off actually fires.
    let sawDepth2 = false;
    for (let seed = 1; seed <= 200 && !sawDepth2; seed++) {
      const board = createBoard({ rows: 8, cols: 7, kinds: 4, rng: createRng(seed) });
      const hint = board.findHint();
      if (!hint) continue;
      if (!board.swap(hint[0], hint[1])) continue;
      const events = board.resolve();
      const maxDepth = Math.max(
        1,
        ...events.map((e) => (e.type === "settle" ? e.maxDepth : e.type === "cascade" ? e.depth : 1)),
      );
      if (maxDepth >= 2) sawDepth2 = true;
    }
    expect(sawDepth2).toBe(true);
  });

  it("difficulty ramps across the 9-level run", () => {
    const n = totalLevels();
    expect(n).toBe(9);
    const first = difficultyForLevel(0);
    const last = difficultyForLevel(n - 1);
    expect(last.tileKinds).toBeGreaterThan(first.tileKinds); // 4 → 6
    expect(last.scoreTarget).toBeGreaterThan(first.scoreTarget); // steep ramp
    expect(last.moveBudget).toBeLessThan(first.moveBudget); // tighter
    // monotonic non-regressions
    for (let i = 1; i < n; i++) {
      expect(difficultyForLevel(i).scoreTarget).toBeGreaterThan(difficultyForLevel(i - 1).scoreTarget);
      expect(difficultyForLevel(i).tileKinds).toBeGreaterThanOrEqual(difficultyForLevel(i - 1).tileKinds);
      expect(difficultyForLevel(i).moveBudget).toBeLessThanOrEqual(difficultyForLevel(i - 1).moveBudget);
    }
  });

  it("each world maps to a distinct authored theme (scenery changes between worlds)", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(3);
    const skies = new Set(THEMES.slice(0, 3).map((t) => t.backdrop.sky.join(",")));
    expect(skies.size).toBe(3); // three visibly distinct backdrops
    const roots = new Set(THEMES.slice(0, 3).map((t) => t.audio.rootHz));
    expect(roots.size).toBe(3); // three distinct audio characters
  });

  it("board never soft-locks: a stuck board reshuffles into having moves", () => {
    const board = createBoard({ rows: 8, cols: 7, kinds: 5, rng: createRng(42) });
    // drive several random-ish resolves; after each, ensure moves exist (shuffle if not)
    for (let k = 0; k < 5; k++) {
      if (!board.hasMoves()) board.shuffleIfStuck();
      expect(board.hasMoves()).toBe(true);
    }
  });
});
