/**
 * Touch controls — DOM/React layer.
 *
 * The pure {@link createTouchState} (./index.ts) is DOM-free: it consumes
 * abstract `{ id, x, y, type, region? }` events and a caller-supplied clock.
 * `<TouchControls>` is the real thing a game mounts: it renders a virtual
 * stick (+ optional action buttons), wires real PointerEvents into the core,
 * and hands back the resulting io — the SAME shape `useCameraInput` returns
 * (`moveAxes()`, `drainLook()`, `drainZoom()`, `isDragging()`), so it drops
 * straight into `<GameCamera inputOverride={...} />` (see `../camera/r3f.tsx`).
 *
 * Not a React-Three-Fiber component — this renders plain HTML **outside** the
 * `<Canvas>`, absolutely positioned over it, like a HUD layer (see
 * `../hud/index.ts`). Despite the `r3f.tsx` filename (matching this kit's
 * convention for "react + peer-dep" modules), it does not touch three or
 * @react-three/fiber.
 *
 * Requires the react peer dep (optional in package.json).
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createTouchState, type TouchButtonRegion, type TouchState, type TouchTapEvent } from './index.js';

/**
 * True when the environment looks like a touch device: `(pointer: coarse)`
 * media query first (most reliable for "primary input is touch"), falling
 * back to `ontouchstart` presence for older/non-standard UAs. Returns false
 * during SSR (no `window`).
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    } catch {
      // matchMedia can throw in exotic/embedded environments — fall through.
    }
  }
  return 'ontouchstart' in window || (navigator?.maxTouchPoints ?? 0) > 0;
}

/** A single on-screen action button. */
export interface TouchActionButton {
  /** Stable id — read back via `io.isPressed(id)` / `io.justPressed(id)`. */
  id: string;
  /** Short label rendered on the button (e.g. "A", "Jump"). */
  label: string;
  /** Optional imperative callback fired on the down transition (in addition to justPressed()). */
  onPress?: () => void;
}

export interface TouchControlsProps {
  /** Action buttons rendered bottom-right, stacked. Omit for stick+look only. */
  buttons?: readonly TouchActionButton[];
  /** Virtual stick radius in px. Default 60. */
  stickRadius?: number;
  /** Stick deadzone as a fraction of radius. Default 0.15. */
  stickDeadzone?: number;
  /** Look-drag sensitivity multiplier. Default 1. */
  lookSensitivity?: number;
  /** Max px movement for a press to still count as a tap. Default 12. */
  tapMoveThreshold?: number;
  /** Max ms duration for a press to still count as a tap. Default 300. */
  tapTimeThreshold?: number;
  /** Fired for every completed tap (drag-free short press) on the look surface. */
  onTap?: (tap: TouchTapEvent) => void;
  /** Called once with the live {@link TouchIO} — wire this into GameCamera's `inputOverride`. */
  onReady?: (io: TouchIO) => void;
  /** Extra class name on the root overlay. */
  className?: string;
}

/**
 * The io shape `useCameraInput` (camera/r3f.tsx) exposes, so this drops
 * straight into `GameCamera`'s `inputOverride` prop with no adapter.
 */
export interface TouchIO {
  drainLook(): [number, number];
  moveAxes(): [number, number];
  drainZoom(): number;
  isDragging(): boolean;
  /** True while `id` is currently held down. */
  isPressed(id: string): boolean;
  /** True only on the down transition; consumed on read. */
  justPressed(id: string): boolean;
}

const ROOT_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  // The overlay itself never blocks canvas interaction; only its children
  // (the look surface, stick base, buttons) opt back in via pointerEvents: 'auto'.
  pointerEvents: 'none',
  touchAction: 'none',
  userSelect: 'none',
  zIndex: 10,
  // Safe-area-inset aware: keep controls clear of notches/home indicators.
  paddingLeft: 'env(safe-area-inset-left, 0px)',
  paddingRight: 'env(safe-area-inset-right, 0px)',
  paddingBottom: 'env(safe-area-inset-bottom, 0px)',
  paddingTop: 'env(safe-area-inset-top, 0px)',
};

/**
 * The right-half "look" surface. Unlike the stick/buttons (small opt-in hit
 * areas), this must cover the WHOLE right half so a drag starting anywhere
 * over there reaches the core — the root itself is `pointer-events: none`
 * and would otherwise let those touches fall straight through to the canvas.
 * Sits UNDER the stick base and button column in DOM order so their own
 * (smaller, opt-in) hit areas still win on overlap.
 */
const LOOK_SURFACE_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  left: '50%',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const STICK_BASE_STYLE: CSSProperties = {
  position: 'absolute',
  left: 24,
  bottom: 24,
  width: 120,
  height: 120,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.25)',
  pointerEvents: 'auto',
  touchAction: 'none',
};

const STICK_NUB_STYLE: CSSProperties = {
  position: 'absolute',
  width: 52,
  height: 52,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.35)',
  left: '50%',
  top: '50%',
  willChange: 'transform',
};

const BUTTON_COLUMN_STYLE: CSSProperties = {
  position: 'absolute',
  right: 24,
  bottom: 24,
  display: 'flex',
  flexDirection: 'column-reverse',
  gap: 12,
  pointerEvents: 'none',
};

const BUTTON_STYLE: CSSProperties = {
  width: 64,
  height: 64,
  borderRadius: '50%',
  background: 'rgba(255,255,255,0.12)',
  border: '1px solid rgba(255,255,255,0.25)',
  color: 'rgba(255,255,255,0.85)',
  fontSize: 14,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  pointerEvents: 'auto',
  touchAction: 'none',
  userSelect: 'none',
};

const BUTTON_PRESSED_STYLE: CSSProperties = {
  background: 'rgba(255,255,255,0.3)',
};

/**
 * Renders the stick (base + nub that follows the touch) and optional action
 * buttons; wires real PointerEvents into a `createTouchState` instance;
 * exposes the resulting io via `onReady`. Translucent + unobtrusive: only the
 * stick/button hit areas capture pointer events, everything else passes
 * through to the canvas beneath.
 *
 * Mount this as a sibling OVERLAY of your `<Canvas>` (both inside a
 * `position: relative` container), not inside the Canvas itself:
 *
 * ```tsx
 * <div style={{ position: 'relative', width: '100%', height: '100%' }}>
 *   <Canvas><GameCamera mode="first" inputOverride={touchIoRef.current} /></Canvas>
 *   {isTouchDevice() && (
 *     <TouchControls
 *       buttons={[{ id: 'interact', label: 'E' }]}
 *       onReady={(io) => { touchIoRef.current = io; }}
 *     />
 *   )}
 * </div>
 * ```
 */
export function TouchControls(props: TouchControlsProps): JSX.Element {
  const { buttons = [], onTap, onReady, className } = props;

  const rootRef = useRef<HTMLDivElement | null>(null);
  const stickBaseRef = useRef<HTMLDivElement | null>(null);
  const nubRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  const stickRadius = props.stickRadius ?? 60;

  // Rebuild button hit-regions relative to the root's viewport rect whenever the
  // button set or root size changes. Regions are in the same coordinate space
  // as clientX/clientY (viewport px), matching the pointer events below.
  const [buttonRegions, setButtonRegions] = useState<TouchButtonRegion[]>([]);

  useEffect(() => {
    const measure = () => {
      const regions: TouchButtonRegion[] = [];
      for (const b of buttons) {
        const el = buttonRefs.current.get(b.id);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        regions.push({ id: b.id, x: r.left, y: r.top, width: r.width, height: r.height });
      }
      setButtonRegions(regions);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttons.map((b) => b.id).join(',')]);

  const [touchState] = useState<{ current: TouchState | null }>({ current: null });

  useEffect(() => {
    const width = rootRef.current?.clientWidth ?? window.innerWidth;
    const state = createTouchState({
      screenWidth: width,
      stickRadius,
      stickDeadzone: props.stickDeadzone,
      lookSensitivity: props.lookSensitivity,
      buttons: buttonRegions,
      tapMoveThreshold: props.tapMoveThreshold,
      tapTimeThreshold: props.tapTimeThreshold,
    });
    touchState.current = state;

    const io: TouchIO = {
      drainLook: () => state.drainLook(),
      moveAxes: () => state.moveAxes(),
      drainZoom: () => state.drainZoom(),
      isDragging: () => state.isDragging(),
      isPressed: (id) => state.isPressed(id),
      justPressed: (id) => state.justPressed(id),
    };
    onReady?.(io);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttonRegions, stickRadius, props.stickDeadzone, props.lookSensitivity, props.tapMoveThreshold, props.tapTimeThreshold]);

  // Drive the stick nub + button pressed-visuals + onTap/onPress callbacks from
  // a rAF loop reading the core state — keeps the DOM in sync without the game
  // having to call back into this component every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const state = touchState.current;
      if (state) {
        const s = state.stick();
        const nub = nubRef.current;
        if (nub) {
          const dx = s.x * stickRadius;
          const dy = s.y * stickRadius;
          nub.style.transform = `translate(-50%, -50%) translate(${dx}px, ${dy}px)`;
        }

        for (const b of buttons) {
          const el = buttonRefs.current.get(b.id);
          if (el) {
            const pressed = state.isPressed(b.id);
            Object.assign(el.style, pressed ? BUTTON_PRESSED_STYLE : { background: BUTTON_STYLE.background });
          }
          if (state.justPressed(b.id)) b.onPress?.();
        }

        const taps = state.drainTaps();
        if (onTap) for (const t of taps) onTap(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buttons, stickRadius, onTap]);

  // Pointer events bubble from whichever interactive child (look surface,
  // stick base, button) they started on up to this single set of handlers on
  // the root, keyed by e.pointerId — the pure core tracks each pointerId's
  // stick/look/button assignment independently, so N concurrent pointers
  // (e.g. left thumb on the stick + right hand dragging look) flow through
  // cleanly with no shared-state stomping.
  //
  // `setPointerCapture` on `down` (released on `up`/`cancel`) pins this
  // pointerId's subsequent events to `e.currentTarget` — the ROOT div, since
  // that's the only element these handlers are bound to (they fire via
  // bubbling from whichever child the touch actually started on). Without
  // capture, a look-drag that crosses the stick/look midline — or a finger
  // that briefly leaves the look surface's bounds (e.g. sliding onto the
  // button column or off-screen) — gets re-targeted by the browser to
  // whatever element is currently under the finger, which may have
  // `pointer-events: none` and simply swallow the rest of the drag. Capture
  // makes the root the sole, permanent recipient of that pointerId's events
  // for its whole down→up lifecycle, independent of where the finger
  // physically travels.
  const handlePointer = (type: 'down' | 'move' | 'up') => (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = touchState.current;
    if (!state) return;
    if (type === 'down') {
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // setPointerCapture can throw in exotic/embedded environments (or if
        // the pointerId is already gone) — capture is a reliability
        // enhancement, not load-bearing, so ignore and continue.
      }
    } else if (type === 'up') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Already released/never captured — fine to ignore.
      }
    }
    state.handleEvent({ id: e.pointerId, x: e.clientX, y: e.clientY, type }, performance.now());
  };

  return (
    <div
      ref={rootRef}
      className={className}
      style={ROOT_STYLE}
      onPointerDown={handlePointer('down')}
      onPointerMove={handlePointer('move')}
      onPointerUp={handlePointer('up')}
      onPointerCancel={handlePointer('up')}
    >
      <div style={LOOK_SURFACE_STYLE} />
      <div ref={stickBaseRef} style={STICK_BASE_STYLE}>
        <div ref={nubRef} style={STICK_NUB_STYLE} />
      </div>
      {buttons.length > 0 && (
        <div style={BUTTON_COLUMN_STYLE}>
          {buttons.map((b) => (
            <div
              key={b.id}
              ref={(el) => {
                if (el) buttonRefs.current.set(b.id, el);
                else buttonRefs.current.delete(b.id);
              }}
              style={BUTTON_STYLE}
            >
              {b.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
