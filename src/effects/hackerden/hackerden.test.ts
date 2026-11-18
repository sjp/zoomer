import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { hackerden } from "./hackerden";

const DEFAULTS = { palette: "green", handle: "ghost", pace: 0.5, alerts: true, screens: 6 };

function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = hackerden.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, dt = 1 / 30) => {
    for (let i = 0; i < seconds / dt; i++) {
      effect.frame(dt, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("hacker thriller den", () => {
  it.each(["green", "amber", "ice", "movie", "unknown"])(
    "draws the %s palette with every screen count without GL errors",
    (palette) => {
      const { fake, effect, run } = start();
      for (const screens of [5, 6, 7]) {
        run(1, { palette, screens });
      }
      run(2, { palette, handle: "", pace: 1, alerts: false });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("runs past an alert", () => {
    const { fake, run } = start();
    run(150, { screens: 7 }, 0.25);
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
    expect(fake.errors).toEqual([]);
  });
});
