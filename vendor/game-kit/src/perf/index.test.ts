import { describe, it, expect } from 'vitest';
import {
  detectDeviceTier,
  isDeviceTier,
  readDeviceSignals,
  createFrameMonitor,
  createAdaptiveQuality,
  TIER_ORDER,
  type DeviceTier,
} from './index.js';

describe('detectDeviceTier', () => {
  it('override wins over everything', () => {
    expect(detectDeviceTier({ override: 'low', search: '?tier=high', signals: { cores: 32 } })).toBe('low');
  });

  it('parses the ?tier= URL override', () => {
    expect(detectDeviceTier({ search: '?tier=low' })).toBe('low');
    expect(detectDeviceTier({ search: '?foo=1&tier=mid' })).toBe('mid');
    expect(detectDeviceTier({ search: '?tier=high' })).toBe('high');
  });

  it('ignores a malformed ?tier= value and falls through to the heuristic', () => {
    expect(detectDeviceTier({ search: '?tier=ultra', signals: { cores: 8, memoryGiB: 16 } })).toBe('high');
  });

  it('scores a beefy desktop as high', () => {
    expect(detectDeviceTier({ signals: { cores: 12, memoryGiB: 16, dpr: 2, mobile: false } })).toBe('high');
  });

  it('scores a mid phone as mid', () => {
    expect(detectDeviceTier({ signals: { cores: 8, memoryGiB: 4, dpr: 3, mobile: true } })).toBe('mid');
  });

  it('scores a weak phone as low', () => {
    expect(detectDeviceTier({ signals: { cores: 4, memoryGiB: 2, dpr: 2, mobile: true } })).toBe('low');
  });

  it('assumes capable when signals are empty (headless-safe default)', () => {
    // no globals in the vitest node env, no signals → treated as mid-range (cores/mem default to 4)
    expect(isDeviceTier(detectDeviceTier({ signals: {} }))).toBe(true);
  });

  it('readDeviceSignals never throws without browser globals', () => {
    expect(() => readDeviceSignals()).not.toThrow();
  });
});

describe('isDeviceTier', () => {
  it('accepts the three tiers and rejects anything else', () => {
    expect(TIER_ORDER.every(isDeviceTier)).toBe(true);
    expect(isDeviceTier('ultra')).toBe(false);
    expect(isDeviceTier(null)).toBe(false);
    expect(isDeviceTier(2)).toBe(false);
  });
});

describe('createFrameMonitor', () => {
  it('computes avg, fps and p95 on a known series', () => {
    const m = createFrameMonitor({ window: 100 });
    for (let i = 0; i < 100; i++) m.push(10); // steady 100fps
    expect(m.avg()).toBeCloseTo(10, 6);
    expect(m.fps()).toBeCloseTo(100, 6);
    expect(m.p95()).toBeCloseTo(10, 6);
    expect(m.count()).toBe(100);
  });

  it('p95 tracks the tail, not the mean', () => {
    const m = createFrameMonitor({ window: 100 });
    for (let i = 0; i < 90; i++) m.push(10);
    for (let i = 0; i < 10; i++) m.push(50); // slowest 10% of frames
    expect(m.avg()).toBeLessThan(15);
    expect(m.p95()).toBe(50);
  });

  it('counts dropped frames past the threshold', () => {
    const m = createFrameMonitor({ window: 10, dropThresholdMs: 33 });
    for (let i = 0; i < 7; i++) m.push(16);
    for (let i = 0; i < 3; i++) m.push(40);
    expect(m.dropped()).toBe(3);
  });

  it('respects the rolling window (old samples fall off)', () => {
    const m = createFrameMonitor({ window: 4 });
    m.push(100);
    m.push(100);
    m.push(10);
    m.push(10);
    m.push(10);
    m.push(10); // the two 100s have now been overwritten
    expect(m.count()).toBe(4);
    expect(m.avg()).toBeCloseTo(10, 6);
  });

  it('is empty-safe and reset-safe', () => {
    const m = createFrameMonitor();
    expect(m.avg()).toBe(0);
    expect(m.p95()).toBe(0);
    expect(m.fps()).toBe(0);
    m.push(16);
    m.reset();
    expect(m.count()).toBe(0);
    expect(m.avg()).toBe(0);
  });

  it('ignores NaN / negative samples', () => {
    const m = createFrameMonitor({ window: 10 });
    m.push(10);
    m.push(NaN);
    m.push(-5);
    expect(m.count()).toBe(1);
    expect(m.avg()).toBeCloseTo(10, 6);
  });
});

// A fake p95 source so adaptive-quality tests are fully deterministic.
function fakeMonitor(p95: number) {
  const box = { v: p95 };
  return {
    set: (v: number) => (box.v = v),
    monitor: { p95: () => box.v },
  };
}

describe('createAdaptiveQuality', () => {
  it('starts at the requested tier', () => {
    const f = fakeMonitor(0);
    const aq = createAdaptiveQuality({ start: 'mid', monitor: f.monitor });
    expect(aq.tier()).toBe('mid');
  });

  it('steps DOWN after downgradeAfter consecutive over-budget ticks — not before', () => {
    const f = fakeMonitor(40); // way over a 16.7ms budget
    const aq = createAdaptiveQuality({ start: 'high', monitor: f.monitor, downgradeAfter: 3 });
    aq.tick();
    aq.tick();
    expect(aq.tier()).toBe('high'); // 2 ticks — not yet
    expect(aq.tick()).toBe('mid'); // 3rd tick trips it
  });

  it('steps UP after upgradeAfter comfortable ticks', () => {
    const f = fakeMonitor(5); // well under 0.7 * 16.7
    const aq = createAdaptiveQuality({ start: 'low', monitor: f.monitor, upgradeAfter: 4 });
    let t: DeviceTier = 'low';
    for (let i = 0; i < 3; i++) t = aq.tick();
    expect(t).toBe('low');
    expect(aq.tick()).toBe('mid'); // 4th comfortable tick
  });

  it('never oscillates in the hysteresis dead-band', () => {
    const f = fakeMonitor(0);
    // budget 16.7, comfort 0.7*16.7 ≈ 11.7. Sit p95 between comfort and budget.
    const aq = createAdaptiveQuality({ start: 'mid', monitor: f.monitor, budgetMs: 16.7, headroom: 0.7 });
    for (let i = 0; i < 100; i++) {
      f.set(i % 2 === 0 ? 13 : 15); // both inside (11.7, 16.7)
      expect(aq.tick()).toBe('mid');
    }
  });

  it('an over/under-budget flip-flop does not step (fast down, slow up cancel out)', () => {
    const f = fakeMonitor(0);
    const aq = createAdaptiveQuality({ start: 'mid', monitor: f.monitor, downgradeAfter: 3, upgradeAfter: 12 });
    for (let i = 0; i < 60; i++) {
      f.set(i % 2 === 0 ? 40 : 5); // alternate over-budget / comfortable
      aq.tick();
    }
    // neither run ever reaches its threshold because each resets the other
    expect(aq.tier()).toBe('mid');
  });

  it('clamps at the ladder ends', () => {
    const low = fakeMonitor(999);
    const aqLow = createAdaptiveQuality({ start: 'low', monitor: low.monitor, downgradeAfter: 1 });
    for (let i = 0; i < 10; i++) aqLow.tick();
    expect(aqLow.tier()).toBe('low'); // can't go below low

    const high = fakeMonitor(1);
    const aqHigh = createAdaptiveQuality({ start: 'high', monitor: high.monitor, upgradeAfter: 1 });
    for (let i = 0; i < 10; i++) aqHigh.tick();
    expect(aqHigh.tier()).toBe('high'); // can't go above high
  });

  it('respects a restricted tier ladder', () => {
    const f = fakeMonitor(40);
    const aq = createAdaptiveQuality({
      start: 'mid',
      monitor: f.monitor,
      tiers: ['mid', 'high'],
      downgradeAfter: 1,
    });
    for (let i = 0; i < 5; i++) aq.tick();
    expect(aq.tier()).toBe('mid'); // 'low' is not on the ladder
  });

  it('reset jumps tier and clears counters', () => {
    const f = fakeMonitor(40);
    const aq = createAdaptiveQuality({ start: 'high', monitor: f.monitor, downgradeAfter: 3 });
    aq.tick();
    aq.tick(); // 2 over-budget banked
    aq.reset('high');
    aq.tick(); // counter was cleared, so this is only the 1st over-budget again
    expect(aq.tier()).toBe('high');
  });

  it('is deterministic: identical tick sequences yield identical tiers', () => {
    const seq = [40, 40, 40, 5, 5, 5, 5, 40, 12, 12];
    const run = () => {
      const f = fakeMonitor(0);
      const aq = createAdaptiveQuality({ start: 'high', monitor: f.monitor });
      return seq.map((v) => (f.set(v), aq.tick()));
    };
    expect(run()).toEqual(run());
  });
});
