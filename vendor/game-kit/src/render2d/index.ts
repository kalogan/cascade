/**
 * render2d — Canvas2D rendering substrate for a portrait match-3 board.
 *
 * `createRenderer2D` wraps a `<canvas>` with a DPR-aware resize, a handful of
 * primitive draw calls, and the sprite-ready `drawTile` seam (procedural
 * silhouettes today, a straight swap for spritesheet blits later — same call
 * shape). `createCamera2D` is a lightweight 2D pan/zoom/shake camera meant
 * mostly for background parallax + juice; the match-3 grid itself is normally
 * drawn in fixed screen space (see `screenToCell`).
 *
 * HEADLESS-SAFE: `createRenderer2D(null)` (or a canvas whose `getContext('2d')`
 * returns null, e.g. jsdom without the `canvas` package) yields a renderer
 * whose `ctx` is null and whose draw calls are all no-ops. Every ctx access in
 * this module is guarded so importing + driving this module under node/jsdom
 * or SSR never throws.
 *
 * DETERMINISTIC: camera shake consumes a `Rng` (see `../prng/index.ts`) —
 * never `Math.random()` / `Date.now()`.
 */

import { createRng, type Rng } from '../prng/index.js';
import type { SpriteAtlas } from '../sprite/index.js';

// ── Shared helpers ───────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function getDevicePixelRatio(): number {
  const g = globalThis as { devicePixelRatio?: number };
  return typeof g.devicePixelRatio === 'number' && g.devicePixelRatio > 0 ? g.devicePixelRatio : 1;
}

// ── Renderer2D ────────────────────────────────────────────────────────────────

export interface Renderer2DOptions {
  /** Upper bound for devicePixelRatio when sizing the backing buffer. Default 2. */
  dprCap?: number;
  /** Initial tile-shine budget; merged over DEFAULT_TILE_SHINE. Live-adjustable via setTileShine. */
  tileShine?: Partial<TileShine>;
}

export interface DrawRectOpts {
  fill?: string;
  stroke?: string;
  /** Corner radius in CSS px. Rounded-rect path when > 0. */
  radius?: number;
  alpha?: number;
}

export interface DrawTextOpts {
  fill?: string;
  font?: string;
  align?: CanvasTextAlign;
  alpha?: number;
}

/**
 * Options for the sprite-ready `drawTile` seam. `fill` is the base tile
 * color; `glow` (optional) draws a soft additive halo behind the tile in that
 * color; `stroke` (optional) outlines the silhouette; `scale` (default 1)
 * shrinks/grows the tile within its cell; `alpha` (default 1) is overall
 * opacity.
 */
export interface DrawTileOpts {
  fill: string;
  glow?: string;
  stroke?: string;
  scale?: number;
  alpha?: number;
}

export interface Renderer2D {
  /** The live 2D context, or null when headless / no 2d ctx is available. */
  readonly ctx: CanvasRenderingContext2D | null;
  /** Current logical (CSS px) size, as last set via `resize`. */
  readonly width: number;
  readonly height: number;
  /** Clear the whole canvas; optionally fill it with `color` first. */
  clear(color?: string): void;
  drawRect(x: number, y: number, w: number, h: number, opts?: DrawRectOpts): void;
  drawText(text: string, x: number, y: number, opts?: DrawTextOpts): void;
  /**
   * SPRITE-READY SEAM: draw one of N procedural tile silhouettes, selected by
   * `shape` (wrapped modulo the shape count so any kind count works),
   * centered in a `size` x `size` cell at (x, y) top-left. Each silhouette is
   * rendered as a gradient fill + a color-agnostic bevel/inner highlight, with
   * an optional outer glow. This is the seam a real spritesheet blit would
   * replace without changing the call shape.
   */
  drawTile(shape: number, x: number, y: number, size: number, opts: DrawTileOpts): void;
  /** DPR-aware resize: sets canvas.width/height and rescales the context. */
  resize(cssW: number, cssH: number): void;
  /** Live-merge new tile-shine values (a tuning panel pushes here). */
  setTileShine(partial: Partial<TileShine>): void;
  /** Current tile-shine budget (for a panel to read / bake). */
  getTileShine(): TileShine;
  /**
   * Install a sprite atlas so `drawTile` BLITS a frame (real art) instead of
   * drawing the procedural silhouette. `frameFor(shape)` maps a tile kind to a
   * frame name; when it returns undefined (or the frame is missing) that tile
   * falls back to procedural. Pass `null` to remove the atlas. This is the
   * "generated art drops into the drawTile seam" path.
   */
  setTileAtlas(atlas: SpriteAtlas | null, frameFor?: (shape: number) => string | undefined): void;
}

/**
 * `drawTile` shine budget — how glossy the procedural tiles read. Kept
 * restrained by default (calm matte gems, not wet glass); raising these
 * re-introduces the "too shiny, pulls the eye off the board" look. Exposed as a
 * runtime config (not baked consts) so a tuning panel / preview harness can dial
 * shininess live and bake the chosen values back into `DEFAULT_TILE_SHINE`.
 */
export interface TileShine {
  /** Additive aura opacity behind a tile (0 = no glow). */
  glowAlpha: number;
  /** Aura radius as a multiple of the tile radius. */
  glowRadius: number;
  /** Top-left bevel light strength. */
  sheenLight: number;
  /** Bottom-right bevel shadow strength. */
  sheenShadow: number;
  /** Glassy upper-left hotspot strength. */
  highlight: number;
}

export const DEFAULT_TILE_SHINE: TileShine = {
  glowAlpha: 0.38, // was full strength — dimmed so the aura rims, not blooms
  glowRadius: 1.3, // was 1.6 — tighter, less bleed onto the board
  sheenLight: 0.26, // was 0.55
  sheenShadow: 0.22, // was 0.28
  highlight: 0.2, // was 0.5
};

/**
 * Create a Canvas2D renderer bound to `canvas`. Context-guarded: if `canvas`
 * is null, or `getContext('2d')` returns null (headless), `ctx` is null and
 * every draw call becomes a safe no-op.
 */
export function createRenderer2D(
  canvas: HTMLCanvasElement | null,
  opts: Renderer2DOptions = {},
): Renderer2D {
  const dprCap = opts.dprCap ?? 2;
  const tileShine: TileShine = { ...DEFAULT_TILE_SHINE, ...(opts.tileShine ?? {}) };
  let tileAtlas: SpriteAtlas | null = null;
  let tileFrameFor: (shape: number) => string | undefined = () => undefined;

  let ctx: CanvasRenderingContext2D | null = null;
  if (canvas) {
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
  }

  let width = 0;
  let height = 0;

  function resize(cssW: number, cssH: number): void {
    width = Math.max(0, cssW);
    height = Math.max(0, cssH);
    if (!canvas || !ctx) return;
    const dpr = Math.min(getDevicePixelRatio(), dprCap);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    // Scale so every subsequent draw call can keep using CSS-px coordinates.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function clear(color?: string): void {
    if (!ctx) return;
    ctx.save();
    if (color) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    ctx.restore();
  }

  function drawRect(x: number, y: number, w: number, h: number, rectOpts: DrawRectOpts = {}): void {
    if (!ctx) return;
    const { fill, stroke, radius, alpha } = rectOpts;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    if (radius && radius > 0) {
      roundRectPath(ctx, x, y, w, h, radius);
    } else {
      ctx.beginPath();
      ctx.rect(x, y, w, h);
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawText(text: string, x: number, y: number, textOpts: DrawTextOpts = {}): void {
    if (!ctx) return;
    const { fill, font, align, alpha } = textOpts;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha = alpha;
    if (font) ctx.font = font;
    if (align) ctx.textAlign = align;
    if (fill) ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function drawTile(shape: number, x: number, y: number, size: number, tileOpts: DrawTileOpts): void {
    if (!ctx) return;
    const { fill, glow, stroke, alpha = 1 } = tileOpts;
    const scale = clamp(tileOpts.scale ?? 1, 0, 1.5);
    const cx = x + size / 2;
    const cy = y + size / 2;
    const r = (size / 2) * scale * 0.86; // padding so tiles don't touch cell edges
    const kind = wrapIndex(shape, SHAPE_COUNT);

    ctx.save();
    ctx.globalAlpha = alpha;

    if (glow) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = alpha * tileShine.glowAlpha; // dim the aura so it rims, not blooms
      const glowR = Math.max(r * tileShine.glowRadius, 0.001);
      const glowGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      glowGrad.addColorStop(0, glow);
      glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glowGrad;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Sprite path: if an atlas is installed and maps this kind to a frame, blit
    // the frame (real art) at the tile footprint and skip the procedural draw.
    if (tileAtlas) {
      const frameName = tileFrameFor(kind);
      if (frameName && tileAtlas.has(frameName)) {
        tileAtlas.draw(ctx, frameName, cx - r, cy - r, r * 2, r * 2);
        if (stroke) {
          buildShapePath(ctx, kind, cx, cy, r);
          ctx.lineWidth = Math.max(1, size * 0.035);
          ctx.strokeStyle = stroke;
          ctx.stroke();
        }
        ctx.restore();
        return;
      }
    }

    // Base fill: a real gradient when `fill` parses as #rrggbb, else the flat
    // color (the sheen pass below still gives it a bevel either way, so any
    // CSS color string — named, rgb(), hsl() — degrades gracefully).
    let fillStyle: string | CanvasGradient = fill;
    const rgb = tryParseHexColor(fill);
    if (rgb && r > 0) {
      const grad = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      grad.addColorStop(0, shadeRgb(rgb, 0.35));
      grad.addColorStop(0.55, fill);
      grad.addColorStop(1, shadeRgb(rgb, -0.3));
      fillStyle = grad;
    }

    buildShapePath(ctx, kind, cx, cy, r);
    ctx.fillStyle = fillStyle;
    ctx.fill();

    // Bevel sheen: light-to-dark diagonal overlay blended via composite ops so
    // it reads as a gradient + bevel regardless of the fill's color format.
    ctx.save();
    buildShapePath(ctx, kind, cx, cy, r);
    ctx.clip();
    const sheen = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    sheen.addColorStop(0, `rgba(255,255,255,${tileShine.sheenLight})`);
    sheen.addColorStop(0.45, `rgba(255,255,255,${tileShine.sheenLight * 0.2})`);
    sheen.addColorStop(0.55, 'rgba(0,0,0,0.03)');
    sheen.addColorStop(1, `rgba(0,0,0,${tileShine.sheenShadow})`);
    ctx.globalCompositeOperation = 'overlay';
    ctx.fillStyle = sheen;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    // Inner highlight: a small additive bloom near the upper-left, glassy pop.
    ctx.save();
    buildShapePath(ctx, kind, cx, cy, r);
    ctx.clip();
    ctx.globalCompositeOperation = 'lighter';
    const hi = ctx.createRadialGradient(
      cx - r * 0.32,
      cy - r * 0.38,
      0,
      cx - r * 0.32,
      cy - r * 0.38,
      Math.max(r * 0.55, 0.001),
    );
    hi.addColorStop(0, `rgba(255,255,255,${tileShine.highlight})`);
    hi.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hi;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    if (stroke) {
      buildShapePath(ctx, kind, cx, cy, r);
      ctx.lineWidth = Math.max(1, size * 0.035);
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }

    ctx.restore();
  }

  return {
    get ctx() {
      return ctx;
    },
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    clear,
    drawRect,
    drawText,
    drawTile,
    resize,
    setTileShine(partial: Partial<TileShine>): void {
      Object.assign(tileShine, partial);
    },
    getTileShine(): TileShine {
      return { ...tileShine };
    },
    setTileAtlas(atlas: SpriteAtlas | null, frameFor?: (shape: number) => string | undefined): void {
      tileAtlas = atlas;
      tileFrameFor = frameFor ?? (() => undefined);
    },
  };
}

// ── drawTile shape set ───────────────────────────────────────────────────────

/**
 * 0=gem/diamond, 1=leaf, 2=drop, 3=star, 4=hexagon, 5=blossom. `shape` wraps
 * modulo this count, so a theme with any number of tile kinds still resolves
 * to one of these silhouettes (repeating once it runs past 6).
 */
const SHAPE_COUNT = 6;

function wrapIndex(i: number, count: number): number {
  const n = Math.trunc(i) % count;
  return n < 0 ? n + count : n;
}

function buildShapePath(
  ctx: CanvasRenderingContext2D,
  kind: number,
  cx: number,
  cy: number,
  r: number,
): void {
  switch (kind) {
    case 0:
      gemPath(ctx, cx, cy, r);
      return;
    case 1:
      leafPath(ctx, cx, cy, r);
      return;
    case 2:
      dropPath(ctx, cx, cy, r);
      return;
    case 3:
      starPath(ctx, cx, cy, r);
      return;
    case 4:
      hexPath(ctx, cx, cy, r);
      return;
    default:
      blossomPath(ctx, cx, cy, r);
      return;
  }
}

/** 0 — gem: a tall six-point diamond cut. */
function gemPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r * 0.62, cy - r * 0.38);
  ctx.lineTo(cx + r * 0.78, cy + r * 0.15);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r * 0.78, cy + r * 0.15);
  ctx.lineTo(cx - r * 0.62, cy - r * 0.38);
  ctx.closePath();
}

/** 1 — leaf: an asymmetric almond/vesica silhouette. */
function leafPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy + r);
  ctx.quadraticCurveTo(cx + r * 0.95, cy + r * 0.15, cx, cy - r);
  ctx.quadraticCurveTo(cx - r * 0.55, cy + r * 0.15, cx, cy + r);
  ctx.closePath();
}

/** 2 — drop: pointed apex over a rounded base. */
function dropPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const baseCy = cy + r * 0.28;
  const baseR = r * 0.66;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.quadraticCurveTo(cx + r * 0.95, cy - r * 0.05, cx + baseR * 0.94, baseCy - baseR * 0.15);
  ctx.arc(cx, baseCy, baseR, -0.35, Math.PI + 0.35, false);
  ctx.quadraticCurveTo(cx - r * 0.95, cy - r * 0.05, cx, cy - r);
  ctx.closePath();
}

/** 3 — star: classic 5-point star. */
function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  const spikes = 5;
  const outerR = r;
  const innerR = r * 0.45;
  const step = Math.PI / spikes;
  ctx.beginPath();
  let angle = -Math.PI / 2;
  for (let i = 0; i < spikes * 2; i++) {
    const rad = i % 2 === 0 ? outerR : innerR;
    const px = cx + Math.cos(angle) * rad;
    const py = cy + Math.sin(angle) * rad;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
    angle += step;
  }
  ctx.closePath();
}

/** 4 — hexagon: regular 6-gon, point-right orientation. */
function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i;
    const px = cx + Math.cos(angle) * r;
    const py = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** 5 — blossom: five petal circles + a center circle, unioned by the fill rule. */
function blossomPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  const petals = 5;
  const petalR = r * 0.5;
  const dist = r * 0.52;
  for (let i = 0; i < petals; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / petals;
    const px = cx + Math.cos(angle) * dist;
    const py = cy + Math.sin(angle) * dist;
    ctx.moveTo(px + petalR, py);
    ctx.arc(px, py, petalR, 0, Math.PI * 2);
  }
  const centerR = r * 0.4;
  ctx.moveTo(cx + centerR, cy);
  ctx.arc(cx, cy, centerR, 0, Math.PI * 2);
}

/** Rounded-rect path, manually traced (no reliance on ctx.roundRect). */
function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const rr = Math.max(0, Math.min(radius, Math.min(Math.abs(w), Math.abs(h)) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** Parse a strict `#rrggbb` string. Any other format (named/rgb()/hsl()) → null. */
function tryParseHexColor(input: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(input.trim());
  if (!m) return null;
  const hex = m[1];
  if (!hex) return null;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}

/** Lighten (amount > 0) or darken (amount < 0) an rgb triple, amount in [-1, 1]. */
function shadeRgb(rgb: readonly [number, number, number], amount: number): string {
  const [r, g, b] = rgb;
  const clampByte = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const adjust = (c: number): number => (amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  return `rgb(${clampByte(adjust(r))}, ${clampByte(adjust(g))}, ${clampByte(adjust(b))})`;
}

// ── Camera2D ──────────────────────────────────────────────────────────────────

export interface Cell {
  row: number;
  col: number;
}

export interface CreateCamera2DOptions {
  /** Trauma decay rate, per second. Default 1.5. */
  shakeDecay?: number;
  /** Seeded Rng for shake jitter. Default: a fixed internal seed. */
  rng?: Rng;
}

export interface Camera2D {
  x: number;
  y: number;
  zoom: number;
  /** Additive trauma impulse (clamped to [0, 1] after adding). */
  addShake(trauma: number): void;
  /** Decay trauma by `shakeDecay * dt` and recompute the shake offset. */
  update(dt: number): void;
  worldToScreen(wx: number, wy: number): [number, number];
  screenToWorld(sx: number, sy: number): [number, number];
  /**
   * Map a screen point to a grid cell for a portrait board drawn at
   * (originX, originY) with square cells of `cellSize`. Returns null when the
   * point falls before the grid's origin (above/left of it) — the only bound
   * this signature can check, since it isn't given the grid's row/col count.
   */
  screenToCell(sx: number, sy: number, originX: number, originY: number, cellSize: number): Cell | null;
  /**
   * Apply pan/zoom/shake onto the CURRENT transform via relative
   * translate/scale calls (not an absolute `setTransform`), so it composes
   * with whatever base transform is already active — e.g. the DPR scale a
   * `Renderer2D.resize` call already applied. Caller wraps this in its own
   * save()/restore().
   */
  applyTo(ctx: CanvasRenderingContext2D): void;
}

const DEFAULT_SHAKE_DECAY = 1.5;
const MAX_SHAKE_OFFSET_PX = 24;
/** Fixed internal seed so an rng-less camera is still fully deterministic. */
const DEFAULT_CAMERA_SEED = 0x5eed_1234;

export function createCamera2D(opts: CreateCamera2DOptions = {}): Camera2D {
  const shakeDecay = opts.shakeDecay ?? DEFAULT_SHAKE_DECAY;
  const rng = opts.rng ?? createRng(DEFAULT_CAMERA_SEED);

  let x = 0;
  let y = 0;
  let zoom = 1;
  let trauma = 0;
  let shakeX = 0;
  let shakeY = 0;

  return {
    get x() {
      return x;
    },
    set x(v: number) {
      x = v;
    },
    get y() {
      return y;
    },
    set y(v: number) {
      y = v;
    },
    get zoom() {
      return zoom;
    },
    set zoom(v: number) {
      zoom = v;
    },

    addShake(t: number): void {
      trauma = clamp(trauma + t, 0, 1);
    },

    update(dt: number): void {
      const elapsed = dt > 0 ? dt : 0;
      trauma = clamp(trauma - shakeDecay * elapsed, 0, 1);
      const mag = trauma * trauma * MAX_SHAKE_OFFSET_PX;
      shakeX = (rng.next() * 2 - 1) * mag;
      shakeY = (rng.next() * 2 - 1) * mag;
    },

    worldToScreen(wx: number, wy: number): [number, number] {
      return [(wx - x) * zoom + shakeX, (wy - y) * zoom + shakeY];
    },

    screenToWorld(sx: number, sy: number): [number, number] {
      return [(sx - shakeX) / zoom + x, (sy - shakeY) / zoom + y];
    },

    screenToCell(sx: number, sy: number, originX: number, originY: number, cellSize: number): Cell | null {
      if (!(cellSize > 0)) return null;
      const col = Math.floor((sx - originX) / cellSize);
      const row = Math.floor((sy - originY) / cellSize);
      if (col < 0 || row < 0) return null;
      return { row, col };
    },

    applyTo(ctx: CanvasRenderingContext2D): void {
      if (!ctx) return;
      ctx.translate(shakeX, shakeY);
      ctx.scale(zoom, zoom);
      ctx.translate(-x, -y);
    },
  };
}
