import { describe, it, expect } from 'vitest';
import { advance, createLoop, createFixedLoop } from './index.js';

describe('advance (pure fixed-timestep accumulator)', () => {
  const dt = 1 / 60;

  it('runs exactly one step when the frame equals the fixed step', () => {
    const r = advance(0, dt, dt);
    expect(r.steps).toBe(1);
    expect(r.accumulator).toBeCloseTo(0, 9);
    expect(r.alpha).toBeCloseTo(0, 9);
  });

  it('carries a sub-step remainder into alpha + accumulator', () => {
    const r = advance(0, dt * 1.5, dt);
    expect(r.steps).toBe(1);
    expect(r.accumulator).toBeCloseTo(dt * 0.5, 9);
    expect(r.alpha).toBeCloseTo(0.5, 6);
  });

  it('runs multiple steps for a long frame', () => {
    const r = advance(0, dt * 3, dt);
    expect(r.steps).toBe(3);
    expect(r.accumulator).toBeCloseTo(0, 9);
  });

  it('accumulates across frames (leftover feeds the next call)', () => {
    const a = advance(0, dt * 0.6, dt);
    expect(a.steps).toBe(0);
    const b = advance(a.accumulator, dt * 0.6, dt);
    expect(b.steps).toBe(1); // 0.6 + 0.6 = 1.2 steps → one step, 0.2 leftover
    expect(b.accumulator).toBeCloseTo(dt * 0.2, 6);
  });

  it('clamps the spiral of death and drops the backlog', () => {
    const r = advance(0, dt * 100, dt, 5);
    expect(r.steps).toBe(5); // clamped
    expect(r.accumulator).toBeLessThan(dt); // backlog discarded, only a remainder kept
    expect(r.alpha).toBeGreaterThanOrEqual(0);
    expect(r.alpha).toBeLessThan(1);
  });

  it('treats NaN / negative frame deltas as zero (clock ran backwards)', () => {
    expect(advance(0, -5, dt).steps).toBe(0);
    expect(advance(0, NaN, dt).steps).toBe(0);
    expect(advance(dt * 0.5, -1, dt).accumulator).toBeCloseTo(dt * 0.5, 9);
  });

  it('throws on a non-positive fixed step', () => {
    expect(() => advance(0, dt, 0)).toThrow();
    expect(() => advance(0, dt, -1)).toThrow();
  });

  it('alpha is always in [0, 1)', () => {
    for (const frame of [0, dt * 0.1, dt * 0.99, dt, dt * 2.3, dt * 999]) {
      const r = advance(0, frame, dt);
      expect(r.alpha).toBeGreaterThanOrEqual(0);
      expect(r.alpha).toBeLessThan(1);
    }
  });
});

describe('createLoop', () => {
  // A controllable fake RAF + clock installed on globalThis.
  function withFakeRaf(run: (tick: (ms: number) => void, calls: () => number) => void) {
    const g = globalThis as any;
    const saved = {
      raf: g.requestAnimationFrame,
      caf: g.cancelAnimationFrame,
      perf: g.performance,
    };
    let nowMs = 0;
    let queued: ((t: number) => void) | null = null;
    let nextId = 1;
    let rafCalls = 0;
    g.requestAnimationFrame = (cb: (t: number) => void) => {
      rafCalls++;
      queued = cb;
      return nextId++;
    };
    g.cancelAnimationFrame = () => {
      queued = null;
    };
    g.performance = { now: () => nowMs };
    const tick = (ms: number) => {
      nowMs += ms;
      const cb = queued;
      queued = null;
      if (cb) cb(nowMs);
    };
    try {
      run(tick, () => rafCalls);
    } finally {
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
      g.performance = saved.perf;
    }
  }

  it('calls step at the fixed rate as the clock advances', () => {
    withFakeRaf((tick) => {
      let steps = 0;
      const loop = createLoop(() => steps++, { fixedHz: 60 });
      loop.start();
      tick(1000 / 60); // one fixed step of wall time
      expect(steps).toBe(1);
      tick(1000 / 60);
      expect(steps).toBe(2);
      loop.stop();
    });
  });

  it('is import-safe with no RAF: start()/stop() are no-ops that never throw', () => {
    const g = globalThis as any;
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    try {
      const loop = createLoop(() => {});
      expect(() => {
        loop.start();
        loop.stop();
      }).not.toThrow();
    } finally {
      g.requestAnimationFrame = saved;
    }
  });

  it('stop() halts further ticking', () => {
    withFakeRaf((tick) => {
      let steps = 0;
      const loop = createLoop(() => steps++, { fixedHz: 60 });
      loop.start();
      tick(1000 / 60);
      expect(steps).toBe(1);
      loop.stop();
      tick(1000 / 60); // nothing queued anymore
      expect(steps).toBe(1);
    });
  });
});

describe('createFixedLoop', () => {
  function withFakeRaf(run: (tick: (ms: number) => void) => void) {
    const g = globalThis as any;
    const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, perf: g.performance };
    let nowMs = 0;
    let queued: ((t: number) => void) | null = null;
    g.requestAnimationFrame = (cb: (t: number) => void) => ((queued = cb), 1);
    g.cancelAnimationFrame = () => (queued = null);
    g.performance = { now: () => nowMs };
    const tick = (ms: number) => {
      nowMs += ms;
      const cb = queued;
      queued = null;
      cb?.(nowMs);
    };
    try {
      run(tick);
    } finally {
      g.requestAnimationFrame = saved.raf;
      g.cancelAnimationFrame = saved.caf;
      g.performance = saved.perf;
    }
  }

  it('runs update once per fixed step and render once per frame', () => {
    withFakeRaf((tick) => {
      let updates = 0;
      let renders = 0;
      const loop = createFixedLoop(
        { update: () => updates++, render: () => renders++ },
        { fixedHz: 60, autoPauseHidden: false },
      );
      loop.start();
      tick((1000 / 60) * 3); // a 3-step frame
      expect(updates).toBe(3);
      expect(renders).toBe(1);
    });
  });

  it('renders even on a sub-step frame with zero updates', () => {
    withFakeRaf((tick) => {
      let updates = 0;
      let renders = 0;
      const loop = createFixedLoop(
        { update: () => updates++, render: () => renders++ },
        { fixedHz: 60, autoPauseHidden: false },
      );
      loop.start();
      tick((1000 / 60) * 0.4); // less than one step
      expect(updates).toBe(0);
      expect(renders).toBe(1);
      loop.stop();
    });
  });

  it('exposes running and stops cleanly', () => {
    withFakeRaf((tick) => {
      const loop = createFixedLoop({ update: () => {} }, { autoPauseHidden: false });
      expect(loop.running).toBe(false);
      loop.start();
      expect(loop.running).toBe(true);
      loop.stop();
      expect(loop.running).toBe(false);
      const before = loop.running;
      tick(1000);
      expect(loop.running).toBe(before);
    });
  });

  it('is import-safe with no RAF', () => {
    const g = globalThis as any;
    const saved = g.requestAnimationFrame;
    g.requestAnimationFrame = undefined;
    try {
      const loop = createFixedLoop({ update: () => {} });
      expect(() => {
        loop.start();
        loop.stop();
      }).not.toThrow();
    } finally {
      g.requestAnimationFrame = saved;
    }
  });
});
