import { describe, expect, it } from "vitest";
import {
  catenary,
  createKiteState,
  gustAt,
  gustNoise,
  kiteCounts,
  lineCounts,
  MAX_BACK_STREAKS,
  MAX_FRONT_STREAKS,
  MAX_KITE_TRIS,
  MAX_TRIS,
  PALETTES,
  paletteFor,
  poseMatrix,
  SHAPES,
  shapeFor,
  STRING_SEGMENTS,
  stepKite,
  TAIL_POINTS,
  TAIL_TRIS,
  TRI_FLOATS,
  writeKite,
  writeLines,
  writeTail,
} from "./kite-sim";
import { COLOUR_OPTIONS, KITE_OPTIONS } from "./kite.meta";
import { STREAK_FLOATS } from "./streaks";

const ASPECT = 16 / 9;
const DT = 1 / 60;
const KINDS = KITE_OPTIONS.map((o) => o.value);

describe("shapes", () => {
  it("has a shape and a palette for every option, with fallbacks", () => {
    for (const k of KINDS) expect(shapeFor(k)).toBe(SHAPES[k]);
    expect(shapeFor("nope")).toBe(SHAPES.diamond);
    for (const { value } of COLOUR_OPTIONS) expect(paletteFor(value)).toBe(PALETTES[value]);
    expect(paletteFor("nope")).toBe(PALETTES.rainbow);
  });

  it("has valid, non-degenerate triangles, spars and faces", () => {
    for (const k of KINDS) {
      const s = SHAPES[k];
      const n = s.points.length / 3;
      const tris = s.tris.length / 3;
      expect(tris).toBeLessThanOrEqual(MAX_KITE_TRIS);
      expect(s.spars.length / 2).toBeLessThanOrEqual(MAX_BACK_STREAKS);
      let bad = 0;
      for (let t = 0; t < tris; t++) {
        const [a, b, c] = [s.tris[t * 3], s.tris[t * 3 + 1], s.tris[t * 3 + 2]];
        if (Math.max(a, b, c) >= n || s.face[t] >= s.faceCount || s.slot[t] > 3) bad++;
        // Twice the area of the triangle, from the cross product in 3D.
        const ux = s.points[b * 3] - s.points[a * 3];
        const uy = s.points[b * 3 + 1] - s.points[a * 3 + 1];
        const uz = s.points[b * 3 + 2] - s.points[a * 3 + 2];
        const vx = s.points[c * 3] - s.points[a * 3];
        const vy = s.points[c * 3 + 1] - s.points[a * 3 + 1];
        const vz = s.points[c * 3 + 2] - s.points[a * 3 + 2];
        const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        if (area < 0.05) bad++;
      }
      for (const i of s.spars) if (i >= n) bad++;
      for (let f = 0; f < s.faceCount; f++) {
        const o = f * 6;
        if (Math.abs(Math.hypot(s.faces[o], s.faces[o + 1], s.faces[o + 2]) - 1) > 1e-9) bad++;
      }
      expect(bad).toBe(0);
      expect(s.tailPoint).toBeLessThan(n);
      expect(s.bridlePoint).toBeLessThan(n);
    }
  });
});

describe("pose", () => {
  it("builds an orthonormal rotation", () => {
    const m = poseMatrix(new Float64Array(9), 0.4, 0.3, -0.5);
    let err = 0;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const dot = m[i * 3] * m[j * 3] + m[i * 3 + 1] * m[j * 3 + 1] + m[i * 3 + 2] * m[j * 3 + 2];
        err = Math.max(err, Math.abs(dot - (i === j ? 1 : 0)));
      }
    }
    expect(err).toBeLessThan(1e-12);
  });

  it("tips the nose away from the viewer", () => {
    const m = poseMatrix(new Float64Array(9), 0, 0.4, 0);
    // The nose (0, 1, 0) ends up with z < 0.
    expect(m[7]).toBeLessThan(0);
  });
});

describe("flight", () => {
  it("keeps the kite within its top corner", () => {
    for (const k of KINDS) {
      const shape = SHAPES[k];
      const n = shape.points.length / 3;
      for (const corner of ["left", "right"]) {
        for (const wind of [0, 0.5, 1]) {
          const s = createKiteState();
          let minX = Infinity;
          let maxX = -Infinity;
          let minY = Infinity;
          let maxY = -Infinity;
          // Three minutes at 30 fps covers several loops and gusts.
          for (let f = 0; f < 30 * 180; f++) {
            stepKite(s, 1 / 30, shape, wind, corner, ASPECT);
            for (let i = 0; i < n; i++) {
              // Mirrored for the left corner, so both are checked as the right one.
              const x = corner === "right" ? s.world[i * 3] : ASPECT - s.world[i * 3];
              const y = s.world[i * 3 + 1];
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
          expect(minX).toBeGreaterThan((ASPECT * 2) / 3);
          expect(maxX).toBeLessThan(ASPECT);
          expect(minY).toBeGreaterThan(0.5);
          expect(maxY).toBeLessThan(1);
        }
      }
    }
  });

  it("is deterministic", () => {
    const a = createKiteState();
    const b = createKiteState();
    for (let f = 0; f < 600; f++) {
      stepKite(a, DT, SHAPES.delta, 0.7, "left", ASPECT);
      stepKite(b, DT, SHAPES.delta, 0.7, "left", ASPECT);
    }
    expect(Array.from(a.tail)).toEqual(Array.from(b.tail));
    expect(a.pose).toEqual(b.pose);
  });

  it("keeps the tail segments at their spacing", () => {
    for (const k of KINDS) {
      const shape = SHAPES[k];
      const spacing = shape.tailLength / (TAIL_POINTS - 1);
      const s = createKiteState();
      let worst = 0;
      // Uneven frame times, including a long stall, and a wind change.
      for (let f = 0; f < 2000; f++) {
        const dt = f === 700 ? 0.5 : f % 7 === 0 ? 1 / 24 : DT;
        stepKite(s, dt, shape, f < 1000 ? 0.2 : 1, "right", ASPECT);
        for (let i = 1; i < TAIL_POINTS; i++) {
          const d = Math.hypot(
            s.tail[i * 2] - s.tail[i * 2 - 2],
            s.tail[i * 2 + 1] - s.tail[i * 2 - 1],
          );
          worst = Math.max(worst, Math.abs(d - spacing) / spacing);
        }
      }
      expect(worst).toBeLessThan(1e-6);
    }
  });

  it("streams the tail down and towards the middle of the frame", () => {
    for (const corner of ["left", "right"]) {
      const s = createKiteState();
      let sumX = 0;
      let sumY = 0;
      for (let f = 0; f < 60 * 120; f++) {
        stepKite(s, DT, SHAPES.diamond, 0.5, corner, ASPECT);
        const e = (TAIL_POINTS - 1) * 2;
        sumX += s.tail[e] - s.tail[0];
        sumY += s.tail[e + 1] - s.tail[1];
      }
      expect(sumY).toBeLessThan(0);
      expect(corner === "right" ? sumX < 0 : sumX > 0).toBe(true);
    }
  });

  it("moves continuously in time, also while changing corner", () => {
    for (const k of KINDS) {
      const shape = SHAPES[k];
      const s = createKiteState();
      const prevTail = new Float64Array(TAIL_POINTS * 2);
      let px = Number.NaN;
      let py = 0;
      let pr = 0;
      let pp = 0;
      let pyaw = 0;
      let maxMove = 0;
      let maxTurn = 0;
      let maxTail = 0;
      for (let f = 0; f < 60 * 90; f++) {
        const corner = f < 60 * 40 ? "right" : "left";
        const wind = f < 60 * 20 ? 0.3 : 1;
        stepKite(s, DT, shape, wind, corner, ASPECT);
        const p = s.pose;
        if (!Number.isNaN(px)) {
          maxMove = Math.max(maxMove, Math.hypot(p.x - px, p.y - py));
          maxTurn = Math.max(
            maxTurn,
            Math.abs(p.roll - pr),
            Math.abs(p.pitch - pp),
            Math.abs(p.yaw - pyaw),
          );
          for (let i = 0; i < TAIL_POINTS * 2; i++) {
            maxTail = Math.max(maxTail, Math.abs(s.tail[i] - prevTail[i]));
          }
        }
        px = p.x;
        py = p.y;
        pr = p.roll;
        pp = p.pitch;
        pyaw = p.yaw;
        prevTail.set(s.tail);
      }
      // Per 1/60 s frame, in frame heights and radians.
      expect(maxMove).toBeLessThan(0.01);
      expect(maxTurn).toBeLessThan(0.03);
      expect(maxTail).toBeLessThan(0.02);
    }
  });

  it("has smooth gusts in 0..1", () => {
    let lo = Infinity;
    let hi = -Infinity;
    let jump = 0;
    let prev = gustNoise(0);
    for (let i = 1; i <= 100000; i++) {
      const t = i * 0.001;
      const g = gustNoise(t);
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      jump = Math.max(jump, Math.abs(g - prev));
      prev = g;
    }
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
    expect(jump).toBeLessThan(0.002);
    // Gusts are occasional, not constant.
    let calm = 0;
    for (let i = 0; i < 6000; i++) if (gustAt(i * 0.1) === 0) calm++;
    expect(calm / 6000).toBeGreaterThan(0.2);
    expect(calm / 6000).toBeLessThan(0.9);
  });
});

describe("catenary", () => {
  it("runs from end to end, sagging below the chord", () => {
    const out = new Float64Array((STRING_SEGMENTS + 1) * 2);
    for (const a of [0.6, 1.5, 3.4]) {
      catenary(out, STRING_SEGMENTS, 1.4, 0.75, 2.03, -0.45, a);
      expect(out[0]).toBe(1.4);
      expect(out[1]).toBe(0.75);
      expect(out[STRING_SEGMENTS * 2]).toBeCloseTo(2.03, 12);
      expect(out[STRING_SEGMENTS * 2 + 1]).toBe(-0.45);
      let above = 0;
      for (let i = 1; i < STRING_SEGMENTS; i++) {
        const u = i / STRING_SEGMENTS;
        if (out[i * 2 + 1] > 0.75 + (-0.45 - 0.75) * u) above++;
      }
      expect(above).toBe(0);
    }
  });

  it("sags less with more tension", () => {
    const loose = new Float64Array((STRING_SEGMENTS + 1) * 2);
    const tight = new Float64Array((STRING_SEGMENTS + 1) * 2);
    catenary(loose, STRING_SEGMENTS, 0.4, 0.75, -0.25, -0.45, 0.6);
    catenary(tight, STRING_SEGMENTS, 0.4, 0.75, -0.25, -0.45, 3);
    const mid = STRING_SEGMENTS + 1;
    expect(tight[mid]).toBeGreaterThan(loose[mid]);
  });

  it("draws a nearly vertical span straight", () => {
    const out = new Float64Array(6);
    catenary(out, 2, 1, 1, 1, 0, 1);
    expect(Array.from(out)).toEqual([1, 1, 1, 0.5, 1, 0]);
  });
});

describe("writers", () => {
  it("fills the instance data within its limits", () => {
    const tris = new Float32Array(MAX_TRIS * TRI_FLOATS);
    const back = new Float32Array(MAX_BACK_STREAKS * STREAK_FLOATS);
    const front = new Float32Array(MAX_FRONT_STREAKS * STREAK_FLOATS);
    for (const k of KINDS) {
      const shape = SHAPES[k];
      const s = createKiteState();
      for (let f = 0; f < 300; f++) stepKite(s, DT, shape, 0.5, "right", ASPECT);
      const palette = PALETTES.rainbow;
      const nt = writeTail(tris, 0, s, palette, 1080);
      expect(nt).toBe(TAIL_TRIS);
      const nk = writeKite(tris, nt, s, shape, palette, 1080);
      expect(nk).toBe(shape.tris.length / 3);
      expect(kiteCounts.back + kiteCounts.front).toBe(nk);
      // Only the box kite has faces turned away.
      expect(kiteCounts.back > 0).toBe(k === "box");
      writeLines(back, front, s, shape, 1080, 1);
      expect(lineCounts.back + lineCounts.front).toBe(shape.spars.length / 2 + STRING_SEGMENTS);
      expect(lineCounts.back > 0).toBe(k === "box");
      let bad = 0;
      for (let t = 0; t < nt + nk; t++) {
        const o = t * TRI_FLOATS;
        const a = tris[o + 11];
        // Premultiplied colour; the tail opaque, the fabric translucent.
        if (!(a > 0 && a <= 1)) bad++;
        if (t < nt && a !== 1) bad++;
        for (let c = 8; c < 11; c++) if (!(tris[o + c] >= 0 && tris[o + c] <= a + 1e-6)) bad++;
        for (let c = 0; c < 6; c++) if (!Number.isFinite(tris[o + c])) bad++;
      }
      expect(bad).toBe(0);
    }
  });
});
