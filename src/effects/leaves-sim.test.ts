import { describe, expect, it } from "vitest";
import {
  BLOB_FLOATS,
  createPieces,
  fallFactor,
  fanStrip,
  gustAt,
  layerMargin,
  leafOutline,
  MAX_BLOBS,
  OUTLINE_POINTS,
  PIECE_FLOATS,
  type PieceFrame,
  SEASONS,
  SHAPES,
  swayOffset,
  swayTilt,
  writeFoliage,
} from "./leaves-sim";
import { createNoise } from "./noise";

const MAX = 450;
const frame = (over: Partial<PieceFrame> = {}): PieceFrame => ({
  refWidth: 1920,
  scale: 1,
  season: SEASONS.autumn,
  count: 200,
  size: 16,
  speed: 1,
  wind: 0.15,
  gusts: 0.4,
  hazeTop: [0.9, 0.8, 0.7],
  hazeBottom: [0.7, 0.5, 0.3],
  ...over,
});

/** Signed area of each triangle of a strip. */
const triangleAreas = (v: readonly number[]) => {
  const out: number[] = [];
  for (let i = 0; i + 5 < v.length; i += 2) {
    const [ax, ay, bx, by, cx, cy] = v.slice(i, i + 6);
    out.push(((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2);
  }
  return out;
};

/** Shoelace area of a closed outline. */
const polygonArea = (o: readonly number[]) => {
  let a = 0;
  for (let i = 0; i < o.length; i += 2) {
    const j = (i + 2) % o.length;
    a += o[i] * o[j + 1] - o[j] * o[i + 1];
  }
  return Math.abs(a) / 2;
};

describe("fanStrip", () => {
  it("is a closed fan with 2n + 1 vertices and the centre between rim points", () => {
    const square = [1, 0, 0, 1, -1, 0, 0, -1];
    const v = fanStrip(square);
    expect(v).toHaveLength((2 * 4 + 1) * 2);
    expect(v.slice(-2)).toEqual(v.slice(0, 2));
    for (let k = 1; k < 9; k += 2) expect(v.slice(k * 2, k * 2 + 2)).toEqual([0, 0]);
    const areas = triangleAreas(v).filter((a) => a !== 0);
    expect(areas).toHaveLength(4);
    expect(areas.reduce((s, a) => s + Math.abs(a), 0)).toBeCloseTo(2, 12);
  });
});

describe("leaf shapes", () => {
  it.each(SHAPES.map((s, i) => [i, s] as const))("shape %i covers its outline once", (i, v) => {
    const outline = leafOutline(i);
    expect(outline).toHaveLength(OUTLINE_POINTS * 2);
    expect(v).toHaveLength((2 * OUTLINE_POINTS + 1) * 2);
    // Closed: the strip ends on the rim point it started from.
    expect(v.slice(-2)).toEqual(v.slice(0, 2));

    let maxR = 0;
    for (let k = 0; k < outline.length; k += 2) {
      const r = Math.hypot(outline[k], outline[k + 1]);
      // Only the centre sits at the origin, which the shader relies on.
      expect(r).toBeGreaterThan(0.05);
      maxR = Math.max(maxR, r);
    }
    expect(maxR).toBeCloseTo(1, 12);

    // Symmetric about the y axis: mirroring a rim point lands on another one.
    for (let k = 0; k < outline.length; k += 2) {
      const m = ((OUTLINE_POINTS / 2 - k / 2 + OUTLINE_POINTS) % OUTLINE_POINTS) * 2;
      expect(outline[m]).toBeCloseTo(-outline[k], 9);
      expect(outline[m + 1]).toBeCloseTo(outline[k + 1], 9);
    }

    // The real triangles all wind the same way (alternate strip triangles flip
    // orientation, so compare with the strip parity) and add up to the outline's
    // area: no overlap, no gaps.
    const areas = triangleAreas(v);
    const real = areas.filter((_, t) => t % 2 === 0);
    const degenerate = areas.filter((_, t) => t % 2 === 1);
    expect(degenerate.every((a) => a === 0)).toBe(true);
    expect(new Set(real.map(Math.sign))).toEqual(new Set([Math.sign(real[0])]));
    expect(Math.sign(real[0])).not.toBe(0);
    const total = real.reduce((s, a) => s + Math.abs(a), 0);
    expect(total).toBeCloseTo(polygonArea(outline), 10);
  });
});

describe("flutter", () => {
  it("is bounded and continuous", () => {
    const step = 0.005;
    let sum = 0;
    let n = 0;
    // Whole periods, so the mean comes out exact.
    for (let psi = -2 * Math.PI; psi < 2 * Math.PI; psi += step) {
      for (const fn of [swayOffset, swayTilt]) {
        expect(Math.abs(fn(psi))).toBeLessThanOrEqual(1);
        expect(Math.abs(fn(psi + step) - fn(psi))).toBeLessThan(step * 1.01);
      }
      const f = fallFactor(psi);
      expect(f).toBeGreaterThanOrEqual(0.55 - 1e-12);
      expect(f).toBeLessThanOrEqual(1.45 + 1e-12);
      expect(Math.abs(fallFactor(psi + step) - f)).toBeLessThan(step);
      sum += f;
      n++;
    }
    expect(sum / n).toBeCloseTo(1, 2);
    // Fastest fall at the bottom of the swing, where the offset crosses zero.
    expect(fallFactor(0)).toBeCloseTo(1.45, 12);
    expect(fallFactor(Math.PI / 2)).toBeCloseTo(0.55, 12);
  });
});

describe("gustAt", () => {
  it("stays in [0, 1], changes smoothly and gusts now and then", () => {
    const noise = createNoise(7);
    let prev = gustAt(noise, 0);
    let calm = 0;
    let gusty = 0;
    // Plain comparisons in the hot loop: an expect per sample costs far more than the check.
    const bad: string[] = [];
    for (let t = 1 / 60; t < 900; t += 1 / 60) {
      const g = gustAt(noise, t);
      if (!(g >= 0 && g <= 1 && Math.abs(g - prev) < 0.01) && bad.length < 10) {
        bad.push(`t ${String(t)}: ${String(prev)} -> ${String(g)}`);
      }
      if (g < 0.1) calm++;
      if (g > 0.4) gusty++;
      prev = g;
    }
    expect(bad).toEqual([]);
    expect(calm).toBeGreaterThan(0);
    expect(gusty).toBeGreaterThan(0);
  });
});

describe("createPieces", () => {
  const data = new Float32Array(MAX * PIECE_FLOATS);

  it("is deterministic for a seed", () => {
    const a = createPieces(MAX, 1920);
    const b = createPieces(MAX, 1920);
    for (let k = 0; k < 30; k++) {
      a.step(1 / 60, frame(), data, PIECE_FLOATS);
      b.step(1 / 60, frame(), data, PIECE_FLOATS);
    }
    expect(b.xs).toEqual(a.xs);
    expect(b.ys).toEqual(a.ys);
  });

  it("respawns a piece above the top once it falls off the bottom", () => {
    const pieces = createPieces(MAX, 1920);
    // Fast fall and strong wind, so pieces wrap often on both axes.
    const f = frame({ speed: 3, wind: 1, gusts: 1 });
    const m = [0, 1, 2].map((l) => layerMargin(l, f.size));
    const bad: string[] = [];
    let respawns = 0;
    for (let k = 0; k < 600; k++) {
      const ys = pieces.ys.slice();
      pieces.step(1 / 30, f, data, PIECE_FLOATS);
      for (let i = 0; i < pieces.live; i++) {
        const margin = m[pieces.layer[i]];
        const [x, y] = [pieces.xs[i], pieces.ys[i]];
        if (x < -margin || x > 1920 + margin) bad.push(`x ${String(x)} outside ${String(margin)}`);
        if (y < -margin || y > 1080 + margin) bad.push(`y ${String(y)} outside ${String(margin)}`);
        if (ys[i] - y > 540) {
          respawns++;
          if (ys[i] < 1080 + margin - 30) bad.push(`fell from ${String(ys[i])}`);
          if (y > -margin + 30) bad.push(`respawned at ${String(y)}`);
        }
      }
    }
    expect(bad).toEqual([]);
    expect(respawns).toBeGreaterThan(100);
  });

  it("groups instances back to front by layer and shape", () => {
    for (const season of [SEASONS.autumn, SEASONS.blossom]) {
      const pieces = createPieces(MAX, 1920);
      const f = frame({ season });
      for (let k = 0; k < 120; k++) pieces.step(1 / 60, f, data, PIECE_FLOATS);
      const n = pieces.step(1 / 60, f, data, PIECE_FLOATS);
      expect(n).toBeGreaterThan(0);
      expect(pieces.live).toBe(Math.floor(200 * season.countMul));
      let next = 0;
      for (let g = 0; g < pieces.groups; g++) {
        expect(pieces.groupFirst[g]).toBe(next);
        expect(season.shapes).toContain(pieces.groupShape[g]);
        next += pieces.groupCount[g];
      }
      expect(next).toBe(n);
      for (let i = 0; i < n; i++) {
        const o = i * PIECE_FLOATS;
        expect(data[o + 3]).toBeLessThanOrEqual(1);
        for (let k = 4; k < 7; k++) {
          expect(data[o + k]).toBeGreaterThanOrEqual(0);
          expect(data[o + k]).toBeLessThanOrEqual(1);
        }
        const flip = Math.abs(data[o + 9]);
        expect(flip).toBeGreaterThanOrEqual(0.06 - 1e-6);
        expect(flip).toBeLessThanOrEqual(1);
      }
      // The far layer comes first and the near layer last: every far piece is
      // smaller than every near one.
      const radii = (g: number) =>
        Array.from({ length: pieces.groupCount[g] }, (_, k) => {
          return data[(pieces.groupFirst[g] + k) * PIECE_FLOATS + 2];
        });
      expect(Math.max(...radii(0))).toBeLessThan(Math.min(...radii(pieces.groups - 1)));
    }
  });

  it("fades pieces in from nothing", () => {
    const pieces = createPieces(MAX, 1920);
    expect(pieces.step(1 / 60, frame(), data, PIECE_FLOATS)).toBe(0);
    for (let k = 0; k < 120; k++) pieces.step(1 / 60, frame(), data, PIECE_FLOATS);
    expect(pieces.step(1 / 60, frame(), data, PIECE_FLOATS)).toBe(200);
  });
});

describe("createPieces with a spawn callback", () => {
  const data = new Float32Array(MAX * PIECE_FLOATS);

  it("parks pieces until the callback places them, and draws them at its point", () => {
    let budget = 0;
    let spawned = 0;
    const pieces = createPieces(MAX, 1920, 3, {
      spawn(out) {
        if (budget <= 0) return false;
        budget--;
        spawned++;
        out.x = 500;
        out.y = 300;
        return true;
      },
    });
    const f = frame({ count: 50 });
    // Let the count fade in with nothing spawned: nothing is drawn.
    let drawn = 0;
    for (let k = 0; k < 120; k++) drawn += pieces.step(1 / 60, f, data, PIECE_FLOATS);
    expect(drawn).toBe(0);
    expect(Array.from(pieces.parked.subarray(0, 50)).every((p) => p === 1)).toBe(true);
    budget = 3;
    expect(pieces.step(1 / 60, f, data, PIECE_FLOATS)).toBe(3);
    for (let k = 0; k < 3; k++) {
      expect(data[k * PIECE_FLOATS]).toBeCloseTo(500, 3);
      expect(data[k * PIECE_FLOATS + 1]).toBeCloseTo(300, 3);
    }
    expect(spawned).toBe(3);
  });

  it("parks a piece again when it falls off the bottom, and only offers pieces within the count", () => {
    let offered = 0;
    let refuse = false;
    const pieces = createPieces(MAX, 1920, 3, {
      spawn(out) {
        offered++;
        if (refuse) return false;
        out.x = 960;
        out.y = 1000;
        return true;
      },
    });
    const f = frame({ count: 40, speed: 3 });
    pieces.step(1 / 60, f, data, PIECE_FLOATS);
    expect(offered).toBe(40);
    refuse = true;
    for (let k = 0; k < 300; k++) pieces.step(1 / 30, f, data, PIECE_FLOATS);
    expect(Array.from(pieces.parked.subarray(0, 40)).every((p) => p === 1)).toBe(true);
    expect(Array.from(pieces.parked.subarray(40)).every((p) => p === 1)).toBe(true);
    expect(pieces.step(1 / 30, f, data, PIECE_FLOATS)).toBe(0);
  });

  it("leaves pieces without a callback unparked", () => {
    const pieces = createPieces(MAX, 1920);
    for (let k = 0; k < 30; k++) pieces.step(1 / 60, frame(), data, PIECE_FLOATS);
    expect(pieces.parked.every((p) => p === 0)).toBe(true);
  });
});

describe("writeFoliage", () => {
  const data = new Float32Array(MAX_BLOBS * BLOB_FLOATS);

  it("draws nothing at zero and frames the edges otherwise", () => {
    expect(writeFoliage(data, BLOB_FLOATS, 0, 0, 0, 1920, 1, SEASONS.autumn)).toBe(0);
    const n = writeFoliage(data, BLOB_FLOATS, 12, 1, 0.5, 1920, 2, SEASONS.blossom);
    expect(n).toBe(MAX_BLOBS);
    for (let b = 0; b < n; b++) {
      const o = b * BLOB_FLOATS;
      const x = data[o] / 2;
      const y = data[o + 1] / 2;
      // Clear of the speaker: at a side edge, or above the top of the frame.
      expect(x < 0.35 * 1920 || x > 0.65 * 1920).toBe(true);
      expect(x < 0.15 * 1920 || x > 0.85 * 1920 || y < 0).toBe(true);
      expect(data[o + 3]).toBeGreaterThan(0);
      expect(data[o + 3]).toBeLessThanOrEqual(1);
    }
  });
});
