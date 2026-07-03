// game-kit/npc — server-side NPC reasoning (conversations + memory) over a
// provider-agnostic seam. Grok is just an OpenAI-compatible provider.
//
// SERVER-SIDE ONLY: real providers hold an API key and make network calls. Keep
// this entry out of client/browser bundles. The firewall (parseReasoningResponse)
// is the security boundary — a model can only ever emit the bounded intent vocabulary.
//
// ── CLIENT vs SERVER (why there are two entries) ──────────────────────────────
// This entry re-exports the zod SCHEMA (the firewall) + the keyed OpenAI-compatible
// provider — both server concerns. A CLIENT game that only needs an OFFLINE NPC (the
// mock/selector provider + budget + memory + brain) should import from the sibling
// ./runtime.ts entry (game-kit/npc/runtime) instead: it exposes the SAME brain/mock/budget
// surface but WITHOUT importing zod, so the browser bundle stays lean (this split is what
// got zod's ~557KB out of GYRE's client build). The mock/selector/fallback lines are
// trusted strings and go through the zod-free ./trustedIntent.ts cap; only the real
// untrusted-LLM path (openaiProvider) keeps the zod firewall.
//
// ERGONOMICS: createNpcBrain accepts a RAW ReasoningProvider (a mock, a keyed provider) OR
// an already-BudgetedProvider — it auto-wraps once, so a mock "just works" with no
// hand-wrapping in createBudgetedProvider.

export * from './schema.js';
export * from './trustedIntent.js';
export * from './prompt.js';
export * from './provider.js';
export * from './openaiProvider.js';
export * from './mockProvider.js';
export * from './budgetedProvider.js';
export * from './memory.js';
export * from './store.js';
export * from './summarizer.js';
export * from './embedder.js';
export * from './brain.js';
