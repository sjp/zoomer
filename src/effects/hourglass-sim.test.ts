import { describe, expect, it } from "vitest";
import {
  bottomSand,
  bulbRadius,
  CAP_END,
  CAP_W,
  createClock,
  createLayout,
  createSandTables,
  discArea,
  FILL_H,
  frameKind,
  FRAMES,
  glassUnit,
  hourglassLayout,
  pileLevel,
  pileVolume,
  planeVolume,
  REACH,
  runSeconds,
  SEAT_Y,
  SETTLE_TIME,
  stepClock,
  streamSpan,
  TABLE_N,
  topLevel,
  topSand,
  topVolume,
  TURN_TIME,
  turnAngle,
  turnBlend,
  turnDirection,
  turnEase,
  turnLevel,
  turnLift,
} from "./hourglass-sim";
import {
  DURATION_RANGE,
  FRAME_OPTIONS,
  hourglassMeta,
  POSITION_OPTIONS,
  SIZE_RANGE,
} from "./hourglass.meta";

const tables = createSandTables();
const ASPECTS = [4 / 3, 16 / 9, 21 / 9];
const POSITIONS = POSITION_OPTIONS.map((o) => o.value);
const SIZES = [SIZE_RANGE[0], 1, SIZE_RANGE[1]];
const DT = 1 / 60;

describe("bulb profile", () => {
  it("narrows to the neck, widens into a bulb and closes in a little at the end", () => {
    expect(bulbRadius(0)).toBeLessThan(0.05);
    expect(bulbRadius(0.65)).toBeGreaterThan(0.4);
    expect(bulbRadius(1)).toBeLessThan(bulbRadius(0.65));
    expect(bulbRadius(1)).toBeLessThan(CAP_W);
  });

  it("discArea covers none, half and all of the disc", () => {
    expect(discArea(1, -2)).toBe(0);
    expect(discArea(1, 0)).toBeCloseTo(Math.PI / 2, 12);
    expect(discArea(1, 2)).toBeCloseTo(Math.PI, 12);
    expect(discArea(2, 0.5) + discArea(2, -0.5)).toBeCloseTo(4 * Math.PI, 12);
  });
});

describe("sand tables", () => {
  it("holds all the sand in the top bulb at FILL_H, with room to spare", () => {
    expect(tables.total).toBeCloseTo(topVolume(FILL_H), 12);
    expect(tables.total).toBeLessThan(topVolume(1));
    expect(tables.top[TABLE_N - 1]).toBe(FILL_H);
    expect(tables.top[0]).toBe(0);
    expect(tables.pile[0]).toBe(0);
    // The full pile stays well below the neck.
    expect(tables.pile[TABLE_N - 1]).toBeGreaterThan(0.3);
    expect(tables.pile[TABLE_N - 1]).toBeLessThan(0.8);
  });

  it("surface heights are monotonic in volume", () => {
    let ok = true;
    for (let i = 1; i < TABLE_N; i++) {
      if (!(tables.top[i] > tables.top[i - 1]) || !(tables.pile[i] > tables.pile[i - 1]))
        ok = false;
    }
    expect(ok).toBe(true);
  });

  it("inverts the volume integrals", () => {
    let worst = 0;
    for (let i = 1; i < 10; i++) {
      const v = (tables.total * i) / 10;
      worst = Math.max(worst, Math.abs(topVolume(topLevel(tables, v)) - v));
      worst = Math.max(worst, Math.abs(pileVolume(pileLevel(tables, v)) - v));
    }
    expect(worst / tables.total).toBeLessThan(2e-3);
  });

  it("the turn's level holds all the sand and moves the sand from the end to the neck", () => {
    let worst = 0;
    for (let i = 0; i <= 8; i++) {
      const a = (Math.PI * i) / 8;
      const v = planeVolume(Math.sin(a), Math.cos(a), turnLevel(tables, a));
      worst = Math.max(worst, Math.abs(v - tables.total));
    }
    expect(worst / tables.total).toBeLessThan(2e-3);
    // Upright: a flat layer at the glass end (y = -1). Turned over: it rests on the neck at FILL_H.
    expect(turnLevel(tables, 0)).toBeLessThan(-0.3);
    expect(turnLevel(tables, Math.PI)).toBeCloseTo(FILL_H, 3);
  });
});

describe("clock", () => {
  it("conserves the sand through a run and empties at the right time", () => {
    const c = createClock(1);
    c.time = 0;
    const run = 30;
    let bad = 0;
    let steps = 0;
    while (c.phase === "run" && steps < 10_000) {
      stepClock(c, DT, run);
      steps++;
      const top = topSand(c, tables);
      const bot = bottomSand(c, tables);
      // The levels each bulb shows hold what the clock says it holds.
      const shown = topVolume(topLevel(tables, top)) + pileVolume(pileLevel(tables, bot));
      if (Math.abs(top + bot - tables.total) > 1e-12) bad++;
      if (Math.abs(shown - tables.total) > 2e-3 * tables.total) bad++;
    }
    expect(bad).toBe(0);
    expect(steps * DT).toBeCloseTo(run, 1);
    expect(c.phase).toBe("settle");
  });

  it("settles, turns, then starts a full run turning the other way", () => {
    const c = createClock(0.001);
    expect(turnDirection(c)).toBe(1);
    stepClock(c, 0.03, 60);
    expect(c.phase).toBe("run");
    stepClock(c, 0.06, 60);
    expect(c.phase).toBe("settle");
    c.time = 0;
    stepClock(c, SETTLE_TIME + 1e-9, 60);
    expect(c.phase).toBe("turn");
    stepClock(c, TURN_TIME / 2, 60);
    expect(turnAngle(c)).toBeCloseTo(Math.PI / 2, 6);
    stepClock(c, TURN_TIME, 60);
    expect(c.phase).toBe("run");
    expect(c.top).toBeLessThan(1);
    expect(c.top).toBeGreaterThan(0.95);
    expect(turnAngle(c)).toBe(0);
    expect(turnDirection(c)).toBe(-1);
  });

  it("survives huge, zero and bad steps", () => {
    const c = createClock();
    stepClock(c, 1e6, 30);
    stepClock(c, Number.NaN, 30);
    stepClock(c, -1, Number.NaN);
    stepClock(c, 0, 30);
    expect(Number.isFinite(c.top) && c.top >= 0 && c.top <= 1).toBe(true);
    expect(Number.isFinite(c.time) && c.time >= 0).toBe(true);
    expect(runSeconds(Number.NaN)).toBe(120);
    expect(runSeconds(1)).toBe(DURATION_RANGE[0]);
    expect(runSeconds(1e9)).toBe(DURATION_RANGE[1]);
  });

  it("the turnover curve is continuous, from 0 to PI with zero speed at the ends", () => {
    expect(turnEase(0)).toBe(0);
    expect(turnEase(1)).toBe(1);
    const c = createClock(0);
    stepClock(c, SETTLE_TIME + 1e-9, 60);
    expect(c.phase).toBe("turn");
    let prev = turnAngle(c);
    let prevLift = turnLift(prev);
    let prevBlend = turnBlend(c);
    let maxJump = 0;
    let monotonic = true;
    for (let i = 0; i < 399; i++) {
      stepClock(c, TURN_TIME / 400, 60);
      const a = turnAngle(c);
      const lift = turnLift(a);
      const blend = turnBlend(c);
      if (a < prev || blend < prevBlend) monotonic = false;
      maxJump = Math.max(
        maxJump,
        Math.abs(a - prev),
        Math.abs(lift - prevLift),
        Math.abs(blend - prevBlend),
      );
      prev = a;
      prevLift = lift;
      prevBlend = blend;
    }
    expect(monotonic).toBe(true);
    expect(maxJump).toBeLessThan(0.02);
    expect(turnEase(0.001)).toBeLessThan(1e-5);
    expect(1 - turnEase(0.999)).toBeLessThan(1e-5);
  });

  it("lifts the hourglass just enough to clear the table at every angle", () => {
    let bad = 0;
    for (let i = 0; i <= 100; i++) {
      const a = (Math.PI * i) / 100;
      const lift = turnLift(a);
      // Lowest corner, measured from the centre at rest.
      const low = Math.abs(Math.sin(a)) * CAP_W + Math.abs(Math.cos(a)) * CAP_END;
      if (lift - low < -CAP_END - 1e-12) bad++;
    }
    expect(bad).toBe(0);
    expect(turnLift(0)).toBe(0);
    expect(Math.abs(turnLift(Math.PI))).toBeLessThan(1e-12);
  });
});

describe("streamSpan", () => {
  it("falls from the neck at a run's start, runs down to the pile, then its tail falls", () => {
    const out = [0, 0];
    const c = createClock(1);
    c.time = 0;
    streamSpan(c, 0.2, out);
    expect(out).toEqual([0, 0]);
    c.time = 0.1;
    streamSpan(c, 0.2, out);
    expect(out[0]).toBe(0);
    expect(out[1]).toBeGreaterThan(0);
    expect(out[1]).toBeLessThan(0.8);
    c.time = 5;
    streamSpan(c, 0.2, out);
    expect(out[1]).toBeCloseTo(0.8, 12);
    c.phase = "settle";
    c.time = 0.1;
    streamSpan(c, 0.2, out);
    expect(out[0]).toBeGreaterThan(0);
    expect(out[1]).toBeCloseTo(0.8, 12);
    c.time = SETTLE_TIME;
    streamSpan(c, 0.5, out);
    expect(out[0]).toBe(out[1]);
    c.phase = "turn";
    streamSpan(c, 0.5, out);
    expect(out[0]).toBe(out[1]);
  });
});

describe("hourglassLayout", () => {
  it("stays in its bottom corner at 4:3, 16:9 and 21:9, at every turn angle", () => {
    const bad: string[] = [];
    for (const aspect of ASPECTS) {
      for (const pos of POSITIONS) {
        for (const size of SIZES) {
          const l = hourglassLayout(aspect, pos, size, createLayout());
          const [x0, y0, x1, y1] = l.box;
          const inner = pos === "left" ? x1 : aspect - x0;
          let ok =
            x0 >= 0 &&
            x1 <= aspect &&
            y0 >= 0 &&
            y1 < 0.5 &&
            inner <= aspect / 3 &&
            l.side === (pos === "left" ? -1 : 1) &&
            Math.abs(l.cy - CAP_END * l.unit - SEAT_Y) < 1e-12;
          // The turning frame's corners stay inside the box.
          for (let i = 0; i <= 32; i++) {
            const a = (Math.PI * i) / 32;
            const cy = l.cy + turnLift(a) * l.unit;
            const ex = (Math.abs(Math.cos(a)) * CAP_W + Math.abs(Math.sin(a)) * CAP_END) * l.unit;
            const ey = (Math.abs(Math.sin(a)) * CAP_W + Math.abs(Math.cos(a)) * CAP_END) * l.unit;
            if (l.cx - ex < x0 || l.cx + ex > x1 || cy - ey < y0 || cy + ey > y1) ok = false;
          }
          if (!ok) bad.push(`${aspect} ${pos} ${size}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("mirrors left and right, scales with size and survives bad input", () => {
    const aspect = 16 / 9;
    const l = hourglassLayout(aspect, "left", 1, createLayout());
    const r = hourglassLayout(aspect, "right", 1, createLayout());
    expect(l.cx).toBeCloseTo(aspect - r.cx, 12);
    expect(l.box[0]).toBeCloseTo(aspect - r.box[2], 12);
    expect(glassUnit(SIZE_RANGE[1])).toBeGreaterThan(glassUnit(SIZE_RANGE[0]));
    expect(glassUnit(Number.NaN)).toBe(glassUnit(1));
    const odd = hourglassLayout(Number.NaN, "nope", Number.NaN, createLayout());
    expect(odd.side).toBe(1);
    expect(odd.box.every(Number.isFinite)).toBe(true);
    expect(REACH).toBeGreaterThan(CAP_END);
  });
});

describe("meta", () => {
  it("maps every frame option and falls back to walnut", () => {
    for (const o of FRAME_OPTIONS) expect(frameKind(o.value)).toBe(FRAMES[o.value]);
    expect(frameKind("plastic")).toBe(FRAMES.walnut);
    expect(frameKind("constructor")).toBe(FRAMES.walnut);
  });

  it("has defaults inside its ranges", () => {
    const p = hourglassMeta.params;
    expect(p.duration.default).toBeGreaterThanOrEqual(DURATION_RANGE[0]);
    expect(p.duration.default).toBeLessThanOrEqual(DURATION_RANGE[1]);
    expect(p.size.default).toBeGreaterThanOrEqual(SIZE_RANGE[0]);
    expect(p.size.default).toBeLessThanOrEqual(SIZE_RANGE[1]);
  });
});
