import { render } from "preact";
import { App } from "./App";
import { stateFromHash } from "./effects/params";
import { defaultEffect, effectLoader, effects } from "./effects/registry";
import "./index.css";

// Start fetching the first effect's code before the first render, so the download
// overlaps the app's startup. App picks up the same (cached) import.
effectLoader.prefetch(stateFromHash(window.location.hash, effects, defaultEffect).effect);

const root = document.getElementById("root");
if (!root) {
  throw new Error("Missing #root element");
}

render(<App />, root);
