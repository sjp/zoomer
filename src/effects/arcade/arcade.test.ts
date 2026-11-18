import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { arcade } from "./arcade";

const DEFAULTS = {
  framing: "screen",
  title: "",
  initials: "",
  palette: "arcade",
  crt: 0.6,
  pace: 1,
  seed: 1,
};

function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = arcade.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}, dt = 1 / 30) => {
    for (let i = 0; i < seconds / dt; i++) {
      effect.frame(dt, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

describe("arcade attract mode", () => {
  it.each(["arcade", "amber", "green", "unknown"])(
    "draws the %s palette in both framings without GL errors, and frees everything",
    (palette) => {
      const { fake, effect, run } = start();
      run(1, { palette });
      run(2, { palette, framing: "cabinet", title: "Moon Miner", initials: "abc" });
      run(2, { palette, framing: "screen", crt: 0, pace: 1.5 });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("runs through whole loops", () => {
    const { fake, run } = start();
    run(80, { pace: 1.5 }, 0.25);
    run(80, { framing: "cabinet", pace: 0.5 }, 0.25);
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
    run(2, { framing: "cabinet" });
    expect(fake.errors).toEqual([]);
  });
});
