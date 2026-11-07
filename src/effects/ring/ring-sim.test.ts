import { describe, expect, it } from "vitest";
import { MAX_SPIN, MIN_SPIN } from "./ring.meta";
import {
  advanceSpin,
  BODIES,
  bodyAzimuth,
  bodyFrame,
  bodyInView,
  BODY_AZIMUTH,
  BODY_POLAR,
  INDICATOR_FADE,
  INDICATOR_PERIOD,
  indicatorColour,
  skyDirection,
  spinAngle,
  spinSeconds,
  START_PHASE,
  WINDOW_AZIMUTHS,
} from "./ring-sim";

const TAU = Math.PI * 2;

/** Angle between two rotations, as the shortest way round. */
const angleGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d);
};

describe("station turn", () => {
  it("repeats every `spin` seconds", () => {
    for (const spin of [MIN_SPIN, 90, 137, MAX_SPIN]) {
      let phase = START_PHASE;
      const dt = 1 / 60;
      const steps = Math.round(spin / dt);
      for (let i = 0; i < steps; i++) {
        phase = advanceSpin(phase, dt, spin);
      }
      // Rounding the step count leaves at most half a step over or under.
      expect(angleGap(spinAngle(phase), spinAngle(START_PHASE))).toBeLessThan(
        (TAU * dt) / spin + 1e-9,
      );
    }
  });

  it("is continuous across the wrap", () => {
    const spin = 90;
    const dt = 1 / 120;
    let phase = 0.999;
    let wrapped = false;
    for (let i = 0; i < 100; i++) {
      const next = advanceSpin(phase, dt, spin);
      wrapped ||= next < phase;
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(1);
      const step = angleGap(spinAngle(next), spinAngle(phase));
      expect(step).toBeCloseTo((TAU * dt) / spin, 9);
      // The uploaded cosine and sine move smoothly too.
      expect(Math.abs(Math.cos(spinAngle(next)) - Math.cos(spinAngle(phase)))).toBeLessThan(1e-3);
      expect(Math.abs(Math.sin(spinAngle(next)) - Math.sin(spinAngle(phase)))).toBeLessThan(1e-3);
      phase = next;
    }
    expect(wrapped).toBe(true);
  });

  it("keeps the angle when the speed changes", () => {
    const a = advanceSpin(0.3, 0, 60);
    const b = advanceSpin(a, 0, 240);
    expect(spinAngle(b)).toBe(spinAngle(a));
    expect(advanceSpin(0.3, Number.NaN, 60)).toBe(0.3);
    expect(advanceSpin(0.3, -1, 60)).toBe(0.3);
  });

  it("clamps the spin to its range", () => {
    expect(spinSeconds(1)).toBe(MIN_SPIN);
    expect(spinSeconds(1e6)).toBe(MAX_SPIN);
    expect(spinSeconds(Number.NaN)).toBe(MIN_SPIN);
  });
});

describe("planet in view", () => {
  const sample = (radius: number, n = 72000) => {
    let partly = 0;
    for (let i = 0; i < n; i++) {
      if (bodyInView(i / n, radius) > 0) {
        partly++;
      }
    }
    return partly / n;
  };

  it("covers the expected fraction of a turn", () => {
    const [lo, hi] = WINDOW_AZIMUTHS;
    for (const body of Object.values(BODIES)) {
      const expected = (hi - lo + 2 * body.radius) / TAU;
      expect(sample(body.radius)).toBeCloseTo(expected, 3);
      // In view for part of each turn, out of sight for the rest.
      expect(expected).toBeGreaterThan(0.1);
      expect(expected).toBeLessThan(0.4);
    }
  });

  it("rises and sets once per turn", () => {
    const n = 7200;
    let rises = 0;
    let prev = bodyInView(0, BODIES.earth.radius);
    for (let i = 1; i <= n; i++) {
      const v = bodyInView(i / n, BODIES.earth.radius);
      if (prev === 0 && v > 0) {
        rises++;
      }
      prev = v;
    }
    expect(rises).toBe(1);
  });

  it("eases its light in over at least a second at the fastest spin", () => {
    for (const body of Object.values(BODIES)) {
      const dt = 0.01;
      let phase = 0.5;
      // Find a moment it is out of view, then time the rise to full view.
      while (bodyInView(phase, body.radius) > 0) {
        phase = advanceSpin(phase, dt, MIN_SPIN);
      }
      while (bodyInView(phase, body.radius) === 0) {
        phase = advanceSpin(phase, dt, MIN_SPIN);
      }
      let t = 0;
      let peak = 0;
      let maxStep = 0;
      let v = bodyInView(phase, body.radius);
      while (v > peak - 1e-9 && t < MIN_SPIN) {
        peak = v;
        phase = advanceSpin(phase, dt, MIN_SPIN);
        const next = bodyInView(phase, body.radius);
        maxStep = Math.max(maxStep, Math.abs(next - v));
        v = next;
        t += dt;
      }
      expect(t).toBeGreaterThan(1);
      expect(maxStep / dt).toBeLessThan(1.5);
    }
  });

  it("starts just below the windows", () => {
    const a = bodyAzimuth(START_PHASE);
    expect(a).toBeLessThan(WINDOW_AZIMUTHS[0]);
    expect(a).toBeGreaterThan(WINDOW_AZIMUTHS[0] - 2 * BODIES.earth.radius);
  });
});

describe("body frame", () => {
  const dot = (a: readonly number[], b: readonly number[]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  it("has an orthonormal, right-handed basis and faces the station at its lon and lat", () => {
    for (const spec of Object.values(BODIES)) {
      const f = bodyFrame(spec);
      const bx = f.basis.slice(0, 3);
      const by = f.basis.slice(3, 6);
      const bz = f.basis.slice(6, 9);
      for (const [a, b, want] of [
        [bx, bx, 1],
        [by, by, 1],
        [bz, bz, 1],
        [bx, by, 0],
        [by, bz, 0],
        [bx, bz, 0],
      ] as const) {
        expect(dot(a, b)).toBeCloseTo(want, 9);
      }
      // y x z = x for a right-handed frame, so maps are not mirrored.
      const cx = [
        by[1] * bz[2] - by[2] * bz[1],
        by[2] * bz[0] - by[0] * bz[2],
        by[0] * bz[1] - by[1] * bz[0],
      ];
      expect(dot(cx, bx)).toBeCloseTo(1, 9);
      expect(dot(f.sun, f.sun)).toBeCloseTo(1, 9);
      expect(f.centre).toEqual(skyDirection(BODY_POLAR, BODY_AZIMUTH));
      // The point facing the station.
      const n = f.centre.map((v) => -v);
      const b = [dot(bx, n), dot(by, n), dot(bz, n)];
      expect(Math.atan2(b[0], b[2])).toBeCloseTo(spec.lon, 9);
      expect(Math.asin(b[1])).toBeCloseTo(spec.lat, 9);
      // Lit on the side facing the station: a broad gibbous phase.
      expect(dot(f.sun, n)).toBeGreaterThan(0.3);
    }
  });
});

describe("wall indicator", () => {
  it("changes rarely and softly", () => {
    const c: [number, number, number] = [0, 0, 0];
    const prev: [number, number, number] = [0, 0, 0];
    indicatorColour(0, prev);
    const dt = 0.05;
    let changing = 0;
    let maxRate = 0;
    let latest = 0;
    for (let t = dt; t < 40 * INDICATOR_PERIOD; t += dt) {
      indicatorColour(t, c);
      const d = Math.max(...c.map((v, i) => Math.abs(v - prev[i])));
      if (d > 1e-9) {
        changing += dt;
        latest = Math.max(latest, t % INDICATOR_PERIOD);
      }
      maxRate = Math.max(maxRate, d / dt);
      prev.splice(0, 3, ...c);
    }
    expect(changing).toBeGreaterThan(0);
    // Changes happen only in the fade at the start of each period.
    expect(latest).toBeLessThan(INDICATOR_FADE + dt);
    // No step faster than a full swing over a second.
    expect(maxRate).toBeLessThan(1);
    expect(INDICATOR_FADE).toBeGreaterThanOrEqual(1);
  });
});
