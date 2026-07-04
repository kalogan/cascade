# Cascade — tile art bible (generated-sprite spec)

Turnkey spec for generating the tile sprites and dropping them into the game. The
pipeline is already wired and proven at $0 (`src/spriteTiles.ts` + `?sprites`); this
doc is what the paid generation run fills in. When the real atlas exists, only the
image source changes — the `render2d.setTileAtlas` seam is identical.

## What to generate

**6 tile kinds × 3 worlds = 18 sprites.** Kinds (by `drawTile` shape index):

| kind | shape   | motif suggestion |
|------|---------|------------------|
| 0    | gem/diamond | faceted crystal |
| 1    | leaf    | leaf / petal |
| 2    | drop    | dew / droplet |
| 3    | star    | 5-point star |
| 4    | hexagon | honeycomb / cut stone |
| 5    | blossom | flower / bloom |

**Worlds** (palette + mood come from `game-kit/theme` `THEMES`):
- **World 1 — Verdant Glade:** soft greens, gentle, organic (`tileSkin: organic`).
- **World 2 — Ember Reach:** warm oranges/reds, fiery dusk, chunky (`tileSkin: chunky`).
- **World 3 — Astral Deep:** cool purples/cyans, cosmic, luminous.

## Format constraints (critical for a clean atlas)

- **Square, centered, transparent background.** 256×256 each (downscaled into the
  128px atlas cells; keep source higher-res for crispness).
- **Uniform framing:** the motif fills ~86% of the frame (matches `drawTile`'s
  padding), centered, no clipping, consistent optical weight across kinds.
- **Single object, no scene, no text, no drop-shadow baked in** (the game adds glow).
- **Readable at 40–60px** on a phone: bold silhouette, high contrast vs a dark board.
- Per-world colour comes from the world palette; keep the same 6 silhouettes
  recognizable across worlds (a player learns the shapes, worlds re-skin them).

## Prompt template (per tile)

Use Crucible's canon-driven 2D generation (image-only, ~$0.003/img). Rough prompt:

```
A single {motif} game tile icon, {world-mood} style, {world-palette} colours,
centered on a transparent background, bold clean silhouette, soft inner shading,
mobile match-3 gem art, no text, no background scene, no drop shadow.
```

e.g. World 3 star: `A single 5-point star game tile icon, cosmic luminous style,
cool purple and cyan colours, centered on transparent background, bold clean
silhouette, soft inner shading, mobile match-3 gem art, no text, no background`.

## Generation run (once keys are set)

Prereqs in `crucible-asset-studio/.env.local`: `REPLICATE_API_TOKEN` **or**
`GEMINI_API_KEY`, plus `CRUCIBLE_IMPORT_TOKEN`; server env `CRUCIBLE_ALLOW_PAID_BATCH=1`.

1. Enqueue an 18-job image-only batch (one job per world×kind, prompts above).
2. `pnpm dev` (Crucible) then `pnpm run-batch <batchId> --paid` (double-gated).
3. Review in the asset library; regenerate any weak tiles (2D-review-before-3D).
4. Background-remove + trim to square, downscale to 256², pack into a **6×3 grid**
   (cols=kind, rows=world) PNG → `cascade/public/tiles.png`.

## Wiring (drop-in swap)

In `src/spriteTiles.ts`, replace the procedural bake with a load of the packed
atlas and keep the same frame naming (`w{world}_k{kind}`), then it flows through the
existing `renderer.setTileAtlas(atlas, frameFor)` unchanged:

```ts
const store = await loadAssets([{ id: "tiles", url: "/tiles.png", kind: "image" }]);
const atlas = createAtlas(store.image("tiles")!, gridAtlas(6, 3, 256, 256, names));
```

Flip it on by default (drop the `?sprites` gate) once the art passes the taste check.
Note: sprite tiles are fixed art — the live per-world colour knobs apply to procedural
tiles only, so baking is the point at which a world's palette is locked in.

## Cost

18 tiles × ~$0.003 ≈ **$0.05**; budget ~$0.20 with regenerations. Well under the $5
daily cap. Set a tighter cap via `CRUCIBLE_DAILY_COST_CAP` if desired.
