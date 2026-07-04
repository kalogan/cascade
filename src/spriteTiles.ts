/**
 * spriteTiles — the $0 end-to-end proof of the generated-art pipeline.
 *
 * Bakes the game's procedural tile silhouettes (6 kinds × 3 worlds) into an
 * offscreen spritesheet, loads it through the REAL `assets` preloader (as a PNG
 * data-URL, exactly as it would load a downloaded FLUX atlas), builds a `sprite`
 * atlas over it, and hands it to `render2d.setTileAtlas`. When real generated art
 * exists, only `atlasImageUrl` changes — the seam is identical.
 *
 * Opt-in (the game calls this only under `?sprites`) so the default live look —
 * procedural tiles + live colour knobs — is unchanged.
 */
import { createRenderer2D } from "game-kit/render2d";
import { createAtlas, gridAtlas } from "game-kit/sprite";
import { loadAssets } from "game-kit/assets";
import type { SpriteAtlas } from "game-kit/sprite";

export interface WorldTileColors {
  tiles: string[]; // per-kind fill colours
  glow: string;
}

const CELL = 128; // px per baked tile

/** Frame name for a (world, kind) cell — matches gridAtlas's row-major order. */
export const tileFrameName = (world: number, kind: number, kinds: number): string =>
  `w${world}_k${kind % kinds}`;

/**
 * Bake all worlds' procedural tiles into one spritesheet → PNG data-URL → load via
 * `assets` → `sprite` atlas. Returns the atlas + a `frameFor(kind)` bound to a
 * live world getter, ready for `renderer.setTileAtlas(atlas, frameFor)`.
 */
export async function bakeTileAtlas(
  worlds: WorldTileColors[],
  kinds: number,
  currentWorld: () => number,
): Promise<{ atlas: SpriteAtlas; frameFor: (kind: number) => string }> {
  const cols = kinds;
  const rows = worlds.length;

  const canvas = document.createElement("canvas");
  canvas.width = cols * CELL;
  canvas.height = rows * CELL;

  // A temp renderer over the offscreen canvas draws the PROCEDURAL tiles (it has
  // no atlas installed, so drawTile paints the silhouettes we're baking).
  const baker = createRenderer2D(canvas, { dprCap: 1 });
  baker.resize(canvas.width, canvas.height);
  const names: string[] = [];
  for (let w = 0; w < rows; w++) {
    const world = worlds[w]!;
    for (let k = 0; k < cols; k++) {
      const fill = world.tiles[k % world.tiles.length] ?? "#888";
      baker.drawTile(k, k * CELL, w * CELL, CELL, { fill, glow: world.glow });
      names.push(tileFrameName(w, k, kinds));
    }
  }

  // Round-trip through the real assets loader as a PNG (mirrors loading a FLUX atlas).
  const url = canvas.toDataURL("image/png");
  const store = await loadAssets([{ id: "tiles", url, kind: "image" }]);
  const image = store.image("tiles")!;

  const atlas = createAtlas(image, gridAtlas(cols, rows, CELL, CELL, names));
  const frameFor = (kind: number): string => {
    const w = Math.max(0, Math.min(rows - 1, currentWorld()));
    return tileFrameName(w, kind, kinds);
  };
  return { atlas, frameFor };
}
