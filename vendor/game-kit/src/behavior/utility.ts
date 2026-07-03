/**
 * Utility-AI action selection (Track B4).
 *
 * The deterministic "what should this NPC do now?" layer: score a set of candidate actions
 * against a game-supplied context and pick the best. Generic over the context type `C` and
 * the action payload `A`, so a game defines its own actions (idle / wander / patrol /
 * goToStation / interact / flee) and their scoring; the kit owns the selection rule.
 *
 * Pure + deterministic: selection is a function of the scores. Stable tie-break (declaration
 * order) so equal scores never flip frame-to-frame. No clock, no RNG.
 */

export interface UtilityAction<C, A = unknown> {
  /** A stable id for diagnostics. */
  name: string;
  /** Desirability of this action in context `ctx`; higher wins. ≤ 0 ⇒ never chosen. */
  score: (ctx: C) => number;
  /** Optional payload returned alongside the choice (e.g. a target, a station id). */
  payload?: A;
}

export interface UtilityChoice<C, A = unknown> {
  action: UtilityAction<C, A>;
  score: number;
}

export interface UtilitySelector<C, A = unknown> {
  /** Pick the highest-scoring action with score > 0, or null if none qualifies. */
  select(ctx: C): UtilityChoice<C, A> | null;
  /** All actions scored for `ctx`, in declaration order (for debugging/inspection). */
  scoreAll(ctx: C): UtilityChoice<C, A>[];
}

export interface UtilitySelectorOptions {
  /**
   * Hysteresis: the bonus added to the CURRENTLY-selected action's score so the NPC doesn't
   * flip-flop between near-equal options. 0 disables (pure argmax). Default 0.
   */
  stickiness?: number;
}

export function createUtilitySelector<C, A = unknown>(
  actions: ReadonlyArray<UtilityAction<C, A>>,
  opts: UtilitySelectorOptions = {},
): UtilitySelector<C, A> {
  const stickiness = opts.stickiness ?? 0;
  let current: string | null = null;

  function scoreAll(ctx: C): UtilityChoice<C, A>[] {
    return actions.map((action) => ({ action, score: action.score(ctx) }));
  }

  return {
    scoreAll,
    select(ctx: C): UtilityChoice<C, A> | null {
      let best: UtilityChoice<C, A> | null = null;
      for (const action of actions) {
        let score = action.score(ctx);
        if (stickiness > 0 && action.name === current) score += stickiness;
        // Strictly-greater keeps the FIRST of equal scores (stable tie-break).
        if (score > 0 && (best === null || score > best.score)) {
          best = { action, score };
        }
      }
      current = best ? best.action.name : null;
      return best;
    },
  };
}
