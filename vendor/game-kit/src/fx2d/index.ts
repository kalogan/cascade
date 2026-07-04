/**
 * fx2d — 2D juice: pooled particle system, tween helpers, a trauma-model
 * screen-shake driver, and named Match-3 emitter presets.
 *
 * THREE-FREE, DOM-FREE: pure TypeScript, no `three`, no canvas/DOM. Callers
 * (render2d) draw whatever this module produces.
 *
 * Determinism: every source of randomness flows through an injected `Rng`
 * (see `../prng/index.js`). Never `Math.random()` / `Date.now()`. The same
 * seed plus the same sequence of `emit`/`step`/`update` calls always produces
 * identical particle/shake state — this is asserted directly in the test
 * suite via snapshot comparisons across two independently constructed
 * systems.
 *
 * No per-frame allocation: `createParticleSystem` pre-allocates its full
 * pool (plus a free-list and a same-length "initial size" side array) once,
 * up front. `emit`, `step`, and `forEach` only ever mutate that fixed state —
 * they never push to an array, spread, map, or otherwise allocate.
 */

import { createRng, type Rng } from '../prng/index.js';
import { clamp, lerp, easeOutCubic } from '../math/index.js';

// ─────────────────────────────────────────────────────────────────────────
// Particle system
// ─────────────────────────────────────────────────────────────────────────

export type BlendMode = 'normal' | 'add';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ax: number;
  ay: number;
  life: number;
  maxLife: number;
  size: number;
  rot: number;
  vr: number;
  r: number;
  g: number;
  b: number;
  a: number;
  blend: BlendMode;
  active: boolean;
}

export interface EmitOpts {
  count: number;
  speed?: [number, number];
  angle?: [number, number];
  gravity?: number;
  life?: [number, number];
  size?: [number, number];
  color: [number, number, number];
  blend?: BlendMode;
  spread?: number;
}

export interface ParticleSystem {
  /** Live (active) particle count. */
  readonly count: number;
  emit(x: number, y: number, opts: EmitOpts): void;
  /** Integrate physics, age particles, and retire the dead. Fixed cap, no per-frame alloc. */
  step(dt: number): void;
  /** Iterate ACTIVE particles only. Caller draws each via render2d. */
  forEach(cb: (p: Particle) => void): void;
  /** Retire every active particle. */
  clear(): void;
}

/** Build one blank, inactive pool slot. Every field lives on the object up front. */
function makeSlot(): Particle {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ax: 0,
    ay: 0,
    life: 0,
    maxLife: 0,
    size: 0,
    rot: 0,
    vr: 0,
    r: 0,
    g: 0,
    b: 0,
    a: 0,
    blend: 'normal',
    active: false,
  };
}

/**
 * Create a fixed-capacity, pooled particle system.
 *
 * `cap` slots are allocated exactly once. `emit` reuses dead slots via a
 * LIFO free-list (O(1) per particle, no scanning, no allocation); when the
 * free-list is empty the remaining requested particles are simply dropped —
 * `cap` is a hard ceiling (the perf-tier budget), never exceeded.
 */
export function createParticleSystem(opts: { cap: number; rng: Rng }): ParticleSystem {
  const cap = Math.max(0, Math.floor(opts.cap));
  const rng = opts.rng;

  const slots: Particle[] = new Array(cap);
  for (let i = 0; i < cap; i++) slots[i] = makeSlot();

  // Side array remembering each slot's *initial* size at emit time, so `step`
  // can shrink `size` proportionally to remaining life without needing an
  // extra field on `Particle` itself (the contract fixes that shape).
  const sizeInit = new Float32Array(cap);

  // LIFO free-list of inactive slot indices; `freeCount` is the live length.
  // Seeded descending so the first emits land on ascending indices (0,1,2,…),
  // which keeps single-emit tests easy to reason about.
  const freeList = new Int32Array(cap);
  const resetFreeList = (): void => {
    for (let i = 0; i < cap; i++) freeList[i] = cap - 1 - i;
  };
  resetFreeList();
  let freeCount = cap;
  let activeCount = 0;

  const SPIN_RANGE = 3; // rad/s, symmetric — internal detail, not part of EmitOpts

  const emit = (x: number, y: number, o: EmitOpts): void => {
    const speedLo = o.speed ? o.speed[0] : 50;
    const speedHi = o.speed ? o.speed[1] : 50;
    const angleLo = o.angle ? o.angle[0] : 0;
    const angleHi = o.angle ? o.angle[1] : Math.PI * 2;
    const gravity = o.gravity ?? 0;
    const lifeLo = o.life ? o.life[0] : 0.5;
    const lifeHi = o.life ? o.life[1] : 0.5;
    const sizeLo = o.size ? o.size[0] : 4;
    const sizeHi = o.size ? o.size[1] : 4;
    const blend: BlendMode = o.blend ?? 'normal';
    const spread = o.spread ?? 0;
    const [cr, cg, cb] = o.color;

    const n = Math.max(0, Math.floor(o.count));
    for (let k = 0; k < n; k++) {
      if (freeCount <= 0) break; // cap reached — drop the rest of this emit
      const idx = freeList[--freeCount] as number;
      const p = slots[idx] as Particle;

      const angle = lerp(angleLo, angleHi, rng.next());
      const speed = lerp(speedLo, speedHi, rng.next());
      const jx = spread > 0 ? (rng.next() * 2 - 1) * spread : 0;
      const jy = spread > 0 ? (rng.next() * 2 - 1) * spread : 0;

      p.x = x;
      p.y = y;
      p.vx = Math.cos(angle) * speed + jx;
      p.vy = Math.sin(angle) * speed + jy;
      p.ax = 0;
      p.ay = gravity;
      p.maxLife = lerp(lifeLo, lifeHi, rng.next());
      p.life = p.maxLife;
      const size = lerp(sizeLo, sizeHi, rng.next());
      p.size = size;
      sizeInit[idx] = size;
      p.rot = rng.next() * Math.PI * 2;
      p.vr = (rng.next() * 2 - 1) * SPIN_RANGE;
      p.r = cr;
      p.g = cg;
      p.b = cb;
      p.a = 1;
      p.blend = blend;
      p.active = true;

      activeCount++;
    }
  };

  const step = (dt: number): void => {
    for (let i = 0; i < cap; i++) {
      const p = slots[i] as Particle;
      if (!p.active) continue;

      p.vx += p.ax * dt;
      p.vy += p.ay * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.life -= dt;

      if (p.life <= 0) {
        p.active = false;
        p.a = 0;
        freeList[freeCount++] = i;
        activeCount--;
        continue;
      }

      const t = p.maxLife > 0 ? clamp(p.life / p.maxLife, 0, 1) : 0;
      p.a = t;
      p.size = (sizeInit[i] as number) * t;
    }
  };

  const forEach = (cb: (p: Particle) => void): void => {
    for (let i = 0; i < cap; i++) {
      const p = slots[i] as Particle;
      if (p.active) cb(p);
    }
  };

  const clearAll = (): void => {
    for (let i = 0; i < cap; i++) {
      const p = slots[i] as Particle;
      p.active = false;
      p.a = 0;
    }
    resetFreeList();
    freeCount = cap;
    activeCount = 0;
  };

  return {
    get count(): number {
      return activeCount;
    },
    emit,
    step,
    forEach,
    clear: clearAll,
  };
}

/** Snapshot every active particle as a plain-object copy (test/debug helper). */
export function snapshotParticles(sys: ParticleSystem): Particle[] {
  const out: Particle[] = [];
  sys.forEach((p) => {
    out.push({ ...p });
  });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Screen-shake driver (trauma model)
// ─────────────────────────────────────────────────────────────────────────

export interface ShakeDriver {
  readonly trauma: number;
  addTrauma(a: number): void;
  update(dt: number): { x: number; y: number; angle: number };
}

const DEFAULT_SHAKE_DECAY = 1.5; // trauma units/sec
const DEFAULT_MAX_OFFSET = 16; // px
const MAX_ANGLE = 0.15; // rad, independent of maxOffset (px vs radians)

/**
 * Trauma model: `addTrauma` adds an impulse (clamped to [0,1] total);
 * `update(dt)` decays trauma linearly by `decay` (units/sec) and returns a
 * shake offset scaled by `trauma^2 * maxOffset` with seeded jitter — the
 * squared falloff means small trauma barely shakes while a maxed-out trauma
 * shakes hard, matching the classic "trauma model" curve.
 */
export function createShakeDriver(opts?: {
  decay?: number;
  rng?: Rng;
  maxOffset?: number;
}): ShakeDriver {
  const decay = opts?.decay ?? DEFAULT_SHAKE_DECAY;
  const rng = opts?.rng ?? createRng(1);
  const maxOffset = opts?.maxOffset ?? DEFAULT_MAX_OFFSET;

  let trauma = 0;

  return {
    get trauma(): number {
      return trauma;
    },
    addTrauma(a: number): void {
      trauma = clamp(trauma + a, 0, 1);
    },
    update(dt: number): { x: number; y: number; angle: number } {
      trauma = clamp(trauma - decay * dt, 0, 1);
      const shake = trauma * trauma;
      // Always draw the same number of rng values regardless of `shake` so the
      // stream stays deterministic step-for-step even as trauma reaches 0.
      const jx = rng.next() * 2 - 1;
      const jy = rng.next() * 2 - 1;
      const ja = rng.next() * 2 - 1;
      // `+ 0` normalizes a possible `-0` (e.g. jx negative, shake 0) to `+0` so
      // a fully-settled shake reports an exact, tidy zero vector.
      return {
        x: jx * shake * maxOffset + 0,
        y: jy * shake * maxOffset + 0,
        angle: ja * shake * MAX_ANGLE + 0,
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tween
// ─────────────────────────────────────────────────────────────────────────

export interface Tween {
  readonly done: boolean;
  value(): number;
  step(dt: number): void;
  reset(): void;
}

export function createTween(opts: {
  from: number;
  to: number;
  duration: number;
  ease?: (t: number) => number;
}): Tween {
  const { from, to } = opts;
  const duration = Math.max(0, opts.duration);
  const ease = opts.ease ?? easeOutCubic;

  let elapsed = 0;

  return {
    get done(): boolean {
      return elapsed >= duration;
    },
    value(): number {
      if (duration <= 0) return to;
      const t = clamp(elapsed / duration, 0, 1);
      return lerp(from, to, ease(t));
    },
    step(dt: number): void {
      elapsed = clamp(elapsed + dt, 0, duration);
    },
    reset(): void {
      elapsed = 0;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Named Match-3 emitter presets
// ─────────────────────────────────────────────────────────────────────────

export type FxPresetName = 'clear' | 'combo-flourish' | 'spawn-pop' | 'select' | 'swap' | 'fall-trail';

const FULL_CIRCLE: [number, number] = [0, Math.PI * 2];

/**
 * The expensive *burst* presets — the ones the perf-tier particle budget thins
 * on weaker devices. The cheap tactile presets (`select`/`swap`/`spawn-pop`)
 * are deliberately NOT in here: they're ≤6 particles and carry the game-feel,
 * so `countScale` leaves them at full strength even on the lowest tier.
 */
const BUDGETED_PRESETS: ReadonlySet<FxPresetName> = new Set<FxPresetName>([
  'clear',
  'combo-flourish',
  'fall-trail',
]);

/** Particle count for `combo-flourish`, strictly increasing with depth. */
function comboFlourishCount(depth: number): number {
  const d = Math.max(1, Math.floor(depth));
  if (d <= 1) return 6; // minimal
  if (d === 2) return 14; // sparkle
  return 22 + (d - 3) * 6; // 3+ : ring burst, grows further with depth
}

function comboFlourishShape(depth: number): {
  speed: [number, number];
  life: [number, number];
  size: [number, number];
  gravity: number;
  blend: BlendMode;
  spread: number;
} {
  const d = Math.max(1, Math.floor(depth));
  if (d <= 1) {
    return { speed: [20, 50], life: [0.25, 0.35], size: [2, 4], gravity: 60, blend: 'normal', spread: 5 };
  }
  if (d === 2) {
    return { speed: [40, 90], life: [0.3, 0.45], size: [3, 5], gravity: 40, blend: 'add', spread: 10 };
  }
  // Wider + longer-lived the deeper the cascade goes.
  const widen = Math.min(1, (d - 3) * 0.15);
  return {
    speed: [80 + widen * 40, 170 + widen * 60],
    life: [0.4, 0.6],
    size: [3.5, 6],
    gravity: 20,
    blend: 'add',
    spread: 14 + widen * 12,
  };
}

/**
 * Emit one of the named Match-3 juice presets onto `sys` at `(x, y)`.
 * All presets emit exclusively through `sys.emit` (no direct pool access) so
 * they stay pure functions of their arguments plus the system's own rng.
 */
export function playFx(
  sys: ParticleSystem,
  name: FxPresetName,
  x: number,
  y: number,
  opts: {
    color: [number, number, number];
    depth?: number;
    size?: number;
    /**
     * Particle-budget multiplier (0..1+) from the active perf tier. Scales the
     * count of the *burst* presets only (see BUDGETED_PRESETS); a low-tier
     * device passes e.g. 0.3 to thin bursts while the tactile presets stay full.
     * Defaults to 1 (no scaling).
     */
    countScale?: number;
    /**
     * Override the base particle count for the `clear` burst (before countScale),
     * so the game can bind it to a tunable (e.g. `particlesPerClear`). Ignored by
     * the other presets. Defaults to the preset's built-in count.
     */
    count?: number;
  },
): void {
  const sizeFactor = opts.size ?? 1;
  const scaleRange = (r: [number, number]): [number, number] => [r[0] * sizeFactor, r[1] * sizeFactor];
  const budget = BUDGETED_PRESETS.has(name) ? Math.max(0, opts.countScale ?? 1) : 1;
  // Round so a small non-zero budget still yields at least 1 particle (a burst
  // never silently vanishes unless the budget is exactly 0).
  const scaleCount = (n: number): number => {
    if (budget >= 1) return Math.round(n * budget);
    if (budget <= 0) return 0;
    return Math.max(1, Math.round(n * budget));
  };

  switch (name) {
    case 'clear': {
      // 8-16 outward shards with gravity, additive, tinted, fade+shrink ~400ms.
      // Base count is overridable (game binds it to the `particlesPerClear` knob).
      sys.emit(x, y, {
        count: scaleCount(opts.count ?? 12),
        speed: [60, 160],
        angle: FULL_CIRCLE,
        gravity: 220,
        life: [0.35, 0.45],
        size: scaleRange([3, 6]),
        color: opts.color,
        blend: 'add',
        spread: 8,
      });
      return;
    }
    case 'combo-flourish': {
      const depth = opts.depth ?? 1;
      const shape = comboFlourishShape(depth);
      sys.emit(x, y, {
        count: scaleCount(comboFlourishCount(depth)),
        speed: shape.speed,
        angle: FULL_CIRCLE,
        gravity: shape.gravity,
        life: shape.life,
        size: scaleRange(shape.size),
        color: opts.color,
        blend: shape.blend,
        spread: shape.spread,
      });
      return;
    }
    case 'spawn-pop': {
      sys.emit(x, y, {
        count: 6,
        speed: [15, 40],
        angle: FULL_CIRCLE,
        gravity: 30,
        life: [0.2, 0.28],
        size: scaleRange([2, 3.5]),
        color: opts.color,
        blend: 'normal',
        spread: 3,
      });
      return;
    }
    case 'select': {
      sys.emit(x, y, {
        count: 4,
        speed: [8, 20],
        angle: FULL_CIRCLE,
        gravity: 0,
        life: [0.12, 0.18],
        size: scaleRange([1.5, 2.5]),
        color: opts.color,
        blend: 'normal',
        spread: 1,
      });
      return;
    }
    case 'swap': {
      sys.emit(x, y, {
        count: 5,
        speed: [12, 30],
        angle: FULL_CIRCLE,
        gravity: 10,
        life: [0.15, 0.22],
        size: scaleRange([1.5, 3]),
        color: opts.color,
        blend: 'normal',
        spread: 2,
      });
      return;
    }
    case 'fall-trail': {
      // A faint, short-lived smear dropped at a collapsing tile's position so
      // gravity reads as motion, not teleport. Emitted per moved tile per frame,
      // so it stays sparse (2 particles) and near-stationary — the tile falls
      // past it, leaving the trail behind. Additive so it glints, not smudges.
      sys.emit(x, y, {
        count: scaleCount(2),
        speed: [2, 12],
        angle: [Math.PI * 0.25, Math.PI * 0.75], // downward-biased fan
        gravity: 0,
        life: [0.12, 0.2],
        size: scaleRange([1.5, 3]),
        color: opts.color,
        blend: 'add',
        spread: 2,
      });
      return;
    }
  }
}
