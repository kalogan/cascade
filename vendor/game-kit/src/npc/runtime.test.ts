/**
 * game-kit/npc — CLIENT ergonomics tests (the fixes GYRE exposed).
 *
 * Covers: (1) the selector-driven mock reads the player's message + returns the chosen
 * line, (2) createNpcBrain accepts a RAW provider (auto-wrap), (3) the trusted-intent cap
 * stays in lock-step with the zod firewall's, (4) the runtime barrel is zod-free at source.
 *
 * These import from the vendored source directly (vitest resolves from disk), mirroring
 * lib/npc/firewall.test.ts's convention.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createSelectorMockProvider,
  createMockProvider,
  type LineSelector,
} from './mockProvider.js';
import { createNpcBrain, type NpcInfo } from './brain.js';
import {
  createBudgetedProvider,
  toBudgetedProvider,
  isBudgetedProvider,
} from './budgetedProvider.js';
import { createInMemoryNpcStore } from './memory.js';
import { buildSayIntents, capIntentText, TRUSTED_MAX_INTENT_TEXT } from './trustedIntent.js';
import { MAX_INTENT_TEXT } from './schema.js';
import type { ReasoningPersona, ReasoningRequest } from './schema.js';

const persona: ReasoningPersona = {
  role: 'a test NPC',
  knowledgeScope: 'the test world',
  goals: [],
  voice: 'terse',
};

const req = (overrides: Partial<ReasoningRequest> = {}): ReasoningRequest => ({
  npcName: 'Tester',
  persona,
  playerMessage: '',
  history: [],
  ...overrides,
});

// ── (1) The selector mock is CONTENT-AWARE ────────────────────────────────────

describe('createSelectorMockProvider', () => {
  it('returns the line the selector chose for the player message', async () => {
    const select: LineSelector = (msg) =>
      msg.toLowerCase().includes('sump') ? 'Then let it finish.' : 'Choose.';
    const p = createSelectorMockProvider(select);

    const hit = await p.respond(req({ playerMessage: 'I feed the Sump.' }));
    expect(hit.intents).toEqual([{ kind: 'say', text: 'Then let it finish.' }]);

    const miss = await p.respond(req({ playerMessage: 'hello there' }));
    expect(miss.intents).toEqual([{ kind: 'say', text: 'Choose.' }]);
  });

  it('passes context (history + memorySummary + request) to the selector', async () => {
    let seen: unknown;
    const select: LineSelector = (msg, ctx) => {
      seen = { msg, npcName: ctx.npcName, historyLen: ctx.history.length, summary: ctx.memorySummary };
      return 'ok';
    };
    const p = createSelectorMockProvider(select);
    await p.respond(
      req({
        playerMessage: 'who are you',
        history: [{ role: 'player', text: 'earlier' }],
        memorySummary: 'remembers you',
      }),
    );
    expect(seen).toEqual({
      msg: 'who are you',
      npcName: 'Tester',
      historyLen: 1,
      summary: 'remembers you',
    });
  });

  it('an empty / undefined selection yields NO intents (brain then falls back)', async () => {
    const empty = createSelectorMockProvider(() => '');
    expect((await empty.respond(req({ playerMessage: 'x' }))).intents).toEqual([]);
    const undef = createSelectorMockProvider(() => undefined);
    expect((await undef.respond(req({ playerMessage: 'x' }))).intents).toEqual([]);
  });

  it('caps an overlong selected line to the intent-text cap', async () => {
    const long = 'z'.repeat(TRUSTED_MAX_INTENT_TEXT + 50);
    const p = createSelectorMockProvider(() => long);
    const out = await p.respond(req({ playerMessage: 'x' }));
    expect(out.intents).toHaveLength(1);
    expect((out.intents[0] as { text: string }).text).toHaveLength(TRUSTED_MAX_INTENT_TEXT);
  });

  it('has a stable name for telemetry (overridable)', () => {
    expect(createSelectorMockProvider(() => 'x').name).toBe('selector-mock');
    expect(createSelectorMockProvider(() => 'x', { name: 'hollow' }).name).toBe('hollow');
  });
});

// ── (2) createNpcBrain accepts a RAW provider (auto-wrap ergonomics) ──────────

describe('createNpcBrain — provider ergonomics', () => {
  const info: NpcInfo = {
    name: 'Tester',
    persona,
    fallbackLines: ['scripted fallback'],
    retentionDays: 0,
  };
  const deps = (provider: Parameters<typeof createNpcBrain>[0]['provider']) => ({
    provider,
    store: createInMemoryNpcStore(),
    getNpcInfo: (id: string) => (id === 'npc1' ? info : undefined),
  });

  it('accepts a RAW selector mock provider directly (no hand-wrapping)', async () => {
    const brain = createNpcBrain(
      deps(createSelectorMockProvider((m) => (m.includes('rest') ? 'The Sump, then.' : 'Choose.'))),
    );
    const res = await brain.say({ npcId: 'npc1', playerKey: 'p', characterId: 'c', text: 'let it rest' });
    expect(res?.text).toBe('The Sump, then.');
    expect(res?.source).toBe('llm');
  });

  it('accepts a RAW content-blind mock provider directly', async () => {
    const brain = createNpcBrain(deps(createMockProvider(['line A', 'line B'])));
    const res = await brain.say({ npcId: 'npc1', playerKey: 'p', text: 'hi' });
    expect(res?.text).toBe('line A');
  });

  it('still accepts an already-budgeted provider (no double-wrap)', async () => {
    const budgeted = createBudgetedProvider(createMockProvider(['budgeted line']));
    const brain = createNpcBrain(deps(budgeted));
    const res = await brain.say({ npcId: 'npc1', playerKey: 'p', text: 'hi' });
    expect(res?.text).toBe('budgeted line');
  });

  it('a raw provider with an empty selection degrades to the scripted fallback', async () => {
    const brain = createNpcBrain(deps(createSelectorMockProvider(() => '')));
    const res = await brain.say({ npcId: 'npc1', playerKey: 'p', text: 'hi' });
    expect(res?.text).toBe('scripted fallback');
    expect(res?.source).toBe('scripted');
  });
});

// ── (2b) toBudgetedProvider / isBudgetedProvider are idempotent ───────────────

describe('toBudgetedProvider', () => {
  it('wraps a raw provider once and is idempotent on an already-budgeted one', () => {
    const raw = createMockProvider();
    expect(isBudgetedProvider(raw)).toBe(false);
    const wrapped = toBudgetedProvider(raw);
    expect(isBudgetedProvider(wrapped)).toBe(true);
    expect(toBudgetedProvider(wrapped)).toBe(wrapped); // same instance, not re-wrapped
  });
});

// ── (3) The trusted (zod-free) cap agrees with the zod firewall's ─────────────

describe('trustedIntent builder', () => {
  it('TRUSTED_MAX_INTENT_TEXT stays in lock-step with the schema firewall cap', () => {
    expect(TRUSTED_MAX_INTENT_TEXT).toBe(MAX_INTENT_TEXT);
  });

  it('empty / whitespace text yields no intents', () => {
    expect(buildSayIntents('')).toEqual([]);
    expect(buildSayIntents('   ')).toEqual([]);
  });

  it('builds a single trimmed + capped say intent', () => {
    expect(buildSayIntents('  hi  ')).toEqual([{ kind: 'say', text: 'hi' }]);
    expect(capIntentText('a'.repeat(700))).toHaveLength(TRUSTED_MAX_INTENT_TEXT);
  });
});

// ── (4) The runtime barrel is ZOD-FREE at source ──────────────────────────────

describe('client-safe runtime entry', () => {
  it('runtime.ts and its value-imported modules never import zod', () => {
    // Resolve the npc source dir from the repo cwd (vitest runs from the repo root).
    const here = join(process.cwd(), 'vendor', 'game-kit', 'src', 'npc');
    // The modules re-exported by runtime.ts (only value imports matter — type imports erase).
    const files = [
      'runtime.ts',
      'trustedIntent.ts',
      'mockProvider.ts',
      'budgetedProvider.ts',
      'memory.ts',
      'store.ts',
      'summarizer.ts',
      'embedder.ts',
      'brain.ts',
      'provider.ts',
    ];
    for (const f of files) {
      const src = readFileSync(join(here, f), 'utf8');
      // A real (value) zod import; `import type ... from './schema'` is erased and OK.
      expect(src, `${f} must not value-import zod`).not.toMatch(/^\s*import\s+(?!type\b)[^;]*from\s+['"]zod['"]/m);
    }
  });
});
