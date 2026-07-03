/**
 * Lighting rig — react-three-fiber variant.
 *
 * A declarative <LightingRig/> emitting the same lights as the vanilla
 * `createLightingRig`: an ambient fill, a shadow-casting warm "sun", and
 * optional cool fill + rim lights. Default values come from the shared
 * LIGHTING_DEFAULTS in ./index.ts so vanilla + r3f never drift.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import type { JSX } from 'react';
import type * as THREE from 'three';
import { LIGHTING_DEFAULTS, LIGHTING_PRESETS, type LightingPreset } from './index.js';

export interface LightingRigProps {
  /**
   * Named preset to base the rig on. Defaults to "daylight" (the warm
   * three-point rig); "moody" selects the dark single-source rig. Per-light
   * props below still override the chosen preset's values.
   */
  preset?: LightingPreset;
  /** Ambient hemispheric fill. */
  ambient?: {
    color?: THREE.ColorRepresentation;
    intensity?: number;
  };
  /** Primary shadow-casting directional "sun". */
  sun?: {
    color?: THREE.ColorRepresentation;
    intensity?: number;
    position?: [number, number, number];
    castShadow?: boolean;
    shadowMapSize?: number;
    /** Half-extent of the orthographic shadow camera frustum. */
    shadowCameraExtent?: number;
    shadowCameraNear?: number;
    shadowCameraFar?: number;
  };
  /** Optional cool fill light opposite the sun. Enabled by default. */
  fill?:
    | false
    | {
        color?: THREE.ColorRepresentation;
        intensity?: number;
        position?: [number, number, number];
      };
  /** Optional cool rim/back light. Enabled by default. */
  rim?:
    | false
    | {
        color?: THREE.ColorRepresentation;
        intensity?: number;
        position?: [number, number, number];
      };
}

/**
 * Declarative lighting rig for r3f. Drop into a <Canvas/> scene. For soft
 * shadows, set the canvas's `shadows` prop (and a soft shadow map type).
 */
export function LightingRig(props: LightingRigProps = {}): JSX.Element {
  // Resolve which preset seeds the fallback chain. "daylight" default keeps
  // existing callers unchanged; "moody" seeds from the dark single-source rig.
  const base = LIGHTING_PRESETS[props.preset ?? 'daylight'];

  const sun = props.sun ?? {};
  const extent = sun.shadowCameraExtent ?? base.sun.shadowCameraExtent;
  const mapSize = sun.shadowMapSize ?? base.sun.shadowMapSize;
  const sunPos = sun.position ?? base.sun.position;

  // The preset's own `fill` may be `false` (moody). An explicit prop wins.
  const fillResolved = props.fill ?? base.fill;
  const fill = fillResolved === false ? null : fillResolved;
  const fillBase = base.fill !== false ? base.fill : LIGHTING_DEFAULTS.fill;

  const rimResolved = props.rim ?? base.rim;
  const rim = rimResolved === false ? null : rimResolved;
  const rimBase = base.rim !== false ? base.rim : LIGHTING_DEFAULTS.rim;

  return (
    <>
      <ambientLight
        color={props.ambient?.color ?? base.ambient.color}
        intensity={props.ambient?.intensity ?? base.ambient.intensity}
      />

      <directionalLight
        color={sun.color ?? base.sun.color}
        intensity={sun.intensity ?? base.sun.intensity}
        position={sunPos}
        castShadow={sun.castShadow ?? base.sun.castShadow}
        shadow-mapSize-width={mapSize}
        shadow-mapSize-height={mapSize}
        shadow-camera-near={sun.shadowCameraNear ?? base.sun.shadowCameraNear}
        shadow-camera-far={sun.shadowCameraFar ?? base.sun.shadowCameraFar}
        shadow-camera-left={-extent}
        shadow-camera-right={extent}
        shadow-camera-top={extent}
        shadow-camera-bottom={-extent}
      />

      {fill && (
        <directionalLight
          color={fill.color ?? fillBase.color}
          intensity={fill.intensity ?? fillBase.intensity}
          position={fill.position ?? fillBase.position}
        />
      )}

      {rim && (
        <directionalLight
          color={rim.color ?? rimBase.color}
          intensity={rim.intensity ?? rimBase.intensity}
          position={rim.position ?? rimBase.position}
        />
      )}
    </>
  );
}
