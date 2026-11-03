import { describe, expect, it } from "vitest";
import {
  BOARD_RAIL,
  buildRun,
  createMarbles,
  freeAdvance,
  hopOffset,
  HOP_LEN,
  LIFT_SPEED,
  MARBLE_R,
  type MarbleSide,
  MAX_LEVELS,
  MIN_GAP,
  MIN_LEVELS,
  placeMarbles,
  pointAt,
  RAIL_HALF,
  ROLL_SPEED,
  SEG_DROP,
  SEG_LIFT,
  SEG_ROLL,
  segmentAt,
  spinAt,
  stepMarbles,
} from "./marblerun-sim";
import { createRng } from "./noise";
import { MAX_MARBLES } from "./marblerun.meta";

const ASPECT = 16 / 9;
const SIDES: MarbleSide[] = ["left", "right"];
const LEVELS = [3, 4, 5, 6];
const runs = SIDES.flatMap((side) =>
  LEVELS.map((levels) => ({ side, levels, run: buildRun(levels, side, ASPECT) })),
);
const p = [0, 0];
const q = [0, 0];

describe("buildRun", () => {
  it("is one closed, continuous loop", () => {
    let worst = 0;
    for (const { run } of runs) {
      const segs = run.segments;
      for (let i = 0; i < segs.length; i++) {
        const a = segs[i];
        const b = segs[(i + 1) % segs.length];
        worst = Math.max(worst, Math.hypot(a.x1 - b.x0, a.y1 - b.y0));
        if (i > 0) worst = Math.max(worst, Math.abs(segs[i - 1].s0 + segs[i - 1].len - a.s0));
        // pointAt agrees with the segment's ends.
        pointAt(run, a.s0, p);
        worst = Math.max(worst, Math.hypot(p[0] - a.x0, p[1] - a.y0));
        pointAt(run, a.s0 + a.len - 1e-9, p);
        worst = Math.max(worst, Math.hypot(p[0] - a.x1, p[1] - a.y1));
      }
      const last = segs[segs.length - 1];
      worst = Math.max(worst, Math.abs(last.s0 + last.len - run.length));
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("has no jumps anywhere along the path", () => {
    let worst = 0;
    for (const { run } of runs) {
      const ds = 0.002;
      pointAt(run, 0, q);
      for (let s = ds; s <= run.length + 1e-9; s += ds) {
        pointAt(run, s, p);
        // A drop's chord parameter runs at most ~2× faster than its arc near the end.
        worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1]) / ds);
        q[0] = p[0];
        q[1] = p[1];
      }
    }
    expect(worst).toBeLessThan(2.5);
  });

  it("has tracks, drops and one lift in order", () => {
    let bad = 0;
    for (const { levels, run } of runs) {
      const kinds = run.segments.map((s) => s.kind);
      const rails = levels + (levels % 2);
      if (run.rails !== rails || run.hasReturn !== (levels % 2 === 1)) bad++;
      if (kinds.length !== 2 * rails) bad++;
      for (let k = 0; k < rails; k++) {
        if (kinds[2 * k] !== SEG_ROLL) bad++;
        if (kinds[2 * k + 1] !== (k === rails - 1 ? SEG_LIFT : SEG_DROP)) bad++;
      }
      for (const seg of run.segments) {
        if (!(seg.len > 0) || !(seg.rate > 0)) bad++;
        // Drops fall, rolls go down hill, the lift goes up.
        if (seg.kind === SEG_LIFT ? seg.y1 <= seg.y0 : seg.y1 >= seg.y0) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it("fits in the frame on its side", () => {
    let bad = 0;
    for (const { side, run } of runs) {
      if (!(run.top < 0.96)) bad++;
      const boards = [...run.back, ...run.front];
      for (const b of boards) {
        for (const [x, y] of [
          [b.ax, b.ay],
          [b.bx, b.by],
        ]) {
          if (x < 0 || x > ASPECT || y < 0 || y > 1) bad++;
          if (side === "left" ? x > 0.64 : x < ASPECT - 0.64) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("mirrors the right side from the left", () => {
    for (const levels of LEVELS) {
      const l = buildRun(levels, "left", ASPECT);
      const r = buildRun(levels, "right", ASPECT);
      expect(r.length).toBeCloseTo(l.length, 9);
      const mirrored = l.segments.map((s) => [ASPECT - s.x0, s.y0, ASPECT - s.x1, s.y1]);
      const right = r.segments.map((s) => [s.x0, s.y0, s.x1, s.y1]);
      expect(
        right
          .flat()
          .map((v, i) => v - mirrored.flat()[i])
          .every((d) => Math.abs(d) < 1e-9),
      ).toBe(true);
    }
  });

  it("clamps the level count", () => {
    expect(buildRun(1, "left", ASPECT).rails).toBe(MIN_LEVELS + 1);
    expect(buildRun(99, "left", ASPECT).rails).toBe(MAX_LEVELS);
    expect(buildRun(Number.NaN, "left", ASPECT).rails).toBe(6);
  });

  it("puts each rail just under its track's path", () => {
    let worst = 0;
    for (const { run } of runs) {
      const rails = run.front.filter((b) => b.kind === BOARD_RAIL);
      const rolls = run.segments.filter((s) => s.kind === SEG_ROLL);
      expect(rails.length).toBe(rolls.length);
      for (let k = 0; k < rolls.length; k++) {
        const s = rolls[k];
        const r = rails[k];
        const lx = r.bx - r.ax;
        const ly = r.by - r.ay;
        const l = Math.hypot(lx, ly);
        for (const [x, y] of [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ]) {
          // Signed distance above the rail's centre line.
          const cross = (lx * (y - r.ay) - ly * (x - r.ax)) / l;
          const above = lx > 0 ? cross : -cross;
          worst = Math.max(worst, Math.abs(above - (MARBLE_R + RAIL_HALF)));
        }
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });
});

describe("hopOffset", () => {
  it("is a small bounce that starts and ends at zero", () => {
    expect(hopOffset(0)).toBe(0);
    expect(hopOffset(HOP_LEN)).toBe(0);
    expect(hopOffset(-1)).toBe(0);
    expect(hopOffset(HOP_LEN * (2 / 3))).toBeCloseTo(0, 12);
    expect(hopOffset(HOP_LEN / 3)).toBeGreaterThan(0.004);
    expect(hopOffset(HOP_LEN / 3)).toBeLessThan(MARBLE_R);
  });
});

describe("freeAdvance", () => {
  it("moves at the segment's rate and crosses boundaries", () => {
    const run = buildRun(4, "left", ASPECT);
    const first = run.segments[0];
    expect(freeAdvance(run, 0, 1)).toBeCloseTo(ROLL_SPEED, 12);
    const lift = run.segments[run.segments.length - 1];
    expect(freeAdvance(run, lift.s0, 1)).toBeCloseTo(LIFT_SPEED, 12);
    // From just before the first drop: the rest of the track, then the drop's rate.
    const s = first.len - 0.01;
    const drop = run.segments[1];
    const t = 0.01 / ROLL_SPEED + 0.05;
    expect(freeAdvance(run, s, t)).toBeCloseTo(0.01 + 0.05 * drop.rate, 9);
    // Round the end of the loop.
    expect(freeAdvance(run, run.length - 0.007, 1)).toBeCloseTo(
      0.007 + (1 - 0.007 / LIFT_SPEED) * ROLL_SPEED,
      9,
    );
  });
});

describe("spinAt", () => {
  it("rolls without slipping on tracks and holds still on the lift", () => {
    const run = buildRun(5, "left", ASPECT);
    const seg = run.segments[0];
    // Track 0 runs right on the left side: clockwise, so the angle falls.
    expect(spinAt(run, seg.s0 + 0.1) - spinAt(run, seg.s0)).toBeCloseTo(-0.1 / MARBLE_R, 9);
    const odd = run.segments[2];
    expect(spinAt(run, odd.s0 + 0.1) - spinAt(run, odd.s0)).toBeCloseTo(0.1 / MARBLE_R, 9);
    const lift = run.segments[run.segments.length - 1];
    expect(spinAt(run, lift.s0 + 0.05)).toBeCloseTo(spinAt(run, lift.s0), 12);
    expect(run.loopSpin).toBeCloseTo(spinAt(run, run.length - 1e-12), 6);
  });
});

describe("stepMarbles", () => {
  /** Smallest centre distance between any two marbles. */
  function closest(run: ReturnType<typeof buildRun>, s: Float64Array, n: number): number {
    let min = Infinity;
    for (let i = 0; i < n; i++) {
      pointAt(run, s[i], p);
      for (let j = i + 1; j < n; j++) {
        pointAt(run, s[j], q);
        min = Math.min(min, Math.hypot(p[0] - q[0], p[1] - q[1]));
      }
    }
    return min;
  }

  it("places marbles evenly and keeps them apart", () => {
    let min = Infinity;
    let jump = 0;
    let orderBroken = 0;
    for (const { run } of runs) {
      const m = createMarbles(MAX_MARBLES);
      placeMarbles(run, m, MAX_MARBLES);
      expect(m.count).toBe(MAX_MARBLES);
      const rng = createRng(run.rails * 7 + (run.x0 > 1 ? 1 : 0));
      const prev = new Float64Array(MAX_MARBLES);
      const fast = Math.max(...run.segments.map((s) => s.rate));
      for (let step = 0; step < 300; step++) {
        const dt = 0.01 + 0.09 * rng();
        prev.set(m.s);
        stepMarbles(run, m, dt * 2);
        for (let i = 0; i < m.count; i++) {
          pointAt(run, prev[i], q);
          pointAt(run, m.s[i], p);
          // Continuous: a drop's fall runs up to twice its chord rate.
          jump = Math.max(jump, Math.hypot(p[0] - q[0], p[1] - q[1]) / (fast * dt * 2));
        }
        // The cyclic order never changes: exactly one wrap round the ring.
        let descents = 0;
        for (let i = 0; i < m.count; i++) if (m.s[(i + 1) % m.count] < m.s[i]) descents++;
        if (descents !== 1) orderBroken++;
        if (step % 2 === 0) min = Math.min(min, closest(run, m.s, m.count));
      }
    }
    expect(orderBroken).toBe(0);
    expect(jump).toBeLessThan(2.1);
    expect(min).toBeGreaterThan(2 * MARBLE_R);
  });

  it("queues a marble behind a slower one instead of overlapping", () => {
    const run = buildRun(4, "right", ASPECT);
    const m = createMarbles(2);
    m.count = 2;
    const lift = run.segments[run.segments.length - 1];
    m.s[1] = lift.s0 + 0.001;
    m.s[0] = lift.s0 - MIN_GAP - 0.002;
    stepMarbles(run, m, 0.2);
    const gap = m.s[1] - m.s[0];
    expect(gap).toBeGreaterThanOrEqual(MIN_GAP - 1e-12);
    expect(gap).toBeLessThan(MIN_GAP + 1e-9);
    // The leader moved at the lift's pace.
    expect(m.s[1]).toBeCloseTo(lift.s0 + 0.001 + 0.2 * LIFT_SPEED, 12);
    expect(segmentAt(run, m.s[0])).toBe(run.segments.length - 2);
  });

  it("spins marbles as they roll and ignores bad steps", () => {
    const run = buildRun(3, "left", ASPECT);
    const m = createMarbles(4);
    placeMarbles(run, m, 1);
    m.s[0] = 0;
    m.spin[0] = 1;
    stepMarbles(run, m, 0.1);
    expect(m.spin[0]).toBeCloseTo(1 - (0.1 * ROLL_SPEED) / MARBLE_R, 9);
    const s = m.s[0];
    stepMarbles(run, m, Number.NaN);
    stepMarbles(run, m, -1);
    expect(m.s[0]).toBe(s);
    placeMarbles(run, m, 0);
    expect(m.count).toBe(0);
    stepMarbles(run, m, 0.1);
  });
});
