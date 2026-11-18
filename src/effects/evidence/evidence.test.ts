import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { evidence } from "./evidence";

const DEFAULTS = {
  title: "UNSOLVED",
  lighting: "lamp",
  string: "#c4202b",
  density: 22,
  grow: true,
};

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const texts = () =>
  MeasuringCanvas.calls.filter((c) => c.method === "fillText").map((c) => String(c.args[0]));

/** Creates the effect at 1920 x 1080 and returns a stepper: `seconds` at `fps` with `params`. */
function start() {
  const fake = createFakeGl();
  const effect = evidence.create(fake.gl);
  effect.resize({ width: 1920, height: 1080, scale: 1 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, fps = 30) => {
    for (let i = 0; i < seconds * fps; i++) {
      effect.frame(1 / fps, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("evidence board", () => {
  it("paints the title card and the items' words once, then nothing while it's still", () => {
    const { fake, effect, run } = start();
    run(1);
    expect(texts()).toContain("UNSOLVED");
    expect(texts().some((t) => /^[A-Z0-9 :?]+$/.test(t) && t !== "UNSOLVED")).toBe(true);
    const painted = MeasuringCanvas.calls.length;
    run(20);
    expect(MeasuringCanvas.calls.length).toBe(painted);
    effect.dispose?.();
    expect(fake.errors).toEqual([]);
  });

  it("repaints the title card only when the title is edited, and keeps it while it fades", () => {
    const { run } = start();
    run(1);
    const count = () => texts().filter((t) => t === "WHO TOOK IT?").length;
    run(1, { title: "WHO TOOK IT?" });
    expect(count()).toBe(1);
    const painted = MeasuringCanvas.calls.length;
    run(1, { title: "" });
    expect(MeasuringCanvas.calls.length).toBe(painted);
  });

  it("cleans up the title before painting it", () => {
    const { run } = start();
    run(0.1, { title: "  CASE‮ 42  " });
    expect(texts()).toContain("CASE 42");
  });

  it("paints a new card when the case grows, and none when it doesn't", () => {
    const off = start();
    off.run(1, { grow: false });
    const still = MeasuringCanvas.calls.length;
    off.run(200, { grow: false }, 2);
    expect(MeasuringCanvas.calls.length).toBe(still);

    MeasuringCanvas.reset(0.5);
    const on = start();
    on.run(1);
    const before = texts().length;
    on.run(200, {}, 2);
    expect(texts().length).toBeGreaterThan(before);
  });

  it("draws without a canvas to paint on", () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { fake, run } = start();
    run(2);
    expect(fake.errors).toEqual([]);
  });
});
