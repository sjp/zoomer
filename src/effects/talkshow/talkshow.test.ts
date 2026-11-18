import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { talkshow } from "./talkshow";
import { TITLE_MARGIN } from "./talkshow-sim";

const DEFAULTS = {
  backdrop: "night",
  desk: "wood",
  title: "TONIGHT",
  titleColor: "#ffe9c4",
  mic: true,
  applause: false,
  warmth: 0.6,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.9);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every text painted, the applause sign's word included. */
const texts = () =>
  MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));
const titles = () => texts().filter((t) => t !== "APPLAUSE");

/** Creates the effect and returns a stepper: `seconds` at 30 fps with `params`. */
function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = talkshow.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}) => {
    for (let i = 0; i < seconds * 30; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("late-night talk desk", () => {
  it("paints the title once, then nothing while it's unchanged", () => {
    const { fake, effect, run } = start();
    run(1);
    // Twice: its glow, then its letters.
    expect(titles()).toEqual(["TONIGHT", "TONIGHT"]);
    const painted = MeasuringCanvas.calls.length;
    run(10, { backdrop: "dusk", desk: "retro", mic: false, applause: true, warmth: 0 });
    run(5, { backdrop: "curtain", desk: "glass", titleColor: "#ff0000" });
    expect(MeasuringCanvas.calls.length).toBe(painted);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("repaints the title only when it's edited, and paints none for empty text", () => {
    const { run } = start();
    run(0.5);
    run(0.5, { title: "LIVE" });
    expect(titles().filter((t) => t === "LIVE")).toHaveLength(2);
    const before = titles().length;
    run(1, { title: "" });
    expect(titles().length).toBe(before);
  });

  it("cleans up the title before painting it", () => {
    const { run } = start();
    run(0.1, { title: "  LATE‮ SHOW\nSECOND LINE  " });
    expect(titles()).toEqual(["LATE SHOW", "LATE SHOW"]);
  });

  it.each([
    [1920, 1080],
    [2560, 1080],
    [1080, 1920],
    [640, 480],
  ])("fits the longest title on the desk front at %i x %i", (w, h) => {
    const { run } = start(w, h);
    run(0.1, { title: "W".repeat(16) });
    const call = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
    expect(call?.args[0]).toBe("W".repeat(16));
    const size = Number(/([\d.]+)px/.exec(call?.font ?? "")?.[1]);
    // The title's canvas is the last made: the sign's is painted on resize.
    const title = MeasuringCanvas.made.at(-1) ?? { width: 0, height: 0 };
    expect(size * 16 * 0.9).toBeLessThanOrEqual(title.width - 2 * TITLE_MARGIN * title.height);
  });

  it.each(["night", "dusk", "curtain", "unknown"])(
    "draws the %s backdrop with every desk without GL errors",
    (backdrop) => {
      const { fake, run } = start();
      for (const desk of ["wood", "retro", "glass", "unknown"]) {
        run(1.5, { backdrop, desk, applause: true });
      }
      run(60, { backdrop, applause: true });
      expect(fake.errors).toEqual([]);
    },
  );

  it("draws without a canvas to paint on", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { fake, run } = start();
    run(1);
    expect(fake.errors).toEqual([]);
  });
});
