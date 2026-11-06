import { describe, expect, it } from "vitest";
import {
  buildFilmTable,
  cieXyz,
  drainProfile,
  entryThickness,
  filmMode,
  MAX_THICKNESS,
  reflectance,
  TABLE_SIZE,
} from "./film-sim";

const MODES = ["soap", "oil", "pearl"] as const;

function srgbToLinear(b: number): number {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** First entry index at or after `from` whose RGB satisfies `test`, or -1. */
function findEntry(
  t: Uint8Array,
  from: number,
  test: (r: number, g: number, b: number) => boolean,
): number {
  for (let i = from; i < TABLE_SIZE; i++) {
    if (test(t[i * 4], t[i * 4 + 1], t[i * 4 + 2])) {
      return i;
    }
  }
  return -1;
}

describe("optics helpers", () => {
  it("has a vanishing reflectance for a vanishing film", () => {
    expect(reflectance(0, 550, 1.33)).toBe(0);
    // Quarter-wave optical thickness reflects fully.
    expect(reflectance(550 / (4 * 1.33), 550, 1.33)).toBeCloseTo(1, 10);
  });

  it("peaks the CIE fit where the real functions peak", () => {
    const out = [0, 0, 0];
    cieXyz(555, out);
    const y555 = out[1];
    cieXyz(450, out);
    expect(out[1]).toBeLessThan(y555);
    expect(out[2]).toBeGreaterThan(1.5);
    cieXyz(600, out);
    expect(out[0]).toBeGreaterThan(1);
  });

  it("maps unknown modes to soap", () => {
    expect(filmMode("oil")).toBe("oil");
    expect(filmMode("pearl")).toBe("pearl");
    expect(filmMode("nope")).toBe("soap");
  });
});

describe("buildFilmTable", () => {
  it("covers 0..MAX_THICKNESS", () => {
    expect(entryThickness(0)).toBe(0);
    expect(entryThickness(TABLE_SIZE - 1)).toBe(MAX_THICKNESS);
  });

  it("is black with zero alpha at d = 0 in soap mode", () => {
    const t = buildFilmTable("soap", 1);
    expect([t[0], t[1], t[2], t[3]]).toEqual([0, 0, 0, 0]);
  });

  it("normalises brightness so the brightest channel just reaches full scale", () => {
    for (const mode of ["soap", "oil"]) {
      for (const sat of [0, 0.5, 1]) {
        const t = buildFilmTable(mode, sat);
        let max = 0;
        for (let i = 0; i < TABLE_SIZE; i++) {
          for (let c = 0; c < 3; c++) {
            max = Math.max(max, t[i * 4 + c]);
          }
        }
        expect(max).toBe(255);
      }
    }
  });

  it("is continuous in linear light", () => {
    for (const mode of MODES) {
      for (const sat of [0, 0.85, 1]) {
        const t = buildFilmTable(mode, sat);
        for (let i = 1; i < TABLE_SIZE; i++) {
          for (let c = 0; c < 3; c++) {
            const jump = Math.abs(srgbToLinear(t[i * 4 + c]) - srgbToLinear(t[i * 4 - 4 + c]));
            expect(jump).toBeLessThan(0.08);
          }
          expect(Math.abs(t[i * 4 + 3] - t[i * 4 - 1])).toBeLessThan(30);
        }
      }
    }
  });

  it("is grey at zero saturation", () => {
    const t = buildFilmTable("soap", 0);
    for (let i = 0; i < TABLE_SIZE; i++) {
      expect(Math.abs(t[i * 4] - t[i * 4 + 1])).toBeLessThanOrEqual(1);
      expect(Math.abs(t[i * 4 + 1] - t[i * 4 + 2])).toBeLessThanOrEqual(1);
    }
  });

  it("orders the first-order colours yellow, magenta, blue (Newton's series)", () => {
    for (const mode of ["soap", "oil"]) {
      const t = buildFilmTable(mode, 1);
      // Past the first-order white: thickness above ~90 nm.
      const start = Math.ceil((90 / MAX_THICKNESS) * (TABLE_SIZE - 1));
      const yellow = findEntry(t, start, (r, g, b) => r > 150 && g > 120 && b < 0.6 * g);
      const magenta = findEntry(t, yellow, (r, g, b) => r > g + 40 && b > g + 20);
      const blue = findEntry(t, magenta, (r, g, b) => b > r + 60 && b > g + 60);
      expect(yellow).toBeGreaterThan(0);
      expect(magenta).toBeGreaterThan(yellow);
      expect(blue).toBeGreaterThan(magenta);
      // All within the first order (below ~300 nm).
      expect(entryThickness(blue)).toBeLessThan(300);
    }
  });

  it("makes pearl pale and mostly opaque", () => {
    const t = buildFilmTable("pearl", 1);
    for (let i = 0; i < TABLE_SIZE; i++) {
      for (let c = 0; c < 3; c++) {
        expect(t[i * 4 + c]).toBeGreaterThan(150);
      }
      expect(t[i * 4 + 3]).toBeGreaterThan(100);
    }
  });

  it("writes into a given buffer and treats NaN saturation as 1", () => {
    const out = new Uint8Array(TABLE_SIZE * 4);
    expect(buildFilmTable("oil", Number.NaN, out)).toBe(out);
    expect(out).toEqual(buildFilmTable("oil", 1));
  });
});

describe("drainProfile", () => {
  it("thins monotonically towards the top", () => {
    let prev = Infinity;
    for (let k = 0; k <= 200; k++) {
      const v = drainProfile(k / 200);
      expect(v).toBeLessThanOrEqual(prev);
      expect(v).toBeGreaterThanOrEqual(0);
      prev = v;
    }
    expect(drainProfile(1)).toBeLessThan(0.15);
  });

  it("averages about 1, so the thickness param stays the mean", () => {
    let sum = 0;
    const n = 1000;
    for (let k = 0; k < n; k++) {
      sum += drainProfile((k + 0.5) / n);
    }
    expect(sum / n).toBeGreaterThan(0.9);
    expect(sum / n).toBeLessThan(1.1);
  });

  it("clamps out-of-range heights", () => {
    expect(drainProfile(-1)).toBe(drainProfile(0));
    expect(drainProfile(2)).toBe(drainProfile(1));
  });
});
