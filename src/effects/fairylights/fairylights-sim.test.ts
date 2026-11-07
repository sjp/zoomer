import { describe, expect, it } from "vitest";
import {
  BOKEH_RADIUS,
  BULB_FLOATS,
  BULB_SPACING,
  CHASE_DEPTH,
  CHASE_HZ,
  chaseLevel,
  createFairyLights,
  type FairyFrame,
  type FairyLayout,
  PALETTES,
  REF_HEIGHT,
  swagSag,
  TWINKLE_DEPTH,
  TWINKLE_MAX_HZ,
  twinkleLevel,
  WIRE_FLOATS,
} from "./fairylights-sim";

const MAX_BULBS = 1024;
const MAX_POINTS = 2048;
const WIDTHS = [1440, 1920, 2520];

const frame = (over: Partial<FairyFrame> = {}): FairyFrame => ({
  time: 0,
  twinkle: 0.6,
  pattern: "twinkle",
  focus: 0.7,
  scale: 1,
  palette: PALETTES.warm,
  wall: [0.11, 0.08, 0.07],
  wire: [0.03, 0.02, 0.02],
  ...over,
});

const built = (strings: number, layout: FairyLayout, seed: number, refWidth = 1920) => {
  const sim = createFairyLights(MAX_BULBS, MAX_POINTS);
  sim.build({ strings, layout, seed, refWidth });
  return sim;
};

describe("swags", () => {
  it("sag downward between their anchors, most at the middle", () => {
    expect(swagSag(100, 0)).toBe(0);
    expect(swagSag(100, 1)).toBe(0);
    expect(swagSag(100, 0.5)).toBe(100);
    expect(swagSag(100, 0.25)).toBeGreaterThan(0);
    expect(swagSag(100, 0.25)).toBeLessThan(100);
  });

  it("pass through their anchors: each string starts and ends at a wire point above its sag", () => {
    let bad = 0;
    for (let seed = 0; seed < 20; seed++) {
      const sim = built(4, "swags", seed);
      for (let s = 0; s < sim.stringCount; s++) {
        const first = sim.stringFirst[s];
        const last = first + sim.stringPoints[s] - 1;
        // Ends at the anchors, spanning a little past the frame on both sides.
        if (!(sim.pointX[first] < 0 && sim.pointX[last] > 1920)) {
          bad++;
        }
        // The middle of each swag hangs below the straight line between its anchors.
        for (let i = first; i + 40 <= last; i += 40) {
          const mid = i + 20;
          const chord = (sim.pointY[i] + sim.pointY[i + 40]) / 2;
          if (!(sim.pointY[mid] > chord + 10)) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("space bulbs evenly along the wire", () => {
    let bad = 0;
    let even = 0;
    let checked = 0;
    for (let seed = 0; seed < 10; seed++) {
      const sim = built(3, "swags", seed);
      for (let b = 1; b < sim.bulbCount; b++) {
        const s = sim.bulbString[b];
        if (sim.bulbString[b - 1] !== s) {
          continue;
        }
        const gap = Math.hypot(sim.bulbX[b] - sim.bulbX[b - 1], sim.bulbY[b] - sim.bulbY[b - 1]);
        const spacing = BULB_SPACING * (1 - 0.3 * sim.stringDepth[s]);
        checked++;
        // Chords are a little shorter than the arc where the wire bends, and
        // shortest across the kink at an anchor.
        if (!(gap <= spacing + 1e-6 && gap > spacing * 0.75)) {
          bad++;
        }
        if (gap > spacing * 0.97) {
          even++;
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(bad).toBe(0);
    expect(even / checked).toBeGreaterThan(0.9);
  });

  it("never hang into the middle third of the frame, swaying or not", () => {
    let lowest = -Infinity;
    for (const width of WIDTHS) {
      for (let strings = 1; strings <= 4; strings++) {
        for (let seed = 0; seed < 25; seed++) {
          const sim = built(strings, "swags", seed, width);
          const bulbs = new Float32Array(MAX_BULBS * BULB_FLOATS);
          const wires = new Float32Array(MAX_POINTS * WIRE_FLOATS);
          for (let t = 0; t < 30; t += 1.7) {
            const n = sim.step(frame({ time: t, focus: 1 }), bulbs, wires);
            for (let i = 0; i < n; i++) {
              const o = i * BULB_FLOATS;
              lowest = Math.max(lowest, bulbs[o + 1] + bulbs[o + 2]);
            }
            for (let i = 0; i < sim.wireCount; i++) {
              const o = i * WIRE_FLOATS;
              lowest = Math.max(lowest, wires[o + 1], wires[o + 3]);
            }
          }
        }
      }
    }
    expect(lowest).toBeGreaterThan(REF_HEIGHT * 0.15);
    expect(lowest).toBeLessThanOrEqual(REF_HEIGHT / 3);
  });

  it("are deterministic per seed and differ between seeds", () => {
    const a = built(3, "both", 5);
    const b = built(3, "both", 5);
    const c = built(3, "both", 6);
    expect(a.bulbCount).toBe(b.bulbCount);
    expect(Array.from(a.bulbX.subarray(0, a.bulbCount))).toEqual(
      Array.from(b.bulbX.subarray(0, b.bulbCount)),
    );
    expect(Array.from(a.bulbY.subarray(0, 20))).not.toEqual(Array.from(c.bulbY.subarray(0, 20)));
  });
});

describe("curtain", () => {
  it("hangs strands down the side edges, clear of the middle third", () => {
    let bad = 0;
    for (const width of WIDTHS) {
      for (let seed = 0; seed < 20; seed++) {
        const sim = built(4, "curtain", seed, width);
        expect(sim.stringCount).toBe(10);
        const bulbs = new Float32Array(MAX_BULBS * BULB_FLOATS);
        const wires = new Float32Array(MAX_POINTS * WIRE_FLOATS);
        for (let t = 0; t < 30; t += 2.3) {
          const n = sim.step(frame({ time: t, focus: 1 }), bulbs, wires);
          for (let i = 0; i < n; i++) {
            const x = bulbs[i * BULB_FLOATS];
            const r = bulbs[i * BULB_FLOATS + 2];
            if (x + r > width / 3 && x - r < (2 * width) / 3) {
              bad++;
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("adds strands to the swags in the 'both' layout", () => {
    const swags = built(2, "swags", 1);
    const both = built(2, "both", 1);
    expect(both.stringCount).toBe(swags.stringCount + 6);
    expect(both.bulbCount).toBeGreaterThan(swags.bulbCount);
  });
});

describe("twinkle and chase", () => {
  it("keep twinkling bulbs within their bounds and below the frequency cap", () => {
    expect(TWINKLE_MAX_HZ).toBeLessThan(0.5);
    const sim = built(4, "both", 3);
    const f = frame({ twinkle: 1 });
    let lo = Infinity;
    let hi = -Infinity;
    let steepest = 0;
    const dt = 1 / 30;
    for (let i = 0; i < sim.bulbCount; i += 7) {
      f.time = 0;
      let prev = sim.level(i, f);
      for (let t = dt; t < 40; t += dt) {
        f.time = t;
        const v = sim.level(i, f);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        steepest = Math.max(steepest, Math.abs(v - prev) / dt);
        prev = v;
      }
    }
    expect(lo).toBeGreaterThanOrEqual(1 - TWINKLE_DEPTH - 1e-9);
    expect(hi).toBeLessThanOrEqual(1 + 1e-9);
    // Swings by at least half its range somewhere.
    expect(hi - lo).toBeGreaterThan(TWINKLE_DEPTH * 0.5);
    // Two sines of amplitude TWINKLE_DEPTH / 4 below 0.5 Hz change at most this fast.
    expect(steepest).toBeLessThanOrEqual((TWINKLE_DEPTH / 4) * 2 * Math.PI * 0.5 * 2);
  });

  it("scales the twinkle with its amount, and holds steady bulbs at full", () => {
    expect(twinkleLevel(1.3, 0.1, 0.2, 0.2, 0.4, 0)).toBe(1);
    const sim = built(2, "swags", 0);
    let off = 0;
    for (let t = 0; t < 20; t += 0.5) {
      for (let i = 0; i < sim.bulbCount; i++) {
        if (sim.level(i, frame({ time: t, pattern: "steady", twinkle: 1 })) !== 1) {
          off++;
        }
      }
    }
    expect(off).toBe(0);
  });

  it("runs the chase slowly along the string, never fully off", () => {
    expect(CHASE_HZ).toBeLessThan(0.5);
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < 20; k++) {
      for (let t = 0; t < 30; t += 0.1) {
        const v = chaseLevel(k, t);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    expect(lo).toBeGreaterThanOrEqual(1 - CHASE_DEPTH - 1e-9);
    expect(hi).toBeLessThanOrEqual(1 + 1e-9);
    // The wave moves along: the next bulb reaches the same level a little later.
    const later = 1 / (7 * CHASE_HZ);
    expect(chaseLevel(1, later)).toBeCloseTo(chaseLevel(0, 0), 9);
  });
});

describe("rendering data", () => {
  it("blurs far strings into larger discs and drops their wires", () => {
    const sim = built(3, "swags", 2);
    const bulbs = new Float32Array(MAX_BULBS * BULB_FLOATS);
    const wires = new Float32Array(MAX_POINTS * WIRE_FLOATS);
    const sharp = sim.step(frame({ focus: 0 }), bulbs, wires);
    const allWires = sim.wireCount;
    let maxBlur = 0;
    for (let i = 0; i < sharp; i++) {
      maxBlur = Math.max(maxBlur, bulbs[i * BULB_FLOATS + 7]);
    }
    expect(maxBlur).toBe(0);

    const n = sim.step(frame({ focus: 1 }), bulbs, wires);
    expect(sim.wireCount).toBeLessThan(allWires);
    let biggest = 0;
    for (let i = 0; i < n; i++) {
      biggest = Math.max(biggest, bulbs[i * BULB_FLOATS + 2]);
    }
    expect(biggest).toBeGreaterThan(BOKEH_RADIUS * 0.6);
    expect(biggest).toBeLessThanOrEqual(BOKEH_RADIUS);
  });

  it("scales positions and sizes to device pixels", () => {
    const sim = built(2, "swags", 4);
    const a = new Float32Array(MAX_BULBS * BULB_FLOATS);
    const b = new Float32Array(MAX_BULBS * BULB_FLOATS);
    const wires = new Float32Array(MAX_POINTS * WIRE_FLOATS);
    const n = sim.step(frame({ time: 3 }), a, wires);
    sim.step(frame({ time: 3, scale: 2 }), b, wires);
    let bad = 0;
    for (let i = 0; i < n * BULB_FLOATS; i++) {
      const k = i % BULB_FLOATS;
      const expected = k < 3 ? a[i] * 2 : a[i];
      if (Math.abs(b[i] - expected) > 1e-3) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("stays within its capacities on a very wide frame", () => {
    const sim = createFairyLights(200, 300);
    sim.build({ strings: 4, layout: "both", seed: 1, refWidth: 8000 });
    expect(sim.bulbCount).toBeLessThanOrEqual(200);
    expect(sim.pointCount).toBeLessThanOrEqual(300);
    const n = sim.step(
      frame(),
      new Float32Array(200 * BULB_FLOATS),
      new Float32Array(300 * WIRE_FLOATS),
    );
    expect(n).toBeLessThanOrEqual(200);
  });
});
