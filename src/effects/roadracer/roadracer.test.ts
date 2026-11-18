import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MAX_MEAN_STEP } from "../motion-limits";
import { CROSSFADE, roadRacer } from "./roadracer";

const DEFAULTS = {
  course: "coast",
  speed: 0.5,
  lane: "right",
  hud: true,
  pixel: 2,
  seed: 1,
};

function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = roadRacer.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, dt = 1 / 30) => {
    for (let i = 0; i < seconds / dt; i++) {
      effect.frame(dt, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("road racer", () => {
  it.each(["coast", "sunset", "night", "unknown"])(
    "draws the %s course through course, seed, lane, pixel and HUD changes without GL errors, and frees everything",
    (course) => {
      const { fake, effect, run } = start();
      run(1, { course });
      run(2, { course: "night", lane: "left", hud: false });
      run(2, { course, seed: 9, speed: 1, pixel: 4 });
      run(2, { course, pixel: 1, speed: 0.2, hud: true });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("drives on for a long time", () => {
    const { fake, run } = start();
    run(900, { speed: 1 }, 0.25);
    expect(fake.errors).toEqual([]);
  });

  it.each([
    [2560, 1080],
    [1080, 1920],
    [3840, 2160],
    [640, 480],
    [1, 1],
  ])("draws at %i x %i", (w, h) => {
    const { fake, run } = start(w, h);
    run(1);
    run(1, { pixel: 1 });
    expect(fake.errors).toEqual([]);
  });

  it("crossfades a change of course slowly enough that the frame's brightness never jumps", () => {
    // The worst case, black to white, over the whole crossfade at 30 fps.
    expect(1 / (CROSSFADE * 30)).toBeLessThan(MAX_MEAN_STEP);
  });
});
