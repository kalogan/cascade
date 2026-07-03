/**
 * NPC reasoning — the SEAM CONTRACT + the FIREWALL.
 *
 * Ported from Wayfinders' reasoning seam (docs/DESIGN-reasoning-npcs.md §2). The
 * brain is event-driven, server-side, and NEVER authoritative: its ONLY channel
 * back into the game is a BOUNDED set of `NpcIntent`s the game may choose to apply.
 *
 * ★ THE FIREWALL IS `parseReasoningResponse`. Any model output — malformed JSON,
 * an oversized `text`, an unknown `kind`, a movement/combat/economy intent that
 * does not exist in the vocabulary — is DROPPED, not applied. A consumer that runs
 * each parsed intent can therefore only ever execute a vocabulary item this schema
 * explicitly allows.
 *
 * ★ THE VOCABULARY IS DELIBERATELY SMALL + SAFE: `say`, `setMood`, `wait`,
 * `endConversation`, `recall`. NO movement / combat / economy intents BY DEFAULT —
 * adding one is an explicit, reviewed widening of the firewall, never an accident of
 * a clever model reply.
 *
 * ★ GATED MOVEMENT (Track B5): two movement intents — `goTo` (request a destination)
 * and `emote` (a bounded gesture) — exist but are ADMITTED ONLY when the caller passes
 * `{ allowMovement: true }` into `parseReasoningResponse`. The default (`false`) drops
 * them EXACTLY like an unknown `kind`, so the default build is byte-for-byte as safe as
 * before this track. Even when admitted, the model only PROPOSES a goal: `goTo.target`
 * is validated finite + CLAMPED to the nav grid's walkable bounds, and the authoritative
 * behavior/pathfinder still owns actual movement — the model never writes a position.
 *
 * Engine-agnostic + serializable: plain Zod shapes, no three / colyseus / DB import.
 */

import { z } from 'zod';

export const REASONING_SCHEMA_VERSION = 1;

// Bounds — caps that keep a single reply small. These are part of the firewall:
// an oversized field FAILS validation and the offending intent is dropped.

/** Max characters for a spoken / `recall` line. */
export const MAX_INTENT_TEXT = 600;
/** Max characters for a mood token (a short label, not a paragraph). */
export const MAX_MOOD_LEN = 40;
/** Max intents acted on from a single response (defence in depth). */
export const MAX_INTENTS_PER_RESPONSE = 8;

// ── ReasoningRequest — the plain, serializable INPUT to a provider ───────────

/** One turn of the conversation transcript fed to the brain. */
export const ReasoningHistoryTurnSchema = z
  .object({
    role: z.enum(['player', 'npc']),
    text: z.string(),
  })
  .strict();
export type ReasoningHistoryTurn = z.infer<typeof ReasoningHistoryTurnSchema>;

/** The brain's character sheet — all plain strings the brain reads. */
export const ReasoningPersonaSchema = z
  .object({
    role: z.string(),
    knowledgeScope: z.string(),
    goals: z.array(z.string()).default([]),
    voice: z.string(),
  })
  .strict();
export type ReasoningPersona = z.infer<typeof ReasoningPersonaSchema>;

export const ReasoningRequestSchema = z
  .object({
    /** The NPC's display name (used in the system prompt + transcript framing). */
    npcName: z.string(),
    /** The NPC's character sheet (role / knowledge scope / goals / voice). */
    persona: ReasoningPersonaSchema,
    /** The latest player utterance the brain is responding to. */
    playerMessage: z.string(),
    /** The transcript so far (oldest → newest), excluding `playerMessage`. */
    history: z.array(ReasoningHistoryTurnSchema).default([]),
    /** An optional rolled-up memory summary ("what it remembers about you"). */
    memorySummary: z.string().optional(),
  })
  .strict();
export type ReasoningRequest = z.infer<typeof ReasoningRequestSchema>;

// ── NpcIntent — the BOUNDED set the brain may emit (the firewall vocabulary) ──

/** `say` — speak a line to the player (the common case). Length-capped. */
export const SayIntentSchema = z
  .object({
    kind: z.literal('say'),
    text: z.string().min(1).max(MAX_INTENT_TEXT),
  })
  .strict();

/** `setMood` — nudge the NPC's displayed mood (a short cosmetic label; advisory). */
export const SetMoodIntentSchema = z
  .object({
    kind: z.literal('setMood'),
    mood: z.string().min(1).max(MAX_MOOD_LEN),
  })
  .strict();

/** `wait` — the brain chooses to say/do nothing this turn (a deliberate beat). */
export const WaitIntentSchema = z.object({ kind: z.literal('wait') }).strict();

/** `endConversation` — the brain ends the exchange (sign-off handled by `say`). */
export const EndConversationIntentSchema = z
  .object({ kind: z.literal('endConversation') })
  .strict();

/** `recall` — store a memory note (episodic/relational). Length-capped. */
export const RecallIntentSchema = z
  .object({
    kind: z.literal('recall'),
    note: z.string().min(1).max(MAX_INTENT_TEXT),
  })
  .strict();

// ── Gated MOVEMENT intents (Track B5) — admitted ONLY with allowMovement: true ──
//
// These two widen the firewall in a strictly opt-in way. They are NOT part of the
// default `NpcIntentSchema` union below — so with the flag OFF the discriminated union
// has no `goTo`/`emote` member and they are dropped exactly like an unknown kind.

/**
 * The bounded set of gestures the model may request. An `emote` whose `name` is not in
 * this enum FAILS validation and is dropped — the model can never invent a new gesture.
 */
export const NPC_EMOTE_NAMES = ['wave', 'nod', 'point', 'shrug'] as const;
export type NpcEmoteName = (typeof NPC_EMOTE_NAMES)[number];

/**
 * A FINITE world coordinate. `z.number()` admits ±Infinity (it only rejects NaN), so we
 * refine with `Number.isFinite` — a non-finite target then fails validation and the whole
 * `goTo` is dropped (the model can never request an unbounded / NaN destination).
 */
const FiniteCoordSchema = z.number().refine((n) => Number.isFinite(n), { message: 'must be finite' });

/**
 * `goTo` — REQUEST a destination in world XZ. The model only proposes a goal; the target
 * is validated finite (above) + clamped to the nav grid's walkable bounds, and the
 * authoritative pathfinder/behavior still owns the actual movement (it never writes a
 * position from the model). A non-finite component drops the intent.
 */
export const GoToIntentSchema = z
  .object({
    kind: z.literal('goTo'),
    target: z.tuple([FiniteCoordSchema, FiniteCoordSchema]),
  })
  .strict();

/** `emote` — play one bounded gesture. Out-of-enum names are dropped (see NPC_EMOTE_NAMES). */
export const EmoteIntentSchema = z
  .object({
    kind: z.literal('emote'),
    name: z.enum(NPC_EMOTE_NAMES),
  })
  .strict();

/** The DEFAULT (movement-firewalled) vocabulary — identical to before Track B5. */
export const NpcIntentSchema = z.discriminatedUnion('kind', [
  SayIntentSchema,
  SetMoodIntentSchema,
  WaitIntentSchema,
  EndConversationIntentSchema,
  RecallIntentSchema,
]);
export type NpcIntent = z.infer<typeof NpcIntentSchema>;

/** The WIDENED vocabulary — the default set PLUS the gated movement intents. */
export const NpcMovementIntentSchema = z.discriminatedUnion('kind', [
  SayIntentSchema,
  SetMoodIntentSchema,
  WaitIntentSchema,
  EndConversationIntentSchema,
  RecallIntentSchema,
  GoToIntentSchema,
  EmoteIntentSchema,
]);
export type NpcMovementIntent = z.infer<typeof NpcMovementIntentSchema>;

/** The exact set of intent kinds the DEFAULT firewall admits (for tests + diagnostics). */
export const NPC_INTENT_KINDS = [
  'say',
  'setMood',
  'wait',
  'endConversation',
  'recall',
] as const;
export type NpcIntentKind = (typeof NPC_INTENT_KINDS)[number];

/** The kinds admitted ONLY when allowMovement is on (the widening surface). */
export const NPC_MOVEMENT_INTENT_KINDS = ['goTo', 'emote'] as const;
export type NpcMovementIntentKind = (typeof NPC_MOVEMENT_INTENT_KINDS)[number];

// ── ReasoningResponse — the provider's OUTPUT shape (the wire form) ──────────

export const ReasoningResponseSchema = z
  .object({ intents: z.array(NpcIntentSchema).default([]) })
  .strict();
export type ReasoningResponse = z.infer<typeof ReasoningResponseSchema>;

// ── Nav bounds (Track B5) — the walkable rectangle a `goTo` is clamped into ──

/**
 * The world-XZ AABB the reasoning layer may target. A `goTo` outside it is CLAMPED back
 * to the nearest in-bounds point — the model can only request a destination the
 * pathfinder would accept. Plain numbers (no nav/three import): build it from a grid via
 * {@link navBoundsFromGrid}, or hand-author it.
 */
export interface NavBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The minimal grid surface we read to derive walkable world bounds (a `createGridNav`). */
export interface NavBoundsGridLike {
  readonly width: number;
  readonly height: number;
  /** Map a cell `[col, row]` to its world-XZ centre. */
  cellToWorld(cell: [number, number]): [number, number];
}

/**
 * Derive the walkable world-XZ AABB from a grid: the bounding box of cell (0,0)'s centre
 * and cell (width-1, height-1)'s centre. Order-independent (min/max), so a flipped axis
 * still yields a valid box.
 */
export function navBoundsFromGrid(grid: NavBoundsGridLike): NavBounds {
  const lo = grid.cellToWorld([0, 0]);
  const hi = grid.cellToWorld([Math.max(0, grid.width - 1), Math.max(0, grid.height - 1)]);
  return {
    minX: Math.min(lo[0], hi[0]),
    maxX: Math.max(lo[0], hi[0]),
    minZ: Math.min(lo[1], hi[1]),
    maxZ: Math.max(lo[1], hi[1]),
  };
}

/** Clamp a world-XZ point into the bounds (component-wise). Inputs are already finite. */
export function clampToNavBounds(target: [number, number], bounds: NavBounds): [number, number] {
  const x = Math.min(Math.max(target[0], bounds.minX), bounds.maxX);
  const z = Math.min(Math.max(target[1], bounds.minZ), bounds.maxZ);
  return [x, z];
}

// ── THE FIREWALL — `parseReasoningResponse` ─────────────────────────────────

/** Options that GATE the firewall's widening. Omitted ⇒ the default, movement-firewalled. */
export interface ParseReasoningOptions {
  /**
   * Admit the gated movement intents (`goTo`, `emote`). DEFAULT `false` — with it off the
   * movement intents are dropped EXACTLY like an unknown `kind`, so the default build is
   * byte-for-byte as safe as before Track B5. ★ Turning this on lets the model drive NPC
   * movement (as a clamped goal request) — review the firewall before enabling.
   */
  allowMovement?: boolean;
  /**
   * The walkable world-XZ bounds a `goTo.target` is clamped into. Used ONLY when
   * `allowMovement` is true. Omit to admit `goTo` WITHOUT clamping (only finite-checked) —
   * pass bounds (e.g. {@link navBoundsFromGrid}) so the model can never request a point
   * the pathfinder would reject.
   */
  navBounds?: NavBounds;
}

/**
 * Validate-and-drop: parse a raw provider reply into the list of LEGAL intents.
 *
 * Accepts a JSON string (fenced ```json blocks tolerated) or an already-parsed value.
 * Drops anything that is not a legal intent (unknown `kind`, oversized text/mood,
 * extra fields, wrong types) — one bad intent never poisons the rest — and caps the
 * result at `MAX_INTENTS_PER_RESPONSE`. NEVER throws: garbage yields no intents, and
 * the consumer then falls back to scripted lines. This is the only thing standing
 * between a model and the game state.
 *
 * By DEFAULT (no options, or `allowMovement` falsy) movement intents (`goTo`/`emote`) are
 * NOT in the admitted union and are dropped like any unknown kind — the result type is the
 * unchanged `NpcIntent[]`, so every existing caller is byte-for-byte and type-for-type the
 * same. With `{ allowMovement: true }` they are admitted (result widened to
 * `NpcMovementIntent[]`); a `goTo` is finite-validated by the schema and CLAMPED to
 * `navBounds` (when given), and out-of-enum `emote`s are dropped.
 */
export function parseReasoningResponse(raw: unknown): NpcIntent[];
export function parseReasoningResponse(
  raw: unknown,
  options: ParseReasoningOptions,
): NpcMovementIntent[];
export function parseReasoningResponse(
  raw: unknown,
  options?: ParseReasoningOptions,
): NpcMovementIntent[] {
  const allowMovement = options?.allowMovement === true;
  const schema = allowMovement ? NpcMovementIntentSchema : NpcIntentSchema;
  const candidates = extractIntentCandidates(raw);
  const out: NpcMovementIntent[] = [];
  for (const candidate of candidates) {
    if (out.length >= MAX_INTENTS_PER_RESPONSE) break;
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) continue; // DROP it — an invalid intent never reaches the consumer.
    // Clamp a (validated, finite) goTo target into the walkable bounds, when provided.
    if (allowMovement && parsed.data.kind === 'goTo' && options?.navBounds) {
      out.push({ ...parsed.data, target: clampToNavBounds(parsed.data.target, options.navBounds) });
    } else {
      out.push(parsed.data);
    }
  }
  return out;
}

/**
 * Pull candidate intent objects out of whatever the provider returned, without
 * trusting any of it. Tolerates a JSON string, a fenced block, a bare array, or a
 * `{ intents: [...] }` envelope. Returns `[]` on anything else.
 */
function extractIntentCandidates(raw: unknown): unknown[] {
  let value: unknown = raw;

  if (typeof value === 'string') {
    const text = stripCodeFence(value).trim();
    if (text.length === 0) return [];
    try {
      value = JSON.parse(text);
    } catch {
      return [];
    }
  }

  if (Array.isArray(value)) return value;

  if (
    value &&
    typeof value === 'object' &&
    Array.isArray((value as { intents?: unknown }).intents)
  ) {
    return (value as { intents: unknown[] }).intents;
  }

  return [];
}

/** Strip a leading ```json / ``` fence if the model wrapped its JSON in one. */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z]*\s*\n?/, '');
  return withoutOpen.replace(/\n?```\s*$/, '');
}
