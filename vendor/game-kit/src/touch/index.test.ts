import { describe, it, expect } from 'vitest';
import { createTouchState, type TouchPointerEvent } from './index.js';

// Pure, DOM-free contract for the touch core — the load-bearing state machine
// the DOM layer (r3f.tsx) and the GameCamera `inputOverride` seam both consume.
// No wall-clock: every timestamp is injected explicitly.

const SCREEN_WIDTH = 800; // splitX defaults to 400

function down(id: number, x: number, y: number, nowMs = 0): TouchPointerEvent {
  return { id, x, y, type: 'down' };
}
function move(id: number, x: number, y: number): TouchPointerEvent {
  return { id, x, y, type: 'move' };
}
function up(id: number, x: number, y: number): TouchPointerEvent {
  return { id, x, y, type: 'up' };
}

describe('createTouchState — stick', () => {
  it('push UP walks FORWARD (screen-y negated for the camera; regression: backwards-on-mobile)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 100, 300), 0);
    t.handleEvent(move(1, 100, 200), 16); // drag UP 100px (screen y decreases)
    const [strafe, forward] = t.moveAxes();
    expect(strafe).toBeCloseTo(0);
    expect(forward).toBeGreaterThan(0.5); // UP on screen = POSITIVE forward
  });

  it('is inactive with zero axes before any touch', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    expect(t.stick()).toEqual({ active: false, x: 0, y: 0 });
    expect(t.moveAxes()).toEqual([0, 0]);
  });

  it('anchors on touch-down in the left half and reports active with zero axes', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 100, 200), 0);
    expect(t.stick()).toEqual({ active: true, x: 0, y: 0 });
  });

  it('normalizes a drag beyond the deadzone toward the unit circle', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 160, 100), 0); // +60 in x = exactly at radius
    const s = t.stick();
    expect(s.active).toBe(true);
    expect(s.x).toBeCloseTo(1, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it('applies the deadzone: movement inside it yields zero axes', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 100, stickDeadzone: 0.2 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 115, 100), 0); // 15 units < 20 (deadzone radius)
    expect(t.stick()).toEqual({ active: true, x: 0, y: 0 });
  });

  it('rescales so the deadzone edge maps to 0 and full radius maps to 1', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 100, stickDeadzone: 0.2 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 160, 100), 0); // 60 units: (60-20)/(100-20) = 0.5
    const s = t.stick();
    expect(s.x).toBeCloseTo(0.5, 6);
    expect(s.y).toBeCloseTo(0, 6);
  });

  it('clamps movement beyond the radius to the unit circle (does not exceed 1)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 50, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 100, 500), 0); // way beyond radius, +y direction
    const s = t.stick();
    expect(s.x).toBeCloseTo(0, 6);
    expect(s.y).toBeCloseTo(1, 6);
    expect(Math.hypot(s.x, s.y)).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('resets to inactive zero axes on touch-up', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 160, 100), 0);
    t.handleEvent(up(1, 160, 100), 0);
    expect(t.stick()).toEqual({ active: false, x: 0, y: 0 });
  });

  it('re-anchors at the new down position for a subsequent touch (no drift from the old anchor)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(move(1, 130, 100), 0);
    t.handleEvent(up(1, 130, 100), 0);

    // New touch at a totally different position (still left half) — must
    // re-anchor there, not carry over the old anchor (which would otherwise
    // produce a huge spurious delta).
    t.handleEvent(down(2, 200, 500), 10);
    expect(t.stick()).toEqual({ active: true, x: 0, y: 0 });
    t.handleEvent(move(2, 230, 500), 10);
    const s = t.stick();
    expect(s.x).toBeCloseTo(0.5, 6); // 30/60
    expect(s.y).toBeCloseTo(0, 6);
  });

  it('ignores a second simultaneous touch in the left half (single stick owner)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(down(2, 150, 100), 0); // also left half — ignored for stick
    t.handleEvent(move(2, 300, 100), 0); // large move on the ignored touch
    // Stick still tracks touch 1's anchor only.
    expect(t.stick()).toEqual({ active: true, x: 0, y: 0 });
  });
});

describe('createTouchState — look (drain semantics)', () => {
  it('accumulates drag deltas on the right half and drains to zero', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 620, 310), 0);
    t.handleEvent(move(1, 630, 305), 0);
    // total dx = 30, dy = 5
    expect(t.drainLook()).toEqual([30, 5]);
    // drained — a second read (no new movement) is zero.
    expect(t.drainLook()).toEqual([0, 0]);
  });

  it('applies lookSensitivity as a multiplier on accumulated deltas', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, lookSensitivity: 2 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 610, 300), 0); // dx = 10 * 2
    expect(t.drainLook()).toEqual([20, 0]);
  });

  it('isDragging is true only while a look touch is active', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    expect(t.isDragging()).toBe(false);
    t.handleEvent(down(1, 600, 300), 0);
    expect(t.isDragging()).toBe(true);
    t.handleEvent(up(1, 600, 300), 0);
    expect(t.isDragging()).toBe(false);
  });

  it('drainZoom is always 0 (io-shape parity; no pinch gesture yet)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 650, 300), 0);
    expect(t.drainZoom()).toBe(0);
  });

  it('ignores a second simultaneous touch in the right half (single look owner)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(down(2, 700, 300), 0); // also right half — ignored for look
    t.handleEvent(move(2, 750, 300), 0); // large move on the ignored touch
    expect(t.drainLook()).toEqual([0, 0]);
  });
});

describe('createTouchState — half-screen assignment with simultaneous touches', () => {
  it('assigns a left-half touch to stick and a simultaneous right-half touch to look independently', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0); // left -> stick
    t.handleEvent(down(2, 600, 300), 0); // right -> look

    t.handleEvent(move(1, 130, 100), 0); // stick +30x
    t.handleEvent(move(2, 620, 300), 0); // look +20x

    const s = t.stick();
    expect(s.x).toBeCloseTo(0.5, 6);
    expect(t.drainLook()).toEqual([20, 0]);
  });

  it('a touch exactly at splitX goes to the look/right side (x < splitX is the only left condition)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 400, 300), 0); // splitX === 400
    expect(t.isDragging()).toBe(true);
    expect(t.stick()).toEqual({ active: false, x: 0, y: 0 });
  });

  it('honors a custom splitX', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, splitX: 200 });
    t.handleEvent(down(1, 150, 100), 0); // < 200 -> stick
    t.handleEvent(down(2, 250, 100), 0); // >= 200 -> look
    expect(t.stick().active).toBe(true);
    expect(t.isDragging()).toBe(true);
  });

  it('releasing one touch frees its half for a new touch, independent of the other', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    t.handleEvent(down(2, 600, 300), 0);
    t.handleEvent(up(1, 100, 100), 0);
    expect(t.stick()).toEqual({ active: false, x: 0, y: 0 });

    // A fresh left-half touch now claims the stick.
    t.handleEvent(down(3, 250, 250), 5);
    expect(t.stick()).toEqual({ active: true, x: 0, y: 0 });
    // The look touch (id 2) is untouched throughout.
    expect(t.isDragging()).toBe(true);
  });
});

describe('createTouchState — buttons', () => {
  const buttons = [
    { id: 'jump', x: 700, y: 400, width: 60, height: 60 },
    { id: 'attack', x: 700, y: 480, width: 60, height: 60 },
  ];

  it('claims a touch inside a button region regardless of screen half', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 720, 420), 0); // inside 'jump', right half too
    expect(t.isPressed('jump')).toBe(true);
    // The button touch must NOT also drive look.
    expect(t.isDragging()).toBe(false);
  });

  it('justPressed fires once on the down transition and is consumed on read', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 720, 420), 0);
    expect(t.justPressed('jump')).toBe(true);
    expect(t.justPressed('jump')).toBe(false); // consumed
    expect(t.isPressed('jump')).toBe(true); // still held
  });

  it('isPressed goes false on release', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 720, 420), 0);
    t.handleEvent(up(1, 720, 420), 0);
    expect(t.isPressed('jump')).toBe(false);
  });

  it('two different buttons pressed simultaneously by two touches are independent', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 720, 420), 0); // jump
    t.handleEvent(down(2, 720, 500), 0); // attack
    expect(t.isPressed('jump')).toBe(true);
    expect(t.isPressed('attack')).toBe(true);
    t.handleEvent(up(1, 720, 420), 0);
    expect(t.isPressed('jump')).toBe(false);
    expect(t.isPressed('attack')).toBe(true);
  });

  it('a second touch landing on an already-held button keeps it held after the first releases', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 710, 410), 0); // jump
    t.handleEvent(down(2, 730, 430), 0); // also jump (multi-touch on one button)
    t.handleEvent(up(1, 710, 410), 0);
    expect(t.isPressed('jump')).toBe(true); // touch 2 still holds it
    t.handleEvent(up(2, 730, 430), 0);
    expect(t.isPressed('jump')).toBe(false);
  });

  it('a button touch does not fire a tap on release', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, buttons });
    t.handleEvent(down(1, 720, 420), 0);
    t.handleEvent(up(1, 720, 420), 10);
    expect(t.drainTaps()).toEqual([]);
  });
});

describe('createTouchState — tap vs drag discrimination', () => {
  it('a short press with no movement on the look surface fires a tap', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 12, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(up(1, 600, 300), 100);
    expect(t.drainTaps()).toEqual([{ id: 1, x: 600, y: 300 }]);
  });

  it('drainTaps clears after read (one-shot)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(up(1, 600, 300), 50);
    expect(t.drainTaps().length).toBe(1);
    expect(t.drainTaps()).toEqual([]);
  });

  it('movement beyond tapMoveThreshold suppresses the tap even if released quickly', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 12, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 620, 300), 10); // moved 20 > 12
    t.handleEvent(up(1, 620, 300), 50); // well within time
    expect(t.drainTaps()).toEqual([]);
  });

  it('a long press without movement exceeding tapTimeThreshold suppresses the tap', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 12, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(up(1, 600, 300), 500); // 500ms > 300ms threshold
    expect(t.drainTaps()).toEqual([]);
  });

  it('movement within the threshold still counts as a tap (small jitter tolerated)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 12, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 605, 302), 20); // hypot(5,2) ~ 5.4 < 12
    t.handleEvent(up(1, 605, 302), 60);
    expect(t.drainTaps()).toEqual([{ id: 1, x: 605, y: 302 }]);
  });

  it('exactly at the move threshold boundary still counts (inclusive)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 10, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(move(1, 610, 300), 10); // exactly 10
    t.handleEvent(up(1, 610, 300), 60);
    expect(t.drainTaps()).toEqual([{ id: 1, x: 610, y: 300 }]);
  });

  it('exactly at the time threshold boundary still counts (inclusive)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, tapMoveThreshold: 12, tapTimeThreshold: 300 });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(up(1, 600, 300), 300); // exactly 300ms
    expect(t.drainTaps()).toEqual([{ id: 1, x: 600, y: 300 }]);
  });

  it('multiple taps queue in firing order', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent(down(1, 600, 300), 0);
    t.handleEvent(up(1, 600, 300), 10);
    t.handleEvent(down(2, 650, 350), 20);
    t.handleEvent(up(2, 650, 350), 30);
    expect(t.drainTaps()).toEqual([
      { id: 1, x: 600, y: 300 },
      { id: 2, x: 650, y: 350 },
    ]);
  });
});

describe('createTouchState — determinism', () => {
  it('two independently-constructed states fed the same event series produce deep-equal outputs', () => {
    const buttons = [{ id: 'jump', x: 700, y: 400, width: 60, height: 60 }];
    const opts = { screenWidth: SCREEN_WIDTH, stickRadius: 60, stickDeadzone: 0.1, buttons };
    const events: Array<{ e: TouchPointerEvent; now: number }> = [
      { e: down(1, 100, 100), now: 0 },
      { e: down(2, 600, 300), now: 0 },
      { e: move(1, 140, 100), now: 16 },
      { e: move(2, 630, 320), now: 16 },
      { e: down(3, 720, 420), now: 16 },
      { e: up(1, 140, 100), now: 100 },
      { e: up(2, 630, 320), now: 120 },
      { e: up(3, 720, 420), now: 130 },
    ];

    const a = createTouchState(opts);
    const b = createTouchState(opts);
    const resultsA = events.map(({ e, now }) => {
      a.handleEvent(e, now);
      return { stick: a.stick(), taps: a.drainTaps() };
    });
    const resultsB = events.map(({ e, now }) => {
      b.handleEvent(e, now);
      return { stick: b.stick(), taps: b.drainTaps() };
    });
    expect(resultsA).toEqual(resultsB);
  });
});

describe('createTouchState — edge cases', () => {
  it('handleEvent for an unknown touch id (move/up without a prior down) is a no-op, not a throw', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    expect(() => t.handleEvent(move(99, 100, 100), 0)).not.toThrow();
    expect(() => t.handleEvent(up(99, 100, 100), 0)).not.toThrow();
  });

  it('an explicit region hint bypasses hit-testing and half-screen assignment', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH });
    t.handleEvent({ id: 1, x: 100, y: 100, type: 'down', region: 'look' }, 0); // left half, forced to look
    expect(t.isDragging()).toBe(true);
    expect(t.stick()).toEqual({ active: false, x: 0, y: 0 });
  });

  it('a stickDeadzone of 0 still clamps a zero-distance drag to zero axes (no NaN)', () => {
    const t = createTouchState({ screenWidth: SCREEN_WIDTH, stickDeadzone: 0 });
    t.handleEvent(down(1, 100, 100), 0);
    const s = t.stick();
    expect(Number.isNaN(s.x)).toBe(false);
    expect(Number.isNaN(s.y)).toBe(false);
    expect(s).toEqual({ active: true, x: 0, y: 0 });
  });
});
