import { describe, expect, it } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { createStreakRenderer } from "./streaks";

const named = (calls: { name: string; args: unknown[] }[], name: string) =>
  calls.filter((c) => c.name === name).map((c) => c.args);

describe("createStreakRenderer", () => {
  it("blends additively by default", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const streaks = createStreakRenderer(gl, 4);
    const sources = named(calls, "shaderSource").map((a) => String(a[1]));
    expect(sources.some((s) => s.includes("vFade"))).toBe(false);
    calls.length = 0;
    streaks.draw(2, 100, 100);
    expect(named(calls, "blendFunc")).toEqual([[gl.ONE, gl.ONE]]);
  });

  it("draws source-over with straight colour in alpha mode", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const streaks = createStreakRenderer(gl, 4, { blend: "alpha" });
    const sources = named(calls, "shaderSource").map((a) => String(a[1]));
    expect(sources.every((s) => s.includes("vFade"))).toBe(true);
    expect(sources.some((s) => s.includes("vColor = aStyle.rgb;"))).toBe(true);
    calls.length = 0;
    streaks.draw(2, 100, 100);
    expect(named(calls, "blendFunc")).toEqual([[gl.ONE, gl.ONE_MINUS_SRC_ALPHA]]);
  });

  it("keeps the per-channel maximum in max mode, then restores FUNC_ADD", () => {
    const { gl, calls } = createFakeGl({ record: true });
    const streaks = createStreakRenderer(gl, 4, { blend: "max" });
    const sources = named(calls, "shaderSource").map((a) => String(a[1]));
    expect(sources.some((s) => s.includes("vFade"))).toBe(false);
    calls.length = 0;
    streaks.draw(2, 100, 100);
    expect(named(calls, "blendEquation")).toEqual([[gl.MAX], [gl.FUNC_ADD]]);
  });

  it("refuses alpha blending with the chromatic program", () => {
    const { gl, live } = createFakeGl();
    expect(() => createStreakRenderer(gl, 4, { blend: "alpha", chromatic: true })).toThrow(
      /additive only/,
    );
    expect(live()).toHaveLength(0);
  });
});
