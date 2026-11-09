import { describe, expect, it } from "vitest";
import { createBackgroundBuild, createSettledValue, finishBuild, type BuildSteps } from "./rebuild";

/** Sums 0..n-1, yielding after each term. */
function* sum(n: number, log?: number[]): BuildSteps<number> {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += i;
    log?.push(i);
    yield;
  }
  return total;
}

describe("finishBuild", () => {
  it("runs every step and returns the result", () => {
    const log: number[] = [];
    expect(finishBuild(sum(5, log))).toBe(10);
    expect(log).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("createSettledValue", () => {
  it("returns the first value at once", () => {
    const s = createSettledValue<number>(0.3);
    expect(s.value).toBeUndefined();
    expect(s.update(4, 0)).toBe(4);
    expect(s.pending).toBe(false);
  });

  it("adopts a new value only after it has held for the settle time", () => {
    const s = createSettledValue<number>(0.3);
    s.update(1, 0);
    expect(s.update(2, 0.1)).toBe(1);
    expect(s.pending).toBe(true);
    expect(s.update(2, 0.1)).toBe(1);
    expect(s.update(2, 0.1)).toBe(1);
    expect(s.update(2, 0.1)).toBe(2);
    expect(s.pending).toBe(false);
  });

  it("restarts the wait on every change, so a drag settles once at its end", () => {
    const s = createSettledValue<number>(0.3);
    s.update(0, 0);
    const seen = new Set<number>();
    for (let v = 1; v <= 20; v++) {
      seen.add(s.update(v, 1 / 60));
    }
    expect([...seen]).toEqual([0]);
    for (let i = 0; i < 30; i++) {
      seen.add(s.update(20, 1 / 60));
    }
    expect([...seen]).toEqual([0, 20]);
  });

  it("drops a change that returns to the settled value", () => {
    const s = createSettledValue<string>(0.3);
    s.update("a", 0);
    s.update("b", 0.2);
    expect(s.update("a", 0.2)).toBe("a");
    expect(s.pending).toBe(false);
    expect(s.update("a", 1)).toBe("a");
  });

  it("ignores bad time steps", () => {
    const s = createSettledValue<number>(0.3);
    s.update(1, 0);
    s.update(2, Number.NaN);
    expect(s.update(2, -5)).toBe(1);
  });
});

describe("createBackgroundBuild", () => {
  /** A clock that advances 1 ms every time it is read. */
  const tickingClock = () => {
    let t = 0;
    return () => t++;
  };

  it("respects the budget and gives the same result as a one-shot build", () => {
    const build = createBackgroundBuild<string, number>(tickingClock());
    build.request("a", () => sum(100));
    expect(build.building).toBe("a");
    let result: number | undefined;
    let calls = 0;
    while (result === undefined) {
      result = build.step(10);
      calls++;
      expect(calls).toBeLessThan(100);
    }
    // 10 ms per call at one step per ms: about ten calls for 100 steps.
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(calls).toBeLessThanOrEqual(11);
    expect(result).toBe(finishBuild(sum(100)));
    expect(build.built).toBe("a");
    expect(build.building).toBeUndefined();
    expect(build.step(10)).toBeUndefined();
  });

  it("always makes progress, even with no budget", () => {
    const build = createBackgroundBuild<number, number>(() => 0);
    build.request(1, () => sum(3));
    expect(build.step(0)).toBeUndefined();
    expect(build.step(0)).toBeUndefined();
    expect(build.step(0)).toBeUndefined();
    expect(build.step(0)).toBe(3);
  });

  it("keeps a build going when asked for the same key again", () => {
    const build = createBackgroundBuild<number, number>(tickingClock());
    let made = 0;
    const make = () => {
      made++;
      return sum(50);
    };
    build.request(7, make);
    build.step(5);
    build.request(7, make);
    expect(made).toBe(1);
    expect(build.finish()).toBe(finishBuild(sum(50)));
    build.request(7, make);
    expect(made).toBe(1);
    expect(build.building).toBeUndefined();
  });

  it("replaces a build in flight with a new key", () => {
    const build = createBackgroundBuild<number, number>(tickingClock());
    build.request(1, () => sum(50));
    build.step(5);
    build.request(2, () => sum(4));
    expect(build.finish()).toBe(6);
    expect(build.built).toBe(2);
  });

  it("drops a build in flight when asked for the built key", () => {
    const build = createBackgroundBuild<number, number>(tickingClock());
    build.request(1, () => sum(3));
    build.finish();
    build.request(2, () => sum(50));
    build.step(5);
    build.request(1, () => sum(3));
    expect(build.building).toBeUndefined();
    expect(build.finish()).toBeUndefined();
    expect(build.built).toBe(1);
  });

  it("cancels", () => {
    const build = createBackgroundBuild<number, number>(tickingClock());
    build.request(1, () => sum(50));
    build.cancel();
    expect(build.step(100)).toBeUndefined();
    expect(build.built).toBeUndefined();
  });
});
