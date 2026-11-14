import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { documentPage } from "./document";

const DEFAULTS = {
  layout: "page",
  theme: "light",
  speed: 8,
  comments: true,
  title: "Quarterly Report",
  seed: 1,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs the effect at 1920 x 1080 for `seconds` at 30 fps with `params`, returning the strings it painted. */
function paint(seconds: number, params: Partial<typeof DEFAULTS>[]) {
  const fake = createFakeGl();
  const effect = documentPage.create(fake.gl);
  effect.resize({ width: 1920, height: 1080, scale: 1 });
  for (const p of params) {
    for (let i = 0; i < seconds * 30; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, ...p });
    }
  }
  effect.dispose?.();
  expect(fake.errors).toEqual([]);
  return MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
}

describe("document page", () => {
  it("paints the title, the page count and the words as they are typed", () => {
    const texts = paint(20, [{}]);
    expect(texts).toContain("Quarterly Report");
    expect(texts.some((t) => /^Page \d+ of \d+ {2}· {2}[\d,]+ words$/.test(t))).toBe(true);
    // The line being typed is repainted as it grows, one character (or so) at a time.
    const lengths = new Set(texts.map((t) => t.length));
    expect(lengths.size).toBeGreaterThan(40);
  });

  it.each([
    [{ layout: "margins" }],
    [{ theme: "dark", comments: false }],
    [{ speed: 20, title: "" }],
    [{ title: "Plan" }],
    [{ seed: 9 }],
  ])("keeps typing through a change to %j", (change) => {
    const texts = paint(8, [{}, change, {}]);
    expect(texts.length).toBeGreaterThan(100);
  });
});
