import { describe, it, expect } from 'vitest';
import { createRenderer2D, createCamera2D, DEFAULT_TILE_SHINE, type Cell } from './index.js';
import { createRng } from '../prng/index.js';
import type { SpriteAtlas } from '../sprite/index.js';

// ── A tiny call-recording fake CanvasRenderingContext2D ─────────────────────
//
// jsdom ships no real 2d context (no `canvas` native module in this repo), so
// `HTMLCanvasElement.getContext('2d')` already returns null here — that's the
// real headless path. For the "does drawTile actually issue canvas ops" tests
// we hand createRenderer2D a fake canvas whose getContext returns this stub,
// which just counts calls instead of rendering anything.

interface FakeGradient {
  addColorStop(offset: number, color: string): void;
}

function makeFakeGradient(): FakeGradient {
  return { addColorStop: () => {} };
}

function makeFakeCtx() {
  const calls: Record<string, number> = {};
  const bump = (name: string): void => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  const ctx = {
    calls,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    font: '10px sans-serif',
    textAlign: 'left' as CanvasTextAlign,
    lineWidth: 1,
    save: () => bump('save'),
    restore: () => bump('restore'),
    setTransform: () => bump('setTransform'),
    translate: () => bump('translate'),
    scale: () => bump('scale'),
    clearRect: () => bump('clearRect'),
    fillRect: () => bump('fillRect'),
    beginPath: () => bump('beginPath'),
    closePath: () => bump('closePath'),
    rect: () => bump('rect'),
    moveTo: () => bump('moveTo'),
    lineTo: () => bump('lineTo'),
    quadraticCurveTo: () => bump('quadraticCurveTo'),
    arc: () => bump('arc'),
    arcTo: () => bump('arcTo'),
    clip: () => bump('clip'),
    fill: () => bump('fill'),
    stroke: () => bump('stroke'),
    fillText: () => bump('fillText'),
    drawImage: () => bump('drawImage'),
    createLinearGradient: () => {
      bump('createLinearGradient');
      return makeFakeGradient();
    },
    createRadialGradient: () => {
      bump('createRadialGradient');
      return makeFakeGradient();
    },
  };

  return ctx;
}

function makeFakeCanvas(ctx: ReturnType<typeof makeFakeCtx>) {
  return {
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
}

// ── Renderer2D: headless smoke ───────────────────────────────────────────────

describe('createRenderer2D — tile shine config', () => {
  it('defaults to DEFAULT_TILE_SHINE and is a copy (not the shared object)', () => {
    const r = createRenderer2D(null);
    expect(r.getTileShine()).toEqual(DEFAULT_TILE_SHINE);
    expect(r.getTileShine()).not.toBe(DEFAULT_TILE_SHINE);
  });

  it('merges the constructor tileShine over the defaults', () => {
    const r = createRenderer2D(null, { tileShine: { glowAlpha: 0 } });
    expect(r.getTileShine().glowAlpha).toBe(0);
    expect(r.getTileShine().sheenLight).toBe(DEFAULT_TILE_SHINE.sheenLight); // untouched
  });

  it('setTileShine live-merges partial updates', () => {
    const r = createRenderer2D(null);
    r.setTileShine({ glowAlpha: 0.5, highlight: 0.1 });
    expect(r.getTileShine().glowAlpha).toBe(0.5);
    expect(r.getTileShine().highlight).toBe(0.1);
    expect(r.getTileShine().glowRadius).toBe(DEFAULT_TILE_SHINE.glowRadius);
  });

  it('does not throw when drawing with shine set (headless no-op path)', () => {
    const r = createRenderer2D(null, { tileShine: { glowAlpha: 1, sheenLight: 0.8 } });
    expect(() => r.drawTile(0, 0, 0, 32, { fill: '#ff0044', glow: '#ff0044' })).not.toThrow();
  });
});

describe('createRenderer2D — headless safety', () => {
  it('is a safe no-op with a null canvas: ctx is null, draws never throw', () => {
    const renderer = createRenderer2D(null);
    expect(renderer.ctx).toBeNull();
    expect(renderer.width).toBe(0);
    expect(renderer.height).toBe(0);

    expect(() => {
      renderer.resize(300, 400);
      renderer.clear('#000000');
      renderer.drawRect(0, 0, 10, 10, { fill: '#fff', radius: 4 });
      renderer.drawText('hi', 5, 5, { fill: '#fff' });
      renderer.drawTile(0, 0, 0, 32, { fill: '#ff0044', glow: '#ff0044', stroke: '#000' });
    }).not.toThrow();

    // resize still tracks logical size even with no ctx to scale.
    expect(renderer.width).toBe(300);
    expect(renderer.height).toBe(400);
  });

  it('is a safe no-op with a real DOM canvas lacking a 2d context (jsdom has none)', () => {
    const canvas = document.createElement('canvas');
    const renderer = createRenderer2D(canvas);
    // This repo has no `canvas` package installed, so jsdom's getContext('2d')
    // returns null — exercising the real headless-guard path, not a mock.
    expect(renderer.ctx).toBeNull();

    expect(() => {
      renderer.resize(200, 200);
      for (let shape = 0; shape < 8; shape++) {
        renderer.drawTile(shape, shape * 10, 0, 24, { fill: '#123456' });
      }
      renderer.clear();
    }).not.toThrow();
  });
});

// ── Renderer2D: stub-ctx call-count proof ───────────────────────────────────

describe('createRenderer2D — stub ctx issues real canvas ops', () => {
  it('drawTile fills the shape, clips + overlays a bevel, and glows when asked', () => {
    const ctx = makeFakeCtx();
    const canvas = makeFakeCanvas(ctx);
    const renderer = createRenderer2D(canvas);
    renderer.resize(100, 100);

    expect(renderer.ctx).toBe(ctx);

    renderer.drawTile(0, 0, 0, 40, { fill: '#3366ff', glow: '#88ccff', stroke: '#001133' });

    // The bevel sheen and inner highlight are clipped overlays painted with
    // fillRect (not fill()); actual fill() calls are the glow disc + the base
    // shape fill = 2.
    expect(ctx.calls.fill).toBe(2);
    expect(ctx.calls.fillRect).toBe(2); // sheen overlay + highlight overlay
    // bevel-sheen and inner-highlight each clip to the shape path.
    expect(ctx.calls.clip).toBe(2);
    // an outline stroke was requested.
    expect(ctx.calls.stroke).toBe(1);
    // gradients used for: glow, base fill, bevel sheen, inner highlight.
    expect(ctx.calls.createLinearGradient).toBeGreaterThanOrEqual(2); // base + sheen
    expect(ctx.calls.createRadialGradient).toBeGreaterThanOrEqual(2); // glow + highlight
    // The shape path is traced once per pass: glow disc, base fill, sheen
    // clip, highlight clip, stroke = 5 beginPath calls.
    expect(ctx.calls.beginPath).toBe(5);
  });

  it('setTileAtlas makes drawTile BLIT a frame instead of drawing the procedural shape', () => {
    const ctx = makeFakeCtx();
    const renderer = createRenderer2D(makeFakeCanvas(ctx));
    renderer.resize(100, 100);
    // a minimal atlas whose frame 'leaf' exists for kind 1
    const atlas = {
      has: (n: string) => n === 'leaf',
      frame: () => undefined,
      names: ['leaf'],
      draw: (c: CanvasRenderingContext2D) => ((c as unknown as { drawImage(): void }).drawImage(), true),
    };
    renderer.setTileAtlas(atlas as unknown as SpriteAtlas, (k) => (k === 1 ? 'leaf' : undefined));
    renderer.drawTile(1, 0, 0, 40, { fill: '#3366ff' }); // kind 1 → 'leaf' → blit
    expect(ctx.calls.drawImage).toBe(1);
    expect(ctx.calls.fillRect ?? 0).toBe(0); // no procedural sheen/highlight overlays

    // kind 2 has no frame → falls back to procedural (no new drawImage)
    renderer.drawTile(2, 0, 0, 40, { fill: '#3366ff' });
    expect(ctx.calls.drawImage).toBe(1);
    expect((ctx.calls.fillRect ?? 0)).toBeGreaterThan(0);

    // removing the atlas restores procedural for all kinds
    renderer.setTileAtlas(null);
    renderer.drawTile(1, 0, 0, 40, { fill: '#3366ff' });
    expect(ctx.calls.drawImage).toBe(1); // unchanged
  });

  it('drawTile without glow/stroke still fills + bevels but skips glow/stroke ops', () => {
    const ctx = makeFakeCtx();
    const canvas = makeFakeCanvas(ctx);
    const renderer = createRenderer2D(canvas);
    renderer.resize(100, 100);

    renderer.drawTile(1, 0, 0, 40, { fill: '#22aa66' });

    expect(ctx.calls.fill).toBe(1); // base fill only, no glow
    expect(ctx.calls.fillRect).toBe(2); // sheen + highlight overlays
    expect(ctx.calls.stroke).toBeUndefined();
  });

  it('wraps unknown shape indices modulo the shape count', () => {
    const ctxA = makeFakeCtx();
    const ctxB = makeFakeCtx();
    const rendererA = createRenderer2D(makeFakeCanvas(ctxA));
    const rendererB = createRenderer2D(makeFakeCanvas(ctxB));
    rendererA.resize(100, 100);
    rendererB.resize(100, 100);

    rendererA.drawTile(2, 0, 0, 40, { fill: '#123456' });
    rendererB.drawTile(2 + 6 * 3, 0, 0, 40, { fill: '#123456' }); // same shape, wrapped
    rendererB.drawTile(-4, 0, 0, 40, { fill: '#123456' }); // -4 mod 6 === 2 as well

    // Same silhouette (shape 2, "drop") traced the same number of times →
    // identical call-count fingerprints for arc/lineTo/moveTo/quadraticCurveTo.
    for (const key of ['arc', 'lineTo', 'moveTo', 'quadraticCurveTo'] as const) {
      const perCall = ctxA.calls[key] ?? 0;
      expect(ctxB.calls[key] ?? 0).toBe(perCall * 2);
    }
  });

  it('drawRect fills + strokes a rounded rect path via arcTo', () => {
    const ctx = makeFakeCtx();
    const renderer = createRenderer2D(makeFakeCanvas(ctx));
    renderer.resize(100, 100);

    renderer.drawRect(0, 0, 20, 20, { fill: '#fff', stroke: '#000', radius: 6, alpha: 0.5 });

    expect(ctx.calls.fill).toBe(1);
    expect(ctx.calls.stroke).toBe(1);
    expect(ctx.calls.arcTo).toBe(4); // 4 rounded corners
  });

  it('drawText sets font/align/fill and calls fillText', () => {
    const ctx = makeFakeCtx();
    const renderer = createRenderer2D(makeFakeCanvas(ctx));
    renderer.resize(100, 100);

    renderer.drawText('score', 10, 10, { fill: '#fff', font: '16px sans-serif', align: 'center' });

    expect(ctx.calls.fillText).toBe(1);
    expect(ctx.font).toBe('16px sans-serif');
    expect(ctx.textAlign).toBe('center');
  });

  it('clear fills when a color is given, clearRects otherwise', () => {
    const ctx = makeFakeCtx();
    const renderer = createRenderer2D(makeFakeCanvas(ctx));
    renderer.resize(50, 50);

    renderer.clear('#111111');
    expect(ctx.calls.fillRect).toBe(1);
    expect(ctx.calls.clearRect).toBeUndefined();

    renderer.clear();
    expect(ctx.calls.clearRect).toBe(1);
  });

  it('resize caps DPR-scaled backing buffer size via canvas.width/height', () => {
    const ctx = makeFakeCtx();
    const canvas = makeFakeCanvas(ctx);
    const renderer = createRenderer2D(canvas, { dprCap: 2 });

    renderer.resize(100, 200);

    expect(renderer.width).toBe(100);
    expect(renderer.height).toBe(200);
    // jsdom/node has no devicePixelRatio → getDevicePixelRatio() falls back to 1.
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(200);
    expect(ctx.calls.setTransform).toBeGreaterThanOrEqual(1);
  });
});

// ── Camera2D ──────────────────────────────────────────────────────────────────

describe('createCamera2D', () => {
  it('worldToScreen / screenToWorld round-trip when there is no shake', () => {
    const camera = createCamera2D();
    camera.x = 12;
    camera.y = -8;
    camera.zoom = 1.75;

    const [sx, sy] = camera.worldToScreen(50, 30);
    const [wx, wy] = camera.screenToWorld(sx, sy);

    expect(wx).toBeCloseTo(50, 9);
    expect(wy).toBeCloseTo(30, 9);
  });

  it('addShake accumulates trauma clamped to [0, 1]', () => {
    const camera = createCamera2D({ rng: createRng(1) });
    camera.addShake(0.6);
    camera.addShake(0.9); // would overflow past 1 without clamping
    camera.update(0); // dt=0: no decay, just recompute offset from current trauma

    const [sx1, sy1] = camera.worldToScreen(0, 0);
    // With trauma clamped to 1 (max), the shake offset magnitude should sit at
    // exactly the camera's max offset in at least one axis's worst case, and
    // never explode past a sane bound.
    expect(Math.abs(sx1)).toBeLessThanOrEqual(24);
    expect(Math.abs(sy1)).toBeLessThanOrEqual(24);
  });

  it('shake decays to ~0 after enough time passes', () => {
    const camera = createCamera2D({ shakeDecay: 1.5, rng: createRng(42) });
    camera.addShake(1);

    // Decay is 1.5 trauma/sec, so well under a second of simulated time at a
    // fine step fully drains it (trauma hits 0 in <= 1/1.5 ~ 0.667s).
    for (let i = 0; i < 200; i++) {
      camera.update(1 / 60);
    }

    const [sx, sy] = camera.worldToScreen(0, 0);
    expect(Math.abs(sx)).toBeLessThan(0.001);
    expect(Math.abs(sy)).toBeLessThan(0.001);
  });

  it('screenToCell maps known screen points to the right cell, null outside the grid', () => {
    const camera = createCamera2D();
    const originX = 20;
    const originY = 40;
    const cellSize = 32;

    // A point squarely inside cell (row 0, col 0).
    expect(camera.screenToCell(originX + 5, originY + 5, originX, originY, cellSize)).toEqual<Cell>({
      row: 0,
      col: 0,
    });

    // A point inside cell (row 2, col 3).
    const px = originX + 3 * cellSize + 10;
    const py = originY + 2 * cellSize + 4;
    expect(camera.screenToCell(px, py, originX, originY, cellSize)).toEqual<Cell>({ row: 2, col: 3 });

    // Above and to the left of the grid's origin → outside the grid → null.
    expect(camera.screenToCell(originX - 1, originY + 5, originX, originY, cellSize)).toBeNull();
    expect(camera.screenToCell(originX + 5, originY - 1, originX, originY, cellSize)).toBeNull();
  });

  it('applyTo composes onto the current transform via translate/scale (caller owns save/restore)', () => {
    const ctx = makeFakeCtx();
    const camera = createCamera2D();
    camera.x = 5;
    camera.zoom = 2;

    ctx.save();
    camera.applyTo(ctx as unknown as CanvasRenderingContext2D);
    ctx.restore();

    expect(ctx.calls.translate).toBe(2); // shake offset + (-x, -y)
    expect(ctx.calls.scale).toBe(1);
    expect(ctx.calls.save).toBe(1);
    expect(ctx.calls.restore).toBe(1);
  });
});
