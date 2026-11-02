import { describe, expect, it } from "vitest";
import {
  advanceKeyframes,
  BLOB_PATHS,
  blobAt,
  hexToLinear,
  KEYFRAME_INTERVAL,
  keyframeMix,
  makeBlobPaths,
  MAX_BLOBS,
  PALETTES,
  paletteColor,
  writeBlobUniforms,
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

describe("hexToLinear", () => {
  it("maps endpoints and darkens mid-tones", () => {
    expect(hexToLinear("#000000")).toEqual([0, 0, 0]);
    expect(hexToLinear("#ffffff")).toEqual([1, 1, 1]);
    const [r] = hexToLinear("#808080");
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.25);
  });
});

describe("blob paths", () => {
  it("are deterministic", () => {
    expect(makeBlobPaths()).toEqual(BLOB_PATHS);
    expect(BLOB_PATHS).toHaveLength(MAX_BLOBS);
  });

  it("stay near the frame with radius 30-60% of height (x1.15 breathing)", () => {
    const out = [0, 0, 0];
    for (const path of BLOB_PATHS) {
      for (let t = 0; t < 600; t += 0.37) {
        blobAt(path, t, 16 / 9, 1, out);
        expect(out[0]).toBeGreaterThanOrEqual(0);
        expect(out[0]).toBeLessThanOrEqual(16 / 9);
        expect(out[1]).toBeGreaterThanOrEqual(0);
        expect(out[1]).toBeLessThanOrEqual(1);
        expect(out[2]).toBeGreaterThanOrEqual(0.3 * 0.85 - 1e-9);
        expect(out[2]).toBeLessThanOrEqual(0.6 * 1.15 + 1e-9);
      }
    }
  });

  it("move slowly: under 0.6 frame heights per second at speed 1", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const dt = 0.01;
    for (const path of BLOB_PATHS) {
      for (let t = 0; t < 120; t += 0.5) {
        blobAt(path, t, 16 / 9, 1, a);
        blobAt(path, t + dt, 16 / 9, 1, b);
        expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toBeLessThan(0.6);
      }
    }
  });

  it("have main loop periods of tens of seconds at the default speed (0.3)", () => {
    for (const p of BLOB_PATHS) {
      for (const w of [p.wx, p.wy]) {
        const period = (2 * Math.PI) / (w * 0.3);
        expect(period).toBeGreaterThan(25);
        expect(period).toBeLessThan(60);
      }
    }
  });

  it("scale radius by softness", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    blobAt(BLOB_PATHS[0], 3, 1, 1, a);
    blobAt(BLOB_PATHS[0], 3, 1, 1.5, b);
    expect(b[2]).toBeCloseTo(a[2] * 1.5, 6);
  });
});

describe("writeBlobUniforms", () => {
  it("writes Gaussian exponents and zero-weights unused slots", () => {
    const out = new Float32Array(MAX_BLOBS * 4).fill(9);
    writeBlobUniforms(out, 3, 2, 1.5, 1);
    const xyr = [0, 0, 0];
    blobAt(BLOB_PATHS[1], 2, 1.5, 1, xyr);
    expect(out[4]).toBeCloseTo(xyr[0], 5);
    expect(out[5]).toBeCloseTo(xyr[1], 5);
    // exp2(-r² k) = 1/e at one radius.
    expect(2 ** (-xyr[2] * xyr[2] * out[6])).toBeCloseTo(Math.exp(-1), 5);
    expect(out[7]).toBe(1);
    for (let i = 3 * 4; i < out.length; i++) expect(out[i]).toBe(0);
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
      if (due === 0 && m <= lastMix) monotonic = false;
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
