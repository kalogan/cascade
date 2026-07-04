import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { renameSync, existsSync } from "node:fs";
import react from "@vitejs/plugin-react";

// Static build of ONLY the preview harness (preview.html), emitted to
// dist-preview/index.html with RELATIVE asset URLs (base "./") so it drops onto
// any static host at "/" — Vercel/Netlify/Pages/etc. Possible because Cascade is
// backend-free (preview-harness property §3.6). The product build is untouched.
const kit = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const outDir = fileURLToPath(new URL("./dist-preview", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      // Vite emits the entry at its source path (preview.html); rename to index.html.
      name: "preview-html-as-index",
      closeBundle() {
        const from = `${outDir}/preview.html`;
        const to = `${outDir}/index.html`;
        if (existsSync(from)) renameSync(from, to);
      },
    },
  ],
  resolve: {
    alias: [
      { find: /^game-kit\/(.*)$/, replacement: kit("./vendor/game-kit/src/$1/index.ts") },
      { find: /^game-kit$/, replacement: kit("./vendor/game-kit/src/index.ts") },
    ],
  },
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: fileURLToPath(new URL("./preview.html", import.meta.url)),
    },
  },
});
