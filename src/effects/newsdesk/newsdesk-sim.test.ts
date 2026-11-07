import { describe, expect, it } from "vitest";
import type { Rgb } from "../color";
import {
  barWidth,
  clockText,
  DESIGN_ASPECT,
  deskLayout,
  DUSK_PERIOD,
  DUSK_SUNSET,
  duskCycle,
  duskTarget,
  fitTextSize,
  graphicsLayout,
  litFraction,
  REVEAL_DELAY,
  REVEAL_SECONDS,
  revealShown,
  revealStart,
  skyColours,
  stepReveal,
  stepTicker,
  TICKER_ROW,
  tickerLine,
  tickerOffset,
  tickerSpeed,
  tickerTexel,
  wallEdges,
} from "./newsdesk-sim";

describe("deskLayout", () => {
  for (const aspect of [DESIGN_ASPECT, 4 / 3, 1, 21 / 9]) {
    const l = deskLayout(aspect);
    const half = aspect / 2;

    it(`keeps the set inside a ${aspect.toFixed(2)} frame`, () => {
      expect(l.wallHw).toBeLessThan(half);
      for (const [cx, cy, hw, hh] of [...l.strips, ...l.screens]) {
        expect(Math.abs(cx) + hw).toBeLessThanOrEqual(half);
        expect(Math.abs(cy) + hh).toBeLessThanOrEqual(0.5);
      }
      const [gx, gy, gr] = l.globe;
      expect(Math.abs(gx) + gr).toBeLessThanOrEqual(half);
      expect(gy + gr).toBeLessThanOrEqual(0.5);
    });

    it(`puts the wall behind the anchor's head at ${aspect.toFixed(2)}`, () => {
      // A head-and-shoulders crop: the head within |x| < 0.2 between y -0.1 and 0.35.
      expect(l.wallHw).toBeGreaterThan(0.3);
      expect(l.wallTop).toBeGreaterThan(0.3);
      expect(l.wallBottom).toBeLessThan(-0.1);
      // The screens and globe stand beside the wall, clear of the anchor.
      for (const [cx, , hw] of l.screens) {
        expect(Math.abs(cx) - hw).toBeGreaterThan(l.wallHw);
      }
      expect(Math.abs(l.globe[0]) - l.globe[2]).toBeGreaterThan(l.wallHw);
    });

    it(`keeps the strips clear of the screens and globe at ${aspect.toFixed(2)}`, () => {
      const parts: number[][] = [...l.screens, [l.globe[0], l.globe[1], l.globe[2], l.globe[2]]];
      for (const [sx, , shw] of l.strips) {
        for (const [cx, , hw] of parts) {
          expect(Math.abs(sx - cx)).toBeGreaterThan(hw + shw);
        }
      }
    });
  }

  it("bows the wall: its ends are taller than its middle", () => {
    const l = deskLayout(DESIGN_ASPECT);
    const [top0, bottom0] = wallEdges(l, 0);
    const [top1, bottom1] = wallEdges(l, l.wallHw);
    expect(top1).toBeGreaterThan(top0);
    expect(bottom1).toBeLessThan(bottom0);
    expect(top1).toBeLessThan(0.5);
  });
});

describe("lower third", () => {
  it("fits within the frame, left of the anchor, at 16:9 and narrower", () => {
    for (const aspect of [DESIGN_ASPECT, 4 / 3, 1]) {
      const g = graphicsLayout(aspect);
      expect(g.left).toBeGreaterThan(-aspect / 2);
      expect(g.left + g.maxWidth).toBeLessThanOrEqual(aspect / 2);
      expect(g.bottom).toBeGreaterThan(-0.5 + g.tickerH);
      expect(g.bottom + g.nameH + g.titleH).toBeLessThan(-0.2);
    }
    const wide = graphicsLayout(DESIGN_ASPECT);
    expect(wide.left + wide.maxWidth).toBeLessThan(-0.2);
    expect(graphicsLayout(4 / 3).maxWidth).toBeLessThan(wide.maxWidth);
  });

  it("shrinks long names and titles to fit the bar, and leaves short ones alone", () => {
    const maxSize = 40;
    const maxWidth = 500;
    // A short name: 4 ems at 40 px is 160 px, well inside.
    expect(fitTextSize(4, maxSize, maxWidth)).toBe(maxSize);
    for (const em of [13, 20, 40, 90]) {
      const size = fitTextSize(em, maxSize, maxWidth);
      expect(size).toBeLessThan(maxSize);
      expect(em * size).toBeLessThanOrEqual(maxWidth + 1e-9);
      expect(em * size).toBeCloseTo(maxWidth, 6);
    }
    // Longer text never comes out bigger.
    expect(fitTextSize(30, maxSize, maxWidth)).toBeLessThan(fitTextSize(20, maxSize, maxWidth));
    expect(fitTextSize(0, maxSize, maxWidth)).toBe(maxSize);
  });

  it("sizes the bars to the text, within limits", () => {
    const g = graphicsLayout(DESIGN_ASPECT);
    expect(barWidth(0, g)).toBe(g.minWidth);
    expect(barWidth(0.3, g)).toBeCloseTo(0.3 + 2 * g.pad, 9);
    expect(barWidth(5, g)).toBe(g.maxWidth);
  });

  it("splits ticker stories at wide gaps and joins them with bullets", () => {
    expect(tickerLine("One   Two      Three")).toBe("One   •   Two   •   Three");
    expect(tickerLine("  Just one story  ")).toBe("Just one story");
    expect(tickerLine("     ")).toBe("");
  });
});

describe("ticker", () => {
  it("moves a whole number of pixels per 60 Hz frame, about 60 px/s at 1080p", () => {
    expect(tickerSpeed(1)).toBe(60);
    expect(tickerSpeed(2)).toBe(120);
    expect(tickerSpeed(0.25)).toBe(60);
    for (const scale of [0.5, 0.667, 1, 1.333, 2, 3]) {
      expect(Number.isInteger(tickerSpeed(scale) / 60)).toBe(true);
    }
  });

  it("scales with the speed setting, and stops at 0", () => {
    expect(tickerSpeed(1, 3)).toBe(180);
    expect(tickerSpeed(2, 5)).toBe(600);
    expect(tickerSpeed(0.5, 1)).toBe(60);
    expect(tickerSpeed(1, 0)).toBe(0);
    expect(tickerSpeed(1, Number.NaN)).toBe(60);
    for (const speed of [1, 2, 3, 4, 5]) {
      expect(Number.isInteger(tickerSpeed(1.333, speed) / 60)).toBe(true);
    }
  });

  it("wraps its offset continuously, with no jump", () => {
    for (const period of [97, 1000, 2 * TICKER_ROW + 311]) {
      const speed = tickerSpeed(2);
      const perFrame = speed / 60;
      let pos = period - 3.2 * perFrame;
      let prev = tickerOffset(pos, period);
      let wraps = 0;
      const bad: string[] = [];
      for (let f = 0; f < 3 * period; f++) {
        pos = stepTicker(pos, 1 / 60, speed, period);
        const o = tickerOffset(pos, period);
        if (o < 0 || o >= period || !Number.isInteger(o)) {
          bad.push(`offset ${String(o)} out of range`);
        }
        if (o < prev) {
          wraps++;
        }
        // Every frame moves exactly perFrame texels along the repeating strip.
        const moved = (((o - prev) % period) + period) % period;
        if (moved !== perFrame) {
          bad.push(`frame ${String(f)}: moved ${String(moved)}`);
        }
        prev = o;
      }
      expect(bad.slice(0, 5)).toEqual([]);
      expect(wraps).toBeGreaterThan(0);
    }
  });

  it("shows the same strip texel one pixel along after one pixel of scroll, across the wrap", () => {
    const period = TICKER_ROW + 500;
    for (const offset of [0, period - 1, TICKER_ROW - 1, 1234]) {
      const next = tickerOffset(offset + 1, period);
      for (const x of [0, 1, 777, 3000]) {
        expect(tickerTexel(x, next, period)).toEqual(tickerTexel(x + 1, offset, period));
      }
    }
    // Texels past one row land on the next row.
    expect(tickerTexel(TICKER_ROW + 5, 0, period)).toEqual([5, 1]);
    expect(tickerTexel(period, 0, period)).toEqual([0, 0]);
  });

  it("stays put with no time or a bad period", () => {
    expect(stepTicker(5, 0, 60, 100)).toBe(5);
    expect(stepTicker(5, Number.NaN, 60, 100)).toBe(5);
    expect(stepTicker(5, 1, 60, 0)).toBe(0);
    expect(tickerOffset(99.6, 100)).toBe(0);
  });
});

describe("dusk", () => {
  it("cycles from sunset into night and back, smoothly", () => {
    expect(duskCycle(0)).toBeCloseTo(DUSK_SUNSET, 9);
    expect(duskCycle(330)).toBe(1);
    expect(duskCycle(DUSK_PERIOD)).toBeCloseTo(duskCycle(0), 9);
    let prev = duskCycle(0);
    let biggest = 0;
    for (let t = 0.5; t <= 2 * DUSK_PERIOD; t += 0.5) {
      const e = duskCycle(t);
      expect(e).toBeGreaterThanOrEqual(DUSK_SUNSET - 1e-9);
      expect(e).toBeLessThanOrEqual(1);
      biggest = Math.max(biggest, Math.abs(e - prev));
      prev = e;
    }
    // Never more than a sliver per half second: no visible steps.
    expect(biggest).toBeLessThan(0.005);
  });

  it("holds day and night fixed", () => {
    expect(duskTarget("day", 123)).toBe(0);
    expect(duskTarget("night", 123)).toBe(1);
    expect(duskTarget("cycle", 0)).toBeCloseTo(DUSK_SUNSET, 9);
  });

  it("colours the sky blue by day, orange at sunset and dark at night", () => {
    const z: Rgb = [0, 0, 0];
    const h: Rgb = [0, 0, 0];
    skyColours(0, z, h);
    expect(z[2]).toBeGreaterThan(z[0]);
    expect(h[2]).toBeGreaterThan(h[0]);
    skyColours(0.45, z, h);
    expect(h[0]).toBeGreaterThan(h[2] * 2);
    skyColours(1, z, h);
    expect(Math.max(...z)).toBeLessThan(0.1);
    expect(z[2]).toBeGreaterThan(z[0]);
  });

  it("lights more windows as it gets darker", () => {
    expect(litFraction(0)).toBeLessThan(0.1);
    expect(litFraction(1)).toBeGreaterThan(0.4);
    let prev = 0;
    for (let e = 0; e <= 1; e += 0.05) {
      expect(litFraction(e)).toBeGreaterThanOrEqual(prev);
      prev = litFraction(e);
    }
  });
});

describe("graphics", () => {
  it("waits, then slides in over the reveal time, and fades out when hidden", () => {
    let level = revealStart(REVEAL_DELAY);
    let t = 0;
    while (revealShown(level) === 0 && t < 5) {
      level = stepReveal(level, true, 1 / 60);
      t += 1 / 60;
    }
    expect(t).toBeCloseTo(REVEAL_DELAY, 1);
    while (level < 1 && t < 10) {
      level = stepReveal(level, true, 1 / 60);
      t += 1 / 60;
    }
    expect(t).toBeCloseTo(REVEAL_DELAY + REVEAL_SECONDS, 1);
    // Each frame's change is small: a smooth slide, never a pop.
    let prev = revealShown(level);
    for (let i = 0; i < 120; i++) {
      level = stepReveal(level, false, 1 / 60);
      expect(Math.abs(revealShown(level) - prev)).toBeLessThan(0.05);
      prev = revealShown(level);
    }
    expect(level).toBe(0);
  });

  it("formats the clock", () => {
    expect(clockText(0)).toBe("00:00");
    expect(clockText(0.5)).toBe("12:00");
    expect(clockText((18 * 60 + 7) / 1440 + 1e-6)).toBe("18:07");
    expect(clockText(0.99999)).toBe("23:59");
    expect(clockText(1)).toBe("00:00");
  });
});
