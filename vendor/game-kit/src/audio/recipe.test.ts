import { describe, it, expect } from 'vitest';
// Straight from the vendored game-kit source. The recipe renderer is pure (no DOM /
// AudioContext), so this suite needs no stubs — we never touch the Web-Audio runtime.
import {
  renderRecipeSamples,
  encodeWav,
  renderRecipeToWav,
  SFX_PRESETS,
  type AudioRecipe,
} from './recipe.js';

/** Read a little-endian ASCII tag from WAV bytes. */
function tag(bytes: Uint8Array, offset: number, len: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + len));
}

/** Read a little-endian uint32 from WAV bytes. */
function u32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);
}

/** Peak absolute sample amplitude. */
function peak(a: Float32Array): number {
  return Math.max(0, ...Array.from(a, Math.abs));
}

describe('renderRecipeSamples', () => {
  it('sizes the track to the latest event end', () => {
    const recipe: AudioRecipe = {
      sampleRate: 1000,
      events: [{ type: 'tone', freq: 100, startSec: 0, durationSec: 0.5, gain: 1 }],
    };
    expect(renderRecipeSamples(recipe)).toHaveLength(500);
  });

  it('renders silence (empty buffer) for no events', () => {
    expect(renderRecipeSamples({ sampleRate: 44100, events: [] })).toHaveLength(0);
  });

  it('keeps every sample within [-1, 1] even when events overlap', () => {
    const out = renderRecipeSamples({
      sampleRate: 8000,
      events: [
        { type: 'tone', freq: 440, startSec: 0, durationSec: 0.2, gain: 1 },
        { type: 'tone', freq: 660, startSec: 0, durationSec: 0.2, gain: 1 },
        { type: 'noise', startSec: 0, durationSec: 0.2, gain: 1 },
      ],
    });
    for (const s of out) {
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('applies an attack/release envelope (starts and ends near zero)', () => {
    const out = renderRecipeSamples({
      sampleRate: 8000,
      events: [{ type: 'tone', freq: 200, startSec: 0, durationSec: 0.3, gain: 1 }],
    });
    expect(Math.abs(out[0] ?? 0)).toBeLessThan(0.05);
    expect(Math.abs(out[out.length - 1] ?? 0)).toBeLessThan(0.05);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit PCM mono RIFF/WAVE header', () => {
    const samples = renderRecipeSamples({
      sampleRate: 8000,
      events: [{ type: 'tone', freq: 200, startSec: 0, durationSec: 0.1, gain: 1 }],
    });
    const wav = encodeWav(samples, 8000);
    expect(tag(wav, 0, 4)).toBe('RIFF');
    expect(tag(wav, 8, 4)).toBe('WAVE');
    expect(tag(wav, 12, 4)).toBe('fmt ');
    expect(tag(wav, 36, 4)).toBe('data');
    expect(wav.length).toBe(44 + samples.length * 2);
    expect(u32(wav, 40)).toBe(samples.length * 2); // data chunk size
    expect(u32(wav, 24)).toBe(8000); // sample rate
  });
});

describe('renderRecipeToWav', () => {
  it('renders a recipe straight to non-empty WAV bytes', () => {
    const wav = renderRecipeToWav({
      sampleRate: 22050,
      events: [{ type: 'tone', freq: 440, startSec: 0, durationSec: 0.25, gain: 0.8 }],
    });
    expect(tag(wav, 0, 4)).toBe('RIFF');
    expect(wav.length).toBeGreaterThan(44);
  });
});

describe('SFX_PRESETS', () => {
  const names = Object.keys(SFX_PRESETS) as (keyof typeof SFX_PRESETS)[];
  const expected = [
    'impact',
    'footstep',
    'pickup',
    'coin',
    'ui-click',
    'ui-confirm',
    'ui-back',
    'menu-tick',
    'menu-confirm',
    'hit',
    'error',
    'level-up',
    'whoosh',
  ];

  it('ships the full common-sound library', () => {
    for (const n of expected) expect(names).toContain(n);
  });

  it('every preset is a well-formed recipe (valid sampleRate + events)', () => {
    for (const name of names) {
      const recipe = SFX_PRESETS[name];
      expect(recipe.sampleRate).toBeGreaterThan(0);
      expect(Number.isFinite(recipe.sampleRate)).toBe(true);
      expect(recipe.events.length).toBeGreaterThan(0);
      for (const e of recipe.events) {
        expect(e.type === 'tone' || e.type === 'noise').toBe(true);
        expect(e.startSec).toBeGreaterThanOrEqual(0);
        expect(e.durationSec).toBeGreaterThan(0);
        expect(e.gain).toBeGreaterThan(0);
        expect(e.gain).toBeLessThanOrEqual(1);
        if (e.type === 'tone') expect(e.freq === undefined || e.freq > 0).toBe(true);
      }
    }
  });

  it('every preset bakes to a valid, non-silent WAV', () => {
    for (const name of names) {
      const recipe = SFX_PRESETS[name];
      const samples = renderRecipeSamples(recipe);
      expect(samples.length).toBeGreaterThan(0);
      // Non-silent: at least one audible sample. (Noise-only presets still peak > 0.)
      expect(peak(samples)).toBeGreaterThan(0.01);

      const wav = renderRecipeToWav(recipe);
      expect(tag(wav, 0, 4)).toBe('RIFF');
      expect(tag(wav, 8, 4)).toBe('WAVE');
      expect(wav.length).toBe(44 + samples.length * 2);
    }
  });

  it('every preset envelope starts and ends near zero (no clicks)', () => {
    for (const name of names) {
      const out = renderRecipeSamples(SFX_PRESETS[name]);
      expect(Math.abs(out[0] ?? 0)).toBeLessThan(0.05);
      expect(Math.abs(out[out.length - 1] ?? 0)).toBeLessThan(0.05);
    }
  });
});
