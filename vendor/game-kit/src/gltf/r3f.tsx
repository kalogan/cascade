/**
 * GLTF + screen-space-DOM helpers — react-three-fiber variants.
 *
 * Two harvests from GYRE's src/effigy.tsx, generalized so the next game doesn't
 * rebuild them:
 *   • {@link GltfModel} — a drei `useGLTF` loader that CLONES the cached scene
 *     (never mutating drei's original, so remounts stay clean), then optionally
 *     normalizes the model's height + seats its feet on the floor (the
 *     Box3-driven auto-fit GYRE repeated for every humanoid GLB) and optionally
 *     applies a material override.
 *   • {@link Overlay} — a thin wrapper around drei `<Html>` for screen-space DOM
 *     inside a <Canvas>, carrying the hard-won note that a RAW <div> / react-dom
 *     createPortal CRASHES the R3F reconciler — only drei's <Html> bridges to DOM.
 *
 * Requires the react + @react-three/fiber + @react-three/drei peer deps.
 */

import { useMemo, type ReactNode } from 'react';
import { useGLTF, Html } from '@react-three/drei';
import * as THREE from 'three';
import { computeGltfFit } from './index.js';

// ── GltfModel ────────────────────────────────────────────────────────────────

/** Props for {@link GltfModel}. */
export interface GltfModelProps {
  /** URL of the .glb/.gltf to load (fetched + cached by drei's useGLTF). */
  url: string;
  /**
   * Normalize the model's HEIGHT to `targetHeight` and seat its feet on y=0.
   * Default true — the common case for dropping any humanoid GLB into a scene
   * without a hand-tuned scale (GYRE's pattern). Set false to keep native size.
   */
  autoFit?: boolean;
  /** World height to normalize to when `autoFit`. Default 1.8 (roughly a person). */
  targetHeight?: number;
  /**
   * Seat the model's feet (its bounding-box floor) on y=0. Default true. Only
   * meaningful with `autoFit`; ignored otherwise. Turn off to keep the model's
   * own vertical origin (e.g. a prop already authored around its pivot).
   */
  seatOnFloor?: boolean;
  /**
   * Optional material applied to EVERY mesh in the clone (GYRE recoloured the
   * forge model to a cold Hollow this way). Omit to keep the model's originals.
   */
  recolor?: THREE.Material;
  /** Cast shadows from every mesh. Default true. */
  castShadow?: boolean;
  /** Receive shadows on every mesh. Default true. */
  receiveShadow?: boolean;
}

/**
 * Load, clone, and (optionally) auto-fit a GLB, ready to drop into a scene.
 *
 * `useGLTF` SUSPENDS until the model is fetched + parsed, so render this inside a
 * <Suspense> (with a fallback) — and ideally a small error boundary, since
 * useGLTF THROWS on a failed fetch/parse (a Suspense fallback only covers the
 * pending state, not the throw). We clone the cached scene so drei's original
 * stays pristine and remounts are clean, then apply shadows, the optional
 * material override, and the optional height-normalize + feet-on-floor fit.
 *
 * Preload eagerly with `GltfModel.preload(url)` (re-exported drei's
 * `useGLTF.preload`) to warm the cache before first mount.
 */
export function GltfModel({
  url,
  autoFit = true,
  targetHeight = 1.8,
  seatOnFloor = true,
  recolor,
  castShadow = true,
  receiveShadow = true,
}: GltfModelProps): React.JSX.Element {
  const gltf = useGLTF(url);

  const model = useMemo(() => {
    // Clone the cached scene so we never mutate drei's original (keeps remounts
    // clean and lets multiple instances of the same URL coexist).
    const root = gltf.scene.clone(true);

    root.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = castShadow;
        mesh.receiveShadow = receiveShadow;
        if (recolor) mesh.material = recolor;
      }
    });

    if (autoFit) {
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const fit = computeGltfFit({ minY: box.min.y, sizeY: size.y }, targetHeight);
      root.scale.setScalar(fit.scale);
      root.position.y = seatOnFloor ? fit.positionY : 0;
    }

    return root;
  }, [gltf, autoFit, targetHeight, seatOnFloor, recolor, castShadow, receiveShadow]);

  return <primitive object={model} />;
}

/**
 * Warm drei's GLB cache so a model is fetched before first mount. Thin re-export
 * of `useGLTF.preload` so callers don't also import drei just to preload.
 */
GltfModel.preload = (url: string): void => {
  useGLTF.preload(url);
};

// ── Overlay (screen-space DOM inside a Canvas) ───────────────────────────────

/** Props for {@link Overlay}. */
export interface OverlayProps {
  /** The DOM UI to render (buttons, panels, prompts, HUD). */
  children: ReactNode;
  /**
   * Fill the whole canvas (a screen-space HUD layer). Default true. Set false
   * and pass `position` to anchor the DOM to a world point instead.
   */
  fullscreen?: boolean;
  /** World-space anchor `[x, y, z]` when not `fullscreen` (a diegetic label). */
  position?: [number, number, number];
  /** Center the DOM on its anchor (only meaningful when positioned). Default false. */
  center?: boolean;
  /**
   * z-index range drei maps depth into, `[far, near]`. Handy to keep a dialogue
   * panel above other <Html> in the scene. Passed straight through.
   */
  zIndexRange?: [number, number];
  /** Extra styles for the wrapping DOM element drei injects. */
  style?: React.CSSProperties;
  /** Let pointer events reach the DOM (needed for inputs/buttons). Default true. */
  pointerEvents?: boolean;
}

/**
 * Screen-space (or world-anchored) DOM inside a <Canvas>.
 *
 * IMPORTANT — why this wraps drei's `<Html>` and not a bare <div>: R3F's
 * reconciler only understands three objects, so rendering a raw <div> (or a
 * react-dom `createPortal`) as a child of the Canvas CRASHES it ("div is not
 * part of the THREE namespace"). drei's <Html> is the bridge: it portals real
 * DOM out of the WebGL tree into an overlay layer and keeps it positioned. Route
 * ALL in-Canvas DOM (HUD, dialogue, "press E" prompts) through here.
 *
 * `fullscreen` (default) makes a HUD layer covering the canvas; pass a
 * `position` (with `fullscreen={false}`) to anchor the DOM to a world point.
 * (GYRE used both: a positioned prompt at the Hollow's head + a positioned
 * dialogue panel beside it.)
 */
export function Overlay({
  children,
  fullscreen = true,
  position,
  center = false,
  zIndexRange,
  style,
  pointerEvents = true,
}: OverlayProps): React.JSX.Element {
  const mergedStyle: React.CSSProperties = {
    pointerEvents: pointerEvents ? 'auto' : 'none',
    ...style,
  };
  return (
    <Html
      fullscreen={fullscreen}
      position={position}
      center={center}
      zIndexRange={zIndexRange}
      style={mergedStyle}
    >
      {children}
    </Html>
  );
}
