import { describe, expect, it } from "vitest";
import {
  BELL_FLOATS,
  CHAIN_POINTS,
  CHAINS_PER_JELLY,
  createSwarm,
  PALETTES,
  paletteFor,
  pulseCurve,
  resetChain,
  shiftChain,
  STRIP_FLOATS,
  STRIP_VERTS,
  type StripStyle,
  stepChain,
  type SwarmFrame,
  thrustCurve,
  writeStrip,
} from "./jellyfish-sim";
import { createRng } from "./noise";
import { MAX_JELLIES } from "./jellyfish.meta";

const segLengths = (pos: Float32Array, c: number, n: number) => {
  const out: number[] = [];
  for (let k = 1; k < n; k++) {
    const a = (c * n + k - 1) * 2;
    const b = (c * n + k) * 2;
    out.push(Math.hypot(pos[b] - pos[a], pos[b + 1] - pos[a + 1]));
  }
  return out;
};

describe("pulse and thrust curves", () => {
  it("are bounded in [0, 1] and periodic with period 1", () => {
    for (let i = 0; i <= 400; i++) {
      const p = i / 100 - 2;
      for (const f of [pulseCurve, thrustCurve]) {
        const v = f(p);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(f(p + 1)).toBeCloseTo(v, 5);
        expect(f(p - 3)).toBeCloseTo(v, 5);
      }
    }
  });

  it("start relaxed, contract fully, and are continuous across the wrap", () => {
    expect(pulseCurve(0)).toBe(0);
    expect(Math.max(...Array.from({ length: 101 }, (_, i) => pulseCurve(i / 100)))).toBeCloseTo(
      1,
      3,
    );
    expect(pulseCurve(0.9999)).toBeLessThan(1e-6);
    expect(thrustCurve(0.9999)).toBe(0);
    expect(thrustCurve(0.2)).toBeGreaterThan(0.5);
    // No step larger than a smooth curve allows.
    for (let i = 0; i < 1000; i++) {
      expect(Math.abs(pulseCurve((i + 1) / 1000) - pulseCurve(i / 1000))).toBeLessThan(0.01);
      expect(Math.abs(thrustCurve((i + 1) / 1000) - thrustCurve(i / 1000))).toBeLessThan(0.01);
    }
  });
});

describe("chains", () => {
  const n = CHAIN_POINTS;

  it("keep their segment lengths while the anchor moves", () => {
    const pos = new Float32Array(2 * n * 2);
    const vel = new Float32Array(pos.length);
    resetChain(pos, vel, 1, n, 10, 20, 5);
    for (let s = 0; s < 300; s++) {
      const t = s / 60;
      stepChain(
        pos,
        vel,
        1,
        n,
        10 + 40 * Math.sin(t * 3),
        20 + 30 * Math.cos(t * 2),
        5,
        1 / 60,
        3,
        30,
        0.97,
      );
      for (const l of segLengths(pos, 1, n)) {
        expect(l).toBeCloseTo(5, 3);
      }
    }
    // Chain 0 is untouched.
    expect(pos.subarray(0, n * 2).every((v) => v === 0)).toBe(true);
  });

  it("settle hanging straight down when the anchor stops", () => {
    const pos = new Float32Array(n * 2);
    const vel = new Float32Array(pos.length);
    resetChain(pos, vel, 0, n, 0, 0, 4);
    // Swing it about, then hold the anchor still.
    for (let s = 0; s < 60; s++) {
      stepChain(pos, vel, 0, n, s * 3, 0, 4, 1 / 60, 0, 50, 0.97);
    }
    for (let s = 0; s < 2000; s++) {
      stepChain(pos, vel, 0, n, 180, 0, 4, 1 / 60, 0, 50, 0.97);
    }
    // At rest: another step moves nothing.
    const before = Float32Array.from(pos);
    stepChain(pos, vel, 0, n, 180, 0, 4, 1 / 60, 0, 50, 0.97);
    for (let i = 0; i < pos.length; i++) {
      expect(Math.abs(pos[i] - before[i])).toBeLessThan(1e-3);
    }
    for (let k = 0; k < n; k++) {
      expect(pos[k * 2]).toBeCloseTo(180, 1);
      expect(pos[k * 2 + 1]).toBeCloseTo(4 * k, 1);
    }
  });

  it("only enforce lengths at dt = 0, and survive points on top of each other", () => {
    const pos = new Float32Array(n * 2);
    const vel = new Float32Array(pos.length);
    stepChain(pos, vel, 0, n, 5, 5, 3, 0, 0, 10, 0.9);
    expect(pos.every((v) => Number.isFinite(v))).toBe(true);
    expect(vel.every((v) => v === 0)).toBe(true);
    for (const l of segLengths(pos, 0, n)) {
      expect(l).toBeCloseTo(3, 4);
    }
  });

  it("shift without changing shape", () => {
    const pos = new Float32Array(n * 2);
    const vel = new Float32Array(pos.length);
    resetChain(pos, vel, 0, n, 1, 2, 3);
    shiftChain(pos, 0, n, 100, -50);
    expect(pos[0]).toBe(101);
    expect(pos[1]).toBe(-48);
    for (const l of segLengths(pos, 0, n)) {
      expect(l).toBeCloseTo(3, 4);
    }
  });
});

describe("writeStrip", () => {
  const style: StripStyle = {
    width: 3,
    taper: 0.5,
    minWidth: 1.5,
    frill: 0,
    frillPhase: 0.2,
    r: 1,
    g: 0.5,
    b: 0.25,
    fade: 1.4,
  };

  it("writes 2n + 2 vertices per chain, with degenerate joins", () => {
    const n = CHAIN_POINTS;
    const pos = new Float32Array(2 * n * 2);
    const vel = new Float32Array(pos.length);
    resetChain(pos, vel, 0, n, 0, 0, 5);
    resetChain(pos, vel, 1, n, 50, 0, 5);
    const out = new Float32Array(2 * STRIP_VERTS * STRIP_FLOATS);
    let v = writeStrip(out, 0, pos, 0, n, 2, style);
    expect(v).toBe(STRIP_VERTS);
    v = writeStrip(out, v, pos, 1, n, 2, style);
    expect(v).toBe(2 * STRIP_VERTS);
    const vert = (i: number) => Array.from(out.subarray(i * STRIP_FLOATS, (i + 1) * STRIP_FLOATS));
    expect(vert(0)).toEqual(vert(1));
    expect(vert(STRIP_VERTS - 1)).toEqual(vert(STRIP_VERTS - 2));
    expect(vert(STRIP_VERTS)).toEqual(vert(STRIP_VERTS + 1));
    // A vertical chain: the strip spans x, at least minWidth either side, in device px.
    expect(out[0]).toBeCloseTo(-6);
    expect(out[STRIP_FLOATS * 2]).toBeCloseTo(6);
    const tip = (STRIP_VERTS - 1) * STRIP_FLOATS;
    expect(Math.abs(out[tip])).toBeGreaterThanOrEqual(1.5 * 2 - 1e-6);
    // Colour fades to zero at the tip.
    expect(out[tip + 3]).toBe(0);
    expect(out[3]).toBeCloseTo(1);
  });

  it("produces no NaN for zero-length segments", () => {
    const n = CHAIN_POINTS;
    const pos = new Float32Array(n * 2).fill(7);
    const out = new Float32Array(STRIP_VERTS * STRIP_FLOATS);
    expect(writeStrip(out, 0, pos, 0, n, 1, style)).toBe(STRIP_VERTS);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
    expect(writeStrip(out, 0, pos, 0, n, 1, { ...style, frill: 0.4 })).toBe(STRIP_VERTS);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe("palettes", () => {
  it("fall back to mixed for unknown names", () => {
    expect(paletteFor("violet")).toBe(PALETTES.violet);
    expect(paletteFor("nope")).toBe(PALETTES.mixed);
    expect(paletteFor("constructor")).toBe(PALETTES.mixed);
  });
});

describe("createSwarm", () => {
  const frame = (over: Partial<SwarmFrame> = {}): SwarmFrame => ({
    refWidth: 1920,
    scale: 1,
    count: 10,
    size: 60,
    pulse: 2.5,
    tentacles: 1,
    glow: 0.5,
    palette: PALETTES.mixed,
    ...over,
  });
  const bellStride = BELL_FLOATS + 2;
  const bells = new Float32Array(MAX_JELLIES * bellStride);
  const strips = new Float32Array(MAX_JELLIES * CHAINS_PER_JELLY * STRIP_VERTS * STRIP_FLOATS);

  it("wraps jellyfish around the frame, keeping the count and depths", () => {
    const swarm = createSwarm(createRng(3), 1920);
    const depths = Array.from(swarm.depth);
    const f = frame();
    for (let s = 0; s < 1500; s++) {
      swarm.step(0.1, f, bells, bellStride, BELL_FLOATS, strips);
      expect(swarm.live).toBe(10);
    }
    expect(swarm.wraps).toBeGreaterThanOrEqual(10);
    expect(Array.from(swarm.depth)).toEqual(depths);
    expect(swarm.bells).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(swarm.y[i]).toBeGreaterThan(-1000);
      expect(swarm.y[i]).toBeLessThan(2100);
    }
    expect(
      strips.subarray(0, swarm.stripVerts * STRIP_FLOATS).every((v) => Number.isFinite(v)),
    ).toBe(true);
    expect(bells.every((v) => Number.isFinite(v))).toBe(true);
  }, 30_000);

  it("fades jellyfish out when the count drops, and writes nothing for zero-length tentacles", () => {
    const swarm = createSwarm(createRng(5), 1920);
    swarm.step(0, frame({ count: 6 }), bells, bellStride, BELL_FLOATS, strips);
    for (let s = 0; s < 120; s++) {
      swarm.step(1 / 60, frame({ count: 6 }), bells, bellStride, BELL_FLOATS, strips);
    }
    expect(swarm.bells).toBe(6);
    swarm.step(1 / 60, frame({ count: 2 }), bells, bellStride, BELL_FLOATS, strips);
    expect(swarm.live).toBe(6);
    for (let s = 0; s < 120; s++) {
      swarm.step(1 / 60, frame({ count: 2 }), bells, bellStride, BELL_FLOATS, strips);
    }
    expect(swarm.live).toBe(2);
    expect(swarm.bells).toBe(2);
    swarm.step(1 / 60, frame({ count: 2, tentacles: 0 }), bells, bellStride, BELL_FLOATS, strips);
    expect(
      strips.subarray(0, swarm.stripVerts * STRIP_FLOATS).every((v) => Number.isFinite(v)),
    ).toBe(true);
  });

  it("rescales x positions with the width", () => {
    const swarm = createSwarm(createRng(9), 1920);
    const x0 = swarm.x[0];
    swarm.rescaleX(0.5);
    expect(swarm.x[0]).toBeCloseTo(x0 * 0.5, 3);
  });
});
