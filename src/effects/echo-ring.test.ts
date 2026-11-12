import { describe, expect, it } from "vitest";
import { createEchoRing } from "./echo-ring";

describe("createEchoRing", () => {
  it("keeps the newest samples in order after wrapping around", () => {
    const ring = createEchoRing(5, 2);
    for (let v = 1; v <= 13; v++) {
      const o = ring.push();
      ring.data[o] = v;
      ring.data[o + 1] = -v;
    }
    expect(ring.count).toBe(5);
    const newestFirst = Array.from({ length: ring.count }, (_, k) => ring.data[ring.offset(k)]);
    expect(newestFirst).toEqual([13, 12, 11, 10, 9]);
    expect(ring.data[ring.offset(4) + 1]).toBe(-9);
  });

  it("counts up to its capacity, and forgets everything on clear", () => {
    const ring = createEchoRing(3, 1);
    expect(ring.count).toBe(0);
    ring.data[ring.push()] = 1;
    ring.data[ring.push()] = 2;
    expect(ring.count).toBe(2);
    expect([ring.data[ring.offset(0)], ring.data[ring.offset(1)]]).toEqual([2, 1]);
    ring.clear();
    expect(ring.count).toBe(0);
    ring.data[ring.push()] = 5;
    expect(ring.data[ring.offset(0)]).toBe(5);
  });

  it("works with a capacity of one", () => {
    const ring = createEchoRing(1, 3);
    for (let v = 0; v < 4; v++) {
      ring.data[ring.push()] = v;
    }
    expect(ring.count).toBe(1);
    expect(ring.data[ring.offset(0)]).toBe(3);
  });
});
