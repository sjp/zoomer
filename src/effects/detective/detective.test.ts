import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { detective } from "./detective";

const DEFAULTS = {
  door: "PRIVATE\nINVESTIGATOR",
  tone: "mono",
  rain: 0.5,
  sign: true,
  fan: true,
  grain: 0.3,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.7);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const texts = () =>
  MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));

/** Creates the effect at 1920 x 1080 and returns a stepper: `seconds` at 30 fps with `params`. */
function start() {
  const fake = createFakeGl();
  const effect = detective.create(fake.gl);
  effect.resize({ width: 1920, height: 1080, scale: 1 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}) => {
    for (let i = 0; i < seconds * 30; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("detective office", () => {
  it("letters the door once, then paints nothing while it's unchanged", () => {
    const { fake, effect, run } = start();
    run(1);
    expect(texts()).toEqual(["PRIVATE", "INVESTIGATOR"]);
    const painted = MeasuringCanvas.calls.length;
    run(10, { tone: "sepia", rain: 1, sign: false, fan: false });
    expect(MeasuringCanvas.calls.length).toBe(painted);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("repaints the lettering only when it's edited, and paints none for empty text", () => {
    const { run } = start();
    run(0.5);
    run(0.5, { door: "S. SPADE" });
    expect(texts().filter((t) => t === "S. SPADE")).toHaveLength(1);
    const before = texts().length;
    run(0.5, { door: "" });
    expect(texts().length).toBe(before);
  });

  it("cleans up the lettering before painting it", () => {
    const { run } = start();
    run(0.1, { door: "  ACME‮ AGENCY\nTWO\nTHREE" });
    expect(texts()).toEqual(["ACME AGENCY", "TWO"]);
  });

  it("keeps its letters inside the panel at the longest lettering", () => {
    const { run } = start();
    const line = "W".repeat(22);
    run(0.1, { door: `${line}\n${line}` });
    const call = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
    const size = Number(/([\d.]+)px/.exec(call?.font ?? "")?.[1]);
    expect(size * 22 * 0.7).toBeLessThanOrEqual(600);
  });

  it.each(["mono", "sepia", "colour", "unknown"])("draws the %s tone without GL errors", (tone) => {
    const { fake, run } = start();
    run(2, { tone, rain: 0 });
    run(2, { tone, rain: 1 });
    expect(fake.errors).toEqual([]);
  });

  it("draws without a canvas to paint on", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { fake, run } = start();
    run(1);
    expect(fake.errors).toEqual([]);
  });
});
