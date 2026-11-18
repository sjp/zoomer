import { describe, expect, it } from "vitest";
import { MAX_PATTERN_HZ } from "../motion-limits";
import { DOOR_MAX_LENGTH, DOOR_MAX_LINES } from "./detective.meta";
import {
  createFan,
  createSign,
  DOOR_CANVAS_H,
  DOOR_CANVAS_W,
  DOOR_LINE_HEIGHT,
  DOOR_MARGIN,
  doorLines,
  FAN_BLADES,
  FAN_TURNS,
  fitDoorText,
  gateWeave,
  MAX_SIGN_SWING,
  SIGN_LIGHT,
  SIGN_LOW,
  SIGN_OFF,
  SIGN_ON,
  SIGN_RAMP,
  SIGN_SWITCH,
  signDuration,
  stepFan,
  stepSign,
  STREET_LIGHT,
  TONE_FLOATS,
  TONES,
  WEAVE_PX,
} from "./detective-sim";

const DT = 1 / 30;

/** Runs the sign for `seconds` at 30 fps, returning each frame's level and schedule state. */
function runSign(seconds: number, enabled: (t: number) => boolean = () => true, seed = 5) {
  const s = createSign(seed);
  const levels: number[] = [];
  const on: boolean[] = [];
  for (let i = 0; i < seconds * 30; i++) {
    levels.push(stepSign(s, DT, enabled(i * DT)));
    on.push(s.on);
  }
  return { levels, on };
}

describe("the sign's schedule", () => {
  it.each([1, 5, 77])("stays on for 4-8 s and off for 1-3 s (seed %i)", (seed) => {
    const { on } = runSign(600, () => true, seed);
    const spans: { on: boolean; frames: number }[] = [];
    for (let i = 1; i < on.length; i++) {
      if (on[i] !== on[i - 1]) {
        spans.push({ on: on[i], frames: 0 });
      } else if (spans.length > 0) {
        spans[spans.length - 1].frames++;
      }
    }
    // Drop the last, unfinished span.
    spans.pop();
    expect(spans.length).toBeGreaterThan(60);
    for (const span of spans) {
      const seconds = (span.frames + 1) * DT;
      const [lo, hi] = span.on ? SIGN_ON : SIGN_OFF;
      expect(seconds).toBeGreaterThanOrEqual(lo - DT);
      expect(seconds).toBeLessThanOrEqual(hi + DT);
    }
  });

  it("draws every duration inside its range", () => {
    for (let n = 0; n < 500; n++) {
      const on = signDuration(9, n, true);
      const off = signDuration(9, n, false);
      expect(on).toBeGreaterThanOrEqual(SIGN_ON[0]);
      expect(on).toBeLessThan(SIGN_ON[1]);
      expect(off).toBeGreaterThanOrEqual(SIGN_OFF[0]);
      expect(off).toBeLessThan(SIGN_OFF[1]);
    }
  });

  it("ramps each change over at least 0.4 s, and stays between its low and full levels", () => {
    expect(SIGN_RAMP).toBeGreaterThanOrEqual(0.4);
    const { levels } = runSign(300);
    // The steepest a smoothstep over SIGN_RAMP climbs, per frame.
    const maxStep = ((1.5 * (1 - SIGN_LOW)) / SIGN_RAMP) * DT + 1e-9;
    let rampStart = -1;
    const ramps: number[] = [];
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i]).toBeGreaterThanOrEqual(SIGN_LOW - 1e-9);
      expect(levels[i]).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.abs(levels[i] - levels[i - 1])).toBeLessThanOrEqual(maxStep);
      const moving = levels[i] !== levels[i - 1];
      if (moving && rampStart < 0) {
        rampStart = i - 1;
      } else if (!moving && rampStart >= 0) {
        ramps.push((i - 1 - rampStart) * DT);
        rampStart = -1;
      }
    }
    expect(ramps.length).toBeGreaterThan(30);
    expect(Math.min(...ramps)).toBeGreaterThanOrEqual(0.4 - 1e-9);
  });

  it("caps how much the blinking changes the light through the blinds", () => {
    const brightest = STREET_LIGHT + SIGN_LIGHT;
    const dimmest = STREET_LIGHT + SIGN_LIGHT * SIGN_LOW;
    expect((brightest - dimmest) / brightest).toBeLessThanOrEqual(MAX_SIGN_SWING);
  });

  it("fades out when switched off, never faster than its switch ease, and keeps its schedule", () => {
    const off = runSign(60, (t) => t < 20);
    const steady = runSign(60);
    expect(off.on).toEqual(steady.on);
    const maxStep = (1 / SIGN_SWITCH + (1.5 * (1 - SIGN_LOW)) / SIGN_RAMP) * DT + 1e-9;
    for (let i = 1; i < off.levels.length; i++) {
      expect(Math.abs(off.levels[i] - off.levels[i - 1])).toBeLessThanOrEqual(maxStep);
    }
    expect(off.levels.at(-1)).toBe(0);
  });

  it("starts in its switch's state, without fading", () => {
    expect(stepSign(createSign(1), DT, false)).toBe(0);
    expect(stepSign(createSign(1), DT, true)).toBe(1);
  });

  it("survives bad time steps", () => {
    const s = createSign(3);
    for (const dt of [Number.NaN, -1, Infinity, 0]) {
      expect(Number.isFinite(stepSign(s, dt, true))).toBe(true);
    }
  });
});

describe("the ceiling fan", () => {
  it("turns at about a fifth of a turn a second, well under the codec's pattern limit", () => {
    expect(FAN_TURNS).toBeCloseTo(0.2, 5);
    expect(FAN_TURNS * FAN_BLADES).toBeLessThan(MAX_PATTERN_HZ);
  });

  it("never passes a blade's shadow over a point faster than the limit, spinning up or down", () => {
    const fan = createFan();
    for (let i = 0; i < 30 * 40; i++) {
      stepFan(fan, DT, Math.floor(i / 300) % 2 === 0);
      expect(fan.speed * FAN_BLADES).toBeLessThanOrEqual(MAX_PATTERN_HZ);
      expect(fan.angle).toBeGreaterThanOrEqual(0);
      expect(fan.angle).toBeLessThan(1 / FAN_BLADES);
    }
  });

  it("spins up and runs down gradually", () => {
    const fan = createFan();
    stepFan(fan, DT, false);
    expect(fan.speed).toBe(0);
    stepFan(fan, 1, true);
    expect(fan.speed).toBeGreaterThan(0);
    expect(fan.speed).toBeLessThan(FAN_TURNS);
    for (let i = 0; i < 10; i++) {
      stepFan(fan, 1, true);
    }
    expect(fan.speed).toBeCloseTo(FAN_TURNS, 9);
    stepFan(fan, 1, false);
    expect(fan.speed).toBeGreaterThan(0);
  });

  it("starts at the switch's speed", () => {
    const fan = createFan();
    stepFan(fan, DT, true);
    expect(fan.speed).toBe(FAN_TURNS);
  });
});

describe("the door's lettering", () => {
  const room = DOOR_CANVAS_W - 2 * DOOR_MARGIN;
  const height = DOOR_CANVAS_H - 2 * DOOR_MARGIN;
  const cases = [];
  for (let lines = 1; lines <= DOOR_MAX_LINES; lines++) {
    for (let length = 1; length <= DOOR_MAX_LENGTH; length++) {
      for (const em of [0.5, 0.8, 1.1]) {
        cases.push({ lines, length, em });
      }
    }
  }

  it.each(cases)(
    "fits its panel: $lines line(s) of $length at $em em a letter",
    ({ lines, length, em }) => {
      const text = Array.from({ length: lines }, () => "W".repeat(length));
      const measure = (line: string, size: number) => Array.from(line).length * size * em;
      const sizes = fitDoorText(text, measure, []);
      expect(sizes).toHaveLength(lines);
      let total = 0;
      for (const [i, size] of sizes.entries()) {
        expect(size).toBeGreaterThan(0);
        expect(measure(text[i], size)).toBeLessThanOrEqual(room);
        total += size * DOOR_LINE_HEIGHT;
      }
      expect(total).toBeLessThanOrEqual(height);
    },
  );

  it("letters a short line larger than a long one", () => {
    const sizes = fitDoorText(["PRIVATE", "INVESTIGATOR"], (l, s) => l.length * s * 0.7, []);
    expect(sizes[0]).toBeGreaterThan(sizes[1]);
  });

  it("shrinks a line until it fits when widths don't scale exactly", () => {
    const measure = (line: string, size: number) => line.length * size * 0.8 + 30;
    const [size] = fitDoorText(["X".repeat(DOOR_MAX_LENGTH)], measure, []);
    expect(measure("X".repeat(DOOR_MAX_LENGTH), size)).toBeLessThanOrEqual(room);
  });

  it("paints nothing for empty text and drops trailing blank lines", () => {
    expect(doorLines("")).toEqual([]);
    expect(doorLines("\n")).toEqual([]);
    expect(doorLines("SAM\n")).toEqual(["SAM"]);
    expect(doorLines(" A \nB")).toEqual(["A", "B"]);
    expect(fitDoorText([], () => 1, [5])).toEqual([]);
  });
});

describe("the film", () => {
  it("weaves the picture by at most WEAVE_PX", () => {
    const out = new Float64Array(2);
    for (let t = 0; t < 120; t += 0.05) {
      gateWeave(t, out);
      expect(Math.abs(out[0])).toBeLessThanOrEqual(WEAVE_PX);
      expect(Math.abs(out[1])).toBeLessThanOrEqual(WEAVE_PX);
    }
    expect(gateWeave(Number.NaN, out)[0]).toBe(gateWeave(0, new Float64Array(2))[0]);
  });

  it("has every tone's values, and black and white keeps no colour", () => {
    for (const values of Object.values(TONES)) {
      expect(values).toHaveLength(TONE_FLOATS);
    }
    expect(TONES.mono[0]).toBe(0);
    expect(TONES.colour[0]).toBeGreaterThan(0);
  });
});
