// game-kit/npc/runtime — the CLIENT-SAFE NPC reasoning entry (ZOD-FREE).
//
// ── The client-vs-server split ────────────────────────────────────────────────
// The full `game-kit/npc` entry (./index.ts) re-exports the zod SCHEMA + the keyed
// OpenAI-compatible provider. Those belong on the SERVER: the schema's firewall
// (`parseReasoningResponse`) validates UNTRUSTED model output, and pulling zod into a
// browser bundle cost GYRE ~557KB it never used.
//
// This entry exports ONLY the runtime a CLIENT game needs to run an OFFLINE NPC:
//   • the provider seam type + the deterministic mocks (blind + selector),
//   • the budget firewall (timeout + rate-cap + scripted fallback),
//   • memory (record shaping + the in-memory store), summarizer + embedder seams,
//   • the brain that wires them (it now auto-wraps a raw provider — no hand-wrapping),
//   • the trusted-intent builder the mocks/fallback use INSTEAD of the zod firewall.
//
// None of these import zod as a VALUE (they use only `import type` from ./schema, which is
// erased at build), so a client that imports from HERE ships no zod. TRUST MODEL: the
// mock/selector/fallback paths emit strings the GAME authored, so they're trusted by
// construction and only need the length cap `./trustedIntent.ts` reproduces zod-free. The
// moment you introduce a REAL (network/LLM) provider, import it from `game-kit/npc`
// server-side and keep the zod firewall on that untrusted output.
//
// TOP BARREL: expose this as `game-kit/npc/runtime` in your app's path map, e.g.
//   "game-kit/npc/runtime": ["./vendor/game-kit/src/npc/runtime.ts"]

export * from './provider.js';
export * from './trustedIntent.js';
export * from './mockProvider.js';
export * from './budgetedProvider.js';
export * from './memory.js';
export * from './store.js';
export * from './summarizer.js';
export * from './embedder.js';
export * from './brain.js';
