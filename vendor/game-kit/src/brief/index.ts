/**
 * Design-brief generator — the UPSTREAM of the scaffolder.
 *
 * Turns a one-line game idea into a structured, buildable `DesignBrief` by prompting a model
 * with an ARCHITECT persona (identify the core loop, cut to a few pillars, name the first
 * disjoint slice, flag risks, recommend which kit systems the build needs). The brief is
 * machine-consumable: `briefToScaffoldPicks` maps it straight into scaffolder picks, so the
 * flow is idea → brief → runnable starter.
 *
 * Provider-agnostic + dependency-light: `generateDesignBrief` takes an injected
 * `complete(system, user) => string` — the host wires the real model (e.g. Anthropic). No
 * network, no key here. The only dep is zod (scoped to this entry, like npc). `parseDesignBrief`
 * is the firewall: a tolerant parse with sensible defaults that never throws on a slightly-off
 * model reply.
 */

import { z } from 'zod';

export type BriefTarget = 'r3f' | 'vanilla';

const BriefTargetEnum = z.enum(['r3f', 'vanilla']);

export const DesignBriefNpcSchema = z.object({
  name: z.string().default(''),
  role: z.string().default(''),
  persona: z.string().default(''),
});
export type DesignBriefNpc = z.infer<typeof DesignBriefNpcSchema>;

export const ArtDirectionSchema = z.object({
  palette: z.array(z.string()).default([]),
  mood: z.string().default(''),
  references: z.array(z.string()).default([]),
});

/** The structured brief. Lenient (defaults everywhere) so a near-miss model reply still parses. */
export const DesignBriefSchema = z.object({
  title: z.string().default('Untitled Game'),
  logline: z.string().default(''),
  genre: z.string().default(''),
  perspective: z.string().default(''),
  /** Recommended starter target for the scaffolder. */
  target: BriefTargetEnum.default('r3f'),
  /** 2–4 design pillars — the scope fence. */
  pillars: z.array(z.string()).default([]),
  /** The moment-to-moment core loop. */
  coreLoop: z.string().default(''),
  /** Kit system ids the build needs (from the provided list). Feeds the scaffolder. */
  systems: z.array(z.string()).default([]),
  /** Reasoning NPCs the game wants, if any. */
  npcs: z.array(DesignBriefNpcSchema).default([]),
  artDirection: ArtDirectionSchema.default({ palette: [], mood: '', references: [] }),
  /** Honest risks / things to cut. */
  risks: z.array(z.string()).default([]),
  /** The FIRST disjoint, independently-shippable slice to build. */
  firstSlice: z.string().default(''),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/** A kit system the architect may reference by id (so `systems` uses real ids). */
export interface BriefSystemRef {
  id: string;
  name: string;
}

export interface BriefInput {
  /** The one-line (or short) game idea. */
  idea: string;
  /** The kit systems available to recommend — their ids are what `systems` should use. */
  availableSystems?: BriefSystemRef[];
  /** Optional extra constraints / answers to clarifying questions. */
  notes?: string;
}

export const ARCHITECT_SYSTEM_PROMPT = [
  'You are a senior game-design architect and principal engineer. Given a short game idea,',
  'produce a TIGHT, BUILDABLE design brief — not a wishlist.',
  'Work like this: find the core loop first; cut scope to 2–4 pillars; name the FIRST disjoint,',
  'independently-shippable slice; flag risks honestly (including what to cut); and recommend',
  'ONLY the reusable systems the build actually needs, using the provided system ids.',
  'Prefer the smallest thing that proves the fun. Do not invent systems that are not listed.',
  'OUTPUT: a single STRICT JSON object, no prose, no markdown fences, matching exactly:',
  '{ "title": str, "logline": str, "genre": str, "perspective": str,',
  '  "target": "r3f" | "vanilla", "pillars": [str], "coreLoop": str,',
  '  "systems": [str (ids from the provided list)], "npcs": [{"name":str,"role":str,"persona":str}],',
  '  "artDirection": {"palette":[str],"mood":str,"references":[str]},',
  '  "risks": [str], "firstSlice": str }',
].join('\n');

/** Render the user prompt: the idea + the available system ids the model should choose from. */
export function buildBriefUserPrompt(input: BriefInput): string {
  const lines: string[] = [];
  lines.push(`Game idea: ${input.idea}`);
  if (input.notes && input.notes.trim().length > 0) {
    lines.push(`Extra constraints: ${input.notes.trim()}`);
  }
  if (input.availableSystems && input.availableSystems.length > 0) {
    lines.push('');
    lines.push('Available kit systems (use these ids in "systems"):');
    for (const s of input.availableSystems) lines.push(`- ${s.id} (${s.name})`);
  }
  lines.push('');
  lines.push('Return the JSON brief only.');
  return lines.join('\n');
}

/** Strip a leading ```json / ``` fence if the model wrapped its JSON. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
}

/**
 * Firewall: parse a raw model reply into a `DesignBrief`. Tolerant — accepts a JSON string
 * (fenced ok) or a parsed value, fills defaults for missing fields, and returns null only when
 * the input is not an object / not parseable. Never throws.
 */
export function parseDesignBrief(raw: unknown): DesignBrief | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    const text = stripCodeFence(value);
    if (text.length === 0) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = DesignBriefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Generate a design brief: prompt the injected `complete` with the architect persona, then
 * firewall the reply. Returns null on any failure (no key/throw/garbage) so the caller can
 * offer hand-authoring.
 */
export async function generateDesignBrief(
  complete: (systemPrompt: string, userPrompt: string) => Promise<string>,
  input: BriefInput,
): Promise<DesignBrief | null> {
  let raw: string;
  try {
    raw = await complete(ARCHITECT_SYSTEM_PROMPT, buildBriefUserPrompt(input));
  } catch {
    return null;
  }
  return parseDesignBrief(raw);
}

export interface ScaffoldPicks {
  name: string;
  target: BriefTarget;
  systemIds: string[];
  /**
   * The identity seed/token derived from this brief's title + art-direction
   * mood — carries the anti-sameness signal from brief into scaffold, so
   * "Scaffold this" pre-fills a token instead of leaving the scaffolder to
   * fall back to the (title-derived, but mood-blind) default. Never empty.
   */
  identityToken: string;
}

/**
 * Derive a stable identity token from a brief's title + art-direction mood.
 * Pure + deterministic: the same brief always yields the same token. Combining
 * title and mood (rather than title alone) means two brief titles that land on
 * the same mood text still diverge, and vice versa. Falls back to the title
 * alone when mood is blank, and to a constant when both are blank (never '').
 */
export function briefToIdentityToken(brief: DesignBrief): string {
  const title = brief.title.trim();
  const mood = brief.artDirection.mood.trim();
  const token = [title, mood].filter((s) => s.length > 0).join(' — ');
  return token.length > 0 ? token : 'untitled-game';
}

/**
 * Map a brief into scaffolder picks: the title, the recommended target, the brief's
 * suggested systems INTERSECTED with the ids the host actually offers (so a hallucinated id
 * is dropped), and an identity token derived from the title + mood. Pure.
 */
export function briefToScaffoldPicks(
  brief: DesignBrief,
  availableSystemIds: readonly string[],
): ScaffoldPicks {
  const available = new Set(availableSystemIds);
  return {
    name: brief.title,
    target: brief.target,
    systemIds: brief.systems.filter((id) => available.has(id)),
    identityToken: briefToIdentityToken(brief),
  };
}
