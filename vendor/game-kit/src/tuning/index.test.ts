import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  validateTunable,
  defaultTunables,
  createTuning,
  mountTuningPanel,
  MATCH3_TUNING,
  type TunableSpec,
} from './index.js';

// Straight from the vendored game-kit source. `validateTunable` is pure
// (no DOM), `createTuning` persists via the kit `settings` store (localStorage
// under jsdom, memory fallback under plain node) — this suite exercises both,
// plus the headless guard on `mountTuningPanel`.

const SPEC: TunableSpec = {
  key: 'testKnob',
  label: 'Test knob',
  group: 'Test',
  min: 0,
  max: 10,
  step: 2,
  default: 4,
};

const INT_SPEC: TunableSpec = {
  key: 'testIntKnob',
  label: 'Test int knob',
  group: 'Test',
  min: 0,
  max: 10,
  step: 1,
  default: 3,
  integer: true,
};

describe('validateTunable', () => {
  it('clamps a value below min up to min', () => {
    expect(validateTunable(SPEC, -100)).toBe(0);
  });

  it('clamps a value above max down to max', () => {
    expect(validateTunable(SPEC, 100)).toBe(10);
  });

  it('rounds to the nearest step', () => {
    expect(validateTunable(SPEC, 4.9)).toBe(4); // nearest multiple of 2 from min 0
    expect(validateTunable(SPEC, 5.1)).toBe(6);
    expect(validateTunable(SPEC, 7.9)).toBe(8);
  });

  it('leaves an on-step value unchanged', () => {
    expect(validateTunable(SPEC, 6)).toBe(6);
  });

  it('enforces integer rounding when spec.integer is set', () => {
    expect(validateTunable(INT_SPEC, 4.7)).toBe(5);
    expect(validateTunable(INT_SPEC, 4.2)).toBe(4);
  });

  it('coerces NaN to the spec default', () => {
    expect(validateTunable(SPEC, NaN)).toBe(4);
  });

  it('coerces +Infinity to the spec default', () => {
    expect(validateTunable(SPEC, Infinity)).toBe(4);
  });

  it('coerces -Infinity to the spec default', () => {
    expect(validateTunable(SPEC, -Infinity)).toBe(4);
  });

  it('coerces a non-number value to the spec default', () => {
    expect(validateTunable(SPEC, 'nope' as unknown as number)).toBe(4);
  });

  it('never returns a value outside [min, max] even after step snapping near the edge', () => {
    const oddStepSpec: TunableSpec = { ...SPEC, min: 0, max: 9, step: 4, default: 0 };
    const v = validateTunable(oddStepSpec, 9);
    expect(v).toBeGreaterThanOrEqual(oddStepSpec.min);
    expect(v).toBeLessThanOrEqual(oddStepSpec.max);
  });
});

describe('defaultTunables', () => {
  it('builds a {key: default} map from a spec list', () => {
    expect(defaultTunables([SPEC, INT_SPEC])).toEqual({
      testKnob: 4,
      testIntKnob: 3,
    });
  });

  it('returns an empty map for an empty spec list', () => {
    expect(defaultTunables([])).toEqual({});
  });
});

describe('createTuning', () => {
  it('get() returns the spec default before any set()', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    expect(tuning.get('testKnob')).toBe(4);
  });

  it('set() then get() persists the new value', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    tuning.set('testKnob', 8);
    expect(tuning.get('testKnob')).toBe(8);
  });

  it('set() validates the value against its spec before persisting', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    tuning.set('testKnob', 999);
    expect(tuning.get('testKnob')).toBe(10); // clamped to max
  });

  it('all() returns the full current values map', () => {
    const tuning = createTuning([SPEC, INT_SPEC], { storeKey: `t-${Math.random()}` });
    tuning.set('testKnob', 6);
    expect(tuning.all()).toEqual({ testKnob: 6, testIntKnob: 3 });
  });

  it('subscribe() fires with the full values map on any change', () => {
    const tuning = createTuning([SPEC, INT_SPEC], { storeKey: `t-${Math.random()}` });
    const seen: Record<string, number>[] = [];
    const unsubscribe = tuning.subscribe((values) => seen.push(values));

    tuning.set('testKnob', 8);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ testKnob: 8, testIntKnob: 3 });
    unsubscribe();
  });

  it('subscribe() returns an unsubscribe function that stops further notifications', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    const seen: Record<string, number>[] = [];
    const unsubscribe = tuning.subscribe((values) => seen.push(values));
    unsubscribe();

    tuning.set('testKnob', 8);

    expect(seen).toHaveLength(0);
  });

  it('reset() restores every tunable to its spec default', () => {
    const tuning = createTuning([SPEC, INT_SPEC], { storeKey: `t-${Math.random()}` });
    tuning.set('testKnob', 8);
    tuning.set('testIntKnob', 9);

    tuning.reset();

    expect(tuning.all()).toEqual({ testKnob: 4, testIntKnob: 3 });
  });

  it('get() throws for an unknown key', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    expect(() => tuning.get('nope')).toThrow();
  });

  it('set() throws for an unknown key', () => {
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });
    expect(() => tuning.set('nope', 1)).toThrow();
  });

  it('two instances sharing a storeKey observe persisted values (proves persistence)', () => {
    const storeKey = `shared-${Math.random()}`;
    const a = createTuning([SPEC], { storeKey });
    a.set('testKnob', 6);

    const b = createTuning([SPEC], { storeKey });
    expect(b.get('testKnob')).toBe(6);
  });

  it('defaults to the "match3-tuning" storeKey when none is given', () => {
    // Two instances with no explicit storeKey should share the default key.
    const a = createTuning(MATCH3_TUNING);
    a.set('swapMs', 300);
    const b = createTuning(MATCH3_TUNING);
    expect(b.get('swapMs')).toBe(300);
    // Restore so other tests in this file aren't affected by shared default-key state.
    a.reset();
  });
});

describe('mountTuningPanel — headless guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a safe no-op when document is undefined', () => {
    vi.stubGlobal('document', undefined);
    const tuning = createTuning([SPEC], { storeKey: `t-${Math.random()}` });

    const panel = mountTuningPanel(tuning, [SPEC]);

    expect(panel).toBeDefined();
    expect(() => panel.destroy()).not.toThrow();
  });
});

describe('mountTuningPanel — URL toggle + DOM (jsdom)', () => {
  afterEach(() => {
    window.history.pushState({}, '', '/');
    document.body.innerHTML = '';
  });

  it('does not render when the toggle is absent from location.search', () => {
    window.history.pushState({}, '', '/?debug=1');
    const tuning = createTuning(MATCH3_TUNING, { storeKey: `t-${Math.random()}` });

    const panel = mountTuningPanel(tuning, MATCH3_TUNING);

    expect(document.querySelector('[data-tuning-panel]')).toBeNull();
    expect(() => panel.destroy()).not.toThrow();
  });

  it('renders a grouped, labeled slider panel when the toggle is present', () => {
    window.history.pushState({}, '', '/?tune');
    const tuning = createTuning(MATCH3_TUNING, { storeKey: `t-${Math.random()}` });

    const panel = mountTuningPanel(tuning, MATCH3_TUNING);

    const root = document.querySelector('[data-tuning-panel]');
    expect(root).not.toBeNull();

    // Every slider has an associated label (accessible name) and a text value.
    const sliders = root!.querySelectorAll('input[type="range"]');
    expect(sliders.length).toBe(MATCH3_TUNING.length);
    for (const slider of Array.from(sliders)) {
      const id = slider.getAttribute('id');
      expect(id).toBeTruthy();
      const label = root!.querySelector(`label[for="${id}"]`);
      expect(label).not.toBeNull();
      expect(label!.textContent).toBeTruthy();
    }

    panel.destroy();
    expect(document.querySelector('[data-tuning-panel]')).toBeNull();
  });

  it('updates the slider and its text value live on tuning changes', () => {
    window.history.pushState({}, '', '/?tune');
    const tuning = createTuning(MATCH3_TUNING, { storeKey: `t-${Math.random()}` });
    const panel = mountTuningPanel(tuning, MATCH3_TUNING);

    tuning.set('swapMs', 240);

    const input = document.querySelector(
      'input[data-tuning-key="swapMs"]',
    ) as HTMLInputElement;
    expect(Number(input.value)).toBe(240);

    panel.destroy();
  });

  it('respects a custom urlToggle and container', () => {
    window.history.pushState({}, '', '/?debugTuning');
    const container = document.createElement('div');
    document.body.appendChild(container);

    const tuning = createTuning(MATCH3_TUNING, { storeKey: `t-${Math.random()}` });
    const panel = mountTuningPanel(tuning, MATCH3_TUNING, {
      urlToggle: 'debugTuning',
      container,
    });

    expect(container.querySelector('[data-tuning-panel]')).not.toBeNull();
    panel.destroy();
  });
});

describe('MATCH3_TUNING', () => {
  it('declares the expected keys grouped as documented', () => {
    const byGroup = new Map<string, string[]>();
    for (const spec of MATCH3_TUNING) {
      const list = byGroup.get(spec.group) ?? [];
      list.push(spec.key);
      byGroup.set(spec.group, list);
    }

    expect(byGroup.get('Timing')?.sort()).toEqual(
      ['swapMs', 'cascadeStepMs', 'refillMs'].sort(),
    );
    expect(byGroup.get('Juice')?.sort()).toEqual(
      ['shakeBase', 'particlesPerClear', 'comboFlourishThreshold'].sort(),
    );
    expect(byGroup.get('Difficulty')?.sort()).toEqual(
      ['moveBudgetDecay', 'scoreTargetGrowth'].sort(),
    );
  });

  it('has no duplicate keys', () => {
    const keys = MATCH3_TUNING.map((spec) => spec.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every default passes its own validateTunable unchanged', () => {
    for (const spec of MATCH3_TUNING) {
      expect(validateTunable(spec, spec.default)).toBe(spec.default);
    }
  });
});
