import { describe, expect, it } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { physarum } from "./physarum";

describe("physarum", () => {
  it("carries the network onto a new grid instead of reseeding it", () => {
    const fake = createFakeGl({ record: true });
    const instance = physarum.create(fake.gl);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    const params = {
      palette: "gold",
      agents: "medium",
      scale: 1.25,
      speed: 0.5,
      decay: 0.15,
      food: true,
      calmCentre: true,
    } as const;
    instance.frame(1 / 30, params);
    const uploads = () => fake.calls.filter((c) => c.name === "bufferData").length;
    const seeded = uploads();
    expect(seeded).toBeGreaterThan(0);
    const textures = fake.created.get("Texture") ?? 0;
    instance.frame(1 / 30, { ...params, scale: 1.5 });
    // A new pair of trail targets, but no agents uploaded again.
    expect(fake.created.get("Texture")).toBe(textures + 2);
    expect(uploads()).toBe(seeded);
    expect(fake.errors).toEqual([]);
    instance.dispose?.();
  });
});
