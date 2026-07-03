import { describe, it, expect } from 'vitest';
import {
  briefToIdentityToken,
  briefToScaffoldPicks,
  parseDesignBrief,
  type DesignBrief,
} from './index.js';

/** A minimal, valid DesignBrief — override fields per test via spread. */
function makeBrief(overrides: Partial<DesignBrief> = {}): DesignBrief {
  const base = parseDesignBrief({});
  if (!base) throw new Error('parseDesignBrief({}) unexpectedly failed');
  return { ...base, ...overrides };
}

describe('briefToIdentityToken', () => {
  it('combines title + art-direction mood', () => {
    const brief = makeBrief({
      title: 'Frost Peaks',
      artDirection: { palette: [], mood: 'cold and lonely', references: [] },
    });
    expect(briefToIdentityToken(brief)).toBe('Frost Peaks — cold and lonely');
  });

  it('falls back to the title alone when mood is blank', () => {
    const brief = makeBrief({
      title: 'Frost Peaks',
      artDirection: { palette: [], mood: '', references: [] },
    });
    expect(briefToIdentityToken(brief)).toBe('Frost Peaks');
  });

  it('falls back to the mood alone when title is blank', () => {
    const brief = makeBrief({
      title: '',
      artDirection: { palette: [], mood: 'cold and lonely', references: [] },
    });
    expect(briefToIdentityToken(brief)).toBe('cold and lonely');
  });

  it('is never empty — falls back to a constant when both are blank', () => {
    const brief = makeBrief({
      title: '',
      artDirection: { palette: [], mood: '', references: [] },
    });
    expect(briefToIdentityToken(brief)).toBe('untitled-game');
  });

  it('is deterministic for the same brief', () => {
    const brief = makeBrief({
      title: 'Deep Roots',
      artDirection: { palette: [], mood: 'verdant overgrowth', references: [] },
    });
    expect(briefToIdentityToken(brief)).toBe(briefToIdentityToken(brief));
  });

  it('different titles/moods yield different tokens', () => {
    const a = briefToIdentityToken(
      makeBrief({ title: 'Frost Peaks', artDirection: { palette: [], mood: 'cold', references: [] } }),
    );
    const b = briefToIdentityToken(
      makeBrief({ title: 'Ember Vale', artDirection: { palette: [], mood: 'warm', references: [] } }),
    );
    expect(a).not.toBe(b);
  });
});

describe('briefToScaffoldPicks — identityToken', () => {
  it('carries a non-empty identityToken derived from title + mood', () => {
    const brief = makeBrief({
      title: 'Frost Peaks',
      target: 'r3f',
      systems: [],
      artDirection: { palette: [], mood: 'cold and lonely', references: [] },
    });
    const picks = briefToScaffoldPicks(brief, []);
    expect(picks.identityToken).toBe('Frost Peaks — cold and lonely');
    expect(picks.identityToken.length).toBeGreaterThan(0);
  });

  it('matches briefToIdentityToken(brief) exactly', () => {
    const brief = makeBrief({
      title: 'Deep Roots',
      artDirection: { palette: [], mood: 'verdant overgrowth', references: [] },
    });
    const picks = briefToScaffoldPicks(brief, []);
    expect(picks.identityToken).toBe(briefToIdentityToken(brief));
  });

  it('still intersects systemIds with the available set (unaffected by the token addition)', () => {
    const brief = makeBrief({ systems: ['lighting', 'made-up-id'] });
    const picks = briefToScaffoldPicks(brief, ['lighting', 'postfx']);
    expect(picks.systemIds).toEqual(['lighting']);
  });
});
