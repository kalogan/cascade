/**
 * Live tuning panel — spec-driven, schema-validated constants for the Match-3
 * (and any consumer that wants a "twiddle the knobs while it's running" panel).
 *
 * THREE-FREE, deterministic: `validateTunable` is pure (no Math.random /
 * Date.now); the store persists via the kit `settings` module, which already
 * resolves localStorage or an in-memory fallback, so this whole module is
 * headless-safe. `mountTuningPanel` additionally guards on `document` so it is
 * a no-op under node/SSR/tests without jsdom.
 *
 * Mirrors project-mmo's `TunableSpec` / `TUNABLE_SPECS` / `validateTunable`
 * shape (packages/shared/src/schemas/remoteConfig.ts), minus the server
 * transport: this is client-only, and `validateTunable` here is *coercive*
 * (always returns a usable number — clamp + round) rather than reject/accept,
 * since there is no operator-facing "reject this edit" UX for an in-page
 * slider overlay.
 */

import { createSettingsStore } from '../settings/index.js';

/** A single tunable's schema: range, step, default, and display metadata. */
export interface TunableSpec {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  /** Step for the slider and for rounding on validate. */
  step: number;
  default: number;
  /** Whether the value must be an integer (rounded on top of the step). */
  integer?: boolean;
  description?: string;
}

/**
 * Coerce an arbitrary edit into a value that satisfies `spec`:
 * non-finite (NaN/±Infinity, or a non-number) falls back to `spec.default`,
 * the result is clamped to `[min, max]`, snapped to the nearest `step` from
 * `min`, and rounded to an integer if `spec.integer`. Pure and deterministic.
 */
export function validateTunable(spec: TunableSpec, value: number): number {
  let v = typeof value === 'number' && Number.isFinite(value) ? value : spec.default;

  v = Math.min(spec.max, Math.max(spec.min, v));

  if (spec.step > 0) {
    const steps = Math.round((v - spec.min) / spec.step);
    v = spec.min + steps * spec.step;
    // Re-clamp: snapping to the nearest step can push a value near max/min
    // just outside the range from floating-point drift.
    v = Math.min(spec.max, Math.max(spec.min, v));
  }

  if (spec.integer) {
    v = Math.round(v);
  }

  // Squash floating-point noise from the step arithmetic (e.g. 0.1 + 0.2).
  return Math.round(v * 1e9) / 1e9;
}

/** Build a `{key: default}` map from a spec list. */
export function defaultTunables(specs: TunableSpec[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const spec of specs) out[spec.key] = spec.default;
  return out;
}

export interface Tuning {
  get(key: string): number;
  set(key: string, value: number): void;
  all(): Record<string, number>;
  /** Restore every tunable to its spec default. */
  reset(): void;
  /** Subscribe to any change; fires immediately-on-change with the full values map. */
  subscribe(cb: (values: Record<string, number>) => void): () => void;
}

export interface CreateTuningOptions {
  /** Persistence key for the backing settings store. */
  storeKey?: string;
}

/**
 * Create a live tuning store backed by `createSettingsStore` (localStorage,
 * or in-memory when unavailable). Values are validated against their spec
 * (clamp/step/integer) before every persisted write.
 */
export function createTuning(specs: TunableSpec[], opts?: CreateTuningOptions): Tuning {
  const specByKey = new Map(specs.map((spec) => [spec.key, spec]));
  const defaults = defaultTunables(specs);

  const store = createSettingsStore<Record<string, number>>({
    key: opts?.storeKey ?? 'match3-tuning',
    defaults,
    version: 1,
  });

  function requireSpec(key: string): TunableSpec {
    const spec = specByKey.get(key);
    if (!spec) throw new Error(`tuning: unknown key "${key}"`);
    return spec;
  }

  return {
    get(key: string): number {
      const spec = requireSpec(key);
      const values = store.get();
      return values[key] ?? spec.default;
    },

    set(key: string, value: number): void {
      const spec = requireSpec(key);
      const validated = validateTunable(spec, value);
      store.set({ [key]: validated });
    },

    all(): Record<string, number> {
      return store.get();
    },

    reset(): void {
      store.set({ ...defaults });
    },

    subscribe(cb: (values: Record<string, number>) => void): () => void {
      return store.subscribe(cb);
    },
  };
}

export interface MountTuningPanelOptions {
  /** Substring of `location.search` that must be present to render. Default `'tune'` (i.e. `?tune`). */
  urlToggle?: string;
  /** Mount point; defaults to `document.body`. */
  container?: HTMLElement;
}

/**
 * Mount a DOM overlay of labeled range sliders (grouped by `spec.group`) bound
 * live to `tuning`, plus a reset button. Lives OUTSIDE the canvas — callers
 * render their canvas separately and this appends a fixed-position panel.
 *
 * URL-toggled: only renders when `location.search` contains `opts.urlToggle`
 * (default `'tune'`, i.e. visiting with `?tune` in the URL). HEADLESS-GUARDED:
 * with no `document` (node / non-DOM test env) this is a safe no-op that
 * returns a `{destroy(){}}` stub — it never throws.
 *
 * Accessibility: every slider has an associated `<label for>` (accessible
 * name), sliders are native `<input type="range">` (keyboard-operable by
 * default), and each slider's value is also rendered as text (not color-only).
 */
export function mountTuningPanel(
  tuning: Tuning,
  specs: TunableSpec[],
  opts?: MountTuningPanelOptions,
): { destroy(): void } {
  const noop = { destroy(): void {} };

  if (typeof document === 'undefined') {
    return noop;
  }

  const toggle = opts?.urlToggle ?? 'tune';
  const search = typeof location !== 'undefined' && typeof location.search === 'string'
    ? location.search
    : '';
  if (!search.includes(toggle)) {
    return noop;
  }

  const root = document.createElement('div');
  root.setAttribute('data-tuning-panel', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    top: '0',
    right: '0',
    zIndex: '9999',
    background: 'rgba(16,16,16,0.92)',
    color: '#fff',
    font: '12px system-ui, sans-serif',
    padding: '8px 10px',
    maxHeight: '100vh',
    overflowY: 'auto',
    minWidth: '260px',
  });

  const groups = new Map<string, TunableSpec[]>();
  for (const spec of specs) {
    const list = groups.get(spec.group);
    if (list) list.push(spec);
    else groups.set(spec.group, [spec]);
  }

  const inputByKey = new Map<string, HTMLInputElement>();
  const valueTextByKey = new Map<string, HTMLElement>();
  let uid = 0;

  for (const [groupName, groupSpecs] of groups) {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = groupName;
    fieldset.appendChild(legend);

    for (const spec of groupSpecs) {
      uid += 1;
      const id = `tuning-${spec.key}-${uid}`;

      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.margin = '4px 0';

      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = spec.label;
      label.style.flex = '1 1 auto';
      label.title = spec.description ?? '';

      const currentValue = tuning.get(spec.key);

      const input = document.createElement('input');
      input.type = 'range';
      input.id = id;
      input.dataset.tuningKey = spec.key;
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(currentValue);

      const valueText = document.createElement('span');
      valueText.textContent = String(currentValue);
      valueText.style.minWidth = '3.5em';
      valueText.style.textAlign = 'right';

      input.addEventListener('input', () => {
        tuning.set(spec.key, Number(input.value));
      });

      inputByKey.set(spec.key, input);
      valueTextByKey.set(spec.key, valueText);

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(valueText);
      fieldset.appendChild(row);
    }

    root.appendChild(fieldset);
  }

  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.textContent = 'Reset to defaults';
  resetButton.addEventListener('click', () => tuning.reset());
  root.appendChild(resetButton);

  const unsubscribe = tuning.subscribe((values) => {
    for (const [key, input] of inputByKey) {
      const v = values[key];
      if (v === undefined) continue;
      const asString = String(v);
      if (input.value !== asString) input.value = asString;
      const valueText = valueTextByKey.get(key);
      if (valueText) valueText.textContent = asString;
    }
  });

  const mountPoint = opts?.container ?? document.body;
  mountPoint.appendChild(root);

  return {
    destroy(): void {
      unsubscribe();
      root.remove();
    },
  };
}

/**
 * The Match-3's live-tunable registry, grouped for the panel: Timing (tween
 * durations), Juice (feel/feedback), Difficulty (pacing knobs).
 */
export const MATCH3_TUNING: TunableSpec[] = [
  // ── Timing ──────────────────────────────────────────────────────────────
  {
    key: 'swapMs',
    label: 'Swap duration (ms)',
    group: 'Timing',
    min: 60,
    max: 600,
    step: 10,
    default: 180,
    integer: true,
    description: 'How long a tile-swap tween takes.',
  },
  {
    key: 'cascadeStepMs',
    label: 'Cascade step (ms)',
    group: 'Timing',
    min: 60,
    max: 600,
    step: 10,
    default: 220,
    integer: true,
    description: 'Duration of each fall/clear step within a cascade.',
  },
  {
    key: 'refillMs',
    label: 'Refill duration (ms)',
    group: 'Timing',
    min: 60,
    max: 600,
    step: 10,
    default: 200,
    integer: true,
    description: 'How long newly-spawned tiles take to drop into place.',
  },
  // ── Juice ───────────────────────────────────────────────────────────────
  {
    key: 'shakeBase',
    label: 'Shake base',
    group: 'Juice',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0.35,
    description: 'Base camera-shake trauma added per clear.',
  },
  {
    key: 'particlesPerClear',
    label: 'Particles / clear',
    group: 'Juice',
    min: 0,
    max: 32,
    step: 1,
    default: 12,
    integer: true,
    description: 'Particle burst count spawned per cleared tile.',
  },
  {
    key: 'comboFlourishThreshold',
    label: 'Combo flourish threshold',
    group: 'Juice',
    min: 1,
    max: 6,
    step: 1,
    default: 2,
    integer: true,
    description: 'Cascade depth at which the big flourish/fanfare triggers.',
  },
  // ── Difficulty ──────────────────────────────────────────────────────────
  {
    key: 'moveBudgetDecay',
    label: 'Move budget decay',
    group: 'Difficulty',
    min: 0,
    max: 3,
    step: 0.1,
    default: 1,
    description: 'Multiplier on how fast the move budget drains per level.',
  },
  {
    key: 'scoreTargetGrowth',
    label: 'Score target growth',
    group: 'Difficulty',
    min: 0,
    max: 400,
    step: 10,
    default: 40,
    integer: true,
    description: 'Score-target increase applied per level (campaign curve param).',
  },
  // ── Shine (render2d tile gloss) ───────────────────────────────────────────
  // Mirror DEFAULT_TILE_SHINE in render2d; the game pushes these into
  // renderer.setTileShine so the preview harness can dial gloss live.
  {
    key: 'glowAlpha',
    label: 'Tile glow strength',
    group: 'Shine',
    min: 0,
    max: 1,
    step: 0.02,
    default: 0.38,
    description: 'Opacity of the additive aura behind each tile (0 = none).',
  },
  {
    key: 'glowRadius',
    label: 'Tile glow radius',
    group: 'Shine',
    min: 1,
    max: 2,
    step: 0.05,
    default: 1.3,
    description: 'Aura radius as a multiple of the tile radius.',
  },
  {
    key: 'sheenLight',
    label: 'Bevel sheen',
    group: 'Shine',
    min: 0,
    max: 0.8,
    step: 0.02,
    default: 0.26,
    description: 'Top-left glossy bevel-light strength.',
  },
  {
    key: 'sheenShadow',
    label: 'Bevel shadow',
    group: 'Shine',
    min: 0,
    max: 0.6,
    step: 0.02,
    default: 0.22,
    description: 'Bottom-right bevel-shadow strength.',
  },
  {
    key: 'highlight',
    label: 'Glassy highlight',
    group: 'Shine',
    min: 0,
    max: 0.8,
    step: 0.02,
    default: 0.2,
    description: 'Upper-left glassy hotspot strength.',
  },
  // ── Scenery (backdrop motion + world transition) ──────────────────────────
  {
    key: 'backdropMotion',
    label: 'Backdrop motion',
    group: 'Scenery',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1.1,
    description: 'Multiplier on parallax-band drift + bob.',
  },
  {
    key: 'worldFadeMs',
    label: 'World cross-fade (ms)',
    group: 'Scenery',
    min: 0,
    max: 2000,
    step: 50,
    default: 900,
    integer: true,
    description: 'Duration of the scenery dissolve when entering a new world.',
  },
];
