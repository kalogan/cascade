/**
 * NPC reasoning — the MOCK providers (deterministic, NO network, ZOD-FREE).
 *
 * Two flavours, both `ReasoningProvider`s that a game can drop straight into
 * `createNpcBrain` (which now auto-wraps a raw provider in the budget firewall):
 *
 *   • `createMockProvider(lines)` — CONTENT-BLIND: cycles a small set of canned lines by
 *     the turn count so a conversation feels alive without a backend. Deterministic (the
 *     index is the transcript length, never a clock/RNG). Good for a placeholder NPC.
 *
 *   • `createSelectorMockProvider(select, opts)` — CONTENT-AWARE: calls YOUR `select`
 *     function with the player's actual message + context and speaks the line it returns.
 *     This is the fix for the "split brain" GYRE hit — SCRIPTED reactivity (keyword →
 *     branch) now lives INSIDE the provider seam, so a game branches THROUGH the brain
 *     (one memory, one path) instead of layering a second reply-picker AROUND it.
 *
 * CLIENT-SAFE. Neither mock imports the zod schema: they build their `say` intent through
 * the trusted-intent builder (`./trustedIntent.ts`), which applies the same length cap the
 * firewall would but with plain string math. A client that uses only the mock + brain
 * therefore never bundles zod (import from `game-kit/npc/runtime` — see `./runtime.ts`).
 * The firewall still guards the REAL (untrusted-LLM) provider path unchanged.
 */

import { buildSayIntents } from './trustedIntent.js';
import type { ReasoningRequest, ReasoningResponse } from './schema.js';
import type { ReasoningProvider } from './provider.js';

const DEFAULT_LINES: readonly string[] = [
  'Well met, traveler. The trail has been quiet today.',
  'Mind the frost — it nips the young shoots something fierce.',
  'Stay a while. The kettle is nearly on.',
  'Aye, a few have passed this way. None so weary as you, mind.',
];

/**
 * Create a deterministic, network-free, CONTENT-BLIND provider. `respond` cycles `lines`
 * by the number of turns already spoken; `complete` returns a fixed JSON decision so a
 * consumer that firewalls it gets a valid (not dropped) value. Zod-free.
 */
export function createMockProvider(
  lines: readonly string[] = DEFAULT_LINES,
): ReasoningProvider {
  return {
    name: 'mock',

    async respond(req: ReasoningRequest): Promise<ReasoningResponse> {
      const idx = lines.length === 0 ? 0 : req.history.length % lines.length;
      const text = lines[idx] ?? 'Hm.';
      // Trusted string (an authored line) → zod-free build; same cap the firewall applies.
      return { intents: buildSayIntents(text) };
    },

    async complete(): Promise<string> {
      return JSON.stringify({ kind: 'report', note: 'mock-decision' });
    },
  };
}

/** The context a selector reads besides the player's raw message. Mirrors the request. */
export interface SelectorContext {
  /** The NPC's display name (from the request). */
  npcName: string;
  /** The transcript so far (oldest → newest), EXCLUDING the current player message. */
  history: ReasoningRequest['history'];
  /** The rolled-up relational memory summary, if any. */
  memorySummary: string | undefined;
  /** The full underlying request, for a selector that wants persona/goals too. */
  request: ReasoningRequest;
}

/**
 * Pick the NPC's next line from the player's actual message (+ context). Return the line
 * to speak, or an empty string / `undefined` to say NOTHING this turn — which, once wrapped
 * by the brain's budget firewall, degrades to the NPC's authored `fallbackLines` exactly
 * like a real provider that returned no intents. Pure + synchronous by contract.
 */
export type LineSelector = (
  playerMessage: string,
  ctx: SelectorContext,
) => string | undefined;

/** Options for {@link createSelectorMockProvider}. */
export interface SelectorMockOptions {
  /** Diagnostics/telemetry name. Default `'selector-mock'`. */
  name?: string;
  /**
   * The decision string `complete` returns (for the low-level agent-decision path). Default
   * a fixed mock JSON so a consumer that firewalls it gets a valid value.
   */
  completeDecision?: string;
}

/**
 * Create a CONTENT-AWARE mock: it reads the player's message through your `select` and
 * speaks the chosen line. This moves scripted reactivity INSIDE the provider seam — a game
 * that used to keyword-branch outside the brain (GYRE's Will-detection "split brain") can
 * now branch here, so every reply flows through `brain.say` and shares its ONE memory.
 *
 * Zod-free and network-free, so it's safe in the browser (import via `game-kit/npc/runtime`).
 * Wire it straight into `createNpcBrain` — the brain auto-wraps a raw provider in the budget
 * firewall, so an empty selection still degrades to the NPC's `fallbackLines`.
 */
export function createSelectorMockProvider(
  select: LineSelector,
  opts: SelectorMockOptions = {},
): ReasoningProvider {
  const name = opts.name ?? 'selector-mock';
  const decision = opts.completeDecision ?? JSON.stringify({ kind: 'report', note: 'mock-decision' });
  return {
    name,

    async respond(req: ReasoningRequest): Promise<ReasoningResponse> {
      const chosen = select(req.playerMessage, {
        npcName: req.npcName,
        history: req.history,
        memorySummary: req.memorySummary,
        request: req,
      });
      // A trusted, game-selected line → zod-free build. Empty/undefined ⇒ no intents, which
      // the budget wrapper turns into the scripted fallback (the NPC always speaks).
      return { intents: buildSayIntents(chosen ?? '') };
    },

    async complete(): Promise<string> {
      return decision;
    },
  };
}
