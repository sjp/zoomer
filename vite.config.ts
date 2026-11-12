import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Content-Security-Policy for the built site. GitHub Pages can't send headers, so it
 * goes in a <meta> tag (which can't express frame-ancestors, report-uri or sandbox).
 * The build has no inline scripts and no data: or blob: subresources: the recording
 * download is a blob: link navigation, which CSP doesn't govern. 'unsafe-inline' in
 * style-src covers React's inline style attributes.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

/**
 * Injects the CSP at build time only. The dev server needs an inline script (the React
 * Refresh preamble) and a websocket for HMR, which the production policy forbids.
 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
        injectTo: "head-prepend",
      },
    ],
  };
}

/**
 * Vite's and Vitest's caches, pinned to the project root. The default is relative to
 * the working directory, so Vitest run from a subfolder with `--config` pointing here
 * would otherwise scatter `node_modules/.vite` folders through `src/`. (Run from a
 * subfolder without `--config`, Vitest finds no config at all; run it from the root.)
 */
export const CACHE_DIR = fileURLToPath(new URL("node_modules/.vite", import.meta.url));

/**
 * The instant every unit test's fake clock starts at (2026-03-14 15:09:26 UTC, the
 * same as the browser captures), so no test depends on when it runs.
 */
const TEST_TIME = Date.UTC(2026, 2, 14, 15, 9, 26);

/** Kept out of every Vitest run. */
export const TEST_EXCLUDE = ["**/.claude/**", "e2e/**"];

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build works when served from a GitHub Pages
  // project subpath (https://<user>.github.io/<repo>/).
  base: "./",
  cacheDir: CACHE_DIR,
  plugins: [react(), contentSecurityPolicy()],
  // Agent worktrees live under .claude/; keep their copies of the tests out of the run.
  // e2e/ holds the Playwright browser tests, run by `npm run test:browser`, and
  // *.perf.test.ts the frame-timing tests, run one file at a time by `npm run test:perf`.
  // src/test/setup.ts puts every test on fake timers starting at TEST_TIME.
  test: {
    exclude: [...configDefaults.exclude, ...TEST_EXCLUDE, "**/*.perf.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    fakeTimers: { now: TEST_TIME },
  },
});
