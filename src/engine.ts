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
  difficultyForLevel,
  DEFAULT_DIFFICULTY,
  totalLevels,
  initRun,
  runReducer,
  type LevelConfig,
  type RunState,
} from "game-kit/campaign";
import { THEMES, type ThemeDef } from "game-kit/theme";
import { createTuning, mountTuningPanel, MATCH3_TUNING, type Tuning } from "game-kit/tuning";
import { createRng } from "game-kit/prng";
import { createAudioManager, type AudioManager } from "game-kit/audio";

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
}

interface Scheduled {
  at: number;
  fn: () => void;
  done: boolean;
}

const CLEAR_SECONDS = 0.16;

// Global multiplier on parallax-band drift + bob (Director: "+10% more movement
// so it's easier to see it change" between worlds). One knob to nudge the feel.
const BACKDROP_MOTION = 1.1;

// Cross-fade duration when crossing into a new world's scenery (was a hard cut).
const WORLD_FADE_SECONDS = 0.9;

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
  const renderer: Renderer2D = createRenderer2D(canvas, { dprCap: 2 });
  const rng = createRng(0xca5cade);
  const camera: Camera2D = createCamera2D({ rng: rng.fork(7) });
  const tuning: Tuning = createTuning(MATCH3_TUNING, { storeKey: "cascade-tuning" });
  const psys: ParticleSystem = createParticleSystem({ cap: 600, rng: rng.fork(11) });
  const audio: AudioManager = createAudioManager();

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

  // ── mutable game state ──────────────────────────────────────────────────
  let screen: PublicState["screen"] = "menu";
  let level: LevelConfig = difficultyForLevel(0);
  let theme: ThemeDef = THEMES[0]!;
  let board: Board | null = null;
  let run: RunState = initRun(0);
  let rows = level.boardH;
  let cols = level.boardW;

  let vtiles = new Map<number, VTile>();
  let idAt = new Int32Array(rows * cols).fill(-1);
  let nextId = 1;

  let selected: Cell | null = null;
  let dragStart: Cell | null = null;
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
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const kind = snap[r * cols + c]!;
        if (kind < 0) continue;
        const id = nextId++;
        vtiles.set(id, { id, kind, row: r, col: c, x: cx(c), y: cy(r), scale: 1, alpha: 1, clearing: false, clearT: 0 });
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
    });
  }

  // ── level lifecycle ─────────────────────────────────────────────────────
  function startLevel(index: number) {
    index = Math.max(0, Math.min(N - 1, index));
    const outgoingTheme = theme;
    level = difficultyForLevel(index);
    theme = THEMES[Math.min(THEMES.length - 1, level.world - 1)]!;
    // Only cross-fade when the scenery actually changes (a new world), not on
    // every level start within the same world.
    if (screen === "playing" && outgoingTheme !== theme) {
      prevTheme = outgoingTheme;
      worldFadeT = WORLD_FADE_SECONDS;
    } else {
      prevTheme = null;
      worldFadeT = 0;
    }
    rows = level.boardH;
    cols = level.boardW;
    const lrng = createRng(0x5eed + index * 2654435761);
    board = createBoard({ rows, cols, kinds: level.tileKinds, rng: lrng });
    run = runReducer(initRun(index), { type: "start", levelIndex: index });
    selected = null;
    dragStart = null;
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
    selected = null;
    emit();
  }

  // ── input ───────────────────────────────────────────────────────────────
  function cellAt(px: number, py: number): Cell | null {
    const c = camera.screenToCell(px, py, originX, originY, cell);
    if (!c) return null;
    if (c.row < 0 || c.col < 0 || c.row >= rows || c.col >= cols) return null;
    return c;
  }
  const adjacent = (a: Cell, b: Cell) => Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;

  function pointerDown(px: number, py: number) {
    void audio.resume();
    if (screen !== "playing" || busy || run.phase !== "playing") return;
    const c = cellAt(px, py);
    if (!c) return;
    if (selected && adjacent(selected, c)) {
      trySwap(selected, c);
      selected = null;
      dragStart = null;
      return;
    }
    selected = c;
    dragStart = c;
    playFx(psys, "select", cx(c.col), cy(c.row), { color: hexToRgb(theme.palette.accent) });
    audio.playTone(theme.audio.rootHz, 0.05, { type: "sine", gain: 0.15 });
    emit();
  }
  function pointerMove(px: number, py: number) {
    if (screen !== "playing" || busy || run.phase !== "playing" || !dragStart) return;
    const c = cellAt(px, py);
    if (c && !(c.row === dragStart.row && c.col === dragStart.col) && adjacent(dragStart, c)) {
      trySwap(dragStart, c);
      selected = null;
      dragStart = null;
    }
  }
  function pointerUp() {
    dragStart = null;
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
      playFx(psys, "clear", cx(c.col), cy(c.row), { color, depth });
    }
    // combo escalation: flourish + shake scale with cascade depth
    if (depth >= 2 || cells.length >= 5) {
      const c0 = cells[0]!;
      playFx(psys, "combo-flourish", cx(c0.col), cy(c0.row), { color, depth });
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
      });
      idAt[idx(s.cell)] = id;
    }
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
    // tween tiles toward home; animate clearing pop
    const k = 1 - Math.exp(-18 * dt);
    for (const v of vtiles.values()) {
      v.x += (cx(v.col) - v.x) * k;
      v.y += (cy(v.row) - v.y) * k;
      if (v.clearing) {
        v.clearT += dt;
        const p = Math.min(1, v.clearT / CLEAR_SECONDS);
        v.scale = 1 + p * 0.45;
        v.alpha = 1 - p;
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
    // parallax bands drift + bob. BACKDROP_MOTION scales both (Director:
    // "+10% more movement so it's easier to see it change") — one knob to nudge.
    const bands = th.backdrop.parallax ?? [];
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i]!;
      const speed = b.speed * BACKDROP_MOTION;
      const y = b.y * cssH + Math.sin(time * speed + i) * (b.amp * 40 * BACKDROP_MOTION);
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
  // and dissolve the incoming one in over WORLD_FADE_SECONDS (smoothstep-eased).
  function drawBackdropLayer(ctx: CanvasRenderingContext2D) {
    if (worldFadeT > 0 && prevTheme) {
      const lin = 1 - worldFadeT / WORLD_FADE_SECONDS; // 0 → 1
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
    if (selected) {
      renderer.drawRect(originX + selected.col * cell, originY + selected.row * cell, cell, cell, {
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
        glow: theme.palette.glow,
        alpha: v.alpha,
      });
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
      selected = null;
      trySwap(h[0], h[1]);
      return true;
    },
    getState: () => run,
    _debug: { get busy() { return busy; }, get board() { return board; } },
  };
}

export type Engine = ReturnType<typeof createEngine>;
