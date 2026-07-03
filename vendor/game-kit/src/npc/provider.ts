/**
 * NPC reasoning — the provider-agnostic SEAM.
 *
 * A `ReasoningProvider` is the swappable adapter to a cognition backend (Grok / any
 * OpenAI-compatible API, a mock, or your own). The game talks to the brain ONLY
 * through this interface; the vendor choice never leaks into game logic.
 *
 * SERVER-SIDE: a real provider makes network calls and holds an API key. Keep it on
 * your server — never import a keyed provider into client/browser code.
 */

import type { ReasoningRequest, ReasoningResponse } from './schema.js';

export interface ReasoningProvider {
  /** A stable name for diagnostics/telemetry (e.g. 'grok', 'mock'). */
  readonly name: string;
  /**
   * Reason over the request and return validated intents. MUST resolve (it may return
   * an empty `intents` rather than reject for "nothing to say"); a thrown error /
   * timeout is the caller's signal to scripted-fall-back. An optional `AbortSignal`
   * lets the budget wrapper enforce a per-interaction timeout.
   */
  respond(req: ReasoningRequest, signal?: AbortSignal): Promise<ReasoningResponse>;

  /**
   * LOW-LEVEL text completion for AGENT DECISIONS (a playtest bot, a companion banter
   * line), distinct from the NPC-conversation `respond`. Returns the model's raw
   * completion text; the CALLER is responsible for firewalling it. Makes no safety
   * promise about content, only that it resolves to a string (or throws on
   * error/timeout/no-key, which the budget wrapper turns into a safe default).
   */
  complete(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string>;
}
