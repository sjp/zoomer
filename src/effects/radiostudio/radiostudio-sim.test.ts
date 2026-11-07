import { describe, expect, it } from "vitest";
import { advanceGraph, createGraphWalk, walkWander } from "../bridge/bridge-graph";
import {
  autoOnAir,
  BREAK_GAP,
  BREAK_LENGTH,
  clockHands,
  createNeedle,
  createTape,
  DESIGN_ASPECT,
  LIGHT_FADE,
  musicLevel,
  MUSIC_SAMPLES,
  onAirTarget,
  packRadius,
  REEL_FULL,
  REEL_HUB,
  SIGN_RIM,
  stepBar,
  stepLight,
  stepNeedle,
  stepTape,
  studioLayout,
  TAPE_MIN,
  TAPE_RUN,
  WINDOW_FRAME,
} from "./radiostudio-sim";

describe("studioLayout", () => {
  const l = studioLayout(DESIGN_ASPECT);
  const half = DESIGN_ASPECT / 2;
  /** A head-and-shoulders crop: the head up to y 0.35 within |x| < 0.2, shoulders below -0.15 within 0.36. */
  const clearOfSpeaker = (x0: number, x1: number, y0: number, y1: number) =>
    x0 > 0.2 || x1 < -0.2 || (y1 < -0.15 && (x0 > 0.36 || x1 < -0.36)) || y0 > 0.36;
  const boxClear = ([cx, cy, hw, hh]: number[]) =>
    clearOfSpeaker(cx - hw, cx + hw, cy - hh, cy + hh);

  it("keeps everything inside the frame", () => {
    const boxes = [
      l.sign,
      l.window,
      l.rack,
      l.records,
      l.platter,
      l.mic,
      ...l.meters,
      ...l.bars,
      ...l.decks,
    ];
    for (const [cx, cy, hw, hh] of boxes) {
      expect(cx - hw).toBeGreaterThanOrEqual(-half);
      expect(cx + hw).toBeLessThanOrEqual(half);
      expect(cy - hh).toBeGreaterThanOrEqual(-0.5);
      expect(cy + hh).toBeLessThanOrEqual(0.5);
    }
  });

  it("keeps the busy things out of the speaker's way", () => {
    for (const b of [l.sign, l.window, l.rack, l.mic, ...l.meters, ...l.decks]) {
      expect(boxClear(b)).toBe(true);
    }
    const [cx, cy, r] = l.clock;
    expect(clearOfSpeaker(cx - r, cx + r, cy - r, cy + r)).toBe(true);
  });

  it("puts the sign high on the far side from the microphone, above the window", () => {
    expect(l.sign[0]).toBeGreaterThan(0);
    expect(l.mic[0]).toBeLessThan(0);
    expect(l.sign[1] - l.sign[3] - SIGN_RIM).toBeGreaterThan(
      l.window[1] + l.window[3] + WINDOW_FRAME,
    );
    expect(l.sign[1] + l.sign[3] + SIGN_RIM).toBeLessThan(0.5);
  });

  it("fits each machine's reels inside its cabinet", () => {
    l.reels.forEach(([x, y, r], i) => {
      const [cx, cy, hw, hh] = l.decks[i >> 1];
      expect(Math.abs(x - cx) + r).toBeLessThan(hw);
      expect(Math.abs(y - cy) + r).toBeLessThan(hh);
    });
  });

  it("squeezes sideways for narrower frames and falls back for bad aspects", () => {
    const narrow = studioLayout(4 / 3);
    expect(narrow.sign[0] + narrow.sign[2]).toBeLessThan(2 / 3);
    expect(studioLayout(Number.NaN).aspect).toBe(DESIGN_ASPECT);
    expect(studioLayout(-1).sign).toEqual(l.sign);
  });
});

describe("the ON AIR light", () => {
  it("is deterministic and on for most of the time in Auto", () => {
    let on = 0;
    let n = 0;
    for (let t = 0; t < 7200; t += 0.25) {
      expect(autoOnAir(t)).toBe(autoOnAir(t));
      on += autoOnAir(t) ? 1 : 0;
      n++;
    }
    expect(on / n).toBeGreaterThan(0.94);
    expect(on / n).toBeLessThan(1);
  });

  it("opens on air, then takes one short break per slot, well apart", () => {
    for (let t = 0; t < BREAK_GAP; t += 0.5) {
      expect(autoOnAir(t)).toBe(true);
    }
    const breaks: [number, number][] = [];
    let was = true;
    for (let t = 0; t < 20 * BREAK_GAP; t += 0.05) {
      const on = autoOnAir(t);
      if (was && !on) {
        breaks.push([t, t]);
      } else if (!was && on) {
        breaks[breaks.length - 1][1] = t;
      }
      was = on;
    }
    expect(breaks.length).toBe(19);
    for (const [a, b] of breaks) {
      expect(b - a).toBeCloseTo(BREAK_LENGTH, 0);
    }
    for (let i = 1; i < breaks.length; i++) {
      expect(breaks[i][0] - breaks[i - 1][1]).toBeGreaterThan(60);
    }
    expect(autoOnAir(Number.NaN)).toBe(true);
  });

  it("follows the setting", () => {
    expect(onAirTarget("on", 1000)).toBe(1);
    expect(onAirTarget("off", 1000)).toBe(0);
    for (const t of [0, 500, 1234.5, 5000]) {
      expect(onAirTarget("auto", t)).toBe(autoOnAir(t) ? 1 : 0);
      expect(onAirTarget("bogus", t)).toBe(onAirTarget("auto", t));
    }
  });

  it("fades over about 300 ms, never jumping", () => {
    let light = 0;
    let steps = 0;
    while (light < 1 && steps < 100) {
      const next = stepLight(light, 1, 1 / 60);
      expect(next - light).toBeLessThanOrEqual(1 / 60 / LIGHT_FADE + 1e-9);
      light = next;
      steps++;
    }
    expect(steps / 60).toBeCloseTo(LIGHT_FADE, 1);
    expect(stepLight(1, 0, 0.1)).toBeCloseTo(1 - 0.1 / LIGHT_FADE);
    expect(stepLight(Number.NaN, 1, Number.NaN)).toBe(0);
  });
});

describe("meters", () => {
  it("keep the envelope in range and silent off air", () => {
    for (const w of [-3, -1, 0, 0.5, 1, 3, Number.NaN]) {
      for (const loud of [0, 0.5, 1, 2, Number.NaN]) {
        const v = musicLevel(w, loud);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(musicLevel(w, 0)).toBe(0);
    }
  });

  it("keep the needles in range on a random-walk envelope, and settle when the light goes off", () => {
    const walk = createGraphWalk(2, 7);
    const needles = [createNeedle(), createNeedle()];
    let t = 0;
    let moved = 0;
    for (let i = 0; i < 60 * 60; i++) {
      t += 1 / 60;
      advanceGraph(walk, t);
      for (const [row, n] of needles.entries()) {
        const before = n.pos;
        stepNeedle(n, musicLevel(walkWander(walk, row, MUSIC_SAMPLES), 1), 1 / 60);
        moved += Math.abs(n.pos - before);
        expect(n.pos).toBeGreaterThanOrEqual(0);
        expect(n.pos).toBeLessThanOrEqual(1);
      }
    }
    // They dance on air…
    expect(moved).toBeGreaterThan(5);
    // …and fall back to rest within a couple of seconds of the light going off.
    let light = 1;
    for (let i = 0; i < 3 * 60; i++) {
      t += 1 / 60;
      advanceGraph(walk, t);
      light = stepLight(light, 0, 1 / 60);
      for (const [row, n] of needles.entries()) {
        stepNeedle(n, musicLevel(walkWander(walk, row, MUSIC_SAMPLES), light), 1 / 60);
        expect(n.pos).toBeGreaterThanOrEqual(0);
        expect(n.pos).toBeLessThanOrEqual(1);
      }
    }
    for (const n of needles) {
      expect(n.pos).toBeLessThan(1e-3);
      expect(Math.abs(n.vel)).toBeLessThan(1e-2);
    }
  });

  it("have inertia: a step overshoots a little, then settles", () => {
    const n = createNeedle();
    let peak = 0;
    for (let i = 0; i < 120; i++) {
      stepNeedle(n, 0.5, 1 / 60);
      peak = Math.max(peak, n.pos);
    }
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThan(0.6);
    expect(n.pos).toBeCloseTo(0.5, 2);
    // One frame isn't enough to get there.
    const m = createNeedle();
    stepNeedle(m, 1, 1 / 60);
    expect(m.pos).toBeLessThan(0.2);
  });

  it("survive bad input and long pauses", () => {
    const n = { pos: Number.NaN, vel: Number.NaN };
    stepNeedle(n, 0.3, 1 / 60);
    expect(n.pos).toBeCloseTo(0.3);
    stepNeedle(n, 2, 1000);
    expect(n.pos).toBe(1);
    stepNeedle(n, Number.NaN, Number.NaN);
    expect(n.pos).toBe(1);
  });

  it("let the LED bars rise fast and fall slowly", () => {
    expect(stepBar(0, 1, 0.1)).toBeGreaterThan(0.8);
    expect(stepBar(1, 0, 0.1)).toBeGreaterThan(0.7);
    expect(stepBar(Number.NaN, 2, 10)).toBeCloseTo(1);
  });
});

describe("tape reels", () => {
  it("fill one reel as the other empties, keeping the tape's area", () => {
    expect(packRadius(0)).toBeCloseTo(REEL_HUB);
    expect(packRadius(1)).toBeCloseTo(REEL_FULL);
    for (const f of [0.1, 0.3, 0.5, 0.8]) {
      const area = packRadius(f) ** 2 + packRadius(1 - f) ** 2;
      expect(area).toBeCloseTo(REEL_HUB ** 2 + REEL_FULL ** 2);
    }
  });

  it("wind slowly, turn clockwise, and reverse at the ends", () => {
    const tape = createTape(0.5);
    stepTape(tape, 1, 1);
    expect(tape.fill).toBeGreaterThan(0.5);
    expect(tape.fill - 0.5).toBeLessThan(0.01);
    // Clockwise: the angles went down (wrapping to just under 2π).
    expect(tape.left).toBeGreaterThan(Math.PI);
    // The emptier reel turns faster.
    expect(2 * Math.PI - tape.left).toBeGreaterThan(2 * Math.PI - tape.right);
    let reversed = false;
    for (let i = 0; i < TAPE_RUN * 4; i++) {
      stepTape(tape, 1, 1);
      expect(tape.fill).toBeGreaterThanOrEqual(TAPE_MIN);
      expect(tape.fill).toBeLessThanOrEqual(1 - TAPE_MIN);
      reversed ||= tape.dir < 0;
    }
    expect(reversed).toBe(true);
  });

  it("stop when off air", () => {
    const tape = createTape(0.3);
    stepTape(tape, 5, 0);
    expect(tape).toEqual(createTape(0.3));
  });
});

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
