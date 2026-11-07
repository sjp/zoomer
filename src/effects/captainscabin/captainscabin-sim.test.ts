import { describe, expect, it } from "vitest";
import {
  BEAM_Y0,
  cabinLayout,
  createLightning,
  createMotion,
  createShips,
  createWeatherLook,
  easeGain,
  easeWeather,
  flameAt,
  GAIN_RATE,
  headAt,
  HEAD_Y,
  LANTERN_GAIN,
  LANTERN_HALF,
  LANTERN_H,
  LANTERN_ROD,
  LIGHTNING_LENGTH,
  LIGHTNING_RISE,
  lightningEnvelope,
  MAX_PITCH,
  MAX_ROLL,
  motionAt,
  REF_HEIGHT,
  ROLL_SWELL,
  shipView,
  SHIP_H,
  sillAt,
  SILL_Y,
  stepLightning,
  stepShips,
  STORM_SWELL,
  swellGain,
  WEATHER_EASE,
} from "./captainscabin-sim";

const DEG = Math.PI / 180;

describe("cabinLayout", () => {
  /** A head-and-shoulders crop: the head up to 0.85 of the height within 0.2 heights of the middle, shoulders below 0.35 within 0.36. */
  const clearOfSpeaker = (cx: number, x0: number, x1: number, y0: number, y1: number) => {
    const h = REF_HEIGHT;
    const out = (half: number) => x0 > cx + half * h || x1 < cx - half * h;
    return out(0.2) || (y1 < 0.35 * h && out(0.36)) || y0 > 0.85 * h;
  };

  for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9]) {
    const l = cabinLayout(REF_HEIGHT * aspect);

    it(`centres the windows and puts a pilaster behind the speaker at ${aspect.toFixed(2)}`, () => {
      expect(l.winX0 + l.winX1).toBeCloseTo(l.width, 6);
      expect(l.lights % 2).toBe(0);
      expect(l.lights).toBeGreaterThanOrEqual(2);
      expect(l.winX0).toBeGreaterThan(l.shelfW);
      expect(l.winX1).toBeLessThan(l.width - l.sideW);
    });

    it(`keeps the lantern, sextant and dividers clear of the speaker at ${aspect.toFixed(2)}`, () => {
      const lx0 = l.lanternX - LANTERN_HALF - 12;
      const lx1 = l.lanternX + LANTERN_HALF + 12;
      const ly0 = BEAM_Y0 - LANTERN_ROD - LANTERN_H;
      expect(clearOfSpeaker(l.cx, lx0, lx1, ly0, BEAM_Y0)).toBe(true);
      expect(lx1).toBeLessThan(l.winX1);
      for (const x of [l.sextantX, l.dividersX]) {
        expect(clearOfSpeaker(l.cx, x - 80, x + 80, 0, 160)).toBe(true);
        expect(x - 80).toBeGreaterThan(0);
        expect(x + 80).toBeLessThan(l.width);
      }
    });
  }

  it("bows the row outwards: sill higher and head lower at the middle", () => {
    const l = cabinLayout(1920);
    expect(sillAt(l, l.winX0)).toBeCloseTo(SILL_Y, 6);
    expect(headAt(l, l.winX1)).toBeCloseTo(HEAD_Y, 6);
    expect(sillAt(l, l.cx)).toBeGreaterThan(SILL_Y);
    expect(headAt(l, l.cx)).toBeLessThan(HEAD_Y);
    expect(sillAt(l, l.cx - 100)).toBeCloseTo(sillAt(l, l.cx + 100), 9);
  });

  it("survives a bad width", () => {
    const l = cabinLayout(Number.NaN);
    expect(Number.isFinite(l.winX0)).toBe(true);
    expect(l.lights).toBeGreaterThan(0);
  });
});

describe("the swell", () => {
  const m = createMotion();
  const N = 4800;
  const period = ROLL_SWELL.period;

  it("is bounded by its amplitude at every swell setting", () => {
    for (const gain of [0, 0.5, 1, STORM_SWELL]) {
      for (let i = 0; i < N; i++) {
        motionAt(i / N, gain, m);
        expect(Math.abs(m.roll)).toBeLessThanOrEqual(gain * MAX_ROLL + 1e-12);
        expect(Math.abs(m.pitch)).toBeLessThanOrEqual(gain * MAX_PITCH + 1e-12);
      }
    }
    // A few degrees at most, even in a storm.
    expect(STORM_SWELL * MAX_ROLL).toBeLessThan(5 * DEG);
  });

  it("is smooth and slow: no jumps, and gentle angular speed", () => {
    const gain = STORM_SWELL;
    const dt = period / N;
    motionAt(0, gain, m);
    let roll = m.roll;
    let pitch = m.pitch;
    let maxRate = 0;
    let maxAccel = 0;
    let lastRate = 0;
    for (let i = 1; i <= N; i++) {
      motionAt(i / N, gain, m);
      const rate = (m.roll - roll) / dt;
      if (i > 1) {
        maxAccel = Math.max(maxAccel, Math.abs(rate - lastRate) / dt);
      }
      maxRate = Math.max(maxRate, Math.abs(rate));
      expect(Math.abs(m.pitch - pitch)).toBeLessThan(0.001);
      lastRate = rate;
      roll = m.roll;
      pitch = m.pitch;
    }
    // Under about 4 degrees a second, and no sudden changes of direction.
    expect(maxRate).toBeLessThan(4 * DEG);
    expect(maxAccel).toBeLessThan(4 * DEG);
    // Wraps seamlessly at the end of the period.
    motionAt(1, gain, m);
    const end = m.roll;
    motionAt(0, gain, m);
    expect(end).toBeCloseTo(m.roll, 9);
  });

  it("has a dominant period of 6 to 10 s", () => {
    // Count upward zero crossings of the roll over one full period.
    let crossings = 0;
    motionAt(0, 1, m);
    let prev = m.roll;
    for (let i = 1; i <= N; i++) {
      motionAt(i / N, 1, m);
      if (prev < 0 && m.roll >= 0) {
        crossings++;
      }
      prev = m.roll;
    }
    const mean = period / crossings;
    expect(mean).toBeGreaterThanOrEqual(6);
    expect(mean).toBeLessThanOrEqual(10);
  });

  it("eases its amount toward the setting, never jumping", () => {
    expect(swellGain(1, 1)).toBeCloseTo(STORM_SWELL, 9);
    expect(swellGain(0.5, 0)).toBe(0.5);
    expect(swellGain(Number.NaN, 1)).toBe(0);
    expect(swellGain(5, 0)).toBe(1);
    let g = 0;
    for (let i = 0; i < 10; i++) {
      const next = easeGain(g, 1.5, 0.1);
      expect(next - g).toBeLessThanOrEqual(GAIN_RATE * 0.1 + 1e-12);
      g = next;
    }
    expect(easeGain(1, 0, Number.NaN)).toBe(1);
  });
});

describe("the lantern", () => {
  const m = createMotion();
  const N = 4800;

  it("swings against the roll, in phase with the swell", () => {
    let dot = 0;
    let rr = 0;
    let ll = 0;
    for (let i = 0; i < N; i++) {
      motionAt(i / N, 1, m);
      dot += m.roll * m.lantern;
      rr += m.roll * m.roll;
      ll += m.lantern * m.lantern;
    }
    const correlation = dot / Math.sqrt(rr * ll);
    expect(correlation).toBeLessThan(-0.95);
  });

  it("swings a bounded amount, and not at all on a flat sea", () => {
    for (const gain of [0, 1, STORM_SWELL]) {
      for (let i = 0; i < N; i++) {
        motionAt(i / N, gain, m);
        expect(Math.abs(m.lantern)).toBeLessThanOrEqual(gain * LANTERN_GAIN * MAX_ROLL + 1e-12);
      }
    }
    expect(STORM_SWELL * LANTERN_GAIN * MAX_ROLL).toBeLessThan(7 * DEG);
  });

  it("hangs its flame below the pivot, swinging sideways with the angle", () => {
    const p = { x: 0, y: 0 };
    flameAt(100, 900, 0, p);
    expect(p.x).toBeCloseTo(100, 9);
    expect(p.y).toBeLessThan(900 - LANTERN_ROD);
    flameAt(100, 900, 0.1, p);
    expect(p.x).toBeGreaterThan(100);
  });
});

describe("easeWeather", () => {
  it("rolls from one weather to another over WEATHER_EASE s, weights summing to 1", () => {
    const look = createWeatherLook();
    easeWeather(look, "storm", WEATHER_EASE / 2);
    expect(look.storm).toBeCloseTo(0.5, 6);
    expect(look.fair + look.night + look.storm).toBeCloseTo(1, 9);
    // Changing mind part-way keeps the sum at 1.
    easeWeather(look, "night", 1);
    expect(look.fair + look.night + look.storm).toBeCloseTo(1, 9);
    easeWeather(look, "night", WEATHER_EASE * 2);
    expect(look.night).toBeCloseTo(1, 9);
  });

  it("snaps, and falls back to fair for an unknown value", () => {
    const look = createWeatherLook();
    easeWeather(look, "storm", 0, true);
    expect(look.storm).toBe(1);
    easeWeather(look, "hurricane", 0, true);
    expect(look.fair).toBe(1);
  });
});

describe("lightning", () => {
  it("rises over at least a second and never jumps", () => {
    const dt = 1 / 120;
    let prev = 0;
    let maxStep = 0;
    for (let t = 0; t < LIGHTNING_LENGTH + 1; t += dt) {
      const v = lightningEnvelope(t);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    expect(LIGHTNING_RISE).toBeGreaterThanOrEqual(1);
    // A smoothstep over the rise climbs at most 1.5 / rise per second.
    expect(maxStep).toBeLessThanOrEqual((1.5 / LIGHTNING_RISE) * dt + 1e-9);
    expect(lightningEnvelope(LIGHTNING_RISE / 2)).toBeLessThan(0.6);
  });

  it("is rare, and only in a storm", () => {
    const calm = createLightning(5);
    const storm = createLightning(5);
    let calmMax = 0;
    let starts = 0;
    let lit = false;
    const dt = 1 / 30;
    for (let t = 0; t < 600; t += dt) {
      calmMax = Math.max(calmMax, stepLightning(calm, dt, 0));
      const v = stepLightning(storm, dt, 1);
      expect(v).toBeLessThanOrEqual(1);
      if (v > 0 && !lit) {
        starts++;
      }
      lit = v > 0;
    }
    expect(calmMax).toBe(0);
    // At most one glow every LIGHTNING_MIN_GAP (18 s) over ten minutes, and some.
    expect(starts).toBeGreaterThan(5);
    expect(starts).toBeLessThanOrEqual(600 / 18 + 1);
  });
});

describe("ships", () => {
  it("cross now and then, fading in and out at the ends", () => {
    const s = createShips(9);
    const v = { x: 0, h: 0, alpha: 0 };
    let seen = 0;
    let wasVisible = false;
    let prevX = Number.NaN;
    let maxX = 0;
    let maxH = 0;
    let maxStep = 0;
    let maxFirstAlpha = 0;
    let minAlpha = Infinity;
    let maxAlpha = -Infinity;
    const dt = 0.25;
    for (let t = 0; t < 1800; t += dt) {
      stepShips(s, dt);
      shipView(s, 1.2, v);
      minAlpha = Math.min(minAlpha, v.alpha);
      maxAlpha = Math.max(maxAlpha, v.alpha);
      const visible = v.alpha > 0;
      if (visible) {
        maxX = Math.max(maxX, Math.abs(v.x));
        maxH = Math.max(maxH, v.h);
        maxStep = wasVisible ? Math.max(maxStep, Math.abs(v.x - prevX)) : maxStep;
        maxFirstAlpha = wasVisible ? maxFirstAlpha : Math.max(maxFirstAlpha, v.alpha);
        seen += wasVisible ? 0 : 1;
        prevX = v.x;
      }
      wasVisible = visible;
    }
    expect(minAlpha).toBeGreaterThanOrEqual(0);
    expect(maxAlpha).toBeLessThanOrEqual(1);
    expect(maxX).toBeLessThanOrEqual(1.2);
    expect(maxH).toBeLessThanOrEqual(SHIP_H);
    // Slow: well under 0.01 frame heights a step, and faded in from nothing.
    expect(maxStep).toBeLessThan(0.01);
    expect(maxFirstAlpha).toBeLessThan(0.05);
    expect(seen).toBeGreaterThan(3);
    expect(seen).toBeLessThan(20);
  });
});
