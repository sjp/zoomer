import { describe, expect, it } from "vitest";
import type { Rgb } from "../color";
import { glyphIndex } from "../dot-matrix";
import { SCROLLER_MAX_LENGTH } from "./bedroom80s.meta";
import {
  BEDSIDE_FADE,
  BULB,
  CASSETTES,
  CELL,
  COMFORT_RATE,
  createReels,
  cursorLevel,
  DECK,
  DEMO_W,
  DESIGN_ASPECT,
  FIRST_SWEEP,
  fitScale,
  HEADLIGHT_PEAK,
  headlightAt,
  KEYBOARD,
  LAMP_GLASS,
  luma,
  MAX_CODES,
  MAX_REPEAT_HZ,
  MIN_RAMP,
  MODE_FADE,
  MONITOR,
  POSTER_CAR,
  POSTER_SPACE,
  POSTER_SUNSET,
  RADIO,
  REEL_SPEED,
  screenGlow,
  SCROLL_GAP,
  scrollerCodes,
  scrollerGlyph,
  scrollerPeriod,
  scrollOffset,
  slewColor,
  STRIPE_EDGE,
  STRIPE_PALETTE,
  STRIPE_SPEED,
  stepFade,
  stepModes,
  stepReels,
  stripeColor,
  stripePhase,
  SWEEP_SLOT,
  SWEEP_TIME,
  sweepAt,
  sweepStart,
  WINDOW,
  type Box,
} from "./bedroom80s-sim";

const codesFor = (text: string) => {
  const codes = new Uint8Array(MAX_CODES);
  const len = scrollerCodes(text, codes);
  return { codes, len };
};

/** The glyphs across the demo's width, one per letter cell, at `offset`. */
const visible = (codes: Uint8Array, len: number, offset: number, shift = 0) => {
  const out: number[] = [];
  for (let x = CELL / 2; x < DEMO_W; x += CELL) {
    out.push(scrollerGlyph(codes, len, x + shift, offset));
  }
  return out;
};

describe("scroller", () => {
  it("spells the message in capitals, then a gap, showing missing glyphs as spaces", () => {
    const { codes, len } = codesFor("Hi! 80s");
    expect(len).toBe(7 + SCROLL_GAP);
    expect(Array.from(codes.subarray(0, 7))).toEqual([
      glyphIndex("H"),
      glyphIndex("I"),
      0,
      0,
      glyphIndex("8"),
      glyphIndex("0"),
      glyphIndex("S"),
    ]);
    expect(Array.from(codes.subarray(7, len)).every((c) => c === 0)).toBe(true);
  });

  it("truncates long messages and treats an empty one as all gap", () => {
    expect(codesFor("A".repeat(200)).len).toBe(SCROLLER_MAX_LENGTH + SCROLL_GAP);
    expect(codesFor("").len).toBe(SCROLL_GAP);
    expect(codesFor("   ").len).toBe(SCROLL_GAP);
  });

  it("wraps continuously: no seam or jump where the offset comes round", () => {
    const { codes, len } = codesFor("GREETINGS TO ALL");
    const period = scrollerPeriod(len);
    // Just before and just after the wrap, the picture has moved by exactly the step.
    for (const step of [1, 3, CELL / 2]) {
      for (const d of [period - step, 3 * period - step / 2]) {
        const before = scrollOffset(d, len);
        const after = scrollOffset(d + step, len);
        expect(after).toBeLessThan(before);
        expect(visible(codes, len, after)).toEqual(visible(codes, len, before, step));
      }
    }
    // A whole period later the picture is the same.
    for (let d = 0; d < period; d += 7.3) {
      expect(visible(codes, len, scrollOffset(d + 5 * period, len))).toEqual(
        visible(codes, len, scrollOffset(d, len)),
      );
    }
  });

  it("brings the message's start round straight after the gap", () => {
    const { codes, len } = codesFor("AB");
    const seq: number[] = [];
    for (let i = 0; i < 2 * len; i++) {
      seq.push(scrollerGlyph(codes, len, (i + 0.5) * CELL, 0));
    }
    const once = [glyphIndex("A"), glyphIndex("B"), ...Array.from({ length: SCROLL_GAP }, () => 0)];
    expect(seq).toEqual([...once, ...once]);
  });

  it("keeps the offset in range for any distance", () => {
    const { len } = codesFor("HELLO");
    for (const d of [0, 1e9 + 0.5, -40, Number.NaN, Infinity]) {
      const o = scrollOffset(d, len);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(scrollerPeriod(len));
    }
  });
});

/** The worst rate of change (per second) of `f(t)` over [t0, t1], by finite differences. */
function worstRate(f: (t: number) => number, t0: number, t1: number, dt = 1 / 120): number {
  let worst = 0;
  let prev = f(t0);
  for (let t = t0 + dt; t <= t1; t += dt) {
    const v = f(t);
    worst = Math.max(worst, Math.abs(v - prev) / dt);
    prev = v;
  }
  return worst;
}

describe("loading stripes never strobe", () => {
  const c: Rgb = [0, 0, 0];
  const at = (v: number, t: number) => stripeColor(v, stripePhase(t), c);

  it("changes no faster than the comfort limit, in luminance or any colour channel", () => {
    let worstLuma = 0;
    let worstChannel = 0;
    for (let v = 0; v <= 1; v += 1 / 25) {
      worstLuma = Math.max(
        worstLuma,
        worstRate((t) => luma(at(v, t)), 0, 40),
      );
      for (let k = 0; k < 3; k++) {
        worstChannel = Math.max(
          worstChannel,
          worstRate((t) => at(v, t)[k], 0, 40),
        );
      }
    }
    expect(worstLuma).toBeLessThanOrEqual(COMFORT_RATE * 0.25);
    expect(worstChannel).toBeLessThanOrEqual(COMFORT_RATE);
  });

  it("is low-contrast: every stripe has nearly the same luminance", () => {
    const l = STRIPE_PALETTE.map((rgb) => luma(rgb));
    expect(Math.max(...l) - Math.min(...l)).toBeLessThan(0.06);
  });

  it("changes colour at any point slowly: each change ramps over at least MIN_RAMP, well under MAX_REPEAT_HZ", () => {
    expect(STRIPE_SPEED).toBeLessThanOrEqual(MAX_REPEAT_HZ);
    expect(STRIPE_EDGE / STRIPE_SPEED).toBeGreaterThanOrEqual(MIN_RAMP);
    // Measured: at a fixed point, time each run of changing colour and each steady spell.
    const dt = 1 / 120;
    for (const v of [0, 0.37, 0.81]) {
      let changing = false;
      let since = 0;
      let changes = 0;
      let prev = luma(at(v, 0)) + at(v, 0)[0];
      const ramps: number[] = [];
      for (let t = dt; t <= 60; t += dt) {
        const cur = luma(at(v, t)) + at(v, t)[0];
        const moving = Math.abs(cur - prev) > 1e-9;
        if (moving !== changing) {
          if (changing) {
            ramps.push(t - since);
            changes++;
          }
          changing = moving;
          since = t;
        }
        prev = cur;
      }
      expect(ramps.length).toBeGreaterThan(5);
      // Ignore a ramp cut short by the start of the run.
      for (const r of ramps.slice(1)) {
        expect(r).toBeGreaterThanOrEqual(MIN_RAMP);
      }
      expect(changes / 60).toBeLessThanOrEqual(MAX_REPEAT_HZ);
    }
  });

  it("wraps its phase without a jump", () => {
    for (const t of [0, 15.99, 16, 16.01, 1e7]) {
      const a = stripeColor(0.4, stripePhase(t), [0, 0, 0]);
      const b = stripeColor(0.4, stripePhase(t) + 4, [0, 0, 0]);
      for (let k = 0; k < 3; k++) {
        expect(a[k]).toBeCloseTo(b[k], 9);
      }
    }
    const before = stripeColor(0.2, stripePhase(16 - 1e-6), [0, 0, 0]);
    const after = stripeColor(0.2, stripePhase(16 + 1e-6), [0, 0, 0]);
    for (let k = 0; k < 3; k++) {
      expect(after[k]).toBeCloseTo(before[k], 4);
    }
  });
});

describe("cursor and screen glow", () => {
  it("pulses the cursor gently instead of blinking", () => {
    expect(worstRate(cursorLevel, 0, 12)).toBeLessThanOrEqual(COMFORT_RATE);
    let lo = 1;
    let hi = 0;
    for (let t = 0; t < 6; t += 0.01) {
      lo = Math.min(lo, cursorLevel(t));
      hi = Math.max(hi, cursorLevel(t));
    }
    expect(lo).toBeGreaterThan(0.5);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("crossfades between modes over MODE_FADE, snapping on the first frame", () => {
    const w = new Float64Array(3).fill(Number.NaN);
    stepModes(w, "stripes", 1 / 60);
    expect(Array.from(w)).toEqual([0, 1, 0]);
    stepModes(w, "prompt", MODE_FADE / 2);
    expect(w[1]).toBeCloseTo(0.5, 9);
    expect(w[2]).toBeCloseTo(0.5, 9);
    stepModes(w, "prompt", MODE_FADE);
    expect(Array.from(w)).toEqual([0, 0, 1]);
    stepModes(w, "nonsense", 10);
    expect(Array.from(w)).toEqual([1, 0, 0]);
  });

  it("casts a glow that changes slowly through a mode change and the stripes' drift", () => {
    const w = new Float64Array(3).fill(Number.NaN);
    const target: Rgb = [0, 0, 0];
    const shown: Rgb = [Number.NaN, 0, 0];
    const dt = 1 / 60;
    let worst = 0;
    let prev = 0;
    for (let i = 0; i < 60 * 30; i++) {
      const t = i * dt;
      const mode = t < 8 ? "demo" : t < 20 ? "stripes" : "prompt";
      stepModes(w, mode, dt);
      screenGlow(w, stripePhase(t), target);
      slewColor(shown, target, COMFORT_RATE, dt);
      const l = luma(shown);
      if (i > 0) {
        worst = Math.max(worst, Math.abs(l - prev) / dt);
      }
      prev = l;
    }
    expect(worst).toBeLessThanOrEqual(COMFORT_RATE + 1e-9);
  });
});

describe("headlights", () => {
  it("come every minute or two, the first soon after the start", () => {
    expect(sweepStart(0)).toBe(FIRST_SWEEP);
    let prev = sweepStart(0);
    for (let s = 1; s < 200; s++) {
      const start = sweepStart(s);
      expect(start - prev).toBeGreaterThanOrEqual(30);
      expect(start - prev).toBeLessThanOrEqual(150);
      expect(start + SWEEP_TIME).toBeLessThan((s + 1) * SWEEP_SLOT);
      prev = start;
    }
    expect(sweepAt(FIRST_SWEEP - 1)).toBe(-1);
    expect(sweepAt(FIRST_SWEEP + 2)).toBeCloseTo(2, 9);
    expect(sweepAt(-5)).toBe(-1);
    expect(sweepAt(Number.NaN)).toBe(-1);
  });

  it("never strobe: no point on the ceiling brightens faster than its peak over MIN_RAMP", () => {
    let worst = 0;
    let peak = 0;
    for (let x = -1.2; x <= 1; x += 0.02) {
      worst = Math.max(
        worst,
        worstRate((t) => headlightAt(x, sweepAt(t)), FIRST_SWEEP - 1, FIRST_SWEEP + SWEEP_TIME + 1),
      );
      for (let s = 0; s <= SWEEP_TIME; s += 0.05) {
        peak = Math.max(peak, headlightAt(x, s));
      }
    }
    expect(peak).toBeLessThanOrEqual(HEADLIGHT_PEAK);
    expect(peak).toBeGreaterThan(HEADLIGHT_PEAK * 0.5);
    expect(worst).toBeLessThanOrEqual(HEADLIGHT_PEAK / MIN_RAMP);
  });

  it("drift from the window side across to the far side", () => {
    const at = (s: number) => {
      let best = -9;
      let bx = 0;
      for (let x = -1.2; x <= 1; x += 0.01) {
        const v = headlightAt(x, s);
        if (v > best) {
          best = v;
          bx = x;
        }
      }
      return bx;
    };
    expect(at(SWEEP_TIME * 0.25)).toBeGreaterThan(at(SWEEP_TIME * 0.5));
    expect(at(SWEEP_TIME * 0.5)).toBeGreaterThan(at(SWEEP_TIME * 0.75));
    expect(headlightAt(0, -1)).toBe(0);
  });
});

describe("fades and reels", () => {
  it("brings the bedside lamp up over BEDSIDE_FADE, never in a jump", () => {
    let l = stepFade(Number.NaN, false, 0, BEDSIDE_FADE);
    expect(l).toBe(0);
    const dt = 1 / 60;
    let t = 0;
    while (l < 1) {
      const next = stepFade(l, true, dt, BEDSIDE_FADE);
      expect(next - l).toBeLessThanOrEqual(dt / MIN_RAMP + 1e-12);
      l = next;
      t += dt;
    }
    expect(t).toBeGreaterThanOrEqual(BEDSIDE_FADE - 1e-9);
  });

  it("turns the reels clockwise while playing and eases them to a stop", () => {
    const r = createReels();
    stepReels(r, true, 0.5);
    expect(r.speed).toBe(1);
    expect(r.angle).toBeCloseTo(2 * Math.PI - REEL_SPEED * 0.5, 9);
    stepReels(r, false, 0.3);
    expect(r.speed).toBeCloseTo(0.5, 9);
    stepReels(r, false, 5);
    const a = r.angle;
    stepReels(r, false, 5);
    expect(r.angle).toBe(a);
    expect(r.angle).toBeGreaterThanOrEqual(0);
    expect(r.angle).toBeLessThan(2 * Math.PI);
  });
});

describe("layout", () => {
  const inFrame = (b: Box) =>
    Math.abs(b[0]) + b[2] <= DESIGN_ASPECT / 2 && Math.abs(b[1]) + b[3] <= 0.5;
  /** The speaker's head and shoulders, roughly: nothing busy goes behind them. */
  const behindSpeaker = (b: Box) => {
    const x0 = b[0] - b[2];
    const x1 = b[0] + b[2];
    const y1 = b[1] + b[3];
    const headClear = x1 < -0.2 || x0 > 0.2;
    const shoulderClear = x1 < -0.32 || x0 > 0.32 || b[1] - b[3] > -0.12;
    return !(headClear && shoulderClear) && y1 > -0.5;
  };

  it("keeps the scene's parts in frame at 16:9, clear of the speaker's head and shoulders", () => {
    const parts = [
      MONITOR,
      KEYBOARD,
      DECK,
      CASSETTES,
      POSTER_SUNSET,
      POSTER_SPACE,
      POSTER_CAR,
      RADIO,
      LAMP_GLASS,
      WINDOW,
    ];
    for (const p of parts) {
      expect(inFrame(p)).toBe(true);
      expect(behindSpeaker(p)).toBe(false);
    }
    expect(Math.abs(BULB[0])).toBeGreaterThan(0.6);
  });

  it("shrinks the room to fit narrower frames, never enlarging it", () => {
    expect(fitScale(DESIGN_ASPECT)).toBe(1);
    expect(fitScale(21 / 9)).toBe(1);
    expect(fitScale(4 / 3)).toBeCloseTo(0.75, 9);
    expect(fitScale(Number.NaN)).toBe(1);
  });
});
