import { describe, expect, it } from "vitest";
import { createCountFade, driftPoint, FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { createRng } from "./noise";

/** One frame of the documented loop; returns the new live count. */
function frame(life: Float32Array, live: number, target: number, step: number): number {
  live = growLive(life, live, target);
  for (let i = 0; i < live; i++) {
    stepLife(life, i, target, step, step);
  }
  return trimLive(life, live, target);
}

describe("count fades", () => {
  it("fades added items in from 0", () => {
    const life = new Float32Array(4).fill(1);
    let live = frame(life, 0, 2, 0.25);
    expect(live).toBe(2);
    expect([...life]).toEqual([0.25, 0.25, 1, 1]);
    for (let k = 0; k < 10; k++) {
      live = frame(life, live, 2, 0.25);
    }
    expect(life[0]).toBe(1);
  });

  it("keeps removed items live until they have faded out", () => {
    const life = new Float32Array(4).fill(1);
    let live = 4;
    live = frame(life, live, 2, 0.5);
    expect(live).toBe(4);
    expect([...life]).toEqual([1, 1, 0.5, 0.5]);
    live = frame(life, live, 2, 0.5);
    expect(live).toBe(2);
    expect([...life]).toEqual([1, 1, 0, 0]);
  });

  it("fades items back in from where they were when the count rises mid fade-out", () => {
    const life = new Float32Array(4).fill(1);
    let live = frame(life, 4, 1, 0.25);
    expect(life[2]).toBe(0.75);
    live = frame(life, live, 3, 0.25);
    expect(live).toBe(4);
    expect([...life]).toEqual([1, 1, 1, 0.5]);
  });

  it("restarts items beyond the live range at 0", () => {
    const life = new Float32Array(3).fill(0.7);
    expect(growLive(life, 1, 3)).toBe(3);
    expect([...life].map((v) => Math.round(v * 10) / 10)).toEqual([0.7, 0, 0]);
  });

  it("trims only from the top", () => {
    const life = new Float32Array([1, 0, 0.5, 0]);
    expect(trimLive(life, 4, 1)).toBe(3);
    expect(trimLive(life, 4, 4)).toBe(4);
  });
});

describe("driftPoint", () => {
  it("moves without wrapping inside the domain", () => {
    const xs = new Float32Array([100]);
    const ys = new Float32Array([200]);
    expect(driftPoint(xs, ys, 0, 1.5, -2, -50, -50, 2020, 1180)).toBe(false);
    expect(xs[0]).toBeCloseTo(101.5, 4);
    expect(ys[0]).toBeCloseTo(198, 4);
  });

  it("flags a wrap on either axis", () => {
    const xs = new Float32Array([1969, 10]);
    const ys = new Float32Array([500, -49]);
    expect(driftPoint(xs, ys, 0, 2, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(xs[0]).toBeCloseTo(-49, 3);
    expect(driftPoint(xs, ys, 1, 0, -2, -50, -50, 2020, 1180)).toBe(true);
    expect(ys[1]).toBeCloseTo(1129, 3);
  });

  it("flags the fold when the link distance shrinks the margin", () => {
    // From 0.3 to 0.05 of the height: x = 2200 was in the old margin.
    const dist = 0.05 * 1080;
    const xs = new Float32Array([2200]);
    const ys = new Float32Array([500]);
    expect(driftPoint(xs, ys, 0, 0, 0, -dist, -dist, 1920 + 2 * dist, 1080 + 2 * dist)).toBe(true);
    expect(xs[0]).toBeGreaterThan(0);
    expect(xs[0]).toBeLessThan(1920);
  });
});

describe("driftPoint wrapping", () => {
  it("wraps a point stored exactly at minX + spanX to minX, flagging it", () => {
    const xs = new Float32Array([1970, 300]);
    const ys = new Float32Array([500, 1130]);
    expect(driftPoint(xs, ys, 0, 0, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(xs[0]).toBe(-50);
    expect(driftPoint(xs, ys, 1, 0, 0, -50, -50, 2020, 1180)).toBe(true);
    expect(ys[1]).toBe(-50);
    // ...and a point exactly at minX stays.
    expect(driftPoint(xs, ys, 0, 0, 0, -50, -50, 2020, 1180)).toBe(false);
    expect(xs[0]).toBe(-50);
  });

  it("keeps drifting points in the domain, flagging each crossing once", () => {
    const rng = createRng(31);
    for (let k = 0; k < 20; k++) {
      // Awkward, non-representable domains and steps.
      const minX = -40 - rng() * 30;
      const minY = -40 - rng() * 30;
      const spanX = 1920 - 2 * minX;
      const spanY = 1080 - 2 * minY;
      const dx = (rng() - 0.5) * 7;
      const dy = (rng() - 0.5) * 7;
      const xs = new Float32Array([rng() * 1920]);
      const ys = new Float32Array([rng() * 1080]);
      // Float32 storage may round a point up onto the far edge, never past it.
      const loX = Math.fround(minX);
      const hiX = Math.fround(minX + spanX);
      const loY = Math.fround(minY);
      const hiY = Math.fround(minY + spanY);
      let flagged = 0;
      let crossings = 0;
      // Plain comparisons in the hot loop: an expect per step dominates the runtime.
      const outside: string[] = [];
      for (let step = 0; step < 5000; step++) {
        const x = xs[0] + dx;
        const y = ys[0] + dy;
        if (x < minX || x >= minX + spanX || y < minY || y >= minY + spanY) {
          crossings++;
        }
        if (driftPoint(xs, ys, 0, dx, dy, minX, minY, spanX, spanY)) {
          flagged++;
        }
        const inside = xs[0] >= loX && xs[0] <= hiX && ys[0] >= loY && ys[0] <= hiY;
        if (!inside && outside.length < 10) {
          outside.push(
            `domain ${String(k)}, step ${String(step)}: (${String(xs[0])}, ${String(ys[0])})`,
          );
        }
      }
      expect(outside).toEqual([]);
      expect(flagged).toBe(crossings);
      expect(crossings).toBeGreaterThan(0);
    }
  });
});

describe("createCountFade", () => {
  it("fades items in and out, then rests until the target changes", () => {
    const fade = createCountFade(8);
    fade.snap(3);
    expect(fade.live).toBe(3);
    expect([...fade.life.subarray(0, 3)]).toEqual([1, 1, 1]);
    expect(fade.step(3, 0.1, 1)).toBe(false);

    expect(fade.step(5, 0.25, 1)).toBe(true);
    expect(fade.live).toBe(5);
    expect([...fade.life.subarray(0, 5)]).toEqual([1, 1, 1, 0.25, 0.25]);
    for (let k = 0; k < 3; k++) {
      expect(fade.step(5, 0.25, 1)).toBe(true);
    }
    expect([...fade.life.subarray(3, 5)]).toEqual([1, 1]);
    expect(fade.step(5, 0.25, 1)).toBe(false);

    expect(fade.step(2, FADE_OUT / 2, 1)).toBe(true);
    expect(fade.live).toBe(5);
    expect(fade.life[4]).toBeCloseTo(0.5);
    expect(fade.step(2, FADE_OUT / 2, 1)).toBe(true);
    expect(fade.live).toBe(2);
    expect(fade.step(2, 1, 1)).toBe(false);
  });

  it("clamps the target to the capacity and ignores bad steps", () => {
    const fade = createCountFade(4);
    fade.snap(99);
    expect(fade.live).toBe(4);
    fade.step(2, Number.NaN, 1);
    expect(fade.live).toBe(4);
    expect(fade.life[3]).toBe(1);
    // A target that isn't a number counts as none.
    fade.step(Number.NaN, FADE_OUT, 1);
    expect(fade.live).toBe(0);
  });
});
