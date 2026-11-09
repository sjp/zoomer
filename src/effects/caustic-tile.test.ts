import { describe, expect, it } from "vitest";
import { createCausticTile, tileFragment } from "./caustic-tile";
import { CAUSTIC_RATES } from "./caustics/caustics-sim";
import { createFullscreenTriangle } from "./gl";
import { createFakeGl } from "../test/fake-gl";

describe("tileFragment", () => {
  it("generates one unrolled warp iteration per rate", () => {
    const src = tileFragment(CAUSTIC_RATES.length);
    expect(src.startsWith("#version 300 es")).toBe(true);
    expect(src.match(/inversesqrt/g)?.length).toBe(CAUSTIC_RATES.length);
    expect(src).toContain(`uniform float uT[${String(CAUSTIC_RATES.length)}];`);
  });
});

describe("createCausticTile", () => {
  const make = (unrenderable: string[] = []) => {
    const fake = createFakeGl({ unrenderable });
    const triangle = createFullscreenTriangle(fake.gl);
    const tile = createCausticTile(fake.gl, triangle, {
      interval: 0.1,
      rate: 1,
      driftA: [0.5, 0.25],
      driftB: [-0.5, 0],
    });
    return { fake, triangle, tile };
  };

  it("renders when new, then at most once an interval while moving", () => {
    const { fake, triangle, tile } = make();
    expect(tile.texture).toBeNull();
    expect(tile.update(0.01, true)).toBe(false);
    expect(tile.resize(256)).toBe(true);
    expect(tile.texture).not.toBeNull();
    // New: rendered even while still.
    expect(tile.update(0, false)).toBe(true);
    expect(tile.update(0.05, true)).toBe(false);
    expect(tile.update(0.05, false)).toBe(false);
    expect(tile.update(0, true)).toBe(true);
    // The same size again is kept as it is.
    expect(tile.resize(256)).toBe(true);
    expect(tile.update(0, true)).toBe(false);
    // Hidden: ages, but doesn't render until shown.
    expect(tile.update(0.2, true, false)).toBe(false);
    expect(tile.update(0, true, true)).toBe(true);
    expect(fake.state.drawFramebuffer).toBeNull();
    tile.dispose();
    triangle.dispose();
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it("drifts both layers, wrapped to 0..1", () => {
    const { tile } = make();
    tile.advance(1);
    expect([...tile.offsets]).toEqual([0.5, 0.25, 0.5, 0]);
    tile.advance(3);
    expect([...tile.offsets]).toEqual([0, 0, 0, 0]);
    tile.dispose();
  });

  it("reports a tile that can't be allocated", () => {
    const { fake, tile } = make(["R8"]);
    expect(tile.resize(256)).toBe(false);
    expect(tile.texture).toBeNull();
    expect(tile.update(1, true)).toBe(false);
    tile.dispose();
    expect(fake.live().map((o) => o.kind)).toEqual(["VertexArray", "Buffer"]);
  });
});
