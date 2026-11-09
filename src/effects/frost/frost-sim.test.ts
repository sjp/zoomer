import { describe, expect, it } from "vitest";
import {
  ARRIVAL_FILL,
  buildFrostField,
  cycleSeed,
  edgeMetric,
  effectiveArrival,
  fieldSize,
  FIELD_ROWS,
  growFrost,
  MAX_LIGHTS,
  MAX_TREES,
  METRIC_MAX,
  NEVER,
  reachLimit,
  REACH_MIN,
  sceneLayout,
  stampSegment,
  THICKEN,
  buildFrostFieldSteps,
  type FrostField,
} from "./frost-sim";
import { SCENE_OPTIONS } from "./frost.meta";

const { width: W, height: H } = fieldSize(16 / 9);

/**
 * Index of the first element where `a` and `b` differ (by Object.is, as `toEqual`
 * compares numbers), or -1 when they match. A plain loop: `toEqual` on the
 * half-million floats of a field takes most of a second.
 */
function firstDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return Math.min(a.length, b.length);
  }
  for (let i = 0; i < a.length; i++) {
    if (!Object.is(a[i], b[i])) {
      return i;
    }
  }
  return -1;
}
const field = buildFrostField(1234, W, H);

describe("fieldSize", () => {
  it("keeps square texels at FIELD_ROWS rows", () => {
    expect(fieldSize(16 / 9)).toEqual({ width: 640, height: FIELD_ROWS });
    expect(fieldSize(1)).toEqual({ width: FIELD_ROWS, height: FIELD_ROWS });
    expect(fieldSize(Number.NaN)).toEqual({ width: 640, height: FIELD_ROWS });
    expect(fieldSize(100).width).toBe(FIELD_ROWS * 6);
  });
});

describe("edgeMetric", () => {
  it("is 0 at the centre, 1 mid-edge and largest in the corners", () => {
    expect(edgeMetric(0.5, 0.5)).toBe(0);
    expect(edgeMetric(0, 0.5)).toBeCloseTo(1);
    expect(edgeMetric(0.5, 1)).toBeCloseTo(1);
    expect(edgeMetric(1, 1)).toBeCloseTo(METRIC_MAX);
  });

  it("keeps the centre third inside the closest reach", () => {
    expect(edgeMetric(2 / 3, 2 / 3)).toBeLessThan(REACH_MIN - 0.04);
  });
});

describe("reachLimit and effectiveArrival", () => {
  it("reaches further in with more coverage", () => {
    expect(reachLimit(1)).toBe(REACH_MIN);
    expect(reachLimit(0)).toBeGreaterThan(reachLimit(0.5));
    expect(reachLimit(0.5)).toBeGreaterThan(reachLimit(1));
    expect(reachLimit(Number.NaN)).toBe(reachLimit(0.75));
  });

  it("delays frost past the limit and leaves it alone inside", () => {
    expect(effectiveArrival(0.3, 0.9, 0.6)).toBe(0.3);
    expect(effectiveArrival(0.3, 0.5, 0.6)).toBeGreaterThan(0.3);
    expect(effectiveArrival(0.3, 0.4, 0.6)).toBeGreaterThan(effectiveArrival(0.3, 0.5, 0.6));
  });
});

describe("cycleSeed", () => {
  it("is deterministic and changes per cycle and per seed", () => {
    expect(cycleSeed(7, 3)).toBe(cycleSeed(7, 3));
    expect(cycleSeed(7, 3)).not.toBe(cycleSeed(7, 4));
    expect(cycleSeed(7, 3)).not.toBe(cycleSeed(8, 3));
  });
});

describe("stampSegment", () => {
  it("arrives on the line first, widens over THICKEN and keeps the earliest arrival", () => {
    const w = 20;
    const h = 10;
    const a = new Float32Array(w * h).fill(NEVER);
    stampSegment(a, w, h, 2, 5, 0.2, 2, 18, 5, 0.6, 2);
    expect(a[4 * w + 2]).toBeCloseTo(0.2 + 0.4 * (0.5 / 16) + THICKEN * (0.5 / 2), 5);
    expect(a[4 * w + 10]).toBeGreaterThan(a[4 * w + 5]);
    expect(a[5 * w + 10]).toBeCloseTo(a[4 * w + 10], 5);
    expect(a[0]).toBeGreaterThan(0.2 + THICKEN);
    const before = a[4 * w + 10];
    stampSegment(a, w, h, 2, 5, 0.9, 2, 18, 5, 0.9, 2);
    expect(a[4 * w + 10]).toBe(before);
  });
});

describe("buildFrostField", () => {
  // Two full-size field builds: seconds of CPU once the full suite shares the cores.
  it("is deterministic per seed", { timeout: 20_000 }, () => {
    const again = buildFrostField(1234, W, H);
    expect(firstDiff(again.data, field.data)).toBe(-1);
    const other = buildFrostField(4321, W, H);
    expect(firstDiff(other.data, field.data)).not.toBe(-1);
  });

  it("holds finite arrivals in [0, NEVER] and the edge metric", () => {
    let bad = 0;
    for (let k = 0; k < W * H; k++) {
      const a = field.data[k * 2];
      if (!(Number.isFinite(a) && a >= 0 && a <= NEVER)) {
        bad++;
      }
    }
    expect(bad).toBe(0);
    const centre = (H / 2) * W + W / 2;
    expect(field.data[centre * 2 + 1]).toBeLessThan(0.01);
  });

  it("reaches a good part of the frame", () => {
    let reached = 0;
    for (let k = 0; k < W * H; k++) {
      if (field.data[k * 2] < 1) {
        reached++;
      }
    }
    expect(reached / (W * H)).toBeGreaterThan(0.25);
  });

  it("reaches the edges before the inner frost", () => {
    let edgeSum = 0;
    let edgeN = 0;
    let innerSum = 0;
    let innerN = 0;
    for (let k = 0; k < W * H; k++) {
      const a = field.data[k * 2];
      const m = field.data[k * 2 + 1];
      if (a >= 1) {
        continue;
      }
      if (m > 0.93) {
        edgeSum += a;
        edgeN++;
      } else if (m < 0.7) {
        innerSum += a;
        innerN++;
      }
    }
    expect(edgeN).toBeGreaterThan(0);
    expect(innerN).toBeGreaterThan(0);
    expect(edgeSum / edgeN).toBeLessThan(innerSum / innerN - 0.15);
  });

  // Two more full-size field builds, like the determinism test.
  it("never covers the centre third, even at full coverage", { timeout: 20_000 }, () => {
    for (const seed of [1, 2, 3]) {
      const f = seed === 1 ? field : buildFrostField(seed, W, H);
      let covered = 0;
      for (let j = Math.ceil(H / 3); j < Math.floor((2 * H) / 3); j++) {
        for (let i = Math.ceil(W / 3); i < Math.floor((2 * W) / 3); i++) {
          const k = j * W + i;
          if (effectiveArrival(f.data[k * 2], f.data[k * 2 + 1], reachLimit(1)) <= 1) {
            covered++;
          }
        }
      }
      expect(covered).toBe(0);
    }
  });
});

describe("growFrost", () => {
  const skeleton = growFrost(99, W, H);

  it("normalises the latest arrival to ARRIVAL_FILL", () => {
    let max = 0;
    for (const b of skeleton.branches) {
      for (let i = 2; i < b.points.length; i += 3) {
        max = Math.max(max, b.points[i]);
      }
    }
    expect(max).toBeCloseTo(ARRIVAL_FILL, 6);
  });

  it("starts each child at its parent's arrival at the branch point, and never earlier", () => {
    let children = 0;
    // Plain comparisons over every branch point: an expect per point dominates the runtime.
    const wrong: string[] = [];
    const fail = (msg: string) => wrong.length < 10 && wrong.push(msg);
    skeleton.branches.forEach((b, k) => {
      const p = b.points;
      if (!Object.is(p[2], b.parentArrival)) {
        fail(`branch ${String(k)} starts at ${String(p[2])}, not ${String(b.parentArrival)}`);
      }
      for (let i = 5; i < p.length; i += 3) {
        if (!(p[i] >= p[i - 3])) {
          fail(`branch ${String(k)}, point ${String((i - 2) / 3)} arrives earlier`);
        }
      }
      if (b.parent < 0) {
        return;
      }
      children++;
      const parent = skeleton.branches[b.parent];
      if (!(parent.depth <= b.depth)) {
        fail(`branch ${String(k)} is shallower than its parent`);
      }
      let found = false;
      const q = parent.points;
      for (let i = 0; i < q.length; i += 3) {
        if (q[i] === p[0] && q[i + 1] === p[1] && q[i + 2] === p[2]) {
          found = true;
        }
      }
      if (!found) {
        fail(`branch ${String(k)} does not start on its parent`);
      }
    });
    expect(wrong).toEqual([]);
    expect(children).toBeGreaterThan(100);
  });

  it("grows side branches and needles", () => {
    const depths = new Set(skeleton.branches.map((b) => b.depth));
    expect([...depths].toSorted((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it("keeps every point inside the frame and outside the reach limit", () => {
    // Plain comparisons over every point: an expect per point dominates the runtime.
    const stray: string[] = [];
    for (const b of skeleton.branches) {
      for (let i = 3; i < b.points.length; i += 3) {
        const x = b.points[i];
        const y = b.points[i + 1];
        const inFrame = x >= 0 && x < W && y >= 0 && y < H;
        if (!(inFrame && edgeMetric(x / W, y / H) >= REACH_MIN) && stray.length < 10) {
          stray.push(`(${String(x)}, ${String(y)})`);
        }
      }
    }
    expect(stray).toEqual([]);
  });
});

describe("sceneLayout", () => {
  it("fills lights and trees per scene, within range and deterministically", () => {
    for (const { value } of SCENE_OPTIONS) {
      const s = sceneLayout(value, 7);
      expect(sceneLayout(value, 7)).toEqual(s);
      expect(s.lightCount).toBeLessThanOrEqual(MAX_LIGHTS);
      expect(s.treeCount).toBeLessThanOrEqual(MAX_TREES);
      for (let i = 0; i < s.lightCount; i++) {
        expect(s.lights[i * 4]).toBeGreaterThanOrEqual(0);
        expect(s.lights[i * 4]).toBeLessThanOrEqual(1);
        expect(s.lights[i * 4 + 2]).toBeGreaterThan(0);
      }
      for (const c of s.lightColors) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
    expect(sceneLayout("lights", 7).lightCount).toBeGreaterThan(5);
    const trees = sceneLayout("trees", 7);
    expect(trees.treeCount).toBeGreaterThan(5);
    for (let i = 1; i < trees.treeCount; i++) {
      expect(trees.trees[i * 4 + 3]).toBeLessThanOrEqual(trees.trees[i * 4 - 1]);
    }
    const plain = sceneLayout("plain", 7);
    expect(plain.lightCount + plain.treeCount).toBe(0);
    expect(sceneLayout("nonsense", 7).lightCount).toBe(0);
  });
});

describe("buildFrostFieldSteps", () => {
  it("gives exactly the one-shot field, in many small steps", () => {
    const steps = buildFrostFieldSteps(11, 160, 90);
    let yields = 0;
    let result: FrostField | undefined;
    while (result === undefined) {
      const r = steps.next();
      if (r.done === true) {
        result = r.value;
      } else {
        yields++;
      }
    }
    expect(yields).toBeGreaterThan(20);
    expect(firstDiff(result.data, buildFrostField(11, 160, 90).data)).toBe(-1);
  });
});
