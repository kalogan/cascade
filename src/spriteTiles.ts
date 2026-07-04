/**
 * spriteTiles — load the generated tile atlas and install it on the renderer.
 *
 * Real FLUX-generated art (public/tiles.png, a 6×3 grid: cols = kind, rows = world)
 * loaded through the `assets` preloader → a `sprite` atlas → `render2d.setTileAtlas`,
 * so `drawTile` blits real art per (world, kind). This is the drop-in swap of the
 * earlier $0 procedural-bake proof — the seam is identical.
 *
 * Opt-in behind `?sprites` (the game calls this only under that flag) while the art
 * is being reviewed; flip it on by default once approved.
 */
import { createAtlas, gridAtlas } from "game-kit/sprite";
import { loadAssets } from "game-kit/assets";
import type { SpriteAtlas } from "game-kit/sprite";

const CELL = 256; // atlas cell size (px)
const COLS = 6; // tile kinds
const ROWS = 3; // worlds

/** Frame name for a (world, kind) cell — matches the packed atlas grid order. */
export const tileFrameName = (world: number, kind: number): string => `w${world}_k${kind % COLS}`;

/**
 * Load the generated tile atlas (`/tiles.png`) via `assets`, build a `sprite`
 * atlas over its 6×3 grid, and return it + a `frameFor(kind)` bound to a live
 * world getter — ready for `renderer.setTileAtlas(atlas, frameFor)`.
 */
export async function loadTileAtlas(
  currentWorld: () => number,
): Promise<{ atlas: SpriteAtlas; frameFor: (kind: number) => string }> {
  const names: string[] = [];
  for (let w = 0; w < ROWS; w++) for (let k = 0; k < COLS; k++) names.push(tileFrameName(w, k));

  const store = await loadAssets([{ id: "tiles", url: "/tiles.png", kind: "image" }]);
  const image = store.image("tiles");
  if (!image) throw new Error("spriteTiles: /tiles.png failed to load");

  const atlas = createAtlas(image, gridAtlas(COLS, ROWS, CELL, CELL, names));
  const frameFor = (kind: number): string => {
    const w = Math.max(0, Math.min(ROWS - 1, currentWorld()));
    return tileFrameName(w, kind);
  };
  return { atlas, frameFor };
}
