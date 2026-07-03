/**
 * Cascade — a themed Match-3 with cascade combos, built on Crucible's game-kit.
 *
 * This is the SCAFFOLD entry (clean, green gate, before the game slice). The real
 * playable run — campaign ramp + themed worlds + board/render2d/fx2d + tuning — is
 * assembled in App.tsx once the kit's 2D modules are vendored in.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
