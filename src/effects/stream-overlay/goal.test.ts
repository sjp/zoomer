import { describe, expect, it } from "vitest";
import { createGoal, GOAL_FILL_SECONDS, GOAL_HOLD_SECONDS, goalRaise } from "./goal";
import { createStreamEvents } from "./stream-events";

const DT = 1 / 60;

describe("goalRaise", () => {
  it.each([
    [10, 10],
    [100, 50],
    [250, 130],
    [1000, 500],
  ])("raises a %i target by %i", (base, raise) => {
    expect(goalRaise(base)).toBe(raise);
  });
});

describe("createGoal", () => {
  it("starts at the start fraction, without easing in", () => {
    const goal = createGoal();
    goal.configure(0.8, 100);
    goal.step(DT);
    expect([goal.count, goal.target, goal.fill, goal.holding]).toEqual([80, 100, 0.8, false]);
  });

  it("never shows a count above the target, and holds when it's reached", () => {
    const goal = createGoal();
    goal.configure(0.8, 100);
    const events = createStreamEvents(5);
    let holds = 0;
    let wasHolding = false;
    for (let t = 0; t < 4 * 3600; t += 0.25) {
      const before = events.follows;
      events.step(0.25, 60, "all");
      goal.add(events.follows - before);
      goal.step(0.25);
      expect(goal.count).toBeLessThanOrEqual(goal.target);
      expect(goal.count < goal.target || goal.holding).toBe(true);
      if (goal.holding && !wasHolding) {
        holds++;
      }
      wasHolding = goal.holding;
    }
    expect(holds).toBeGreaterThanOrEqual(3);
  });

  it("holds full for a while, then raises the target and eases the bar back", () => {
    const goal = createGoal();
    goal.configure(0.9, 10);
    goal.step(DT);
    goal.add(1);
    expect([goal.count, goal.target, goal.holding]).toEqual([10, 10, true]);
    // A follow during the hold isn't shown yet.
    goal.add(1);
    expect(goal.count).toBe(10);
    for (let t = 0; t < GOAL_HOLD_SECONDS - 0.5; t += DT) {
      goal.step(DT);
    }
    expect(goal.holding).toBe(true);
    expect(goal.fill).toBe(1);
    expect(goal.glow).toBe(1);
    for (let t = 0; t < 1; t += DT) {
      goal.step(DT);
    }
    expect(goal.holding).toBe(false);
    expect([goal.count, goal.target]).toEqual([11, 20]);
    expect(goal.fill).toBeGreaterThan(0.55);
    expect(goal.fill).toBeLessThan(1);
    for (let t = 0; t < GOAL_FILL_SECONDS + 0.1; t += DT) {
      goal.step(DT);
    }
    expect(goal.fill).toBeCloseTo(0.55, 9);
    expect(goal.glow).toBe(0);
  });

  it("only ever raises the target while its params stand", () => {
    const goal = createGoal();
    goal.configure(0.5, 20);
    let last = 0;
    for (let i = 0; i < 2000; i++) {
      if (i % 7 === 0) {
        goal.add(1 + (i % 3));
      }
      goal.step(0.5);
      expect(goal.target).toBeGreaterThanOrEqual(last);
      last = goal.target;
    }
    expect(last).toBeGreaterThan(20);
  });

  it("raises past a count far beyond the target in one go", () => {
    const goal = createGoal();
    goal.configure(0.5, 100);
    goal.step(DT);
    goal.add(500);
    expect(goal.holding).toBe(true);
    goal.step(GOAL_HOLD_SECONDS + 0.1);
    expect(goal.holding).toBe(false);
    expect(goal.target).toBe(600);
    expect(goal.count).toBe(550);
  });

  it.each([
    ["goalStart", 0.25, 20, 0.5],
    ["goalTarget", 0.5, 100, 0.55],
  ])("eases the bar when %s changes", (_, start, base, end) => {
    const goal = createGoal();
    goal.configure(0.5, 20);
    goal.step(DT);
    goal.add(5);
    goal.step(GOAL_FILL_SECONDS + DT);
    expect(goal.fill).toBe(0.75);
    goal.configure(start, base);
    goal.step(DT);
    // One frame in, it has hardly moved.
    expect(goal.fill).toBeGreaterThan(0.74);
    let previous = goal.fill;
    for (let t = DT; t < GOAL_FILL_SECONDS - DT / 2; t += DT) {
      goal.step(DT);
      expect(goal.fill).toBeLessThanOrEqual(previous);
      expect(previous - goal.fill).toBeLessThan(0.01);
      previous = goal.fill;
    }
    goal.step(DT);
    expect(goal.fill).toBeCloseTo(end, 9);
  });

  it("stops holding when a param change takes the goal out of reach", () => {
    const goal = createGoal();
    goal.configure(1, 100);
    goal.step(DT);
    expect(goal.holding).toBe(true);
    goal.configure(1, 200);
    // The start fraction is of the new target: still reached.
    expect(goal.holding).toBe(true);
    goal.configure(0.5, 200);
    expect(goal.holding).toBe(false);
    expect([goal.count, goal.target]).toEqual([100, 200]);
  });

  it("bumps its version only when the count or target changes", () => {
    const goal = createGoal();
    goal.configure(0.5, 100);
    goal.step(DT);
    const v = goal.version;
    goal.configure(0.5, 100);
    goal.step(DT);
    expect(goal.version).toBe(v);
    goal.add(1);
    expect(goal.version).toBe(v + 1);
  });
});
