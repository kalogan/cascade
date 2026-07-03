import { describe, it, expect } from 'vitest';
import {
  LIGHTING_DEFAULTS,
  MOODY,
  LIGHTING_PRESETS,
  type LightingPreset,
} from './index.js';
import { BLOOM_DEFAULTS, BLOOM_MOODY, BLOOM_PRESETS } from '../postfx/index.js';

// ── The "moody" lighting/postfx preset ───────────────────────────────────────
//
// These assert the PURE preset VALUES only (no THREE scene construction), so
// the suite is a fast, side-effect-free contract on the numbers distilled from
// storm-break-hockey's dramatic play rig. The rig-building code
// (`createLightingRig`) just seeds its fallback chain from these constants.

describe('MOODY lighting preset', () => {
  it('is the opposite of the warm daylight default', () => {
    // Near-nil dark ambient — deep shadows must survive.
    expect(MOODY.ambient.intensity).toBeLessThan(LIGHTING_DEFAULTS.ambient.intensity);
    expect(MOODY.ambient.intensity).toBeLessThanOrEqual(0.1);
    expect(MOODY.ambient.color).toBe(0x0e0d16); // near-black indigo (from Storm-Break)

    // One STRONG key — noticeably brighter than the daylight sun.
    expect(MOODY.sun.intensity).toBeGreaterThan(LIGHTING_DEFAULTS.sun.intensity);

    // ...and COLD, unlike the warm (0xfff1d6) daylight key.
    expect(MOODY.sun.color).toBe(0xbcd2ff); // cold steel-white
    expect(MOODY.sun.color).not.toBe(LIGHTING_DEFAULTS.sun.color);
  });

  it('casts deep shadows (2048 map, wide frustum)', () => {
    expect(MOODY.sun.castShadow).toBe(true);
    expect(MOODY.sun.shadowMapSize).toBe(2048);
    expect(MOODY.sun.shadowCameraExtent).toBe(60);
    // High + near-overhead key placement for a single dramatic pool of light.
    expect(MOODY.sun.position[1]).toBeGreaterThanOrEqual(40);
  });

  it('is single-source: no fill, dim cool rim', () => {
    // A moody rig drops the fill entirely.
    expect(MOODY.fill).toBe(false);
    // Rim is kept for a sliver of edge shape, but dimmer than the daylight rim.
    expect(MOODY.rim.intensity).toBeLessThan(LIGHTING_DEFAULTS.rim.intensity);
    expect(MOODY.rim.color).toBe(0x2244aa); // cool blue
  });

  it('exposes an optional fog hook (pure data)', () => {
    expect(MOODY.fog.color).toBe(0x080808); // near-black void (Storm-Break VOID)
    expect(MOODY.fog.density).toBeGreaterThan(0);
    expect(MOODY.fog.density).toBeLessThan(0.1);
  });

  it('is registered in LIGHTING_PRESETS under both preset names', () => {
    const names: LightingPreset[] = ['daylight', 'moody'];
    for (const n of names) expect(LIGHTING_PRESETS[n]).toBeDefined();
    expect(LIGHTING_PRESETS.daylight).toBe(LIGHTING_DEFAULTS);
    expect(LIGHTING_PRESETS.moody).toBe(MOODY);
  });
});

describe('BLOOM_MOODY postfx preset', () => {
  it('is a tight-radius, low-threshold profile vs the general default', () => {
    // Distilled from Storm-Break's play-rig UnrealBloomPass (0.70 / 0.38 / 0.18).
    expect(BLOOM_MOODY.strength).toBe(0.7);
    expect(BLOOM_MOODY.radius).toBe(0.38);
    expect(BLOOM_MOODY.threshold).toBe(0.18);

    // Tighter glow + lower punch-through threshold than the general-purpose look.
    expect(BLOOM_MOODY.radius).toBeLessThan(BLOOM_DEFAULTS.radius);
    expect(BLOOM_MOODY.threshold).toBeLessThan(BLOOM_DEFAULTS.threshold);
  });

  it('is registered in BLOOM_PRESETS', () => {
    expect(BLOOM_PRESETS.default).toBe(BLOOM_DEFAULTS);
    expect(BLOOM_PRESETS.moody).toBe(BLOOM_MOODY);
  });
});
