import { defineConfig } from "@playwright/test";

const PORT = 5199;
const CI = (process.env.CI ?? "") !== "";

/**
 * Browser smoke tests: every effect compiled and drawn in headless Chromium, on
 * SwiftShader's software WebGL2 so no GPU is needed. Runs against the Vite dev
 * server, so the dev-only GL checks in the effect helpers are active too.
 */
export default defineConfig({
  testDir: "e2e",
  // SwiftShader runs shaders on the CPU: the heaviest effects take over a minute.
  timeout: 300_000,
  fullyParallel: true,
  forbidOnly: CI,
  reporter: CI ? [["list"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${String(PORT)}`,
    browserName: "chromium",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    },
  },
  webServer: {
    command: `npx vite --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}/e2e/smoke.html`,
    reuseExistingServer: !CI,
  },
});
