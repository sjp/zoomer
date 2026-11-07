import { describe, expect, it } from "vitest";
import { createRng } from "../noise";
import { STREAK_FLOATS } from "../streaks";
import { createStarfield, EDGE_FAR, FADE_IN, NEAR_Z, type StarFrame } from "./warp-sim";

const MAX = 500;
const frame = (over: Partial<StarFrame> = {}): StarFrame => ({
  width: 1920,
  height: 1080,
  scale: 1,
  speed: 3,
  count: 300,
  streak: 0.35,
  size: 2,
  tintAmount: 0.5,
  star: [1, 1, 1],
  tint: [0.5, 0.7, 1],
  ...over,
});

describe("createStarfield", () => {
  const data = new Float32Array(MAX * STREAK_FLOATS);

  it("draws streaks pointing away from the centre, within the screen margin", () => {
    const stars = createStarfield(MAX, createRng(1));
    const f = frame();
    const bad: string[] = [];
    let drawn = 0;
    for (let k = 0; k < 300; k++) {
      const n = stars.step(1 / 60, f, data);
      expect(n).toBeLessThanOrEqual(300);
      drawn += n;
      for (let i = 0; i < n; i++) {
        const [tx, ty, hx, hy, r, g, b, hw] = data.subarray(
          i * STREAK_FLOATS,
          (i + 1) * STREAK_FLOATS,
        );
        // The tail lies between the centre and the head.
        if (Math.hypot(tx - 960, ty - 540) > Math.hypot(hx - 960, hy - 540) + 1e-3) {
          bad.push(`tail outside head ${String(i)}`);
        }
        if (hx < -50 || hx > 1970 || hy < -50 || hy > 1130) {
          bad.push(`head off screen ${String(i)}`);
        }
        if ([r, g, b].some((c) => c < 0 || c > 1)) {
          bad.push(`colour ${String(r)},${String(g)},${String(b)}`);
        }
        if (hw < 0.25) {
          bad.push(`half width ${String(hw)}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(drawn).toBeGreaterThan(300 * 200);
  });

  it("keeps every star between the camera and the back", () => {
    const stars = createStarfield(MAX, createRng(2));
    const f = frame({ speed: 10 });
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 600; k++) {
      stars.step(0.1, f, data);
      for (let i = 0; i < stars.live; i++) {
        lo = Math.min(lo, stars.zs[i]);
        hi = Math.max(hi, stars.zs[i]);
      }
    }
    expect(lo).toBeGreaterThan(NEAR_Z);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("stands still at speed 0", () => {
    const stars = createStarfield(MAX, createRng(3));
    const f = frame({ speed: 0 });
    stars.step(1 / 60, f, data);
    const zs = stars.zs.slice();
    for (let k = 0; k < 30; k++) {
      stars.step(1 / 60, f, data);
    }
    expect(stars.zs).toEqual(zs);
  });

  it("fades added stars in and removed ones out", () => {
    const stars = createStarfield(MAX, createRng(4));
    stars.step(1 / 60, frame({ count: 100 }), data);
    // The starting stars fade in too, from life 0.
    for (let k = 0; k < 60; k++) {
      stars.step(1 / 60, frame({ count: 100 }), data);
    }
    expect(stars.life[0]).toBe(1);
    stars.step(1 / 60, frame({ count: 200 }), data);
    expect(stars.life[150]).toBeCloseTo(1 / 60 / FADE_IN, 6);
    expect(stars.live).toBe(200);
    for (let k = 0; k < 60; k++) {
      stars.step(1 / 60, frame({ count: 200 }), data);
    }
    expect(stars.life[150]).toBe(1);
    stars.step(1 / 60, frame({ count: 100 }), data);
    expect(stars.live).toBe(200);
    expect(stars.life[150]).toBeLessThan(1);
    expect(stars.life[150]).toBeGreaterThan(0.9);
    for (let k = 0; k < 60; k++) {
      stars.step(1 / 60, frame({ count: 100 }), data);
    }
    expect(stars.live).toBe(100);
  });

  it("caps the count at its capacity", () => {
    const stars = createStarfield(MAX, createRng(5));
    stars.step(1 / 60, frame({ count: 10_000 }), data);
    expect(stars.live).toBe(MAX);
  });

  describe("backwards", () => {
    it("draws receding stars drifting in towards the centre, never past the back", () => {
      const stars = createStarfield(MAX, createRng(6));
      const f = frame({ speed: -0.5, streak: 0 });
      const xs = new Float64Array(MAX);
      const ys = new Float64Array(MAX);
      const zs = new Float64Array(MAX);
      const bad: string[] = [];
      let drawn = 0;
      for (let k = 0; k < 2000; k++) {
        for (let i = 0; i < MAX; i++) {
          xs[i] = stars.xs[i];
          ys[i] = stars.ys[i];
          zs[i] = stars.zs[i];
        }
        drawn += stars.step(1 / 30, f, data);
        for (let i = 0; i < stars.live; i++) {
          const z = stars.zs[i];
          if (!(z > NEAR_Z && z <= 1)) {
            bad.push(`depth ${String(z)}`);
          }
          // Unless it just respawned, a star keeps its place and recedes.
          if (stars.xs[i] === xs[i] && stars.ys[i] === ys[i] && !(z > zs[i])) {
            bad.push(`not receding ${String(i)}`);
          }
        }
      }
      expect(bad).toEqual([]);
      // Once the starting stars have cycled, most are on screen.
      expect(stars.step(1 / 30, f, data)).toBeGreaterThan(250);
      expect(drawn).toBeGreaterThan(2000 * 150);
    });

    it("brings respawned stars in from just outside the edge", () => {
      const stars = createStarfield(MAX, createRng(7));
      const f = frame({ speed: -2, streak: 0 });
      const zs = new Float64Array(MAX);
      let respawned = 0;
      const bad: string[] = [];
      for (let k = 0; k < 600; k++) {
        zs.set(stars.zs);
        stars.step(1 / 30, f, data);
        for (let i = 0; i < stars.live; i++) {
          if (stars.zs[i] >= zs[i]) {
            continue;
          }
          respawned++;
          const hx = 960 + (stars.xs[i] * 960) / stars.zs[i];
          const hy = 540 + (stars.ys[i] * 960) / stars.zs[i];
          const outside = hx < 1 || hx > 1919 || hy < 1 || hy > 1079;
          const near = hx > -50 && hx < 1970 && hy > -50 && hy < 1130;
          if (stars.zs[i] > EDGE_FAR || !outside || !near) {
            bad.push(`${String(hx)},${String(hy)} at ${String(stars.zs[i])}`);
          }
        }
      }
      expect(bad).toEqual([]);
      expect(respawned).toBeGreaterThan(100);
    });
  });
});
