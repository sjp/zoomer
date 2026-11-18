import { describe, expect, it } from "vitest";
import { MAX_PACE, MIN_PACE } from "./arcade.meta";
import { MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import {
  BLINK_PERIOD,
  blinkLevel,
  CONTACT,
  effectivePace,
  GAME_LINES,
  gameSize,
  highScores,
  LOOP_SECONDS,
  minePosition,
  ordinal,
  PHASES,
  type PhaseState,
  phaseAt,
  planDemo,
  sanitizeInitials,
  SCORE_ROWS,
  scoreAt,
  TUG_SPEED,
  tugAt,
} from "./arcade-sim";

const state = (): PhaseState => ({ index: 0, local: 0 });

/** Real seconds each phase lasts at `pace`, found by stepping the loop clock at 60 fps. */
function phaseLengths(pace: number): { id: string; seconds: number }[] {
  const dt = 1 / 600;
  const out: { id: string; seconds: number }[] = [];
  const s = state();
  let loop = 0;
  let current = -1;
  let start = 0;
  for (let real = 0; real < (LOOP_SECONDS / effectivePace(pace)) * 2; real += dt) {
    phaseAt(loop, s);
    if (s.index !== current) {
      if (current >= 0) {
        out.push({ id: PHASES[current].id, seconds: real - start });
      }
      current = s.index;
      start = real;
    }
    loop += dt * effectivePace(pace);
  }
  return out;
}

describe("the attract loop", () => {
  it.each([MIN_PACE, 1, MAX_PACE])("runs title, demo, scores, coin at pace %s", (pace) => {
    const lengths = phaseLengths(pace).slice(0, 4);
    expect(lengths.map((p) => p.id)).toEqual(["title", "demo", "scores", "coin"]);
    const k = effectivePace(pace);
    // The first title is cut short by starting at loop time 0 (stepping starts mid-phase).
    for (const [i, p] of lengths.slice(1).entries()) {
      expect(p.seconds).toBeCloseTo(PHASES[i + 1].seconds / k, 1);
    }
  });

  it("lasts 6, 20, 8 and 4 s at pace 1", () => {
    expect(PHASES.map((p) => p.seconds)).toEqual([6, 20, 8, 4]);
    expect(LOOP_SECONDS).toBe(38);
    expect(effectivePace(1)).toBe(1);
    expect(phaseAt(5.9, state())).toEqual({ index: 0, local: expect.closeTo(5.9) as number });
    expect(phaseAt(6.1, state()).index).toBe(1);
    expect(phaseAt(26.1, state()).index).toBe(2);
    expect(phaseAt(34.1, state()).index).toBe(3);
    expect(phaseAt(38.1, state()).index).toBe(0);
    expect(phaseAt(-0.5, state()).index).toBe(3);
  });

  it("clamps the pace to its slider and keeps the tug within the codec's per-frame limit", () => {
    expect(effectivePace(0)).toBe(MIN_PACE);
    expect(effectivePace(9)).toBeLessThanOrEqual(MAX_PACE);
    expect(effectivePace(Number.NaN)).toBe(1);
    for (const pace of [MIN_PACE, 1, MAX_PACE]) {
      const px = pxPerReferenceFrame((TUG_SPEED * effectivePace(pace)) / GAME_LINES);
      expect(px).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    }
  });

  it.each([MIN_PACE, 1, MAX_PACE])("blinks INSERT COIN at 1 Hz or slower at pace %s", (pace) => {
    expect(BLINK_PERIOD / effectivePace(pace)).toBeGreaterThanOrEqual(1);
    // Count the rises through half brightness over 10 real seconds.
    const dt = 1 / 120;
    let rises = 0;
    let prev = blinkLevel(0);
    for (let t = dt; t <= 10; t += dt) {
      const v = blinkLevel(t * effectivePace(pace));
      if (prev < 0.5 && v >= 0.5) {
        rises++;
      }
      prev = v;
    }
    expect(rises).toBeLessThanOrEqual(10);
    expect(rises).toBeGreaterThan(0);
  });

  it("ramps the blink softly, never a hard toggle", () => {
    let worst = 0;
    const dt = (1 / 30) * MAX_PACE;
    for (let t = 0; t < 4; t += dt) {
      worst = Math.max(worst, Math.abs(blinkLevel(t + dt) - blinkLevel(t)));
    }
    expect(worst).toBeLessThan(0.35);
  });
});

describe("gameSize", () => {
  it("keeps 224 lines when landscape and 256 px across when portrait", () => {
    expect(gameSize(1920, 1080)).toEqual({ width: 398, height: 224 });
    expect(gameSize(2560, 1080)).toEqual({ width: 531, height: 224 });
    expect(gameSize(1080, 1920)).toEqual({ width: 256, height: 455 });
    expect(gameSize(0, 0)).toEqual({ width: 398, height: 224 });
    expect(gameSize(10000, 1).width).toBeLessThanOrEqual(640);
    expect(gameSize(1, 10000).height).toBeLessThanOrEqual(560);
  });
});

describe("high scores", () => {
  it.each([0, 1, 7, 42, 999])(
    "are ten rows, best first, three letters each, for seed %i",
    (seed) => {
      const rows = highScores(seed, "");
      expect(rows).toHaveLength(SCORE_ROWS);
      for (const r of rows) {
        expect(r.name).toMatch(/^[A-Z]{3}$/);
        expect(r.owner).toBe(false);
        expect(r.score).toBeGreaterThan(0);
        expect(r.score % 50).toBe(0);
      }
      const scores = rows.map((r) => r.score);
      expect(scores).toEqual(scores.toSorted((a, b) => b - a));
      expect(new Set(scores).size).toBe(SCORE_ROWS);
      expect(new Set(rows.map((r) => r.name)).size).toBe(SCORE_ROWS);
      expect(highScores(seed, "")).toEqual(rows);
    },
  );

  it("puts the owner's initials at the top", () => {
    const rows = highScores(3, "SJP");
    expect(rows).toHaveLength(SCORE_ROWS);
    expect(rows[0]).toMatchObject({ name: "SJP", owner: true });
    expect(rows.slice(1).every((r) => !r.owner)).toBe(true);
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
    expect(rows.slice(1).map((r) => r.name)).toEqual(
      highScores(3, "")
        .slice(0, 9)
        .map((r) => r.name),
    );
  });

  it("keeps up to three characters of the initials the font can draw", () => {
    expect(sanitizeInitials("sjp")).toBe("SJP");
    expect(sanitizeInitials("a b")).toBe("AB");
    expect(sanitizeInitials("é東#Z9x7")).toBe("Z9X");
    expect(sanitizeInitials("")).toBe("");
  });

  it("writes ranks as ordinals", () => {
    expect([1, 2, 3, 4, 10, 11, 12, 13, 21].map((n) => ordinal(n))).toEqual([
      "1ST",
      "2ND",
      "3RD",
      "4TH",
      "10TH",
      "11TH",
      "12TH",
      "13TH",
      "21ST",
    ]);
  });
});

const SIZES: [number, number][] = [
  [398, 224],
  [531, 224],
  [299, 224],
  [256, 455],
];

describe("the demo", () => {
  it("is the same for the same seed and size", () => {
    const a = planDemo(5, 398, 224);
    const b = planDemo(5, 398, 224);
    expect(b.tug).toEqual(a.tug);
    expect(b.crateOut).toEqual(a.crateOut);
    expect(planDemo(6, 398, 224).tug).not.toEqual(a.tug);
  });

  const cases = SIZES.flatMap(([w, h]) =>
    Array.from({ length: 12 }, (_, i) => [i * 37 + 1, w, h] as const),
  );

  it.each(cases)("never lets the tug touch a mine (seed %i, %i x %i)", (seed, w, h) => {
    const plan = planDemo(seed, w, h);
    const tug = new Float64Array(4);
    const p = [0, 0];
    let least = Infinity;
    for (let t = 0; t <= 20.8; t += 1 / 120) {
      tugAt(plan, t, tug);
      for (const m of plan.mines) {
        minePosition(m, t, p);
        least = Math.min(least, Math.hypot(tug[0] - p[0], tug[1] - p[1]));
      }
    }
    expect(least).toBeGreaterThan(CONTACT);
  });

  it.each(cases)(
    "keeps the tug out of the middle third most of the time (seed %i, %i x %i)",
    (seed, w, h) => {
      const plan = planDemo(seed, w, h);
      const tug = new Float64Array(4);
      let middle = 0;
      let n = 0;
      for (let t = 0; t <= 20; t += 1 / 30) {
        tugAt(plan, t, tug);
        if (tug[0] > w / 3 && tug[0] < (2 * w) / 3) {
          middle++;
        }
        n++;
      }
      expect(middle / n).toBeLessThan(0.4);
    },
  );

  it.each(cases)("collects crates and counts the score up (seed %i, %i x %i)", (seed, w, h) => {
    const plan = planDemo(seed, w, h);
    let collected = 0;
    for (let k = 0; k < plan.crates; k++) {
      if (plan.crateOut[k] <= 20) {
        collected++;
      }
    }
    expect(collected).toBeGreaterThanOrEqual(3);
    let prev = 0;
    for (let t = 0; t <= 20; t += 0.1) {
      const s = scoreAt(plan, t);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
    expect(prev).toBeGreaterThan(0);
  });

  it("moves the tug no faster than its top speed", () => {
    const plan = planDemo(11, 398, 224);
    const a = new Float64Array(4);
    const b = new Float64Array(4);
    const dt = 1 / 30;
    for (let t = 0; t < 20; t += dt) {
      tugAt(plan, t, a);
      tugAt(plan, t + dt, b);
      expect(Math.hypot(b[0] - a[0], b[1] - a[1]) / dt).toBeLessThanOrEqual(TUG_SPEED * 1.01);
    }
  });
});
