import { describe, expect, it } from "vitest";
import {
  advanceCamera,
  buildMesh,
  buildOctaves,
  buildRamp,
  cameraAt,
  CAM_BACK,
  CAM_HEIGHT,
  createPose,
  HORIZON_NDC,
  MAX_TAN_H,
  MESH_TAN,
  octaveWeights,
  PALETTES,
  PERIOD,
  RAMP_SIZE,
  rowHalfWidth,
  ROWS,
  SWAY_HORIZON,
  SWAY_X,
  SWAY_Y,
  SWAY_YAW,
  triangleCount,
  VERTEX_SHORTS,
} from "./terrain-sim";

/** Decodes the mesh into triangles of three [x, z] corners. */
function triangles(mesh: Int16Array): [number, number][][] {
  const out: [number, number][][] = [];
  for (let v = 0; v < mesh.length; v += 3 * VERTEX_SHORTS) {
    out.push([0, 1, 2].map((i) => [mesh[v + i * VERTEX_SHORTS], mesh[v + i * VERTEX_SHORTS + 1]]));
  }
  return out;
}
const decode = (code: number) => [(code % 3) - 1, Math.floor(code / 3) - 1];
/** Twice the signed area in the (x right, z forward) plane: positive when counter-clockwise. */
const area2 = ([a, b, c]: [number, number][]) =>
  (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);

describe("buildMesh", () => {
  const mesh = buildMesh();
  const tris = triangles(mesh);

  it("has two triangles per cell of the trapezoid, about 27k in all", () => {
    let cells = 0;
    for (let r = 0; r < ROWS; r++) cells += 2 * rowHalfWidth(r) + 1;
    expect(triangleCount()).toBe(2 * cells);
    expect(mesh.length).toBe(triangleCount() * 3 * VERTEX_SHORTS);
    expect(triangleCount()).toBeGreaterThan(20000);
    expect(triangleCount()).toBeLessThan(34000);
  });

  it("winds every triangle counter-clockwise, as one half of its cell", () => {
    for (const t of tris) expect(area2(t)).toBe(1);
  });

  it("gives each vertex its triangle's other corners in winding order", () => {
    for (let v = 0; v < mesh.length; v += 3 * VERTEX_SHORTS) {
      for (let i = 0; i < 3; i++) {
        const o = v + i * VERTEX_SHORTS;
        const next = v + ((i + 1) % 3) * VERTEX_SHORTS;
        const last = v + ((i + 2) % 3) * VERTEX_SHORTS;
        const [ax, az] = decode(mesh[o + 2]);
        const [bx, bz] = decode(mesh[o + 3]);
        expect([mesh[o] + ax, mesh[o + 1] + az]).toEqual([mesh[next], mesh[next + 1]]);
        expect([mesh[o] + bx, mesh[o + 1] + bz]).toEqual([mesh[last], mesh[last + 1]]);
      }
    }
  });

  it("covers each cell exactly once, within the period's width", () => {
    const seen = new Set<string>();
    for (let i = 0; i < tris.length; i += 2) {
      const xs = [...tris[i], ...tris[i + 1]].map((p) => p[0]);
      const zs = [...tris[i], ...tris[i + 1]].map((p) => p[1]);
      const key = `${Math.min(...xs)},${Math.min(...zs)}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      expect(Math.max(...xs) - Math.min(...xs)).toBe(1);
      expect(Math.max(...zs) - Math.min(...zs)).toBe(1);
    }
    for (const t of tris) for (const [x] of t) expect(Math.abs(x)).toBeLessThan(PERIOD / 2);
  });

  it("draws back to front, so no later triangle can be hidden by an earlier one", () => {
    // Rows far to near; within a row, columns outside in; within a cell, the far
    // triangle (away from the camera across the diagonal) first.
    let prev = { row: Infinity, dist: Infinity };
    for (let i = 0; i < tris.length; i += 2) {
      const far = tris[i];
      const near = tris[i + 1];
      const all = [...far, ...near];
      const row = Math.min(...all.map((p) => p[1]));
      const col = Math.min(...all.map((p) => p[0]));
      const dist = col >= 0 ? col : -col;
      // Lexicographic (row, dist) never increases.
      const descending = row < prev.row || (row === prev.row && dist <= prev.dist);
      expect(descending, `cell ${col},${row} after ${prev.row}`).toBe(true);
      prev = { row, dist };
      // The camera is behind row 0 inside column 0; take a far, sideways sample of it.
      for (const cam of [
        [0.15, -CAM_BACK - 0.999],
        [0.85, -CAM_BACK],
      ]) {
        const centroid = (t: [number, number][]) =>
          [0, 1].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
        const d = (t: [number, number][]) => Math.hypot(...centroid(t).map((v, k) => v - cam[k]));
        expect(d(far)).toBeGreaterThan(d(near));
      }
    }
  });

  it("reaches past the view's sides from any camera position", () => {
    const tanH = Math.tan(Math.atan(MAX_TAN_H) + SWAY_YAW);
    expect(MESH_TAN).toBeGreaterThan(tanH);
    for (let r = 0; r < ROWS; r++) {
      const ahead = r + 1 + CAM_BACK + 1;
      const k = rowHalfWidth(r);
      // Column 0 spans [0, 1] and the camera stays within [0.5 - SWAY_X, 0.5 + SWAY_X].
      expect(k + 0.5 - SWAY_X).toBeGreaterThanOrEqual(tanH * ahead);
    }
  });
});

describe("cameraAt", () => {
  const pose = createPose();

  it("stays within its sway bounds, inside column 0", () => {
    for (let t = 0; t < 4000; t += 0.7) {
      cameraAt(t, pose);
      expect(Math.abs(pose.x - 0.5)).toBeLessThanOrEqual(SWAY_X + 1e-12);
      expect(pose.x).toBeGreaterThan(0);
      expect(pose.x).toBeLessThan(1);
      expect(Math.abs(pose.y - CAM_HEIGHT)).toBeLessThanOrEqual(SWAY_Y + 1e-12);
      expect(Math.abs(pose.yaw)).toBeLessThanOrEqual(SWAY_YAW + 1e-12);
      expect(Math.abs(pose.horizon - HORIZON_NDC)).toBeLessThanOrEqual(SWAY_HORIZON + 1e-12);
    }
  });

  it("is continuous and slow", () => {
    const a = createPose();
    const b = createPose();
    for (let t = 0; t < 2000; t += 3.1) {
      cameraAt(t, a);
      cameraAt(t + 1 / 60, b);
      expect(Math.abs(b.x - a.x)).toBeLessThan(0.001);
      expect(Math.abs(b.y - a.y)).toBeLessThan(0.001);
      expect(Math.abs(b.yaw - a.yaw)).toBeLessThan(0.0001);
      expect(Math.abs(b.horizon - a.horizon)).toBeLessThan(0.0001);
    }
  });

  it("puts the horizon 40-45% from the top", () => {
    for (let t = 0; t < 1000; t += 1.3) {
      const fromTop = (1 - cameraAt(t, pose).horizon) / 2;
      expect(fromTop).toBeGreaterThanOrEqual(0.4);
      expect(fromTop).toBeLessThanOrEqual(0.45);
    }
  });
});

describe("advanceCamera", () => {
  it("wraps at the terrain period and is continuous mod it", () => {
    let z = 0;
    let total = 0;
    for (let i = 0; i < 10000; i++) {
      const dz = 0.05 + (i % 7) * 0.01;
      const next = advanceCamera(z, dz);
      total += dz;
      expect(next).toBeGreaterThanOrEqual(0);
      expect(next).toBeLessThan(PERIOD);
      const step = (((next - z) % PERIOD) + PERIOD) % PERIOD;
      expect(step).toBeCloseTo(dz, 9);
      z = next;
    }
    expect(total).toBeGreaterThan(PERIOD * 2);
    expect(z).toBeCloseTo(total % PERIOD, 6);
  });
});

describe("buildOctaves", () => {
  it("is deterministic per seed, uses the whole byte range and has no lattice zeros", () => {
    const a = buildOctaves(3);
    expect(a).toHaveLength(PERIOD * PERIOD * 4);
    expect(buildOctaves(3)).toEqual(a);
    expect(buildOctaves(4)).not.toEqual(a);
    for (let c = 0; c < 4; c++) {
      let min = 255;
      let max = 0;
      let mid = 0;
      for (let i = c; i < a.length; i += 4) {
        min = Math.min(min, a[i]);
        max = Math.max(max, a[i]);
        if (a[i] === 128 || a[i] === 127) mid++;
      }
      expect(min).toBeLessThan(60);
      expect(max).toBeGreaterThan(195);
      // Sampling on the lattice would pin a whole grid of texels to mid-grey.
      expect(mid).toBeLessThan(PERIOD * PERIOD * 0.05);
    }
  });
});

describe("octaveWeights", () => {
  it("sums to the amplitude times the stretch and decays with octave", () => {
    const w = new Float64Array(4);
    for (const r of [0, 0.5, 1]) {
      const amp = octaveWeights(r, w);
      expect(w.reduce((s, v) => s + v, 0)).toBeCloseTo(amp * 1.4, 9);
      for (let i = 1; i < 4; i++) expect(w[i]).toBeLessThan(w[i - 1]);
    }
    const smooth = octaveWeights(0, w) && w[3] / w[0];
    const rough = octaveWeights(1, w) && w[3] / w[0];
    expect(rough).toBeGreaterThan(smooth);
  });
});

describe("buildRamp", () => {
  const out = new Float32Array(RAMP_SIZE * 4);

  it.each(Object.entries(PALETTES))("%s: hits its end stops and stays in range", (_, palette) => {
    buildRamp(palette.stops, out);
    expect(out.every((v) => v >= 0 && v <= 1)).toBe(true);
    const first = palette.stops[0];
    const last = palette.stops[palette.stops.length - 1];
    expect(first.at).toBe(0);
    expect(last.at).toBe(1);
    expect(out[3]).toBeCloseTo(first.rock, 6);
    expect(out[(RAMP_SIZE - 1) * 4 + 3]).toBeCloseTo(last.rock, 6);
    for (let i = 1; i < palette.stops.length; i++) {
      expect(palette.stops[i].at).toBeGreaterThan(palette.stops[i - 1].at);
    }
  });

  it("interpolates linearly between stops and holds beyond them", () => {
    const stops = [
      { at: 0.25, color: "#000000", rock: 0 },
      { at: 0.75, color: "#ffffff", rock: 1 },
    ];
    buildRamp(stops, out);
    for (let i = 0; i < RAMP_SIZE; i++) {
      const t = i / (RAMP_SIZE - 1);
      const f = Math.min(1, Math.max(0, (t - 0.25) / 0.5));
      for (let c = 0; c < 4; c++) expect(out[i * 4 + c]).toBeCloseTo(f, 5);
    }
  });
});
