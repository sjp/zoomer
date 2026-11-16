import { describe, expect, it } from "vitest";
import { createRng } from "../noise";
import {
  advanceKeyframes,
  createKeyframeTargets,
  updateKeyframes,
  KEYFRAME_INTERVAL,
  keyframeMix,
  PALETTES,
  paletteColor,
  type KeyframeClock,
} from "./blobs";

describe("paletteColor", () => {
  it("looks up presets and wraps the index", () => {
    expect(paletteColor("ocean", [], 0)).toBe(PALETTES.ocean[0]);
    expect(paletteColor("ocean", [], 5)).toBe(PALETTES.ocean[1]);
    expect(paletteColor("mono", [], -1)).toBe(PALETTES.mono[3]);
  });

  it("uses custom colours only for 'custom'", () => {
    const custom = ["#000001", "#000002", "#000003", "#000004"];
    expect(paletteColor("custom", custom, 2)).toBe("#000003");
    expect(paletteColor("custom", custom, 4)).toBe("#000001");
    expect(paletteColor("candy", custom, 2)).toBe(PALETTES.candy[2]);
  });

  it("falls back to dusk for unknown names and empty custom lists", () => {
    expect(paletteColor("nope", [], 1)).toBe(PALETTES.dusk[1]);
    expect(paletteColor("constructor", [], 1)).toBe(PALETTES.dusk[1]);
    expect(paletteColor("custom", [], 1)).toBe(PALETTES.dusk[1]);
  });
});

describe("advanceKeyframes", () => {
  const T = KEYFRAME_INTERVAL;

  it("renders both on reset", () => {
    const c: KeyframeClock = { elapsed: 0.02 };
    expect(advanceKeyframes(c, 0.001, T, true)).toBe(2);
    expect(c.elapsed).toBe(0);
  });

  it("renders one keyframe per interval at 120 Hz and cross-fades in between", () => {
    const c: KeyframeClock = { elapsed: 0 };
    let renders = 0;
    let lastMix = -1;
    let monotonic = true;
    for (let i = 0; i < 120; i++) {
      const due = advanceKeyframes(c, 1 / 120, T, false);
      expect(due).not.toBe(2);
      renders += due;
      const m = keyframeMix(c, T);
      // Between keyframes the B weight only grows.
      if (due === 0 && m <= lastMix) {
        monotonic = false;
      }
      lastMix = m;
    }
    expect(monotonic).toBe(true);
    // One second at 120 Hz -> ~30 low-res renders instead of 120.
    expect(renders).toBeGreaterThanOrEqual(29);
    expect(renders).toBeLessThanOrEqual(31);
  });

  it("carries the remainder over a keyframe so the mix stays continuous", () => {
    const c: KeyframeClock = { elapsed: T * 0.9 };
    expect(advanceKeyframes(c, T * 0.3, T, false)).toBe(1);
    expect(c.elapsed).toBeCloseTo(T * 0.2, 12);
    expect(keyframeMix(c, T)).toBeCloseTo(0.2, 9);
  });

  it("re-renders both after a gap of two intervals or more", () => {
    const c: KeyframeClock = { elapsed: 0 };
    expect(advanceKeyframes(c, 2 * T, T, false)).toBe(2);
    expect(c.elapsed).toBe(0);
    expect(advanceKeyframes(c, 5, T, false)).toBe(2);
  });

  it("still interpolates at display rates below the keyframe rate", () => {
    const c: KeyframeClock = { elapsed: 0 };
    expect(advanceKeyframes(c, 1 / 24, T, false)).toBe(1);
    expect(keyframeMix(c, T)).toBeGreaterThan(0);
    expect(keyframeMix(c, T)).toBeLessThan(1);
  });

  it("ignores bad dt and treats a non-positive interval as always fresh", () => {
    const c: KeyframeClock = { elapsed: 0.01 };
    expect(advanceKeyframes(c, Number.NaN, T, false)).toBe(0);
    expect(advanceKeyframes(c, -1, T, false)).toBe(0);
    expect(c.elapsed).toBe(0.01);
    expect(advanceKeyframes(c, 0.001, 0, false)).toBe(2);
    expect(keyframeMix(c, 0)).toBe(0);
  });
});

describe("updateKeyframes", () => {
  const T = KEYFRAME_INTERVAL;

  /** Runs the clock and targets like `frame`, recording each render. */
  function harness() {
    const clock: KeyframeClock = { elapsed: 0 };
    const keys = createKeyframeTargets();
    const renders: [0 | 1, number][] = [];
    let time = 0;
    let lastSpeed = Number.NaN;
    return {
      keys,
      clock,
      renders,
      get time() {
        return time;
      },
      frame(dt: number, speed: number, invalid = false) {
        time += dt * speed;
        const due = advanceKeyframes(clock, dt, T, invalid);
        updateKeyframes(keys, due, invalid, time, speed, speed !== lastSpeed, clock, T, (k, t) => {
          renders.push([k, t]);
        });
        lastSpeed = speed;
      },
      /** The sim time the blit shows: A cross-faded towards B. */
      shown() {
        const a = keys.held[keys.mainIsA ? 0 : 1];
        const b = keys.held[keys.mainIsA ? 1 : 0];
        return a + keyframeMix(clock, T) * (b - a);
      },
    };
  }

  it("renders both keyframes on the first frame, A now and B one interval ahead", () => {
    const h = harness();
    h.frame(1 / 60, 0.5, true);
    expect(h.renders).toEqual([
      [0, 0.5 / 60],
      [1, 0.5 / 60 + 0.5 * T],
    ]);
    expect(h.keys.mainIsA).toBe(true);
  });

  it("shows the current sim time at a steady speed, whatever the frame rate", () => {
    const h = harness();
    const rng = createRng(9);
    h.frame(1 / 60, 0.3, true);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      // 20 to 240 Hz, with the odd hitch and the odd invalidation.
      const dt = rng() < 0.01 ? 0.1 : 1 / (20 + 220 * rng());
      h.frame(dt, 0.3, rng() < 0.01);
      worst = Math.max(worst, Math.abs(h.shown() - h.time));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("renders one keyframe per interval at 120 Hz, alternating targets", () => {
    const h = harness();
    h.frame(1 / 120, 1, true);
    h.renders.length = 0;
    for (let i = 0; i < 120; i++) {
      h.frame(1 / 120, 1);
    }
    expect(h.renders.length).toBeGreaterThanOrEqual(29);
    expect(h.renders.length).toBeLessThanOrEqual(31);
    for (let i = 1; i < h.renders.length; i++) {
      expect(h.renders[i][0]).not.toBe(h.renders[i - 1][0]);
      expect(h.renders[i][1]).toBeCloseTo(h.renders[i - 1][1] + T, 9);
    }
  });

  it("re-renders only B for a speed change, and the shown time catches up", () => {
    const h = harness();
    h.frame(1 / 120, 1, true);
    h.frame(1 / 120, 1);
    h.renders.length = 0;
    const b = h.keys.mainIsA ? 1 : 0;
    h.frame(1 / 120, 2);
    expect(h.renders).toHaveLength(1);
    expect(h.renders[0][0]).toBe(b);
    // B now lands where the new speed will have taken the sim at its show time.
    expect(h.keys.held[b]).toBeCloseTo(h.time + 2 * (T - h.clock.elapsed), 12);
    // A was rendered at the old speed: the cross-fade lags by at most (2 - 1) * T / 4...
    expect(Math.abs(h.shown() - h.time)).toBeLessThanOrEqual(T / 4 + 1e-12);
    // ...until A is replaced, one interval later.
    for (let i = 0; i < 6; i++) {
      h.frame(1 / 120, 2);
    }
    expect(Math.abs(h.shown() - h.time)).toBeLessThan(1e-9);
  });

  it("re-renders both targets after an invalidation, but nothing it already holds", () => {
    const h = harness();
    h.frame(1 / 120, 0, true);
    h.renders.length = 0;
    // Paused: both keyframes hold the same time, so nothing new is rendered...
    for (let i = 0; i < 10; i++) {
      h.frame(1 / 120, 0);
    }
    expect(h.renders).toEqual([]);
    // ...until the image changes.
    h.frame(1 / 120, 0, true);
    expect(h.renders.map((r) => r[0])).toEqual([0, 1]);
  });
});
