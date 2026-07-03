// game-kit/npc — the server-side NPC reasoning entry. Kept SEPARATE from the main
// entry (./index.ts) so the client/three bundle never pulls in a keyed provider or
// the zod dependency. Import `game-kit/npc` only from server code.

export * from './npc/index.js';
