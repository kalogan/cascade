/**
 * NPC memory — rolling SUMMARIZATION (Track A2).
 *
 * Today the relational summary only grows from brain `recall` notes. This adds the missing
 * leg: when the episodic log overflows, compress the OLDEST turns into the summary so the
 * NPC keeps a compact "what I remember about you" without an ever-growing transcript.
 *
 * A `Summarizer` is a seam with two shipped impls:
 *   • `createExtractiveSummarizer()` — LOCAL, deterministic, zero-cost. Pulls salient
 *     player statements (self-id, wants, facts) and folds them into the summary. No model.
 *   • `createProviderSummarizer(complete)` — model-backed, using any `complete(system, user)`
 *     (e.g. a reasoning provider's). Degrades to the previous summary on any failure.
 *
 * `consolidateMemory` ties it together: keep the most recent N turns, summarize the rest.
 */

import type { NpcMemoryRecord, NpcMemoryTurn } from './memory.js';

/** Cap the rolled-up summary (a short note, not a transcript). */
const DEFAULT_SUMMARY_CAP = 600;

/** Compress old turns into a relational summary line. Pure or model-backed. */
export interface Summarizer {
  /**
   * Fold `turns` (the overflow being dropped) into `previousSummary`, returning the new
   * summary. MUST resolve (degrade to `previousSummary` rather than reject).
   */
  summarize(turns: readonly NpcMemoryTurn[], previousSummary: string): Promise<string>;
}

export interface ExtractiveSummarizerOptions {
  /** Max length (chars) of the produced summary. Default 600. */
  maxLen?: number;
}

// Cue patterns that flag a player statement worth remembering (self-id, wants, facts).
const CUE = /\b(i am|i'm|my name|i want|i need|i seek|looking for|i have|i'm from|i am from|going to|my quest|help me|remember|i like|i hate|i fear|i live|i'll|i will)\b/i;

/** Split a turn's text into trimmed, non-empty sentences/clauses. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Pull salient PLAYER statements (the NPC learns about the player), in order. */
function extractSalient(turns: readonly NpcMemoryTurn[]): string[] {
  const out: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'player') continue;
    for (const s of sentences(turn.text)) {
      if (CUE.test(s)) out.push(s);
    }
  }
  return out;
}

/** Trim a summary to `maxLen`, keeping the NEWEST content (drop from the front). */
function capSummary(summary: string, maxLen: number): string {
  return summary.length > maxLen ? summary.slice(summary.length - maxLen) : summary;
}

/**
 * A LOCAL, deterministic summarizer: appends salient (deduped) player statements from the
 * overflow into the previous summary. No model, no network, no clock/RNG → reproducible.
 */
export function createExtractiveSummarizer(
  opts: ExtractiveSummarizerOptions = {},
): Summarizer {
  const maxLen = opts.maxLen ?? DEFAULT_SUMMARY_CAP;
  return {
    async summarize(turns, previousSummary): Promise<string> {
      let summary = previousSummary.trim();
      for (const statement of extractSalient(turns)) {
        if (summary.toLowerCase().includes(statement.toLowerCase())) continue; // dedupe
        summary = summary.length > 0 ? `${summary} ${statement}` : statement;
      }
      return capSummary(summary, maxLen);
    },
  };
}

const SUMMARY_SYSTEM_PROMPT =
  'You maintain an NPC\'s private memory of ONE traveler. Given the existing note and new ' +
  'exchanges, output an updated note: a SHORT third-person summary (one or two sentences) of ' +
  'durable facts about the traveler and your relationship. No preamble, no quotes, no markdown.';

export interface ProviderSummarizerOptions {
  /** Max length (chars) of the produced summary. Default 600. */
  maxLen?: number;
}

/**
 * A model-backed summarizer over any `complete(systemPrompt, userPrompt) => Promise<string>`
 * (e.g. a reasoning provider's `complete`). Degrades to `previousSummary` on any failure /
 * empty output, so consolidation never loses the old note.
 */
export function createProviderSummarizer(
  complete: (systemPrompt: string, userPrompt: string) => Promise<string>,
  opts: ProviderSummarizerOptions = {},
): Summarizer {
  const maxLen = opts.maxLen ?? DEFAULT_SUMMARY_CAP;
  return {
    async summarize(turns, previousSummary): Promise<string> {
      const transcript = turns
        .map((t) => `${t.role === 'player' ? 'Traveler' : 'NPC'}: ${t.text}`)
        .join('\n');
      const userPrompt =
        `Existing note: ${previousSummary.trim() || '(none)'}\n\n` +
        `New exchanges:\n${transcript}\n\nUpdated note:`;

      let text: string;
      try {
        text = await complete(SUMMARY_SYSTEM_PROMPT, userPrompt);
      } catch {
        return previousSummary;
      }
      const line = text.trim();
      if (line.length === 0) return previousSummary;
      return line.length > maxLen ? line.slice(0, maxLen) : line;
    },
  };
}

export interface ConsolidateOptions {
  /** Keep this many most-recent turns verbatim; summarize the rest. Default 16. */
  keepRecent?: number;
}

/**
 * If the episodic log exceeds `keepRecent`, summarize the overflow (the oldest turns) into
 * the relational summary and drop it from `episodic`. Returns a new record (the input is not
 * mutated). A no-op when the log is already within bounds.
 */
export async function consolidateMemory(
  record: NpcMemoryRecord,
  summarizer: Summarizer,
  opts: ConsolidateOptions = {},
): Promise<NpcMemoryRecord> {
  const keepRecent = opts.keepRecent ?? 16;
  if (record.episodic.length <= keepRecent) return record;

  const cut = record.episodic.length - keepRecent;
  const overflow = record.episodic.slice(0, cut);
  const kept = record.episodic.slice(cut);
  const summary = await summarizer.summarize(overflow, record.summary);

  return { ...record, episodic: kept, summary };
}
