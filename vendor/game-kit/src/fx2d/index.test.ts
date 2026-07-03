import { describe, it, expect } from 'vitest';
import { createRng } from '../prng/index.js';
import { easeOutCubic, easeInOutQuad } from '../math/index.js';
import {
  createParticleSystem,
  snapshotParticles,
  createShakeDriver,
  createTween,
  playFx,
  type EmitOpts,
  type Particle,
} from './index.js';

const BASE_EMIT: EmitOpts = {
  count: 1,
  speed: [50, 50],
  angle: [0, 0],
  gravity: 0,
  life: [1, 1],
  size: [4, 4],
  color: [1, 0.5, 0.25],
};

describe('fx2d / particle pool', () => {
  it('starts empty', () => {
    const sys = createParticleSystem({ cap: 8, rng: createRng(1) });
    expect(sys.count).toBe(0);
    let seen = 0;
    sys.forEach(() => seen++);
    expect(seen).toBe(0);
  });

  it('emit activates the requested count, up to cap', () => {
    const sys = createParticleSystem({ cap: 8, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 5 });
    expect(sys.count).toBe(5);
  });

  it('never exceeds cap even under heavy repeated emit', () => {
    const cap = 20;
    const sys = createParticleSystem({ cap, rng: createRng(42) });
    for (let i = 0; i < 50; i++) {
      sys.emit(i, i, { ...BASE_EMIT, count: 30 });
      expect(sys.count).toBeLessThanOrEqual(cap);
    }
    expect(sys.count).toBe(cap);
  });

  it('drops the excess of a single over-cap emit rather than queuing it', () => {
    const sys = createParticleSystem({ cap: 5, rng: createRng(7) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 100 });
    expect(sys.count).toBe(5);
    // Stepping doesn't somehow reveal the dropped particles later.
    sys.step(0.001);
    expect(sys.count).toBeLessThanOrEqual(5);
  });

  it('forEach iterates active particles only', () => {
    const sys = createParticleSystem({ cap: 10, rng: createRng(3) });
    sys.emit(1, 2, { ...BASE_EMIT, count: 3 });
    const xs: number[] = [];
    sys.forEach((p) => xs.push(p.x));
    expect(xs).toHaveLength(3);
    expect(xs.every((x) => x === 1)).toBe(true);
  });

  it('step integrates position by velocity*dt', () => {
    const sys = createParticleSystem({ cap: 4, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 1, speed: [100, 100], angle: [0, 0], life: [10, 10] });
    const before = snapshotParticles(sys)[0] as Particle;
    expect(before.vx).toBeCloseTo(100, 5);
    expect(before.vy).toBeCloseTo(0, 5);
    sys.step(0.5);
    const after = snapshotParticles(sys)[0] as Particle;
    expect(after.x).toBeCloseTo(before.x + 100 * 0.5, 5);
  });

  it('gravity accelerates vy over successive steps', () => {
    const sys = createParticleSystem({ cap: 4, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 1, speed: [0, 0], angle: [0, 0], gravity: 50, life: [10, 10] });
    sys.step(1);
    const p1 = snapshotParticles(sys)[0] as Particle;
    sys.step(1);
    const p2 = snapshotParticles(sys)[0] as Particle;
    expect(p2.vy).toBeGreaterThan(p1.vy);
  });

  it('particles retire once life expires, freeing their slot', () => {
    const sys = createParticleSystem({ cap: 2, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 1, life: [0.1, 0.1] });
    expect(sys.count).toBe(1);
    sys.step(0.2);
    expect(sys.count).toBe(0);
    // The freed slot is reusable.
    sys.emit(5, 5, { ...BASE_EMIT, count: 1, life: [5, 5] });
    expect(sys.count).toBe(1);
  });

  it('alpha fades monotonically toward 0 as life runs out', () => {
    const sys = createParticleSystem({ cap: 2, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 1, life: [1, 1] });
    const alphas: number[] = [];
    for (let i = 0; i < 5; i++) {
      const p = snapshotParticles(sys)[0];
      alphas.push(p ? p.a : 0);
      sys.step(0.2);
    }
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeLessThanOrEqual(alphas[i - 1] as number);
    }
    expect(alphas[0]).toBeCloseTo(1, 5);
  });

  it('size shrinks toward 0 alongside alpha', () => {
    const sys = createParticleSystem({ cap: 2, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 1, life: [1, 1], size: [10, 10] });
    const first = snapshotParticles(sys)[0] as Particle;
    expect(first.size).toBeCloseTo(10, 5);
    sys.step(0.5);
    const mid = snapshotParticles(sys)[0] as Particle;
    expect(mid.size).toBeLessThan(first.size);
    expect(mid.size).toBeGreaterThan(0);
  });

  it('clear() retires everything immediately', () => {
    const sys = createParticleSystem({ cap: 10, rng: createRng(1) });
    sys.emit(0, 0, { ...BASE_EMIT, count: 6 });
    expect(sys.count).toBe(6);
    sys.clear();
    expect(sys.count).toBe(0);
    let seen = 0;
    sys.forEach(() => seen++);
    expect(seen).toBe(0);
  });

  it('pool never grows past cap distinct particle objects across many cycles', () => {
    const cap = 3;
    const sys = createParticleSystem({ cap, rng: createRng(9) });
    const seen = new Set<Particle>();
    for (let cycle = 0; cycle < 10; cycle++) {
      sys.emit(cycle, cycle, { ...BASE_EMIT, count: 3, life: [0.05, 0.05] });
      sys.forEach((p) => seen.add(p));
      sys.step(0.1); // all three retire, freeing their slots for the next cycle
    }
    // No matter how many emit/step cycles run, only `cap` distinct pool
    // objects ever exist — proof there is no per-emit allocation.
    expect(seen.size).toBe(cap);
  });

  it('is deterministic: same seed + same call sequence -> identical snapshot', () => {
    const sysA = createParticleSystem({ cap: 32, rng: createRng(123) });
    const sysB = createParticleSystem({ cap: 32, rng: createRng(123) });

    const run = (sys: ReturnType<typeof createParticleSystem>) => {
      sys.emit(3, 4, { ...BASE_EMIT, count: 10, speed: [10, 200], angle: [0, Math.PI * 2], spread: 5 });
      sys.step(1 / 60);
      sys.emit(1, 1, { ...BASE_EMIT, count: 5, life: [0.2, 0.6] });
      sys.step(1 / 60);
      sys.step(1 / 60);
    };
    run(sysA);
    run(sysB);

    expect(snapshotParticles(sysA)).toEqual(snapshotParticles(sysB));
    expect(sysA.count).toBe(sysB.count);
  });

  it('different seeds diverge (sanity check the determinism test isn\'t vacuous)', () => {
    const sysA = createParticleSystem({ cap: 32, rng: createRng(1) });
    const sysB = createParticleSystem({ cap: 32, rng: createRng(2) });
    sysA.emit(0, 0, { ...BASE_EMIT, count: 10, speed: [10, 200], angle: [0, Math.PI * 2] });
    sysB.emit(0, 0, { ...BASE_EMIT, count: 10, speed: [10, 200], angle: [0, Math.PI * 2] });
    expect(snapshotParticles(sysA)).not.toEqual(snapshotParticles(sysB));
  });
});

describe('fx2d / shake driver', () => {
  it('starts at zero trauma', () => {
    const shake = createShakeDriver({ rng: createRng(1) });
    expect(shake.trauma).toBe(0);
  });

  it('addTrauma clamps the running total to [0, 1]', () => {
    const shake = createShakeDriver({ rng: createRng(1) });
    shake.addTrauma(0.6);
    shake.addTrauma(0.9);
    expect(shake.trauma).toBe(1);
    shake.addTrauma(-5);
    expect(shake.trauma).toBe(0);
  });

  it('update decays trauma linearly by `decay` per second', () => {
    const shake = createShakeDriver({ decay: 1, rng: createRng(1) });
    shake.addTrauma(1);
    shake.update(0.25);
    expect(shake.trauma).toBeCloseTo(0.75, 5);
    shake.update(0.25);
    expect(shake.trauma).toBeCloseTo(0.5, 5);
  });

  it('trauma decays fully to 0 and stays there', () => {
    const shake = createShakeDriver({ decay: 2, rng: createRng(1) });
    shake.addTrauma(1);
    for (let i = 0; i < 10; i++) shake.update(0.5);
    expect(shake.trauma).toBe(0);
    const offset = shake.update(0.1);
    expect(offset).toEqual({ x: 0, y: 0, angle: 0 });
  });

  it('offset magnitude shrinks as trauma decays', () => {
    const maxOffset = 20;
    const shake = createShakeDriver({ decay: 0.3, rng: createRng(5), maxOffset });
    shake.addTrauma(1);
    const mags: number[] = [];
    for (let i = 0; i < 8; i++) {
      const o = shake.update(1);
      mags.push(Math.hypot(o.x, o.y));
      // Per-step magnitude is always bounded by the trauma^2 * maxOffset
      // envelope (jx, jy each in [-1, 1], so worst case is sqrt(2) apart).
      const ceiling = maxOffset * shake.trauma * shake.trauma * Math.SQRT2;
      expect(mags[mags.length - 1] as number).toBeLessThanOrEqual(ceiling + 1e-9);
    }
    // The bounding envelope itself shrinks monotonically with decaying trauma,
    // so comparing the first and last step's ceiling shows real shrinkage.
    expect(mags[mags.length - 1] as number).toBeLessThan(mags[0] as number);
    expect(mags[mags.length - 1]).toBeCloseTo(0, 5);
  });

  it('respects maxOffset as the scale ceiling', () => {
    const shake = createShakeDriver({ decay: 0, rng: createRng(2), maxOffset: 10 });
    shake.addTrauma(1);
    const o = shake.update(0);
    expect(Math.abs(o.x)).toBeLessThanOrEqual(10 + 1e-9);
    expect(Math.abs(o.y)).toBeLessThanOrEqual(10 + 1e-9);
  });

  it('is deterministic given the same rng seed and call sequence', () => {
    const a = createShakeDriver({ rng: createRng(77) });
    const b = createShakeDriver({ rng: createRng(77) });
    a.addTrauma(1);
    b.addTrauma(1);
    const outA = [a.update(0.1), a.update(0.1), a.update(0.1)];
    const outB = [b.update(0.1), b.update(0.1), b.update(0.1)];
    expect(outA).toEqual(outB);
  });
});

describe('fx2d / tween', () => {
  it('starts at `from` and is not done', () => {
    const t = createTween({ from: 0, to: 10, duration: 1 });
    expect(t.value()).toBeCloseTo(0, 5);
    expect(t.done).toBe(false);
  });

  it('reaches `to` exactly at duration and reports done', () => {
    const t = createTween({ from: 0, to: 10, duration: 2, ease: (x) => x }); // linear for exactness
    t.step(2);
    expect(t.value()).toBeCloseTo(10, 5);
    expect(t.done).toBe(true);
  });

  it('clamps: stepping past duration does not overshoot `to`', () => {
    const t = createTween({ from: 0, to: 10, duration: 1, ease: (x) => x });
    t.step(5);
    expect(t.value()).toBeCloseTo(10, 5);
    expect(t.done).toBe(true);
  });

  it('reset() returns to the start', () => {
    const t = createTween({ from: 0, to: 10, duration: 1, ease: (x) => x });
    t.step(1);
    expect(t.done).toBe(true);
    t.reset();
    expect(t.done).toBe(false);
    expect(t.value()).toBeCloseTo(0, 5);
  });

  it('defaults to easeOutCubic', () => {
    const t = createTween({ from: 0, to: 1, duration: 1 });
    t.step(0.4);
    expect(t.value()).toBeCloseTo(easeOutCubic(0.4), 6);
  });

  it('honors a custom ease function', () => {
    const t = createTween({ from: 0, to: 1, duration: 1, ease: easeInOutQuad });
    t.step(0.3);
    expect(t.value()).toBeCloseTo(easeInOutQuad(0.3), 6);
  });

  it('handles duration 0 by jumping straight to `to` and being done', () => {
    const t = createTween({ from: 0, to: 5, duration: 0 });
    expect(t.done).toBe(true);
    expect(t.value()).toBe(5);
  });
});

describe('fx2d / named presets', () => {
  const color: [number, number, number] = [0.9, 0.2, 0.6];

  it('"clear" emits between 8 and 16 outward shards, additive, tinted to color', () => {
    const sys = createParticleSystem({ cap: 32, rng: createRng(1) });
    playFx(sys, 'clear', 10, 20, { color });
    expect(sys.count).toBeGreaterThanOrEqual(8);
    expect(sys.count).toBeLessThanOrEqual(16);
    sys.forEach((p) => {
      expect(p.blend).toBe('add');
      expect(p.r).toBeCloseTo(color[0], 5);
      expect(p.g).toBeCloseTo(color[1], 5);
      expect(p.b).toBeCloseTo(color[2], 5);
      expect(p.x).toBe(10);
      expect(p.y).toBe(20);
    });
  });

  it('"clear" particles fall under gravity and fade+shrink out within ~400ms', () => {
    const sys = createParticleSystem({ cap: 32, rng: createRng(1) });
    playFx(sys, 'clear', 0, 0, { color });
    for (let i = 0; i < 60; i++) sys.step(1 / 60); // ~1s, well past 400ms
    expect(sys.count).toBe(0);
  });

  it('"combo-flourish" emits strictly more particles at higher depth', () => {
    const counts = [1, 2, 3, 4, 5].map((depth) => {
      const sys = createParticleSystem({ cap: 200, rng: createRng(1) });
      playFx(sys, 'combo-flourish', 0, 0, { color, depth });
      return sys.count;
    });
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i] as number).toBeGreaterThan(counts[i - 1] as number);
    }
  });

  it('"combo-flourish" defaults depth to the minimal tier when omitted', () => {
    const sysDefault = createParticleSystem({ cap: 200, rng: createRng(1) });
    playFx(sysDefault, 'combo-flourish', 0, 0, { color });
    const sysDepth1 = createParticleSystem({ cap: 200, rng: createRng(1) });
    playFx(sysDepth1, 'combo-flourish', 0, 0, { color, depth: 1 });
    expect(sysDefault.count).toBe(sysDepth1.count);
  });

  it.each(['spawn-pop', 'select', 'swap'] as const)(
    '"%s" emits a small subtle burst tinted to color',
    (name) => {
      const sys = createParticleSystem({ cap: 32, rng: createRng(1) });
      playFx(sys, name, 5, 5, { color });
      expect(sys.count).toBeGreaterThan(0);
      expect(sys.count).toBeLessThanOrEqual(8);
      sys.forEach((p) => {
        expect(p.r).toBeCloseTo(color[0], 5);
        expect(p.g).toBeCloseTo(color[1], 5);
        expect(p.b).toBeCloseTo(color[2], 5);
      });
    },
  );

  it('`size` option scales preset particle sizes', () => {
    const small = createParticleSystem({ cap: 32, rng: createRng(1) });
    playFx(small, 'clear', 0, 0, { color, size: 1 });
    const big = createParticleSystem({ cap: 32, rng: createRng(1) });
    playFx(big, 'clear', 0, 0, { color, size: 3 });

    const smallSizes = snapshotParticles(small).map((p) => p.size);
    const bigSizes = snapshotParticles(big).map((p) => p.size);
    for (let i = 0; i < smallSizes.length; i++) {
      expect(bigSizes[i] as number).toBeCloseTo((smallSizes[i] as number) * 3, 4);
    }
  });

  it('presets are deterministic given the same seed', () => {
    const sysA = createParticleSystem({ cap: 64, rng: createRng(55) });
    const sysB = createParticleSystem({ cap: 64, rng: createRng(55) });
    playFx(sysA, 'combo-flourish', 3, 3, { color, depth: 4 });
    playFx(sysB, 'combo-flourish', 3, 3, { color, depth: 4 });
    expect(snapshotParticles(sysA)).toEqual(snapshotParticles(sysB));
  });

  it('all presets go through sys.emit and never exceed the pool cap', () => {
    const sys = createParticleSystem({ cap: 10, rng: createRng(1) });
    playFx(sys, 'clear', 0, 0, { color }); // wants 12, cap is 10
    expect(sys.count).toBeLessThanOrEqual(10);
  });
});
