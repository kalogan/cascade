/**
 * theme — the scenery DNA layer.
 *
 * A `ThemeDef` bundles everything a match-3 world needs to look and sound like
 * a coherent PLACE: a palette (including a per-tile-kind tint ramp), a backdrop
 * (sky gradient + optional fog/parallax bands), an audio character (scale +
 * root), and a `tileSkin` naming which drawTile shape-set to render with.
 *
 * Mirrors project-mmo's `themes`: an INHERITANCE layer (a base theme resolved
 * with field-by-field overrides) rather than a flat enum, so a level/world can
 * start from a hand-authored world and tweak just what differs. Bands are soft
 * — "gentle -> grand" is a vibe progression across `THEMES`, not a hard gate.
 *
 * PURE + DETERMINISTIC: `resolveTheme` and `themeFromIdentity` never mutate
 * their inputs, never touch `Math.random`/`Date.now`, and never import `three`
 * or touch the DOM. `themeFromIdentity` composes the kit's `identity` primitive
 * (same token -> identical identity -> identical theme).
 */

import { createIdentity } from '../identity/index.js';

// ── public shapes ────────────────────────────────────────────────────────────

/** One parallax scenery band: a flat-tinted strip drifting behind the board. */
export interface ParallaxBand {
  color: string;
  /** Vertical anchor within the backdrop, 0 (top) .. 1 (bottom). */
  y: number;
  /** Bob amplitude (0..1-ish, backdrop-space units). */
  amp: number;
  /** Drift speed multiplier. */
  speed: number;
}

/** Sky gradient + optional atmosphere for a world's backdrop. */
export interface BackdropSpec {
  /** [topHex, bottomHex] vertical gradient. */
  sky: [string, string];
  /** Optional atmospheric fog tint. */
  fog?: string;
  /** Optional drifting scenery bands, back-to-front render order. */
  parallax?: ParallaxBand[];
}

/** A fully-resolved world skin: palette, backdrop, audio character, tile skin. */
export interface ThemeDef {
  id: string;
  name: string;
  palette: {
    bg: string;
    surface: string;
    text: string;
    accent: string;
    glow: string;
    /** Per-tile-kind tint ramp; index = TileKind. >=6 entries authored per world. */
    tiles: string[];
  };
  backdrop: BackdropSpec;
  audio: { scaleSemitones: number[]; rootHz: number };
  /** Which drawTile shape-set to render this world's tiles with (sprite-swap seam). */
  tileSkin: string;
}

// ── hex color helpers (pure; no DOM/canvas) ─────────────────────────────────

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True iff `s` is a valid `#rgb` or `#rrggbb` hex color string. */
export function isValidHex(s: string): boolean {
  return HEX_RE.test(s);
}

function expandHex(hex: string): string {
  if (hex.length === 4) {
    const r = hex[1] ?? '0';
    const g = hex[2] ?? '0';
    const b = hex[3] ?? '0';
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return hex;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = expandHex(hex).slice(1);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return [r, g, b];
}

/**
 * WCAG relative luminance of a hex color (0 = black, 1 = white), per the
 * sRGB → linear formula in WCAG 2.x. Used to keep tile-vs-board contrast honest.
 */
export function relativeLuminance(hex: string): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * WCAG contrast ratio between two hex colors (1:1 .. 21:1). SC 1.4.11
 * (Non-text Contrast) asks graphical objects to clear **3:1** against adjacent
 * colors — the bar the theme test holds every tile to versus its board surface.
 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (n: number) => clampByte(n).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Linear-mix two hex colors; t=0 -> a, t=1 -> b. */
function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

/** Lighten (amt > 0) or darken (amt < 0) a hex color toward white/black. */
function shadeHex(hex: string, amt: number): string {
  const target = amt >= 0 ? '#ffffff' : '#000000';
  return mixHex(hex, target, Math.min(1, Math.abs(amt)));
}

/** Relative luminance (0..1), used to pick a legible text color for a bg. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Deterministically nudge a hex color's channels by a small, index-derived amount. */
function nudgeHex(hex: string, salt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const d = (salt * 29) % 256;
  return rgbToHex((r + d) % 256, (g + d * 2) % 256, (b + d * 3) % 256);
}

/** Ensure every color in the list is distinct, nudging later duplicates deterministically. */
function ensureDistinctHex(colors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < colors.length; i++) {
    let c = (colors[i] ?? '#000000').toLowerCase();
    let guard = 0;
    while (seen.has(c) && guard < 32) {
      guard++;
      c = nudgeHex(c, i + 1 + guard);
    }
    seen.add(c);
    out.push(c);
  }
  return out;
}

// ── resolveTheme: pure deep-merge, overrides win ────────────────────────────

/**
 * Resolve a theme by deep-merging `overrides` onto `base`. Overrides win
 * field-by-field; nested `palette`/`backdrop`/`audio` objects are merged one
 * level deep (each present field replaces the base's), and arrays (tiles,
 * sky, parallax, scaleSemitones) are replaced WHOLESALE when the owning
 * nested object is provided in overrides — never element-merged.
 *
 * Pure: never mutates `base` or `overrides`; always returns fresh objects and
 * array copies, so aliasing the result can never retroactively change either
 * input.
 */
export function resolveTheme(base: ThemeDef, overrides: Partial<ThemeDef>): ThemeDef {
  const palette = { ...base.palette, ...(overrides.palette ?? {}) };
  const backdrop = { ...base.backdrop, ...(overrides.backdrop ?? {}) };
  const audio = { ...base.audio, ...(overrides.audio ?? {}) };

  return {
    id: overrides.id ?? base.id,
    name: overrides.name ?? base.name,
    palette: { ...palette, tiles: palette.tiles.slice() },
    backdrop: {
      ...backdrop,
      sky: [backdrop.sky[0], backdrop.sky[1]],
      parallax: backdrop.parallax ? backdrop.parallax.map((p) => ({ ...p })) : undefined,
    },
    audio: { ...audio, scaleSemitones: audio.scaleSemitones.slice() },
    tileSkin: overrides.tileSkin ?? base.tileSkin,
  };
}

// ── themeFromIdentity: generate a coherent theme from an identity token ────

function capitalize(s: string): string {
  return s.length === 0 ? s : (s[0] ?? '').toUpperCase() + s.slice(1);
}

/** Per-mood display suffixes so generated names read as a "world", not a mood dump. */
const MOOD_WORLD_SUFFIX: Record<string, string> = {
  ember: 'Cinder Reach',
  abyssal: 'Deep Current',
  verdant: 'Wild Glade',
  frostbite: 'Rime Hollow',
  arcane: 'Hidden Sigil',
};

/** Per-mood tile skin, echoing the identity's geometry vocabulary. */
const MOOD_TILE_SKIN: Record<string, string> = {
  ember: 'chunky',
  abyssal: 'crystalline',
  verdant: 'organic',
  frostbite: 'crystalline',
  arcane: 'crystalline',
};

/**
 * Deterministically derive a full `ThemeDef` from an identity token (a string
 * or number seed, hashed via `createIdentity`). Same token -> deep-equal
 * theme, always; different tokens diverge across palette/backdrop/audio.
 */
export function themeFromIdentity(token: string | number): ThemeDef {
  const identity = createIdentity(token);
  const { bg, surface, primary, secondary, accent, glow } = identity.palette.colors;

  const text = luminance(bg) < 0.5 ? '#f5f6f8' : '#101114';

  const tiles = ensureDistinctHex([
    primary,
    secondary,
    accent,
    glow,
    shadeHex(mixHex(primary, glow, 0.5), 0.15),
    shadeHex(mixHex(secondary, accent, 0.5), -0.15),
  ]);

  const skyTop = mixHex(bg, surface, 0.15);
  const skyBottom = mixHex(surface, accent, 0.35);

  const parallax: ParallaxBand[] = [
    {
      color: secondary,
      y: 0.6,
      amp: Math.min(0.2, Math.max(0.02, identity.motion.bobAmplitude * 2)),
      speed: Math.min(1, Math.max(0.05, identity.motion.swaySpeed * 0.4)),
    },
    {
      color: mixHex(glow, bg, 0.5),
      y: 0.8,
      amp: Math.min(0.15, Math.max(0.015, identity.motion.bobAmplitude * 1.2)),
      speed: Math.min(0.8, Math.max(0.03, identity.motion.swaySpeed * 0.2)),
    },
  ];

  return {
    id: `identity-${String(token)}`,
    name: `${capitalize(identity.mood)} ${MOOD_WORLD_SUFFIX[identity.mood] ?? 'Uncharted'}`,
    palette: { bg, surface, text, accent, glow, tiles },
    backdrop: {
      sky: [skyTop, skyBottom],
      fog: mixHex(bg, accent, 0.15),
      parallax,
    },
    audio: {
      scaleSemitones: identity.audio.scaleSemitones.slice(),
      rootHz: identity.audio.rootHz,
    },
    tileSkin: MOOD_TILE_SKIN[identity.mood] ?? 'chunky',
  };
}

// ── THEMES: hand-authored worlds, soft difficulty bands gentle -> grand ────

/**
 * World 1 — gentle. Soft greens, a warm cream-gold horizon; a calm major
 * scale in a comfortable mid register. The onboarding world.
 */
const VERDANT_GLADE: ThemeDef = {
  id: 'verdant-glade',
  name: 'Verdant Glade',
  palette: {
    // Board pulled down to a near-black green (was a mid-dark #16281a). The old
    // lighter, saturated-green board let the bright yellow-green glow bleed into
    // it as haze — tiles read "shiny/washed". A deep board makes the same glow a
    // crisp rim (the trick World 3 already relies on) while keeping the verdant
    // identity. Glow deepened a touch so it rims rather than blooms.
    bg: '#071009',
    surface: '#0e1a12',
    text: '#eef7e9',
    accent: '#8fd15a',
    glow: '#b4e86a',
    tiles: ['#5ea8d8', '#6fbf4a', '#e3c65a', '#e08a4e', '#b86bfd', '#7fd1c3'],
  },
  backdrop: {
    sky: ['#bfe3f0', '#fef3c2'],
    fog: '#dff2c8',
    parallax: [
      { color: '#9fd17a', y: 0.7, amp: 0.05, speed: 0.15 },
      { color: '#cfead0', y: 0.85, amp: 0.03, speed: 0.08 },
    ],
  },
  audio: { scaleSemitones: [0, 2, 4, 5, 7, 9, 11], rootHz: 261.63 },
  tileSkin: 'organic',
};

/**
 * World 2 — mid. Warm oranges/reds, a fiery dusk sky; a dorian scale a fifth
 * lower than world 1 so the two worlds are audibly distinct.
 */
const EMBER_REACH: ThemeDef = {
  id: 'ember-reach',
  name: 'Ember Reach',
  palette: {
    bg: '#1f0f0a',
    surface: '#2e150c',
    text: '#fff1e0',
    accent: '#f2872f',
    glow: '#ffb347',
    // Last tile brightened from #8a2f6e (only 2.21:1 vs the board — failed WCAG
    // SC 1.4.11's 3:1 for graphical objects; it vanished into the dark surface).
    tiles: ['#e0562a', '#f2a13a', '#c92f2f', '#3f6fae', '#2f8a6e', '#cf5aa2'],
  },
  backdrop: {
    sky: ['#3a120a', '#f2872f'],
    fog: '#6b2413',
    parallax: [
      { color: '#7a2f12', y: 0.6, amp: 0.08, speed: 0.25 },
      { color: '#c9531f', y: 0.8, amp: 0.05, speed: 0.4 },
    ],
  },
  audio: { scaleSemitones: [0, 2, 3, 5, 7, 9, 10], rootHz: 196 },
  tileSkin: 'chunky',
};

/**
 * World 3 — grand. Cool purples/cyans against a near-black cosmic sky, three
 * slow-drifting parallax bands, a phrygian scale on a low, dramatic root.
 */
const ASTRAL_DEEP: ThemeDef = {
  id: 'astral-deep',
  name: 'Astral Deep',
  palette: {
    bg: '#05060f',
    surface: '#0c1030',
    text: '#eaf2ff',
    accent: '#8a5cf0',
    glow: '#5adfe8',
    tiles: ['#8a5cf0', '#5adfe8', '#e85ecc', '#f2c14e', '#4fd18a', '#3a5bd9'],
  },
  backdrop: {
    sky: ['#05040c', '#241a4d'],
    fog: '#160f33',
    parallax: [
      { color: '#3a2a66', y: 0.5, amp: 0.1, speed: 0.05 },
      { color: '#5adfe8', y: 0.75, amp: 0.02, speed: 0.02 },
      { color: '#8a5cf0', y: 0.9, amp: 0.04, speed: 0.1 },
    ],
  },
  audio: { scaleSemitones: [0, 1, 3, 5, 7, 8, 10], rootHz: 130.81 },
  tileSkin: 'crystalline',
};

/** >=3 authored worlds forming a soft difficulty band, gentle -> grand. */
export const THEMES: ThemeDef[] = [VERDANT_GLADE, EMBER_REACH, ASTRAL_DEEP];
