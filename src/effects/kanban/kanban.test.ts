import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { kanban } from "./kanban";

const DEFAULTS = {
  theme: "light",
  columns: "classic",
  pace: 8,
  title: "Sprint Board",
  style: "cards",
  seed: 1,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Runs the effect at `w` x `h` for `seconds` per param set at 30 fps, returning the strings it painted. */
function paint(seconds: number, params: Partial<typeof DEFAULTS>[], w = 1920, h = 1080) {
  const fake = createFakeGl();
  const effect = kanban.create(fake.gl);
  effect.resize({ width: w, height: h, scale: h / 1080 });
  for (const p of params) {
    for (let i = 0; i < seconds * 30; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, ...p });
    }
  }
  effect.dispose?.();
  expect(fake.errors).toEqual([]);
  return MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
}

describe("kanban board", () => {
  it("paints the title, the column names, counts and cards", () => {
    const texts = paint(2, [{}]);
    for (const t of ["Sprint Board", "Backlog", "To do", "In progress", "Done"]) {
      expect(texts).toContain(t);
    }
    expect(texts.some((t) => /^\d+$/.test(t))).toBe(true);
    expect(texts.some((t) => /^\d\/\d$/.test(t))).toBe(true);
  });

  it("shows three columns in a narrow frame", () => {
    const texts = paint(1, [{}], 607, 1080);
    expect(texts).toContain("In progress");
    expect(texts).not.toContain("Backlog");
  });

  it("paints nothing more while the board is still", () => {
    const fake = createFakeGl();
    const effect = kanban.create(fake.gl);
    effect.resize({ width: 1920, height: 1080, scale: 1 });
    const texts = () => MeasuringCanvas.calls.filter((c) => c.method === "fillText").length;
    for (let i = 0; i < 30; i++) {
      effect.frame(1 / 30, DEFAULTS);
    }
    const first = texts();
    // The first move comes half a pace in, the first arrival and checklist tick later still.
    for (let i = 0; i < 60; i++) {
      effect.frame(1 / 30, DEFAULTS);
    }
    expect(first).toBeGreaterThan(50);
    expect(texts()).toBe(first);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("lets a look's crossfade finish before fading to a third look", () => {
    const fake = createFakeGl({ record: true });
    const effect = kanban.create(fake.gl);
    effect.resize({ width: 1920, height: 1080, scale: 1 });
    const mixes = () =>
      fake.calls
        .filter((c) => c.name === "uniform1f" && (c.args[0] as { name: string }).name === "uMix")
        .map((c) => c.args[1] as number);
    for (let i = 0; i < 10; i++) {
      effect.frame(1 / 30, DEFAULTS);
    }
    // Dark, then sticky notes a moment into that fade.
    for (let i = 0; i < 9; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, theme: "dark" });
    }
    for (let i = 0; i < 120; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, theme: "dark", style: "sticky" });
    }
    const m = mixes();
    // The mix only falls back once a fade has reached 1: once for dark, once for sticky.
    const restarts = m.filter((x, i) => i > 0 && x < m[i - 1]);
    expect(m.some((x, i) => i > 0 && x < m[i - 1] && m[i - 1] < 1)).toBe(false);
    expect(restarts.length).toBe(2);
    expect(m[m.length - 1]).toBe(1);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it.each([
    [{ theme: "dark" }],
    [{ style: "sticky" }],
    [{ columns: "simple" }],
    [{ columns: "product", title: "Roadmap" }],
    [{ pace: 4, title: "" }],
    [{ seed: 9 }],
  ])("keeps working through a change to %j", (change) => {
    const texts = paint(6, [{}, change, {}]);
    expect(texts.length).toBeGreaterThan(20);
  });
});
