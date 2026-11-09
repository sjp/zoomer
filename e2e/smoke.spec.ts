/**
 * Compiles and draws every registered effect in a real browser: see
 * `src/test/smoke.ts` for what each run checks.
 */
import { expect, test, type Page } from "@playwright/test";
import { effects } from "../src/effects/registry";
import type { SmokeOptions } from "../src/test/smoke";

/**
 * Effects that may legitimately show a single flat colour after warm-up, with why.
 * Keep this short: each entry hides a real "renders nothing" failure.
 */
const ALLOW_FLAT: Record<string, string> = {};

/** Frames drawn with the defaults (at 30 fps) before checking the frame isn't flat. */
const WARMUP_FRAMES = 60;

let page: Page;

test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  const messages: string[] = [];
  page.on("pageerror", (err) => messages.push(err.message));
  await page.goto("/e2e/smoke.html");
  await page.waitForFunction(() => typeof window.smoke === "function");
  expect(messages).toEqual([]);
});

test.afterAll(async () => {
  await page.close();
});

async function check(id: string): Promise<void> {
  const options: SmokeOptions = { warmupFrames: WARMUP_FRAMES, allowFlat: id in ALLOW_FLAT };
  const result = await page.evaluate(([effectId, opts]) => window.smoke(effectId, opts), [
    id,
    options,
  ] as const);
  expect(result.errors, "exceptions and GL errors").toEqual([]);
  expect(result.missingUniforms, "uniforms with no location").toEqual([]);
  expect(result.flat, "frame is one flat colour after warm-up").toBeNull();
}

for (const { id } of effects) {
  test(id, () => check(id));
}
