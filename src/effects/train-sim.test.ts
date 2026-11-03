import { describe, expect, it } from "vitest";
import type { Rgb } from "./color";
import { sampleSky, createSkyState } from "./horizon-sim";
import {
  BANK_CHANNELS,
  BANK_COLUMNS,
  BANK_PERIOD,
  createTimeState,
  createTrain,
  FAR_LINE_Z,
  FAR_Y,
  FIELD_CHANNELS,
  FIELD_COLUMNS,
  FIELD_PERIOD,
  FOCAL,
  groundDepth,
  groundY,
  hazeAt,
  HILL_CHANNELS,
  HILL_COLUMNS,
  HILL_PERIOD,
  HORIZON_Y,
  HOUSE_FLOATS,
  HOUSE_Y,
  HOUSE_Z,
  fillBankTable,
  fillFieldTable,
  fillHillTable,
  lampAmount,
  LAYER_DEPTHS,
  MAX_HOUSES,
  MID_Y,
  placeHouses,
  POLE_SPACING,
  POLE_Z,
  poleOffset,
  polePositions,
  sampleTable,
  sampleTime,
  screenSpeed,
  scrollOffset,
  shadeLayer,
  stepTime,
  stepTrain,
  SWAY_AMP,
  swayOffset,
  TIME_KEYS,
  timeIndex,
  V_MAX,
  viewHouses,
  WIRE_DX,
  WIRE_SAG,
  WIRE_Y,
  wireHeight,
} from "./train-sim";

const hillTable = (seed: number) => {
  const t = new Float32Array(HILL_COLUMNS * HILL_CHANNELS);
  fillHillTable(t, seed);
  return t;
};
const fieldTable = (seed: number) => {
  const t = new Float32Array(FIELD_COLUMNS * FIELD_CHANNELS);
  fillFieldTable(t, seed);
  return t;
};
const bankTable = (seed: number) => {
  const t = new Float32Array(BANK_COLUMNS * BANK_CHANNELS);
  fillBankTable(t, seed);
  return t;
};

/**
 * Whether channel `ch` of a periodic table has no seam: the step from the last
 * column back to the first is no bigger than the largest step between neighbours.
 */
function seamless(t: Float32Array, columns: number, channels: number, ch: number): boolean {
  let maxStep = 0;
  for (let c = 1; c < columns; c++) {
    maxStep = Math.max(maxStep, Math.abs(t[c * channels + ch] - t[(c - 1) * channels + ch]));
  }
  const seam = Math.abs(t[ch] - t[(columns - 1) * channels + ch]);
  return seam <= maxStep + 1e-6;
}

describe("layers", () => {
  it("scroll faster the nearer they are", () => {
    for (let i = 1; i < LAYER_DEPTHS.length; i++) {
      expect(LAYER_DEPTHS[i]).toBeLessThan(LAYER_DEPTHS[i - 1]);
      expect(screenSpeed(1, LAYER_DEPTHS[i])).toBeGreaterThan(screenSpeed(1, LAYER_DEPTHS[i - 1]));
    }
  });

  it("sit on the ground plane in depth order, below the horizon", () => {
    expect(MID_Y).toBeLessThan(HOUSE_Y);
    expect(HOUSE_Y).toBeLessThan(FAR_Y);
    expect(FAR_Y).toBeLessThan(HORIZON_Y);
    expect(groundDepth(groundY(FAR_LINE_Z))).toBeCloseTo(FAR_LINE_Z, 9);
  });

  it("wrap their scroll to the period without moving the picture", () => {
    let ok = true;
    for (const z of LAYER_DEPTHS) {
      for (const pos of [0, 1.7, 123.4, 98765.4321]) {
        const a = scrollOffset(pos, z, 2048);
        // One period on screen later, the offset is the same.
        const b = scrollOffset(pos + (2048 * z) / FOCAL, z, 2048);
        const d = Math.abs(a - b);
        if (!(a >= 0 && a < 1) || Math.min(d, 1 - d) > 1e-6) ok = false;
      }
    }
    expect(ok).toBe(true);
  });

  it("move by the screen speed between frames", () => {
    const dt = 1 / 60;
    const v = 0.72;
    const a = scrollOffset(1000, POLE_Z, 4096);
    const b = scrollOffset(1000 + v * dt, POLE_Z, 4096);
    expect((b - a) * 4096).toBeCloseTo(screenSpeed(v, POLE_Z) * dt, 6);
  });

  it("haze more with distance, and shade towards the horizon colour", () => {
    expect(hazeAt(0)).toBe(0);
    expect(hazeAt(50)).toBeLessThan(hazeAt(400));
    const out: Rgb = [0, 0, 0];
    shadeLayer(out, [0.5, 0.5, 0.5], [1, 0.5, 1], [1, 1, 1], 0);
    expect(out).toEqual([0.5, 0.25, 0.5]);
    shadeLayer(out, [0.5, 0.5, 0.5], [1, 1, 1], [1, 0, 0], 1e6);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(0, 6);
  });
});

describe("tables", () => {
  it("tile seamlessly in every channel", () => {
    let ok = true;
    for (const seed of [0, 5, 999]) {
      const h = hillTable(seed);
      const f = fieldTable(seed);
      const b = bankTable(seed);
      for (let ch = 0; ch < HILL_CHANNELS; ch++)
        ok &&= seamless(h, HILL_COLUMNS, HILL_CHANNELS, ch);
      // R (heights) and B (hedges) are continuous; G (field tone) steps at a field edge.
      for (const ch of [0, 2, 3]) ok &&= seamless(f, FIELD_COLUMNS, FIELD_CHANNELS, ch);
      for (let ch = 0; ch < BANK_CHANNELS; ch++)
        ok &&= seamless(b, BANK_COLUMNS, BANK_CHANNELS, ch);
    }
    expect(ok).toBe(true);
  });

  it("have a hedge where the field tone changes, including across the seam", () => {
    const f = fieldTable(5);
    let ok = true;
    for (let c = 0; c < FIELD_COLUMNS; c++) {
      const prev = (c + FIELD_COLUMNS - 1) % FIELD_COLUMNS;
      if (f[c * FIELD_CHANNELS + 1] !== f[prev * FIELD_CHANNELS + 1]) {
        if (Math.max(f[c * FIELD_CHANNELS + 2], f[prev * FIELD_CHANNELS + 2]) < 0.5) ok = false;
      }
    }
    expect(ok).toBe(true);
  });

  it("are deterministic per seed and differ between seeds", () => {
    expect(fieldTable(7)).toEqual(fieldTable(7));
    expect(hillTable(7)).toEqual(hillTable(7));
    expect(bankTable(7)).toEqual(bankTable(7));
    expect(fieldTable(7)).not.toEqual(fieldTable(8));
    expect(hillTable(7)).not.toEqual(hillTable(8));
    expect(bankTable(7)).not.toEqual(bankTable(8));
  });

  it("keep heights in their bands", () => {
    const h = hillTable(3);
    const f = fieldTable(3);
    const b = bankTable(3);
    let ok = true;
    for (let c = 0; c < HILL_COLUMNS; c++) {
      if (h[c * 2] < 20 || h[c * 2] > 130 || h[c * 2 + 1] < 8 || h[c * 2 + 1] > 80) ok = false;
    }
    for (let c = 0; c < FIELD_COLUMNS; c++) {
      const o = c * FIELD_CHANNELS;
      if (f[o] < 0.25 || f[o] > 6 || f[o + 1] < 0 || f[o + 1] > 1 || f[o + 3] < 0 || f[o + 3] > 1) {
        ok = false;
      }
    }
    for (let c = 0; c < BANK_COLUMNS; c++) {
      if (b[c * 2] < 155 || b[c * 2] > 215 || b[c * 2 + 1] < 0 || b[c * 2 + 1] > 1) ok = false;
    }
    expect(ok).toBe(true);
  });

  it("return their tallest point", () => {
    const f = new Float32Array(FIELD_COLUMNS * FIELD_CHANNELS);
    const maxF = fillFieldTable(f, 9);
    const b = new Float32Array(BANK_COLUMNS * BANK_CHANNELS);
    const maxB = fillBankTable(b, 9);
    let mf = 0;
    let mb = 0;
    for (let c = 0; c < FIELD_COLUMNS; c++) mf = Math.max(mf, f[c * FIELD_CHANNELS]);
    for (let c = 0; c < BANK_COLUMNS; c++) mb = Math.max(mb, b[c * 2]);
    expect(maxF).toBeCloseTo(mf, 4);
    expect(maxB).toBeCloseTo(mb, 3);
  });

  it("read back continuously across the wrap, as REPEAT filtering does", () => {
    const b = bankTable(1);
    const lo = sampleTable(b, BANK_COLUMNS, BANK_CHANNELS, 0, 1 - 1e-7);
    const hi = sampleTable(b, BANK_COLUMNS, BANK_CHANNELS, 0, 1e-7);
    expect(Math.abs(lo - hi)).toBeLessThan(0.01);
    // At a texel centre the read is the texel.
    expect(sampleTable(b, BANK_COLUMNS, BANK_CHANNELS, 0, 10.5 / BANK_COLUMNS)).toBeCloseTo(
      b[20],
      5,
    );
    expect(BANK_PERIOD % BANK_COLUMNS).toBe(0);
    expect(HILL_PERIOD % HILL_COLUMNS).toBe(0);
    expect(FIELD_PERIOD).toBeGreaterThan(0);
  });
});

describe("train", () => {
  it("starts at speed, then eases to a new speed and direction without jumps", () => {
    const train = createTrain();
    stepTrain(train, 1 / 60, 0.5, 1);
    expect(train.v).toBeCloseTo(0.5 * V_MAX, 9);
    let ok = true;
    let prevV = train.v;
    let prevPos = train.pos;
    for (let i = 0; i < 600; i++) {
      stepTrain(train, 1 / 60, 0.5, -1);
      if (Math.abs(train.v - prevV) > 0.011 || Math.abs(train.pos - prevPos) > V_MAX / 60)
        ok = false;
      prevV = train.v;
      prevPos = train.pos;
    }
    expect(ok).toBe(true);
    expect(train.v).toBeCloseTo(-0.5 * V_MAX, 9);
  });

  it("stands still at speed 0", () => {
    const train = createTrain();
    stepTrain(train, 0.1, 0, 1);
    stepTrain(train, 0.1, 0, 1);
    expect(train.pos).toBe(0);
  });
});

describe("poles and wires", () => {
  it("are evenly spaced and scroll with the train", () => {
    const xs = new Float64Array(16);
    const off = poleOffset(12.345);
    const n = polePositions(off, 1920, xs);
    expect(off).toBeGreaterThanOrEqual(0);
    expect(off).toBeLessThan(POLE_SPACING);
    let ok = xs[0] <= 0 && xs[n - 1] >= 1920;
    for (let i = 1; i < n; i++) {
      if (Math.abs(xs[i] - xs[i - 1] - POLE_SPACING) > 1e-9) ok = false;
    }
    expect(ok).toBe(true);
    // A small step moves the poles left by the pole layer's screen speed.
    const step = poleOffset(12.345 + 0.01) - off;
    expect(step).toBeCloseTo((0.01 * FOCAL) / POLE_Z, 6);
  });

  it("connect the attachment points of consecutive poles, sagging by the same amount in each span", () => {
    const xs = new Float64Array(16);
    const off = poleOffset(77.7);
    const n = polePositions(off, 1920, xs);
    let ok = true;
    for (let w = 0; w < WIRE_Y.length; w++) {
      for (let i = 0; i + 1 < n; i++) {
        const a = xs[i] + WIRE_DX[w];
        const b = xs[i + 1] + WIRE_DX[w];
        // Both ends at the attachment height, from either side.
        for (const x of [a, b]) {
          if (Math.abs(wireHeight(w, x + 1e-6, off) - WIRE_Y[w]) > 1e-3) ok = false;
          if (Math.abs(wireHeight(w, x - 1e-6, off) - WIRE_Y[w]) > 1e-3) ok = false;
        }
        // The lowest point, mid-span.
        if (Math.abs(wireHeight(w, (a + b) / 2, off) - (WIRE_Y[w] - WIRE_SAG[w])) > 1e-6)
          ok = false;
        // Symmetric about mid-span.
        const q = (b - a) / 4;
        if (Math.abs(wireHeight(w, a + q, off) - wireHeight(w, b - q, off)) > 1e-6) ok = false;
      }
    }
    expect(ok).toBe(true);
  });
});

describe("houses", () => {
  it("slide by the house layer's screen speed and stay in view only near the frame", () => {
    const houses = new Float64Array(MAX_HOUSES * HOUSE_FLOATS);
    placeHouses(houses, 4);
    const out = new Float32Array(MAX_HOUSES * 4);
    const look = new Float32Array(MAX_HOUSES * 4);
    // Put house 0 in the middle of the view.
    const pos = houses[0];
    const n = viewHouses(houses, pos, 1920, 1, out, look);
    expect(n).toBeGreaterThan(0);
    expect(out[0]).toBeCloseTo(960, 6);
    expect(out[1]).toBeCloseTo((houses[1] * FOCAL) / HOUSE_Z, 4);
    viewHouses(houses, pos + 1, 1920, 1, out, look);
    expect(out[0]).toBeCloseTo(960 - FOCAL / HOUSE_Z, 4);
    let ok = true;
    for (let p = 0; p < 2000; p += 3.7) {
      const m = viewHouses(houses, p, 1920, 0.5, out, look);
      for (let i = 0; i < m; i++) {
        if (Math.abs(out[i * 4] - 960) > 960 + out[i * 4 + 1] * 1.4 + 2) ok = false;
        if (look[i * 4] !== 0 && look[i * 4] !== 0.5) ok = false;
      }
    }
    expect(ok).toBe(true);
  });
});

describe("sway", () => {
  it("stays within its amplitude and is still when off or standing", () => {
    let ok = true;
    let peak = 0;
    for (let t = 0; t < 60; t += 0.05) {
      const s = swayOffset(t, 1, 0.5);
      peak = Math.max(peak, Math.abs(s));
      if (Math.abs(s) > SWAY_AMP + 1e-9) ok = false;
      if (swayOffset(t, 0, 0.5) !== 0 || swayOffset(t, 1, 0) !== 0) ok = false;
    }
    expect(ok).toBe(true);
    expect(peak).toBeGreaterThan(SWAY_AMP * 0.6);
  });
});

describe("time of day", () => {
  it("snaps on the first step, then travels through the keys smoothly", () => {
    const state = createTimeState();
    expect(stepTime(state, 1 / 60, 3)).toBe(3);
    const look = { hour: 0, sunX: 0, sunY: 0 };
    let ok = true;
    let prev = sampleTime(state.pos, look).hour;
    for (let i = 0; i < 300; i++) {
      stepTime(state, 1 / 60, 0);
      const h = sampleTime(state.pos, look).hour;
      if (h > prev + 1e-9 || prev - h > 0.5) ok = false;
      prev = h;
    }
    expect(ok).toBe(true);
    expect(state.pos).toBe(0);
    expect(sampleTime(2, look)).toEqual({ ...TIME_KEYS[2] });
  });

  it("maps option values to keys, falling back to golden hour", () => {
    expect(timeIndex("morning")).toBe(0);
    expect(timeIndex("dusk")).toBe(3);
    expect(timeIndex("nope")).toBe(2);
  });

  it("lights the lamps at dusk only", () => {
    const sky = createSkyState();
    const amount = (i: number) => {
      sampleSky(TIME_KEYS[i].hour / 24, sky);
      return lampAmount(sky.light);
    };
    expect(amount(0)).toBe(0);
    expect(amount(1)).toBe(0);
    expect(amount(2)).toBeLessThan(0.2);
    expect(amount(3)).toBeGreaterThan(0.7);
  });
});
