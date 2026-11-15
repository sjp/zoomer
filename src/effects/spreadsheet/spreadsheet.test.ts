import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { spreadsheet } from "./spreadsheet";

const DEFAULTS = {
  theme: "light",
  accent: "#3f8a5f",
  pace: 2,
  chart: "bar",
  zoom: 1,
  seed: 1,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs the effect at 1920 x 1080 for `seconds` at 30 fps per entry of `params`, returning the strings it painted. */
function paint(seconds: number, params: Partial<typeof DEFAULTS>[]) {
  const fake = createFakeGl();
  const effect = spreadsheet.create(fake.gl);
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

describe("spreadsheet", () => {
  it("paints the column letters, the chart's title and axis, and figures as they are typed", () => {
    const texts = paint(20, [{}]);
    expect(texts).toContain("A");
    expect(texts.some((t) => t.endsWith(" by region"))).toBe(true);
    expect(texts.some((t) => t.startsWith("$"))).toBe(true);
    // The cell being typed is repainted a character at a time.
    const painted = new Set(texts);
    const typed = texts.filter((t) => /^\d{3,}$/.test(t) && painted.has(t.slice(0, -1)));
    expect(typed.length).toBeGreaterThan(0);
  });

  it.each([
    [{ theme: "dark" }],
    [{ chart: "line" }],
    [{ chart: "none" }],
    [{ zoom: 1.6 }],
    [{ seed: 9 }],
    [{ accent: "#c2410c", pace: 12 }],
  ])("keeps painting through a change to %j", (change) => {
    const before = paint(8, [{}]).length;
    MeasuringCanvas.reset(0.5);
    const texts = paint(8, [{}, change, {}]);
    expect(texts.length).toBeGreaterThan(before);
  });

  it("draws without a canvas to paint on, and through a resize", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const fake = createFakeGl();
    const effect = spreadsheet.create(fake.gl);
    effect.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (let i = 0; i < 300; i++) {
      effect.frame(1 / 30, DEFAULTS);
      if (i === 150) {
        effect.resize({ width: 360, height: 640, scale: 1 / 3 });
      }
    }
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });
});
