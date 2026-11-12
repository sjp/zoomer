import { describe, expect, it } from "vitest";
import { ECHO_SIM_RATE, echoSteps, MIN_ECHO_STEPS } from "../echo-lines";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import { defaults } from "../params";
import { STREAK_FLOATS } from "../streaks";
import type { ParamValues } from "../types";
import {
  bezierPieces,
  createBeziers,
  MAX_PIECES,
  MAX_STREAKS,
  POINTS,
  SPEED_UNIT,
} from "./beziers-sim";
import { beziersMeta, MAX_CURVES, MAX_SEGMENTS, MAX_SPEED, MAX_TRAIL } from "./beziers.meta";

type Params = ParamValues<typeof beziersMeta.params>;
const params = (over: Partial<Params> = {}): Params => ({
  ...(defaults(beziersMeta.params) as Params),
  ...over,
});

const W = 1920;
const H = 1080;
const out = new Float32Array(MAX_STREAKS * STREAK_FLOATS);

function run(p: Params, frames: number, dt = 1 / 60) {
  const sim = createBeziers();
  for (let k = 0; k < frames; k++) {
    sim.step(dt, p, W / H);
  }
  return sim;
}

function brightest(from: number, to: number) {
  let b = 0;
  for (let i = from; i < to; i++) {
    const o = i * STREAK_FLOATS;
    b = Math.max(b, out[o + 4], out[o + 5], out[o + 6]);
  }
  return b;
}

/** Line pieces drawn as one chain: each piece's start is the previous piece's end. */
function chainBreaks(from: number, to: number) {
  let breaks = 0;
  for (let i = from + 1; i < to; i++) {
    const o = i * STREAK_FLOATS;
    const p = o - STREAK_FLOATS;
    if (Math.hypot(out[o] - out[p + 2], out[o + 1] - out[p + 3]) > 1e-3) {
      breaks++;
    }
  }
  return breaks;
}

describe("bezierPieces", () => {
  it("uses one piece for a straight line and more for tighter curves", () => {
    expect(bezierPieces(0, 0, 10, 0, 20, 0, 30, 0, 0.75)).toBe(1);
    const gentle = bezierPieces(0, 0, 100, 50, 200, 50, 300, 0, 0.75);
    const tight = bezierPieces(0, 0, 400, 400, -400, 400, 0, 0, 0.75);
    expect(gentle).toBeGreaterThan(1);
    expect(tight).toBeGreaterThan(gentle);
    expect(tight).toBeLessThanOrEqual(MAX_PIECES);
    expect(bezierPieces(0, 0, 1e9, 0, -1e9, 1e9, 0, 0, 0.75)).toBe(MAX_PIECES);
    expect(bezierPieces(0, 0, Number.NaN, 0, 0, 0, 0, 0, 0.75)).toBe(1);
  });

  it("keeps the pieces within the tolerance of the curve", () => {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = [0, 0, 160, -80, -50, 190, 130, 100];
    const n = bezierPieces(x0, y0, x1, y1, x2, y2, x3, y3, 0.75);
    const at = (t: number) => {
      const s = 1 - t;
      const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
      return [
        w[0] * x0 + w[1] * x1 + w[2] * x2 + w[3] * x3,
        w[0] * y0 + w[1] * y1 + w[2] * y2 + w[3] * y3,
      ];
    };
    let worst = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = at(i / n);
      const [bx, by] = at((i + 1) / n);
      for (let k = 1; k < 16; k++) {
        const [px, py] = at((i + k / 16) / n);
        // Distance from the curve point to the chord.
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        worst = Math.max(worst, Math.abs((px - ax) * dy - (py - ay) * dx) / len);
      }
    }
    expect(worst).toBeLessThanOrEqual(0.75);
  });
});

describe("createBeziers", () => {
  it("keeps every control point and line inside the canvas for any dt and setting", () => {
    const sim = createBeziers();
    const extremes = params({
      curves: MAX_CURVES,
      segments: MAX_SEGMENTS,
      trail: MAX_TRAIL,
      speed: MAX_SPEED,
      style: "modern",
    });
    let bad = 0;
    let most = 0;
    for (const dt of [0, 1 / 144, 1 / 30, 0.1, 5, 1e4, -1, Number.NaN]) {
      for (let k = 0; k < 12; k++) {
        sim.step(dt, extremes, W / H);
        for (const l of sim.loops) {
          for (let j = 0; j < POINTS; j++) {
            if (!(l.points.x[j] >= 0 && l.points.x[j] <= 1)) {
              bad++;
            }
            if (!(l.points.y[j] >= 0 && l.points.y[j] <= 1)) {
              bad++;
            }
          }
        }
        const n = sim.write(out, W, H, 1);
        most = Math.max(most, n);
        for (let i = 0; i < n; i++) {
          const o = i * STREAK_FLOATS;
          const inside =
            out[o] >= 0 &&
            out[o] <= W &&
            out[o + 2] >= 0 &&
            out[o + 2] <= W &&
            out[o + 1] >= 0 &&
            out[o + 1] <= H &&
            out[o + 3] >= 0 &&
            out[o + 3] <= H;
          if (!inside) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(MAX_STREAKS);
  });

  it("joins the segments end to end into a closed loop", () => {
    for (let segments = 1; segments <= MAX_SEGMENTS; segments++) {
      const sim = run(params({ segments, trail: 0, curves: 1 }), 200);
      const n = sim.write(out, W, H, 1);
      expect(n).toBeGreaterThanOrEqual(segments);
      expect(chainBreaks(0, n)).toBe(0);
      // The last piece ends where the first starts.
      const last = (n - 1) * STREAK_FLOATS;
      expect(Math.hypot(out[last + 2] - out[0], out[last + 3] - out[1])).toBeLessThan(1e-3);
    }
  });

  it("passes through each segment's anchors", () => {
    const sim = run(params({ segments: 3, trail: 0, curves: 1 }), 1);
    const n = sim.write(out, W, H, 1);
    const pts = sim.loops[0].points;
    // Right after a fresh start the newest loop is drawn at the step before the latest.
    const inset = 2;
    const anchors = [0, 3, 6].map((j) => [
      inset + pts.prevX[j] * (W - 2 * inset),
      inset + pts.prevY[j] * (H - 2 * inset),
    ]);
    for (const [ax, ay] of anchors) {
      let hit = false;
      for (let i = 0; i < n; i++) {
        const o = i * STREAK_FLOATS;
        if (Math.hypot(out[o] - ax, out[o + 1] - ay) < 1e-2) {
          hit = true;
        }
      }
      expect(hit).toBe(true);
    }
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

  it("draws the loop and its echoes, with a glow only in Modern", () => {
    const classic = run(params({ trail: 12 }), 10);
    const lines = classic.write(out, W, H, 1);
    expect(lines).toBeGreaterThanOrEqual(13 * 2);
    expect(lines).toBeLessThanOrEqual(13 * 2 * MAX_PIECES);
    const modern = run(params({ trail: 12, style: "modern" }), 10);
    expect(modern.write(out, W, H, 1)).toBe(lines * 2);
  });

  it("keeps echoes in time order", () => {
    const sim = run(params({ trail: MAX_TRAIL }), 600);
    const ring = sim.loops[0].history;
    expect(ring.count).toBe(MAX_TRAIL);
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
    const full = brightest(0, sim.write(out, W, H, 1));
    sim.step(1 / 60, params({ seed: 2 }), W / H);
    const dipping = brightest(0, sim.write(out, W, H, 1));
    expect(dipping).toBeLessThan(full);
    expect(dipping).toBeGreaterThan(full * 0.9);
  });

  it("unfolds a new segment from where the loop closes instead of popping it in", () => {
    const sim = run(params({ segments: 2, trail: 0 }), 120);
    const before = Array.from(out.subarray(0, sim.write(out, W, H, 1) * STREAK_FLOATS));
    sim.step(1e-6, params({ segments: 3, trail: 0 }), W / H);
    const n = sim.write(out, W, H, 1);
    // The new segment's points all start on anchor 0, so the loop still closes and
    // the old closing curve is drawn as before, now partly faded.
    const pts = sim.loops[0].points;
    for (const j of [6, 7, 8]) {
      expect(pts.x[j]).toBe(pts.x[0]);
      expect(pts.y[j]).toBe(pts.y[0]);
    }
    expect(n).toBeGreaterThan(before.length / STREAK_FLOATS);
    // The first segment is unchanged.
    expect(Math.hypot(out[0] - before[0], out[1] - before[1])).toBeLessThan(1e-3);
  });

  it("eases a loop count change instead of popping loops in", () => {
    const sim = run(params({ curves: 1 }), 60);
    const before = sim.write(out, W, H, 1);
    sim.step(1 / 60, params({ curves: 2 }), W / H);
    const after = sim.write(out, W, H, 1);
    expect(after).toBeGreaterThan(before);
    // Classic draws the first loop's lines at full brightness; the new loop's are faint.
    let faint = 0;
    let between = 0;
    for (let i = 0; i < after; i++) {
      const b = brightest(i, i + 1);
      if (b > 0 && b < 0.1) {
        faint++;
      } else if (b < 0.99) {
        between++;
      }
    }
    expect(faint).toBeGreaterThan(0);
    expect(between).toBe(0);
  });
});

describe("motion limits", () => {
  it("keeps every point on the curves under the per-frame limit at the top speed", () => {
    expect(pxPerReferenceFrame(MAX_SPEED * SPEED_UNIT)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
    // Measured: control points move per 1080p30 frame. A point on a curve is a
    // fixed weighted average of its control points, so it moves no faster.
    const sim = createBeziers();
    const p = params({ speed: MAX_SPEED, curves: MAX_CURVES, segments: MAX_SEGMENTS });
    let fastest = 0;
    for (let k = 0; k < 900; k++) {
      sim.step(1 / 30, p, W / H);
      for (const l of sim.loops) {
        const pts = l.points;
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
    const slider = beziersMeta.params.speed;
    for (const v of [slider.min, slider.default, slider.max, 0, 100]) {
      const steps = echoSteps(v * SPEED_UNIT);
      expect(ECHO_SIM_RATE / steps).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      expect(steps).toBeGreaterThanOrEqual(MIN_ECHO_STEPS);
    }
  });
});
