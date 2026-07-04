/**
 * Cascade — the game engine (non-React). Owns the board core, the Canvas2D
 * renderer + camera, the particle system, audio, the difficulty/run state, and
 * the animation sequencer. React (App.tsx) is a thin shell: it mounts the canvas,
 * forwards pointer events, and renders HUD/menu/overlays off `onState`.
 *
 * The load-bearing seam (per the plan): the pure `board` core emits a BoardEvent
 * stream from `resolve()`; this engine CONSUMES that stream to drive tile motion,
 * particles, screen-shake, score, and the rising combo-chime — the core never
 * re-derives juice, and the juice never re-derives logic.
 */
import { createBoard, type Board, type BoardEvent, type Cell } from "game-kit/board";
import { createRenderer2D, createCamera2D, type Renderer2D, type Camera2D } from "game-kit/render2d";
import { createParticleSystem, playFx, type ParticleSystem } from "game-kit/fx2d";
import {
  detectDeviceTier,
  createFrameMonitor,
  createAdaptiveQuality,
  type DeviceTier,
} from "game-kit/perf";
import {
  difficultyForLevel,
  DEFAULT_DIFFICULTY,
  totalLevels,
  initRun,
  runReducer,
  type LevelConfig,
  type RunState,
} from "game-kit/campaign";
import { THEMES, resolveTheme, type ThemeDef } from "game-kit/theme";
import { createTuning, mountTuningPanel, MATCH3_TUNING, type Tuning } from "game-kit/tuning";
import { createRng } from "game-kit/prng";
import { createAudioManager, type AudioManager } from "game-kit/audio";
import { createGridInput } from "game-kit/grid-input";
import { createMetaStore, initMeta, type MetaState } from "game-kit/meta";

export interface PublicState {
  screen: "menu" | "playing";
  phase: RunState["phase"];
  levelIndex: number;
  world: number;
  levelInWorld: number;
  worldName: string;
  score: number;
  scoreTarget: number;
  movesLeft: number;
  stars: number;
  totalLevels: number;
  /** best stars earned per level (0 = unplayed); length = totalLevels */
  progress: number[];
  /** highest level index unlocked (playable) */
  unlocked: number;
  /** cross-run progression: streaks, per-level best scores, aggregate stats */
  meta: MetaState;
}

interface VTile {
  id: number;
  kind: number;
  row: number;
  col: number;
  x: number;
  y: number;
  scale: number;
  alpha: number;
  clearing: boolean;
  clearT: number;
  /** "Locked" (crated) obstacle tile — unmatchable/unswappable until a neighbour clears. */
  locked: boolean;
}

interface Scheduled {
  at: number;
  fn: () => void;
  done: boolean;
}

const CLEAR_SECONDS = 0.16;

// Backdrop drift multiplier and world cross-fade duration are now live tunables
// (`backdropMotion`, `worldFadeMs` in MATCH3_TUNING → editable in the preview
// harness / ?tune panel), read via `t()` below rather than baked here.

// What each perf tier means for THIS game (perf owns *when* to switch; the game
// owns *what* the switch scales). DPR cap is set once at boot from the detected
// tier; the particle-budget multiplier adapts live as the frame monitor reacts.
const TIER_DPR_CAP: Record<DeviceTier, number> = { low: 1, mid: 1.5, high: 2 };
const TIER_PARTICLE_SCALE: Record<DeviceTier, number> = { low: 0.35, mid: 0.7, high: 1 };
// Re-evaluate the adaptive tier this often (frames), not every frame.
const TIER_TICK_FRAMES = 30;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface EngineHooks {
  onState(s: PublicState): void;
}

export function createEngine(canvas: HTMLCanvasElement, hooks: EngineHooks) {
  // perf: pick a starting tier from the device (overridable with ?tier=low|mid|high),
  // cap the render DPR to match, and thereafter let the adaptive controller thin
  // the particle budget live if frames start dropping.
  const startTier = detectDeviceTier();
  const frameMon = createFrameMonitor();
  const adaptive = createAdaptiveQuality({ start: startTier, monitor: frameMon });
  let particleScale = TIER_PARTICLE_SCALE[startTier];
  let tierTickCounter = 0;

  const renderer: Renderer2D = createRenderer2D(canvas, { dprCap: TIER_DPR_CAP[startTier] });
  const rng = createRng(0xca5cade);
  const camera: Camera2D = createCamera2D({ rng: rng.fork(7) });
  const tuning: Tuning = createTuning(MATCH3_TUNING, { storeKey: "cascade-tuning" });
  const psys: ParticleSystem = createParticleSystem({ cap: 600, rng: rng.fork(11) });
  const audio: AudioManager = createAudioManager();

  // Cross-run progression (streaks, per-level best scores, aggregates), persisted.
  const metaStore = createMetaStore({ key: "cascade-meta-v1" });
  let metaState: MetaState = metaStore.get();
  let levelRecorded = false; // record each level's result into meta exactly once

  // progress persistence (kit save would work; a tiny localStorage shim keeps the
  // engine dependency-light and is headless-safe).
  const SAVE_KEY = "cascade-progress-v1";
  const N = totalLevels(DEFAULT_DIFFICULTY);
  let progress: number[] = new Array(N).fill(0);
  let unlocked = 0;
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SAVE_KEY) : null;
    if (raw) {
      const p = JSON.parse(raw) as { progress?: number[]; unlocked?: number };
      if (Array.isArray(p.progress)) for (let i = 0; i < N; i++) progress[i] = p.progress[i] ?? 0;
      if (typeof p.unlocked === "number") unlocked = Math.max(0, Math.min(N - 1, p.unlocked));
    }
  } catch {
    /* ignore corrupt save */
  }
  function persist() {
    try {
      if (typeof localStorage !== "undefined")
        localStorage.setItem(SAVE_KEY, JSON.stringify({ progress, unlocked }));
    } catch {
      /* ignore */
    }
  }

  if (typeof document !== "undefined") mountTuningPanel(tuning, MATCH3_TUNING, { urlToggle: "tune" });

  // Push the Shine tunables into the renderer, live. Applied on boot and on every
  // tuning change so the preview harness / ?tune panel dials tile gloss with no
  // recompile; the values mirror render2d's DEFAULT_TILE_SHINE.
  function applyShine() {
    renderer.setTileShine({
      glowAlpha: tuning.get("glowAlpha"),
      glowRadius: tuning.get("glowRadius"),
      sheenLight: tuning.get("sheenLight"),
      sheenShadow: tuning.get("sheenShadow"),
      highlight: tuning.get("highlight"),
    });
  }
  applyShine();
  tuning.subscribe(applyShine);

  // ── per-world colour overrides (preview-harness "colour knobs") ───────────
  // Deep-merged onto the authored THEME via resolveTheme, keyed by theme id, and
  // persisted so a tuned palette survives reload. Empty by default → ships as
  // authored. The harness edits these live; `bake` dumps them for THEMES.
  // Nested-partial override (resolveTheme deep-merges; its param type is the
  // conservative Partial<ThemeDef>, so we cast at the one call site).
  type ThemeOverride = { palette?: Partial<ThemeDef["palette"]>; backdrop?: Partial<ThemeDef["backdrop"]> };
  const THEME_OVR_KEY = "cascade-theme-overrides";
  let themeOverrides: Record<string, ThemeOverride> = (() => {
    try {
      const raw = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_OVR_KEY) : null;
      return raw ? (JSON.parse(raw) as Record<string, ThemeOverride>) : {};
    } catch {
      return {};
    }
  })();
  const persistThemeOverrides = () => {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(THEME_OVR_KEY, JSON.stringify(themeOverrides));
    } catch {
      /* ignore */
    }
  };
  const baseThemeFor = (worldIdx: number): ThemeDef => THEMES[Math.max(0, Math.min(THEMES.length - 1, worldIdx))]!;
  const resolvedThemeFor = (worldIdx: number): ThemeDef => {
    const base = baseThemeFor(worldIdx);
    const ovr = themeOverrides[base.id];
    return ovr ? resolveTheme(base, ovr as Partial<ThemeDef>) : base;
  };

  // ── mutable game state ──────────────────────────────────────────────────
  let screen: PublicState["screen"] = "menu";
  let level: LevelConfig = difficultyForLevel(0);
  let theme: ThemeDef = resolvedThemeFor(0);
  let board: Board | null = null;
  let run: RunState = initRun(0);
  let rows = level.boardH;
  let cols = level.boardW;

  let vtiles = new Map<number, VTile>();
  let idAt = new Int32Array(rows * cols).fill(-1);
  let nextId = 1;

  let busy = false;

  // animation timeline
  let scheduled: Scheduled[] = [];
  let tl = 0;
  let animEnd = 0;
  let finalizePending = false;

  // layout
  let cell = 40;
  let originX = 0;
  let originY = 0;
  let cssW = 0;
  let cssH = 0;

  let time = 0; // wall seconds for backdrop drift

  // World cross-fade: when startLevel crosses into a new world's theme we hold
  // the outgoing scenery in `prevTheme` and ramp `worldFadeT` down to 0, blending
  // the new backdrop in over the old so scenery *dissolves* between worlds.
  let prevTheme: ThemeDef | null = null;
  let worldFadeT = 0;
  let worldFadeDur = 0.9; // seconds; captured from the `worldFadeMs` tunable per fade

  const idx = (c: Cell) => c.row * cols + c.col;
  const cx = (col: number) => originX + col * cell + cell / 2;
  const cy = (row: number) => originY + row * cell + cell / 2;
  const t = (k: string) => tuning.get(k);

  function relayout() {
    cssW = canvas.clientWidth || canvas.width || 400;
    cssH = canvas.clientHeight || canvas.height || 700;
    renderer.resize(cssW, cssH);
    const topReserve = Math.min(96, cssH * 0.14); // HUD band
    const botReserve = Math.min(40, cssH * 0.06);
    const availW = cssW - 24;
    const availH = cssH - topReserve - botReserve;
    cell = Math.floor(Math.min(availW / cols, availH / rows));
    const boardW = cell * cols;
    const boardH = cell * rows;
    originX = Math.floor((cssW - boardW) / 2);
    originY = Math.floor(topReserve + (availH - boardH) / 2);
  }

  function buildVTiles() {
    vtiles = new Map();
    idAt = new Int32Array(rows * cols).fill(-1);
    nextId = 1;
    if (!board) return;
    const snap = board.snapshot();
    const locked = board.lockedSnapshot();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const kind = snap[r * cols + c]!;
        if (kind < 0) continue;
        const id = nextId++;
        vtiles.set(id, { id, kind, row: r, col: c, x: cx(c), y: cy(r), scale: 1, alpha: 1, clearing: false, clearT: 0, locked: locked[r * cols + c] ?? false });
        idAt[r * cols + c] = id;
      }
    }
  }

  function emit() {
    hooks.onState({
      screen,
      phase: run.phase,
      levelIndex: run.levelIndex,
      world: level.world,
      levelInWorld: level.levelInWorld,
      worldName: theme.name,
      score: run.score,
      scoreTarget: run.scoreTarget,
      movesLeft: run.movesLeft,
      stars: run.stars,
      totalLevels: N,
      progress: progress.slice(),
      unlocked,
      meta: metaState,
    });
  }

  // ── level lifecycle ─────────────────────────────────────────────────────
  function startLevel(index: number) {
    index = Math.max(0, Math.min(N - 1, index));
    const outgoingTheme = theme;
    // Difficulty curve params ride two live tunables (moveBudgetDecay,
    // scoreTargetGrowth); defaults equal DEFAULT_DIFFICULTY so this is a no-op
    // until the Director dials them.
    const curveParams = {
      ...DEFAULT_DIFFICULTY,
      moveBudgetDecay: t("moveBudgetDecay"),
      scoreTargetGrowth: t("scoreTargetGrowth"),
    };
    level = difficultyForLevel(index, curveParams);
    theme = resolvedThemeFor(level.world - 1);
    // Only cross-fade when the scenery actually changes (a new world), not on
    // every level start within the same world.
    if (screen === "playing" && outgoingTheme !== theme) {
      prevTheme = outgoingTheme;
      worldFadeDur = t("worldFadeMs") / 1000;
      worldFadeT = worldFadeDur;
    } else {
      prevTheme = null;
      worldFadeT = 0;
    }
    rows = level.boardH;
    cols = level.boardW;
    const lrng = createRng(0x5eed + index * 2654435761);
    // Campaign's per-world obstacleDensity → a count of "locked" (crated) tiles
    // (World 1 = 0, so it stays a clean onboarding board; W2/W3 ramp up).
    const lockedCount = Math.round(level.obstacleDensity * rows * cols);
    board = createBoard({ rows, cols, kinds: level.tileKinds, rng: lrng, lockedCount });
    // Same curve params flow into the run so scoreTarget/moveBudget match the
    // level (the difficulty knobs actually move the target, not just the board).
    run = runReducer(initRun(index, curveParams), { type: "start", levelIndex: index, params: curveParams });
    grid.clear();
    levelRecorded = false;
    busy = false;
    scheduled = [];
    finalizePending = false;
    screen = "playing";
    relayout();
    buildVTiles();
    emit();
  }

  function toMenu() {
    screen = "menu";
    board = null;
    grid.clear();
    emit();
  }

  // ── input ───────────────────────────────────────────────────────────────
  function cellAt(px: number, py: number): Cell | null {
    const c = camera.screenToCell(px, py, originX, originY, cell);
    if (!c) return null;
    if (c.row < 0 || c.col < 0 || c.row >= rows || c.col >= cols) return null;
    return c;
  }

  // Tap-select-then-tap-neighbour + drag-to-swap, via the kit's reusable grid-input
  // (the `touch` module is stick/look-shaped; this is the grid gesture home).
  const grid = createGridInput({
    hitTest: cellAt,
    enabled: () => screen === "playing" && !busy && run.phase === "playing",
    onSwap: (a, b) => trySwap(a, b),
    onSelect: (c) => {
      playFx(psys, "select", cx(c.col), cy(c.row), { color: hexToRgb(theme.palette.accent) });
      audio.playTone(theme.audio.rootHz, 0.05, { type: "sine", gain: 0.15 });
      emit();
    },
  });

  function pointerDown(px: number, py: number) {
    void audio.resume();
    grid.pointerDown(px, py);
  }
  function pointerMove(px: number, py: number) {
    grid.pointerMove(px, py);
  }
  function pointerUp() {
    grid.pointerUp(0, 0);
  }

  // ── swap + resolve → animation timeline ─────────────────────────────────
  function homeSwap(a: Cell, b: Cell) {
    const ia = idx(a);
    const ib = idx(b);
    const idA = idAt[ia];
    const idB = idAt[ib];
    if (idA >= 0) {
      const v = vtiles.get(idA)!;
      v.row = b.row;
      v.col = b.col;
    }
    if (idB >= 0) {
      const v = vtiles.get(idB)!;
      v.row = a.row;
      v.col = a.col;
    }
    idAt[ia] = idB;
    idAt[ib] = idA;
  }

  function trySwap(a: Cell, b: Cell) {
    if (!board || busy) return;
    busy = true;
    homeSwap(a, b); // slide the two tiles (visual)
    audio.playTone(theme.audio.rootHz * 1.5, 0.05, { type: "triangle", gain: 0.12 });
    const ok = board.swap(a, b);
    const swapMs = t("swapMs");
    if (ok) {
      const events = board.resolve();
      // let the swap slide land, then run the cascade timeline
      runTimeline(events, swapMs);
    } else {
      // illegal: slide back after the swap animation
      schedule(swapMs, () => {
        homeSwap(a, b);
        audio.playTone(theme.audio.rootHz * 0.75, 0.06, { type: "sine", gain: 0.1 });
      });
      finishAt(swapMs + 120, () => {
        busy = false;
      });
    }
  }

  function schedule(at: number, fn: () => void) {
    scheduled.push({ at, fn, done: false });
    if (at > animEnd) animEnd = at;
  }
  function finishAt(at: number, fn: () => void) {
    tl = 0;
    animEnd = Math.max(animEnd, at);
    scheduled.push({ at, fn: () => { fn(); }, done: false });
    finalizePending = true;
  }

  function runTimeline(events: BoardEvent[], startOffset: number) {
    tl = 0;
    animEnd = 0;
    const stepMs = t("cascadeStepMs");
    const refillMs = t("refillMs");
    const clearMs = Math.max(90, Math.min(stepMs * 0.5, refillMs * 0.7));
    let cursor = startOffset;
    let totalDelta = 0;

    for (const ev of events) {
      switch (ev.type) {
        case "clear": {
          const at = cursor;
          const cells = ev.cells;
          const kind = ev.kind;
          const depth = ev.cascadeDepth;
          const delta = cells.length * 10 * depth;
          totalDelta += delta;
          schedule(at, () => startClear(cells, kind, depth, delta));
          schedule(at + clearMs, () => finishClear(cells));
          break;
        }
        case "fall": {
          const moves = ev.moves;
          schedule(cursor + clearMs, () => applyFall(moves));
          break;
        }
        case "spawn": {
          const spawns = ev.spawns;
          schedule(cursor + clearMs, () => applySpawn(spawns));
          break;
        }
        case "unlock": {
          const cells = ev.cells;
          schedule(cursor, () => applyUnlock(cells));
          break;
        }
        case "cascade": {
          cursor += stepMs; // advance to the next cascade step
          break;
        }
        case "settle":
          break;
      }
    }
    void totalDelta;
    // finalize shortly after the last scheduled action
    finishAt(animEnd + 160, () => finalizeResolve());
  }

  function startClear(cells: Cell[], kind: number, depth: number, _delta: number) {
    const color = hexToRgb(theme.palette.tiles[kind % theme.palette.tiles.length] ?? theme.palette.accent);
    for (const c of cells) {
      const id = idAt[idx(c)];
      if (id >= 0) {
        const v = vtiles.get(id);
        if (v) {
          v.clearing = true;
          v.clearT = 0;
        }
      }
      playFx(psys, "clear", cx(c.col), cy(c.row), {
        color,
        depth,
        countScale: particleScale,
        count: t("particlesPerClear"),
      });
    }
    // combo escalation: flourish + shake scale with cascade depth
    if (depth >= t("comboFlourishThreshold") || cells.length >= 5) {
      const c0 = cells[0]!;
      playFx(psys, "combo-flourish", cx(c0.col), cy(c0.row), { color, depth, countScale: particleScale });
    }
    camera.addShake(t("shakeBase") * Math.min(4, depth) * (cells.length >= 5 ? 1.3 : 1));
    // SFX: base match tone + a RISING combo chime keyed to the theme's scale
    audio.playTone(theme.audio.rootHz, 0.08, { type: "sine", gain: 0.18 });
    const scale = theme.audio.scaleSemitones;
    const step = depth - 1;
    const semis = (scale[step % scale.length] ?? 0) + 12 * Math.floor(step / scale.length);
    audio.playTone(theme.audio.rootHz * Math.pow(2, semis / 12), 0.12, { type: "triangle", gain: 0.22 });
    // score live
    run = runReducer(run, { type: "score", delta: _delta });
    emit();
  }

  function finishClear(cells: Cell[]) {
    for (const c of cells) {
      const id = idAt[idx(c)];
      if (id >= 0) {
        vtiles.delete(id);
        idAt[idx(c)] = -1;
      }
    }
  }

  function applyFall(moves: { from: Cell; to: Cell; kind: number }[]) {
    const relocate = moves.map((m) => ({ id: idAt[idx(m.from)], from: m.from, to: m.to }));
    for (const r of relocate) idAt[idx(r.from)] = -1;
    for (const r of relocate) {
      if (r.id < 0) continue;
      idAt[idx(r.to)] = r.id;
      const v = vtiles.get(r.id);
      if (v) {
        v.row = r.to.row;
        v.col = r.to.col;
      }
    }
  }

  function applySpawn(spawns: { cell: Cell; kind: number }[]) {
    for (const s of spawns) {
      const id = nextId++;
      const startY = originY - cell * (1 + rng.next() * 0.5); // enter from above the board
      vtiles.set(id, {
        id,
        kind: s.kind,
        row: s.cell.row,
        col: s.cell.col,
        x: cx(s.cell.col),
        y: startY,
        scale: 1,
        alpha: 1,
        clearing: false,
        clearT: 0,
        locked: false, // refilled tiles are never crated
      });
      idAt[idx(s.cell)] = id;
    }
  }

  // A crate broke: clear the locked flag on those tiles + a small pop/chime.
  function applyUnlock(cells: Cell[]) {
    for (const c of cells) {
      const id = idAt[idx(c)];
      if (id < 0) continue;
      const v = vtiles.get(id);
      if (v) v.locked = false;
      if (particleScale > 0) playFx(psys, "spawn-pop", cx(c.col), cy(c.row), { color: hexToRgb(theme.palette.glow) });
    }
    if (cells.length) audio.playTone(theme.audio.rootHz * 1.25, 0.06, { type: "triangle", gain: 0.14 });
  }

  function finalizeResolve() {
    if (!board) {
      busy = false;
      return;
    }
    // spend the move for the successful swap (win already checked live via 'score')
    run = runReducer(run, { type: "spend-move" });
    // never soft-lock
    if (run.phase === "playing" && !board.hasMoves()) {
      board.shuffleIfStuck();
      buildVTiles();
    }
    if (run.phase === "won") {
      progress[run.levelIndex] = Math.max(progress[run.levelIndex] ?? 0, run.stars);
      unlocked = Math.max(unlocked, Math.min(N - 1, run.levelIndex + 1));
      persist();
      playWinChime();
    }
    // Record the run into cross-run meta exactly once, when it reaches a terminal
    // phase (win or loss) — updates streaks, per-level best score, and aggregates.
    if (!levelRecorded && (run.phase === "won" || run.phase === "lost")) {
      levelRecorded = true;
      metaState = metaStore.record({
        levelId: String(run.levelIndex),
        won: run.phase === "won",
        score: run.score,
        stars: run.stars,
      });
    }
    busy = false;
    emit();
  }

  /**
   * Level-cleared chime — an ascending 4-note arpeggio up the ACTIVE THEME's
   * scale, landing on the octave. Same tonal family as the rising combo chime
   * (Director: keep the win moment in the sound-world he already likes), a
   * touch longer and warmer so it reads "ceremony", not "another cascade".
   * setTimeout staggering mirrors GYRE's start-chime precedent; late timeouts
   * after a dispose are harmless no-ops on a closed AudioContext.
   */
  function playWinChime() {
    const scale = theme.audio.scaleSemitones;
    const steps = [scale[0] ?? 0, scale[2] ?? 4, scale[4] ?? 7, 12]; // triad walk-up → octave
    steps.forEach((semis, i) => {
      setTimeout(() => {
        audio.playTone(theme.audio.rootHz * Math.pow(2, semis / 12), 0.22, {
          type: "triangle",
          gain: 0.26,
        });
      }, i * 130);
    });
  }

  // ── per-frame update + draw ─────────────────────────────────────────────
  function update(dt: number) {
    time += dt;

    // perf: record this frame and, a few times a second, let the adaptive
    // controller re-decide the tier → particle budget (hysteresis lives in the
    // kit; here we just read the tier it settles on).
    frameMon.push(dt * 1000);
    if (++tierTickCounter >= TIER_TICK_FRAMES) {
      tierTickCounter = 0;
      particleScale = TIER_PARTICLE_SCALE[adaptive.tick()];
    }

    // fire due scheduled callbacks
    if (scheduled.length) {
      tl += dt * 1000;
      for (const s of scheduled) {
        if (!s.done && s.at <= tl) {
          s.done = true;
          s.fn();
        }
      }
      if (finalizePending && tl >= animEnd) {
        scheduled = [];
        finalizePending = false;
        animEnd = 0;
        tl = 0;
      }
    }
    // tween tiles toward home; animate clearing pop; trail fast-falling tiles
    const k = 1 - Math.exp(-18 * dt);
    const fallTrailGap = cell * 0.4; // how far below home before a tile "streaks"
    for (const v of vtiles.values()) {
      const dy = cy(v.row) - v.y; // >0 while a tile is still dropping into place
      v.x += (cx(v.col) - v.x) * k;
      v.y += (cy(v.row) - v.y) * k;
      if (v.clearing) {
        v.clearT += dt;
        const p = Math.min(1, v.clearT / CLEAR_SECONDS);
        v.scale = 1 + p * 0.45;
        v.alpha = 1 - p;
      } else if (dy > fallTrailGap && particleScale > 0 && rng.next() < 0.6) {
        // faint streak dropped at the tile's current spot so gravity reads as
        // motion; sparse (2 particles), budget-scaled, thinned by the rng gate.
        const color = hexToRgb(theme.palette.tiles[v.kind % theme.palette.tiles.length] ?? theme.palette.accent);
        playFx(psys, "fall-trail", v.x, v.y, { color, countScale: particleScale });
      }
    }
    if (worldFadeT > 0) {
      worldFadeT = Math.max(0, worldFadeT - dt);
      if (worldFadeT === 0) prevTheme = null;
    }
    psys.step(dt);
    camera.update(dt);
  }

  // Paint one theme's backdrop (sky gradient + drifting parallax bands) at a
  // global opacity. `alpha` < 1 is what makes the world cross-fade read as a
  // dissolve rather than a hard cut.
  function drawBackdrop(ctx: CanvasRenderingContext2D, th: ThemeDef, alpha: number) {
    const g = ctx.createLinearGradient(0, 0, 0, cssH);
    g.addColorStop(0, th.backdrop.sky[0]);
    g.addColorStop(1, th.backdrop.sky[1]);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.globalAlpha = 1;
    // parallax bands drift + bob, scaled by the live `backdropMotion` tunable
    // (Director: "+10% more movement so it's easier to see it change").
    const motion = t("backdropMotion");
    const bands = th.backdrop.parallax ?? [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      const speed = b.speed * motion;
      const y = b.y * cssH + Math.sin(time * speed + i) * (b.amp * 40 * motion);
      ctx.globalAlpha = 0.35 * alpha;
      ctx.fillStyle = b.color;
      const h = cssH * 0.16;
      ctx.beginPath();
      const drift = ((time * speed * 24) % (cssW + 200)) - 100;
      ctx.ellipse(drift, y, cssW * 0.7, h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(drift - cssW * 0.6, y + h * 0.5, cssW * 0.6, h, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // Backdrop layer with the world cross-fade applied: hold the outgoing scenery
  // and dissolve the incoming one in over `worldFadeDur` (smoothstep-eased).
  function drawBackdropLayer(ctx: CanvasRenderingContext2D) {
    if (worldFadeT > 0 && prevTheme && worldFadeDur > 0) {
      const lin = 1 - worldFadeT / worldFadeDur; // 0 → 1
      const p = lin * lin * (3 - 2 * lin); // smoothstep
      drawBackdrop(ctx, prevTheme, 1);
      drawBackdrop(ctx, theme, p);
    } else {
      drawBackdrop(ctx, theme, 1);
    }
  }

  function draw() {
    const ctx = renderer.ctx;
    if (!ctx) return;
    renderer.clear();
    if (screen !== "playing" || !board) {
      // menu backdrop only
      drawBackdropLayer(ctx);
      return;
    }
    drawBackdropLayer(ctx);

    ctx.save();
    camera.applyTo(ctx); // shake only (camera x/y/zoom stay at 0/0/1)

    // board frame
    renderer.drawRect(originX - 8, originY - 8, cell * cols + 16, cell * rows + 16, {
      fill: theme.palette.surface,
      radius: 16,
      alpha: 0.85,
    });
    // cell wells
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        renderer.drawRect(originX + c * cell + 2, originY + r * cell + 2, cell - 4, cell - 4, {
          fill: theme.palette.bg,
          radius: 8,
          alpha: 0.35,
        });
      }
    }
    // selection highlight
    const sel = grid.selected;
    if (sel) {
      renderer.drawRect(originX + sel.col * cell, originY + sel.row * cell, cell, cell, {
        stroke: theme.palette.glow,
        radius: 10,
      });
    }
    // tiles
    const drawSize = cell * 0.86;
    for (const v of vtiles.values()) {
      const size = drawSize * v.scale;
      const fill = theme.palette.tiles[v.kind % theme.palette.tiles.length] ?? theme.palette.accent;
      renderer.drawTile(v.kind, v.x - size / 2, v.y - size / 2, size, {
        fill,
        glow: v.locked ? undefined : theme.palette.glow, // crated tiles don't glow
        alpha: v.alpha,
      });
      if (v.locked) {
        // "crate" overlay: dark tint + a light cage cross — reads as blocked,
        // clears (with a pop) when a neighbour match frees it.
        const half = size / 2;
        renderer.drawRect(v.x - half, v.y - half, size, size, { fill: "#05060c", radius: 8, alpha: 0.5 });
        ctx.save();
        ctx.globalAlpha = v.alpha * 0.8;
        ctx.strokeStyle = "rgba(222,228,238,0.7)";
        ctx.lineWidth = Math.max(2, size * 0.08);
        const s = half * 0.68;
        ctx.beginPath();
        ctx.moveTo(v.x - s, v.y - s);
        ctx.lineTo(v.x + s, v.y + s);
        ctx.moveTo(v.x + s, v.y - s);
        ctx.lineTo(v.x - s, v.y + s);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();

    // particles (drawn in screen space, additive-ish)
    drawParticles(ctx);
  }

  function drawParticles(ctx: CanvasRenderingContext2D) {
    ctx.save();
    psys.forEach((p) => {
      ctx.globalCompositeOperation = p.blend === "add" ? "lighter" : "source-over";
      ctx.globalAlpha = Math.max(0, Math.min(1, p.a));
      ctx.fillStyle = `rgb(${p.r | 0},${p.g | 0},${p.b | 0})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, p.size), 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  }

  // ── RAF loop ────────────────────────────────────────────────────────────
  let raf = 0;
  let last = 0;
  let running = false;
  function frame(now: number) {
    if (!running) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }
  function start() {
    if (running) return;
    running = true;
    last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
  }

  relayout();
  emit();

  return {
    start,
    stop,
    relayout,
    startLevel,
    toMenu,
    pointerDown,
    pointerMove,
    pointerUp,
    advance() {
      if (run.phase === "won") startLevel(Math.min(N - 1, run.levelIndex + 1));
    },
    retry() {
      startLevel(run.levelIndex);
    },
    /** Play one hinted (guaranteed-legal) swap — a test/smoke seam to trigger a real cascade. */
    hintSwap(): boolean {
      if (!board || busy || run.phase !== "playing") return false;
      const h = board.findHint();
      if (!h) return false;
      grid.clear();
      trySwap(h[0], h[1]);
      return true;
    },
    getState: () => run,
    /** Cross-run progression snapshot (streaks, per-level records, aggregates). */
    getMeta: () => metaState,
    /** The live tuning store (same instance the ?tune panel binds to) — the
     *  preview harness mounts its own always-on panel + "bake" against this. */
    tuning,
    // ── per-world colour knobs (preview harness) ──────────────────────────
    /** Current resolved colours for a world (0-based), for the harness pickers. */
    getThemeColors(worldIdx: number) {
      const th = resolvedThemeFor(worldIdx);
      return {
        id: th.id,
        name: th.name,
        bg: th.palette.bg,
        surface: th.palette.surface,
        glow: th.palette.glow,
        tiles: th.palette.tiles.slice(),
        sky: [th.backdrop.sky[0], th.backdrop.sky[1]] as [string, string],
      };
    },
    /** Merge a colour patch into a world's override; re-resolves live if shown. */
    setThemeColors(
      worldIdx: number,
      patch: { palette?: Partial<ThemeDef["palette"]>; backdrop?: { sky?: [string, string] } },
    ) {
      const base = baseThemeFor(worldIdx);
      const cur = themeOverrides[base.id] ?? {};
      themeOverrides[base.id] = {
        ...cur,
        palette: { ...(cur.palette ?? {}), ...(patch.palette ?? {}) },
        backdrop: { ...(cur.backdrop ?? {}), ...(patch.backdrop ?? {}) },
      };
      persistThemeOverrides();
      if (theme.id === base.id) theme = resolvedThemeFor(worldIdx);
      emit();
    },
    /** Clear all colour overrides (back to authored palettes). */
    resetThemeColors() {
      themeOverrides = {};
      persistThemeOverrides();
      theme = resolvedThemeFor(level.world - 1);
      emit();
    },
    /** Raw override map, for "bake" export. */
    themeOverridesSnapshot: () => JSON.parse(JSON.stringify(themeOverrides)) as Record<string, ThemeOverride>,
    /** Wipe cross-run progression (streaks, records). */
    resetMeta() {
      metaStore.reset();
      metaState = initMeta();
      emit();
    },
    _debug: {
      get busy() { return busy; },
      get board() { return board; },
      get selected() { return grid.selected; },
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
