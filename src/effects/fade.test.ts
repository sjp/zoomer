import { describe, expect, it } from "vitest";
import { growLive, stepLife, trimLive } from "./fade";

/** One frame of the documented loop; returns the new live count. */
function frame(life: Float32Array, live: number, target: number, step: number): number {
  live = growLive(life, live, target);
  for (let i = 0; i < live; i++) {
    stepLife(life, i, target, step, step);
  }
  return trimLive(life, live, target);
}

describe("count fades", () => {
  it("fades added items in from 0", () => {
    const life = new Float32Array(4).fill(1);
    let live = frame(life, 0, 2, 0.25);
    expect(live).toBe(2);
    expect([...life]).toEqual([0.25, 0.25, 1, 1]);
    for (let k = 0; k < 10; k++) {
      live = frame(life, live, 2, 0.25);
    }
    expect(life[0]).toBe(1);
  });

  it("keeps removed items live until they have faded out", () => {
    const life = new Float32Array(4).fill(1);
    let live = 4;
    live = frame(life, live, 2, 0.5);
    expect(live).toBe(4);
    expect([...life]).toEqual([1, 1, 0.5, 0.5]);
    live = frame(life, live, 2, 0.5);
    expect(live).toBe(2);
    expect([...life]).toEqual([1, 1, 0, 0]);
  });

  it("fades items back in from where they were when the count rises mid fade-out", () => {
    const life = new Float32Array(4).fill(1);
    let live = frame(life, 4, 1, 0.25);
    expect(life[2]).toBe(0.75);
    live = frame(life, live, 3, 0.25);
    expect(live).toBe(4);
    expect([...life]).toEqual([1, 1, 1, 0.5]);
  });

  it("restarts items beyond the live range at 0", () => {
    const life = new Float32Array(3).fill(0.7);
    expect(growLive(life, 1, 3)).toBe(3);
    expect([...life].map((v) => Math.round(v * 10) / 10)).toEqual([0.7, 0, 0]);
  });

  it("trims only from the top", () => {
    const life = new Float32Array([1, 0, 0.5, 0]);
    expect(trimLive(life, 4, 1)).toBe(3);
    expect(trimLive(life, 4, 4)).toBe(4);
  });
});
