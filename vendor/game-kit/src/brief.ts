// game-kit/brief — the design-brief generator (idea → structured brief → scaffolder picks).
// Separate entry so zod stays out of the client/three bundle. Pure: no network, no key —
// the host injects the model `complete`. Import `game-kit/brief`.

export * from './brief/index.js';
