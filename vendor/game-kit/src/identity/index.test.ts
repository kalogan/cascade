import { describe, it, expect } from 'vitest';
import { createIdentity, IDENTITY_MOODS, type Identity } from './index.js';
import { createPalette } from '../palette/index.js';
import { createRng } from '../prng/index.js';

// identity is pure + THREE-free, so this suite needs no stubs. It asserts the
// three guarantees: STABILITY (same token → deep-equal), DIVERGENCE (two seeds
// differ across most channels), and COHERENCE (values live within the archetype
// tables). The weightedPick distribution is covered in ../prng/index.test.ts.

/** Flatten an identity into a comparable channel map for divergence checks. */
function channels(id: Identity): Record<string, unknown> {
  return {
    mood: id.mood,
    palette: JSON.stringify(id.palette.colors),
    lightingPreset: id.lighting.preset,
    ambient: id.lighting.ambient.intensity,
    sun: id.lighting.sun.intensity,
    postfxPreset: id.postfx.preset,
    bloomStrength: id.postfx.bloom.strength,
    scale: id.audio.scale,
    rootHz: id.audio.rootHz,
    tempo: id.audio.tempo,
    timbre: id.audio.timbre,
    geoStyle: id.geometry.style,
    jitter: id.geometry.jitter,
  };
}

describe('createIdentity — stability', () => {
  it('same numeric seed → deep-equal identity', () => {
    expect(createIdentity(12345)).toEqual(createIdentity(12345));
  });

  it('same string token → deep-equal identity', () => {
    expect(createIdentity('gyre')).toEqual(createIdentity('gyre'));
  });

  it('a token and its hashed seed produce the same identity', () => {
    // createIdentity hashes the token, so the numeric equivalent must match.
    const viaToken = createIdentity('living-dungeon');
    const viaSeed = createIdentity(viaToken.seed);
    expect(viaSeed).toEqual(viaToken);
  });

  it('is a plain, serializable (THREE-free) bundle', () => {
    const id = createIdentity('serialize-me');
    expect(() => JSON.parse(JSON.stringify(id))).not.toThrow();
    expect(JSON.parse(JSON.stringify(id))).toEqual(id);
  });
});

describe('createIdentity — divergence', () => {
  it('two different seeds differ across MOST channels', () => {
    const a = channels(createIdentity('alpha'));
    const b = channels(createIdentity('bravo'));
    const keys = Object.keys(a);
    const differing = keys.filter((k) => a[k] !== b[k]);
    // "distinct" — the majority of channels should visibly diverge.
    expect(differing.length).toBeGreaterThan(keys.length / 2);
  });

  it('exercises multiple moods across a spread of seeds (not one clone)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(createIdentity(i * 7919).mood);
    // With 5 weighted moods over 200 seeds we expect at least 3 distinct moods.
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('two seeds in the SAME mood still differ (within-mood jitter)', () => {
    // Find two seeds that landed on the same mood, then assert some channel moved.
    let found = false;
    const byMood = new Map<string, Identity>();
    for (let i = 0; i < 500 && !found; i++) {
      const id = createIdentity(i);
      const prev = byMood.get(id.mood);
      if (prev && prev.seed !== id.seed) {
        const a = channels(prev);
        const b = channels(id);
        const differing = Object.keys(a).filter((k) => a[k] !== b[k]);
        expect(differing.length).toBeGreaterThan(0);
        found = true;
      } else {
        byMood.set(id.mood, id);
      }
    }
    expect(found).toBe(true);
  });
});

describe('createIdentity — coherence', () => {
  it('every mood is one of the curated archetypes', () => {
    for (let i = 0; i < 100; i++) {
      expect(IDENTITY_MOODS).toContain(createIdentity(i * 131).mood);
    }
  });

  it('lighting/postfx presets are the kit\'s named presets', () => {
    for (let i = 0; i < 50; i++) {
      const id = createIdentity(i * 977);
      expect(['daylight', 'moody']).toContain(id.lighting.preset);
      expect(['default', 'moody']).toContain(id.postfx.preset);
      // moody lighting pairs with moody bloom; daylight with default — coherent.
      if (id.lighting.preset === 'moody') expect(id.postfx.preset).toBe('moody');
      if (id.lighting.preset === 'daylight') expect(id.postfx.preset).toBe('default');
    }
  });

  it('jittered numeric channels stay in sane ranges', () => {
    for (let i = 0; i < 100; i++) {
      const id = createIdentity(i * 313 + 1);
      expect(id.lighting.ambient.intensity).toBeGreaterThan(0);
      expect(id.lighting.ambient.intensity).toBeLessThan(1);
      expect(id.postfx.bloom.threshold).toBeGreaterThanOrEqual(0);
      expect(id.postfx.bloom.threshold).toBeLessThan(1);
      expect(id.geometry.jitter).toBeGreaterThan(0);
      expect(id.geometry.jitter).toBeLessThan(0.2);
      expect(id.audio.tempo).toBeGreaterThanOrEqual(id.audio.tempoBand.min);
      expect(id.audio.tempo).toBeLessThanOrEqual(id.audio.tempoBand.max);
    }
  });

  it('audio scale semitones are a valid, non-empty pitch set', () => {
    const id = createIdentity('scale-check');
    expect(id.audio.scaleSemitones.length).toBeGreaterThan(0);
    expect(id.audio.scaleSemitones[0]).toBe(0); // rooted at the tonic
    for (const s of id.audio.scaleSemitones) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(12);
    }
  });
});

describe('createIdentity — plugs into the consuming modules', () => {
  it('palette.colors is accepted by createPalette and every slot resolves', () => {
    const id = createIdentity('plug-palette');
    const palette = createPalette(id.palette.colors);
    for (const name of Object.keys(id.palette.colors)) {
      expect(palette.has(name)).toBe(true);
      // color() returns a THREE.Color clone — just assert it doesn't throw.
      expect(() => palette.color(name)).not.toThrow();
    }
  });

  it('geometry.jitter is a usable amount for jitterVerts-style displacement', () => {
    // jitterVerts consumes (rng() * 2 - 1) * amount per axis; assert the identity's
    // amount produces bounded, deterministic displacement for a fixed rng.
    const id = createIdentity('plug-geo');
    const rng = createRng(1);
    const disp = (rng.next() * 2 - 1) * id.geometry.jitter;
    expect(Math.abs(disp)).toBeLessThanOrEqual(id.geometry.jitter);
  });
});
