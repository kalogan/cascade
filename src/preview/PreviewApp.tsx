/**
 * PreviewApp — Cascade's preview harness (a la PREVIEW_HARNESS.md).
 *
 * PRODUCTION-TRUTHFUL: it mounts the SAME `createEngine` (via the SAME
 * `useCascadeEngine` hook the game uses), the SAME themes/board/renderer, and
 * binds its knobs to the engine's OWN `tuning` store (every edit goes through the
 * real `tuning.set`, i.e. the real `validateTunable`). Nothing here reimplements
 * game behaviour — it only adds inspection scaffolding (world/level navigator,
 * live knobs laid out BELOW the board so it stays visible, auto-play, reset, and
 * a "bake values" export).
 *
 * Backend-free already (Cascade has no server), so this builds to a static URL.
 * Data-driven: the level navigator + knob list enumerate from the real campaign
 * curve, themes, and MATCH3_TUNING specs — new levels/worlds/knobs appear for free.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { type PublicState } from "../engine.js";
import { useCascadeEngine } from "../useCascadeEngine.js";

type WorldColors = {
  id: string;
  name: string;
  bg: string;
  surface: string;
  glow: string;
  tiles: string[];
  sky: [string, string];
};
import { MATCH3_TUNING, type TunableSpec } from "game-kit/tuning";
import { difficultyForLevel, totalLevels, DEFAULT_DIFFICULTY } from "game-kit/campaign";
import { THEMES } from "game-kit/theme";

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
  totalLevels: totalLevels(DEFAULT_DIFFICULTY),
  progress: [],
  unlocked: 0,
};

// Enumerate the real campaign curve → one descriptor per level (data-driven).
function useLevelList() {
  return useMemo(() => {
    const n = totalLevels(DEFAULT_DIFFICULTY);
    return Array.from({ length: n }, (_, i) => {
      const lc = difficultyForLevel(i);
      const theme = THEMES[Math.min(THEMES.length - 1, lc.world - 1)]!;
      return { i, world: lc.world, levelInWorld: lc.levelInWorld, worldName: theme.name };
    });
  }, []);
}

// Group the real tunable specs by their group, preserving first-seen order.
function useGroupedSpecs() {
  return useMemo(() => {
    const groups: { name: string; specs: TunableSpec[] }[] = [];
    for (const spec of MATCH3_TUNING) {
      let g = groups.find((x) => x.name === spec.group);
      if (!g) groups.push((g = { name: spec.group, specs: [] }));
      g.specs.push(spec);
    }
    return groups;
  }, []);
}

const btn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,.18)",
  background: "rgba(255,255,255,.08)",
  color: "#fff",
  font: "12px system-ui, sans-serif",
  cursor: "pointer",
};

function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }} title={label}>
      <span style={{ opacity: 0.65 }}>{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: 30, height: 22, padding: 0, border: "1px solid rgba(255,255,255,.2)", borderRadius: 4, background: "none" }}
      />
    </label>
  );
}

export function PreviewApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [s, setS] = useState<PublicState>(INIT);
  const engineRef = useCascadeEngine(canvasRef, setS);
  const levels = useLevelList();
  const groups = useGroupedSpecs();
  const [autoPlay, setAutoPlay] = useState(false);
  const [baked, setBaked] = useState<string | null>(null);
  const [vals, setVals] = useState<Record<string, number>>({});
  const [colors, setColors] = useState<Record<number, WorldColors>>({});
  const worldIdxs = useMemo(() => [...new Set(levels.map((l) => l.world - 1))], [levels]);

  // Mirror the engine's real tuning store into local state (runs after the
  // engine-mount effect, so engineRef.current is set); every knob edit round-trips
  // through the real store, so `reset()` and validation reflect here automatically.
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    setVals(eng.tuning.all());
    const seed: Record<number, WorldColors> = {};
    for (const wi of worldIdxs) seed[wi] = eng.getThemeColors(wi);
    setColors(seed);
    return eng.tuning.subscribe(setVals);
  }, [engineRef, worldIdxs]);

  // Auto-play: drive real hinted swaps so cascades/juice play while you tune.
  useEffect(() => {
    if (!autoPlay) return;
    const id = window.setInterval(() => {
      const eng = engineRef.current;
      if (!eng) return;
      if (eng.getState().phase !== "playing") eng.startLevel(s.levelIndex);
      else eng.hintSwap();
    }, 850);
    return () => window.clearInterval(id);
  }, [autoPlay, engineRef, s.levelIndex]);

  const setKnob = (key: string, v: number) => engineRef.current?.tuning.set(key, v);

  // Apply a colour edit to a world: patch the engine's theme override (live) and
  // mirror it into local state so the picker reflects it.
  const patchColor = (wi: number, patch: Parameters<NonNullable<typeof engineRef.current>["setThemeColors"]>[1], local: Partial<WorldColors>) => {
    engineRef.current?.setThemeColors(wi, patch);
    setColors((prev) => ({ ...prev, [wi]: { ...prev[wi]!, ...local } }));
  };
  const resetColors = () => {
    const eng = engineRef.current;
    if (!eng) return;
    eng.resetThemeColors();
    const seed: Record<number, WorldColors> = {};
    for (const wi of worldIdxs) seed[wi] = eng.getThemeColors(wi);
    setColors(seed);
  };

  const bake = () => {
    const eng = engineRef.current;
    if (eng) setBaked(JSON.stringify({ tunables: eng.tuning.all(), themeOverrides: eng.themeOverridesSnapshot() }, null, 2));
  };
  const worlds = [...new Set(levels.map((l) => l.world))];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0b0d16", display: "flex", flexDirection: "column" }}>
      {/* the real game canvas, portrait, centered — kept fully visible above the drawer */}
      <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center" }}>
        <div style={{ position: "relative", width: "100%", maxWidth: 440 }}>
          <canvas
            ref={canvasRef}
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block", touchAction: "none" }}
          />
        </div>
      </div>

      {/* harness controls (inspection only — never game logic), BELOW the board */}
      <div
        style={{
          flex: "0 0 auto",
          background: "rgba(10,12,20,.97)",
          borderTop: "1px solid rgba(255,255,255,.12)",
          padding: "8px 10px",
          color: "#fff",
          font: "12px system-ui, sans-serif",
          maxHeight: "52vh",
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>Cascade preview</strong>
          <span style={{ opacity: 0.7 }}>
            {s.screen === "playing" ? `${s.worldName} · L${s.levelInWorld} · ${s.score}/${s.scoreTarget}` : "menu"}
          </span>
          <span style={{ flex: 1 }} />
          <button style={{ ...btn, background: autoPlay ? "#2f7d4f" : btn.background }} onClick={() => setAutoPlay((v) => !v)}>
            {autoPlay ? "⏸ Auto-play" : "▶ Auto-play"}
          </button>
          <button style={btn} onClick={() => engineRef.current?.tuning.reset()}>Reset knobs</button>
          <button style={btn} onClick={bake}>⬇ Bake values</button>
        </div>

        {/* World × Level navigator */}
        {worlds.map((w) => (
          <div key={w} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", margin: "3px 0" }}>
            <span style={{ opacity: 0.6, width: 118 }}>{levels.find((l) => l.world === w)?.worldName}</span>
            {levels
              .filter((l) => l.world === w)
              .map((l) => (
                <button
                  key={l.i}
                  style={{ ...btn, background: s.levelIndex === l.i && s.screen === "playing" ? "#3a5bd9" : btn.background }}
                  onClick={() => engineRef.current?.startLevel(l.i)}
                >
                  L{l.levelInWorld}
                </button>
              ))}
          </div>
        ))}

        {/* Live knobs, grouped — bound to the real tuning store */}
        {groups.map((g) => (
          <fieldset key={g.name} style={{ border: "1px solid rgba(255,255,255,.14)", borderRadius: 8, margin: "8px 0 0", padding: "4px 8px 8px" }}>
            <legend style={{ opacity: 0.75, padding: "0 4px" }}>{g.name}</legend>
            {g.specs.map((spec) => {
              const v = vals[spec.key] ?? spec.default;
              return (
                <div key={spec.key} style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0" }}>
                  <label htmlFor={`k-${spec.key}`} title={spec.description} style={{ flex: "1 1 auto", minWidth: 130 }}>
                    {spec.label}
                  </label>
                  <input
                    id={`k-${spec.key}`}
                    type="range"
                    min={spec.min}
                    max={spec.max}
                    step={spec.step}
                    value={v}
                    onChange={(e) => setKnob(spec.key, Number(e.target.value))}
                    style={{ flex: "1 1 120px" }}
                  />
                  <span style={{ width: 46, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                    {spec.integer ? v : Math.round(v * 100) / 100}
                  </span>
                </div>
              );
            })}
          </fieldset>
        ))}

        {/* Per-world colour knobs (drive theme overrides live via resolveTheme) */}
        <fieldset style={{ border: "1px solid rgba(255,255,255,.14)", borderRadius: 8, margin: "8px 0 0", padding: "4px 8px 8px" }}>
          <legend style={{ opacity: 0.75, padding: "0 4px" }}>
            Colours{" "}
            <button style={{ ...btn, padding: "2px 8px", marginLeft: 6 }} onClick={resetColors}>
              Reset colours
            </button>
          </legend>
          {worldIdxs.map((wi) => {
            const c = colors[wi];
            if (!c) return null;
            return (
              <div key={wi} style={{ margin: "4px 0 6px" }}>
                <div style={{ opacity: 0.6, margin: "2px 0" }}>{c.name}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <ColorField label="bg" value={c.bg} onChange={(v) => patchColor(wi, { palette: { bg: v } }, { bg: v })} />
                  <ColorField label="board" value={c.surface} onChange={(v) => patchColor(wi, { palette: { surface: v } }, { surface: v })} />
                  <ColorField label="glow" value={c.glow} onChange={(v) => patchColor(wi, { palette: { glow: v } }, { glow: v })} />
                  <ColorField label="sky↑" value={c.sky[0]} onChange={(v) => patchColor(wi, { backdrop: { sky: [v, c.sky[1]] } }, { sky: [v, c.sky[1]] })} />
                  <ColorField label="sky↓" value={c.sky[1]} onChange={(v) => patchColor(wi, { backdrop: { sky: [c.sky[0], v] } }, { sky: [c.sky[0], v] })} />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", marginTop: 4 }}>
                  <span style={{ opacity: 0.6 }}>tiles</span>
                  {c.tiles.map((tile, k) => (
                    <input
                      key={k}
                      type="color"
                      value={tile}
                      title={`tile ${k}`}
                      onChange={(e) => {
                        const nt = c.tiles.slice();
                        nt[k] = e.target.value;
                        patchColor(wi, { palette: { tiles: nt } }, { tiles: nt });
                      }}
                      style={{ width: 26, height: 22, padding: 0, border: "1px solid rgba(255,255,255,.2)", borderRadius: 4, background: "none" }}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </fieldset>

        {baked && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4 }}>
              <span style={{ opacity: 0.7 }}>Baked tunables (paste into MATCH3_TUNING defaults / DEFAULT_TILE_SHINE):</span>
              <button style={btn} onClick={() => navigator.clipboard?.writeText(baked)}>Copy</button>
              <button style={btn} onClick={() => setBaked(null)}>Close</button>
            </div>
            <textarea
              readOnly
              value={baked}
              style={{ width: "100%", height: 120, background: "#05060f", color: "#cfe", border: "1px solid rgba(255,255,255,.15)", borderRadius: 6, font: "11px monospace", padding: 6 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
