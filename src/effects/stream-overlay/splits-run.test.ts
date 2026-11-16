import { describe, expect, it } from "vitest";
import {
  createSplitsSession,
  formatSplitDiff,
  formatSplitTime,
  HOLD_SECONDS,
  parseSplitLine,
  parseSplitTime,
  planSplits,
  simulateRun,
  SPLIT_AHEAD,
  SPLIT_BEHIND,
  SPLIT_BEST,
  SPLIT_PENDING,
  START_SECONDS,
  textSeed,
  windowStart,
} from "./splits-run";

const LIST = "Tutorial\nForest\nBoss 1\nCaves\nCastle\nFinal Boss";

describe("parseSplitTime", () => {
  it.each([
    ["45", 45],
    ["7.5", 7.5],
    ["4:32", 272],
    ["9:05.5", 545.5],
    ["0:59", 59],
    ["1:02:10", 3730],
    ["1:02:10.25", 3730.25],
    [" 12:00 ", 720],
  ])("reads %j", (text, seconds) => {
    expect(parseSplitTime(text)).toBeCloseTo(seconds, 9);
  });

  it.each(["", "abc", "59:60", "4:7", "1:60:00", "1:2:03", ":30", "4:32.", "1.2.3", "-5", "4:32x"])(
    "rejects %j",
    (text) => {
      expect(parseSplitTime(text)).toBeNull();
    },
  );
});

describe("parseSplitLine", () => {
  it("reads a name alone", () => {
    expect(parseSplitLine("Tutorial")).toEqual({ name: "Tutorial", time: null });
  });

  it("reads a name and a time after two or more spaces", () => {
    expect(parseSplitLine("Forest      4:32")).toEqual({ name: "Forest", time: 272 });
    expect(parseSplitLine("Final Boss  1:02:10")).toEqual({ name: "Final Boss", time: 3730 });
  });

  it("keeps a single-spaced number as part of the name", () => {
    expect(parseSplitLine("Boss 1")).toEqual({ name: "Boss 1", time: null });
    expect(parseSplitLine("World 1 4:32")).toEqual({ name: "World 1 4:32", time: null });
  });

  it("keeps a time that doesn't parse as part of the name", () => {
    expect(parseSplitLine("Castle  59:60")).toEqual({ name: "Castle 59:60", time: null });
  });

  it.each(["", "   ", "　"])("skips the blank line %j", (line) => {
    expect(parseSplitLine(line)).toBeNull();
  });

  it("reads a time with no name", () => {
    expect(parseSplitLine("   4:32")).toEqual({ name: "", time: 272 });
  });

  it("keeps a very long name whole (the text param cuts it)", () => {
    const name = "A".repeat(80);
    expect(parseSplitLine(`${name}  1:00`)).toEqual({ name, time: 60 });
  });
});

describe("planSplits", () => {
  it("skips blank lines and names nameless splits", () => {
    const plan = planSplits("\nTutorial\n   \n  2:00\nCaves\n", 300, 1);
    expect(plan.names).toEqual(["Tutorial", "Split 2", "Caves"]);
    expect(plan.comparison[1]).toBe(120);
  });

  it("has one split for an empty list", () => {
    const plan = planSplits("  \n\n", 300, 1);
    expect(plan.names).toEqual(["Finish"]);
    expect([...plan.comparison]).toEqual([300]);
  });

  it.each([1, 7, 999])("makes up times summing to the run length (seed %i)", (seed) => {
    const plan = planSplits(LIST, 300, seed);
    expect(plan.comparison[5]).toBe(300);
    for (let i = 0; i < 6; i++) {
      expect(plan.comparison[i]).toBeGreaterThan(i > 0 ? plan.comparison[i - 1] : 0);
    }
  });

  it.each([60, 1800])("ends exactly at a %is run", (seconds) => {
    expect(planSplits(LIST, seconds, 3).comparison[5]).toBe(seconds);
  });

  it("is stable for the same seed and varies with it", () => {
    expect(planSplits(LIST, 300, 5).comparison).toEqual(planSplits(LIST, 300, 5).comparison);
    expect(planSplits(LIST, 300, 5).comparison).not.toEqual(planSplits(LIST, 300, 6).comparison);
  });

  it("keeps given times and shares the gaps between them", () => {
    const plan = planSplits("A\nB  2:00\nC\nD\nE  5:00", 600, 2);
    expect(plan.comparison[1]).toBe(120);
    expect(plan.comparison[4]).toBe(300);
    expect(plan.comparison[0]).toBeGreaterThan(0);
    expect(plan.comparison[0]).toBeLessThan(120);
    expect(plan.comparison[2]).toBeGreaterThan(120);
    expect(plan.comparison[3]).toBeGreaterThan(plan.comparison[2]);
    expect(plan.comparison[3]).toBeLessThan(300);
  });

  it("shares out the rest of the run after the last given time", () => {
    const plan = planSplits("A  1:00\nB\nC", 300, 2);
    expect(plan.comparison[0]).toBe(60);
    expect(plan.comparison[2]).toBe(300);
  });

  it("drops decreasing times but keeps their names", () => {
    const plan = planSplits("A  3:00\nB  2:00\nC  2:00\nD  4:00", 300, 2);
    expect(plan.names).toEqual(["A", "B", "C", "D"]);
    expect(plan.comparison[0]).toBe(180);
    expect(plan.comparison[3]).toBe(240);
    expect(plan.comparison[1]).toBeGreaterThan(180);
    expect(plan.comparison[2]).toBeGreaterThan(plan.comparison[1]);
    expect(plan.comparison[2]).toBeLessThan(240);
  });

  it("gives splits after an overlong given time some time of their own", () => {
    const plan = planSplits("A  20:00\nB\nC", 300, 2);
    expect(plan.comparison[1]).toBeGreaterThan(1200);
    expect(plan.comparison[2]).toBeGreaterThan(plan.comparison[1]);
  });

  it("never throws on odd input", () => {
    for (const list of ["", "\n\n\n", "0", "0:00", "  :  ", "A  0", "x".repeat(500)]) {
      expect(() => planSplits(list, Number.NaN, 1)).not.toThrow();
    }
  });
});

describe("simulateRun", () => {
  const { comparison } = planSplits(LIST, 300, 1);

  it.each([0, 1, 2])("is deterministic per seed (run %i)", (run) => {
    expect(simulateRun(comparison, 0.5, 9, run)).toEqual(simulateRun(comparison, 0.5, 9, run));
    expect(simulateRun(comparison, 0.5, 9, run)).not.toEqual(simulateRun(comparison, 0.5, 10, run));
  });

  it.each([1, 2, 3])("is always slower at luck 0 and quicker at luck 1 (seed %i)", (seed) => {
    for (let run = 0; run < 5; run++) {
      const slow = simulateRun(comparison, 0, seed, run);
      const fast = simulateRun(comparison, 1, seed, run);
      for (let i = 0; i < comparison.length; i++) {
        const segment = comparison[i] - (i > 0 ? comparison[i - 1] : 0);
        expect(slow[i]).toBeGreaterThan(segment);
        expect(fast[i]).toBeLessThan(segment);
      }
    }
  });
});

/** Runs a session through `runs` whole runs, collecting each finished split's result. */
function collect(luck: number, seed: number, runs: number): number[] {
  const session = createSplitsSession(seed);
  session.configure(LIST, 5, luck);
  const results: number[] = [];
  while (session.run < runs) {
    const before = session.current;
    const run = session.run;
    session.step(0.1);
    if (session.run === run) {
      for (let i = before; i < session.current; i++) {
        results.push(session.results[i]);
      }
    }
  }
  return results;
}

describe("createSplitsSession", () => {
  it.each([1, 2, 3])("finishes splits ahead, behind and best at luck 0.5 (seed %i)", (seed) => {
    const results = collect(0.5, seed, 4);
    expect(results).toContain(SPLIT_AHEAD);
    expect(results).toContain(SPLIT_BEHIND);
    expect(results).toContain(SPLIT_BEST);
    expect(results).not.toContain(SPLIT_PENDING);
  });

  it.each([1, 2])("is always behind at luck 0 (seed %i)", (seed) => {
    expect(new Set(collect(0, seed, 3))).toEqual(new Set([SPLIT_BEHIND]));
  });

  it.each([1, 2])("is always ahead (or best) at luck 1 (seed %i)", (seed) => {
    const results = collect(1, seed, 3);
    expect(results).not.toContain(SPLIT_BEHIND);
    // The first run beats the comparison everywhere, so every segment is a best.
    expect(results.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => SPLIT_BEST));
  });

  it("only calls a segment best when it beats every earlier run", () => {
    const session = createSplitsSession(4);
    session.configure(LIST, 5, 0.5);
    const best = [...planSplits(LIST, 300, textSeed(LIST)).comparison].map(
      (t, i, a) => t - (i > 0 ? a[i - 1] : 0),
    );
    let run = session.run;
    let seen = 0;
    while (session.run < 6) {
      session.step(0.05);
      if (session.run !== run) {
        run = session.run;
        seen = 0;
      }
      for (; seen < session.current; seen++) {
        const segment = session.finished[seen] - (seen > 0 ? session.finished[seen - 1] : 0);
        const isBest = segment < best[seen];
        expect(session.results[seen] === SPLIT_BEST).toBe(isBest);
        if (isBest) {
          best[seen] = segment;
        }
      }
    }
  });

  it("rests at zero, counts up, holds the final time, then starts over", () => {
    const session = createSplitsSession(1);
    session.configure(LIST, 5, 0.5);
    session.step(START_SECONDS - 0.1);
    expect(session.time).toBe(0);
    session.step(0.6);
    expect(session.time).toBeCloseTo(0.5, 9);
    while (session.current < session.count) {
      session.step(0.1);
    }
    const final = session.time;
    expect(final).toBe(session.finished[session.count - 1]);
    session.step(HOLD_SECONDS - 0.2);
    expect(session.time).toBe(final);
    expect(session.run).toBe(0);
    session.step(0.3);
    expect(session.run).toBe(1);
    expect(session.current).toBe(0);
    expect(session.time).toBe(0);
    expect([...session.results]).toEqual(Array.from({ length: 6 }, () => SPLIT_PENDING));
  });

  it("is deterministic per seed", () => {
    const a = createSplitsSession(3);
    const b = createSplitsSession(3);
    a.configure(LIST, 5, 0.5);
    b.configure(LIST, 5, 0.5);
    for (let i = 0; i < 4000; i++) {
      a.step(0.25);
      b.step(0.25);
    }
    expect(a.run).toBe(b.run);
    expect(a.time).toBe(b.time);
    expect(a.results).toEqual(b.results);
  });

  it("catches up across runs in one long step", () => {
    const session = createSplitsSession(1);
    session.configure(LIST, 1, 0.5);
    session.step(3600);
    expect(session.run).toBeGreaterThan(10);
  });

  it("renames splits in place when the count stays the same", () => {
    const session = createSplitsSession(1);
    session.configure(LIST, 5, 0.5);
    const comparison = [...session.comparison];
    const version = session.namesVersion;
    session.configure(LIST.replace("Forest", "Swamp  1:00"), 5, 0.5);
    expect(session.names[1]).toBe("Swamp");
    expect(session.namesVersion).toBeGreaterThan(version);
    // The new time waits for the next run.
    expect([...session.comparison]).toEqual(comparison);
  });

  it("takes a new list length or run length at the next run", () => {
    const session = createSplitsSession(1);
    session.configure(LIST, 5, 0.5);
    session.configure("A\nB", 2, 0.5);
    expect(session.count).toBe(6);
    expect(session.names[0]).toBe("Tutorial");
    while (session.run === 0) {
      session.step(1);
    }
    expect(session.count).toBe(2);
    expect(session.names).toEqual(["A", "B"]);
    expect(session.comparison[1]).toBe(120);
  });
});

describe("windowStart", () => {
  it.each(
    [1, 3, 5, 6, 20].flatMap((count) =>
      [1, 2, 4, 5, 10, 25].map((visible) => [count, visible] as const),
    ),
  )("keeps the current split in view (%i splits, %i rows)", (count, visible) => {
    let previous = windowStart(0, count, visible);
    for (let current = 0; current <= count; current++) {
      const start = windowStart(current, count, visible);
      const shown = Math.min(count - 1, current);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(start + Math.min(visible, count)).toBeLessThanOrEqual(count);
      expect(shown).toBeGreaterThanOrEqual(start);
      expect(shown).toBeLessThan(start + visible);
      expect(Math.abs(start - previous)).toBeLessThanOrEqual(1);
      previous = start;
    }
  });
});

describe("formatSplitTime", () => {
  it.each([
    [0, "0.0"],
    [7.39, "7.3"],
    [0.3, "0.3"],
    [59.99, "59.9"],
    [60, "1:00.0"],
    [272.5, "4:32.5"],
    [3730.25, "1:02:10.2"],
    [-3, "0.0"],
  ])("shows %d s as %j", (seconds, text) => {
    expect(formatSplitTime(seconds)).toBe(text);
  });

  it("signs differences", () => {
    expect(formatSplitDiff(4.25)).toBe("+4.2");
    expect(formatSplitDiff(-63.5)).toBe("−1:03.5");
  });
});
