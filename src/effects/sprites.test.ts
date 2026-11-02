import { describe, expect, it } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { createSpriteBatch, polygonStrip } from "./sprites";

const named = (calls: { name: string; args: unknown[] }[], name: string) =>
  calls.filter((c) => c.name === name).map((c) => c.args);

describe("createSpriteBatch", () => {
  it("clamps upload to maxInstances", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [2, 1]);
    calls.length = 0;
    batch.upload(25);
    const [sub] = named(calls, "bufferSubData");
    expect(sub[4]).toBe(10 * 3);
  });

  it("uploads nothing for a zero, negative or NaN count", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.upload(0);
    batch.upload(-3);
    batch.upload(NaN);
    expect(calls).toHaveLength(0);
  });

  it("clips draws to the instances that exist", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const batch = createSpriteBatch(gl, 10, [4]);
    calls.length = 0;
    batch.draw(0, 50);
    batch.draw(6, 50);
    batch.draw(10, 5);
    batch.draw(3, 4);
    const draws = named(calls, "drawArraysInstanced").map((c) => c[3]);
    expect(draws).toEqual([10, 4, 4]);
  });
});

describe("polygonStrip", () => {
  /** Signed area of each triangle of the strip. */
  const triangleAreas = (v: number[]) => {
    const out: number[] = [];
    for (let i = 0; i + 5 < v.length; i += 2) {
      const [ax, ay, bx, by, cx, cy] = v.slice(i, i + 6);
      out.push(((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2);
    }
    return out;
  };

  it.each([3, 4, 5, 6, 8, 12])("covers a %i-gon with apothem 1 and no overlap", (sides) => {
    for (const angle of [0, Math.PI / sides, 0.3]) {
      const v = polygonStrip(sides, angle);
      expect(v).toHaveLength(sides * 2);

      // Every vertex is a distinct corner of the regular n-gon whose circumradius is
      // 1 / cos(pi / n), so its apothem (each edge midpoint's distance) is 1.
      const corners = new Set<number>();
      for (let i = 0; i < v.length; i += 2) {
        expect(Math.hypot(v[i], v[i + 1])).toBeCloseTo(1 / Math.cos(Math.PI / sides), 12);
        const k = (Math.atan2(v[i + 1], v[i]) - angle) / ((2 * Math.PI) / sides);
        corners.add(((Math.round(k) % sides) + sides) % sides);
      }
      expect(corners.size).toBe(sides);

      // The strip's triangles alternate orientation (consistent winding for a strip),
      // none is degenerate, and together they cover exactly the polygon's area.
      const areas = triangleAreas(v);
      expect(areas).toHaveLength(sides - 2);
      areas.forEach((a, i) => {
        expect(Math.abs(a)).toBeGreaterThan(1e-6);
        expect(Math.sign(a)).toBe(i % 2 === 0 ? Math.sign(areas[0]) : -Math.sign(areas[0]));
      });
      const total = areas.reduce((s, a) => s + Math.abs(a), 0);
      expect(total).toBeCloseTo(sides * Math.tan(Math.PI / sides), 10);
    }
  });
});
