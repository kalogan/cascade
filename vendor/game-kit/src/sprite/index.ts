/**
 * sprite — a spritesheet atlas + blit, and the seam that lets real art replace
 * render2d's procedural `drawTile` output.
 *
 * THREE-FREE. The atlas definition + frame math (`gridAtlas`, frame lookup) are
 * PURE and unit-test headless; `draw` blits via a Canvas2D `drawImage`, tested
 * against a stub context. Load the atlas image with the `assets` module, build an
 * atlas over it, and either draw frames directly or hand it to
 * `renderer.setTileAtlas` so `drawTile` blits frames instead of drawing shapes.
 */

/** A source rectangle within the atlas image. */
export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AtlasDef {
  /** frame name → source rect. */
  frames: Record<string, AtlasFrame>;
}

export interface SpriteAtlas {
  frame(name: string): AtlasFrame | undefined;
  has(name: string): boolean;
  readonly names: string[];
  /**
   * Blit a frame into `ctx` at (dx, dy) with dest size dw×dh (defaults to the
   * frame's native size). Returns false if the frame is unknown (no draw).
   */
  draw(ctx: CanvasRenderingContext2D, name: string, dx: number, dy: number, dw?: number, dh?: number): boolean;
}

/** Anything drawImage accepts as a source (image, canvas, bitmap). */
export type SpriteSource = CanvasImageSource;

/**
 * Build an atlas over an already-loaded image and a frame table. Pure lookups;
 * `draw` blits the frame's source rect via `ctx.drawImage`.
 */
export function createAtlas(image: SpriteSource, def: AtlasDef): SpriteAtlas {
  const frames = def.frames;
  return {
    frame(name: string): AtlasFrame | undefined {
      return frames[name];
    },
    has(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(frames, name);
    },
    get names(): string[] {
      return Object.keys(frames);
    },
    draw(ctx, name, dx, dy, dw, dh): boolean {
      const f = frames[name];
      if (!f) return false;
      ctx.drawImage(image, f.x, f.y, f.w, f.h, dx, dy, dw ?? f.w, dh ?? f.h);
      return true;
    },
  };
}

export interface GridAtlasOptions {
  /** Pixel gap between cells (spritesheet padding). Default 0. */
  spacing?: number;
  /** Pixel margin around the whole sheet. Default 0. */
  margin?: number;
}

/**
 * Build an AtlasDef for a uniform grid spritesheet: `cols`×`rows` cells of
 * `frameW`×`frameH`, named left-to-right, top-to-bottom by `names` (index-named
 * if a name is missing). Pure — no image needed.
 */
export function gridAtlas(
  cols: number,
  rows: number,
  frameW: number,
  frameH: number,
  names: string[] = [],
  opts: GridAtlasOptions = {},
): AtlasDef {
  const spacing = opts.spacing ?? 0;
  const margin = opts.margin ?? 0;
  const frames: Record<string, AtlasFrame> = {};
  let i = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const name = names[i] ?? String(i);
      frames[name] = {
        x: margin + col * (frameW + spacing),
        y: margin + row * (frameH + spacing),
        w: frameW,
        h: frameH,
      };
      i++;
    }
  }
  return { frames };
}
