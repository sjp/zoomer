import { describe, expect, it } from "vitest";
import {
  ALERT_EASE,
  alertWash,
  BEACON_PERIOD,
  BEACON_Y,
  beaconAngle,
  beaconAzimuths,
  blinkShape,
  CALM,
  CALM_HALF,
  CALM_MAX_RATE,
  CALM_RAMP,
  CALM_SLOT0,
  CEILING_H,
  CONSOLE_BACK_H,
  CONSOLE_H,
  createLampBank,
  DECK_H,
  DOOR,
  FACE_TOP,
  isCalmSlot,
  LAMP_GROUP,
  LAMP_RAMP,
  LAMP_SLOTS,
  MAX_RATE,
  MAX_SEGMENTS,
  MIN_RATE,
  PULSE_PERIOD,
  project,
  R_CHAIR,
  R_CONSOLE,
  R_CONSOLE_BACK,
  R_DECK,
  R_RAIL,
  R_WALL,
  RAIL_H,
  RAIL_T,
  ringSegments,
  SCREEN_PERIOD,
  screenTime,
  slotRate,
  STATION,
  stepAlert,
  stepLamps,
  wallPoint,
} from "./retrobridge-sim";

const out = new Float64Array(2);

describe("the ring", () => {
  const segs = ringSegments();

  it("fits the room shader and tiles without gaps or overlaps", () => {
    expect(segs.length).toBeLessThanOrEqual(MAX_SEGMENTS);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].a0).toBeCloseTo(segs[i - 1].a1, 12);
    }
    for (const s of segs) {
      expect(s.a1).toBeGreaterThan(s.a0);
    }
  });

  it("has one calm stretch, centred, and one door beside it", () => {
    const calm = segs.filter((s) => s.kind === CALM);
    expect(calm).toHaveLength(1);
    expect(calm[0].a0).toBeCloseTo(-CALM_HALF, 12);
    expect(calm[0].a1).toBeCloseTo(CALM_HALF, 12);
    const doors = segs.filter((s) => s.kind === DOOR);
    expect(doors).toHaveLength(1);
    expect(doors[0].a0).toBeCloseTo(CALM_HALF, 12);
  });

  it("keeps the middle third of a 16:9 frame calm at every wall height", () => {
    for (const y of [1.2, 1.6, 2, 2.5, 2.9]) {
      wallPoint(CALM_HALF, y, out);
      expect(out[0]).toBeGreaterThan(16 / 9 / 6);
    }
  });

  it("shows stations past both edges of a 16:9 frame, and the door inside it", () => {
    const edge = 16 / 9 / 2;
    const first = segs[0];
    const last = segs[segs.length - 1];
    expect(wallPoint(first.a0, 2, out)[0]).toBeLessThan(-edge);
    expect(wallPoint(last.a1, 2, out)[0]).toBeGreaterThan(edge);
    const doorEnd = segs.find((s) => s.kind === DOOR)?.a1 ?? Number.NaN;
    expect(wallPoint(doorEnd, 2, out)[0]).toBeLessThan(edge);
    expect(segs.filter((s) => s.kind === STATION).length).toBeGreaterThanOrEqual(6);
  });

  it("puts the wall's top and the deck inside the frame", () => {
    expect(wallPoint(0, CEILING_H, out)[1]).toBeLessThan(0.45);
    expect(wallPoint(0, 0.45, out)[1]).toBeGreaterThan(-0.4);
  });

  it("rings the well with the railing, the chairs, the consoles and the wall, in that order", () => {
    const radii = [R_DECK, R_RAIL, R_CHAIR, R_CONSOLE, R_CONSOLE_BACK, R_WALL];
    for (let i = 1; i < radii.length; i++) {
      expect(radii[i]).toBeGreaterThan(radii[i - 1]);
    }
    const heights = [
      DECK_H,
      CONSOLE_H,
      RAIL_H - RAIL_T,
      RAIL_H,
      CONSOLE_BACK_H,
      FACE_TOP,
      BEACON_Y,
    ];
    for (let i = 1; i < heights.length; i++) {
      expect(heights[i]).toBeGreaterThan(heights[i - 1]);
    }
    expect(CEILING_H).toBeGreaterThan(BEACON_Y);
  });

  it("shows the desk's red front edge below the railing and its back above it", () => {
    const railLow = project(0, RAIL_H - RAIL_T, R_RAIL, new Float64Array(2))[1];
    const railTop = project(0, RAIL_H, R_RAIL, new Float64Array(2))[1];
    expect(project(0, CONSOLE_H, R_CONSOLE, out)[1]).toBeLessThan(railLow - 0.02);
    expect(project(0, CONSOLE_BACK_H, R_CONSOLE_BACK, out)[1]).toBeGreaterThan(railTop);
  });

  it("puts the beacons outside the calm stretch and in frame", () => {
    for (const a of beaconAzimuths()) {
      expect(Math.abs(a)).toBeGreaterThan(CALM_HALF);
      wallPoint(a, BEACON_Y, out);
      expect(Math.abs(out[0])).toBeLessThan(16 / 9 / 2);
      expect(Math.abs(out[1])).toBeLessThan(0.5);
    }
  });

  it("projects points behind the camera to NaN", () => {
    project(0, 1, -10, out);
    expect(out[0]).toBeNaN();
  });
});

describe("lamps", () => {
  it("are deterministic for a seed", () => {
    const a = createLampBank(7);
    const b = createLampBank(7);
    const oa = new Uint8Array(LAMP_SLOTS);
    const ob = new Uint8Array(LAMP_SLOTS);
    for (let i = 0; i < 300; i++) {
      stepLamps(a, 1 / 60, 0.5, oa);
      stepLamps(b, 1 / 60, 0.5, ob);
    }
    expect(Array.from(oa)).toEqual(Array.from(ob));
    const c = createLampBank(8);
    const oc = new Uint8Array(LAMP_SLOTS);
    for (let i = 0; i < 300; i++) {
      stepLamps(c, 1 / 60, 0.5, oc);
    }
    expect(Array.from(oc)).not.toEqual(Array.from(oa));
  });

  it("blink no faster than their bounds and fit their fades in the cycle", () => {
    const calm: number[] = [];
    const busy: number[] = [];
    let worstCalmFit = -1;
    let worstBusyFit = -1;
    let shortestOff = 1;
    for (const seed of [0, 7, 999]) {
      const bank = createLampBank(seed);
      for (let i = 0; i < LAMP_SLOTS; i++) {
        const calmSlot = isCalmSlot(i);
        (calmSlot ? calm : busy).push(bank.rate[i]);
        const ramp = calmSlot ? CALM_RAMP * bank.rate[i] : LAMP_RAMP * slotRate(bank.rate[i], 1);
        const fit = ramp - bank.duty[i] / 2;
        if (calmSlot) {
          worstCalmFit = Math.max(worstCalmFit, fit);
        } else {
          worstBusyFit = Math.max(worstBusyFit, fit);
          shortestOff = Math.min(shortestOff, 1 - bank.duty[i]);
        }
      }
    }
    expect(Math.max(...calm)).toBeLessThanOrEqual(CALM_MAX_RATE);
    expect(Math.min(...busy)).toBeGreaterThanOrEqual(MIN_RATE);
    expect(Math.max(...busy)).toBeLessThanOrEqual(MAX_RATE);
    expect(slotRate(MAX_RATE, 1)).toBeLessThanOrEqual(MAX_RATE);
    expect(worstCalmFit).toBeLessThanOrEqual(1e-12);
    expect(worstBusyFit).toBeLessThanOrEqual(1e-12);
    expect(shortestOff).toBeGreaterThanOrEqual(LAMP_RAMP * MAX_RATE);
  });

  it("stay in range and never change faster than a fade, even while activity moves", () => {
    const bank = createLampBank(42);
    const bytes = new Uint8Array(LAMP_SLOTS);
    const dt = 1 / 60;
    const prev = new Float64Array(LAMP_SLOTS).fill(Number.NaN);
    let lo = 1;
    let hi = 0;
    // A smoothstep fade has slope 1.5 / ramp at its steepest; activity easing adds a little.
    const limit = 1.5 / LAMP_RAMP + 1.5;
    let worst = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const t = i * dt;
      const target = t < 30 ? 0 : t < 60 ? 1 : t < 90 ? 0.3 : 0.8;
      stepLamps(bank, dt, target, bytes);
      for (let s = 0; s < LAMP_SLOTS; s++) {
        const v = bank.level[s];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        if (!Number.isNaN(prev[s])) {
          worst = Math.max(worst, Math.abs(v - prev[s]) / dt);
        }
        prev[s] = v;
      }
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(worst).toBeLessThanOrEqual(limit);
    expect(worst).toBeGreaterThan(0);
  });

  it("keep calm slots slow and soft", () => {
    const bank = createLampBank(3);
    const bytes = new Uint8Array(LAMP_SLOTS);
    const dt = 1 / 60;
    let worst = 0;
    let low = 1;
    const prev = new Float64Array(LAMP_SLOTS).fill(Number.NaN);
    for (let i = 0; i < 60 * 60; i++) {
      stepLamps(bank, dt, 1, bytes);
      for (let s = CALM_SLOT0; s < LAMP_SLOTS; s++) {
        const v = bank.level[s];
        low = Math.min(low, v);
        if (!Number.isNaN(prev[s])) {
          worst = Math.max(worst, Math.abs(v - prev[s]) / dt);
        }
        prev[s] = v;
      }
    }
    expect(low).toBeGreaterThanOrEqual(0.35 - 1e-9);
    expect(worst).toBeLessThanOrEqual((0.65 * 1.5) / CALM_RAMP + 1e-6);
  });

  it("blink more of the lamps at higher activity", () => {
    const count = (activity: number) => {
      const bank = createLampBank(5);
      const bytes = new Uint8Array(LAMP_SLOTS);
      const seen = new Uint8Array(LAMP_SLOTS);
      const first = new Uint8Array(LAMP_SLOTS);
      for (let i = 0; i < 60 * 30; i++) {
        stepLamps(bank, 1 / 60, activity, bytes);
        if (i === 0) {
          first.set(bytes);
        }
        for (let s = 0; s < CALM_SLOT0; s++) {
          if (Math.abs(bytes[s] - first[s]) > 128) {
            seen[s] = 1;
          }
        }
      }
      return seen.reduce((a, b) => a + b, 0);
    };
    const idle = count(0);
    const busy = count(1);
    expect(busy).toBeGreaterThan(idle);
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThan(CALM_SLOT0 * 0.6);
  });

  it("does not light whole rows in phase", () => {
    const bank = createLampBank(11);
    for (let g = 0; g < CALM_SLOT0 / LAMP_GROUP; g++) {
      const offsets = new Set<number>();
      for (let k = 0; k < LAMP_GROUP; k++) {
        offsets.add(Math.round(bank.offset[g * LAMP_GROUP + k] * 1000));
      }
      expect(offsets.size).toBeGreaterThan(1);
    }
  });

  it("shape a blink that starts and ends dark", () => {
    expect(blinkShape(0, 0.5, 0.2)).toBe(0);
    expect(blinkShape(0.5, 0.5, 0.2)).toBe(0);
    expect(blinkShape(0.25, 0.5, 0.2)).toBe(1);
    expect(blinkShape(0.8, 0.5, 0.2)).toBe(0);
  });

  it("survive bad steps", () => {
    const bank = createLampBank(1);
    const bytes = new Uint8Array(LAMP_SLOTS);
    stepLamps(bank, Number.NaN, Number.NaN, bytes);
    stepLamps(bank, -1, 2, bytes);
    stepLamps(bank, 1e9, 0.5, bytes);
    for (const v of bank.level) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});

describe("red alert", () => {
  it("eases on and off no faster than its ramp", () => {
    let level = 0;
    const dt = 1 / 60;
    let t = 0;
    let prevWash = alertWash(level, t);
    let worst = 0;
    for (let i = 0; i < 60 * 20; i++) {
      t += dt;
      const on = t < 10;
      const next = stepAlert(level, on, dt);
      expect(Math.abs(next - level)).toBeLessThanOrEqual(dt / ALERT_EASE + 1e-12);
      level = next;
      const w = alertWash(level, t);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(1);
      worst = Math.max(worst, Math.abs(w - prevWash) / dt);
      prevWash = w;
    }
    expect(level).toBe(0);
    // Easing in (slope 1.5 / ALERT_EASE) plus the pulse (0.4 * pi / PULSE_PERIOD).
    expect(worst).toBeLessThanOrEqual(1.5 / ALERT_EASE + (0.4 * Math.PI) / PULSE_PERIOD + 1e-6);
  });

  it("takes at least a second to come fully on", () => {
    let level = 0;
    let t = 0;
    while (level < 1) {
      level = stepAlert(level, true, 0.01);
      t += 0.01;
    }
    expect(t).toBeGreaterThanOrEqual(1);
    expect(alertWash(0, 1.2)).toBe(0);
  });

  it("pulses and turns slowly", () => {
    expect(PULSE_PERIOD).toBeGreaterThanOrEqual(2);
    expect(BEACON_PERIOD).toBeGreaterThanOrEqual(2);
    expect(beaconAngle(0)).toBe(0);
    expect(beaconAngle(BEACON_PERIOD / 4)).toBeCloseTo(Math.PI / 2, 9);
    expect(beaconAngle(1e6)).toBeGreaterThanOrEqual(0);
    expect(beaconAngle(1e6)).toBeLessThan(Math.PI * 2);
  });
});

describe("screen clock", () => {
  it("wraps to its period", () => {
    expect(screenTime(SCREEN_PERIOD + 5)).toBeCloseTo(5, 9);
    expect(screenTime(-5)).toBeCloseTo(SCREEN_PERIOD - 5, 9);
  });
});
