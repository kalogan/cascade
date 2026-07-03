import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const kit = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^game-kit\/(.*)$/, replacement: kit("./vendor/game-kit/src/$1/index.ts") },
      { find: /^game-kit$/, replacement: kit("./vendor/game-kit/src/index.ts") },
    ],
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
