import { describe, expect, it } from "vitest";
import {
  BLUR_RANGE,
  blurWidth,
  buildGrainTexture,
  FLUTE_SQUASH,
  fluteCoord,
  fluteOffset,
  GLASS,
  glassPreset,
  GRAIN_SIZE,
  MAIN_PERIOD,
  makeShapePaths,
  PALETTES,
  ROTATE_PERIOD,
  SHAPE_OPACITY,
  SHAPE_PATHS,
  shapeAt,
  shapeColor,
  WOBBLE_PERIOD,
  writeShapeUniforms,
} from "./frosted-sim";
import { MAX_SHAPES } from "./frosted.meta";

describe("shapeColor", () => {
  it("looks up presets and repeats every three shapes", () => {
    expect(shapeColor("lagoon", [], 0)).toBe(PALETTES.lagoon[0]);
    expect(shapeColor("lagoon", [], 4)).toBe(PALETTES.lagoon[1]);
    expect(shapeColor("slate", [], -1)).toBe(PALETTES.slate[2]);
  });

  it("uses custom colours only for 'custom' and falls back to dusk", () => {
    const custom = ["#000001", "#000002", "#000003"];
    expect(shapeColor("custom", custom, 3)).toBe("#000001");
    expect(shapeColor("ember", custom, 1)).toBe(PALETTES.ember[1]);
    expect(shapeColor("nope", [], 1)).toBe(PALETTES.dusk[1]);
    expect(shapeColor("constructor", [], 1)).toBe(PALETTES.dusk[1]);
    expect(shapeColor("custom", [], 2)).toBe(PALETTES.dusk[2]);
  });
});

describe("glassPreset", () => {
  it("maps each option and falls back to frosted", () => {
    expect(glassPreset("reeded")).toBe(GLASS.reeded);
    expect(glassPreset("clear")).toBe(GLASS.clear);
    expect(glassPreset("toString")).toBe(GLASS.frosted);
  });

  it("only reeded glass has flutes, and clear-ish blurs least", () => {
    expect(GLASS.reeded.flute).toBe(1);
    expect(GLASS.frosted.flute).toBe(0);
    expect(GLASS.clear.flute).toBe(0);
    expect(GLASS.clear.blur).toBeLessThan(GLASS.reeded.blur);
    expect(GLASS.reeded.blur).toBeLessThan(GLASS.frosted.blur);
  });
});

describe("shape paths", () => {
  it("are deterministic and include every kind", () => {
    expect(makeShapePaths()).toEqual(SHAPE_PATHS);
    expect(SHAPE_PATHS).toHaveLength(MAX_SHAPES);
    // Even the minimum of two shapes isn't two of the same.
    expect(SHAPE_PATHS[0].kind).not.toBe(SHAPE_PATHS[1].kind);
    expect(new Set(SHAPE_PATHS.map((s) => s.kind))).toEqual(new Set(["disc", "capsule", "ring"]));
  });

  it("have consistent geometry per kind", () => {
    for (const s of SHAPE_PATHS) {
      expect(s.radius).toBeGreaterThan(0);
      expect(s.halfLen > 0).toBe(s.kind === "capsule");
      expect(s.ringHalf > 0).toBe(s.kind === "ring");
      expect(s.ringHalf).toBeLessThan(s.radius);
    }
  });

  it("keep centres inside the frame", () => {
    const out = [0, 0, 0];
    for (const path of SHAPE_PATHS) {
      for (let t = 0; t < 900; t += 0.71) {
        shapeAt(path, t, 16 / 9, out);
        expect(out[0]).toBeGreaterThan(0.05 * (16 / 9));
        expect(out[0]).toBeLessThan(0.95 * (16 / 9));
        expect(out[1]).toBeGreaterThan(0.05);
        expect(out[1]).toBeLessThan(0.95);
      }
    }
  });

  it("loop in 30-90 s at speed 1", () => {
    const period = (w: number) => (2 * Math.PI) / Math.abs(w);
    for (const p of SHAPE_PATHS) {
      for (const w of [p.wx, p.wy]) {
        expect(period(w)).toBeGreaterThanOrEqual(MAIN_PERIOD[0]);
        expect(period(w)).toBeLessThanOrEqual(MAIN_PERIOD[1]);
      }
      for (const w of [p.wx2, p.wy2]) {
        expect(period(w)).toBeGreaterThanOrEqual(WOBBLE_PERIOD[0]);
        expect(period(w)).toBeLessThanOrEqual(WOBBLE_PERIOD[1]);
      }
      expect(period(p.wr)).toBeGreaterThanOrEqual(ROTATE_PERIOD[0]);
      expect(period(p.wr)).toBeLessThanOrEqual(ROTATE_PERIOD[1]);
    }
    expect(MAIN_PERIOD[0]).toBeGreaterThanOrEqual(30);
    expect(MAIN_PERIOD[1]).toBeLessThanOrEqual(90);
  });

  it("move slowly: under 0.1 frame heights per second at speed 1", () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const dt = 0.01;
    for (const path of SHAPE_PATHS) {
      for (let t = 0; t < 120; t += 0.5) {
        shapeAt(path, t, 16 / 9, a);
        shapeAt(path, t + dt, 16 / 9, b);
        expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toBeLessThan(0.1);
      }
    }
  });
});

describe("writeShapeUniforms", () => {
  it("writes centre, rotation, geometry and opacity for the first count shapes", () => {
    const a = new Float32Array(MAX_SHAPES * 4).fill(9);
    const b = new Float32Array(MAX_SHAPES * 4).fill(9);
    writeShapeUniforms(a, b, 3, 12, 1.5, [1, 0.5, 1]);
    const xyr = [0, 0, 0];
    shapeAt(SHAPE_PATHS[1], 12, 1.5, xyr);
    expect(a[4]).toBeCloseTo(xyr[0], 5);
    expect(a[5]).toBeCloseTo(xyr[1], 5);
    expect(a[6]).toBeCloseTo(Math.cos(xyr[2]), 5);
    expect(a[7]).toBeCloseTo(Math.sin(xyr[2]), 5);
    expect(b[4]).toBeCloseTo(SHAPE_PATHS[1].halfLen, 6);
    expect(b[5]).toBeCloseTo(SHAPE_PATHS[1].radius, 6);
    expect(b[6]).toBeCloseTo(SHAPE_PATHS[1].ringHalf, 6);
    expect(b[7]).toBeCloseTo(0.5 * SHAPE_OPACITY, 6);
    expect(b[3]).toBeCloseTo(SHAPE_OPACITY, 6);
    for (let i = 12; i < a.length; i++) {
      expect(a[i]).toBe(9);
      expect(b[i]).toBe(9);
    }
  });
});

describe("blurWidth", () => {
  it("spans the blur range, scaled by the glass", () => {
    expect(blurWidth(0, 1, 0)).toBeCloseTo(BLUR_RANGE[0], 12);
    expect(blurWidth(1, 1, 0)).toBeCloseTo(BLUR_RANGE[1], 12);
    expect(blurWidth(1, 0.5, 0)).toBeCloseTo(BLUR_RANGE[1] * 0.5, 12);
  });

  it("clamps the param, handles NaN and keeps the floor", () => {
    expect(blurWidth(5, 1, 0)).toBe(blurWidth(1, 1, 0));
    expect(blurWidth(-1, 1, 0)).toBe(blurWidth(0, 1, 0));
    expect(Number.isFinite(blurWidth(Number.NaN, 1, 0))).toBe(true);
    expect(blurWidth(0, 0.01, 0.02)).toBe(0.02);
    expect(blurWidth(0, 1, 0)).toBeGreaterThan(0);
  });
});

describe("flute profile", () => {
  it("is zero, odd and smooth through the flute centre", () => {
    expect(fluteOffset(0)).toBe(0);
    for (const u of [0.01, 0.1, 0.3, 0.49]) {
      expect(fluteOffset(-u)).toBeCloseTo(-fluteOffset(u), 12);
    }
    // Continuous with slope FLUTE_SQUASH: the same from either side.
    const h = 1e-5;
    const right = (fluteOffset(h) - fluteOffset(0)) / h;
    const left = (fluteOffset(0) - fluteOffset(-h)) / h;
    expect(right).toBeCloseTo(FLUTE_SQUASH, 4);
    expect(left).toBeCloseTo(right, 6);
  });

  it("is bounded at the flute edges", () => {
    const bound = FLUTE_SQUASH / Math.PI;
    for (let u = -0.5; u <= 0.5; u += 0.01) {
      expect(Math.abs(fluteOffset(u))).toBeLessThanOrEqual(bound + 1e-12);
    }
    expect(fluteOffset(0.5)).toBeCloseTo(bound, 12);
    expect(fluteOffset(-0.5)).toBeCloseTo(-bound, 12);
    // Under a flute width each side: the image never jumps more than ~one flute.
    expect(bound).toBeLessThan(1);
  });

  it("maps each flute monotonically (a lens, no fold-over)", () => {
    let prev = -Infinity;
    for (let u = -0.5; u <= 0.5; u += 0.01) {
      const x = u + fluteOffset(u);
      expect(x).toBeGreaterThan(prev);
      prev = x;
    }
  });

  it("finds the in-flute coordinate from a pixel column", () => {
    expect(fluteCoord(0, 40)).toBe(-0.5);
    expect(fluteCoord(20, 40)).toBe(0);
    expect(fluteCoord(60, 40)).toBe(0);
    expect(fluteCoord(30, 40)).toBeCloseTo(0.25, 12);
    expect(fluteCoord(-10, 40)).toBeCloseTo(0.25, 12);
  });
});

describe("buildGrainTexture", () => {
  const tex = buildGrainTexture();

  it("is deterministic RG8 data of the right size", () => {
    expect(tex.length).toBe(GRAIN_SIZE * GRAIN_SIZE * 2);
    // A plain loop: toEqual on the whole texture is slow.
    const again = buildGrainTexture();
    expect(again.length).toBe(tex.length);
    expect(again.findIndex((v, i) => v !== tex[i])).toBe(-1);
  });

  it("centres both channels on mid-grey, with fine white noise in R", () => {
    let r = 0;
    let g = 0;
    let rDiff = 0;
    let gDiff = 0;
    const n = GRAIN_SIZE * GRAIN_SIZE;
    for (let i = 0; i < n; i++) {
      r += tex[i * 2];
      g += tex[i * 2 + 1];
      if (i % GRAIN_SIZE > 0) {
        rDiff += Math.abs(tex[i * 2] - tex[i * 2 - 2]);
        gDiff += Math.abs(tex[i * 2 + 1] - tex[i * 2 - 1]);
      }
    }
    expect(r / n).toBeGreaterThan(120);
    expect(r / n).toBeLessThan(136);
    expect(g / n).toBeGreaterThan(110);
    expect(g / n).toBeLessThan(146);
    // R changes a lot from texel to texel; G (the mottling) is smooth.
    expect(rDiff / n).toBeGreaterThan(60);
    expect(gDiff / n).toBeLessThan(10);
  });
});
