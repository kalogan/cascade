/**
 * NPC reasoning — the BRAIN (the orchestration the game calls).
 *
 * `createNpcBrain` wires the pieces: for a free-text player line it loads memory, builds
 * the request, runs the budgeted provider (which firewalls + scripted-falls-back), applies
 * the validated intents in order, and writes the exchange back to the store. `say` NEVER
 * rejects — any failure degrades to the NPC's scripted fallback line.
 *
 * SERVER-SIDE: holds the (keyed) provider. Never construct this in the browser.
 */

import type { ReasoningPersona, NpcIntent } from './schema.js';
import type { ReasoningProvider } from './provider.js';
import {
  toBudgetedProvider,
  type BudgetedProvider,
  type BudgetedProviderOptions,
} from './budgetedProvider.js';
import {
  appendTurnToRecord,
  buildMemoryView,
  emptyNpcMemory,
  noteRecall,
  type NpcMemoryRecord,
  type NpcMemoryStore,
} from './memory.js';
import { consolidateMemory, type Summarizer } from './summarizer.js';
import { selectRelevantTurns, type Embedder, type RecallOptions } from './embedder.js';

/** The reasoning info the game resolves for an NPC the player is talking to. */
export interface NpcInfo {
  name: string;
  persona: ReasoningPersona;
  /** Authored scripted lines — the classic-safe / graceful-degrade output. */
  fallbackLines: readonly string[];
  /** Retention window (days) for the episodic memory; 0 = no age limit. Default 0. */
  retentionDays?: number;
}

/** The context for a free-text say: who's asking, the NPC, and what they said. */
export interface NpcSayContext {
  npcId: string;
  /** Stable per-player key (e.g. sessionId) — for the per-player budget. */
  playerKey: string;
  /** Durable memory key; absent ⇒ ephemeral no-memory turn (still reasons). */
  characterId?: string;
  /** The free-text line the player typed. */
  text: string;
}

/** The brain's verdict for a free-text say. */
export interface NpcSayResult {
  /** The NPC's display name (echoed so the client renders the speaker). */
  name: string;
  /** The single line the NPC speaks back (already firewalled + length-capped). */
  text: string;
  /** Whether the brain ended the conversation this turn (`endConversation` intent). */
  end: boolean;
  /** Where the words came from — a live model reply or the scripted fallback. */
  source: 'llm' | 'scripted';
  /** Optional mood the brain nudged (cosmetic; advisory `setMood` intent). */
  mood?: string;
}

export interface NpcBrainDeps {
  /**
   * The reasoning provider seam. Pass EITHER a raw {@link ReasoningProvider} (e.g.
   * `createMockProvider(...)`, `createSelectorMockProvider(...)`, or a keyed provider) OR an
   * already-{@link BudgetedProvider}. A raw provider is AUTO-WRAPPED once in the budget +
   * timeout + scripted-fallback firewall — so a mock "just works" without the caller
   * hand-wrapping in `createBudgetedProvider`. Tune the auto-wrap with {@link NpcBrainDeps.budget}.
   */
  provider: ReasoningProvider | BudgetedProvider;
  /**
   * OPTIONAL budget/timeout options for the auto-wrap, used ONLY when `provider` is a raw
   * provider (ignored when it's already budgeted — you chose the options when you wrapped it).
   */
  budget?: BudgetedProviderOptions;
  /** The durable memory store (ship your own; `createInMemoryNpcStore` for dev/tests). */
  store: NpcMemoryStore;
  /** Resolve an NPC's reasoning info (persona + name + fallback + retention), or undefined. */
  getNpcInfo: (npcId: string) => NpcInfo | undefined;
  /**
   * OPTIONAL rolling summarizer. When set, after each remembered exchange the episodic log
   * is consolidated: turns past `consolidateKeepRecent` are folded into the relational
   * summary. Omit to keep the verbatim-only memory behaviour.
   */
  summarizer?: Summarizer;
  /** Keep this many recent turns verbatim before summarizing the rest. Default 16. */
  consolidateKeepRecent?: number;
  /**
   * OPTIONAL embedder for SEMANTIC recall (Track A3). When set, the brain embeds each turn
   * on write and the player message on read, then feeds the model the most RELEVANT past
   * turns (by cosine) plus a few recent — instead of recency only. Omit for recency-only.
   */
  embedder?: Embedder;
  /** Tuning for semantic recall (top-k relevant + n recent). Used only with `embedder`. */
  recall?: RecallOptions;
  /** Injected clock for memory timestamps (testability). Default Date.now. */
  now?: () => number;
}

export interface NpcBrain {
  /** True when this NPC has a persona (the game should route free-text here). */
  isReasoningCapable(npcId: string): boolean;
  /**
   * Resolve a free-text player line: load memory, run the budgeted provider, apply the
   * firewalled intents (say/setMood/wait/endConversation/recall), and write the exchange
   * to memory. NEVER rejects — any failure degrades to the scripted fallback. Returns null
   * only when the NPC isn't reasoning-capable or the player line is empty.
   */
  say(ctx: NpcSayContext): Promise<NpcSayResult | null>;
}

export function createNpcBrain(deps: NpcBrainDeps): NpcBrain {
  const now = deps.now ?? Date.now;
  // Accept a raw OR already-budgeted provider — wrap once (idempotent) so the rest of the
  // brain always talks to the budget firewall. This is the ergonomics fix: a mock provider
  // can be passed straight in without the caller hand-wrapping it.
  const provider = toBudgetedProvider(deps.provider, deps.budget ?? {});

  return {
    isReasoningCapable(npcId: string): boolean {
      return deps.getNpcInfo(npcId) !== undefined;
    },

    async say(ctx: NpcSayContext): Promise<NpcSayResult | null> {
      const info = deps.getNpcInfo(ctx.npcId);
      if (!info) return null;

      const playerText = ctx.text.trim();
      if (playerText.length === 0) return null;

      const memoryKey = ctx.characterId;
      const retentionDays = info.retentionDays ?? 0;

      // Load memory (durable + per-character); absent characterId ⇒ ephemeral no-memory.
      let record: NpcMemoryRecord;
      try {
        record = memoryKey ? await deps.store.load(ctx.npcId, memoryKey) : emptyNpcMemory();
      } catch {
        record = emptyNpcMemory();
      }

      const view = buildMemoryView(record);

      // Embed the player message for semantic recall (Track A3) — best-effort.
      let queryEmbedding: number[] | undefined;
      if (deps.embedder) {
        try {
          queryEmbedding = await deps.embedder.embed(playerText);
        } catch {
          queryEmbedding = undefined;
        }
      }
      // With an embedding, feed the model the most RELEVANT past turns (+ recent); else recency.
      const history = queryEmbedding
        ? selectRelevantTurns(record.episodic, queryEmbedding, deps.recall ?? {}).map((t) => ({
            role: t.role,
            text: t.text,
          }))
        : view.history;

      // Run the budgeted provider (firewalls + scripted-falls-back; never throws).
      let intents: NpcIntent[];
      try {
        const res = await provider.respond(
          {
            npcName: info.name,
            persona: info.persona,
            playerMessage: playerText,
            history,
            memorySummary: view.memorySummary,
          },
          { playerKey: ctx.playerKey, fallbackLines: info.fallbackLines },
        );
        intents = res.intents;
      } catch {
        intents = [];
      }

      // Apply the FIREWALLED intents in order (fixed vocabulary).
      let text = '';
      let end = false;
      let mood: string | undefined;
      let workingRecord = record;
      for (const intent of intents) {
        switch (intent.kind) {
          case 'say':
            text = text.length === 0 ? intent.text : `${text} ${intent.text}`;
            break;
          case 'setMood':
            mood = intent.mood;
            break;
          case 'endConversation':
            end = true;
            break;
          case 'recall':
            workingRecord = noteRecall(workingRecord, intent.note);
            break;
          case 'wait':
            break;
        }
      }

      // If the brain said nothing (only wait/recall, or no intents), speak the scripted beat.
      const scripted = (info.fallbackLines[0] ?? '').trim();
      let source: 'llm' | 'scripted' = 'llm';
      if (text.length === 0) {
        text = scripted.length > 0 ? scripted : '...';
        source = 'scripted';
      } else if (scripted.length > 0 && text === scripted) {
        // The budget wrapper degraded to the authored line → mark it scripted (honest badge).
        source = 'scripted';
      }

      // Write the exchange through to memory (durable). Best-effort: never breaks the reply.
      if (memoryKey) {
        try {
          // Embed the NPC reply too (best-effort) so future turns can recall this exchange.
          let npcEmbedding: number[] | undefined;
          if (deps.embedder) {
            try {
              npcEmbedding = await deps.embedder.embed(text);
            } catch {
              npcEmbedding = undefined;
            }
          }
          let next = appendTurnToRecord(workingRecord, playerText, text, retentionDays, now(), {
            player: queryEmbedding,
            npc: npcEmbedding,
          });
          // Roll the oldest turns into the summary once the log overflows (if configured).
          if (deps.summarizer) {
            next = await consolidateMemory(next, deps.summarizer, {
              keepRecent: deps.consolidateKeepRecent ?? 16,
            });
          }
          await deps.store.save(ctx.npcId, memoryKey, next);
        } catch {
          // Memory is best-effort — a failed write never breaks the reply.
        }
      }

      return {
        name: info.name,
        text,
        end,
        source,
        ...(mood !== undefined ? { mood } : {}),
      };
    },
  };
}

// ── Companion event-banter ────────────────────────────────────────────────

/** The max length (chars) of a companion banter line (a floating bubble — keep it short). */
const COMPANION_BANTER_MAX_CHARS = 120;

/** The persona + event a companion banter line is composed from. */
export interface CompanionBanterInput {
  /** The companion's display name. */
  name: string;
  /** The companion's persona character sheet (role / voice / goals). */
  persona: ReasoningPersona;
  /** A one-line description of the gameplay event that triggered the line. */
  eventDescription: string;
  /** Stable per-player key (the owner) — for the provider's per-"player" budget. */
  playerKey: string;
}

/**
 * Compose ONE short, in-character companion banter line via the budgeted provider, or null
 * on any failure / over-budget / empty output (the caller then stays silent). Fire-and-forget.
 */
export async function composeCompanionBanter(
  provider: BudgetedProvider,
  input: CompanionBanterInput,
): Promise<string | null> {
  const goals =
    input.persona.goals.length > 0 ? input.persona.goals.join('; ') : 'help your companion';
  const systemPrompt =
    `You are ${input.name}, ${input.persona.role}. Voice: ${input.persona.voice}. ` +
    `You care about: ${goals}. ` +
    `Speak ONE short in-character line (no quotes, no narration, under ${COMPANION_BANTER_MAX_CHARS} characters) ` +
    `reacting to what just happened. Stay in the game world; do not break character.`;
  const userPrompt = `What just happened: ${input.eventDescription}\nYour one-line reaction:`;

  let text: string;
  try {
    text = await provider.complete(systemPrompt, userPrompt, {
      playerKey: input.playerKey,
      safeDefault: '',
    });
  } catch {
    return null;
  }

  const line = text.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  if (line.length === 0) return null;
  return line.length > COMPANION_BANTER_MAX_CHARS
    ? line.slice(0, COMPANION_BANTER_MAX_CHARS).trim()
    : line;
}
