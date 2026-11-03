import { describe, expect, it } from "vitest";
import {
  createKaleido,
  foldAngle,
  foldPoint,
  INSTANCE_ATTRIBUTES,
  INSTANCE_STRIDE,
  isCircleView,
  palette,
  paletteData,
  PALETTES,
  SEGMENTS,
  segmentCount,
  SHAPE_BEAD,
  SHAPE_DISC,
  SHAPE_ROD,
  SOURCE_MARGIN,
  sourceLayout,
  TAU,
  WALL_PAD,
  wedgeAngle,
  wedgeDistances,
} from "./kaleido-sim";
import { kaleidoMeta, PALETTE_OPTIONS, SEGMENT_OPTIONS, VIEW_OPTIONS } from "./kaleido.meta";

describe("options", () => {
  it("match the sim", () => {
    expect(SEGMENT_OPTIONS.map((o) => segmentCount(o.value))).toEqual([...SEGMENTS]);
    expect(PALETTE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(PALETTES).sort());
    expect(VIEW_OPTIONS.map((o) => isCircleView(o.value))).toEqual([false, true]);
    expect(segmentCount(kaleidoMeta.params.segments.default)).toBe(8);
  });

  it("fall back for unknown names", () => {
    expect(segmentCount("7")).toBe(8);
    expect(segmentCount("")).toBe(8);
    expect(palette("nope")).toBe(PALETTES.jewel);
    expect(isCircleView("nope")).toBe(false);
  });
});

describe("foldAngle", () => {
  it("maps every angle into the wedge, and is the identity inside it", () => {
    let bad = 0;
    for (const n of SEGMENTS) {
      const w = wedgeAngle(n);
      for (let k = -2000; k <= 2000; k++) {
        const a = k * 0.0123;
        const f = foldAngle(a, w);
        if (!(f >= 0 && f <= w + 1e-12)) bad++;
        if (a >= 0 && a <= w && Math.abs(f - a) > 1e-12) bad++;
        // Symmetric under each mirror and periodic over a mirror pair.
        if (Math.abs(foldAngle(-a, w) - f) > 1e-9) bad++;
        if (Math.abs(foldAngle(a + 2 * w, w) - f) > 1e-9) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("is continuous across every mirror line", () => {
    let worst = 0;
    const eps = 1e-6;
    for (const n of SEGMENTS) {
      const w = wedgeAngle(n);
      for (let k = -n; k <= n; k++) {
        const m = k * w;
        worst = Math.max(worst, Math.abs(foldAngle(m + eps, w) - foldAngle(m - eps, w)));
      }
    }
    expect(worst).toBeLessThan(3e-6);
  });

  it("is continuous everywhere (Lipschitz 1)", () => {
    const w = wedgeAngle(6);
    let worst = 0;
    for (let a = -10; a < 10; a += 0.001) {
      worst = Math.max(worst, Math.abs(foldAngle(a + 0.001, w) - foldAngle(a, w)));
    }
    expect(worst).toBeLessThanOrEqual(0.001 + 1e-9);
  });
});

describe("foldPoint", () => {
  it("keeps the radius and lands inside the wedge", () => {
    const out: [number, number] = [0, 0];
    let bad = 0;
    for (const n of SEGMENTS) {
      const w = wedgeAngle(n);
      for (let k = 0; k < 500; k++) {
        const a = (k / 500) * TAU * 3 - TAU;
        const r = (k % 17) / 16;
        foldPoint(r * Math.cos(a), r * Math.sin(a), w, out);
        const d = wedgeDistances(out[0], out[1], w);
        if (Math.abs(Math.hypot(out[0], out[1]) - r) > 1e-9) bad++;
        if (d.first < -1e-9 || d.second < -1e-9 || d.rim < -1e-9) bad++;
      }
    }
    expect(bad).toBe(0);
    expect(foldPoint(0, 0, wedgeAngle(8), out)).toEqual([0, 0]);
  });
});

describe("sourceLayout", () => {
  it("covers the wedge and margin at the output's pixel density", () => {
    for (const n of SEGMENTS) {
      const w = wedgeAngle(n);
      const l = sourceLayout(w, 1000, 4096);
      expect(l.originX).toBe(-SOURCE_MARGIN);
      expect(l.originY).toBe(-SOURCE_MARGIN);
      expect(l.spanX).toBeCloseTo(1 + 2 * SOURCE_MARGIN);
      expect(l.spanY).toBeCloseTo(Math.sin(w) + 2 * SOURCE_MARGIN);
      expect(l.width).toBe(Math.ceil(l.spanX * 1000));
      expect(l.height).toBe(Math.ceil(l.spanY * 1000));
      // The wedge's corner at the rim maps inside the texture.
      expect((Math.sin(w) - l.originY) / l.spanY).toBeLessThan(1);
    }
  });

  it("scales down to fit the texture limit", () => {
    const l = sourceLayout(wedgeAngle(6), 5000, 2048);
    expect(l.width).toBeLessThanOrEqual(2048);
    expect(l.height).toBeLessThanOrEqual(2048);
    expect(l.width).toBeGreaterThan(2000);
    expect(sourceLayout(wedgeAngle(6), 0, 2048).width).toBeGreaterThanOrEqual(1);
  });
});

describe("paletteData", () => {
  it("parses colours once and keeps the mean between backlight and white", () => {
    for (const name of Object.keys(PALETTES)) {
      const d = paletteData(name);
      expect(paletteData(name)).toBe(d);
      expect(d.chips.length).toBe(palette(name).chips.length);
      for (let c = 0; c < 3; c++) {
        expect(d.mean[c]).toBeGreaterThanOrEqual(d.bg[c]);
        expect(d.mean[c]).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("createKaleido", () => {
  it("scales the chip count with the wedge", () => {
    const counts = SEGMENTS.map((n) => createKaleido(n, 1).count);
    expect(counts[0]).toBeGreaterThan(counts[1]);
    expect(counts[1]).toBeGreaterThan(counts[2]);
    expect(counts[2]).toBeGreaterThanOrEqual(15);
  });

  it("keeps every chip inside the wedge", () => {
    let bad = 0;
    let moved = 0;
    for (const n of SEGMENTS) {
      const w = wedgeAngle(n);
      for (const seed of [0, 42]) {
        const sim = createKaleido(n, seed);
        const x0 = Array.from(sim.x);
        const check = () => {
          for (let i = 0; i < sim.count; i++) {
            const d = wedgeDistances(sim.x[i], sim.y[i], w);
            const pad = WALL_PAD * sim.bound[i] - 1e-9;
            if (!(d.first >= pad && d.second >= pad && d.rim >= pad)) bad++;
          }
        };
        check();
        // Long and coarse: 0.3 s steps are the most a frame can ask for (0.1 s at speed 3).
        for (let k = 0; k < 600; k++) {
          sim.step(0.3);
          if (k % 50 === 0) check();
        }
        check();
        for (let i = 0; i < sim.count; i++) if (Math.abs(sim.x[i] - x0[i]) > 0.01) moved++;
      }
    }
    expect(bad).toBe(0);
    expect(moved).toBeGreaterThan(0);
  });

  it("is deterministic per seed and holds still at zero dt", () => {
    const a = createKaleido(8, 3);
    const b = createKaleido(8, 3);
    const c = createKaleido(8, 4);
    for (let k = 0; k < 100; k++) {
      a.step(0.05);
      b.step(0.05);
      c.step(0.05);
    }
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
    const before = Array.from(a.y);
    a.step(0);
    a.step(Number.NaN);
    expect(Array.from(a.y)).toEqual(before);
  });

  it("writes finite instances with valid shapes, colours and flips", () => {
    expect(INSTANCE_ATTRIBUTES.reduce((s, v) => s + v, 0) + 2).toBe(INSTANCE_STRIDE);
    const sim = createKaleido(6, 9);
    sim.step(1);
    const data = new Float32Array(sim.count * INSTANCE_STRIDE);
    const pal = paletteData("pastel");
    expect(sim.write(data, pal)).toBe(sim.count);
    let bad = 0;
    const shapes = new Set<number>();
    for (let i = 0; i < sim.count; i++) {
      const o = i * INSTANCE_STRIDE;
      for (let k = 0; k < INSTANCE_STRIDE; k++) if (!Number.isFinite(data[o + k])) bad++;
      const shape = data[o + 8];
      shapes.add(shape);
      if (![SHAPE_DISC, SHAPE_BEAD, SHAPE_ROD, 3, 4, 5, 6].includes(shape)) bad++;
      if (data[o + 2] < data[o + 3]) bad++;
      for (let c = 4; c < 7; c++) if (data[o + c] < 0 || data[o + c] > 1) bad++;
      if (data[o + 7] <= 0 || data[o + 7] > pal.opacity) bad++;
      const flip = Math.abs(data[o + 10]);
      if (flip < 0.25 - 1e-6 || flip > 1) bad++;
      if (shape === SHAPE_BEAD && flip !== 1) bad++;
    }
    expect(bad).toBe(0);
    expect(shapes.size).toBeGreaterThanOrEqual(4);
  });
});
