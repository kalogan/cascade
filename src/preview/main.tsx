/**
 * Preview harness entry — mounts <PreviewApp> (the real engine + inspection
 * shell). Separate from the product entry (src/main.tsx); never ships in the
 * game bundle.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PreviewApp } from "./PreviewApp.js";

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <PreviewApp />
    </StrictMode>,
  );
}
