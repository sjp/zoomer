import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { blockCascade } from "./blockcascade";

const DEFAULTS = {
  wells: "two",
  style: "glass",
  palette: "candy",
  speed: 2,
  skill: 0.7,
  seed: 1,
};

function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = blockCascade.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, dt = 1 / 30) => {
    for (let i = 0; i < seconds / dt; i++) {
      effect.frame(dt, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("block cascade", () => {
  it.each(["glass", "pixel", "neon", "unknown"])(
    "draws the %s style through palette, wells and seed changes without GL errors, and frees everything",
    (style) => {
      const { fake, effect, run } = start();
      run(1, { style });
      run(2, { style, palette: "pastel", wells: "one" });
      run(2, { style, palette: "ocean", seed: 9, speed: 6, skill: 0 });
      run(2, { style, palette: "mono", speed: 1, skill: 1 });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("plays on for a long time", () => {
    const { fake, run } = start();
    run(600, { speed: 6 }, 0.25);
    expect(fake.errors).toEqual([]);
  });

  it.each([
    [2560, 1080],
    [1080, 1920],
    [640, 480],
    [1, 1],
  ])("draws at %i x %i", (w, h) => {
    const { fake, run } = start(w, h);
    run(1);
    run(1, { wells: "one" });
    expect(fake.errors).toEqual([]);
  });
});
