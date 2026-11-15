import { describe, expect, it } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { createScope } from "./gl";
import {
  type AutoRangeOptions,
  type AxisRange,
  autoRange,
  CHART_STRIDE,
  type ChartMesh,
  type ChartRenderer,
  createAxisRange,
  createChartMesh,
  createChartRenderer,
  createStepSlide,
  createTicks,
  formatCompact,
  formatFixed,
  formatPercent,
  formatSigned,
  formatTickCompact,
  kickSlide,
  minTweenSeconds,
  niceStep,
  niceTicks,
  priceDecimals,
  pushArc,
  pushArea,
  pushQuad,
  pushCandle,
  pushLine,
  pushPolyline,
  pushRect,
  pushRoundRect,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  COVER_MAX_TICKS,
  COVER_MIN_TICKS,
  coverTicks,
  rangeShiftPx,
  settleSlide,
  snapAxis,
  type StepSlide,
  stepAxis,
  stepDecimals,
  stepSlide,
  tickAt,
  type Ticks,
  tweenAxis,
  tweenPeakPxPerFrame,
  valueY,
} from "./charts";
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME } from "./motion-limits";

describe("niceStep", () => {
  it.each([
    [10, 5, 2],
    [1, 4, 0.25],
    [0.3, 3, 0.1],
    [97, 6, 20],
    [1234, 5, 250],
    [0.004, 4, 0.001],
  ])("divides %d into at most %d steps with %d", (span, steps, want) => {
    const s = niceStep(span, steps);
    expect(s).toBeCloseTo(want, 12);
    expect(span / s).toBeLessThanOrEqual(steps + 1e-9);
  });

  it("returns 1 for an empty or invalid span", () => {
    expect(niceStep(0, 5)).toBe(1);
    expect(niceStep(Number.NaN, 5)).toBe(1);
    expect(niceStep(-3, 5)).toBe(1);
  });
});

describe("stepDecimals", () => {
  it.each([
    [1, 0],
    [20, 0],
    [2.5, 1],
    [0.25, 2],
    [0.05, 2],
    [0.001, 3],
  ])("writes multiples of %d with %d places", (step, want) => {
    expect(stepDecimals(step)).toBe(want);
  });
});

describe("niceTicks", () => {
  it("lists the nice values inside the range", () => {
    const t: Ticks = niceTicks(97.3, 103.1, 5, createTicks());
    expect(t.step).toBe(2);
    expect(t.first).toBe(98);
    expect(t.count).toBe(3);
    expect(tickAt(t, 2)).toBe(102);
    expect(t.decimals).toBe(0);
  });

  it("includes ticks exactly on the ends", () => {
    const t = niceTicks(0, 10, 5, createTicks());
    expect([t.first, t.count]).toEqual([0, 6]);
  });

  it("copes with an empty range", () => {
    expect(niceTicks(5, 5, 5, createTicks()).count).toBe(1);
    expect(niceTicks(Number.NaN, 5, 5, createTicks()).count).toBe(0);
  });
});

describe("formatters", () => {
  it("groups thousands and fixes decimals", () => {
    expect(formatFixed(1234567.891, 2)).toBe("1,234,567.89");
    expect(formatFixed(-0.001, 2)).toBe("0.00");
    expect(formatFixed(-12.5, 1)).toBe("-12.5");
    expect(formatFixed(Number.NaN, 2)).toBe("-");
  });

  it("signs changes", () => {
    expect(formatSigned(1.25, 2)).toBe("+1.25");
    expect(formatSigned(-0.4, 2)).toBe("-0.40");
    expect(formatSigned(0, 2)).toBe("0.00");
    expect(formatPercent(0.0123)).toBe("+1.23%");
  });

  it("compacts counts", () => {
    expect(formatCompact(950)).toBe("950");
    expect(formatCompact(12_400)).toBe("12.4K");
    expect(formatCompact(3_210_000)).toBe("3.21M");
    expect(formatCompact(999_999)).toBe("1.00M");
    expect(formatCompact(1.05e9)).toBe("1.05B");
    expect(formatCompact(999.4)).toBe("999");
    expect(formatCompact(999.5)).toBe("1.00K");
    expect(formatCompact(999.99)).toBe("1.00K");
    expect(formatCompact(-999.7)).toBe("-1.00K");
    expect(formatCompact(-0.3)).toBe("0");
    expect(formatCompact(-0.6)).toBe("-1");
  });

  it("shows more decimals for pennies", () => {
    expect(priceDecimals(123)).toBe(2);
    expect(priceDecimals(0.5)).toBe(3);
    expect(priceDecimals(0.05)).toBe(4);
  });
});

describe("coverTicks", () => {
  /** A deterministic spread of ranges: every size from tiny to huge, either side of zero. */
  const ranges: [number, number][] = [];
  for (let e = -7; e <= 9; e++) {
    for (const f of [1, 1.3, 2.7, 4.9, 7.7]) {
      const span = f * 10 ** e;
      for (const centre of [0, span * 0.3, -span * 2.2, span * 17, -span * 400]) {
        ranges.push([centre - span / 2, centre + span / 2]);
      }
    }
  }

  it("covers every range with 4 to 7 ticks", () => {
    const t = createTicks();
    for (const [lo, hi] of ranges) {
      coverTicks(lo, hi, t);
      const last = tickAt(t, t.count - 1);
      const span = hi - lo;
      expect(t.count).toBeGreaterThanOrEqual(COVER_MIN_TICKS);
      expect(t.count).toBeLessThanOrEqual(COVER_MAX_TICKS);
      expect(t.first).toBeLessThanOrEqual(lo + span * 1e-6);
      expect(last).toBeGreaterThanOrEqual(hi - span * 1e-6);
      // Not wastefully loose: the ticks span at most a few times the range.
      expect(last - t.first).toBeLessThanOrEqual(span * 3);
      // Every step is 1, 2, 2.5 or 5 times a power of ten.
      const m = t.step / 10 ** Math.floor(Math.log10(t.step) + 1e-9);
      expect([1, 2, 2.5, 5].some((n) => Math.abs(m - n) < 1e-6)).toBe(true);
    }
  });

  it("ends a zero-based range on a nice value", () => {
    const t = coverTicks(0, 87, createTicks());
    expect(t.first).toBe(0);
    expect(tickAt(t, t.count - 1)).toBe(100);
    const n = coverTicks(-0.0042, 0.0013, createTicks());
    expect(n.first).toBeCloseTo(-0.005, 12);
    expect(n.decimals).toBeGreaterThanOrEqual(3);
  });

  it("widens an empty range, and gives nothing for an invalid one", () => {
    const t = coverTicks(5, 5, createTicks());
    expect(t.first).toBeLessThan(5);
    expect(tickAt(t, t.count - 1)).toBeGreaterThan(5);
    expect(coverTicks(0, 0, createTicks()).count).toBeGreaterThanOrEqual(COVER_MIN_TICKS);
    expect(coverTicks(Number.NaN, 1, createTicks()).count).toBe(0);
  });
});

describe("formatTickCompact", () => {
  it("puts every tick on one unit with the step's decimals", () => {
    expect(formatTickCompact(0, 500, 3000)).toBe("0");
    expect(formatTickCompact(500, 500, 3000)).toBe("0.5K");
    expect(formatTickCompact(3000, 500, 3000)).toBe("3.0K");
    expect(formatTickCompact(2_500_000, 500_000, 3_000_000)).toBe("2.5M");
    expect(formatTickCompact(40, 10, 60)).toBe("40");
    expect(formatTickCompact(0.25, 0.05, 0.4)).toBe("0.25");
    expect(formatTickCompact(-2000, 1000, 4000)).toBe("-2K");
  });
});

describe("step slide", () => {
  it("jumps back by the step and glides to rest", () => {
    const s = createStepSlide(0.6);
    kickSlide(s, 14);
    expect(s.offset).toBe(14);
    let last = 14;
    for (let i = 0; i < 36; i++) {
      const o = stepSlide(s, 1 / 60);
      expect(o).toBeLessThanOrEqual(last);
      last = o;
    }
    expect(stepSlide(s, 1 / 60)).toBe(0);
  });

  it("carries on from mid-glide when kicked again, and settles at once", () => {
    const s: StepSlide = createStepSlide(1);
    kickSlide(s, 10);
    stepSlide(s, 0.5);
    kickSlide(s, 10);
    expect(s.offset).toBeCloseTo(15, 9);
    settleSlide(s);
    expect(stepSlide(s, 0.1)).toBe(0);
  });

  it("peaks at the ease's steepest slope times the average speed", () => {
    const s = createStepSlide(1);
    kickSlide(s, 100);
    let peak = 0;
    let last = s.offset;
    for (let i = 0; i < 1000; i++) {
      const o = stepSlide(s, 0.001);
      peak = Math.max(peak, (last - o) / 0.001);
      last = o;
    }
    expect(peak).toBeCloseTo(EASE_PEAK * 100, 0);
  });
});

describe("motion limits", () => {
  it.each([10, 100, 960])("a move of %d px at its minimum duration peaks at the limit", (px) => {
    const seconds = minTweenSeconds(px);
    expect(tweenPeakPxPerFrame(px, seconds)).toBeCloseTo(MAX_FEATURE_PX_PER_FRAME, 9);
  });
});

describe("axis range", () => {
  const opts: AutoRangeOptions = {
    pad: 0.1,
    edge: 0.05,
    minFill: 0.4,
    minSpan: 0.01,
    minSeconds: 0.6,
  };

  it("snaps on first use, then holds while the data fits", () => {
    const r: AxisRange = createAxisRange();
    expect(autoRange(r, 99, 101, 500, 1, opts)).toBe(true);
    expect(r.lo).toBeCloseTo(98.8, 9);
    expect(r.hi).toBeCloseTo(101.2, 9);
    expect(autoRange(r, 99.5, 100.9, 500, 1, opts)).toBe(false);
  });

  it("rescales smoothly when the data nears an edge", () => {
    const r = createAxisRange();
    autoRange(r, 99, 101, 500, 1, opts);
    expect(autoRange(r, 99, 101.2, 500, 1, opts)).toBe(true);
    expect(r.t).toBe(0);
    const startHi = r.hi;
    stepAxis(r, 0.1);
    expect(r.hi).toBeGreaterThan(startHi);
    expect(r.hi).toBeLessThan(r.toHi);
    for (let i = 0; i < 100; i++) {
      stepAxis(r, 0.1);
    }
    expect(r.hi).toBe(r.toHi);
  });

  it("rescales when the data shrinks well inside the range", () => {
    const r = createAxisRange();
    autoRange(r, 90, 110, 500, 1, opts);
    expect(autoRange(r, 99.9, 100.1, 500, 1, opts)).toBe(true);
  });

  it("keeps every gridline within the codec motion limits", () => {
    const r = createAxisRange();
    autoRange(r, 99, 101, 1000, 1, opts);
    autoRange(r, 80, 130, 1000, 1, opts);
    const shift = rangeShiftPx(r.fromLo, r.fromHi, r.toLo, r.toHi, 1000);
    expect(tweenPeakPxPerFrame(shift, r.seconds)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME + 1e-9,
    );
  });

  it("keeps a span for flat data with no minimum span", () => {
    const r = createAxisRange();
    const flat = { ...opts, minSpan: 0 };
    autoRange(r, 0, 0, 500, 1, flat);
    expect(r.hi).toBeGreaterThan(r.lo);
    expect(Number.isFinite(valueY(0, r, 100, 300))).toBe(true);
    expect(autoRange(r, 0, 0, 500, 1, flat)).toBe(false);
    autoRange(r, 5e6, 5e6, 500, 1, flat);
    expect(r.toHi).toBeGreaterThan(r.toLo);
    expect(autoRange(r, 5e6, 5e6, 500, 1, flat)).toBe(false);
    // An empty range puts every value mid-plot rather than dividing by zero.
    snapAxis(r, 3, 3);
    expect(valueY(3, r, 100, 300)).toBe(200);
  });

  it("maps values to device y", () => {
    const r = createAxisRange();
    snapAxis(r, 0, 10);
    expect(valueY(0, r, 100, 300)).toBe(300);
    expect(valueY(10, r, 100, 300)).toBe(100);
    tweenAxis(r, 0, 20, 0);
    expect(r.hi).toBe(20);
  });
});

describe("mesh", () => {
  const c = [1, 0.5, 0.25];

  it("snaps rects to whole pixels", () => {
    const m: ChartMesh = createChartMesh(64);
    pushRect(m, 10.4, 20.6, 30.2, 20.7, c, 1);
    expect(m.count).toBe(6);
    const xs = [];
    const ys = [];
    for (let i = 0; i < 6; i++) {
      xs.push(m.data[i * CHART_STRIDE]);
      ys.push(m.data[i * CHART_STRIDE + 1]);
    }
    expect(Math.min(...xs)).toBe(10);
    expect(Math.max(...xs)).toBe(30);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(1);
  });

  it("skips empty, invisible and overflowing marks", () => {
    const m = createChartMesh(6);
    pushRect(m, 0, 0, 0, 10, c, 1);
    pushRect(m, 0, 0, 10, 10, c, 0);
    pushLine(m, 0, 0, 0, 0, 2, c, 1);
    expect(m.count).toBe(0);
    pushRect(m, 0, 0, 10, 10, c, 1);
    pushRect(m, 0, 0, 10, 10, c, 1);
    expect(m.count).toBe(6);
  });

  it("writes lines, polylines, areas, candles and arcs with finite vertices", () => {
    const m = createChartMesh(4096);
    pushLine(m, 0, 0, 10, 5, 1.5, c, 1);
    const xs = [0, 10, 20, 30];
    const ys = [5, 0, 8, 8];
    pushPolyline(m, xs, ys, 0, 4, 2, c, 1);
    pushArea(m, xs, ys, 0, 4, 20, c, 0.4, 0);
    pushCandle(m, 50, 9, 1, 10, 20, 5, 25, c, 1);
    pushArc(m, 100, 100, 30, 40, 0, Math.PI, c, 1);
    expect(m.count).toBeGreaterThan(6 + 18 + 18 + 12);
    for (let i = 0; i < m.count * CHART_STRIDE; i++) {
      expect(Number.isFinite(m.data[i])).toBe(true);
    }
  });

  it("draws a filled dot as a fan with no overlap at the centre", () => {
    for (const r0 of [-1, 0]) {
      const m = createChartMesh(4096);
      pushArc(m, 50, 50, r0, 10, 0, 2 * Math.PI, c, 0.5);
      expect(m.count % 3).toBe(0);
      const at = (v: number, k: number) => m.data[v * CHART_STRIDE + k] ?? Number.NaN;
      let area = 0;
      let reach = 0;
      for (let v = 0; v < m.count; v += 3) {
        const [x0, y0, x1, y1, x2, y2] = [0, 1, 2].flatMap((k) => [at(v + k, 0), at(v + k, 1)]);
        area += Math.abs((x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)) / 2;
        for (let k = 0; k < 3; k++) {
          reach = Math.max(reach, Math.hypot(at(v + k, 0) - 50, at(v + k, 1) - 50));
        }
      }
      // The triangles tile the outer polygon (to float32 precision): none doubles up.
      const segments = m.count / 3;
      const polygon = (segments / 2) * reach * reach * Math.sin((2 * Math.PI) / segments);
      expect(area).toBeCloseTo(polygon, 2);
      // The centre vertices carry the cover the centre has: over 1 (full) for the dot trick.
      const centre = [];
      for (let v = 0; v < m.count; v++) {
        if (at(v, 0) === 50 && at(v, 1) === 50) {
          centre.push(at(v, 3) + 0.5 - Math.abs(at(v, 2)));
        }
      }
      expect(centre).toHaveLength(segments);
      expect(Math.min(...centre)).toBeCloseTo(0.5 - r0, 5);
    }
  });

  it("keeps a polyline's width through a bend", () => {
    const m = createChartMesh(64);
    pushPolyline(m, [0, 10, 20], [0, 0, 10], 0, 3, 2, c, 1);
    // The middle point's offsets: second quad's first two corners.
    const o = 6 * CHART_STRIDE;
    const ex = m.data[o] - 10;
    const ey = m.data[o + 1];
    expect(Math.hypot(ex, ey)).toBeGreaterThan(2);
  });

  it("draws repeated polyline points as if they were one", () => {
    const plain = createChartMesh(64);
    pushPolyline(plain, [0, 10, 20], [0, 0, 10], 0, 3, 2, c, 1);
    for (const [xs, ys] of [
      [
        [0, 10, 10, 20],
        [0, 0, 0, 10],
      ],
      [
        [0, 0, 10, 10, 10, 20, 20],
        [0, 0, 0, 0, 0, 10, 10],
      ],
    ]) {
      const m = createChartMesh(64);
      pushPolyline(m, xs, ys, 0, xs.length, 2, c, 1);
      expect(m.count).toBe(plain.count);
      expect(m.data).toEqual(plain.data);
    }
  });

  it("starts arcs at twelve o'clock and runs clockwise", () => {
    const m = createChartMesh(4096);
    pushArc(m, 0, 0, 9, 11, 0, Math.PI / 2, c, 1);
    // The first vertex is the outer edge at the start angle: straight up (y negative).
    expect(m.data[0]).toBeCloseTo(0, 9);
    expect(m.data[1]).toBeCloseTo(-12, 9);
    // The last outer vertex is at three o'clock.
    const last = (m.count - 3) * CHART_STRIDE;
    expect(m.data[last]).toBeCloseTo(12, 9);
    expect(m.data[last + 1]).toBeCloseTo(0, 9);
  });
});

describe("pushQuad", () => {
  const c = [1, 0, 0];

  it("writes two solid triangles through the four corners in order", () => {
    const m = createChartMesh(16);
    pushQuad(m, 0, 10, 10, 0, 20, 0, 10, 10, c, 0.5);
    expect(m.count).toBe(6);
    const corners = Array.from({ length: 6 }, (_, i) => [
      m.data[i * CHART_STRIDE],
      m.data[i * CHART_STRIDE + 1],
    ]);
    expect(corners).toEqual([
      [0, 10],
      [10, 0],
      [20, 0],
      [0, 10],
      [20, 0],
      [10, 10],
    ]);
    expect(m.data[7]).toBe(0.5);
  });

  it("skips invisible, non-finite and overflowing quads", () => {
    const m = createChartMesh(8);
    pushQuad(m, 0, 0, 1, 0, 1, 1, 0, 1, c, 0);
    pushQuad(m, 0, 0, Number.NaN, 0, 1, 1, 0, 1, c, 1);
    expect(m.count).toBe(0);
    pushQuad(m, 0, 0, 1, 0, 1, 1, 0, 1, c, 1);
    pushQuad(m, 0, 0, 1, 0, 1, 1, 0, 1, c, 1);
    expect(m.count).toBe(6);
  });
});

describe("pushRoundRect", () => {
  const c = [1, 1, 1];
  /** Sum of the mesh's triangle areas. */
  const area = (m: ChartMesh) => {
    let sum = 0;
    for (let i = 0; i < m.count; i += 3) {
      const o = i * CHART_STRIDE;
      const d = m.data;
      const ax = d[o + CHART_STRIDE] - d[o];
      const ay = d[o + CHART_STRIDE + 1] - d[o + 1];
      const bx = d[o + 2 * CHART_STRIDE] - d[o];
      const by = d[o + 2 * CHART_STRIDE + 1] - d[o + 1];
      sum += Math.abs(ax * by - ay * bx) / 2;
    }
    return sum;
  };

  it("cuts the corners to quarter circles, with a pixel of fringe", () => {
    const m = createChartMesh(1024);
    pushRoundRect(m, 0, 0, 100, 60, 10, c, 1);
    // The rect less four corner squares, plus four quarter discs of radius 10..11.
    const a = area(m);
    expect(a).toBeGreaterThan(6000 - 400 + Math.PI * 100 * 0.97);
    expect(a).toBeLessThan(6000 - 400 + Math.PI * 121);
    for (let i = 0; i < m.count; i++) {
      const x = m.data[i * CHART_STRIDE];
      const y = m.data[i * CHART_STRIDE + 1];
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(101);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(61);
    }
  });

  it("leaves unflagged corners square", () => {
    const m = createChartMesh(1024);
    pushRoundRect(m, 0, 0, 40, 40, 6, c, 1, CORNER_TOP_LEFT | CORNER_TOP_RIGHT);
    const a = area(m);
    expect(a).toBeGreaterThan(1600 - 72 + Math.PI * 36 * 0.5 * 0.97);
    expect(a).toBeLessThan(1600 - 72 + Math.PI * 49 * 0.5);
  });

  it("draws a plain rect for a tiny radius, and caps the radius at half the side", () => {
    const m = createChartMesh(1024);
    pushRoundRect(m, 0, 0, 10, 10, 0.4, c, 1);
    expect(m.count).toBe(6);
    m.count = 0;
    pushRoundRect(m, 0, 0, 10, 4, 50, c, 1);
    for (let i = 0; i < m.count; i++) {
      expect(m.data[i * CHART_STRIDE + 3]).toBeLessThanOrEqual(1e4);
      expect(Number.isFinite(m.data[i * CHART_STRIDE])).toBe(true);
    }
    // Radius 2: four quarter discs of radius 3 in place of the 2 x 2 corner squares.
    expect(area(m)).toBeLessThan(40 - 16 + Math.PI * 9);
    m.count = 0;
    pushRoundRect(m, 0, 0, 10, 10, 3, c, 0);
    expect(m.count).toBe(0);
  });
});

describe("createChartRenderer", () => {
  it("uploads and draws a range of the mesh, then frees everything", () => {
    const fake = createFakeGl();
    const scope = createScope();
    const chart: ChartRenderer = createChartRenderer(fake.gl, scope, 64);
    pushRect(chart.mesh, 0, 0, 10, 10, [1, 1, 1], 1);
    chart.upload();
    chart.draw(100, 100, 0, chart.mesh.count);
    chart.draw(100, 100, 6, 6);
    expect(fake.draws()).toBe(1);
    scope.dispose();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });
});
