// game-kit/r3f — react-three-fiber component variants of the three-dependent
// systems. Kept SEPARATE from the main entry (./index.ts) so the vanilla API
// stays react-free; consumers import `game-kit/r3f` only when they want the
// declarative components.
//
// Requires the react + @react-three/* peer deps (optional in package.json).

export * from './lighting/r3f.js';
export * from './postfx/r3f.js';
export * from './camera/r3f.js';
export * from './fx/r3f.js';
export * from './clip/r3f.js';
export * from './render/r3f.js';
export * from './gltf/r3f.js';
export * from './character/r3f.js';
export * from './scene-state/r3f.js';
export * from './cutscene/r3f.js';
export * from './layout/r3f.js';
export * from './touch/r3f.js';
