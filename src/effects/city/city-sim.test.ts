import { describe, expect, it } from "vitest";
import {
  BEACON_STRIDE,
  beaconPulse,
  createAircraft,
  CATCH_UP_SECONDS,
  createWindowState,
  FADE_SECONDS,
  FADE_SLOTS,
  generateCity,
  LAYERS,
  MAX_QUADS,
  MAX_WINDOWS,
  QUAD_STRIDE,
  REF_HEIGHT,
  STAR_STRIDE,
  strobe,
} from "./city-sim";
import { MAX_TOGGLE_RATE } from "./city.meta";

describe("generateCity", () => {
  it("is deterministic for a seed", () => {
    const a = generateCity(7, 0.5, 1920);
    const b = generateCity(7, 0.5, 1920);
    expect(b.quadCount).toBe(a.quadCount);
    expect(b.windowCount).toBe(a.windowCount);
    expect(b.buildings).toEqual(a.buildings);
    expect(b.quads).toEqual(a.quads);
    expect(b.beacons).toEqual(a.beacons);
    expect(generateCity(8, 0.5, 1920).buildings).not.toEqual(a.buildings);
  });

  it.each([
    [1, 0, 1920],
    [2, 0.5, 1920],
    [3, 1, 1920],
    [4, 1, 3840],
    [5, 0.3, 1440],
    [6, 0.8, 200],
    [7, 1, 8000],
  ])("keeps seed %d, density %d, width %d inside the frame", (seed, density, w) => {
    const c = generateCity(seed, density, w);
    expect(c.buildings.length).toBeGreaterThan(0);
    for (const b of c.buildings) {
      const spec = LAYERS[b.layer];
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.width).toBeGreaterThan(0);
      expect(b.x + b.width).toBeLessThanOrEqual(w + 1e-3);
      expect(b.height).toBeGreaterThanOrEqual(spec.lo * REF_HEIGHT - 1e-3);
      expect(b.height).toBeLessThanOrEqual(spec.hi * REF_HEIGHT + 1e-3);
    }
    let windows = 0;
    for (let i = 0; i < c.quadCount; i++) {
      const o = i * QUAD_STRIDE;
      const [x, top, qw, qh, , , cols, rows] = c.quads.subarray(o, o + 8);
      expect(x).toBeGreaterThanOrEqual(-1e-3);
      expect(x + qw).toBeLessThanOrEqual(w + 1e-3);
      // The skyline (antennas included) stays in the lower part of the frame.
      expect(top).toBeGreaterThan(0.3 * REF_HEIGHT);
      expect(top + qh).toBeLessThanOrEqual(REF_HEIGHT + 1e-3);
      // Windows are numbered consecutively, quad by quad.
      expect(c.quads[o + 12]).toBe(windows);
      windows += cols * rows;
    }
    expect(windows).toBe(c.windowCount);
    expect(c.windowCount).toBeLessThanOrEqual(MAX_WINDOWS);
    expect(c.quadCount).toBeLessThanOrEqual(MAX_QUADS);
    for (let i = 0; i < c.starCount; i++) {
      expect(c.stars[i * STAR_STRIDE + 1]).toBeLessThan(0.4 * REF_HEIGHT);
    }
    for (let i = 0; i < c.beaconCount; i++) {
      const phase = c.beacons[i * BEACON_STRIDE + 3];
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
  });

  it("builds a busier skyline at higher density", () => {
    const sparse = generateCity(3, 0, 1920).buildings.length;
    const dense = generateCity(3, 1, 1920).buildings.length;
    expect(dense).toBeGreaterThan(sparse * 1.5);
  });

  it("covers all three layers, far ones lower", () => {
    const c = generateCity(11, 0.5, 1920);
    for (let layer = 0; layer < LAYERS.length; layer++) {
      expect(c.buildings.some((b) => b.layer === layer)).toBe(true);
    }
    expect(LAYERS[0].hi).toBeLessThan(LAYERS[2].hi);
  });
});

describe("createWindowState", () => {
  const litFraction = (s: ReturnType<typeof createWindowState>) => s.litCount / s.windowCount;

  it("lights the requested fraction exactly on reset", () => {
    const s = createWindowState(5000);
    s.reset(4000, 1, 0.3);
    expect(s.litCount).toBe(1200);
    let counted = 0;
    for (let i = 0; i < 4000; i++) {
      counted += s.isLit(i) ? 1 : 0;
    }
    expect(counted).toBe(1200);
    s.reset(4000, 1, 0);
    expect(s.litCount).toBe(0);
    s.reset(4000, 1, 1);
    expect(s.litCount).toBe(4000);
  });

  it("reaches a new target through fades even with no activity, a few windows a frame", () => {
    const s = createWindowState(5000);
    s.reset(3000, 3, 0.3);
    s.setTarget(0.31);
    let most = 0;
    let t = 0;
    for (; t < 10 && s.litCount !== 930; t += 1 / 60) {
      const before = s.litCount;
      s.step(1 / 60, 0);
      most = Math.max(most, Math.abs(s.litCount - before));
      // Every toggle starts a fade: nothing is lit or unlit in one step.
      expect(s.fading).toBe(true);
    }
    expect(s.litCount).toBe(930);
    expect(t).toBeLessThan(CATCH_UP_SECONDS * 3);
    expect(most).toBeLessThan(5);
    // Then it rests: no toggles at rate 0.
    for (let k = 0; k < 120; k++) {
      s.step(1 / 60, 0);
    }
    expect(s.litCount).toBe(930);
    expect(s.fading).toBe(false);
  });

  it("keeps the lit fraction near the target over time", () => {
    for (const target of [0.2, 0.35, 0.5]) {
      const s = createWindowState(5000);
      s.reset(3000, 2, target);
      // Plain comparisons in the hot loop: an expect per step dominates the runtime.
      const off: string[] = [];
      for (let t = 0; t < 3000; t += 1 / 30) {
        s.step(1 / 30, 2);
        const err = Math.abs(litFraction(s) - target);
        if (!(err < 0.002) && off.length < 10) {
          off.push(`t ${String(t)}: lit ${String(litFraction(s))}`);
        }
      }
      expect(off, `target ${String(target)}`).toEqual([]);
    }
  });

  it("fades windows towards a new target gradually, without touching any at once", () => {
    const s = createWindowState(2000);
    s.reset(1000, 4, 0.1);
    s.setTarget(0.5);
    expect(s.litCount).toBe(100);
    s.step(1 / 30, 20);
    expect(s.litCount).toBeLessThan(110);
    for (let t = 0; t < 60; t += 1 / 30) {
      s.step(1 / 30, 20);
    }
    // Activity keeps toggling round the target, a window either side.
    expect(Math.abs(s.litCount - 500)).toBeLessThanOrEqual(1);
  });

  it("toggles windows at about the requested rate, and not at all at rate 0", () => {
    const s = createWindowState(2000);
    s.reset(1000, 3, 0.4);
    let toggles = 0;
    for (let t = 0; t < 600; t += 1 / 60) {
      s.step(1 / 60, 0.5);
      for (let n = 0; n < s.dirtyCount; n++) {
        // A fade start has a slot; a settle has none.
        if (s.data[s.dirty[n] * 4 + 3] !== 0) {
          toggles++;
        }
      }
    }
    expect(toggles).toBeGreaterThan(250);
    expect(toggles).toBeLessThan(350);
    // The top of the slider keeps up too: the fade slots never run out.
    s.reset(1000, 3, 0.4);
    toggles = 0;
    for (let t = 0; t < 60; t += 1 / 60) {
      s.step(1 / 60, MAX_TOGGLE_RATE);
      for (let n = 0; n < s.dirtyCount; n++) {
        if (s.data[s.dirty[n] * 4 + 3] !== 0) {
          toggles++;
        }
      }
    }
    expect(toggles).toBeGreaterThan(MAX_TOGGLE_RATE * 60 * 0.85);
    expect(toggles).toBeLessThan(MAX_TOGGLE_RATE * 60 * 1.15);
    s.reset(1000, 3, 0.4);
    for (let t = 0; t < 60; t += 1 / 60) {
      s.step(1 / 60, 0);
      expect(s.dirtyCount).toBe(0);
    }
  });

  it("fades over FADE_SECONDS and then settles", () => {
    const s = createWindowState(100);
    s.reset(50, 4, 0.5);
    let window = -1;
    for (let t = 0; t < 30 && window < 0; t += 1 / 60) {
      s.step(1 / 60, 2);
      for (let n = 0; n < s.dirtyCount; n++) {
        if (s.data[s.dirty[n] * 4 + 3] !== 0) {
          window = s.dirty[n];
        }
      }
    }
    expect(window).toBeGreaterThanOrEqual(0);
    const o = window * 4;
    const slot = s.data[o + 3] - 1;
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(FADE_SLOTS);
    // From one level to the other, one of them dark.
    expect(Math.min(s.data[o], s.data[o + 1])).toBe(0);
    expect(Math.max(s.data[o], s.data[o + 1])).toBeGreaterThanOrEqual(150);
    const to = s.data[o + 1];
    let age = 0;
    let decreased = false;
    while (s.data[o + 3] !== 0 && age < 2) {
      const before = s.fade[slot];
      s.step(1 / 60, 0);
      age += 1 / 60;
      decreased ||= s.data[o + 3] !== 0 && s.fade[slot] < before;
    }
    expect(decreased).toBe(false);
    expect(age).toBeLessThan(FADE_SECONDS + 0.05);
    expect(age).toBeGreaterThan(FADE_SECONDS - 0.05);
    expect(s.data[o]).toBe(to);
    expect(s.data[o + 1]).toBe(to);
  });

  it("handles an empty city", () => {
    const s = createWindowState(10);
    s.reset(0, 1, 0.5);
    s.step(0.1, 2);
    expect(s.litCount).toBe(0);
  });
});

describe("lights", () => {
  it("pulses beacons smoothly between a dim floor and full", () => {
    expect(beaconPulse(0)).toBeCloseTo(0.06);
    expect(beaconPulse(0.5)).toBeCloseTo(1);
    expect(beaconPulse(1)).toBeCloseTo(beaconPulse(0));
  });

  it("blinks the strobe briefly once per period", () => {
    expect(strobe(0.12)).toBeGreaterThan(0.9);
    expect(strobe(0.75)).toBeLessThan(0.01);
    expect(strobe(1.5 + 0.12)).toBeCloseTo(strobe(0.12));
  });

  it("flies an aircraft across the frame in about 30 s, rarely", () => {
    const plane = createAircraft(5);
    let flights = 0;
    let wasActive = false;
    let start = 0;
    const heights: number[] = [];
    const durations: number[] = [];
    for (let t = 0; t < 600; t += 1 / 30) {
      plane.step(1 / 30, 1920, true);
      if (plane.active && !wasActive) {
        flights++;
        start = t;
        heights.push(plane.y);
      }
      if (!plane.active && wasActive) {
        durations.push(t - start);
      }
      wasActive = plane.active;
    }
    expect(Math.max(...heights)).toBeLessThan(0.35 * REF_HEIGHT);
    expect(Math.min(...durations)).toBeGreaterThan(24);
    expect(Math.max(...durations)).toBeLessThan(36);
    expect(flights).toBeGreaterThan(3);
    expect(flights).toBeLessThan(12);
    plane.step(1 / 30, 1920, false);
    expect(plane.active).toBe(false);
  });
});
