import { describe, expect, it } from "vitest";
import { FOCAL } from "../train/train-sim";
import {
  BUMP_DAMPING,
  BUMP_HZ,
  BUMP_KICK,
  BUMP_MAX,
  createJolts,
  createSpring,
  createStations,
  diningLayout,
  drinkLook,
  EXPRESS_V,
  FRINGE_DAMPING,
  FRINGE_HZ,
  FRINGE_KICK,
  FRINGE_MAX,
  JOLT_JITTER,
  LIQUID_DAMPING,
  LIQUID_HZ,
  LIQUID_KICK,
  LIQUID_MAX,
  MIN_JOLT_GAP,
  RAIL_LEN,
  ROCK_PX,
  ROCK_TILT,
  rockAt,
  SHADE_HALF0,
  STATION_FLOATS,
  STATION_RAMP,
  STATION_Z,
  stationGap,
  stepJolts,
  stepSpring,
  stepStations,
  viewStation,
} from "./diningcar-sim";

const DT = 1 / 60;

/** Times of the jolts over `seconds` at velocity `v` (world units per second). */
function joltTimes(seed: number, v: number, seconds: number): number[] {
  const j = createJolts(seed);
  const times: number[] = [];
  for (let t = 0; t < seconds; t += DT) {
    if (stepJolts(j, DT, v)) {
      times.push(t);
    }
  }
  return times;
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe("diningLayout", () => {
  for (const width of [1920, 1440, 2520, 608]) {
    it(`keeps the post central and the panes in frame at ${String(width)} px`, () => {
      const l = diningLayout(width);
      expect((l.paneL1 + l.paneR0) / 2).toBeCloseTo(l.cx);
      expect(l.paneL0).toBeGreaterThan(l.seatW);
      expect(l.paneL1 - l.paneL0).toBeGreaterThan(100);
      expect(l.paneR1 - l.paneR0).toBeCloseTo(l.paneL1 - l.paneL0);
      expect(l.vaseX).toBeLessThan(l.lampX);
      expect(l.lampX - SHADE_HALF0).toBeGreaterThan(0);
    });
  }

  it("keeps the lamp and the drink out of the middle at 16:9", () => {
    const l = diningLayout(1920);
    expect(l.lampX + SHADE_HALF0).toBeLessThan(l.cx - 0.1 * 1920);
    expect(l.vesselX - 60).toBeGreaterThan(l.cx + 0.15 * 1920);
  });
});

describe("rockAt", () => {
  it("stays within its bounds and is still when the train stands", () => {
    const out = { dy: 0, tilt: 0 };
    for (let t = 0; t < 60; t += 0.37) {
      rockAt(t, 1, out);
      expect(Math.abs(out.dy)).toBeLessThanOrEqual(ROCK_PX + 1e-9);
      expect(Math.abs(out.tilt)).toBeLessThanOrEqual(ROCK_TILT + 1e-12);
      rockAt(t, 0, out);
      expect(Math.abs(out.dy)).toBe(0);
      expect(Math.abs(out.tilt)).toBe(0);
    }
  });
});

describe("jolts", () => {
  it("come once per rail length, with small jitter, at the default speed", () => {
    const v = 0.4 * EXPRESS_V;
    const g = gaps(joltTimes(3, v, 120));
    const base = RAIL_LEN / v;
    expect(base).toBeGreaterThan(1);
    expect(base).toBeLessThan(2);
    expect(g.length).toBeGreaterThan(60);
    for (const gap of g) {
      expect(gap).toBeGreaterThan(base * (1 - JOLT_JITTER) - 2 * DT);
      expect(gap).toBeLessThan(base * (1 + JOLT_JITTER) + 2 * DT);
    }
    // Jittered: not every gap the same.
    expect(Math.max(...g) - Math.min(...g)).toBeGreaterThan(0.02);
  });

  it("never come faster than the minimum gap, however fast the train", () => {
    for (const v of [EXPRESS_V, 3 * EXPRESS_V, 100]) {
      const g = gaps(joltTimes(9, v, 120));
      expect(g.length).toBeGreaterThan(80);
      for (const gap of g) {
        expect(gap).toBeGreaterThanOrEqual(MIN_JOLT_GAP - 1e-9);
        expect(gap).toBeLessThan(MIN_JOLT_GAP * (1 + JOLT_JITTER) + 2 * DT);
      }
    }
  });

  it("respect the minimum gap across huge and odd steps", () => {
    const j = createJolts(1);
    const times: number[] = [];
    let t = 0;
    for (const dt of [5, 0.001, 0.001, 3, Number.NaN, -1, 0.5, 0.5, 0.5, 0.5, 2, 0.2]) {
      t += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      if (stepJolts(j, dt, 50)) {
        times.push(t);
      }
    }
    expect(times.length).toBeGreaterThan(2);
    for (const gap of gaps(times)) {
      expect(gap).toBeGreaterThanOrEqual(MIN_JOLT_GAP);
    }
  });

  it("stop when the train stands", () => {
    expect(joltTimes(4, 0, 30)).toHaveLength(0);
  });
});

describe("springs", () => {
  const springs = [
    { name: "liquid", hz: LIQUID_HZ, damping: LIQUID_DAMPING, max: LIQUID_MAX, kick: LIQUID_KICK },
    { name: "fringe", hz: FRINGE_HZ, damping: FRINGE_DAMPING, max: FRINGE_MAX, kick: FRINGE_KICK },
    { name: "bump", hz: BUMP_HZ, damping: BUMP_DAMPING, max: BUMP_MAX, kick: BUMP_KICK },
  ];

  for (const { name, hz, damping, max, kick } of springs) {
    it(`settles the ${name} after a jolt, before the next can come`, () => {
      const s = createSpring();
      s.v = kick;
      let peak = 0;
      for (let t = 0; t < 3; t += DT) {
        peak = Math.max(peak, Math.abs(stepSpring(s, DT, hz, damping, max)));
      }
      expect(peak).toBeGreaterThan(0);
      // Visible, but well inside the hard bound: it is the spring that settles it, not the clamp.
      expect(peak).toBeLessThan(max);
      expect(Math.abs(s.x)).toBeLessThan(0.05 * peak);
    });

    it(`keeps the ${name} bounded under jolts at the minimum gap`, () => {
      const s = createSpring();
      let since = 0;
      for (let t = 0; t < 120; t += DT) {
        since += DT;
        if (since >= MIN_JOLT_GAP) {
          since = 0;
          s.v += kick;
        }
        const x = stepSpring(s, DT, hz, damping, max);
        expect(Number.isFinite(x)).toBe(true);
        expect(Math.abs(x)).toBeLessThanOrEqual(max);
      }
    });
  }

  it("settles on its target and copes with odd steps", () => {
    const s = createSpring();
    for (let t = 0; t < 5; t += DT) {
      stepSpring(s, DT, LIQUID_HZ, LIQUID_DAMPING, LIQUID_MAX, 0.05);
    }
    expect(s.x).toBeCloseTo(0.05, 4);
    s.v = 1e9;
    for (const dt of [Number.NaN, -1, 10, 0]) {
      const x = stepSpring(s, dt, LIQUID_HZ, LIQUID_DAMPING, LIQUID_MAX);
      expect(Math.abs(x)).toBeLessThanOrEqual(LIQUID_MAX);
    }
  });
});

describe("stations", () => {
  const cx = 960;

  /** Runs the train at velocity `v` and returns the table light every frame. */
  function run(seed: number, stations: number, v: number, seconds: number) {
    const st = createStations(seed);
    const light: number[] = [];
    let pos = 0;
    for (let t = 0; t < seconds; t += DT) {
      pos += v * DT;
      light.push(stepStations(st, DT, pos, stations, cx));
    }
    return light;
  }

  it("gets rarer as `stations` falls, and stops at 0", () => {
    expect(stationGap(1)).toBeLessThan(stationGap(0.5));
    expect(stationGap(0.5)).toBeLessThan(stationGap(0.1));
    expect(stationGap(0)).toBe(Infinity);
    expect(Math.max(...run(2, 0, EXPRESS_V, 600))).toBe(0);
  });

  it("passes a few every ten minutes at full rate, each lighting the table", () => {
    const light = run(5, 1, 0.4 * EXPRESS_V, 600);
    let events = 0;
    for (let i = 1; i < light.length; i++) {
      if (light[i] > 0 && light[i - 1] === 0) {
        events++;
      }
    }
    expect(events).toBeGreaterThanOrEqual(4);
    expect(Math.max(...light)).toBeGreaterThan(0.4);
  });

  it("ramps the light over at least a second, both ways", () => {
    const light = run(7, 1, EXPRESS_V, 900);
    const maxStep = Math.max(...light.slice(1).map((l, i) => Math.abs(l - light[i])));
    expect(maxStep).toBeLessThanOrEqual(DT / STATION_RAMP + 1e-9);
    expect(STATION_RAMP).toBeGreaterThanOrEqual(1);
  });

  it("projects the lamps at the platform's depth", () => {
    const st = createStations(3);
    stepStations(st, DT, 0, 1, cx);
    const out = new Float32Array(STATION_FLOATS);
    viewStation(st, st.at, cx, out);
    expect(out[0]).toBeCloseTo(cx);
    expect(out[2]).toBeGreaterThanOrEqual(2);
    viewStation(st, st.at - 1, cx, out);
    expect(out[0]).toBeCloseTo(cx + FOCAL / STATION_Z, 3);
  });
});

describe("drinkLook", () => {
  it("falls back to red wine", () => {
    expect(drinkLook("tea").vessel).toBe(1);
    expect(drinkLook("nonsense")).toBe(drinkLook("red"));
  });
});
