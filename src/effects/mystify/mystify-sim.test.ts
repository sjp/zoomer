import { describe, expect, it } from "vitest";
import { defaults } from "../params";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import { STREAK_FLOATS } from "../streaks";
import type { ParamValues } from "../types";
import {
  createMystify,
  echoSteps,
  MAX_STREAKS,
  MIN_ECHO_STEPS,
  SIM_RATE,
  SPEED_UNIT,
} from "./mystify-sim";
import { MAX_SPEED, MAX_TRAIL, mystifyMeta } from "./mystify.meta";

type Params = ParamValues<typeof mystifyMeta.params>;
const params = (over: Partial<Params> = {}): Params => ({
  ...(defaults(mystifyMeta.params) as Params),
  ...over,
});

const W = 1920;
const H = 1080;
const out = new Float32Array(MAX_STREAKS * STREAK_FLOATS);

function run(p: Params, frames: number, dt = 1 / 60) {
  const sim = createMystify();
  for (let k = 0; k < frames; k++) {
    sim.step(dt, p, W / H);
  }
  return sim;
}

describe("createMystify", () => {
  it("keeps every line inside the canvas for any dt and setting", () => {
    const sim = createMystify();
    const extremes = params({
      shapes: 4,
      points: 8,
      trail: MAX_TRAIL,
      speed: MAX_SPEED,
      mirror: "both",
      style: "modern",
    });
    let bad = 0;
    let most = 0;
    for (const dt of [0, 1 / 144, 1 / 30, 0.1, 5, 1e4, -1, Number.NaN]) {
      for (let k = 0; k < 40; k++) {
        sim.step(dt, extremes, W / H);
        const n = sim.write(out, W, H, 1);
        most = Math.max(most, n);
        for (let i = 0; i < n; i++) {
          const o = i * STREAK_FLOATS;
          for (const [v, max] of [
            [out[o], W],
            [out[o + 1], H],
            [out[o + 2], W],
            [out[o + 3], H],
          ]) {
            if (!(v >= 0 && v <= max)) {
              bad++;
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(MAX_STREAKS);
  });

  it("gives the same motion for the same seed, and different motion for another", () => {
    const frame = (seed: number) => {
      const sim = run(params({ seed }), 300);
      const n = sim.write(out, W, H, 1);
      return Array.from(out.subarray(0, n * STREAK_FLOATS));
    };
    expect(frame(5)).toEqual(frame(5));
    expect(frame(5)).not.toEqual(frame(6));
  });

  it("draws the shapes and their echoes with one line per edge", () => {
    const sim = run(params({ shapes: 2, points: 4, trail: 8 }), 10);
    // Classic: no glow. Two shapes, each the newest outline and eight echoes of four edges.
    expect(sim.write(out, W, H, 1)).toBe(2 * 9 * 4);
  });

  it("keeps echoes in time order, evenly spaced along each corner's path", () => {
    const sim = run(params({ trail: MAX_TRAIL }), 600);
    const shape = sim.shapes[0];
    const ring = shape.history;
    expect(ring.count).toBe(MAX_TRAIL);
    // The hue drifts forwards with time, so older echoes have earlier hues.
    const unwrap = (h: number, ref: number) => h - Math.round(h - ref);
    let prev = ring.data[ring.offset(0) + ring.stride - 1];
    for (let k = 1; k < ring.count; k++) {
      const h = unwrap(ring.data[ring.offset(k) + ring.stride - 1], prev);
      expect(h).toBeLessThan(prev);
      prev = h;
    }
  });

  it("fades a seed change out and back in rather than cutting", () => {
    const sim = run(params({ seed: 1 }), 120);
    const brightest = (n: number) => {
      let b = 0;
      for (let i = 0; i < n; i++) {
        b = Math.max(b, out[i * STREAK_FLOATS + 4], out[i * STREAK_FLOATS + 5]);
        b = Math.max(b, out[i * STREAK_FLOATS + 6]);
      }
      return b;
    };
    const full = brightest(sim.write(out, W, H, 1));
    sim.step(1 / 60, params({ seed: 2 }), W / H);
    const dipping = brightest(sim.write(out, W, H, 1));
    expect(dipping).toBeLessThan(full);
    expect(dipping).toBeGreaterThan(full * 0.9);
  });

  it("splits a new corner off its neighbour instead of popping it in", () => {
    const sim = run(params({ points: 4 }), 120);
    const pts = sim.shapes[0].points;
    sim.step(1 / 60, params({ points: 5 }), W / H);
    // The fifth corner (index 4) starts on the fourth and drifts away at the corners' speed.
    const gap = Math.hypot((pts.x[4] - pts.x[3]) * (W / H), pts.y[4] - pts.y[3]);
    expect(gap).toBeLessThan(2 * MAX_SPEED * SPEED_UNIT * (1 / 60) + 1e-6);
  });

  it("eases a shape count change instead of popping shapes in", () => {
    const sim = run(params({ shapes: 1 }), 60);
    const before = sim.write(out, W, H, 1);
    sim.step(1 / 60, params({ shapes: 2 }), W / H);
    const after = sim.write(out, W, H, 1);
    expect(after).toBe(before * 2);
    // The new shape's lines come after the first shape's, at low brightness.
    let newest = 0;
    for (let i = before; i < after; i++) {
      newest = Math.max(newest, out[i * STREAK_FLOATS + 4], out[i * STREAK_FLOATS + 5]);
      newest = Math.max(newest, out[i * STREAK_FLOATS + 6]);
    }
    expect(newest).toBeGreaterThan(0);
    expect(newest).toBeLessThan(0.1);
  });
});

describe("motion limits", () => {
  it("keeps the fastest corner under the per-frame limit at the top speed", () => {
    expect(pxPerReferenceFrame(MAX_SPEED * SPEED_UNIT)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
    // Measured: corner moves per 1080p30 frame, mirrored or not.
    const sim = createMystify();
    const p = params({ speed: MAX_SPEED, shapes: 4, points: 8, mirror: "both" });
    let fastest = 0;
    for (let k = 0; k < 900; k++) {
      sim.step(1 / 30, p, W / H);
      for (const s of sim.shapes) {
        const pts = s.points;
        for (let j = 0; j < pts.count; j++) {
          const px = Math.hypot((pts.x[j] - pts.prevX[j]) * W, (pts.y[j] - pts.prevY[j]) * H);
          fastest = Math.max(fastest, px);
        }
      }
    }
    // A step is half a frame at 30 fps.
    expect(fastest * 2).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });

  it("spaces echoes so the trail passes a point no faster than the pattern limit", () => {
    const slider = mystifyMeta.params.speed;
    for (const v of [slider.min, slider.default, slider.max, 0, 100]) {
      const steps = echoSteps(v * SPEED_UNIT);
      expect(SIM_RATE / steps).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      expect(steps).toBeGreaterThanOrEqual(MIN_ECHO_STEPS);
    }
  });
});
