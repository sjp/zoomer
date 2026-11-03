import react from "@vitejs/plugin-react";
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

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the build works when served from a GitHub Pages
  // project subpath (https://<user>.github.io/<repo>/).
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  // Agent worktrees live under .claude/; keep their copies of the tests out of the run.
  test: { exclude: [...configDefaults.exclude, "**/.claude/**"] },
});
