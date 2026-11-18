import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { loadingScreen } from "./loadingscreen";

const DEFAULTS = {
  art: "ruins",
  tips: "",
  tipEvery: 12,
  progress: "never",
  loop: 5,
  accent: "#5fd4ff",
  seed: 1,
};

function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = loadingScreen.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, dt = 1 / 30) => {
    for (let i = 0; i < seconds / dt; i++) {
      effect.frame(dt, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("loading screen", () => {
  it.each(["ruins", "spaceport", "forest", "unknown"])(
    "draws the %s art through art, tip, progress and seed changes without GL errors, and frees everything",
    (art) => {
      const { fake, effect, run } = start();
      run(1, { art });
      run(2, { art: "spaceport" });
      run(2, { art, tips: "One\n\nTwo", tipEvery: 6, seed: 9 });
      run(2, { art: "forest", progress: "steady", loop: 1, accent: "#ff8800" });
      run(14, { art, progress: "steady", loop: 1 });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("keeps loading for a long time", () => {
    const { fake, run } = start();
    run(1800, {}, 0.5);
    expect(fake.errors).toEqual([]);
  });

  it.each([
    [2560, 1080],
    [1080, 1920],
    [640, 480],
    [7680, 1080],
    [1, 1],
  ])("draws at %i x %i", (w, h) => {
    const { fake, effect, run } = start(w, h);
    run(1);
    effect.resize({ width: h, height: w, scale: w / 1080 });
    run(1, { art: "forest" });
    expect(fake.errors).toEqual([]);
  });
});
