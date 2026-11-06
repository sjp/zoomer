import { describe, expect, it } from "vitest";
import {
  buildMesh,
  buildOctaves,
  buildRamp,
  cameraAt,
  cameraMeshZ,
  CAM_BACK,
  createOctaveRows,
  CAM_HEIGHT,
  createPose,
  HORIZON_NDC,
  MAX_TAN_H,
  MESH_TAN,
  octaveWeights,
  PALETTES,
  PERIOD,
  RAMP_SIZE,
  ringRow,
  rowHalfWidth,
  ROWS,
  rowsNeeded,
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
/**
 * Index of the first byte where `a` and `b` differ, or -1 when they match. A plain
 * loop: `toEqual` on a quarter-million bytes takes most of a second.
 */
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
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
    const bad = tris.filter((t) => area2(t) !== 1).slice(0, 10);
    expect(bad).toEqual([]);
  });

  it("gives each vertex its triangle's other corners in winding order", () => {
    // Plain comparisons in the loop: an expect per vertex costs far more than the check.
    const wrong: string[] = [];
    for (let v = 0; v < mesh.length; v += 3 * VERTEX_SHORTS) {
      for (let i = 0; i < 3; i++) {
        const o = v + i * VERTEX_SHORTS;
        const next = v + ((i + 1) % 3) * VERTEX_SHORTS;
        const last = v + ((i + 2) % 3) * VERTEX_SHORTS;
        const [ax, az] = decode(mesh[o + 2]);
        const [bx, bz] = decode(mesh[o + 3]);
        const nextOk = mesh[o] + ax === mesh[next] && mesh[o + 1] + az === mesh[next + 1];
        const lastOk = mesh[o] + bx === mesh[last] && mesh[o + 1] + bz === mesh[last + 1];
        if (!(nextOk && lastOk) && wrong.length < 10)
          wrong.push(`triangle at ${String(v)}, corner ${String(i)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("covers each cell exactly once, within the period's width", () => {
    const seen = new Set<string>();
    const wrong: string[] = [];
    const fail = (msg: string) => wrong.length < 10 && wrong.push(msg);
    for (let i = 0; i < tris.length; i += 2) {
      const xs = [...tris[i], ...tris[i + 1]].map((p) => p[0]);
      const zs = [...tris[i], ...tris[i + 1]].map((p) => p[1]);
      const key = `${String(Math.min(...xs))},${String(Math.min(...zs))}`;
      if (seen.has(key)) fail(`cell ${key} covered twice`);
      seen.add(key);
      if (Math.max(...xs) - Math.min(...xs) !== 1) fail(`cell ${key} is not one wide`);
      if (Math.max(...zs) - Math.min(...zs) !== 1) fail(`cell ${key} is not one deep`);
    }
    for (const t of tris) {
      for (const [x] of t)
        if (!(Math.abs(x) < PERIOD / 2)) fail(`x ${String(x)} outside the period`);
    }
    expect(wrong).toEqual([]);
  });

  it("draws back to front, so no later triangle can be hidden by an earlier one", () => {
    // Rows far to near; within a row, columns outside in; within a cell, the far
    // triangle (away from the camera across the diagonal) first.
    let prev = { row: Infinity, dist: Infinity };
    const wrong: string[] = [];
    for (let i = 0; i < tris.length; i += 2) {
      const far = tris[i];
      const near = tris[i + 1];
      const all = [...far, ...near];
      const row = Math.min(...all.map((p) => p[1]));
      const col = Math.min(...all.map((p) => p[0]));
      const dist = col >= 0 ? col : -col;
      // Lexicographic (row, dist) never increases.
      const descending = row < prev.row || (row === prev.row && dist <= prev.dist);
      if (!descending && wrong.length < 10)
        wrong.push(`cell ${String(col)},${String(row)} after ${String(prev.row)}`);
      prev = { row, dist };
      // The camera is behind row 0 inside column 0; take a far, sideways sample of it.
      for (const cam of [
        [0.15, -CAM_BACK - 0.999],
        [0.85, -CAM_BACK],
      ]) {
        const centroid = (t: [number, number][]) =>
          [0, 1].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
        const d = (t: [number, number][]) => Math.hypot(...centroid(t).map((v, k) => v - cam[k]));
        if (!(d(far) > d(near)) && wrong.length < 10) {
          wrong.push(
            `cell ${String(col)},${String(row)}: far triangle not farther from ${cam.join(",")}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
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
    const outside: string[] = [];
    for (let t = 0; t < 4000; t += 0.7) {
      cameraAt(t, pose);
      const ok =
        Math.abs(pose.x - 0.5) <= SWAY_X + 1e-12 &&
        pose.x > 0 &&
        pose.x < 1 &&
        Math.abs(pose.y - CAM_HEIGHT) <= SWAY_Y + 1e-12 &&
        Math.abs(pose.yaw) <= SWAY_YAW + 1e-12 &&
        Math.abs(pose.horizon - HORIZON_NDC) <= SWAY_HORIZON + 1e-12;
      if (!ok && outside.length < 10) outside.push(`t ${String(t)}: ${JSON.stringify(pose)}`);
    }
    expect(outside).toEqual([]);
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

describe("cameraMeshZ", () => {
  it("stays behind the mesh and moves forward smoothly across row changes", () => {
    let prevWorld = Math.floor(0) + cameraMeshZ(0) - 0.037;
    const wrong: string[] = [];
    for (let d = 0; d < 600; d += 0.037) {
      const z = cameraMeshZ(d);
      // Behind row 0 and within the distance rowHalfWidth allows for.
      const behind = z <= -CAM_BACK + 1e-9 && z > -CAM_BACK - 1 - 1e-9;
      const world = Math.floor(d) + z;
      // toBeCloseTo(0.037, 9): within half of 1e-9.
      const smooth = Math.abs(world - prevWorld - 0.037) < 5e-10;
      if (!(behind && smooth) && wrong.length < 10)
        wrong.push(`d ${String(d)}: z ${String(z)}, step ${String(world - prevWorld)}`);
      prevWorld = world;
    }
    expect(wrong).toEqual([]);
  });
});

describe("octave ring buffer", () => {
  it("streams rows that match a full rebuild and never repeat along z", () => {
    const write = createOctaveRows(5);
    const start = 1000;
    const ring = buildOctaves(5, start);
    // Fly 300 rows on, streaming each needed row over the oldest one.
    let filledTo = start + PERIOD;
    const missing: number[] = [];
    for (let row = start; row < start + 300; row++) {
      for (; filledTo < rowsNeeded(row); filledTo++) {
        write(filledTo, ring, ringRow(filledTo) * PERIOD * 4);
      }
      // Every row the mesh reads is in place.
      if (filledTo - PERIOD > row) missing.push(row);
    }
    expect(missing).toEqual([]);
    expect(firstDiff(ring, buildOctaves(5, filledTo - PERIOD))).toBe(-1);
    // Row r and r + PERIOD differ: no tiling along the flight.
    const a = new Uint8Array(PERIOD * 4);
    const b = new Uint8Array(PERIOD * 4);
    for (const r of [0, 17, 4000]) {
      write(r, a);
      write(r + PERIOD, b);
      expect(firstDiff(b, a)).not.toBe(-1);
    }
    expect(ringRow(-1)).toBe(PERIOD - 1);
    expect(ringRow(PERIOD + 3)).toBe(3);
  });
});

describe("buildOctaves", () => {
  it("is deterministic per seed, uses the whole byte range and has no lattice zeros", () => {
    const a = buildOctaves(3);
    expect(a).toHaveLength(PERIOD * PERIOD * 4);
    expect(firstDiff(buildOctaves(3), a)).toBe(-1);
    expect(firstDiff(buildOctaves(4), a)).not.toBe(-1);
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
