import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import {
  BADGE_BUTTON,
  BADGE_POINTS,
  BADGE_TURNS,
  badgeAngle,
  BLINK_DEPTH,
  BLINK_HZ,
  blinkAlpha,
  BUTTON_LABELS,
  CLEAR_HEIGHT,
  CLEAR_WIDTH,
  COUNTER_DIGITS,
  counterTarget,
  createGeoClock,
  createHitCounter,
  digitOf,
  DIG_PERIOD,
  geoStyle,
  geoTile,
  GLOBE_FPS,
  globeFrame,
  layoutPage,
  MARQUEE_GAP_EM,
  MARQUEE_SPEED,
  marqueeOffset,
  marqueePeriod,
  type MeasureText,
  pageBoxes,
  pageSize,
  type Rect,
  refPerPage,
  ROLL_MAX_RATE,
  stepGeoClock,
  stepHitCounter,
  textEm,
  TICK_MAX,
  TICK_MIN,
  workerFrame,
} from "./geocities-sim";
import { geocitiesMeta, MARQUEE_LENGTH, TITLE_LENGTH } from "./geocities.meta";

/** A fixed-width stand-in for measured text: wide enough for most real faces. */
const fixedWidth: MeasureText = (text, face) =>
  Array.from(text).length * (face === "small" ? 0.5 : 0.6);
const unmeasured: MeasureText = () => undefined;

const ASPECTS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["9:16", 9 / 16],
  ["3:4", 3 / 4],
  ["5:4", 5 / 4],
  ["1:1", 1],
] as const;
const TITLES = [
  ["default", geocitiesMeta.params.text.default],
  ["longest", "W".repeat(TITLE_LENGTH)],
  ["empty", ""],
] as const;
const MEASURES = [
  ["fixed", fixedWidth],
  ["unmeasured", unmeasured],
] as const;

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number) =>
  a.x >= -1e-9 && a.y >= -1e-9 && a.x + a.w <= w + 1e-9 && a.y + a.h <= h + 1e-9;

describe("params", () => {
  it("map unknown values to the defaults", () => {
    expect(geoStyle("crisp")).toBe("crisp");
    expect(geoStyle("nope")).toBe("classic");
    expect(geoTile("paper")).toBe("paper");
    expect(geoTile("nope")).toBe("stars");
  });
});

describe("page layout", () => {
  const cases = ASPECTS.flatMap(([name, aspect]) =>
    TITLES.flatMap(([title, text]) =>
      MEASURES.map(([m, measure]) => [name, title, m, aspect, text, measure] as const),
    ),
  );

  it.each(cases)(
    "leaves the middle clear at %s (%s title, %s)",
    (_, _t, _m, aspect, text, measure) => {
      const layout = layoutPage(aspect, text, measure);
      const { width, height, clear } = layout;
      expect(clear.w).toBeCloseTo(width * CLEAR_WIDTH);
      expect(clear.h).toBeCloseTo(height * CLEAR_HEIGHT);
      for (const box of pageBoxes(layout)) {
        expect(overlaps(box, clear)).toBe(false);
        expect(inside(box, width, height)).toBe(true);
        expect(box.w).toBeGreaterThan(0);
        expect(box.h).toBeGreaterThan(0);
      }
    },
  );

  it.each(cases)(
    "keeps its parts apart at %s (%s title, %s)",
    (_, _t, _m, aspect, text, measure) => {
      const layout = layoutPage(aspect, text, measure);
      const b = layout.badge;
      const badge = { x: b.x - b.r, y: b.y - b.r, w: 2 * b.r, h: 2 * b.r };
      const host = layout.buttons[BADGE_BUTTON];
      const others = pageBoxes(layout).filter(
        (r) => r !== host && !(r.x === badge.x && r.y === badge.y && r.w === badge.w),
      );
      for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++) {
          expect(overlaps(others[i], others[j])).toBe(false);
        }
        // The badge sits on its own button and nothing else.
        expect(overlaps(others[i], badge)).toBe(false);
      }
      expect(overlaps(host, badge)).toBe(true);
    },
  );

  it.each(ASPECTS)("lays the page out wide or tall at %s", (_, aspect) => {
    const layout = layoutPage(aspect, "hi", fixedWidth);
    const [w, h] = pageSize(aspect);
    expect(layout.width).toBeCloseTo(w);
    expect(layout.height).toBeCloseTo(h);
    expect(Math.min(w, h)).toBeCloseTo(600);
    expect(layout.wide).toBe(aspect >= 1.25);
  });

  it.each(ASPECTS)("fits the longest title and labels in their slots at %s", (_, aspect) => {
    const layout = layoutPage(aspect, "W".repeat(TITLE_LENGTH), unmeasured);
    const t = layout.title;
    expect(t.size).toBeGreaterThanOrEqual(12);
    expect(t.x - t.width / 2).toBeGreaterThanOrEqual(layout.globes[0].x + layout.globes[0].w);
    expect(t.x + t.width / 2).toBeLessThanOrEqual(layout.globes[1].x);
    layout.buttons.forEach((b, i) => {
      expect(textEm(BUTTON_LABELS[i], "button", unmeasured) * layout.buttonSize).toBeLessThan(b.w);
    });
    expect(layout.counterLabel.size).toBeGreaterThanOrEqual(6);
    for (const line of layout.footer) {
      expect(line.width).toBeLessThanOrEqual(layout.width - 20 + 1e-9);
    }
  });

  it.each(ASPECTS)("sizes the marquee's text to its band at %s", (_, aspect) => {
    const layout = layoutPage(aspect, "", unmeasured);
    expect(layout.marqueeSize).toBeLessThan(layout.marquee.h);
    expect(layout.marqueeSize).toBeGreaterThan(layout.marquee.h * 0.5);
  });

  it.each([
    ["a tall strip", 60 / 1080],
    ["a thin strip", 1920 / 60],
    ["a square", 1],
    ["nonsense", Number.NaN],
  ])("stays finite for %s", (_, aspect) => {
    const layout = layoutPage(aspect, "Welcome", fixedWidth);
    for (const box of pageBoxes(layout)) {
      expect([box.x, box.y, box.w, box.h].every((v) => Number.isFinite(v))).toBe(true);
    }
  });
});

describe("marquee", () => {
  it.each([0, 1, 10, MARQUEE_LENGTH])(
    "draws %i characters inside one period, so the wrap is seamless",
    (chars) => {
      const size = 30;
      const em = textEm("W".repeat(chars), "marquee", unmeasured);
      const period = marqueePeriod(em, size);
      const start = (MARQUEE_GAP_EM * size) / 2;
      // The text, with an outline of up to a tenth of an em, stays off both ends.
      expect(start - size * 0.1).toBeGreaterThan(0);
      expect(start + em * size + size * 0.1).toBeLessThan(period);
    },
  );

  it.each([
    [100, 0],
    [100, 99.5],
    [437.25, 1e6],
    [1, 12.5],
  ])("scrolls continuously across the wrap (period %d from %d)", (period, distance) => {
    const step = 0.7;
    const a = marqueeOffset(distance, period);
    const b = marqueeOffset(distance + step, period);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(period);
    expect((((b - a) % period) + period) % period).toBeCloseTo(step % period);
  });

  it.each(ASPECTS)("moves within the codec limit at %s", (_, aspect) => {
    const [, h] = pageSize(aspect);
    const refPxPerSecond = MARQUEE_SPEED * refPerPage(h);
    expect(pxPerReferenceFrame(refPxPerSecond / 1080)).toBeLessThanOrEqual(
      MAX_FEATURE_PX_PER_FRAME,
    );
  });
});

describe("animation", () => {
  it("keeps every rate under the pattern limit", () => {
    expect(BLINK_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(BADGE_TURNS * BADGE_POINTS).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(GLOBE_FPS).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(ROLL_MAX_RATE).toBeLessThanOrEqual(MAX_PATTERN_HZ);
  });

  it("blinks softly between on and faded", () => {
    const c = createGeoClock();
    let lo = 1;
    let hi = 0;
    let biggest = 0;
    let last = blinkAlpha(c, 1);
    for (let i = 0; i < 600; i++) {
      stepGeoClock(c, 1 / 60, 1);
      const a = blinkAlpha(c, 1);
      lo = Math.min(lo, a);
      hi = Math.max(hi, a);
      biggest = Math.max(biggest, Math.abs(a - last));
      last = a;
    }
    expect(hi).toBeCloseTo(1);
    expect(lo).toBeCloseTo(1 - BLINK_DEPTH);
    // No hard cut: at most a tenth of the way per 60 Hz frame.
    expect(biggest).toBeLessThan(0.1);
  });

  it("digs every few seconds with a short shovel loop", () => {
    const c = createGeoClock();
    const frames: number[] = [];
    for (let i = 0; i < Math.round(DIG_PERIOD * 20); i++) {
      frames.push(workerFrame(c));
      stepGeoClock(c, 0.05, 1);
    }
    const runs = frames.filter((f, i) => i === 0 || f !== frames[i - 1]);
    expect(runs).toEqual([1, 2, 1, 0]);
  });

  it("gives identical frames over time at motion 0", () => {
    const c = createGeoClock();
    stepGeoClock(c, 3.3, 1);
    const counter = createHitCounter(1337);
    stepHitCounter(counter, 3.3, c.t, 1337);
    const snapshot = () => [
      blinkAlpha(c, 0),
      badgeAngle(c),
      globeFrame(c),
      workerFrame(c),
      marqueeOffset(c.distance, 321),
      ...counter.wheels,
    ];
    const before = snapshot();
    for (let i = 0; i < 2000; i++) {
      stepGeoClock(c, 1 / 30, 0);
      stepHitCounter(counter, 1 / 30, c.t, 1337);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("hit counter", () => {
  it("shows its starting count at once", () => {
    const c = createHitCounter(1337);
    expect(Array.from(c.wheels)).toEqual([0, 0, 0, 1, 3, 3, 7]);
    expect(digitOf(1337, COUNTER_DIGITS - 1)).toBe(7);
  });

  it.each([1337, 9999, 1999999, 9999999])(
    "only ever increases, by one visit at a time, from %i",
    (start) => {
      const c = createHitCounter(start);
      const dt = 1 / 30;
      let t = 0;
      let last = counterTarget(c);
      let lastVisit = 0;
      let fastest = 0;
      const steps: number[] = [];
      const gaps: number[] = [];
      /** Each visit's wheel travel, digits, once it has rolled in. */
      const rolls: number[][] = [];
      let travel = new Float64Array(COUNTER_DIGITS);
      const prev = Float64Array.from(c.wheels);
      for (let i = 0; i < 30 * 60 * 10; i++) {
        t += dt;
        stepHitCounter(c, dt, t, start);
        for (let d = 0; d < COUNTER_DIGITS; d++) {
          // Wheels only roll forward, so the step forward mod 10 is the whole move.
          const moved = (c.wheels[d] - prev[d] + 10) % 10;
          fastest = Math.max(fastest, moved / dt);
          travel[d] += moved;
          prev[d] = c.wheels[d];
        }
        const now = counterTarget(c);
        if (now !== last) {
          steps.push((now - last + 10 ** COUNTER_DIGITS) % 10 ** COUNTER_DIGITS);
          if (lastVisit > 0) {
            gaps.push(t - lastVisit);
            rolls.push(Array.from(travel));
          }
          travel = new Float64Array(COUNTER_DIGITS);
          lastVisit = t;
          last = now;
        }
      }
      expect(steps.length).toBeGreaterThanOrEqual(10);
      expect(steps.length).toBeLessThanOrEqual(30);
      expect(steps.every((s) => s === 1)).toBe(true);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(TICK_MIN - dt);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(TICK_MAX + dt);
      expect(fastest).toBeLessThanOrEqual(ROLL_MAX_RATE + 1e-6);
      // Each visit rolls the last wheel on by exactly one digit, and any carried
      // wheel by one at most.
      for (const roll of rolls) {
        expect(roll[COUNTER_DIGITS - 1]).toBeCloseTo(1);
        expect(roll.every((x) => x <= 1 + 1e-9)).toBe(true);
      }
    },
  );

  it("rolls forward to a new starting count", () => {
    const c = createHitCounter(1337);
    for (let i = 0; i < 300; i++) {
      stepHitCounter(c, 1 / 30, 0, 42);
    }
    expect(Array.from(c.wheels)).toEqual([0, 0, 0, 0, 0, 4, 2]);
  });
});
