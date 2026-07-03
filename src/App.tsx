/**
 * Cascade — React shell. Mounts the canvas, drives the engine, and renders the
 * HUD, level-select map, and win/lose overlays off the engine's PublicState.
 * Portrait / mobile-first; all game input is pointer-based (tap-to-select-then-
 * tap-neighbour, or drag-to-swap).
 */
import { useEffect, useRef, useState } from "react";
import { createEngine, type Engine, type PublicState } from "./engine.js";

const INIT: PublicState = {
  screen: "menu",
  phase: "ready",
  levelIndex: 0,
  world: 1,
  levelInWorld: 1,
  worldName: "",
  score: 0,
  scoreTarget: 0,
  movesLeft: 0,
  stars: 0,
  totalLevels: 9,
  progress: [],
  unlocked: 0,
};

function Stars({ n, size = 16 }: { n: number; size?: number }) {
  return (
    <span aria-label={`${n} of 3 stars`} style={{ fontSize: size, letterSpacing: 1 }}>
      {"★★★".slice(0, n) + "☆☆☆".slice(0, 3 - n)}
    </span>
  );
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const [s, setS] = useState<PublicState>(INIT);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = createEngine(canvas, { onState: setS });
    engineRef.current = engine;
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
  }, []);

  const eng = engineRef.current;
  const worldOf = (i: number) => Math.floor(i / 3) + 1;
  const WORLD_NAMES = ["Verdant Glade", "Ember Reach", "Astral Deep"];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", background: "#0b0d16", overflow: "hidden" }}>
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" }} />

      {/* ── in-game HUD ── */}
      {s.screen === "playing" && (
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-start", color: "#fff", fontFamily: "system-ui, sans-serif", pointerEvents: "none", textShadow: "0 1px 3px rgba(0,0,0,.6)" }}>
          <div>
            <div style={{ fontSize: 13, opacity: 0.85 }}>
              World {s.world} · {s.worldName}
            </div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>Level {s.levelInWorld} of 3</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{s.score}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>target {s.scoreTarget}</div>
            <div style={{ width: 120, height: 6, background: "rgba(255,255,255,.2)", borderRadius: 4, marginTop: 4, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, (s.score / Math.max(1, s.scoreTarget)) * 100)}%`, height: "100%", background: "#ffe08a" }} />
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1, color: s.movesLeft <= 4 ? "#ff9a8a" : "#fff" }}>{s.movesLeft}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>moves</div>
          </div>
        </div>
      )}

      {/* ── menu button while playing ── */}
      {s.screen === "playing" && s.phase === "playing" && (
        <button
          onClick={() => eng?.toMenu()}
          style={{ position: "absolute", bottom: 10, left: 12, padding: "8px 14px", minHeight: 44, borderRadius: 10, border: "none", background: "rgba(255,255,255,.14)", color: "#fff", fontSize: 14, cursor: "pointer" }}
        >
          ☰ Levels
        </button>
      )}

      {/* ── win / lose overlay ── */}
      {s.screen === "playing" && (s.phase === "won" || s.phase === "lost") && (
        <div style={overlayStyle}>
          <div style={cardStyle}>
            <h2 style={{ margin: "0 0 6px", fontSize: 26 }}>{s.phase === "won" ? "Level Cleared!" : "Out of Moves"}</h2>
            {s.phase === "won" && (
              <div style={{ margin: "6px 0 10px" }}>
                <Stars n={s.stars} size={30} />
              </div>
            )}
            <div style={{ opacity: 0.8, marginBottom: 16, fontSize: 15 }}>
              {s.score} / {s.scoreTarget} points
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
              {s.phase === "won" && s.levelIndex < s.totalLevels - 1 && (
                <button style={btnPrimary} onClick={() => eng?.advance()}>
                  Next →
                </button>
              )}
              {s.phase === "won" && s.levelIndex >= s.totalLevels - 1 && (
                <button style={btnPrimary} onClick={() => eng?.toMenu()}>
                  ✦ Run Complete
                </button>
              )}
              <button style={btnGhost} onClick={() => eng?.retry()}>
                Retry
              </button>
              <button style={btnGhost} onClick={() => eng?.toMenu()}>
                Levels
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── level-select map ── */}
      {s.screen === "menu" && (
        <div style={{ ...overlayStyle, alignItems: "flex-start", overflowY: "auto" }}>
          <div style={{ width: "min(440px, 92vw)", padding: "28px 8px 40px", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
            <h1 style={{ textAlign: "center", fontSize: 34, margin: "6px 0 2px", letterSpacing: 1 }}>Cascade</h1>
            <p style={{ textAlign: "center", opacity: 0.7, marginTop: 0, fontSize: 14 }}>
              Match 3+ · chain the cascades · three worlds
            </p>
            {[0, 1, 2].map((w) => (
              <div key={w} style={{ marginTop: 22 }}>
                <div style={{ fontSize: 14, opacity: 0.85, marginBottom: 8, paddingLeft: 4 }}>
                  World {w + 1} — {WORLD_NAMES[w]}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  {[0, 1, 2].map((l) => {
                    const i = w * 3 + l;
                    const locked = i > s.unlocked;
                    const stars = s.progress[i] ?? 0;
                    return (
                      <button
                        key={i}
                        disabled={locked}
                        onClick={() => eng?.startLevel(i)}
                        style={{
                          minHeight: 72,
                          borderRadius: 14,
                          border: "none",
                          cursor: locked ? "not-allowed" : "pointer",
                          background: locked ? "rgba(255,255,255,.06)" : WORLD_TINT[w],
                          color: locked ? "rgba(255,255,255,.4)" : "#fff",
                          fontSize: 15,
                          fontWeight: 600,
                          display: "flex",
                          flexDirection: "column",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 4,
                        }}
                      >
                        <span>{locked ? "🔒" : `Level ${l + 1}`}</span>
                        {!locked && <Stars n={stars} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p style={{ textAlign: "center", opacity: 0.45, fontSize: 12, marginTop: 26 }}>
              Tap a tile then an adjacent one — or drag to swap. Append <code>?tune</code> for live tuning.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const WORLD_TINT = ["#2f6b4f", "#8a4326", "#3a2f6b"];
const overlayStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(6,8,16,.55)",
  backdropFilter: "blur(2px)",
};
const cardStyle: React.CSSProperties = {
  background: "rgba(20,24,40,.94)",
  color: "#fff",
  padding: "26px 28px",
  borderRadius: 20,
  textAlign: "center",
  fontFamily: "system-ui, sans-serif",
  boxShadow: "0 12px 40px rgba(0,0,0,.5)",
  maxWidth: "88vw",
};
const btnPrimary: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 22px",
  borderRadius: 12,
  border: "none",
  background: "#ffe08a",
  color: "#20180a",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};
const btnGhost: React.CSSProperties = {
  minHeight: 44,
  padding: "10px 18px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.25)",
  background: "transparent",
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
};
