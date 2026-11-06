import { describe, expect, it } from "vitest";
import { createLights, FADE_IN, LIGHT_FLOATS, type LightFrame, SPRITE_PAD } from "./bokeh-sim";
import { createRng } from "./noise";

const MAX = 200;
const frame = (over: Partial<LightFrame> = {}): LightFrame => ({
  refWidth: 1920,
  scale: 2,
  target: 60,
  size: 60,
  sizeVariation: 0.5,
  direction: 30,
  speed: 3,
  wander: 0.5,
  twinkle: 0.5,
  brightness: 1,
  ...over,
});

describe("createLights", () => {
  const data = new Float32Array(MAX * LIGHT_FLOATS);

  it("wraps a light only once it is fully off-screen, to fully off-screen", () => {
    const lights = createLights(MAX, 1920, createRng(1));
    // Fast and large, so lights wrap often.
    const f = frame({ speed: 40, size: 150, sizeVariation: 0 });
    const margin = 150 * SPRITE_PAD;
    let wraps = 0;
    const bad: string[] = [];
    for (let k = 0; k < 600; k++) {
      const xs = lights.xs.slice();
      const ys = lights.ys.slice();
      lights.step(1 / 30, f, data, LIGHT_FLOATS);
      for (let i = 0; i < lights.live; i++) {
        for (const [a, b, size] of [
          [xs[i], lights.xs[i], 1920],
          [ys[i], lights.ys[i], 1080],
        ]) {
          if (b < -margin || b > size + margin)
            bad.push(`light ${String(i)} left the padded span: ${String(b)}`);
          if (Math.abs(b - a) > size / 2) {
            wraps++;
            // Before and after the jump, the whole sprite (radius < margin) is out of view.
            if (!(a <= -margin + 30 || a >= size + margin - 30))
              bad.push(`jumped from ${String(a)}`);
            if (!(b <= -margin + 30 || b >= size + margin - 30)) bad.push(`jumped to ${String(b)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
    expect(wraps).toBeGreaterThan(20);
  });

  it("emits device-pixel instances with opacity in (0, 1]", () => {
    const lights = createLights(MAX, 1920, createRng(2));
    for (let k = 0; k < 200; k++) lights.step(1 / 60, frame(), data, LIGHT_FLOATS);
    const n = lights.step(1 / 60, frame(), data, LIGHT_FLOATS);
    expect(n).toBeGreaterThan(30);
    for (let i = 0; i < n; i++) {
      const [x, y, r, a, hue] = data.subarray(i * LIGHT_FLOATS, (i + 1) * LIGHT_FLOATS);
      // Scale 2: within the padded span, in device px.
      expect(Math.abs(x / 2 - 960)).toBeLessThanOrEqual(960 + (r / 2) * SPRITE_PAD + 1e-3);
      expect(Math.abs(y / 2 - 540)).toBeLessThanOrEqual(540 + (r / 2) * SPRITE_PAD + 1e-3);
      expect(r).toBeGreaterThan(0);
      expect(a).toBeGreaterThan(0.002);
      expect(a).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(hue);
    }
  });

  it("fades the starting lights and added ones in over FADE_IN", () => {
    const lights = createLights(MAX, 1920, createRng(3));
    const f = frame({ target: 50, twinkle: 0 });
    const dt = 1 / 60;
    lights.step(dt, f, data, LIGHT_FLOATS);
    expect(lights.life[0]).toBeCloseTo(dt / FADE_IN, 6);
    for (let t = 0; t < FADE_IN; t += dt) lights.step(dt, f, data, LIGHT_FLOATS);
    expect(lights.life[49]).toBe(1);
    f.target = 80;
    // Opacity rises as life squared, so an added light starts out invisible.
    expect(lights.step(dt, f, data, LIGHT_FLOATS)).toBeLessThanOrEqual(50);
    expect(lights.life[60]).toBeCloseTo(dt / FADE_IN, 6);
    expect(lights.live).toBe(80);
  });

  it("fades removed lights out before it stops simulating them", () => {
    const lights = createLights(MAX, 1920, createRng(4));
    const f = frame({ target: 80 });
    for (let k = 0; k < 200; k++) lights.step(1 / 60, f, data, LIGHT_FLOATS);
    f.target = 40;
    lights.step(1 / 60, f, data, LIGHT_FLOATS);
    expect(lights.live).toBe(80);
    expect(lights.life[60]).toBeGreaterThan(0.9);
    for (let k = 0; k < 60; k++) lights.step(1 / 60, f, data, LIGHT_FLOATS);
    expect(lights.live).toBe(40);
  });

  it("rescales x positions with the screen width", () => {
    const lights = createLights(MAX, 1920, createRng(5));
    const xs = lights.xs.slice();
    lights.rescaleX(0.5);
    expect(lights.xs[7]).toBeCloseTo(xs[7] * 0.5, 4);
  });
});
