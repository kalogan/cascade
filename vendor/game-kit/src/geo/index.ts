/**
 * Geometry helpers — the chunky faceted low-poly look.
 *
 * Distilled from project-mmo's approved procgen art-kit (packages/client/src/art/geo.ts):
 * the two primitives every faceted generator leans on are (a) collapsing a geometry
 * to hard per-facet normals and (b) deterministically jittering its vertices so the
 * silhouette reads hand-carved rather than CAD-perfect.
 *
 * three-dependent: imports three. Determinism lives in the caller's `rng` — these
 * helpers never touch Math.random().
 */

import * as THREE from 'three';

/**
 * Collapse to a non-indexed geometry with hard, per-facet normals → crisp flat
 * shading. `toNonIndexed()` splits shared vertices so each triangle owns its own
 * three corners, then `computeVertexNormals()` gives every face a single normal.
 *
 * Guarded: only expands when the geometry is actually indexed — `toNonIndexed()`
 * on an already-flat geometry logs a console warning and does wasted work.
 *
 * Returns the de-indexed geometry. When the input is indexed this is a NEW
 * geometry (three's `toNonIndexed()` clones); when already non-indexed the SAME
 * instance is returned (with normals recomputed in place).
 */
export function nonIndexedFlat(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  flat.computeVertexNormals();
  return flat;
}

/**
 * Displace every position vertex by `(rng() * 2 - 1) * amount` on each axis, then
 * recompute normals so the faceting follows the new surface.
 *
 * MUTATES `geo` in place and returns it (matching the project-mmo helper). Pass a
 * clone if you need the original intact: `jitterVerts(geo.clone(), rng, amount)`.
 *
 * DETERMINISTIC: for a given `rng` sequence the displacement is fully reproducible
 * (three position floats consumed per vertex, in x/y/z order). Pair with a
 * `createRng(seed)`'s `.next` for seed-stable jitter.
 *
 * @param rng A `() => number` yielding floats in [0, 1) (e.g. an Rng's `.next`).
 * @param amount Max displacement magnitude per axis (the half-range).
 */
export function jitterVerts(
  geo: THREE.BufferGeometry,
  rng: () => number,
  amount: number,
): THREE.BufferGeometry {
  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr) {
    throw new Error('jitterVerts: geometry has no position attribute');
  }
  const arr = posAttr.array as Float32Array;
  for (let i = 0; i < arr.length; i++) {
    arr[i] = arr[i]! + (rng() * 2 - 1) * amount;
  }
  posAttr.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
