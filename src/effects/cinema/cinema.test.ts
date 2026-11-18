import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { cinema } from "./cinema";

const DEFAULTS = {
  view: "projector",
  state: "playing",
  film: "drama",
  seats: "#8c1420",
  dust: 0.5,
};

/** Creates the effect and returns a stepper: `seconds` at 30 fps with `params`. */
function start(width = 1920, height = 1080) {
  const fake = createFakeGl();
  const effect = cinema.create(fake.gl);
  effect.resize({ width, height, scale: height / 1080 });
  const run = (seconds: number, params: Partial<typeof DEFAULTS> = {}) => {
    for (let i = 0; i < seconds * 30; i++) {
      effect.frame(1 / 30, { ...DEFAULTS, ...params });
    }
  };
  return { fake, effect, run };
}

/** How many times the room has been drawn into a cache: full-size draws into a framebuffer. */
const bakes = (fake: ReturnType<typeof createFakeGl>) => fake.created.get("Framebuffer") ?? 0;

describe("cinema auditorium", () => {
  it.each(["projector", "screen", "unknown"])(
    "draws the %s view in every state and film without GL errors",
    (view) => {
      const { fake, effect, run } = start();
      for (const film of ["drama", "scifi", "western", "animation", "unknown"]) {
        run(1, { view, film });
        run(1, { view, film, state: "before", dust: 1 });
      }
      run(12, { view, dust: 0 });
      effect.dispose?.();
      expect(fake.errors).toEqual([]);
      expect(fake.live()).toEqual([]);
    },
  );

  it("cross-fades a view or seat colour change, then keeps one cached room", () => {
    const { fake, run } = start();
    run(1);
    const made = bakes(fake);
    run(2, { view: "screen" });
    run(2, { view: "screen", seats: "#204080" });
    // One new cache for each change, freed again once its fade is done.
    expect(bakes(fake)).toBe(made + 2);
    run(2, { view: "screen", seats: "#204080" });
    expect(bakes(fake)).toBe(made + 2);
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
    run(1, { view: "screen" });
    expect(fake.errors).toEqual([]);
  });
});
