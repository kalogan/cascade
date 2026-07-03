/**
 * Campaign — Match-3 difficulty curve + run state machine.
 *
 * Mirrors mmo's `progression` module (Phase 4b): a param-driven, pure curve
 * with a DEFAULT_* const, plus a pure reducer layered on top. Deterministic
 * (Constraint #1/#6) — same index always yields the same LevelConfig, same
 * (state, action) always yields the same next RunState. No Math.random,
 * Date.now, three, or DOM access anywhere in this module.
 *
 * `difficultyForLevel` is the single source of truth for how a ~15-minute,
 * 9-level run (3 worlds x 3 levels) ramps: tile kinds widen per world, move
 * budgets tighten per level, and score targets accelerate per level so world 3
 * is a genuine squeeze compared to world 1's gentle on-ramp.
 */

export interface DifficultyParams {
  worlds: number;
  levelsPerWorld: number;
  baseKinds: number;
  kindsGrowthPerWorld: number;
  maxKinds: number;
  boardW: number;
  boardH: number;
  moveBudgetBase: number;
  moveBudgetDecay: number;
  scoreTargetBase: number;
  scoreTargetGrowth: number;
  obstacleBase: number;
  obstacleGrowthPerWorld: number;
}

/**
 * Defaults tuned for a ~15-minute session across 3 worlds x 3 levels (9
 * levels total):
 *  - tileKinds: 4 -> 5 -> 6 across worlds 1/2/3 (kindsGrowthPerWorld=1,
 *    clamped at maxKinds=6) — more kinds = harder-to-spot matches.
 *  - moveBudget: 22 down to 14 (moveBudgetDecay=1/level) — a steady 1-move
 *    tightening every level so the squeeze is felt continuously, not just at
 *    world boundaries.
 *  - scoreTarget: 600 up to 2040 via a triangular-number growth curve
 *    (base + growth * index*(index+1)/2) — targets ACCELERATE per level
 *    (level-over-level increments grow), so world 1 (600/640/720) is a gentle
 *    on-ramp while world 3 (1440/1720/2040) is a real squeeze combined with
 *    fewer moves and more tile kinds.
 *  - obstacleDensity: 0 -> 0.05 -> 0.10 per world, a small nudge so later
 *    worlds add a bit of board friction without dominating the difficulty.
 *  - board is a fixed 7x8 portrait board for the whole session.
 */
export const DEFAULT_DIFFICULTY: DifficultyParams = {
  worlds: 3,
  levelsPerWorld: 3,
  baseKinds: 4,
  kindsGrowthPerWorld: 1,
  maxKinds: 6,
  boardW: 7,
  boardH: 8,
  moveBudgetBase: 22,
  moveBudgetDecay: 1,
  scoreTargetBase: 600,
  scoreTargetGrowth: 40,
  obstacleBase: 0,
  obstacleGrowthPerWorld: 0.05,
};

export interface LevelConfig {
  index: number;
  world: number;
  levelInWorld: number;
  boardW: number;
  boardH: number;
  tileKinds: number;
  moveBudget: number;
  scoreTarget: number;
  obstacleDensity: number;
}

/**
 * Pure curve: 0-based level `index` -> a fully-resolved LevelConfig. World and
 * levelInWorld are both 1-based for display (world 1..worlds,
 * levelInWorld 1..levelsPerWorld). Deterministic — same index + params always
 * produces the same config; negative/fractional indices are floored/clamped
 * to 0 rather than throwing.
 */
export function difficultyForLevel(
  index: number,
  params: DifficultyParams = DEFAULT_DIFFICULTY,
): LevelConfig {
  const idx = Math.max(0, Math.floor(index));
  const levelsPerWorld = Math.max(1, Math.floor(params.levelsPerWorld));
  const worldZeroBased = Math.floor(idx / levelsPerWorld);
  const world = worldZeroBased + 1;
  const levelInWorld = (idx % levelsPerWorld) + 1;

  const tileKinds = Math.min(
    params.maxKinds,
    params.baseKinds + params.kindsGrowthPerWorld * worldZeroBased,
  );

  const moveBudget = Math.max(
    1,
    Math.round(params.moveBudgetBase - params.moveBudgetDecay * idx),
  );

  const scoreTarget = Math.round(
    params.scoreTargetBase + (params.scoreTargetGrowth * (idx * (idx + 1))) / 2,
  );

  const obstacleDensity = Math.max(
    0,
    params.obstacleBase + params.obstacleGrowthPerWorld * worldZeroBased,
  );

  return {
    index: idx,
    world,
    levelInWorld,
    boardW: params.boardW,
    boardH: params.boardH,
    tileKinds,
    moveBudget,
    scoreTarget,
    obstacleDensity,
  };
}

/** Total level count for a full run: worlds * levelsPerWorld. */
export function totalLevels(params: DifficultyParams = DEFAULT_DIFFICULTY): number {
  return Math.max(0, Math.floor(params.worlds)) * Math.max(1, Math.floor(params.levelsPerWorld));
}

export type RunPhase = "ready" | "playing" | "won" | "lost";

export interface RunState {
  phase: RunPhase;
  levelIndex: number;
  score: number;
  movesLeft: number;
  scoreTarget: number;
  stars: number;
  won: boolean;
}

export type RunAction =
  | { type: "start"; levelIndex: number; params?: DifficultyParams }
  | { type: "score"; delta: number; movesSpent?: number }
  | { type: "spend-move" }
  | { type: "advance"; params?: DifficultyParams }
  | { type: "retry" };

/**
 * Stars (1-3) awarded on a win, scaled by the fraction of the level's original
 * move budget remaining: >=50% left -> 3 stars, >=20% left -> 2 stars,
 * otherwise 1 star. A win always earns at least 1 star.
 */
function computeStars(movesLeft: number, moveBudget: number): number {
  if (moveBudget <= 0) return 1;
  const ratio = movesLeft / moveBudget;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

/**
 * Builds a fresh 'ready' RunState for `levelIndex`, preloading that level's
 * scoreTarget and moveBudget so UI can display them before 'start' fires.
 */
export function initRun(
  levelIndex: number = 0,
  params: DifficultyParams = DEFAULT_DIFFICULTY,
): RunState {
  const idx = Math.max(0, Math.floor(levelIndex));
  const config = difficultyForLevel(idx, params);
  return {
    phase: "ready",
    levelIndex: idx,
    score: 0,
    movesLeft: config.moveBudget,
    scoreTarget: config.scoreTarget,
    stars: 0,
    won: false,
  };
}

/**
 * Pure reducer for a single campaign run. Same (state, action, params) always
 * yields the same next state — no hidden clock/RNG. Actions that don't apply
 * to the current phase (e.g. 'score' while not 'playing') are no-ops that
 * return `state` unchanged.
 */
export function runReducer(
  state: RunState,
  action: RunAction,
  params: DifficultyParams = DEFAULT_DIFFICULTY,
): RunState {
  switch (action.type) {
    case "start": {
      const effectiveParams = action.params ?? params;
      return { ...initRun(action.levelIndex, effectiveParams), phase: "playing" };
    }

    case "score": {
      if (state.phase !== "playing") return state;

      const nextScore = state.score + action.delta;
      const nextMoves = action.movesSpent
        ? Math.max(0, state.movesLeft - action.movesSpent)
        : state.movesLeft;

      if (nextScore >= state.scoreTarget) {
        const config = difficultyForLevel(state.levelIndex, params);
        const stars = computeStars(nextMoves, config.moveBudget);
        return {
          ...state,
          phase: "won",
          score: nextScore,
          movesLeft: nextMoves,
          stars,
          won: true,
        };
      }

      if (nextMoves <= 0) {
        return { ...state, phase: "lost", score: nextScore, movesLeft: 0, won: false };
      }

      return { ...state, score: nextScore, movesLeft: nextMoves };
    }

    case "spend-move": {
      if (state.phase !== "playing") return state;

      const nextMoves = Math.max(0, state.movesLeft - 1);
      if (nextMoves <= 0 && state.score < state.scoreTarget) {
        return { ...state, movesLeft: 0, phase: "lost", won: false };
      }
      return { ...state, movesLeft: nextMoves };
    }

    case "advance": {
      if (state.phase !== "won") return state;

      const effectiveParams = action.params ?? params;
      const total = totalLevels(effectiveParams);
      const nextIndex = Math.min(state.levelIndex + 1, Math.max(0, total - 1));
      return initRun(nextIndex, effectiveParams);
    }

    case "retry": {
      if (state.phase !== "won" && state.phase !== "lost") return state;
      return initRun(state.levelIndex, params);
    }

    default:
      return state;
  }
}
