/**
 * Touch controls — pure core state machine.
 *
 * NO DOM here: this module consumes abstract pointer events
 * (`{ id, x, y, type, region? }`) and exposes the same drain-style io shape
 * `camera/r3f.tsx`'s `useCameraInput` returns (`moveAxes()`, `drainLook()`,
 * `drainZoom()`, `isDragging()`), plus button and tap state so a HUD (or the
 * GameCamera `inputOverride` seam) can consume touch exactly like the
 * existing pointer-lock/keyboard rig.
 *
 * THREE-FREE, DOM-FREE: fully unit-testable without jsdom or a canvas. Time is
 * NEVER read internally (no `Date.now`/`performance.now`) — every event and
 * poll that needs "now" takes it as an explicit argument, so tests are
 * deterministic and the DOM layer (`./r3f.tsx`) supplies the real clock.
 *
 * ── Multi-touch assignment ──────────────────────────────────────────────────
 * A touch is classified, in order, on its `down` event:
 *   1. If it lands inside a registered BUTTON region, that button claims it
 *      (buttons claim their touches first, regardless of screen half).
 *   2. Otherwise it's assigned to STICK or LOOK by which half of the screen
 *      it started in (configurable `splitX`, default: caller-provided width
 *      midpoint) — left half anchors/re-anchors the virtual stick, right half
 *      drives look-drag + is the tap/interact surface.
 * Only one touch drives the stick and one drives look at a time; a second
 * touch landing in an already-claimed half is ignored for stick/look (but can
 * still hit a button). This mirrors the classic "left thumb moves, right
 * thumb looks" twin-stick layout without requiring fixed screen regions.
 */

/** A named button region's bounding box in the same coordinate space as pointer events. */
export interface TouchButtonRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which side of the screen a touch is anchored to, once classified. */
export type TouchRole = 'stick' | 'look' | 'button' | 'ignored';

/** Abstract pointer event fed into {@link TouchState.handleEvent}. No real DOM type required. */
export interface TouchPointerEvent {
  /** Stable identifier for this touch/pointer across its down→move→up lifecycle. */
  id: number;
  x: number;
  y: number;
  type: 'down' | 'move' | 'up';
  /**
   * Optional explicit region hint (bypasses button-hit-testing / half-screen
   * assignment). Mainly for tests; the DOM layer normally leaves this unset
   * and lets {@link TouchStateOptions.buttons} + `splitX` classify it.
   */
  region?: TouchRole;
}

export interface TouchStateOptions {
  /** Screen width (or any coordinate-space width) used to split stick/look halves. Required. */
  screenWidth: number;
  /**
   * X coordinate the screen splits at. Default `screenWidth / 2`. Touches with
   * `x < splitX` anchor the stick; `x >= splitX` drive look (when not claimed
   * by a button).
   */
  splitX?: number;
  /** Virtual stick radius (event-coordinate units, e.g. px). Default 60. */
  stickRadius?: number;
  /** Stick deadzone as a fraction of radius, [0, 1). Default 0.15. */
  stickDeadzone?: number;
  /** Look-drag sensitivity multiplier applied to accumulated deltas. Default 1. */
  lookSensitivity?: number;
  /** Named button hit-regions, checked on touch-down before stick/look assignment. */
  buttons?: readonly TouchButtonRegion[];
  /**
   * Max movement (event-coordinate units) for a press to still count as a
   * TAP rather than a drag. Default 12.
   */
  tapMoveThreshold?: number;
  /**
   * Max duration in milliseconds for a press to still count as a TAP. Needs a
   * `now` timestamp on both the down and up events (see {@link TouchState.handleEvent}).
   * Default 300.
   */
  tapTimeThreshold?: number;
}

/** Resolved stick output: normalized axes + raw/derived diagnostics. */
export interface StickState {
  /** True while a touch is actively anchoring the stick. */
  active: boolean;
  /** Normalized `[x, y]` axes in [-1, 1], deadzone-applied, clamped to the unit circle. */
  x: number;
  y: number;
}

/** One-shot tap event, emitted when a short press-without-drag completes. */
export interface TouchTapEvent {
  /** The touch id that produced the tap. */
  id: number;
  x: number;
  y: number;
}

export interface TouchState {
  /**
   * Feed one abstract pointer event. `nowMs` is required for `down`/`up` (tap
   * timing) — pass a real clock in the DOM layer, fixed values in tests.
   */
  handleEvent(e: TouchPointerEvent, nowMs?: number): void;

  // ── stick (mirrors CameraInput.move / moveAxes()) ──────────────────────────
  /** Current stick axes `[strafe, forward-ish x, y]` — see {@link StickState}. */
  stick(): StickState;
  /** `[x, y]` tuple form, for direct use as `CameraInput.move` / `moveAxes()`. */
  moveAxes(): [number, number];

  // ── look (mirrors CameraInput.lookDelta / drainLook()) ──────────────────────
  /** Accumulated look-drag delta since the last drain, `[dx, dy]`, then reset. */
  drainLook(): [number, number];
  /** True while a touch is actively dragging the look surface. */
  isDragging(): boolean;

  // ── zoom (parity with the keyboard/mouse io; touch has no wheel, always 0) ──
  /** Always 0 — no pinch/zoom gesture in this slice. Present for io-shape parity. */
  drainZoom(): number;

  // ── buttons ──────────────────────────────────────────────────────────────
  /** True while `id` is currently held down. */
  isPressed(id: string): boolean;
  /**
   * True only on the frame/call after `id` transitioned from up to down.
   * Consumes the flag: a second call before the next `down` returns false.
   */
  justPressed(id: string): boolean;

  // ── tap ──────────────────────────────────────────────────────────────────
  /** Taps completed since the last drain, in firing order, then cleared. */
  drainTaps(): TouchTapEvent[];
}

interface StickTrack {
  id: number;
  anchorX: number;
  anchorY: number;
  curX: number;
  curY: number;
}

interface LookTrack {
  id: number;
  lastX: number;
  lastY: number;
}

interface PendingTouch {
  role: TouchRole;
  buttonId?: string;
  startX: number;
  startY: number;
  startMs: number;
  moved: boolean;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function hitTest(region: TouchButtonRegion, x: number, y: number): boolean {
  return (
    x >= region.x &&
    x <= region.x + region.width &&
    y >= region.y &&
    y <= region.y + region.height
  );
}

/**
 * Create a pure touch-input state machine. No DOM, no clock reads — the
 * caller drives it entirely via {@link TouchState.handleEvent}.
 */
export function createTouchState(opts: TouchStateOptions): TouchState {
  const splitX = opts.splitX ?? opts.screenWidth / 2;
  const stickRadius = opts.stickRadius ?? 60;
  const stickDeadzone = clamp(opts.stickDeadzone ?? 0.15, 0, 0.999);
  const lookSensitivity = opts.lookSensitivity ?? 1;
  const buttons = opts.buttons ?? [];
  const tapMoveThreshold = opts.tapMoveThreshold ?? 12;
  const tapTimeThreshold = opts.tapTimeThreshold ?? 300;

  /** id → classification + press-start bookkeeping, for every touch currently down. */
  const active = new Map<number, PendingTouch>();

  let stickTrack: StickTrack | null = null;
  let lookTrack: LookTrack | null = null;

  let lookAccumX = 0;
  let lookAccumY = 0;

  /** button id → held. */
  const buttonHeld = new Set<string>();
  /** button id → justPressed flag, consumed on read. */
  const buttonJustPressed = new Set<string>();

  let pendingTaps: TouchTapEvent[] = [];

  function classify(e: TouchPointerEvent): { role: TouchRole; buttonId?: string } {
    if (e.region) return { role: e.region };

    for (const b of buttons) {
      if (hitTest(b, e.x, e.y)) return { role: 'button', buttonId: b.id };
    }

    if (e.x < splitX) {
      // Left half → stick. Only one touch drives the stick at a time.
      return stickTrack === null ? { role: 'stick' } : { role: 'ignored' };
    }
    // Right half → look/tap. Only one touch drives look at a time.
    return lookTrack === null ? { role: 'look' } : { role: 'ignored' };
  }

  function handleDown(e: TouchPointerEvent, nowMs: number): void {
    const { role, buttonId } = classify(e);
    active.set(e.id, {
      role,
      buttonId,
      startX: e.x,
      startY: e.y,
      startMs: nowMs,
      moved: false,
    });

    if (role === 'stick') {
      // Anchor-on-touch-down: re-anchoring per touch is automatic since a new
      // touch always creates a fresh anchor at its own down position.
      stickTrack = { id: e.id, anchorX: e.x, anchorY: e.y, curX: e.x, curY: e.y };
    } else if (role === 'look') {
      lookTrack = { id: e.id, lastX: e.x, lastY: e.y };
    } else if (role === 'button' && buttonId) {
      if (!buttonHeld.has(buttonId)) buttonJustPressed.add(buttonId);
      buttonHeld.add(buttonId);
    }
  }

  function handleMove(e: TouchPointerEvent): void {
    const p = active.get(e.id);
    if (!p) return;

    const dx = e.x - p.startX;
    const dy = e.y - p.startY;
    if (!p.moved && Math.hypot(dx, dy) > tapMoveThreshold) p.moved = true;

    if (p.role === 'stick' && stickTrack && stickTrack.id === e.id) {
      stickTrack.curX = e.x;
      stickTrack.curY = e.y;
    } else if (p.role === 'look' && lookTrack && lookTrack.id === e.id) {
      lookAccumX += (e.x - lookTrack.lastX) * lookSensitivity;
      lookAccumY += (e.y - lookTrack.lastY) * lookSensitivity;
      lookTrack.lastX = e.x;
      lookTrack.lastY = e.y;
    }
  }

  function handleUp(e: TouchPointerEvent, nowMs: number): void {
    const p = active.get(e.id);
    if (!p) return;
    active.delete(e.id);

    if (p.role === 'stick') {
      if (stickTrack && stickTrack.id === e.id) stickTrack = null;
    } else if (p.role === 'look') {
      if (lookTrack && lookTrack.id === e.id) lookTrack = null;
      // Short press without drag on the look surface = a tap (interact).
      const elapsed = nowMs - p.startMs;
      if (!p.moved && elapsed <= tapTimeThreshold) {
        pendingTaps.push({ id: e.id, x: e.x, y: e.y });
      }
    } else if (p.role === 'button' && p.buttonId) {
      // Only release if no OTHER active touch still holds this same button.
      const stillHeld = [...active.values()].some((o) => o.role === 'button' && o.buttonId === p.buttonId);
      if (!stillHeld) buttonHeld.delete(p.buttonId);
    }
  }

  return {
    handleEvent(e: TouchPointerEvent, nowMs = 0): void {
      if (e.type === 'down') handleDown(e, nowMs);
      else if (e.type === 'move') handleMove(e);
      else handleUp(e, nowMs);
    },

    stick(): StickState {
      if (!stickTrack) return { active: false, x: 0, y: 0 };
      const dx = stickTrack.curX - stickTrack.anchorX;
      const dy = stickTrack.curY - stickTrack.anchorY;
      const dist = Math.hypot(dx, dy);
      const clamped = Math.min(dist, stickRadius);
      const deadRadius = stickDeadzone * stickRadius;

      if (clamped <= deadRadius) {
        return { active: true, x: 0, y: 0 };
      }

      // Rescale so the deadzone edge maps to 0 and the outer radius maps to 1.
      const norm = (clamped - deadRadius) / (stickRadius - deadRadius);
      const ux = dist === 0 ? 0 : dx / dist;
      const uy = dist === 0 ? 0 : dy / dist;
      return { active: true, x: clamp(ux * norm, -1, 1), y: clamp(uy * norm, -1, 1) };
    },

    moveAxes(): [number, number] {
      const s = stickTrack ? this.stick() : { x: 0, y: 0 };
      // Screen-space Y grows DOWNWARD, but CameraInput.move's forward axis is
      // positive-forward (keyboard W = +1). Negate here — the camera-facing
      // adapter — so pushing the stick UP walks forward. `stick()` stays raw
      // screen-space for nub rendering. (`|| 0` normalizes -0 → 0.)
      return [s.x, -s.y || 0];
    },

    drainLook(): [number, number] {
      const dx = lookAccumX;
      const dy = lookAccumY;
      lookAccumX = 0;
      lookAccumY = 0;
      return [dx, dy];
    },

    isDragging(): boolean {
      return lookTrack !== null;
    },

    drainZoom(): number {
      return 0;
    },

    isPressed(id: string): boolean {
      return buttonHeld.has(id);
    },

    justPressed(id: string): boolean {
      if (buttonJustPressed.has(id)) {
        buttonJustPressed.delete(id);
        return true;
      }
      return false;
    },

    drainTaps(): TouchTapEvent[] {
      const taps = pendingTaps;
      pendingTaps = [];
      return taps;
    },
  };
}
