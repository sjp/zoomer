import { describe, expect, it } from "vitest";
import {
  createFlakes,
  FADE_IN,
  FLAKE_FLOATS,
  type FlakeFrame,
  LAYERS,
  layerSoftness,
  spritePad,
  SWAY_PX,
} from "./snow-sim";

const MAX = 600;
const frame = (over: Partial<FlakeFrame> = {}): FlakeFrame => ({
  refWidth: 1920,
  scale: 1,
  count: 400,
  speed: 1,
  wind: 0.2,
  gustiness: 0.5,
  sway: 0.5,
  size: 3,
  depthBlur: 0.5,
  brightness: 0.9,
  ...over,
});

/** Each layer's wrap margin, as `step` computes it. */
const margins = (f: FlakeFrame) =>
  LAYERS.map(
    (L, l) =>
      (f.size * L.size * spritePad(layerSoftness(l, f.depthBlur)) +
        f.sway * SWAY_PX * (0.5 + L.size * 0.4)) *
      1.3,
  );

describe("createFlakes", () => {
  const data = new Float32Array(MAX * FLAKE_FLOATS);

  it("is deterministic for a seed", () => {
    const a = createFlakes(MAX, 1920);
    const b = createFlakes(MAX, 1920);
    for (let k = 0; k < 30; k++) {
      a.step(1 / 60, frame(), data, FLAKE_FLOATS);
      b.step(1 / 60, frame(), data, FLAKE_FLOATS);
    }
    expect(b.xs).toEqual(a.xs);
    expect(b.ys).toEqual(a.ys);
  });

  it("splits flakes across the layers in their shares", () => {
    const flakes = createFlakes(MAX, 1920);
    for (const n of [50, 400]) {
      LAYERS.forEach((L, l) => {
        const share = flakes.layer.subarray(0, n).filter((x) => x === l).length / n;
        expect(Math.abs(share - L.share)).toBeLessThan(0.03);
      });
    }
  });

  it("wraps a flake only once it is fully off-screen, keeping it in the padded span", () => {
    const flakes = createFlakes(MAX, 1920);
    // Strong wind and fast fall, so flakes wrap often on both axes.
    const f = frame({ speed: 3, wind: 1, gustiness: 1 });
    const m = margins(f);
    const bad: string[] = [];
    let wraps = 0;
    for (let k = 0; k < 400; k++) {
      const xs = flakes.xs.slice();
      const ys = flakes.ys.slice();
      flakes.step(1 / 30, f, data, FLAKE_FLOATS);
      for (let i = 0; i < flakes.live; i++) {
        const margin = m[flakes.layer[i]];
        const [x, y] = [flakes.xs[i], flakes.ys[i]];
        if (x < -margin || x > 1920 + margin) bad.push(`x ${String(x)} outside ${String(margin)}`);
        if (y < -margin || y > 1080 + margin) bad.push(`y ${String(y)} outside ${String(margin)}`);
        // A flake that jumped was past the margin before the step and is back outside it after.
        if (Math.abs(y - ys[i]) > 540) {
          wraps++;
          if (ys[i] < 1080 + margin - 60) bad.push(`fell from ${String(ys[i])}`);
          if (y > -margin + 60) bad.push(`respawned at ${String(y)}`);
        }
        if (Math.abs(x - xs[i]) > 960 && Math.abs(y - ys[i]) <= 540) {
          wraps++;
          if (xs[i] > -margin + 60 && xs[i] < 1920 + margin - 60)
            bad.push(`jumped from x ${String(xs[i])}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(wraps).toBeGreaterThan(50);
  });

  it("orders the instances far to near, with nearStart at the near layer", () => {
    const flakes = createFlakes(MAX, 1920);
    const f = frame({ size: 4 });
    for (let k = 0; k < 120; k++) flakes.step(1 / 60, f, data, FLAKE_FLOATS);
    const n = flakes.step(1 / 60, f, data, FLAKE_FLOATS);
    const near = flakes.nearStart;
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(n);
    // Near flakes are the largest: every near half-height beats every far/mid one.
    let farMax = 0;
    let nearMin = Infinity;
    for (let i = 0; i < n; i++) {
      const half = data[i * FLAKE_FLOATS + 3];
      if (i < near) farMax = Math.max(farMax, half);
      else nearMin = Math.min(nearMin, half);
      expect(data[i * FLAKE_FLOATS + 4]).toBeLessThanOrEqual(1);
    }
    expect(nearMin).toBeGreaterThan(farMax);
  });

  it("fades flakes in from nothing, and removed ones out", () => {
    const flakes = createFlakes(MAX, 1920);
    const dt = 1 / 60;
    // The starting flakes fade in too: on the first frame they are all but invisible.
    expect(flakes.step(dt, frame(), data, FLAKE_FLOATS)).toBe(0);
    for (let t = 0; t < FADE_IN; t += dt) flakes.step(dt, frame(), data, FLAKE_FLOATS);
    expect(flakes.life[399]).toBe(1);
    const shown = flakes.step(dt, frame(), data, FLAKE_FLOATS);
    expect(shown).toBeGreaterThan(300);
    expect(flakes.step(dt, frame({ count: 500 }), data, FLAKE_FLOATS)).toBeLessThanOrEqual(400);
    expect(flakes.life[450]).toBeCloseTo(dt / FADE_IN, 6);
    for (let t = 0; t < FADE_IN; t += dt)
      flakes.step(dt, frame({ count: 500 }), data, FLAKE_FLOATS);
    flakes.step(dt, frame({ count: 200 }), data, FLAKE_FLOATS);
    expect(flakes.live).toBe(500);
    for (let k = 0; k < 60; k++) flakes.step(dt, frame({ count: 200 }), data, FLAKE_FLOATS);
    expect(flakes.live).toBe(200);
  });
});
