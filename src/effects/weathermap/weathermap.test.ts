import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { weathermap } from "./weathermap";
import { DAY_NAMES, REGIONS } from "./weathermap-sim";

const DEFAULTS = {
  region: "british",
  style: "classic",
  season: "autumn",
  units: "c",
  radar: true,
  pace: 25,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.6);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const texts = () =>
  MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));

/** Creates the effect and returns a stepper: `seconds` at `fps` with `params`. */
function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = weathermap.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, fps = 30) => {
    for (let i = 0; i < seconds * fps; i++) {
      effect.frame(1 / fps, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

const isDay = (t: string) => DAY_NAMES.some((d) => d === t);

describe("weather forecast map", () => {
  it("paints its names, glyphs and day once, then nothing until the day changes", () => {
    const { fake, effect, run } = start();
    run(1);
    const painted = texts();
    expect(painted).toEqual(expect.arrayContaining(REGIONS.british.cities.map((c) => c.name)));
    expect(painted.filter((t) => isDay(t))).toHaveLength(1);
    const count = MeasuringCanvas.calls.length;
    run(20, { radar: false, units: "f", style: "modern" });
    expect(MeasuringCanvas.calls.length).toBe(count);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("moves on a day every pace seconds", () => {
    const { run } = start();
    run(1, { pace: 10 });
    const first = texts().filter((t) => isDay(t));
    run(10, { pace: 10 }, 10);
    const days = texts().filter((t) => isDay(t));
    expect(days).toHaveLength(2);
    expect(DAY_NAMES.indexOf(days[1] as (typeof DAY_NAMES)[number])).toBe(
      (DAY_NAMES.indexOf(first[0] as (typeof DAY_NAMES)[number]) + 1) % 7,
    );
  });

  it("starts a new forecast, with the new region's names, on a region change", () => {
    const { run } = start();
    run(1);
    run(2, { region: "japan" });
    expect(texts()).toEqual(expect.arrayContaining(REGIONS.japan.cities.map((c) => c.name)));
  });

  it.each([
    [1920, 1080],
    [1280, 720],
    [2560, 1080],
    [1080, 1920],
    [16, 9],
  ])("draws at %i x %i without GL errors", (width, height) => {
    const { fake, run } = start(width, height);
    run(1);
    expect(fake.errors).toEqual([]);
  });

  it.each(["british", "europe", "america", "australia", "japan", "unknown"])(
    "draws %s in every look without GL errors",
    (region) => {
      const { fake, run } = start();
      run(1, { region });
      run(2, { region, style: "modern", season: "winter", units: "f", radar: false });
      run(30, { region, pace: 10 }, 4);
      expect(fake.errors).toEqual([]);
    },
  );

  it("draws without a canvas to paint on", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { fake, run } = start();
    run(2);
    expect(fake.errors).toEqual([]);
  });
});
