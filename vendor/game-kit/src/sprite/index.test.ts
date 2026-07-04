import { describe, it, expect, vi } from 'vitest';
import { createAtlas, gridAtlas } from './index.js';

// A stub image + a fake ctx that records drawImage calls.
const IMG = {} as CanvasImageSource;
function fakeCtx() {
  const calls: any[][] = [];
  return {
    calls,
    ctx: { drawImage: (...args: any[]) => calls.push(args) } as unknown as CanvasRenderingContext2D,
  };
}

describe('gridAtlas', () => {
  it('lays out a uniform grid left-to-right, top-to-bottom', () => {
    const def = gridAtlas(2, 2, 16, 16, ['a', 'b', 'c', 'd']);
    expect(def.frames.a).toEqual({ x: 0, y: 0, w: 16, h: 16 });
    expect(def.frames.b).toEqual({ x: 16, y: 0, w: 16, h: 16 });
    expect(def.frames.c).toEqual({ x: 0, y: 16, w: 16, h: 16 });
    expect(def.frames.d).toEqual({ x: 16, y: 16, w: 16, h: 16 });
  });

  it('applies margin + spacing', () => {
    const def = gridAtlas(2, 1, 10, 10, ['a', 'b'], { margin: 2, spacing: 4 });
    expect(def.frames.a).toEqual({ x: 2, y: 2, w: 10, h: 10 });
    expect(def.frames.b).toEqual({ x: 16, y: 2, w: 10, h: 10 }); // 2 + 10 + 4
  });

  it('index-names frames when names run out', () => {
    const def = gridAtlas(2, 1, 8, 8, ['only']);
    expect(def.frames.only).toBeDefined();
    expect(def.frames['1']).toEqual({ x: 8, y: 0, w: 8, h: 8 });
  });
});

describe('createAtlas', () => {
  it('exposes frame lookup, has, and names', () => {
    const atlas = createAtlas(IMG, gridAtlas(2, 1, 8, 8, ['x', 'y']));
    expect(atlas.has('x')).toBe(true);
    expect(atlas.has('z')).toBe(false);
    expect(atlas.frame('y')).toEqual({ x: 8, y: 0, w: 8, h: 8 });
    expect(atlas.names.sort()).toEqual(['x', 'y']);
  });

  it('draw blits the frame source rect to the dest, defaulting dest size to frame size', () => {
    const { ctx, calls } = fakeCtx();
    const atlas = createAtlas(IMG, { frames: { hero: { x: 4, y: 8, w: 16, h: 16 } } });
    expect(atlas.draw(ctx, 'hero', 100, 200)).toBe(true);
    expect(calls[0]).toEqual([IMG, 4, 8, 16, 16, 100, 200, 16, 16]);
    // explicit dest size
    atlas.draw(ctx, 'hero', 0, 0, 32, 32);
    expect(calls[1]).toEqual([IMG, 4, 8, 16, 16, 0, 0, 32, 32]);
  });

  it('draw returns false + no-ops for an unknown frame', () => {
    const { ctx, calls } = fakeCtx();
    const atlas = createAtlas(IMG, { frames: {} });
    expect(atlas.draw(ctx, 'missing', 0, 0)).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
