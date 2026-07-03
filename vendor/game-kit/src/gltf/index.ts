/**
 * GLTF helpers — the pure fit math behind the r3f `<GltfModel>` loader.
 *
 * THREE-FREE by design: the height-normalize + seat-on-floor arithmetic is
 * extracted here as plain numbers so it's unit-testable without three, a DOM, or
 * a WebGL context. The r3f component in ./r3f.tsx feeds it a THREE.Box3's min/size
 * and applies the result to the cloned scene.
 *
 * Harvested from GYRE's src/effigy.tsx: every imported humanoid GLB there repeated
 *   const box = new THREE.Box3().setFromObject(root);
 *   const s = TARGET / (box.getSize(...).y || 1);
 *   root.scale.setScalar(s);
 *   root.position.y = -box.min.y * s;   // feet on the floor
 * (twice — GlbEffigy and DistantFigureModel), so any GLB swaps in without a
 * hand-tuned scale. That is exactly {@link computeGltfFit}.
 */

/** A GLB's bounding box, as the two numbers the fit needs (no three types). */
export interface GltfBounds {
  /** Bounding-box minimum Y (the model's lowest point, in its own units). */
  minY: number;
  /** Bounding-box height (size along Y, in the model's own units). */
  sizeY: number;
}

/** The transform to apply to a cloned GLB scene to normalize + seat it. */
export interface GltfFit {
  /** Uniform scale so the model's height becomes `targetHeight`. */
  scale: number;
  /** World Y to place the (scaled) model at so its feet sit on y=0. */
  positionY: number;
}

/**
 * PURE: given a model's bounding box (minY + height) and a desired world height,
 * return the uniform scale that makes it exactly `targetHeight` tall and the Y
 * offset that seats its feet on the floor (y=0).
 *
 * Degenerate `sizeY` (0 / NaN / ±Infinity) falls back to a scale of 1 so a flat
 * or malformed model never divides by zero or scales to infinity — it just sits
 * on the floor at its natural size.
 */
export function computeGltfFit(bounds: GltfBounds, targetHeight: number): GltfFit {
  const h = bounds.sizeY;
  const usable = Number.isFinite(h) && h > 0;
  const scale = usable ? targetHeight / h : 1;
  // Feet-on-floor: the scaled minimum Y should land at 0, so lift by -minY*scale.
  // `+ 0` normalizes -0 (from -0*scale when minY is 0) to a plain 0.
  const positionY = -bounds.minY * scale + 0;
  return { scale, positionY };
}
