/**
 * useCascadeEngine — mounts the REAL Cascade engine on a canvas with the exact
 * production pointer wiring, and returns a ref to it. Shared verbatim by the game
 * shell (App.tsx) and the preview harness (src/preview) so the harness renders
 * precisely what ships — no forked mount, per the preview-harness "reuse, never
 * duplicate" rule.
 */
import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { createEngine, type Engine, type PublicState } from "./engine.js";

export function useCascadeEngine(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  onState: (s: PublicState) => void,
): RefObject<Engine | null> {
  const engineRef = useRef<Engine | null>(null);
  // Latest onState without re-running the mount effect (which must run once).
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = createEngine(canvas, { onState: (s) => onStateRef.current(s) });
    engineRef.current = engine;
    // Debug/smoke seam: expose the engine so the headless runtime smoke can drive
    // deterministic hinted swaps and level jumps. Harmless in prod (unused).
    (window as unknown as { __cascade?: Engine }).__cascade = engine;
    engine.start();

    const ro = new ResizeObserver(() => engine.relayout());
    ro.observe(canvas);
    const onResize = () => engine.relayout();
    window.addEventListener("resize", onResize);

    const pos = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const down = (e: PointerEvent) => {
      canvas.setPointerCapture?.(e.pointerId);
      const [x, y] = pos(e);
      engine.pointerDown(x, y);
    };
    const move = (e: PointerEvent) => {
      const [x, y] = pos(e);
      engine.pointerMove(x, y);
    };
    const up = () => engine.pointerUp();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);

    return () => {
      engine.stop();
      ro.disconnect();
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, [canvasRef]);

  return engineRef;
}
