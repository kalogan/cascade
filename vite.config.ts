import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// game-kit is vendored under vendor/game-kit (the kit master lives in Crucible and
// is re-vendored here via scripts/vendor-game-kit.mjs). We import kit modules by
// SUBPATH (game-kit/board, game-kit/render2d, ...) so the 3D-only barrel modules
// never enter the 2D bundle. Vite resolves the kit's ".js" specifiers to ".ts".
const kit = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^game-kit\/(.*)$/, replacement: kit("./vendor/game-kit/src/$1/index.ts") },
      { find: /^game-kit$/, replacement: kit("./vendor/game-kit/src/index.ts") },
    ],
  },
});
