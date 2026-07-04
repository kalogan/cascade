// game-kit — reusable systems for web 3D games (three.js).
// Re-exports every module's public API.

// THREE-FREE modules (no three import — unit-testable without three).
export * from './prng/index.js';
export * from './nav/index.js';
export * from './behavior/index.js';
export * from './settings/index.js';
export * from './character/index.js';
export * from './scene-state/index.js';
export * from './audio/index.js';
export * from './hud/index.js';
export * from './input/index.js';
export * from './save/index.js';
export * from './math/index.js';
export * from './net/index.js';
export * from './presets/index.js';
export * from './identity/index.js';
export * from './touch/index.js';
export * from './grid-input/index.js';
export * from './meta/index.js';

// NOTE: the 2D modules (board/render2d/fx2d/campaign/theme/tuning/perf) are NOT
// re-exported here. This barrel pulls `three` (via fx/render/…), and a couple of
// names collide with 3D equivalents (e.g. `ParticleSystem` in both `fx` and
// `fx2d`). 2D games import them by subpath (`game-kit/board`) or via the dedicated
// three-free 2D barrel `game-kit/2d` (see ./index2d.ts) — never through here.

// three-dependent modules.
export * from './lighting/index.js';
export * from './postfx/index.js';
export * from './anim/index.js';
export * from './geo/index.js';
export * from './palette/index.js';
export * from './artkit/index.js';
export * from './camera/index.js';
export * from './render/index.js';
export * from './fx/index.js';
export * from './clip/index.js';
export * from './world/index.js';
export * from './gltf/index.js';
export * from './cutscene/index.js';
export * from './layout/index.js';
