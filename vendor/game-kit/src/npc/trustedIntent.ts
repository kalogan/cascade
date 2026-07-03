/**
 * NPC reasoning — the ZOD-FREE trusted-intent builder (the client-safe seam).
 *
 * WHY THIS EXISTS. The firewall (`parseReasoningResponse` in `./schema.ts`) is the
 * security boundary for UNTRUSTED model output — malformed JSON, oversized text, an
 * unknown `kind`. Enforcing that boundary requires zod, and zod is ~heavy: importing it
 * into a browser bundle cost GYRE ~557KB when all it used was the offline mock + brain.
 *
 * But the MOCK / SELECTOR / SCRIPTED-FALLBACK paths never touch untrusted model output.
 * They emit strings the GAME AUTHORED (canned lines, a selector's chosen line, the NPC's
 * `fallbackLines`). Those are trusted by construction, so they don't need the zod
 * validator — only the same length cap the real firewall would apply, so a trusted path
 * and the validated path produce byte-identical `say` intents.
 *
 * This module reproduces JUST that cap with plain string math and NO zod import. Every
 * client-side value module (mock, selector-mock, budgeted fallback, brain) can therefore
 * build intents through here and stay zod-free; only the real (untrusted-LLM) provider
 * path keeps importing `parseReasoningResponse` and paying for zod. See `./runtime.ts`
 * for the client entry that bundles this path without the schema.
 */

import type { NpcIntent } from './schema.js';

/**
 * Max characters for a spoken / `recall` line. MUST stay in lock-step with
 * `MAX_INTENT_TEXT` in `./schema.ts` — the whole point is that a trusted `say` and a
 * firewalled `say` cap identically. Duplicated (not imported) so this file pulls in ZERO
 * zod; a guard test asserts the two constants agree.
 */
export const TRUSTED_MAX_INTENT_TEXT = 600;

/**
 * Build the `say` intents for a TRUSTED string (an authored/selected/fallback line) —
 * the zod-free equivalent of `parseReasoningResponse({ intents: [{ kind: 'say', text }] })`
 * for a string the game itself produced.
 *
 * Contract, matched to the firewall so trusted and validated paths agree:
 *   • empty / whitespace-only text ⇒ `[]` (nothing to say), exactly like the firewall
 *     drops a `say` with `text.min(1)`;
 *   • otherwise ⇒ a single `say`, `text` trimmed of trailing overflow to the cap.
 *
 * Because the input is trusted there is no JSON parse, no shape validation, no drop-loop:
 * just the length cap. That is the only firewall behaviour that is meaningful for a string
 * we authored, and it's why this path needs no zod.
 */
export function buildSayIntents(text: string): NpcIntent[] {
  const capped = capIntentText(text);
  if (capped.length === 0) return [];
  return [{ kind: 'say', text: capped }];
}

/** Trim a trusted line to the intent-text cap (no-op when already within bounds). */
export function capIntentText(text: string): string {
  const t = text.trim();
  return t.length > TRUSTED_MAX_INTENT_TEXT ? t.slice(0, TRUSTED_MAX_INTENT_TEXT).trim() : t;
}
