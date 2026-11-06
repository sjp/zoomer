import { describe, expect, it } from "vitest";
import type { Rgb } from "./color";
import {
  advanceDrift,
  advancePhase,
  centreIndex,
  centreOffset,
  CENTRES,
  footprintGain,
  MAX_SCALE,
  MAX_WAVES,
  MIN_SCALE,
  MIN_WAVELENGTH_PX,
  paletteColor,
  paletteData,
  PALETTES,
  patternValue,
  SYMMETRIES,
  TAU,
  tone,
  toneScale,
  wavelengthPx,
  waveCount,
  writeDirections,
  writeWaves,
} from "./quasi-sim";
import { CENTRE_OPTIONS, PALETTE_OPTIONS, quasiMeta, SYMMETRY_OPTIONS } from "./quasi.meta";

describe("options", () => {
  it("match the sim's names and limits", () => {
    expect(SYMMETRY_OPTIONS.map((o) => waveCount(o.value))).toEqual([...SYMMETRIES]);
    expect(PALETTE_OPTIONS.map((o) => o.value).toSorted()).toEqual(
      Object.keys(PALETTES).toSorted(),
    );
    expect(CENTRE_OPTIONS.map((o) => o.value)).toEqual([...CENTRES]);
    expect(quasiMeta.params.scale.min).toBe(MIN_SCALE);
    expect(quasiMeta.params.scale.max).toBe(MAX_SCALE);
    expect(Math.max(...SYMMETRIES)).toBe(MAX_WAVES);
  });

  it("fall back for unknown names", () => {
    expect(waveCount("nope")).toBe(7);
    expect(waveCount("6")).toBe(7);
    expect(centreIndex("nope")).toBe(1);
    expect(centreIndex("drifting")).toBe(2);
    expect(paletteData("nope")).toBe(paletteData("pastel"));
  });
});

describe("directions", () => {
  it("are unit length and evenly spaced by π / n", () => {
    const dirs = new Float64Array(2 * MAX_WAVES);
    let worst = 0;
    for (const n of SYMMETRIES) {
      writeDirections(n, dirs);
      for (let k = 0; k < n; k++) {
        worst = Math.max(worst, Math.abs(Math.hypot(dirs[2 * k], dirs[2 * k + 1]) - 1));
        const j = (k + 1) % n;
        // Angle between neighbours; the last wraps to the first's opposite.
        const dot = dirs[2 * k] * dirs[2 * j] + dirs[2 * k + 1] * dirs[2 * j + 1];
        const expected = j === 0 ? -Math.cos(Math.PI / n) : Math.cos(Math.PI / n);
        worst = Math.max(worst, Math.abs(dot - expected));
      }
    }
    expect(worst).toBeLessThan(1e-12);
  });
});

describe("phase", () => {
  it("advances at the speed and stays in [0, 2π)", () => {
    let p = 0;
    let bad = 0;
    for (let i = 0; i < 5000; i++) {
      p = advancePhase(p, 0.05, 2);
      if (!(p >= 0 && p < TAU)) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    expect(advancePhase(1, 1, 0)).toBe(1);
    expect(advancePhase(0.1, 1, -1)).toBeGreaterThan(Math.PI);
    expect(advancePhase(Number.NaN, Number.NaN, Number.NaN)).toBe(0);
  });

  it("wraps without a jump in the pattern", () => {
    const n = 7;
    const dirs = writeDirections(n, new Float64Array(2 * MAX_WAVES));
    const a = new Float32Array(3 * MAX_WAVES);
    const b = new Float32Array(3 * MAX_WAVES);
    const f = TAU / 120;
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const phase = 0.3 * i;
      writeWaves(dirs, n, f, phase, 900, 400, a);
      writeWaves(dirs, n, f, phase + TAU, 900, 400, b);
      for (let s = 0; s < 50; s++) {
        const x = s * 71.3;
        const y = s * 37.9;
        worst = Math.max(worst, Math.abs(patternValue(a, n, x, y) - patternValue(b, n, x, y)));
      }
    }
    // A wrapped step across 2π moves the pattern as little as an ordinary step.
    const step = advancePhase(TAU - 0.001, 0.01, 1);
    expect(step).toBeLessThan(0.01);
    writeWaves(dirs, n, f, TAU - 0.001, 0, 0, a);
    writeWaves(dirs, n, f, step, 0, 0, b);
    expect(Math.abs(patternValue(a, n, 333, 777) - patternValue(b, n, 333, 777))).toBeLessThan(
      0.01,
    );
    expect(worst).toBeLessThan(1e-4);
  });

  it("drifts with period 1", () => {
    const a = centreOffset(2, 0.2, new Float64Array(2));
    const b = centreOffset(2, advanceDrift(0.2, 240), new Float64Array(2));
    expect(b[0]).toBeCloseTo(a[0], 9);
    expect(b[1]).toBeCloseTo(a[1], 9);
    expect([...centreOffset(0, 0.3, new Float64Array(2))]).toEqual([0, 0]);
  });
});

describe("pattern", () => {
  it("matches the direct formula and stays in [-1, 1]", () => {
    const dirs = new Float64Array(2 * MAX_WAVES);
    const waves = new Float32Array(3 * MAX_WAVES);
    let worst = 0;
    let outside = 0;
    for (const n of SYMMETRIES) {
      writeDirections(n, dirs);
      const f = TAU / 90;
      writeWaves(dirs, n, f, 1.3, 500, 300, waves);
      for (let s = 0; s < 400; s++) {
        const x = (s * 97.31) % 3840;
        const y = (s * 53.17) % 2160;
        const v = patternValue(waves, n, x, y);
        let d = 0;
        for (let k = 0; k < n; k++) {
          d += Math.cos(f * ((x - 500) * dirs[2 * k] + (y - 300) * dirs[2 * k + 1]) + 1.3);
        }
        worst = Math.max(worst, Math.abs(v - d / n));
        if (v < -1 || v > 1) {
          outside++;
        }
      }
    }
    expect(outside).toBe(0);
    expect(worst).toBeLessThan(1e-4);
  });

  it("peaks at 1 at the centre when the phase is 0", () => {
    const n = 9;
    const dirs = writeDirections(n, new Float64Array(2 * MAX_WAVES));
    const waves = new Float32Array(3 * MAX_WAVES);
    writeWaves(dirs, n, TAU / 100, 0, 640, 360, waves);
    expect(patternValue(waves, n, 640, 360)).toBeCloseTo(1, 5);
  });

  it("tones into (0, 1), shrinking towards 0.5 with contrast", () => {
    let bad = 0;
    for (const n of SYMMETRIES) {
      for (let i = 0; i <= 40; i++) {
        const v = -1 + i / 20;
        const t = tone(v, n, 1);
        if (!(t > 0 && t < 1)) {
          bad++;
        }
        if (Math.abs(tone(v, n, 0.4) - 0.5) > 0.2 + 1e-12) {
          bad++;
        }
        if (tone(v, n, 0) !== 0.5) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(tone(0.3, 7, 1)).toBeGreaterThan(tone(0.1, 7, 1));
    expect(toneScale(7, 1) * 7 * 0.2).toBeCloseTo(0.2 * 7 * (1.6 / Math.sqrt(7)), 12);
  });
});

describe("wavelength clamp", () => {
  it("keeps the wavelength above the minimum at every supported size", () => {
    let bad = 0;
    for (const height of [240, 360, 480, 720, 1080, 1440, 2160, 4320]) {
      const viewScale = height / 1080;
      for (let s = MIN_SCALE - 20; s <= MAX_SCALE + 20; s += 5) {
        const l = wavelengthPx(s, viewScale);
        if (l < MIN_WAVELENGTH_PX) {
          bad++;
        }
        const clamped = Math.min(Math.max(s, MIN_SCALE), MAX_SCALE) * viewScale;
        if (l !== Math.max(clamped, MIN_WAVELENGTH_PX)) {
          bad++;
        }
      }
    }
    expect(bad).toBe(0);
    expect(wavelengthPx(Number.NaN, 2)).toBe(MIN_SCALE * 2);
    expect(wavelengthPx(120, 2)).toBe(240);
  });

  it("filters little at the minimum wavelength", () => {
    expect(footprintGain(MIN_WAVELENGTH_PX)).toBeGreaterThan(0.97);
    expect(footprintGain(MIN_WAVELENGTH_PX)).toBeLessThan(1);
    expect(footprintGain(1e6)).toBeCloseTo(1, 9);
  });
});

describe("palettes", () => {
  it("hit the end stops and stay in gamut", () => {
    const out: Rgb = [0, 0, 0];
    let bad = 0;
    for (const name of Object.keys(PALETTES)) {
      const d = paletteData(name);
      paletteColor(d, 0, out);
      for (let c = 0; c < 3; c++) {
        if (Math.abs(out[c] - d[c]) > 1e-6) {
          bad++;
        }
      }
      paletteColor(d, 1, out);
      for (let c = 0; c < 3; c++) {
        if (Math.abs(out[c] - d[9 + c]) > 1e-6) {
          bad++;
        }
      }
      paletteColor(d, 1 / 3, out);
      for (let c = 0; c < 3; c++) {
        if (Math.abs(out[c] - d[3 + c]) > 1e-6) {
          bad++;
        }
      }
      for (let i = 0; i <= 30; i++) {
        paletteColor(d, i / 30, out);
        for (let c = 0; c < 3; c++) {
          if (!(out[c] >= 0 && out[c] <= 1)) {
            bad++;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });
});
