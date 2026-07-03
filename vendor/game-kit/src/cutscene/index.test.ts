import { describe, it, expect } from 'vitest';
import { createCutscenePlayer, type CutsceneSequence, type CutsceneFrame } from './index.js';

// Pure, THREE-free contract for the cutscene core — the load-bearing math and
// event/skip semantics a GYRE ending montage relies on, so playback stays
// honest without spinning up a WebGL context.

describe('createCutscenePlayer — camera interpolation', () => {
  const seq: CutsceneSequence = {
    shots: [
      {
        duration: 4,
        camera: [
          { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 1] },
          { t: 2, pos: [10, 0, 0], lookAt: [10, 0, 1] },
          { t: 4, pos: [10, 10, 0], lookAt: [10, 10, 1] },
        ],
      },
    ],
  };

  it('clamps to the first key before t=0', () => {
    const p = createCutscenePlayer(seq);
    const f = p.step(0);
    expect(f.camera).toEqual({ pos: [0, 0, 0], lookAt: [0, 0, 1] });
  });

  it('interpolates mid-segment (linear default)', () => {
    const p = createCutscenePlayer(seq);
    p.step(1); // t=1, halfway through [0,2]
    const f = p.step(0);
    expect(f.camera).toEqual({ pos: [5, 0, 0], lookAt: [5, 0, 1] });
  });

  it('crosses into the second segment correctly', () => {
    const p = createCutscenePlayer(seq);
    p.step(3); // t=3, halfway through [2,4]
    const f = p.step(0);
    expect(f.camera).toEqual({ pos: [10, 5, 0], lookAt: [10, 5, 1] });
  });

  it('clamps to the last key once the track ends', () => {
    const p = createCutscenePlayer(seq);
    const f = p.step(4); // exactly completes the (only) shot's duration
    expect(f.camera).toEqual({ pos: [10, 10, 0], lookAt: [10, 10, 1] });
  });

  it('clamps to the last key when the track ends before the shot does', () => {
    const shortTrack: CutsceneSequence = {
      shots: [
        {
          duration: 4,
          camera: [
            { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 1] },
            { t: 2, pos: [10, 0, 0], lookAt: [10, 0, 1] },
          ],
        },
      ],
    };
    const p = createCutscenePlayer(shortTrack);
    p.step(3); // past the last key (t=2) but the shot runs to t=4
    const f = p.step(0);
    expect(f.camera).toEqual({ pos: [10, 0, 0], lookAt: [10, 0, 1] });
  });

  it('is null when the shot has no camera track', () => {
    const p = createCutscenePlayer({ shots: [{ duration: 1 }] });
    const f = p.step(0);
    expect(f.camera).toBeNull();
  });
});

describe('createCutscenePlayer — easing', () => {
  it('applies easeInOutQuad on the incoming segment (not linear)', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 2,
          camera: [
            { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 0] },
            { t: 2, pos: [10, 0, 0], lookAt: [0, 0, 0], ease: 'easeInOutQuad' },
          ],
        },
      ],
    };
    const p = createCutscenePlayer(seq);
    p.step(0.5); // local t=0.5, local fraction 0.25 of the [0,2] segment
    const f = p.step(0);
    // easeInOutQuad(0.25) = 2*0.25^2 = 0.125 -> pos.x = 1.25, NOT the linear 1.25... use a
    // fraction where linear and eased diverge clearly.
    expect(f.camera!.pos[0]).toBeCloseTo(1.25, 6);
  });

  it('diverges from linear at a fraction where the curve is not the identity', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 4,
          camera: [
            { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 0] },
            { t: 4, pos: [10, 0, 0], lookAt: [0, 0, 0], ease: 'easeInOutQuad' },
          ],
        },
      ],
    };
    const linearSeq: CutsceneSequence = {
      shots: [
        {
          duration: 4,
          camera: [
            { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 0] },
            { t: 4, pos: [10, 0, 0], lookAt: [0, 0, 0] },
          ],
        },
      ],
    };
    const eased = createCutscenePlayer(seq);
    const linear = createCutscenePlayer(linearSeq);
    eased.step(1); // local fraction 0.25
    linear.step(1);
    const fe = eased.step(0);
    const fl = linear.step(0);
    expect(fe.camera!.pos[0]).not.toBeCloseTo(fl.camera!.pos[0], 6);
    // easeInOutQuad(0.25) = 0.125 -> 1.25; linear(0.25) = 2.5
    expect(fe.camera!.pos[0]).toBeCloseTo(1.25, 6);
    expect(fl.camera!.pos[0]).toBeCloseTo(2.5, 6);
  });

  it('easeOutCubic is applied on ramps too', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 1,
          ramps: {
            fogDensity: { keys: [{ t: 0, value: 0 }, { t: 1, value: 1, ease: 'easeOutCubic' }] },
          },
        },
      ],
    };
    const p = createCutscenePlayer(seq);
    p.step(0.5);
    const f = p.step(0);
    // easeOutCubic(0.5) = 1 - (0.5)^3 = 0.875
    expect(f.ramps.fogDensity).toBeCloseTo(0.875, 6);
  });
});

describe('createCutscenePlayer — ramp sampling', () => {
  const seq: CutsceneSequence = {
    shots: [
      {
        duration: 4,
        ramps: {
          fogDensity: {
            keys: [
              { t: 0, value: 0 },
              { t: 2, value: 1 },
              { t: 4, value: 0.5 },
            ],
          },
          keyLight: { keys: [{ t: 0, value: 100 }, { t: 4, value: 0 }] },
        },
      },
    ],
  };

  it('samples multiple named ramps independently', () => {
    const p = createCutscenePlayer(seq);
    const f = p.step(0);
    expect(f.ramps).toEqual({ fogDensity: 0, keyLight: 100 });
  });

  it('interpolates and clamps each ramp per its own track', () => {
    const p = createCutscenePlayer(seq);
    p.step(1); // fogDensity: halfway [0,2] -> 0.5; keyLight: 1/4 of [0,4] -> 75
    const f = p.step(0);
    expect(f.ramps.fogDensity).toBeCloseTo(0.5, 6);
    expect(f.ramps.keyLight).toBeCloseTo(75, 6);
  });

  it('omits a ramp with no keys', () => {
    const p = createCutscenePlayer({ shots: [{ duration: 1, ramps: { empty: { keys: [] } } }] });
    const f = p.step(0);
    expect(f.ramps).toEqual({});
  });
});

describe('createCutscenePlayer — event firing', () => {
  it('fires an event exactly once, on the step that crosses its t', () => {
    const seq: CutsceneSequence = {
      shots: [{ duration: 2, events: [{ t: 1, name: 'clip', data: 'roar' }] }],
    };
    const p = createCutscenePlayer(seq);
    const f0 = p.step(0.5); // t=0.5, not yet due
    expect(f0.events).toEqual([]);
    const f1 = p.step(0.6); // t=1.1, crosses t=1
    expect(f1.events).toEqual([{ t: 1, name: 'clip', data: 'roar' }]);
    const f2 = p.step(0.5); // t=1.6, already fired
    expect(f2.events).toEqual([]);
  });

  it('fires multiple due events in authored order on one step', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 2,
          events: [
            { t: 0.5, name: 'a' },
            { t: 0.6, name: 'b' },
          ],
        },
      ],
    };
    const p = createCutscenePlayer(seq);
    const f = p.step(1); // crosses both a and b
    expect(f.events.map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('fires an event at exactly the final instant of a shot', () => {
    const seq: CutsceneSequence = {
      shots: [{ duration: 1, events: [{ t: 1, name: 'end' }] }],
    };
    const p = createCutscenePlayer(seq);
    const f = p.step(1);
    expect(f.events).toEqual([{ t: 1, name: 'end' }]);
  });

  it('skipShot fires the remaining events of the current shot, in order, before jumping', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 10,
          events: [
            { t: 1, name: 'a' },
            { t: 5, name: 'b' },
            { t: 9, name: 'c' },
          ],
        },
        { duration: 2, events: [{ t: 1, name: 'd' }] },
      ],
    };
    const p = createCutscenePlayer(seq);
    p.step(2); // fires 'a', not b/c yet
    p.skipShot();
    const f = p.step(0); // 'b' and 'c' surface here, then we're in shot 1 at t=0
    expect(f.events.map((e) => e.name)).toEqual(['b', 'c']);
    expect(f.shotIndex).toBe(1);
  });

  it('skipAll fires every remaining event across every remaining shot, in order, then finishes', () => {
    const seq: CutsceneSequence = {
      shots: [
        { duration: 2, events: [{ t: 1, name: 'a' }] },
        { duration: 2, events: [{ t: 1, name: 'b' }] },
        { duration: 2, events: [{ t: 1, name: 'c' }] },
      ],
    };
    const p = createCutscenePlayer(seq);
    p.skipAll();
    const f = p.step(0);
    expect(f.events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(f.done).toBe(true);
    expect(p.done).toBe(true);
  });

  it('an event already fired before skipShot is not re-fired', () => {
    const seq: CutsceneSequence = {
      shots: [{ duration: 4, events: [{ t: 1, name: 'a' }, { t: 3, name: 'b' }] }],
    };
    const p = createCutscenePlayer(seq);
    p.step(2); // fires 'a'
    p.skipShot(); // should only fire 'b'
    const f = p.step(0);
    expect(f.events).toEqual([{ t: 3, name: 'b' }]);
  });
});

describe('createCutscenePlayer — multi-shot progression + progress', () => {
  const seq: CutsceneSequence = {
    shots: [{ duration: 2 }, { duration: 3 }, { duration: 5 }],
  };

  it('starts at shotIndex 0 with progress 0', () => {
    const p = createCutscenePlayer(seq);
    expect(p.progress).toBe(0);
    const f = p.step(0);
    expect(f.shotIndex).toBe(0);
  });

  it('advances shotIndex when a shot completes', () => {
    const p = createCutscenePlayer(seq);
    const f = p.step(2); // exactly completes shot 0
    expect(f.shotIndex).toBe(0); // frame reflects the shot that JUST completed
    const f2 = p.step(0);
    expect(f2.shotIndex).toBe(1);
  });

  it('tracks overall progress (0..1) across shots (total duration 10)', () => {
    const p = createCutscenePlayer(seq);
    p.step(2); // end of shot 0 (2/10)
    expect(p.progress).toBeCloseTo(0.2, 6);
    p.step(1.5); // shot 1, 1.5/3 in (2 + 1.5 = 3.5 / 10)
    expect(p.progress).toBeCloseTo(0.35, 6);
  });

  it('reaches progress 1 and done=true once every shot completes', () => {
    const p = createCutscenePlayer(seq);
    p.step(2);
    p.step(3);
    const last = p.step(5);
    expect(p.progress).toBeCloseTo(1, 6);
    expect(p.done).toBe(true);
    expect(last.done).toBe(true);
  });

  it('further steps after done stay done with no camera/events', () => {
    const p = createCutscenePlayer(seq);
    p.step(2);
    p.step(3);
    p.step(5);
    const f = p.step(10);
    expect(f.done).toBe(true);
    expect(f.camera).toBeNull();
    expect(f.events).toEqual([]);
  });
});

describe('createCutscenePlayer — determinism', () => {
  it('two players stepped with the same dt series produce deep-equal frames', () => {
    const seq: CutsceneSequence = {
      shots: [
        {
          duration: 3,
          camera: [
            { t: 0, pos: [0, 0, 0], lookAt: [0, 0, 0] },
            { t: 3, pos: [9, 3, -6], lookAt: [1, 1, 1], ease: 'easeInOutQuad' },
          ],
          ramps: { fogDensity: { keys: [{ t: 0, value: 0 }, { t: 3, value: 1, ease: 'easeOutCubic' }] } },
          events: [{ t: 1, name: 'clip', data: { id: 42 } }],
        },
        { duration: 2, events: [{ t: 0.5, name: 'caption', data: 'The end.' }] },
      ],
    };
    const dts = [0.016, 0.016, 0.033, 0.5, 0.9, 0.016, 1.2, 0.5, 0.016];

    const a = createCutscenePlayer(seq);
    const b = createCutscenePlayer(seq);
    const framesA: CutsceneFrame[] = dts.map((dt) => a.step(dt));
    const framesB: CutsceneFrame[] = dts.map((dt) => b.step(dt));

    expect(framesA).toEqual(framesB);
  });
});

describe('createCutscenePlayer — edge cases', () => {
  it('an empty sequence is immediately done with a null camera', () => {
    const p = createCutscenePlayer({ shots: [] });
    expect(p.done).toBe(true);
    expect(p.progress).toBe(1);
    const f = p.step(1);
    expect(f.done).toBe(true);
    expect(f.camera).toBeNull();
    expect(f.events).toEqual([]);
  });

  it('a zero-duration shot completes on the first step and moves on', () => {
    const seq: CutsceneSequence = {
      shots: [
        { duration: 0, events: [{ t: 0, name: 'instant' }] },
        { duration: 1, camera: [{ t: 0, pos: [1, 1, 1], lookAt: [0, 0, 0] }] },
      ],
    };
    const p = createCutscenePlayer(seq);
    const f = p.step(0);
    expect(f.events).toEqual([{ t: 0, name: 'instant' }]);
    const f2 = p.step(0);
    expect(f2.shotIndex).toBe(1);
    expect(f2.camera).toEqual({ pos: [1, 1, 1], lookAt: [0, 0, 0] });
  });

  it('a shot with no camera, ramps, or events still advances cleanly', () => {
    const seq: CutsceneSequence = { shots: [{ duration: 1 }, { duration: 1 }] };
    const p = createCutscenePlayer(seq);
    const f = p.step(1);
    expect(f.camera).toBeNull();
    expect(f.ramps).toEqual({});
    expect(f.events).toEqual([]);
    const f2 = p.step(1);
    expect(f2.shotIndex).toBe(1);
    expect(f2.done).toBe(true);
  });

  it('skipShot on an already-done player is a no-op', () => {
    const p = createCutscenePlayer({ shots: [{ duration: 1 }] });
    p.step(1);
    expect(p.done).toBe(true);
    expect(() => p.skipShot()).not.toThrow();
    expect(p.done).toBe(true);
  });
});
