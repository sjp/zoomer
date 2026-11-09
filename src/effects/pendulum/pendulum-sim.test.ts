import { describe, expect, it } from "vitest";
import {
  advanceClock,
  BALL_FLOATS,
  BAR_LINES,
  baseOscillations,
  createPendulumRig,
  hsvToRgb,
  LINE_FLOATS,
  lengthRatio,
  type PendulumClock,
  SHADOW_FLOATS,
  swingAngle,
} from "./pendulum-sim";
import { MAX_AMPLITUDE, MAX_PENDULUMS, MIN_PENDULUMS } from "./pendulum.meta";

const TAU = 2 * Math.PI;
const DEG = Math.PI / 180;
const VIEWS = ["front", "angled", "above"] as const;
const WIDTHS = [1440, 1920, 2520];

const buffers = () => ({
  balls: new Float32Array(MAX_PENDULUMS * BALL_FLOATS),
  strings: new Float32Array(MAX_PENDULUMS * LINE_FLOATS),
  bar: new Float32Array(BAR_LINES * LINE_FLOATS),
  shadows: new Float32Array((MAX_PENDULUMS + 1) * SHADOW_FLOATS),
});

describe("swing", () => {
  it("realigns every pendulum exactly at multiples of the cycle", () => {
    let worst = 0;
    for (const n of [8, 25, 50]) {
      for (let k = 0; k <= 4; k++) {
        // Wrapped clock values at t = kT: u = 0, phase = 2π N k mod 2π = 0.
        const a0 = swingAngle(0, 0, 0, 0.2);
        for (let i = 1; i < 24; i++) {
          worst = Math.max(worst, Math.abs(swingAngle(i, 0, 0, 0.2) - a0));
        }
        // And the unwrapped formula at t = kT.
        for (let i = 0; i < 24; i++) {
          const a = 0.2 * Math.cos((TAU * (n + i) * k * 60) / 60);
          worst = Math.max(worst, Math.abs(a - 0.2));
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("stays in line after stepping the clock through whole cycles, even with a change of N", () => {
    const c: PendulumClock = { phase: 0, u: 0 };
    const cycle = 45;
    let spread = 0;
    // One cycle at N = 19, one at N = 30, in uneven steps summing to each cycle.
    for (const n of [19, 30]) {
      for (let s = 0; s < 900; s++) {
        advanceClock(c, (cycle / 900) * (s % 2 ? 0.5 : 1.5), cycle, n);
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 24; i++) {
        const a = swingAngle(i, c.phase, c.u, 0.2);
        lo = Math.min(lo, a);
        hi = Math.max(hi, a);
      }
      spread = Math.max(spread, hi - lo);
    }
    expect(spread).toBeLessThan(1e-9);
  });

  it("matches A cos(2π (N + i) t / T) for a steady N", () => {
    const c: PendulumClock = { phase: 0, u: 0 };
    const cycle = 60;
    const n = 25;
    let t = 0;
    let worst = 0;
    for (let s = 0; s < 2000; s++) {
      const dt = 0.0167 + 0.003 * Math.sin(s);
      advanceClock(c, dt, cycle, n);
      t += dt;
      for (let i = 0; i < 24; i += 5) {
        const want = 0.3 * Math.cos((TAU * (n + i) * t) / cycle);
        worst = Math.max(worst, Math.abs(swingAngle(i, c.phase, c.u, 0.3) - want));
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("drifts out of step between alignments", () => {
    const angles = [];
    for (let i = 0; i < 15; i++) {
      angles.push(swingAngle(i, 0, 0.3, 1));
    }
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(1);
  });

  it("keeps angles within the amplitude, and continuous through a cycle change", () => {
    const rig = createPendulumRig();
    rig.configure({ count: 24, view: "angled", placement: "top", refWidth: 1920 });
    let over = 0;
    let jump = 0;
    const prev = new Float64Array(24);
    for (let s = 0; s < 1200; s++) {
      const cycle = s < 600 ? 30 : 120;
      rig.update(1 / 60, cycle, 14);
      for (let i = 0; i < 24; i++) {
        const a = rig.angle[i];
        if (Math.abs(a) > 14 * DEG + 1e-12) {
          over++;
        }
        if (s > 0) {
          jump = Math.max(jump, Math.abs(a - prev[i]));
        }
        prev[i] = a;
      }
    }
    expect(over).toBe(0);
    // A swing step at 60 fps is small; a jump of the whole wave would not be.
    expect(jump).toBeLessThan(0.1);
  });
});

describe("lengths", () => {
  it("decrease monotonically along the row, following L ∝ 1 / f²", () => {
    let bad = 0;
    for (const n of [8, 24, 50]) {
      for (let i = 1; i < 24; i++) {
        if (!(lengthRatio(i, n) < lengthRatio(i - 1, n))) {
          bad++;
        }
        // L f² is constant, with f ∝ N + i.
        const lf2 = lengthRatio(i, n) * (n + i) ** 2;
        if (Math.abs(lf2 - n * n) > 1e-9 * n * n) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(lengthRatio(0, 25)).toBe(1);
  });

  it("are monotonic in the rig, the longest first", () => {
    const rig = createPendulumRig();
    let bad = 0;
    for (let count = MIN_PENDULUMS; count <= MAX_PENDULUMS; count++) {
      rig.configure({ count, view: "front", placement: "left", refWidth: 1920 });
      rig.update(0.1, 60, 10);
      for (let i = 1; i < count; i++) {
        if (!(rig.length[i] < rig.length[i - 1])) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("base oscillations give a natural slowest period and keep the rig's spread bounded", () => {
    expect(baseOscillations(60, 15)).toBe(25);
    expect(baseOscillations(120, 8)).toBe(50);
    // At least `count`, so the shortest string is over a quarter of the longest.
    expect(baseOscillations(30, 24)).toBe(24);
    expect(lengthRatio(23, baseOscillations(30, 24))).toBeGreaterThan(0.25);
  });
});

describe("placement", () => {
  it("keeps the side rigs out of the central band", () => {
    const rig = createPendulumRig();
    const b = buffers();
    let bad = 0;
    let checked = 0;
    for (const placement of ["left", "right"] as const) {
      for (const view of VIEWS) {
        for (const width of WIDTHS) {
          for (const count of [MIN_PENDULUMS, 15, MAX_PENDULUMS]) {
            for (const scale of [1, 2]) {
              rig.configure({ count, view, placement, refWidth: width });
              const third = (width * scale) / 3;
              for (let s = 0; s < 40; s++) {
                rig.update(s === 0 ? 0 : 0.37, 30, MAX_AMPLITUDE);
                rig.fill(scale, "chrome", b.balls, b.strings, b.bar, b.shadows);
                let lo = Infinity;
                let hi = -Infinity;
                const st = rig.state;
                for (let j = 0; j < st.ballCount; j++) {
                  const o = j * BALL_FLOATS;
                  lo = Math.min(lo, b.balls[o] - b.balls[o + 2]);
                  hi = Math.max(hi, b.balls[o] + b.balls[o + 2]);
                }
                for (let j = 0; j < st.barCount; j++) {
                  const o = j * LINE_FLOATS;
                  const hw = b.bar[o + 7];
                  lo = Math.min(lo, b.bar[o] - hw, b.bar[o + 2] - hw);
                  hi = Math.max(hi, b.bar[o] + hw, b.bar[o + 2] + hw);
                }
                if (
                  placement === "left"
                    ? !(lo > 0 && hi < third)
                    : !(lo > 2 * third && hi < 3 * third)
                ) {
                  bad++;
                }
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
    expect(bad).toBe(0);
  });

  it("keeps the top rig inside the frame's top half", () => {
    const rig = createPendulumRig();
    const b = buffers();
    let bad = 0;
    for (const view of VIEWS) {
      for (const width of WIDTHS) {
        rig.configure({ count: MAX_PENDULUMS, view, placement: "top", refWidth: width });
        for (let s = 0; s < 30; s++) {
          rig.update(s === 0 ? 0 : 0.41, 30, MAX_AMPLITUDE);
          rig.fill(1, "brass", b.balls, b.strings, b.bar, b.shadows);
          for (let j = 0; j < rig.state.ballCount; j++) {
            const o = j * BALL_FLOATS;
            const r = b.balls[o + 2];
            if (b.balls[o] - r < 0 || b.balls[o] + r > width) {
              bad++;
            }
            if (b.balls[o + 1] - r < 0 || b.balls[o + 1] + r > 540) {
              bad++;
            }
          }
        }
      }
    }
    expect(bad).toBe(0);
  });
});

describe("frame data", () => {
  it("draws balls farthest first, nearer ones larger and brighter", () => {
    const rig = createPendulumRig();
    const b = buffers();
    rig.configure({ count: 15, view: "angled", placement: "top", refWidth: 1920 });
    rig.update(0, 60, 15);
    // Mid-cycle, so the swings spread toward and away from the viewer.
    rig.update(17.3, 60, 15);
    rig.fill(1, "chrome", b.balls, b.strings, b.bar, b.shadows);
    let minR = Infinity;
    let maxR = 0;
    let minL = Infinity;
    let maxL = 0;
    for (let j = 0; j < 15; j++) {
      const o = j * BALL_FLOATS;
      minR = Math.min(minR, b.balls[o + 2]);
      maxR = Math.max(maxR, b.balls[o + 2]);
      minL = Math.min(minL, b.balls[o + 3]);
      maxL = Math.max(maxL, b.balls[o + 3]);
    }
    expect(maxR).toBeGreaterThan(minR);
    expect(maxL).toBeGreaterThan(minL + 0.05);
    expect(minL).toBeGreaterThanOrEqual(0.6);
    expect(maxL).toBeLessThanOrEqual(1.4);
  });

  it("connects each string from the bar to its ball", () => {
    const rig = createPendulumRig();
    const b = buffers();
    rig.configure({ count: 12, view: "front", placement: "right", refWidth: 1920 });
    rig.update(0, 60, 12);
    rig.update(3.1, 60, 12);
    rig.fill(1, "coloured", b.balls, b.strings, b.bar, b.shadows);
    const heads = new Set<string>();
    for (let j = 0; j < 12; j++) {
      heads.add(`${String(b.balls[j * BALL_FLOATS])},${String(b.balls[j * BALL_FLOATS + 1])}`);
    }
    let bad = 0;
    const barY = b.bar[1];
    for (let i = 0; i < 12; i++) {
      const o = i * LINE_FLOATS;
      if (!heads.has(`${String(b.strings[o + 2])},${String(b.strings[o + 3])}`)) {
        bad++;
      }
      // Front view: the pivots lie on the bar.
      if (Math.abs(b.strings[o + 1] - barY) > 1e-3) {
        bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("tints coloured balls distinctly and metal balls alike", () => {
    const rig = createPendulumRig();
    const b = buffers();
    rig.configure({ count: 10, view: "above", placement: "top", refWidth: 1920 });
    rig.update(0, 60, 12);
    rig.fill(1, "coloured", b.balls, b.strings, b.bar, b.shadows);
    const colours = new Set<string>();
    for (let j = 0; j < 10; j++) {
      const o = j * BALL_FLOATS;
      colours.add(
        `${b.balls[o + 4].toFixed(3)},${b.balls[o + 5].toFixed(3)},${b.balls[o + 6].toFixed(3)}`,
      );
      expect(b.balls[o + 7]).toBe(0);
    }
    expect(colours.size).toBe(10);
    rig.fill(1, "chrome", b.balls, b.strings, b.bar, b.shadows);
    colours.clear();
    for (let j = 0; j < 10; j++) {
      const o = j * BALL_FLOATS;
      colours.add(
        `${String(b.balls[o + 4])},${String(b.balls[o + 5])},${String(b.balls[o + 6])},${String(b.balls[o + 7])}`,
      );
    }
    expect(colours.size).toBe(1);
  });

  it("casts one soft shadow per ball plus the bar's, all finite", () => {
    const rig = createPendulumRig();
    const b = buffers();
    let bad = 0;
    for (const view of VIEWS) {
      rig.configure({ count: 20, view, placement: "left", refWidth: 1920 });
      rig.update(0, 60, 12);
      rig.fill(2, "chrome", b.balls, b.strings, b.bar, b.shadows);
      if (rig.state.shadowCount !== 21) {
        bad++;
      }
      for (let j = 0; j < rig.state.shadowCount * SHADOW_FLOATS; j++) {
        if (!Number.isFinite(b.shadows[j])) {
          bad++;
        }
      }
      for (let j = 0; j < rig.state.shadowCount; j++) {
        const o = j * SHADOW_FLOATS;
        if (!(b.shadows[o + 5] > 0) || !(b.shadows[o + 6] > 0 && b.shadows[o + 6] < 1)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("puts the key light in front of the balls", () => {
    const rig = createPendulumRig();
    for (const view of VIEWS) {
      rig.configure({ count: 15, view, placement: "top", refWidth: 1920 });
      const [x, y, z] = rig.state.key;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 9);
      expect(z).toBeGreaterThan(0);
    }
  });
});

describe("hsvToRgb", () => {
  it("converts the primaries", () => {
    const out = new Float32Array(3);
    hsvToRgb(0, 1, 1, out, 0);
    expect([...out]).toEqual([1, 0, 0]);
    hsvToRgb(1 / 3, 1, 1, out, 0);
    expect(out[1]).toBeCloseTo(1, 6);
    expect(out[0]).toBeCloseTo(0, 6);
    hsvToRgb(0.5, 0, 0.5, out, 0);
    expect([...out]).toEqual([0.5, 0.5, 0.5]);
  });
});
