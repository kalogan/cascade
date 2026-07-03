/**
 * identity — the anti-sameness primitive.
 *
 * Turns ONE seed or token into a COHERENT, DISTINCT visual+audio identity, so
 * games scaffolded from the same template stop looking like clones. This is
 * possibility-space design, NOT noise: a seed first weighted-picks a curated
 * MOOD ARCHETYPE (which bundles a palette family, a lighting/postfx rig, an
 * audio character, and a geometry style that all BELONG TOGETHER), then applies
 * controlled per-seed jitter WITHIN that mood's ranges. Two mood picks are the
 * big divergence; the jitter makes two seeds inside the same mood still differ.
 *
 * THREE-FREE + PURE: no three import, no Math.random, no Date.now. The output
 * is a plain serializable bundle whose sub-shapes plug straight into the kit's
 * consuming modules:
 *   - `identity.palette`  → createPalette(colors)         (palette/index.ts)
 *   - `identity.lighting` → createLightingRig(scene, cfg) (lighting/index.ts)
 *   - `identity.postfx`   → createPostFx(..., opts)       (postfx/index.ts)
 *   - `identity.audio`    → drive recipe scale/tempo/timbre (audio/recipe.ts)
 *   - `identity.geometry` → jitterVerts(geo, rng, amount) (geo/index.ts)
 *
 * Same token → identical identity (deep-equal). Different tokens → visible
 * divergence across most channels.
 */

import {
  createRng,
  hashStringToSeed,
  weightedPick,
  type Rng,
  type WeightedEntry,
} from '../prng/index.js';
import type { LightingPreset } from '../lighting/index.js';
import type { PostFxPreset } from '../postfx/index.js';
import type { AudioWave } from '../audio/recipe.js';

// ── output shapes ───────────────────────────────────────────────────────────

/**
 * A named colour family, ready to hand straight to `createPalette`. The keys are
 * a stable, semantic contract every mood provides, so a generator can always ask
 * for `palette.color('primary')`, `'accent'`, `'bg'`, etc. regardless of mood.
 */
export interface IdentityPalette {
  /** Hand this to `createPalette(colors)`. Values are `#rrggbb` strings. */
  colors: {
    bg: string;
    surface: string;
    primary: string;
    secondary: string;
    accent: string;
    /** The colour meant for emissive/bloom-popping materials. */
    glow: string;
  };
}

/**
 * Lighting choice for the identity. `preset` selects the kit's named rig; the
 * optional overrides are the seed-jittered tweaks — pass the whole object as the
 * `LightingRigConfig` to `createLightingRig`.
 */
export interface IdentityLighting {
  preset: LightingPreset;
  ambient: { intensity: number };
  sun: { intensity: number };
}

/**
 * Post-processing choice. `preset` selects the kit's named bloom profile; `bloom`
 * carries the seed-jittered strength/radius/threshold. Pass the whole object as
 * `PostFxOptions` to `createPostFx`.
 */
export interface IdentityPostFx {
  preset: PostFxPreset;
  bloom: { strength: number; radius: number; threshold: number };
}

/** Named pitch-class scales (semitone offsets from a root) the audio can use. */
export type IdentityScaleName =
  | 'minor'
  | 'major'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'pentatonic-minor';

/**
 * Audio character. Everything a recipe generator needs to place notes: the scale
 * (semitone offsets), a root frequency, a tempo BAND (min/max BPM the seed lands
 * within), and the dominant timbre (oscillator wave). Feeds the audio recipe
 * params (scale/tempo/timbre) described in audio/recipe.ts.
 */
export interface IdentityAudio {
  scale: IdentityScaleName;
  /** Semitone offsets of the scale from the root (e.g. natural minor). */
  scaleSemitones: number[];
  /** Root note frequency in Hz. */
  rootHz: number;
  /** Tempo in BPM (a seed-jittered value inside the mood's tempo band). */
  tempo: number;
  /** The band the tempo was drawn from, for callers that want the range. */
  tempoBand: { min: number; max: number };
  /** Dominant oscillator waveform — the mood's timbre. */
  timbre: AudioWave;
}

/**
 * Geometry style. `jitter` is the max per-axis vertex displacement to pass as the
 * `amount` arg to `jitterVerts`; the rest are faceting/scale knobs a low-poly
 * generator can consume.
 */
export interface IdentityGeometry {
  /** Named silhouette style. */
  style: 'chunky' | 'crystalline' | 'organic' | 'brutalist';
  /** Max per-axis vertex displacement → the `amount` arg of `jitterVerts`. */
  jitter: number;
  /** Rough facet coarseness knob (0..1); higher = blockier subdivisions. */
  facetCoarseness: number;
  /** Overall proportion bias: <1 squat, >1 tall. */
  proportion: number;
}

/** Optional motion character — animation cadence hooks for a game to read. */
export interface IdentityMotion {
  /** Idle bob/sway speed multiplier. */
  swaySpeed: number;
  /** Ambient bob amplitude (world units). */
  bobAmplitude: number;
}

/** The full deterministic identity bundle. */
export interface Identity {
  /** The numeric seed the identity was derived from (a token is hashed to this). */
  seed: number;
  /** The name of the mood archetype this identity belongs to. */
  mood: IdentityMoodName;
  palette: IdentityPalette;
  lighting: IdentityLighting;
  postfx: IdentityPostFx;
  audio: IdentityAudio;
  geometry: IdentityGeometry;
  motion: IdentityMotion;
}

// ── curated archetype tables ────────────────────────────────────────────────
//
// Each MOOD is a coherent bundle: a palette family, a lighting+postfx rig, an
// audio character, and a geometry style chosen to belong together. The seed
// picks a mood (weighted), then jitters WITHIN the mood's ranges. Coherence is
// structural — channels are never sampled independently.

export type IdentityMoodName =
  | 'ember'
  | 'abyssal'
  | 'verdant'
  | 'frostbite'
  | 'arcane';

/** A palette family: a small set of colour options per semantic slot. */
interface MoodPaletteOptions {
  bg: readonly string[];
  surface: readonly string[];
  primary: readonly string[];
  secondary: readonly string[];
  accent: readonly string[];
  glow: readonly string[];
}

interface MoodArchetype {
  name: IdentityMoodName;
  /** Relative likelihood this mood is chosen. */
  weight: number;
  palette: MoodPaletteOptions;
  lighting: {
    preset: LightingPreset;
    ambient: { min: number; max: number };
    sun: { min: number; max: number };
  };
  postfx: {
    preset: PostFxPreset;
    strength: { min: number; max: number };
    radius: { min: number; max: number };
    threshold: { min: number; max: number };
  };
  audio: {
    scales: readonly IdentityScaleName[];
    rootHz: readonly number[];
    tempoBand: { min: number; max: number };
    timbres: readonly AudioWave[];
  };
  geometry: {
    styles: readonly IdentityGeometry['style'][];
    jitter: { min: number; max: number };
    facetCoarseness: { min: number; max: number };
    proportion: { min: number; max: number };
  };
  motion: {
    swaySpeed: { min: number; max: number };
    bobAmplitude: { min: number; max: number };
  };
}

/** Named pitch-class scales as semitone offsets from the root. */
const SCALE_SEMITONES: Record<IdentityScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  'pentatonic-minor': [0, 3, 5, 7, 10],
};

/**
 * The five curated moods. Warm/hot, dark/cold, natural, icy, and mystical — each
 * a self-consistent possibility space. Weights bias toward the two most generally
 * useful moods (ember, abyssal) without excluding the rest.
 */
const MOODS: readonly MoodArchetype[] = [
  {
    name: 'ember',
    weight: 3,
    palette: {
      bg: ['#1a0f0a', '#160c07', '#1f120b'],
      surface: ['#2e1a10', '#331d12', '#291609'],
      primary: ['#e0561f', '#d9531c', '#e8641f'],
      secondary: ['#8a2b12', '#7d2610', '#93301a'],
      accent: ['#f2a23a', '#f5b04a', '#ef992e'],
      glow: ['#ffb347', '#ff9838', '#ffc255'],
    },
    lighting: {
      preset: 'daylight',
      ambient: { min: 0.28, max: 0.42 },
      sun: { min: 0.7, max: 0.95 },
    },
    postfx: {
      preset: 'default',
      strength: { min: 0.7, max: 1.0 },
      radius: { min: 0.5, max: 0.7 },
      threshold: { min: 0.35, max: 0.45 },
    },
    audio: {
      scales: ['major', 'lydian', 'dorian'],
      rootHz: [220, 246.94, 261.63],
      tempoBand: { min: 108, max: 132 },
      timbres: ['sawtooth', 'square'],
    },
    geometry: {
      styles: ['chunky', 'brutalist'],
      jitter: { min: 0.04, max: 0.09 },
      facetCoarseness: { min: 0.5, max: 0.8 },
      proportion: { min: 0.85, max: 1.05 },
    },
    motion: {
      swaySpeed: { min: 0.9, max: 1.3 },
      bobAmplitude: { min: 0.04, max: 0.09 },
    },
  },
  {
    name: 'abyssal',
    weight: 3,
    palette: {
      bg: ['#05060a', '#04050b', '#070812'],
      surface: ['#0e1220', '#101526', '#0b0f1c'],
      primary: ['#3a5bd9', '#3452c9', '#4064e0'],
      secondary: ['#1b2a5e', '#182556', '#213268'],
      accent: ['#5ad1e0', '#4ec6d9', '#68d9e8'],
      glow: ['#7ee8f2', '#66dced', '#8ff0f8'],
    },
    lighting: {
      preset: 'moody',
      ambient: { min: 0.05, max: 0.12 },
      sun: { min: 2.2, max: 2.9 },
    },
    postfx: {
      preset: 'moody',
      strength: { min: 0.6, max: 0.85 },
      radius: { min: 0.3, max: 0.45 },
      threshold: { min: 0.14, max: 0.24 },
    },
    audio: {
      scales: ['minor', 'phrygian', 'pentatonic-minor'],
      rootHz: [130.81, 146.83, 164.81],
      tempoBand: { min: 60, max: 84 },
      timbres: ['sine', 'triangle'],
    },
    geometry: {
      styles: ['crystalline', 'brutalist'],
      jitter: { min: 0.02, max: 0.06 },
      facetCoarseness: { min: 0.2, max: 0.5 },
      proportion: { min: 1.0, max: 1.35 },
    },
    motion: {
      swaySpeed: { min: 0.4, max: 0.75 },
      bobAmplitude: { min: 0.02, max: 0.06 },
    },
  },
  {
    name: 'verdant',
    weight: 2,
    palette: {
      bg: ['#0c140d', '#0a120c', '#0e170f'],
      surface: ['#17251a', '#1a2a1d', '#142216'],
      primary: ['#4c9a3f', '#459039', '#54a646'],
      secondary: ['#2a5e2c', '#265628', '#316634'],
      accent: ['#c7d94e', '#bcd043', '#d2e259'],
      glow: ['#d8f06a', '#cce85e', '#e2f778'],
    },
    lighting: {
      preset: 'daylight',
      ambient: { min: 0.38, max: 0.5 },
      sun: { min: 0.8, max: 1.0 },
    },
    postfx: {
      preset: 'default',
      strength: { min: 0.55, max: 0.8 },
      radius: { min: 0.55, max: 0.75 },
      threshold: { min: 0.4, max: 0.5 },
    },
    audio: {
      scales: ['major', 'dorian', 'lydian'],
      rootHz: [196, 220, 233.08],
      tempoBand: { min: 88, max: 112 },
      timbres: ['triangle', 'sine'],
    },
    geometry: {
      styles: ['organic', 'chunky'],
      jitter: { min: 0.06, max: 0.12 },
      facetCoarseness: { min: 0.35, max: 0.65 },
      proportion: { min: 0.8, max: 1.1 },
    },
    motion: {
      swaySpeed: { min: 0.7, max: 1.05 },
      bobAmplitude: { min: 0.05, max: 0.1 },
    },
  },
  {
    name: 'frostbite',
    weight: 2,
    palette: {
      bg: ['#0a0f14', '#080d12', '#0c1218'],
      surface: ['#152029', '#17232d', '#121c24'],
      primary: ['#7fb0d9', '#74a8d2', '#8ab8e0'],
      secondary: ['#3e6280', '#385a76', '#456a8a'],
      accent: ['#dff1ff', '#d2eaff', '#eaf6ff'],
      glow: ['#bfe6ff', '#b0deff', '#cdeeff'],
    },
    lighting: {
      preset: 'moody',
      ambient: { min: 0.1, max: 0.18 },
      sun: { min: 2.0, max: 2.6 },
    },
    postfx: {
      preset: 'moody',
      strength: { min: 0.65, max: 0.9 },
      radius: { min: 0.35, max: 0.5 },
      threshold: { min: 0.2, max: 0.3 },
    },
    audio: {
      scales: ['minor', 'lydian', 'dorian'],
      rootHz: [174.61, 196, 220],
      tempoBand: { min: 72, max: 96 },
      timbres: ['sine', 'triangle'],
    },
    geometry: {
      styles: ['crystalline', 'brutalist'],
      jitter: { min: 0.01, max: 0.04 },
      facetCoarseness: { min: 0.15, max: 0.4 },
      proportion: { min: 1.05, max: 1.4 },
    },
    motion: {
      swaySpeed: { min: 0.3, max: 0.6 },
      bobAmplitude: { min: 0.01, max: 0.04 },
    },
  },
  {
    name: 'arcane',
    weight: 2,
    palette: {
      bg: ['#100a1c', '#0d0818', '#130c20'],
      surface: ['#1e1433', '#22173a', '#1a112e'],
      primary: ['#9a4cd9', '#8f43cf', '#a656e0'],
      secondary: ['#4d2a7a', '#472670', '#552f86'],
      accent: ['#e64ca8', '#dc43a0', '#ee59b2'],
      glow: ['#f26ad9', '#e85ecc', '#f87ee6'],
    },
    lighting: {
      preset: 'moody',
      ambient: { min: 0.08, max: 0.15 },
      sun: { min: 2.3, max: 3.0 },
    },
    postfx: {
      preset: 'moody',
      strength: { min: 0.7, max: 0.95 },
      radius: { min: 0.32, max: 0.48 },
      threshold: { min: 0.15, max: 0.25 },
    },
    audio: {
      scales: ['phrygian', 'minor', 'pentatonic-minor'],
      rootHz: [146.83, 155.56, 164.81],
      tempoBand: { min: 66, max: 90 },
      timbres: ['square', 'sawtooth'],
    },
    geometry: {
      styles: ['crystalline', 'organic'],
      jitter: { min: 0.03, max: 0.08 },
      facetCoarseness: { min: 0.25, max: 0.55 },
      proportion: { min: 0.95, max: 1.3 },
    },
    motion: {
      swaySpeed: { min: 0.5, max: 0.9 },
      bobAmplitude: { min: 0.03, max: 0.07 },
    },
  },
];

/** All mood names, in table order — the coherence contract for tests/callers. */
export const IDENTITY_MOODS: readonly IdentityMoodName[] = MOODS.map((m) => m.name);

// ── sampling helpers ─────────────────────────────────────────────────────────

/** Uniformly pick from a readonly array using one rng draw. Empty → throws. */
function pickFrom<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new RangeError('identity: cannot pick from empty array');
  const idx = Math.floor(rng.next() * arr.length);
  const v = arr[Math.min(idx, arr.length - 1)];
  if (v === undefined) throw new RangeError('identity: pick out of bounds (unreachable)');
  return v;
}

/** A seed-stable float within [min, max], rounded to `decimals` places. */
function jitterRange(rng: Rng, range: { min: number; max: number }, decimals = 3): number {
  const raw = range.min + rng.next() * (range.max - range.min);
  const f = 10 ** decimals;
  return Math.round(raw * f) / f;
}

// ── the primitive ────────────────────────────────────────────────────────────

/**
 * Derive a COHERENT, DISTINCT identity from a single seed or token.
 *
 * Pure + deterministic: `createIdentity(x)` deep-equals `createIdentity(x)` for
 * any x. A string token is hashed (FNV-1a) into a 32-bit seed so names seed as
 * readily as numbers.
 *
 * The pipeline:
 *   1. seed the PRNG,
 *   2. WEIGHTED-PICK one mood archetype (the big, coherent divergence),
 *   3. sample each channel WITHIN that mood's curated options + jitter its ranges
 *      (small per-seed divergence so two seeds in the same mood still differ).
 *
 * Every channel is drawn from a FORKED sub-stream so adding a field to one
 * channel never shifts the others' values — keeps identities stable across edits.
 */
export function createIdentity(seedOrToken: number | string): Identity {
  const seed =
    typeof seedOrToken === 'string' ? hashStringToSeed(seedOrToken) : seedOrToken >>> 0;

  const root = createRng(seed);

  // 1) The mood is the coherent bundle. Weighted so some moods are more common.
  const moodEntries: WeightedEntry<MoodArchetype>[] = MOODS.map((m) => ({
    value: m,
    weight: m.weight,
  }));
  const mood = weightedPick(root, moodEntries);

  // 2) Each channel gets its own forked stream (salted per-channel), so the
  //    identity is stable field-by-field.
  const pRng = root.fork(1); // palette
  const lRng = root.fork(2); // lighting
  const fRng = root.fork(3); // postfx
  const aRng = root.fork(4); // audio
  const gRng = root.fork(5); // geometry
  const mRng = root.fork(6); // motion

  const palette: IdentityPalette = {
    colors: {
      bg: pickFrom(pRng, mood.palette.bg),
      surface: pickFrom(pRng, mood.palette.surface),
      primary: pickFrom(pRng, mood.palette.primary),
      secondary: pickFrom(pRng, mood.palette.secondary),
      accent: pickFrom(pRng, mood.palette.accent),
      glow: pickFrom(pRng, mood.palette.glow),
    },
  };

  const lighting: IdentityLighting = {
    preset: mood.lighting.preset,
    ambient: { intensity: jitterRange(lRng, mood.lighting.ambient) },
    sun: { intensity: jitterRange(lRng, mood.lighting.sun) },
  };

  const postfx: IdentityPostFx = {
    preset: mood.postfx.preset,
    bloom: {
      strength: jitterRange(fRng, mood.postfx.strength),
      radius: jitterRange(fRng, mood.postfx.radius),
      threshold: jitterRange(fRng, mood.postfx.threshold),
    },
  };

  const scale = pickFrom(aRng, mood.audio.scales);
  const audio: IdentityAudio = {
    scale,
    scaleSemitones: SCALE_SEMITONES[scale].slice(),
    rootHz: pickFrom(aRng, mood.audio.rootHz),
    tempo: Math.round(jitterRange(aRng, mood.audio.tempoBand, 0)),
    tempoBand: { min: mood.audio.tempoBand.min, max: mood.audio.tempoBand.max },
    timbre: pickFrom(aRng, mood.audio.timbres),
  };

  const geometry: IdentityGeometry = {
    style: pickFrom(gRng, mood.geometry.styles),
    jitter: jitterRange(gRng, mood.geometry.jitter),
    facetCoarseness: jitterRange(gRng, mood.geometry.facetCoarseness),
    proportion: jitterRange(gRng, mood.geometry.proportion),
  };

  const motion: IdentityMotion = {
    swaySpeed: jitterRange(mRng, mood.motion.swaySpeed),
    bobAmplitude: jitterRange(mRng, mood.motion.bobAmplitude),
  };

  return { seed, mood: mood.name, palette, lighting, postfx, audio, geometry, motion };
}
