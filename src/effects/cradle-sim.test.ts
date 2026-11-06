import { describe, expect, it } from "vitest";
import {
  BALL_R,
  ballAngle,
  ballCount,
  createLayout,
  createView,
  cradleLayout,
  DECAY,
  finishOf,
  FINISHES,
  GRAVITY,
  CM_PER_UNIT,
  HALF_PERIOD,
  liftedCount,
  onPlane,
  pendulumPeriod,
  PIVOT_Y,
  project,
  restX,
  SCENES,
  sceneOf,
  SEAT_Y,
  SLOW,
  sortByDepth,
  STRING_LEN,
  swingAmplitude,
  swingRadians,
  swingState,
  TOPUP_SWINGS,
  WOBBLE,
} from "./cradle-sim";
import { BALLS_RANGE, FINISH_OPTIONS, SCENE_OPTIONS, SIZE_RANGE, SWING_RANGE } from "./cradle.meta";

const AMP = swingRadians(25);
const state = new Float64Array(4);

/** The outward angle of the group that swings during half period n. */
function groupAngle(t: number, n: number): number {
  swingState(t, AMP, state);
  return (n & 1) === 0 ? state[0] : state[1];
}

describe("period", () => {
  it("matches the string length", () => {
    const len = (STRING_LEN * CM_PER_UNIT) / 100;
    expect(pendulumPeriod()).toBeCloseTo(2 * Math.PI * Math.sqrt(len / GRAVITY) * SLOW, 12);
    expect(pendulumPeriod(4 * STRING_LEN)).toBeCloseTo(2 * pendulumPeriod(), 12);
    expect(HALF_PERIOD).toBeCloseTo(pendulumPeriod() / 2, 12);
    // Calm: a click somewhere between every half second and every second and a half.
    expect(HALF_PERIOD).toBeGreaterThan(0.5);
    expect(HALF_PERIOD).toBeLessThan(1.5);
  });

  it("each group's swing lasts exactly half a period", () => {
    // Out and back: zero at both ends of its half period, at full amplitude in the middle.
    const n = 4;
    expect(groupAngle(n * HALF_PERIOD + 1e-9, n)).toBeCloseTo(0, 6);
    expect(groupAngle((n + 0.5) * HALF_PERIOD, n)).toBeCloseTo(swingAmplitude(n, AMP), 9);
    expect(groupAngle((n + 1) * HALF_PERIOD - 1e-9, n)).toBeCloseTo(0, 6);
  });
});

describe("swing", () => {
  it("is continuous at every impact and passes the speed to the other end", () => {
    const eps = 1e-6;
    let worst = 0;
    let badSpeed = 0;
    for (let n = 1; n <= 3 * TOPUP_SWINGS; n++) {
      const t = n * HALF_PERIOD;
      swingState(t - eps, AMP, state);
      const before = [state[0], state[1]];
      swingState(t + eps, AMP, state);
      const after = [state[0], state[1]];
      // Every angle is (near) zero on both sides of the impact.
      worst = Math.max(worst, ...before.map(Math.abs), ...after.map(Math.abs));
      // The arriving group (n - 1) stops, the other end leaves.
      const arriving = (n - 1) & 1;
      const leaving = n & 1;
      const vIn = before[arriving] / eps;
      const vOut = after[leaving] / eps;
      expect(after[arriving]).toBe(0);
      const expected = n % TOPUP_SWINGS === 0 ? (AMP * Math.PI) / HALF_PERIOD : vIn * DECAY;
      badSpeed = Math.max(badSpeed, Math.abs(vOut - expected) / expected);
    }
    expect(worst).toBeLessThan(1e-5);
    expect(badSpeed).toBeLessThan(1e-4);
  });

  it("decays each swing and is topped up every TOPUP_SWINGS", () => {
    expect(swingAmplitude(0, AMP)).toBe(AMP);
    expect(swingAmplitude(1, AMP)).toBeCloseTo(AMP * DECAY, 12);
    expect(swingAmplitude(TOPUP_SWINGS, AMP)).toBe(AMP);
    expect(swingAmplitude(-1, AMP)).toBeCloseTo(AMP * DECAY ** (TOPUP_SWINGS - 1), 12);
    expect(swingAmplitude(TOPUP_SWINGS - 1, AMP)).toBeGreaterThan(0.75 * AMP);
  });

  it("never has both end groups away from rest", () => {
    let both = 0;
    let moving = 0;
    for (let t = 0; t < 40; t += 0.013) {
      swingState(t, AMP, state);
      if (state[0] !== 0 && state[1] !== 0) both++;
      if (state[0] > 1e-3 || state[1] > 1e-3) moving++;
    }
    expect(both).toBe(0);
    expect(moving).toBeGreaterThan(2500);
  });

  it("moves only the end groups, and the middle balls by a hair", () => {
    for (const [count, lifted] of [
      [5, 1],
      [5, 2],
      [7, 2],
      [3, 1],
    ]) {
      let leftAndRight = 0;
      let bigMiddle = 0;
      for (let t = 0; t < 20; t += 0.017) {
        swingState(t, AMP, state);
        let left = false;
        let right = false;
        for (let i = 0; i < count; i++) {
          const a = ballAngle(i, count, lifted, state);
          if (i < lifted && a !== 0) left = true;
          else if (i >= count - lifted && a !== 0) right = true;
          else if (Math.abs(a) > WOBBLE * AMP + 1e-12) bigMiddle++;
        }
        if (left && right) leftAndRight++;
      }
      expect([count, lifted, leftAndRight, bigMiddle]).toEqual([count, lifted, 0, 0]);
    }
  });

  it("with 2 of 3 lifted, the middle ball swings with both ends", () => {
    let leftSide = 0;
    let rightSide = 0;
    for (let t = 0; t < 4 * HALF_PERIOD; t += 0.05) {
      swingState(t, AMP, state);
      const a = ballAngle(1, 3, 2, state);
      if (a < -0.05) leftSide++;
      if (a > 0.05) rightSide++;
    }
    expect(leftSide).toBeGreaterThan(0);
    expect(rightSide).toBeGreaterThan(0);
  });

  it("no two balls ever overlap, at any count, lift and swing", () => {
    let worst = Infinity;
    const xs = new Float64Array(BALLS_RANGE[1]);
    const ys = new Float64Array(BALLS_RANGE[1]);
    for (let count: number = BALLS_RANGE[0]; count <= BALLS_RANGE[1]; count++) {
      for (const lifted of [1, 2]) {
        const m = liftedCount(lifted, count);
        for (const deg of [SWING_RANGE[0], 25, SWING_RANGE[1]]) {
          const amp = swingRadians(deg);
          for (let t = 0; t < 6 * HALF_PERIOD; t += 0.004) {
            swingState(t, amp, state);
            for (let i = 0; i < count; i++) {
              const a = ballAngle(i, count, m, state);
              xs[i] = restX(i, count) + STRING_LEN * Math.sin(a);
              ys[i] = PIVOT_Y - STRING_LEN * Math.cos(a);
            }
            for (let i = 1; i < count; i++) {
              worst = Math.min(worst, Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
            }
          }
        }
      }
    }
    expect(worst).toBeGreaterThan(2 * BALL_R - 1e-6);
  });
});

describe("params", () => {
  it("clamps counts and swing, and survives NaN", () => {
    expect(ballCount(1)).toBe(BALLS_RANGE[0]);
    expect(ballCount(99)).toBe(BALLS_RANGE[1]);
    expect(ballCount(Number.NaN)).toBe(BALLS_RANGE[0]);
    expect(liftedCount(2, 3)).toBe(2);
    expect(liftedCount(5, 7)).toBe(2);
    expect(liftedCount(0, 5)).toBe(1);
    expect(liftedCount(Number.NaN, 5)).toBe(1);
    expect(swingRadians(90)).toBeCloseTo((SWING_RANGE[1] * Math.PI) / 180, 12);
    expect(swingRadians(Number.NaN)).toBeCloseTo((SWING_RANGE[0] * Math.PI) / 180, 12);
  });

  it("has a palette for every scene and finish, falling back for unknown ids", () => {
    for (const o of SCENE_OPTIONS) expect(sceneOf(o.value)).toBe(SCENES[o.value]);
    for (const o of FINISH_OPTIONS) expect(finishOf(o.value)).toBe(FINISHES[o.value]);
    expect(sceneOf("nope")).toBe(SCENES.studio);
    expect(finishOf("toString")).toBe(FINISHES.chrome);
  });
});

describe("view and layout", () => {
  it("onPlane inverts project on any horizontal plane", () => {
    const v = createView(1);
    const p = new Float64Array(3);
    const w = new Float64Array(2);
    let worst = 0;
    for (const [x, y, z] of [
      [0, 0, 0],
      [3, 0.5, -2],
      [-7, 2, 1.5],
    ]) {
      project(v, x, y, z, p);
      onPlane(v, p[0], p[1], y, w);
      worst = Math.max(worst, Math.abs(w[0] - x), Math.abs(w[1] - z));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("puts the cradle in the chosen bottom corner, inside the frame, mirrored", () => {
    const right = createLayout();
    const left = createLayout();
    for (const aspect of [4 / 3, 16 / 9, 21 / 9]) {
      for (const size of [SIZE_RANGE[0], 1, SIZE_RANGE[1]]) {
        for (let count: number = BALLS_RANGE[0]; count <= BALLS_RANGE[1]; count++) {
          cradleLayout(aspect, size, count, createView(1), right);
          cradleLayout(aspect, size, count, createView(-1), left);
          const b = right.box;
          // Clear of the speaker in the middle third.
          expect(b[0]).toBeGreaterThan((2 * aspect) / 3);
          expect(b[2]).toBeLessThanOrEqual(aspect);
          expect(b[1]).toBeGreaterThanOrEqual(0);
          expect(b[3]).toBeLessThan(0.5);
          expect(left.box[0]).toBeCloseTo(aspect - b[2], 9);
          expect(left.box[2]).toBeCloseTo(aspect - b[0], 9);
          expect(left.oy).toBeCloseTo(right.oy, 12);
        }
      }
    }
  });

  it("is about a fifth of a 16:9 frame wide by default, sitting on the desk", () => {
    const l = cradleLayout(16 / 9, 1, 5, createView(1), createLayout());
    const width = l.box[2] - l.box[0];
    expect(width / (16 / 9)).toBeGreaterThan(0.17);
    expect(width / (16 / 9)).toBeLessThan(0.26);
    // The base's near corner, the lowest point, sits at SEAT_Y.
    expect(l.oy).toBeGreaterThan(SEAT_Y);
    expect(l.box[1]).toBeLessThan(SEAT_Y);
  });

  it("sorts balls far to near", () => {
    const depth = [0.5, -2, 3, 1, -1];
    const order = new Int32Array(5);
    sortByDepth(depth, 5, order);
    expect(Array.from(order)).toEqual([1, 4, 0, 3, 2]);
  });
});
