import { describe, expect, it } from "vitest";
import {
  buildTrack,
  frameAt,
  freeSpeedSquared,
  GRAVITY,
  MIN_SPEED,
  type Track,
} from "./rollercoaster-track";

const track = buildTrack();

const vec = (a: Float64Array, i: number) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

/** The force a rider feels at sample `i`, in g: along the normal (into the seat) and to the side. */
function riderForces(t: Track, i: number): { vertical: number; lateral: number } {
  const a = (i - 1 + t.count) % t.count;
  const b = (i + 1) % t.count;
  const curve = sub(vec(t.tan, b), vec(t.tan, a)).map((c) => c / (2 * t.step));
  const v = t.speed[i];
  const f = [v * v * curve[0], v * v * curve[1] + GRAVITY, v * v * curve[2]];
  return {
    vertical: dot(f, vec(t.nrm, i)) / GRAVITY,
    lateral: dot(f, vec(t.bin, i)) / GRAVITY,
  };
}

describe("buildTrack", () => {
  it("is the same every time", () => {
    const again = buildTrack();
    expect(again.count).toBe(track.count);
    expect(again.pos).toEqual(track.pos);
    expect(again.nrm).toEqual(track.nrm);
  });

  it("samples evenly and closes the circuit", () => {
    expect(track.count * track.step).toBeCloseTo(track.length, 6);
    for (let i = 0; i < track.count; i++) {
      const gap = len(sub(vec(track.pos, (i + 1) % track.count), vec(track.pos, i)));
      expect(gap).toBeGreaterThan(track.step * 0.9);
      expect(gap).toBeLessThan(track.step * 1.1);
    }
  });

  it("turns smoothly everywhere, the join included", () => {
    for (let i = 0; i < track.count; i++) {
      const j = (i + 1) % track.count;
      expect(dot(vec(track.tan, i), vec(track.tan, j))).toBeGreaterThan(Math.cos(0.12));
      expect(dot(vec(track.nrm, i), vec(track.nrm, j))).toBeGreaterThan(Math.cos(0.12));
    }
  });

  it("has orthonormal frames, the binormal to the rider's right", () => {
    for (let i = 0; i < track.count; i++) {
      const t = vec(track.tan, i);
      const n = vec(track.nrm, i);
      const b = vec(track.bin, i);
      expect(len(t)).toBeCloseTo(1, 6);
      expect(len(n)).toBeCloseTo(1, 6);
      expect(len(b)).toBeCloseTo(1, 6);
      expect(Math.abs(dot(t, n))).toBeLessThan(1e-6);
      expect(Math.abs(dot(t, b))).toBeLessThan(1e-6);
      // b = t × n.
      expect(t[1] * n[2] - t[2] * n[1]).toBeCloseTo(b[0], 6);
    }
  });

  it("keeps the station level and upright", () => {
    const n = vec(track.nrm, 0);
    expect(n[1]).toBeGreaterThan(0.99);
    expect(track.pos[1]).toBeGreaterThan(1.4);
  });

  it("stays clear of the ground and turns over only in the loop", () => {
    let inverted = 0;
    for (let i = 0; i < track.count; i++) {
      expect(track.pos[i * 3 + 1]).toBeGreaterThan(1.4);
      if (track.nrm[i * 3 + 1] < 0) {
        inverted++;
      }
    }
    // The loop's top, a stretch of a few tens of metres.
    expect(inverted * track.step).toBeGreaterThan(10);
    expect(inverted * track.step).toBeLessThan(40);
  });

  it("banks into the turns", () => {
    let banked = 0;
    for (let i = 0; i < track.count; i++) {
      const a = (i - 1 + track.count) % track.count;
      const b = (i + 1) % track.count;
      const curve = sub(vec(track.tan, b), vec(track.tan, a));
      const t = vec(track.tan, i);
      // Turning rate about the vertical, positive turning left (towards -z going +x).
      const turn = (t[2] * curve[0] - t[0] * curve[2]) / (2 * track.step);
      const n = vec(track.nrm, i);
      if (Math.abs(turn) < 0.03 || n[1] < 0.3) {
        continue;
      }
      // The normal leans towards the centre of the turn: (t.z, 0, -t.x) points left.
      expect(Math.sign(turn) * (n[0] * t[2] - n[2] * t[0])).toBeGreaterThan(0);
      banked++;
    }
    expect(banked).toBeGreaterThan(50);
  });

  it("gives the train the energy for every hill and the loop", () => {
    const free = freeSpeedSquared(track);
    const crest = Math.round(track.crest / track.step);
    for (let i = crest + 2; i < track.count; i++) {
      expect(free[i]).toBeGreaterThan(MIN_SPEED * MIN_SPEED);
    }
  });

  it("keeps the forces on the riders within a real coaster's", () => {
    let leastInverted = Infinity;
    for (let i = 0; i < track.count; i++) {
      const { vertical, lateral } = riderForces(track, i);
      // Brief peaks of up to 5 g or so where sections join, as on real coasters.
      expect(vertical).toBeGreaterThan(-1);
      expect(vertical).toBeLessThan(5.5);
      expect(Math.abs(lateral)).toBeLessThan(2.5);
      leastInverted = Math.min(leastInverted, track.nrm[i * 3 + 1] < -0.5 ? vertical : Infinity);
    }
    // Upside down, the riders are still pressed into their seats.
    expect(leastInverted).toBeGreaterThan(0.1);
    expect(leastInverted).toBeLessThan(Infinity);
  });

  it("changes speed smoothly: chain on the lift, fast after the drop, braked into the station", () => {
    for (let i = 0; i < track.count; i++) {
      const j = (i + 1) % track.count;
      expect(Math.abs(track.speed[j] - track.speed[i])).toBeLessThan(0.6);
      expect(track.speed[i]).toBeGreaterThanOrEqual(MIN_SPEED);
    }
    let fastest = 0;
    for (const v of track.speed) {
      fastest = Math.max(fastest, v);
    }
    expect(fastest).toBeGreaterThan(18);
    expect(fastest).toBeLessThan(30);
    expect(track.speed[0]).toBeLessThan(4);
  });
});

describe("frameAt", () => {
  it("matches the samples and wraps round", () => {
    const out = new Float64Array(12);
    frameAt(track, 10 * track.step, out);
    expect(out[0]).toBeCloseTo(track.pos[30], 9);
    expect(out[7]).toBeCloseTo(track.nrm[31], 9);
    const wrapped = new Float64Array(12);
    frameAt(track, 10 * track.step + 3 * track.length, wrapped);
    for (let k = 0; k < 12; k++) {
      expect(wrapped[k]).toBeCloseTo(out[k], 6);
    }
    frameAt(track, 10 * track.step - track.length, wrapped);
    expect(wrapped[0]).toBeCloseTo(out[0], 6);
  });

  it("stays orthonormal between samples", () => {
    const out = new Float64Array(12);
    for (let s = 0; s < track.length; s += 0.37) {
      frameAt(track, s, out);
      const t = [out[3], out[4], out[5]];
      const n = [out[6], out[7], out[8]];
      const b = [out[9], out[10], out[11]];
      expect(len(t)).toBeCloseTo(1, 6);
      expect(len(n)).toBeCloseTo(1, 6);
      expect(len(b)).toBeCloseTo(1, 6);
      expect(Math.abs(dot(t, n))).toBeLessThan(1e-6);
    }
  });
});
