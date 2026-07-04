// game-kit/2d — the THREE-FREE 2D barrel.
//
// Re-exports the Canvas2D substrate + Match-3 spine so a 2D game can pull the
// whole 2D surface from one place WITHOUT dragging in `three` (which the main
// barrel `game-kit` does via fx/render/…). Deliberately separate so the 2D bundle
// stays lean and the 3D/2D name overlaps (e.g. `ParticleSystem`) never collide.

export * from './board/index.js';
export * from './render2d/index.js';
export * from './fx2d/index.js';
export * from './campaign/index.js';
export * from './theme/index.js';
export * from './tuning/index.js';
export * from './perf/index.js';
export * from './meta/index.js';
export * from './grid-input/index.js';
export * from './loop/index.js';
export * from './assets/index.js';
export * from './sprite/index.js';

// board and render2d each export an identical `Cell` ({ row, col }); an explicit
// re-export resolves the two star exports so `import { Cell } from 'game-kit/2d'`
// works instead of the name being silently dropped as ambiguous.
export type { Cell } from './board/index.js';
