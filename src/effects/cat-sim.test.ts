import { describe, expect, it } from "vitest";
import {
  advanceTrack,
  beamFor,
  beamLight,
  BOX_LOCAL,
  BREATH_PERIOD,
  breathAt,
  catLayout,
  catPose,
  coatFor,
  COATS,
  createBeam,
  createCatClock,
  createCatLayout,
  createMotes,
  createPose,
  createTrack,
  CUSHION_REST_Y,
  CUSHION_RX,
  CUSHION_RY,
  CUSHION_Y,
  EAR_DURATION,
  EAR_GAP,
  earTwitch,
  moteBrightness,
  SILL_BACK_Y,
  SILL_FRONT_Y,
  stepMotes,
  TAIL_DURATION,
  TAIL_GAP,
  tailFlick,
  timeFor,
  TIMES,
} from "./cat-sim";
import { COAT_OPTIONS, CORNER_OPTIONS, MAX_MOTES, TIME_OPTIONS } from "./cat.meta";

const ASPECTS = [4 / 3, 16 / 9, 21 / 9];

describe("catLayout", () => {
  it("keeps the cushion in its bottom corner, on the sill, at every aspect and size", () => {
    let bad = 0;
    for (const aspect of ASPECTS) {
      for (const { value } of CORNER_OPTIONS) {
        for (const size of [0.25, 0.4, 0.55]) {
          const l = catLayout(aspect, value, size, createCatLayout());
          const left = l.x - CUSHION_RX * size;
          const right = l.x + CUSHION_RX * size;
          const base = l.y + (CUSHION_Y - CUSHION_RY) * size;
          if (left < 0 || right > aspect) bad++;
          if (Math.abs(base - CUSHION_REST_Y) > 1e-9) bad++;
          if (base < SILL_FRONT_Y || base > SILL_BACK_Y) bad++;
          if (value === "left" ? l.x > aspect / 2 : l.x < aspect / 2) bad++;
          // The box covers the cushion, and the cat above it.
          if (l.box[0] > left || l.box[2] < right || l.box[1] > base) bad++;
          if (l.box[3] < Math.min(1, l.y + 0.45 * size)) bad++;
        }
      }
    }
    expect(bad).toBe(0);
  });

  it("mirrors the bottom-right corner", () => {
    const a = catLayout(16 / 9, "left", 0.4, createCatLayout());
    const b = catLayout(16 / 9, "right", 0.4, createCatLayout());
    expect(a.side).toBe(1);
    expect(b.side).toBe(-1);
    expect(b.x).toBeCloseTo(16 / 9 - a.x, 12);
    expect(b.y).toBe(a.y);
    expect(b.box[0]).toBeCloseTo(16 / 9 - a.box[2], 12);
    expect(b.box[2]).toBeCloseTo(16 / 9 - a.box[0], 12);
  });

  it("clamps the size and falls back for bad values", () => {
    expect(catLayout(16 / 9, "left", 5, createCatLayout()).size).toBe(0.55);
    expect(catLayout(16 / 9, "left", 0, createCatLayout()).size).toBe(0.25);
    expect(catLayout(16 / 9, "left", Number.NaN, createCatLayout()).size).toBe(0.4);
    expect(catLayout(16 / 9, "nowhere", 0.4, createCatLayout()).side).toBe(1);
    expect(BOX_LOCAL[0]).toBe(-BOX_LOCAL[2]);
  });
});

describe("breathAt", () => {
  it("is periodic, bounded and continuous", () => {
    let maxStep = 0;
    let periodErr = 0;
    let lo = 1;
    let hi = 0;
    const dt = 0.01;
    for (let t = 0; t < 3 * BREATH_PERIOD; t += dt) {
      const b = breathAt(t);
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
      maxStep = Math.max(maxStep, Math.abs(breathAt(t + dt) - b));
      periodErr = Math.max(periodErr, Math.abs(breathAt(t + BREATH_PERIOD) - b));
    }
    expect(lo).toBeCloseTo(0, 3);
    expect(hi).toBeCloseTo(1, 3);
    expect(periodErr).toBeLessThan(1e-6);
    // A smooth 3-4 s cycle never moves more than a few per cent in 10 ms.
    expect(maxStep).toBeLessThan(0.02);
    expect(BREATH_PERIOD).toBeGreaterThanOrEqual(3);
    expect(BREATH_PERIOD).toBeLessThanOrEqual(4);
  });
});

describe("event tracks", () => {
  it("keeps every gap within its bounds", () => {
    for (const [lo, hi] of [EAR_GAP, TAIL_GAP]) {
      const track = createTrack(5, lo, hi, 3, 9);
      const starts: number[] = [];
      for (let t = 0; t < 3000; t += 0.5) {
        const last = track.last;
        advanceTrack(track, t);
        if (track.last !== last) starts.push(track.last);
      }
      let bad = 0;
      for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap < lo || gap > hi) bad++;
      }
      expect(starts.length).toBeGreaterThan(3000 / hi - 2);
      expect(starts[0]).toBeGreaterThanOrEqual(3);
      expect(starts[0]).toBeLessThanOrEqual(9);
      expect(bad).toBe(0);
    }
  });

  it("is deterministic per seed and catches up after a long jump", () => {
    const a = createTrack(7, 20, 40, 5, 10);
    const b = createTrack(7, 20, 40, 5, 10);
    for (let t = 0; t < 600; t += 0.25) advanceTrack(a, t);
    advanceTrack(b, 599.75);
    expect(b.last).toBe(a.last);
    expect(b.next).toBe(a.next);
    expect(b.variant).toBe(a.variant);
  });
});

describe("poses", () => {
  it("twitches and flicks start and end at rest, continuously", () => {
    let bad = 0;
    let maxEar = 0;
    let maxTail = 0;
    const dt = 0.002;
    for (let tau = -0.5; tau < TAIL_DURATION + 0.5; tau += dt) {
      const e = earTwitch(tau);
      const f = tailFlick(tau);
      if ((tau <= 0 || tau >= EAR_DURATION) && e !== 0) bad++;
      if ((tau <= 0 || tau >= TAIL_DURATION) && f !== 0) bad++;
      if (Math.abs(earTwitch(tau + dt) - e) > 0.025) bad++;
      if (Math.abs(tailFlick(tau + dt) - f) > 0.01) bad++;
      maxEar = Math.max(maxEar, e);
      maxTail = Math.max(maxTail, f);
    }
    expect(bad).toBe(0);
    expect(maxEar).toBeGreaterThan(0.3);
    expect(maxTail).toBeGreaterThan(0.3);
    expect(earTwitch(EAR_DURATION - 1e-6)).toBeLessThan(1e-3);
    expect(tailFlick(TAIL_DURATION - 1e-6)).toBeLessThan(1e-3);
  });

  it("rests between events, with twitches and flicks at most every minimum gap", () => {
    const clock = createCatClock();
    const pose = createPose();
    let earStarts = 0;
    let tailStarts = 0;
    let wasEar = false;
    let wasTail = false;
    let lastEar = -Infinity;
    let lastTail = -Infinity;
    let bad = 0;
    for (let t = 0; t < 1200; t += 1 / 30) {
      catPose(clock, t, pose);
      const ear = pose.earNear !== 0 || pose.earFar !== 0;
      const tail = pose.tail !== 0;
      if (pose.earNear !== 0 && pose.earFar !== 0) bad++;
      if (ear && !wasEar) {
        earStarts++;
        if (t - lastEar < EAR_GAP[0] - 0.1) bad++;
        lastEar = t;
      }
      if (tail && !wasTail) {
        tailStarts++;
        if (t - lastTail < TAIL_GAP[0] - 0.1) bad++;
        lastTail = t;
      }
      wasEar = ear;
      wasTail = tail;
    }
    expect(bad).toBe(0);
    expect(earStarts).toBeGreaterThanOrEqual(1200 / EAR_GAP[1] - 1);
    expect(earStarts).toBeLessThanOrEqual(1200 / EAR_GAP[0] + 1);
    expect(tailStarts).toBeGreaterThanOrEqual(1200 / TAIL_GAP[1] - 1);
    expect(tailStarts).toBeLessThanOrEqual(1200 / TAIL_GAP[0] + 1);
  });
});

describe("motes", () => {
  const layout = catLayout(16 / 9, "left", 0.4, createCatLayout());
  const beam = beamFor(layout, 0.55, createBeam());

  it("aims the beam down and inwards from the window to the sill", () => {
    expect(beam.dy).toBeGreaterThan(0);
    expect(beam.dx).toBeLessThan(0);
    expect(Math.hypot(beam.dx, beam.dy)).toBeCloseTo(1, 12);
    expect(beam.y + beam.length * beam.dy).toBeCloseTo(0.97, 12);
    expect(beamLight(beam, beam.length / 2, 0)).toBeGreaterThan(0.9);
    expect(beamLight(beam, beam.length / 2, 1)).toBe(0);
    const right = beamFor(catLayout(16 / 9, "right", 0.4, createCatLayout()), 0.55, createBeam());
    expect(right.dx).toBeCloseTo(-beam.dx, 12);
  });

  it("drift inside the beam and follow the amount", () => {
    const m = createMotes(MAX_MOTES);
    let bad = 0;
    for (let t = 0; t < 120; t += 0.05) {
      stepMotes(m, beam, t, 0.05);
      for (let i = 0; i < MAX_MOTES; i++) {
        if (!(m.along[i] >= 0 && m.along[i] <= 1)) bad++;
        if (!(m.across[i] >= -1 && m.across[i] <= 1)) bad++;
      }
    }
    expect(bad).toBe(0);
    let lit0 = 0;
    let litHalf = 0;
    let litAll = 0;
    for (let i = 0; i < MAX_MOTES; i++) {
      if (moteBrightness(m, beam, i, 10, 0) > 0) lit0++;
      if (moteBrightness(m, beam, i, 10, 0.5) > 0) litHalf++;
      if (moteBrightness(m, beam, i, 10, 1) > 0) litAll++;
    }
    expect(lit0).toBe(0);
    expect(litHalf).toBeLessThanOrEqual(MAX_MOTES / 2);
    expect(litAll).toBeGreaterThan(litHalf);
  });
});

describe("palettes", () => {
  it("has a look for every option, and falls back for unknown values", () => {
    for (const { value } of COAT_OPTIONS) expect(coatFor(value)).toBe(COATS[value]);
    for (const { value } of TIME_OPTIONS) expect(timeFor(value)).toBe(TIMES[value]);
    expect(coatFor("tiger")).toBe(COATS.ginger);
    expect(timeFor("midnight")).toBe(TIMES.afternoon);
  });
});
