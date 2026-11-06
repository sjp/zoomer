import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { stateFromHash } from "./effects/params";
import { defaultEffect, effectLoader, effects } from "./effects/registry";
import "./index.css";

// Start fetching the first effect's code before React renders, so the download
// overlaps React's startup. App picks up the same (cached) import.
effectLoader.prefetch(stateFromHash(window.location.hash, effects, defaultEffect).effect);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
