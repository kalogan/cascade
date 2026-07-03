/**
 * Lighting rig — vanilla three.
 *
 * Adds a sensible default three-point-ish rig to a scene: an ambient fill, a
 * shadow-casting "sun" (DirectionalLight), and optional cool fill + rim lights.
 *
 * Proven values are distilled from two shipped games:
 *   - project-mmo FrostpeaksZone: ambient ~0.45, sun with a 2048 shadow map,
 *     near 1 / far 120, ortho frustum ±60.
 *   - storm-break-hockey ThreeSetup: PCFSoftShadowMap, warm key + cool rim.
 *
 * An r3f variant lives in ./r3f.tsx (a <LightingRig/> component). It consumes
 * the shared LIGHTING_DEFAULTS below so vanilla + r3f never drift.
 */

import * as THREE from 'three';

/**
 * A named lighting preset. "daylight" is the warm three-point default;
 * "moody" is a dark, single-source dramatic rig.
 */
export type LightingPreset = 'daylight' | 'moody';

/** A directional side light (fill or rim) within a preset. */
interface PresetSideLight {
  color: THREE.ColorRepresentation;
  intensity: number;
  position: [number, number, number];
}

/** The fully-resolved value shape a lighting preset provides. */
interface LightingPresetValues {
  ambient: { color: THREE.ColorRepresentation; intensity: number };
  sun: {
    color: THREE.ColorRepresentation;
    intensity: number;
    position: [number, number, number];
    castShadow: boolean;
    shadowMapSize: number;
    shadowCameraExtent: number;
    shadowCameraNear: number;
    shadowCameraFar: number;
  };
  /** `false` when the preset intentionally has no fill (e.g. moody). */
  fill: PresetSideLight | false;
  /** `false` when the preset intentionally has no rim. */
  rim: PresetSideLight | false;
  /** Optional atmospheric fog hook (pure data — the rig never mutates fog). */
  fog?: { color: THREE.ColorRepresentation; density: number };
}

/**
 * Default values for the lighting rig, shared between the vanilla
 * `createLightingRig` and the r3f `<LightingRig/>` so the two never drift.
 *
 * This is the "daylight" preset: warm key, cool sky fill + rim, ~0.4 ambient.
 * Selected by default so existing callers keep the same look.
 */
export const LIGHTING_DEFAULTS = {
  ambient: {
    color: 0xffffff as THREE.ColorRepresentation,
    intensity: 0.4,
  },
  sun: {
    color: 0xfff1d6 as THREE.ColorRepresentation, // warm daylight
    intensity: 0.85,
    position: [40, 60, 30] as [number, number, number],
    castShadow: true,
    shadowMapSize: 2048,
    shadowCameraExtent: 60,
    shadowCameraNear: 1,
    shadowCameraFar: 120,
  },
  fill: {
    color: 0xaec6ff as THREE.ColorRepresentation, // cool sky
    intensity: 0.45,
    position: [-40, 30, 20] as [number, number, number],
  },
  rim: {
    color: 0x2244aa as THREE.ColorRepresentation, // cool back rim
    intensity: 0.55,
    position: [-50, 12, -50] as [number, number, number],
  },
} as const;

/**
 * "moody" preset — a dark, single-source dramatic rig. The opposite of the
 * warm daylight default.
 *
 * Distilled from storm-break-hockey's play-scene rig (src/render/ThreeSetup.js),
 * whose essence is: a near-black scene, one strong overhead key, deep shadows,
 * and exponential fog swallowing everything past the key's pool of light.
 * Concrete Storm-Break values that shaped this preset:
 *   - ambient  AmbientLight(0x0e0d16, 2.0)  — near-black indigo, barely-there fill
 *   - key      SpotLight(GOLD 0xD4AF37, 220, decay 1.8) from directly overhead (0,22,0),
 *              castShadow with a 2048 map, near 1 / far 60
 *   - rim      DirectionalLight(0x2244aa, 0.55) cool blue back light
 *   - fog      FogExp2(0x080808, 0.009) + a 0x080808 background
 *
 * We keep the single-key + deep-shadow + fog essence but swap Storm-Break's
 * GOLD brand key for a COLD steel-white key (0xbcd2ff) so the preset reads as a
 * generic dramatic mood rather than a hockey-specific gold look. The daylight
 * rig's `fill` is dropped (moody wants ONE source), and the rim is kept dim and
 * cool for a sliver of shape on the shadow side. `fog` is a pure-data hook the
 * caller can apply to their scene (the rig itself never mutates scene.fog).
 */
export const MOODY = {
  ambient: {
    color: 0x0e0d16 as THREE.ColorRepresentation, // near-black indigo
    intensity: 0.08, // near-nil fill — deep shadows survive
  },
  /** Single strong COLD key, high + overhead, deep shadows. */
  sun: {
    color: 0xbcd2ff as THREE.ColorRepresentation, // cold steel-white
    intensity: 2.6,
    position: [8, 60, 12] as [number, number, number], // high, near-overhead
    castShadow: true,
    shadowMapSize: 2048,
    shadowCameraExtent: 60,
    shadowCameraNear: 1,
    shadowCameraFar: 120,
  },
  /** No fill — a moody rig is single-source. */
  fill: false as const,
  /** Dim, cool rim for a sliver of edge definition on the shadow side. */
  rim: {
    color: 0x2244aa as THREE.ColorRepresentation, // cool blue back rim
    intensity: 0.35,
    position: [-50, 20, -50] as [number, number, number],
  },
  /**
   * Optional atmospheric fog hook (pure data — the rig does NOT mutate the
   * scene's fog). Apply with e.g.
   *   scene.fog = new THREE.FogExp2(MOODY.fog.color, MOODY.fog.density);
   *   scene.background = new THREE.Color(MOODY.fog.color);
   */
  fog: {
    color: 0x080808 as THREE.ColorRepresentation, // near-black void
    density: 0.012, // exponential fog; slightly denser than Storm-Break's 0.009
  },
} as const;

/**
 * All named lighting presets, keyed by name. `daylight` is the warm three-point
 * default (`LIGHTING_DEFAULTS`); `moody` is the dark single-source rig (`MOODY`).
 */
export const LIGHTING_PRESETS: Record<LightingPreset, LightingPresetValues> = {
  daylight: LIGHTING_DEFAULTS,
  moody: MOODY,
};

export interface LightingRigConfig {
  /**
   * Named preset to base the rig on. Defaults to "daylight" (the warm
   * three-point rig) so existing callers are unaffected. "moody" selects the
   * dark single-source `MOODY` rig. Any of the per-light fields below still
   * override the chosen preset's values.
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

export interface LightingRig {
  ambient: THREE.AmbientLight;
  sun: THREE.DirectionalLight;
  fill?: THREE.DirectionalLight;
  rim?: THREE.DirectionalLight;
}

/**
 * Build and attach a lighting rig to `scene`. Returns the created lights so the
 * caller can tweak/animate them. For soft shadows, set the renderer's
 * shadowMap.type to THREE.PCFSoftShadowMap.
 */
export function createLightingRig(
  scene: THREE.Scene,
  config: LightingRigConfig = {},
): LightingRig {
  // Resolve which preset's values seed the fallback chain. "daylight" (the warm
  // three-point rig) is the default so existing callers are unaffected; "moody"
  // seeds from MOODY (dark, single-source). Per-light config still overrides.
  const base = LIGHTING_PRESETS[config.preset ?? 'daylight'];

  // ── Ambient fill ───────────────────────────────────────────────────────────
  const ambient = new THREE.AmbientLight(
    config.ambient?.color ?? base.ambient.color,
    config.ambient?.intensity ?? base.ambient.intensity,
  );
  scene.add(ambient);

  // ── Shadow-casting key / sun ───────────────────────────────────────────────
  const sunCfg = config.sun ?? {};
  const sun = new THREE.DirectionalLight(
    sunCfg.color ?? base.sun.color,
    sunCfg.intensity ?? base.sun.intensity,
  );
  const sunPos = sunCfg.position ?? base.sun.position;
  sun.position.set(sunPos[0], sunPos[1], sunPos[2]);
  sun.castShadow = sunCfg.castShadow ?? base.sun.castShadow;

  const mapSize = sunCfg.shadowMapSize ?? base.sun.shadowMapSize;
  sun.shadow.mapSize.set(mapSize, mapSize);
  sun.shadow.camera.near = sunCfg.shadowCameraNear ?? base.sun.shadowCameraNear;
  sun.shadow.camera.far = sunCfg.shadowCameraFar ?? base.sun.shadowCameraFar;
  const extent = sunCfg.shadowCameraExtent ?? base.sun.shadowCameraExtent;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const rig: LightingRig = { ambient, sun };

  // ── Optional fill ──────────────────────────────────────────────────────────
  // The preset's own `fill` may be `false` (moody drops the fill for a
  // single-source look); an explicit `config.fill` still wins either way.
  const fillResolved = config.fill ?? base.fill;
  if (fillResolved !== false) {
    const fillCfg = fillResolved;
    // Fall back to the daylight fill values when the active preset has no fill
    // of its own (e.g. moody), so an opt-in `config.fill: {}` still works.
    const fillBase = base.fill !== false ? base.fill : LIGHTING_DEFAULTS.fill;
    const fill = new THREE.DirectionalLight(
      fillCfg.color ?? fillBase.color,
      fillCfg.intensity ?? fillBase.intensity,
    );
    const fillPos = fillCfg.position ?? fillBase.position;
    fill.position.set(fillPos[0], fillPos[1], fillPos[2]);
    scene.add(fill);
    rig.fill = fill;
  }

  // ── Optional rim / back light ──────────────────────────────────────────────
  const rimResolved = config.rim ?? base.rim;
  if (rimResolved !== false) {
    const rimCfg = rimResolved;
    const rimBase = base.rim !== false ? base.rim : LIGHTING_DEFAULTS.rim;
    const rim = new THREE.DirectionalLight(
      rimCfg.color ?? rimBase.color,
      rimCfg.intensity ?? rimBase.intensity,
    );
    const rimPos = rimCfg.position ?? rimBase.position;
    rim.position.set(rimPos[0], rimPos[1], rimPos[2]);
    scene.add(rim);
    rig.rim = rim;
  }

  return rig;
}
