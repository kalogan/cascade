# Cascade

A themed **Match-3 with cascade combos**, built on Crucible's `game-kit`. Swap adjacent
tiles to clear runs of 3+; clears collapse, refill, and any new run from the fall **chains**
into a combo — deeper chains escalate score, juice, and a rising combo-chime. A ~15-minute
run across **3 worlds × 3 levels** with difficulty that ramps and scenery that changes
between worlds (Verdant Glade → Ember Reach → Astral Deep).

Portrait / mobile-first (tap-to-select-then-tap-neighbour, or drag-to-swap).

## Run it

```bash
pnpm install
pnpm dev        # http://localhost:5173
```

Gate: `pnpm typecheck && pnpm test && pnpm build`.

Append `?tune` to the URL for the live tuning panel (timing / juice / difficulty knobs).

## Kit vendoring

`game-kit` is **vendored** under `vendor/game-kit/src` — the master lives in the Crucible
repo and is re-vendored here with `node scripts/vendor-game-kit.mjs --to ../cascade`
**run from the Crucible root**. Never edit the vendored copy directly; edit the master and
re-vendor. Kit modules powering this game: `board` · `render2d` · `fx2d` · `campaign` ·
`theme` · `tuning` (+ `prng` · `math` · `settings` · `save` · `audio` · `hud` · `touch` ·
`identity` · `scene-state`).
