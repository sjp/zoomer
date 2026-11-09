import { describe, expect, it } from "vitest";
import { clockHands } from "./wall-clock";

describe("clockHands", () => {
  const out = new Float64Array(3);
  it("points every hand at twelve at midnight and noon", () => {
    expect([...clockHands(0, out)]).toEqual([0, 0, 0]);
    expect([...clockHands(0.5, out)]).toEqual([0, 0, 0]);
  });

  it("reads a quarter past three and a half", () => {
    // 15:15:30
    clockHands((15 * 3600 + 15 * 60 + 30) / 86400, out);
    expect(out[0]).toBeCloseTo((Math.PI * 2 * 3.2583333) / 12, 4);
    expect(out[1]).toBeCloseTo((Math.PI * 2 * 15.5) / 60, 4);
    expect(out[2]).toBeCloseTo(Math.PI, 4);
  });

  it("sweeps the second hand smoothly", () => {
    const a = clockHands(1000.25 / 86400, out)[2];
    const b = clockHands(1000.5 / 86400, out)[2];
    expect(b - a).toBeCloseTo((Math.PI * 2 * 0.25) / 60, 6);
  });
});
