import { describe, expect, it } from "vitest";
import { hyperspace, hyperspaceStreakCount } from "./hyperspace";

describe("hyperspaceStreakCount", () => {
  const p = hyperspace.params;

  it("leaves the default settings alone", () => {
    expect(hyperspaceStreakCount(p.count.default, p.width.default, p.stretch.default, 1920)).toBe(
      p.count.default,
    );
    expect(hyperspaceStreakCount(p.count.max, p.width.default, p.stretch.default, 1920)).toBe(
      p.count.max,
    );
  });

  it("draws fewer streaks at the widest, longest settings", () => {
    const n = hyperspaceStreakCount(p.count.max, p.width.max, p.stretch.max, 1920);
    expect(n).toBeGreaterThan(1000);
    expect(n).toBeLessThan(p.count.max);
  });

  it("falls with width and stretch", () => {
    const a = hyperspaceStreakCount(3000, 5, 0.8, 1920);
    expect(hyperspaceStreakCount(3000, 6, 0.8, 1920)).toBeLessThan(a);
    expect(hyperspaceStreakCount(3000, 5, 1, 1920)).toBeLessThan(a);
  });

  it("returns a whole count within 1..count", () => {
    expect(hyperspaceStreakCount(250.5, 1, 0.5, 1920)).toBe(250);
    expect(hyperspaceStreakCount(1e5, 0.5, 0.05, 1920)).toBe(3000);
  });
});
