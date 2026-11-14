import { describe, expect, it } from "vitest";
import { createDayClock } from "../horizon/horizon-sim";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ, pxPerReferenceFrame } from "../motion-limits";
import { clockHands } from "../wall-clock";
import {
  BAND_SPEED,
  bandCentre,
  BLINK_SHUT,
  blockEdges,
  boardSwing,
  createStandbyClock,
  GRAIN_HZ,
  grainPhase,
  layoutSign,
  type MeasureText,
  PULSE_DEPTH,
  PULSE_HZ,
  REF_HEIGHT,
  ROLL_PERIOD,
  SIGN_BOTTOM,
  SIGN_TOP,
  signMaxWidth,
  signPulse,
  standbyStyle,
  stepStandbyClock,
  SUBTEXT_LINE,
  SWING_ANGLE,
  SWING_PERIOD,
  TITLE_LINE,
  tvBlinking,
} from "./standby-sim";
import { standbyMeta, SUBTEXT_LENGTH, TITLE_LENGTH, TITLE_LINES } from "./standby.meta";

/** A fixed-width stand-in for measured text: a wide title face, a narrower subtext one. */
const fixedWidth: MeasureText = (text, part) =>
  Array.from(text).length * (part === "title" ? 0.72 : 0.56);
const unmeasured: MeasureText = () => undefined;

const DEFAULT = [standbyMeta.params.text.default, standbyMeta.params.subtext.default] as const;
const LONGEST = [
  Array.from({ length: TITLE_LINES }, () => "W".repeat(TITLE_LENGTH)).join("\n"),
  "W".repeat(SUBTEXT_LENGTH),
] as const;

const ASPECTS = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["portrait", 9 / 16],
] as const;

describe("sign layout", () => {
  const cases = ASPECTS.flatMap(([name, aspect]) =>
    (
      [
        ["default", DEFAULT],
        ["longest", LONGEST],
      ] as const
    ).flatMap(([which, texts]) =>
      (
        [
          ["measured", fixedWidth],
          ["unmeasured", unmeasured],
        ] as const
      ).map(([how, measure]) => [name, which, how, aspect, texts, measure] as const),
    ),
  );

  it.each(cases)("fits the %s frame's %s text (%s)", (_n, _w, _h, aspect, texts, measure) => {
    const refWidth = REF_HEIGHT * aspect;
    const l = layoutSign(texts[0], texts[1], refWidth, measure);
    const widthOf = (text: string, part: "title" | "subtext") =>
      (measure(text, part) ?? Array.from(text).length * 0.62) *
      (part === "title" ? l.titleSize : l.subtextSize);

    // The plate in the upper third, within the frame and its width limit.
    expect(l.width).toBeGreaterThan(0);
    expect(l.width).toBeLessThanOrEqual(signMaxWidth(refWidth) + 1e-6);
    expect(l.x - l.width / 2).toBeGreaterThanOrEqual(0);
    expect(l.x + l.width / 2).toBeLessThanOrEqual(refWidth);
    expect(l.top).toBeGreaterThanOrEqual(SIGN_TOP - 1e-6);
    expect(l.top + l.height).toBeLessThanOrEqual(SIGN_BOTTOM + 1e-6);
    expect(l.top + l.height).toBeLessThanOrEqual(REF_HEIGHT / 3);

    // Every line inside the plate.
    expect(l.lines.length).toBe(texts[0].split("\n").length);
    l.lines.forEach((line, i) => {
      expect(widthOf(line, "title")).toBeLessThan(l.width);
      expect(l.lineY[i] - (TITLE_LINE * l.titleSize) / 2).toBeGreaterThanOrEqual(0);
      expect(l.lineY[i] + (TITLE_LINE * l.titleSize) / 2).toBeLessThanOrEqual(l.height);
    });
    expect(widthOf(l.subtext, "subtext")).toBeLessThan(l.width);
    expect(l.subtextY + (SUBTEXT_LINE * l.subtextSize) / 2).toBeLessThanOrEqual(l.height + 1e-6);
    expect(l.subtextSize).toBeGreaterThan(0);
    expect(l.subtextSize).toBeLessThan(l.titleSize);
  });

  it("is large on a wide frame", () => {
    const l = layoutSign(DEFAULT[0], DEFAULT[1], 1920, fixedWidth);
    expect(l.titleSize).toBeGreaterThan(70);
  });

  it("drops blank lines and has no plate for no text", () => {
    expect(layoutSign("\n  \n", "", 1920, fixedWidth).width).toBe(0);
    const l = layoutSign("\nHELLO\n", "", 1920, fixedWidth);
    expect(l.lines).toEqual(["HELLO"]);
    expect(l.subtextSize).toBe(0);
  });

  it("shows the subtext alone on a plate", () => {
    const l = layoutSign("", "back soon", 1920, fixedWidth);
    expect(l.lines).toEqual([]);
    expect(l.subtextSize).toBeGreaterThan(0);
    expect(l.width).toBeGreaterThan(0);
    expect(l.top + l.height).toBeLessThanOrEqual(REF_HEIGHT / 3);
  });
});

describe("bars", () => {
  it("lays blocks edge to edge across the width", () => {
    const edges = blockEdges([1, 1, 1, 1, 1, 1, 1], 1921);
    expect(edges[0]).toBe(0);
    expect(edges[7]).toBe(1921);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i]).toBeGreaterThan(edges[i - 1]);
    }
  });

  it("maps style values, Analogue for anything unknown", () => {
    expect(standbyStyle("digital")).toBe("digital");
    expect(standbyStyle("cartoon")).toBe("cartoon");
    expect(standbyStyle("nope")).toBe("analogue");
  });
});

describe("motion", () => {
  it("keeps the rolling band within the codec limits", () => {
    expect(pxPerReferenceFrame(BAND_SPEED)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    expect(1 / ROLL_PERIOD).toBeLessThanOrEqual(MAX_PATTERN_HZ);
  });

  it("re-seeds the grain within the pattern rate limit", () => {
    expect(GRAIN_HZ).toBeLessThanOrEqual(MAX_PATTERN_HZ);
    expect(GRAIN_HZ).toBeGreaterThan(0);
  });

  it("keeps the sign's pulse and the board's swing small and slow", () => {
    expect(PULSE_HZ).toBeLessThanOrEqual(0.25);
    expect(PULSE_DEPTH).toBeLessThanOrEqual(0.05);
    expect(SWING_ANGLE).toBeLessThanOrEqual((2 * Math.PI) / 180);
    // The board's far corner, about 1200 px from the nail, at the swing's fastest.
    const cornerSpeed = (1200 * SWING_ANGLE * 2 * Math.PI) / SWING_PERIOD / REF_HEIGHT;
    expect(pxPerReferenceFrame(cornerSpeed)).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
  });

  it("rolls the band from above the frame to below it once a period", () => {
    const c = createStandbyClock();
    const seen: number[] = [];
    for (let i = 0; i < ROLL_PERIOD * 10; i++) {
      stepStandbyClock(c, 0.1, 1);
      seen.push(bandCentre(c));
    }
    expect(Math.min(...seen)).toBeLessThan(0);
    expect(Math.max(...seen)).toBeGreaterThan(1);
  });

  it("stands perfectly still at motion 0", () => {
    const c = createStandbyClock();
    stepStandbyClock(c, 3.3, 1);
    const grain = grainPhase(c, new Float64Array(2));
    const before = [bandCentre(c), grain[0], grain[1], c.blinkTime];
    for (let i = 0; i < 600; i++) {
      stepStandbyClock(c, 1 / 60, 0);
      expect(signPulse(c, 0)).toBe(1);
      expect(Math.abs(boardSwing(c, 0))).toBe(0);
      expect(tvBlinking(c, 0)).toBe(false);
    }
    grainPhase(c, grain);
    expect([bandCentre(c), grain[0], grain[1], c.blinkTime]).toEqual(before);
  });

  it("blinks the TV every few seconds, briefly", () => {
    const c = createStandbyClock();
    let shut = 0;
    let blinks = 0;
    let was = false;
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 60; i++) {
      stepStandbyClock(c, dt, 1);
      const now = tvBlinking(c, 1);
      if (now) {
        shut += dt;
      }
      if (now && !was) {
        blinks++;
      }
      was = now;
    }
    expect(blinks).toBeGreaterThan(8);
    expect(blinks).toBeLessThan(25);
    expect(shut / blinks).toBeCloseTo(BLINK_SHUT, 1);
  });

  it("ignores bad time steps", () => {
    const c = createStandbyClock();
    stepStandbyClock(c, Number.NaN, 1);
    stepStandbyClock(c, -1, 1);
    stepStandbyClock(c, Number.POSITIVE_INFINITY, 1);
    expect(c.time).toBe(0);
  });
});

describe("station clock", () => {
  it("shows the pinned local time", () => {
    const now = new Date();
    const hands = clockHands(createDayClock().step(0, "local", 0, 0), new Float64Array(3));
    const minutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const tau = 2 * Math.PI;
    expect(hands[0]).toBeCloseTo((((minutes / 60) % 12) / 12) * tau, 6);
    expect(hands[1]).toBeCloseTo(((minutes % 60) / 60) * tau, 6);
    expect(hands[2]).toBeCloseTo(
      (((now.getSeconds() + now.getMilliseconds() / 1000) % 60) / 60) * tau,
      6,
    );
  });
});
