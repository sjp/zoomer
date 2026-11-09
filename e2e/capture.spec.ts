/**
 * Captures every effect's pixels after a fixed run (see `capture` in
 * `src/test/smoke.ts`) into `$CAPTURE_DIR/<id>.rgba`, for comparing before and
 * after a refactor with `scripts/compare-captures.mjs`. Skipped unless
 * CAPTURE_DIR is set:
 *
 *   CAPTURE_DIR=/tmp/before npx playwright test capture
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Page } from "@playwright/test";
import { effects } from "../src/effects/registry";

const dir = process.env.CAPTURE_DIR ?? "";
/** Frames drawn (at 30 fps) before the capture. */
const FRAMES = 90;

let page: Page;

test.describe.configure({ mode: "parallel" });
test.skip(dir === "", "set CAPTURE_DIR to capture");

test.beforeAll(async ({ browser }) => {
  mkdirSync(dir, { recursive: true });
  page = await browser.newPage();
  await page.goto("/e2e/smoke.html");
  await page.waitForFunction(() => typeof window.capture === "function");
});

test.afterAll(async () => {
  await page.close();
});

async function captureTo(id: string): Promise<void> {
  const shot = await page.evaluate(([effectId, frames]) => window.capture(effectId, frames), [
    id,
    FRAMES,
  ] as const);
  writeFileSync(join(dir, `${id}.rgba`), Buffer.from(shot.rgba, "base64"));
}

for (const { id } of effects) {
  test(id, () => captureTo(id));
}
