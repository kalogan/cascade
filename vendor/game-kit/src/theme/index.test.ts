import { describe, it, expect } from 'vitest';
import {
  resolveTheme,
  themeFromIdentity,
  isValidHex,
  THEMES,
  type ThemeDef,
} from './index.js';

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function baseTheme(): ThemeDef {
  return {
    id: 'base',
    name: 'Base World',
    palette: {
      bg: '#111111',
      surface: '#222222',
      text: '#eeeeee',
      accent: '#3366ff',
      glow: '#66ccff',
      tiles: ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'],
    },
    backdrop: {
      sky: ['#000011', '#001133'],
      fog: '#112244',
      parallax: [{ color: '#334455', y: 0.5, amp: 0.1, speed: 0.2 }],
    },
    audio: { scaleSemitones: [0, 2, 4, 5, 7, 9, 11], rootHz: 220 },
    tileSkin: 'gem',
  };
}

// ── resolveTheme ─────────────────────────────────────────────────────────────

describe('resolveTheme', () => {
  it('overrides win for top-level scalar fields', () => {
    const base = baseTheme();
    const result = resolveTheme(base, { id: 'variant', name: 'Variant World', tileSkin: 'leaf' });
    expect(result.id).toBe('variant');
    expect(result.name).toBe('Variant World');
    expect(result.tileSkin).toBe('leaf');
  });

  it('never mutates the base input', () => {
    const base = baseTheme();
    const snapshot = JSON.parse(JSON.stringify(base));
    resolveTheme(base, {
      id: 'variant',
      palette: { ...base.palette, accent: '#ff9900', tiles: ['#111111'] } as ThemeDef['palette'],
      backdrop: { sky: ['#ffffff', '#000000'] },
    });
    expect(base).toEqual(snapshot);
  });

  it('never mutates the overrides input', () => {
    const base = baseTheme();
    const overrides = { palette: { ...base.palette, accent: '#ff9900' } };
    const snapshot = JSON.parse(JSON.stringify(overrides));
    resolveTheme(base, overrides as Partial<ThemeDef>);
    expect(overrides).toEqual(snapshot);
  });

  it('deep-merges a partial palette override, preserving untouched fields', () => {
    const base = baseTheme();
    const result = resolveTheme(base, { palette: { accent: '#ff9900' } } as Partial<ThemeDef>);
    expect(result.palette.accent).toBe('#ff9900');
    expect(result.palette.bg).toBe(base.palette.bg);
    expect(result.palette.surface).toBe(base.palette.surface);
    expect(result.palette.text).toBe(base.palette.text);
    expect(result.palette.tiles).toEqual(base.palette.tiles);
  });

  it('deep-merges a partial backdrop override, preserving sky when only fog changes', () => {
    const base = baseTheme();
    const result = resolveTheme(base, { backdrop: { fog: '#ff0000' } } as Partial<ThemeDef>);
    expect(result.backdrop.fog).toBe('#ff0000');
    expect(result.backdrop.sky).toEqual(base.backdrop.sky);
    expect(result.backdrop.parallax).toEqual(base.backdrop.parallax);
  });

  it('deep-merges a partial audio override, preserving scaleSemitones when only rootHz changes', () => {
    const base = baseTheme();
    const result = resolveTheme(base, { audio: { rootHz: 440 } } as Partial<ThemeDef>);
    expect(result.audio.rootHz).toBe(440);
    expect(result.audio.scaleSemitones).toEqual(base.audio.scaleSemitones);
  });

  it('replaces arrays wholesale rather than merging element-wise', () => {
    const base = baseTheme();
    const result = resolveTheme(base, {
      palette: { tiles: ['#101010', '#202020'] },
    } as Partial<ThemeDef>);
    expect(result.palette.tiles).toEqual(['#101010', '#202020']);
    expect(result.palette.tiles).not.toEqual(base.palette.tiles);
  });

  it('with empty overrides, produces a deep-equal-but-independent clone of base', () => {
    const base = baseTheme();
    const result = resolveTheme(base, {});
    expect(result).toEqual(base);
    expect(result.palette.tiles).not.toBe(base.palette.tiles);
    expect(result.backdrop.sky).not.toBe(base.backdrop.sky);
    // mutating the result must never leak back into base
    result.palette.tiles.push('#abcabc');
    result.backdrop.sky[0] = '#ffffff';
    expect(base.palette.tiles).toHaveLength(6);
    expect(base.backdrop.sky[0]).toBe('#000011');
  });

  it('supports chained resolution (world -> level override)', () => {
    const world = baseTheme();
    const level = resolveTheme(world, { name: 'Level 3', audio: { rootHz: 330 } } as Partial<ThemeDef>);
    const levelVariant = resolveTheme(level, { palette: { accent: '#00ff99' } } as Partial<ThemeDef>);
    expect(levelVariant.name).toBe('Level 3');
    expect(levelVariant.audio.rootHz).toBe(330);
    expect(levelVariant.palette.accent).toBe('#00ff99');
    expect(levelVariant.palette.bg).toBe(world.palette.bg);
  });
});

// ── themeFromIdentity ────────────────────────────────────────────────────────

describe('themeFromIdentity', () => {
  it('is deterministic: same string token twice -> deep-equal theme', () => {
    const a = themeFromIdentity('crucible-forest');
    const b = themeFromIdentity('crucible-forest');
    expect(a).toEqual(b);
  });

  it('is deterministic: same numeric token twice -> deep-equal theme', () => {
    const a = themeFromIdentity(42);
    const b = themeFromIdentity(42);
    expect(a).toEqual(b);
  });

  it('diverges across different tokens', () => {
    const a = themeFromIdentity('alpha-world');
    const b = themeFromIdentity('omega-world-9000');
    expect(a).not.toEqual(b);
  });

  it('produces a fully-formed ThemeDef with >=6 valid-hex tile colors', () => {
    const theme = themeFromIdentity('sample-token');
    expect(theme.palette.tiles.length).toBeGreaterThanOrEqual(6);
    for (const hex of theme.palette.tiles) expect(isValidHex(hex)).toBe(true);
    expect(isValidHex(theme.palette.bg)).toBe(true);
    expect(isValidHex(theme.palette.surface)).toBe(true);
    expect(isValidHex(theme.palette.text)).toBe(true);
    expect(isValidHex(theme.palette.accent)).toBe(true);
    expect(isValidHex(theme.palette.glow)).toBe(true);
    expect(isValidHex(theme.backdrop.sky[0])).toBe(true);
    expect(isValidHex(theme.backdrop.sky[1])).toBe(true);
    expect(theme.audio.scaleSemitones.length).toBeGreaterThan(0);
    expect(typeof theme.audio.rootHz).toBe('number');
    expect(typeof theme.tileSkin).toBe('string');
  });

  it('generates a tile ramp with no duplicate colors', () => {
    const theme = themeFromIdentity('ramp-check');
    const unique = new Set(theme.palette.tiles);
    expect(unique.size).toBe(theme.palette.tiles.length);
  });
});

// ── THEMES (authored worlds) ─────────────────────────────────────────────────

describe('THEMES', () => {
  it('authors at least 3 worlds', () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(3);
  });

  it('every world has >=6 tile colors, all valid hex, and distinct within the theme', () => {
    for (const theme of THEMES) {
      expect(theme.palette.tiles.length).toBeGreaterThanOrEqual(6);
      for (const hex of theme.palette.tiles) expect(HEX_RE.test(hex)).toBe(true);
      expect(new Set(theme.palette.tiles).size).toBe(theme.palette.tiles.length);
    }
  });

  it('every world has fully valid hex colors across palette + backdrop', () => {
    for (const theme of THEMES) {
      expect(HEX_RE.test(theme.palette.bg)).toBe(true);
      expect(HEX_RE.test(theme.palette.surface)).toBe(true);
      expect(HEX_RE.test(theme.palette.text)).toBe(true);
      expect(HEX_RE.test(theme.palette.accent)).toBe(true);
      expect(HEX_RE.test(theme.palette.glow)).toBe(true);
      expect(HEX_RE.test(theme.backdrop.sky[0])).toBe(true);
      expect(HEX_RE.test(theme.backdrop.sky[1])).toBe(true);
      if (theme.backdrop.fog) expect(HEX_RE.test(theme.backdrop.fog)).toBe(true);
      for (const band of theme.backdrop.parallax ?? []) {
        expect(HEX_RE.test(band.color)).toBe(true);
      }
    }
  });

  it('every world has at least one parallax band', () => {
    for (const theme of THEMES) {
      expect((theme.backdrop.parallax ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('has distinct sky gradients across worlds', () => {
    const skies = THEMES.map((t) => t.backdrop.sky.join('->'));
    expect(new Set(skies).size).toBe(THEMES.length);
  });

  it('has distinct audio (scale or root) across worlds', () => {
    const audioKeys = THEMES.map((t) => `${t.audio.scaleSemitones.join(',')}@${t.audio.rootHz}`);
    expect(new Set(audioKeys).size).toBe(THEMES.length);
  });

  it('has distinct ids and names across worlds', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
  });

  it('reads as a soft gentle -> grand band: root pitch generally descends, mood cools', () => {
    const [gentle, mid, grand] = THEMES;
    expect(gentle).toBeDefined();
    expect(mid).toBeDefined();
    expect(grand).toBeDefined();
    // "grand" world's root sits lower (deeper/more dramatic) than the "gentle" opener.
    expect(grand!.audio.rootHz).toBeLessThan(gentle!.audio.rootHz);
  });
});

// ── isValidHex ────────────────────────────────────────────────────────────────

describe('isValidHex', () => {
  it('accepts #rgb and #rrggbb forms', () => {
    expect(isValidHex('#fff')).toBe(true);
    expect(isValidHex('#a1b2c3')).toBe(true);
    expect(isValidHex('#FFAA00')).toBe(true);
  });

  it('rejects malformed strings', () => {
    expect(isValidHex('fff')).toBe(false);
    expect(isValidHex('#gggggg')).toBe(false);
    expect(isValidHex('#ffff')).toBe(false);
    expect(isValidHex('rgb(0,0,0)')).toBe(false);
  });
});
