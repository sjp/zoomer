import { describe, expect, it } from "vitest";
import {
  advancePhase,
  DOT_FRACTION,
  DOTS,
  layerCount,
  layerPose,
  LINE_FRACTION,
  LINES,
  MAX_LAYERS,
  MIN_LINE_1080,
  MIN_LINE_DEVICE_PX,
  MIN_SPACING,
  MOTIONS,
  motionIndex,
  palette,
  paletteData,
  PALETTES,
  patternKinds,
  PATTERNS,
  PERIOD,
  RINGS,
  spacingPx,
  writeLayerMap,
  type LayerPose,
} from "./moire-sim";
import {
  LAYER_OPTIONS,
  moireMeta,
  MOTION_OPTIONS,
  PALETTE_OPTIONS,
  PATTERN_OPTIONS,
} from "./moire.meta";

const pose = (): LayerPose => ({ cx: 0, cy: 0, angle: 0, scale: 1 });

describe("options", () => {
  it("match the sim's names", () => {
    expect(PATTERN_OPTIONS.map((o) => o.value)).toEqual([...PATTERNS]);
    expect(MOTION_OPTIONS.map((o) => o.value)).toEqual([...MOTIONS]);
    expect(PALETTE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(PALETTES).sort());
    expect(LAYER_OPTIONS.map((o) => layerCount(o.value))).toEqual([2, 3]);
    expect(moireMeta.params.spacing.min).toBe(MIN_SPACING);
  });

  it("fall back for unknown names", () => {
    expect(palette("nope")).toBe(PALETTES.paper);
    expect(motionIndex("nope")).toBe(0);
    expect(motionIndex("breathe")).toBe(2);
    expect(patternKinds("nope")).toEqual([RINGS, RINGS, RINGS]);
    expect(patternKinds("ringslines")).toEqual([RINGS, LINES, RINGS]);
    expect(patternKinds("dots")).toEqual([DOTS, DOTS, DOTS]);
    expect(layerCount("nope")).toBe(2);
  });
});

describe("palettes", () => {
  it("use ink darker than the paper, so layers only ever darken it", () => {
    const bad: string[] = [];
    for (const name of Object.keys(PALETTES)) {
      const d = paletteData(name);
      if (d !== paletteData(name)) bad.push(`${name}: rebuilt`);
      for (const t of d.tints) if (!(t >= 0 && t < 1)) bad.push(`${name}: ${String(t)}`);
    }
    expect(bad).toEqual([]);
  });
});

describe("minimum spacing", () => {
  it("keeps marks at least the documented width from 720p to 4K", () => {
    const bad: string[] = [];
    for (const height of [720, 1080, 1440, 2160]) {
      const scale = height / 1080;
      for (const spacing of [-5, 0, 4, MIN_SPACING, 20, 80, Number.NaN]) {
        const s = spacingPx(spacing, scale);
        const line = s * LINE_FRACTION;
        if (line < MIN_LINE_DEVICE_PX - 1e-9)
          bad.push(`${String(height)}p ${String(spacing)}: ${String(line)} px`);
        if (line < MIN_LINE_1080 * scale - 1e-9)
          bad.push(`${String(height)}p ${String(spacing)}: ${String(line)} px`);
        if (s * DOT_FRACTION < line) bad.push(`${String(height)}p ${String(spacing)}: dots`);
      }
    }
    expect(bad).toEqual([]);
    // 4K scales the 1080p minimum; 720p hits the device floor.
    expect(spacingPx(MIN_SPACING, 2) * LINE_FRACTION).toBeCloseTo(2 * MIN_LINE_1080);
    expect(spacingPx(MIN_SPACING, 720 / 1080) * LINE_FRACTION).toBeCloseTo(MIN_LINE_DEVICE_PX);
    expect(MIN_LINE_1080).toBeGreaterThanOrEqual(6);
  });

  it("keeps the requested spacing above the minimum", () => {
    expect(spacingPx(40, 1)).toBe(40);
    expect(spacingPx(40, 2)).toBe(80);
  });
});

describe("phase", () => {
  it("wraps into [0, 1) and advances one cycle per PERIOD at speed 1", () => {
    let p = 0;
    let ok = true;
    for (let k = 0; k < 600; k++) {
      p = advancePhase(p, PERIOD / 600, 1);
      ok &&= p >= 0 && p < 1;
    }
    expect(ok).toBe(true);
    expect(Math.min(p, 1 - p)).toBeLessThan(1e-9);
    expect(advancePhase(0.3, 1, 0)).toBe(0.3);
    expect(advancePhase(0.3, Number.NaN, 1)).toBe(0.3);
    expect(advancePhase(0.3, -1, 1)).toBe(0.3);
    expect(advancePhase(0.3, PERIOD / 10, 2)).toBeCloseTo(0.5);
  });
});

describe("layer poses", () => {
  it("are continuous and periodic, so wrapping the phase never jumps", () => {
    const a = pose();
    const b = pose();
    const bad: string[] = [];
    const steps = 2000;
    for (let m = 0; m < MOTIONS.length; m++) {
      for (let layer = 0; layer < MAX_LAYERS; layer++) {
        let maxStep = 0;
        let phase = 0;
        layerPose(layer, m, phase, a);
        for (let k = 0; k < steps; k++) {
          phase = advancePhase(phase, PERIOD / steps, 1);
          layerPose(layer, m, phase, b);
          maxStep = Math.max(
            maxStep,
            Math.hypot(b.cx - a.cx, b.cy - a.cy),
            Math.abs(b.angle - a.angle) * 1000,
            Math.abs(b.scale - a.scale) * 1000,
          );
          a.cx = b.cx;
          a.cy = b.cy;
          a.angle = b.angle;
          a.scale = b.scale;
        }
        // Under a pixel (or a milliradian) per 1/2000 of the cycle, including the wrap.
        if (maxStep > 1) bad.push(`motion ${String(m)} layer ${String(layer)}: ${String(maxStep)}`);
        // Period 1: phase 0 and phase just under 1 agree.
        layerPose(layer, m, 0, a);
        layerPose(layer, m, 1 - 1e-12, b);
        if (Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy) + Math.abs(a.angle - b.angle) > 1e-6)
          bad.push(`motion ${String(m)} layer ${String(layer)}: not periodic`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("never shrink a layer below the base spacing", () => {
    const p = pose();
    let min = Infinity;
    for (let m = 0; m < MOTIONS.length; m++) {
      for (let layer = 0; layer < MAX_LAYERS; layer++) {
        for (let k = 0; k < 500; k++) min = Math.min(min, layerPose(layer, m, k / 500, p).scale);
      }
    }
    expect(min).toBeGreaterThanOrEqual(1);
  });

  it("move every layer apart from the others", () => {
    const p = pose();
    for (let m = 0; m < MOTIONS.length; m++) {
      const seen = new Set<string>();
      for (let layer = 0; layer < MAX_LAYERS; layer++) {
        layerPose(layer, m, 0.2, p);
        seen.add(`${p.cx.toFixed(3)},${p.cy.toFixed(3)},${p.angle.toFixed(5)},${String(p.scale)}`);
      }
      expect(seen.size).toBe(MAX_LAYERS);
    }
  });
});

describe("layer map", () => {
  it("puts the pattern centre at the origin with one unit per spacing", () => {
    const m = new Float32Array(4 * MAX_LAYERS);
    const o = new Float32Array(2 * MAX_LAYERS);
    const p: LayerPose = { cx: 30, cy: -20, angle: 0.4, scale: 1.25 };
    const width = 3840;
    const height = 2160;
    const scale = 2;
    writeLayerMap(p, 40, width, height, scale, 1, m, o);
    const apply = (x: number, y: number) => [
      m[4] * x + m[6] * y + o[2],
      m[5] * x + m[7] * y + o[3],
    ];
    const cx = width / 2 + 30 * scale;
    const cy = height / 2 - 20 * scale;
    const c = apply(cx, cy);
    expect(Math.hypot(c[0], c[1])).toBeLessThan(1e-3);
    // A step of one layer spacing (50 px) in the layer's own x direction is one unit along x.
    const d = apply(cx + 50 * Math.cos(0.4), cy + 50 * Math.sin(0.4));
    expect(d[0]).toBeCloseTo(1, 4);
    expect(d[1]).toBeCloseTo(0, 4);
    // Other layers' slots are untouched.
    expect(m[0]).toBe(0);
    expect(o[4]).toBe(0);
  });
});
