import { describe, expect, it } from "vitest";
import {
  AMBIENT,
  BRIGHT_RANGE,
  createCandleLayout,
  createFlameMotion,
  draftAt,
  FLAME_L,
  flameAt,
  flameBaseY,
  layoutCandles,
  LIGHT_TINT,
  lightAt,
  lightGain,
  REF_HEIGHT,
  SWAY_RANGE,
  TARGET_PEAK,
} from "./candle-sim";
import { createNoise } from "../noise";
import { LAYOUT_OPTIONS, MAX_CANDLES } from "./candlelight.meta";

const WIDTHS = [1440, 1920, 2520];

describe("layoutCandles", () => {
  it("keeps candles apart, inside the frame and out of the centre third", () => {
    for (const w of WIDTHS) {
      for (const { value } of LAYOUT_OPTIONS) {
        for (let n = 1; n <= MAX_CANDLES; n++) {
          const l = layoutCandles(createCandleLayout(), value, n, w);
          expect(l.count).toBe(n);
          const spans: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const lo = l.x[i] - l.halfW[i];
            const hi = l.x[i] + l.halfW[i];
            expect(lo).toBeGreaterThan(0);
            expect(hi).toBeLessThan(w);
            expect(hi <= w / 3 || lo >= (2 * w) / 3).toBe(true);
            expect(l.halfW[i]).toBeGreaterThan(5);
            expect(l.baseY[i]).toBeGreaterThan(0);
            // The flame, even stretched, stays well inside the frame.
            expect(flameBaseY(l, i) + FLAME_L * 1.3).toBeLessThan(REF_HEIGHT * 0.6);
            spans.push([lo, hi]);
          }
          spans.sort((a, b) => a[0] - b[0]);
          for (let i = 1; i < spans.length; i++) {
            expect(spans[i][0]).toBeGreaterThan(spans[i - 1][1]);
          }
        }
      }
    }
  });

  it("puts left and right layouts in one corner and splits both sides", () => {
    const w = 1920;
    const left = layoutCandles(createCandleLayout(), "left", 5, w);
    const right = layoutCandles(createCandleLayout(), "right", 5, w);
    const both = layoutCandles(createCandleLayout(), "both", 5, w);
    for (let i = 0; i < 5; i++) {
      expect(left.x[i]).toBeLessThan(w / 3);
      expect(right.x[i]).toBeGreaterThan((2 * w) / 3);
    }
    const leftCount = Array.from(both.x.subarray(0, 5)).filter((x) => x < w / 2).length;
    expect(leftCount).toBe(2);
  });

  it("is deterministic and falls back to the first layout for unknown ids", () => {
    const a = layoutCandles(createCandleLayout(), "both", 4, 1920);
    const b = layoutCandles(createCandleLayout(), "both", 4, 1920);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    const unknown = layoutCandles(createCandleLayout(), "nope", 4, 1920);
    const first = layoutCandles(createCandleLayout(), LAYOUT_OPTIONS[0].value, 4, 1920);
    expect(Array.from(unknown.x)).toEqual(Array.from(first.x));
  });

  it("clamps the count", () => {
    expect(layoutCandles(createCandleLayout(), "row", 0, 1920).count).toBe(1);
    expect(layoutCandles(createCandleLayout(), "row", 99, 1920).count).toBe(MAX_CANDLES);
  });
});

describe("flame motion", () => {
  const noise = createNoise(0xca4d1e);
  const DT = 1 / 120;
  const T = 120;

  /** Samples one flame's curves for `T` seconds at full flicker and draft. */
  const sample = (i: number) => {
    const m = createFlameMotion();
    const sway: number[] = [];
    const bright: number[] = [];
    const stretch: number[] = [];
    const lean: number[] = [];
    for (let t = 0; t < T; t += DT) {
      const l = draftAt(noise, t, 1);
      flameAt(noise, i, t, 1, l, m);
      sway.push(m.sway[i]);
      bright.push(m.bright[i]);
      stretch.push(m.stretch[i]);
      lean.push(l);
    }
    return { sway, bright, stretch, lean };
  };

  /** Largest |dv/dt| over the samples. */
  const maxRate = (v: number[]) => {
    let r = 0;
    for (let k = 1; k < v.length; k++) {
      r = Math.max(r, Math.abs(v[k] - v[k - 1]) / DT);
    }
    return r;
  };

  /** Mean-crossing rate in Hz: a sine of frequency f crosses its mean 2f times a second. */
  const crossingHz = (v: number[]) => {
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    let crossings = 0;
    for (let k = 1; k < v.length; k++) {
      if (v[k] - mean > 0 !== v[k - 1] - mean > 0) {
        crossings++;
      }
    }
    return crossings / (2 * T);
  };

  it("stays bounded", () => {
    for (let i = 0; i < MAX_CANDLES; i++) {
      const { sway, bright, stretch, lean } = sample(i);
      const absMax = (v: number[], c = 0) => Math.max(...v.map((x) => Math.abs(x - c)));
      expect(absMax(sway)).toBeLessThanOrEqual(SWAY_RANGE);
      expect(absMax(bright, 1)).toBeLessThanOrEqual(BRIGHT_RANGE);
      expect(Math.min(...stretch)).toBeGreaterThan(0.9);
      expect(Math.max(...stretch)).toBeLessThan(1.25);
      expect(absMax(lean)).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous and stays below the 2 Hz flicker cap", () => {
    const cap = 2 * Math.PI * 2;
    for (let i = 0; i < MAX_CANDLES; i++) {
      const { sway, bright, stretch, lean } = sample(i);
      // A sine of amplitude A below 2 Hz changes no faster than 2 pi 2 A per second.
      expect(maxRate(bright)).toBeLessThan(cap * BRIGHT_RANGE);
      expect(maxRate(sway)).toBeLessThan(cap * SWAY_RANGE);
      expect(maxRate(stretch)).toBeLessThan(cap * 0.2);
      expect(maxRate(lean)).toBeLessThan(cap);
      expect(crossingHz(bright)).toBeLessThan(2);
      expect(crossingHz(sway)).toBeLessThan(2);
    }
  });

  it("does not flicker at a flicker of 0 without a draft", () => {
    const m = createFlameMotion();
    for (let t = 0; t < 30; t += 0.37) {
      expect(draftAt(noise, t, 0)).toBe(0);
      flameAt(noise, 2, t, 0, 0, m);
      expect(m.bright[2]).toBe(1);
      expect(m.stretch[2]).toBe(1);
    }
  });

  it("leans now and then in a draft, more often with more draft", () => {
    const leaning = (draft: number) => {
      let k = 0;
      for (let t = 0; t < 2000; t += 0.5) {
        if (Math.abs(draftAt(noise, t, draft)) > 0.5) {
          k++;
        }
      }
      return k;
    };
    const some = leaning(0.3);
    expect(some).toBeGreaterThan(0);
    expect(some).toBeLessThan(4000 * 0.5);
    expect(leaning(1)).toBeGreaterThan(some);
  });
});

describe("lighting", () => {
  it("peaks at the target for every layout and count, so it never clips", () => {
    for (const w of WIDTHS) {
      for (const { value } of LAYOUT_OPTIONS) {
        for (let n = 1; n <= MAX_CANDLES; n++) {
          const l = layoutCandles(createCandleLayout(), value, n, w);
          const gain = lightGain(l);
          let peak = 0;
          for (let y = 0; y <= REF_HEIGHT; y += 8) {
            for (let x = 0; x <= w; x += 8) {
              peak = Math.max(peak, lightAt(l, x, y) * gain);
            }
          }
          expect(peak).toBeGreaterThan(TARGET_PEAK * 0.97);
          expect(peak).toBeLessThan(TARGET_PEAK * 1.03);
        }
      }
    }
  });

  it("keeps the default wall below white at the brightest flicker", () => {
    // Default wall #3a2a22, every flame at its brightest.
    const wall = [0x3a / 255, 0x2a / 255, 0x22 / 255];
    const peak = TARGET_PEAK * 1.03 * (1 + BRIGHT_RANGE);
    for (let c = 0; c < 3; c++) {
      expect(wall[c] * (AMBIENT + LIGHT_TINT[c] * peak)).toBeLessThan(0.9);
    }
  });
});
