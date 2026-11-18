import { describe, expect, it } from "vitest";
import { createAircraft } from "../city/city-sim";
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "../motion-limits";
import {
  APPLAUSE_DOWN,
  APPLAUSE_GAP,
  APPLAUSE_PEAK,
  APPLAUSE_UP,
  applauseGap,
  BAND_LIGHT_FLOATS,
  BAND_LIGHTS,
  bandLightLevel,
  BREATH_PERIOD,
  CITY_SEED,
  CITY_ZOOM,
  createApplause,
  createBandLights,
  DESK_Y,
  deskTopAt,
  fitTitle,
  keyTint,
  SIGN_HALF,
  stepApplause,
  talkLayout,
  TITLE_MARGIN,
  TWINKLE_CYCLES,
  TWINKLE_LOOP,
} from "./talkshow-sim";
import { TITLE_MAX_LENGTH } from "./talkshow.meta";

const DT = 1 / 30;

/** Runs the applause schedule for `seconds`, with `enabled(t)`, returning each frame's level. */
function runApplause(seed: number, seconds: number, enabled: (t: number) => boolean): number[] {
  const s = createApplause(seed);
  const out: number[] = [];
  for (let i = 0; i < seconds / DT; i++) {
    out.push(stepApplause(s, DT, enabled(i * DT)));
  }
  return out;
}

/** The times (s) the sign starts to light from dark. */
const starts = (levels: number[]) =>
  levels.flatMap((l, i) => (l > 0 && (i === 0 || levels[i - 1] === 0) ? [i * DT] : []));

describe("talkLayout", () => {
  it.each([16 / 9, 4 / 3, 21 / 9, 9 / 16, 1])(
    "keeps the props and title in frame at aspect %f",
    (aspect) => {
      const l = talkLayout(aspect);
      expect(l.micX + 0.045).toBeLessThan(l.halfW);
      expect(l.mugX).toBeLessThan(l.micX);
      const [cx, cy, hw, hh] = l.title;
      expect(cx - hw).toBeGreaterThanOrEqual(-l.halfW);
      expect(hw).toBeGreaterThanOrEqual(0.15);
      expect(cy + hh).toBeLessThan(DESK_Y);
      expect(cy - hh).toBeGreaterThan(-l.halfH);
    },
  );

  it("keeps the microphone, mug and title clear of a head-and-shoulders speaker at 16:9", () => {
    const l = talkLayout(16 / 9);
    const shoulders = 0.4;
    expect(l.mugX - 0.03).toBeGreaterThan(shoulders);
    expect(l.title[0] + l.title[2]).toBeLessThan(-shoulders);
    expect(l.band[0] + 0.24).toBeLessThan(-shoulders);
  });

  it("raises the desk towards its right-hand end only", () => {
    expect(deskTopAt(-0.8)).toBe(DESK_Y);
    expect(deskTopAt(0)).toBe(DESK_Y);
    let prev = deskTopAt(-1);
    for (let x = -1; x <= 1.5; x += 0.01) {
      expect(deskTopAt(x)).toBeGreaterThanOrEqual(prev);
      prev = deskTopAt(x);
    }
  });
});

describe("applause schedule", () => {
  it("is deterministic per seed", () => {
    expect(runApplause(7, 300, () => true)).toEqual(runApplause(7, 300, () => true));
    expect(starts(runApplause(7, 300, () => true))).not.toEqual(
      starts(runApplause(8, 300, () => true)),
    );
  });

  it.each([1, 7, CITY_SEED])("draws gaps within their range (seed %i)", (seed) => {
    for (let n = 0; n < 200; n++) {
      const gap = applauseGap(seed, n);
      expect(gap).toBeGreaterThanOrEqual(APPLAUSE_GAP[0]);
      expect(gap).toBeLessThan(APPLAUSE_GAP[1]);
    }
  });

  it.each([
    ["always on", () => true],
    ["toggled every 7 s", (t: number) => Math.floor(t / 7) % 2 === 0],
    ["toggled every 0.5 s", (t: number) => Math.floor(t / 0.5) % 2 === 0],
  ])("never lights more often than its schedule allows (%s)", (_, enabled) => {
    const s = starts(runApplause(3, 1800, enabled));
    expect(s.length).toBeGreaterThan(5);
    for (let i = 1; i < s.length; i++) {
      expect(s[i] - s[i - 1]).toBeGreaterThanOrEqual(APPLAUSE_GAP[0] - 1e-6);
    }
  });

  it("never lights while switched off", () => {
    expect(Math.max(...runApplause(3, 600, () => false))).toBe(0);
  });

  it("ramps up and down smoothly, capping its brightness", () => {
    const levels = runApplause(5, 600, () => true);
    const maxStep = (EASE_PEAK * DT) / Math.min(APPLAUSE_UP, APPLAUSE_DOWN);
    for (let i = 1; i < levels.length; i++) {
      expect(Math.abs(levels[i] - levels[i - 1])).toBeLessThanOrEqual(maxStep + 1e-9);
      expect(levels[i]).toBeLessThanOrEqual(1);
    }
    const first = starts(levels)[0] / DT;
    const cue = levels.slice(first);
    const rise = cue.findIndex((l) => l >= 1);
    expect(rise * DT).toBeGreaterThanOrEqual(APPLAUSE_UP - 2 * DT);
    const fall = cue.findIndex((l, i) => i > rise && l < 1);
    const out = cue.findIndex((l, i) => i > fall && l === 0);
    expect((out - fall) * DT).toBeGreaterThanOrEqual(APPLAUSE_DOWN - 2 * DT);
    // A small sign: its lit face is well under 2% of a 16:9 frame.
    expect((4 * SIGN_HALF[0] * SIGN_HALF[1] * APPLAUSE_PEAK) / (16 / 9)).toBeLessThan(0.02);
  });

  it("dims at once when switched off mid-cue", () => {
    const s = createApplause(5);
    let t = 0;
    let l = 0;
    while (l < 1) {
      l = stepApplause(s, DT, true);
      t += DT;
    }
    const off: number[] = [];
    for (let i = 0; i < 45; i++) {
      off.push(stepApplause(s, DT, false));
    }
    expect(off[off.length - 1]).toBe(0);
    expect(off[0]).toBeGreaterThan(0.9);
    expect(t).toBeLessThan(APPLAUSE_GAP[1]);
  });
});

describe("band lights", () => {
  it("are deterministic per seed and lie in the band's rect", () => {
    const a = createBandLights(4);
    expect(a).toEqual(createBandLights(4));
    expect(a).not.toEqual(createBandLights(5));
    for (let i = 0; i < BAND_LIGHTS; i++) {
      const o = i * BAND_LIGHT_FLOATS;
      expect(a[o]).toBeGreaterThan(0);
      expect(a[o]).toBeLessThan(1);
      expect(a[o + 1]).toBeGreaterThan(0);
      expect(a[o + 1]).toBeLessThan(1);
      expect(a[o + 7]).toBeGreaterThanOrEqual(BREATH_PERIOD[0]);
    }
  });

  it("breathe slowly", () => {
    const a = createBandLights(4);
    for (let i = 0; i < BAND_LIGHTS; i++) {
      for (let t = 0; t < 30; t += DT) {
        const d = Math.abs(bandLightLevel(a, i, t + DT) - bandLightLevel(a, i, t));
        expect(d).toBeLessThan(0.01);
      }
    }
  });
});

describe("backdrop motion", () => {
  it("twinkles the bridge lamps slowly, looping whole cycles", () => {
    expect(Number.isInteger(TWINKLE_CYCLES[0])).toBe(true);
    expect(TWINKLE_CYCLES[1] / TWINKLE_LOOP).toBeLessThanOrEqual(0.5);
  });

  it("moves the light crossing the sky within the codec's limit", () => {
    const plane = createAircraft(CITY_SEED);
    let fastest = 0;
    let crossings = 0;
    let x = Number.NaN;
    for (let i = 0; i < 30 * 600; i++) {
      plane.step(DT, 2000, true);
      if (plane.active && Number.isFinite(x)) {
        fastest = Math.max(fastest, Math.abs(plane.x - x));
      } else if (plane.active) {
        crossings++;
      }
      x = plane.active ? plane.x : Number.NaN;
    }
    expect(crossings).toBeGreaterThan(3);
    // Reference px a frame, as frame heights a second in the backdrop.
    const heightsPerSecond = (fastest / DT) * (CITY_ZOOM / 1080);
    expect(pxPerReferenceFrame(heightsPerSecond)).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
  });
});

describe("keyTint", () => {
  it.each([0, 0.6, 1, Number.NaN])("keeps the key light near white at warmth %f", (w) => {
    const t = keyTint(w, new Float32Array(3));
    for (const c of t) {
      expect(c).toBeGreaterThan(0.7);
      expect(c).toBeLessThan(1.2);
    }
  });

  it("warms as warmth rises", () => {
    const cool = keyTint(0, new Float32Array(3));
    const warm = keyTint(1, new Float32Array(3));
    expect(warm[0] / warm[2]).toBeGreaterThan(cool[0] / cool[2]);
  });
});

describe("fitTitle", () => {
  /** Measures `emPerChar` letter sizes per character, as a wide bold face might. */
  const measure = (emPerChar: number) => (text: string, size: number) =>
    Array.from(text).length * size * emPerChar;

  it.each(Array.from({ length: TITLE_MAX_LENGTH }, (_, i) => i + 1))(
    "fits %i wide letters on the desk front",
    (n) => {
      const w = 420;
      const h = 86;
      const text = "W".repeat(n);
      const size = fitTitle(text, w, h, measure(0.95));
      expect(size).toBeGreaterThanOrEqual(1);
      expect(size).toBeLessThanOrEqual(h);
      expect(measure(0.95)(text, size)).toBeLessThanOrEqual(w - 2 * TITLE_MARGIN * h);
    },
  );

  it("paints nothing for empty text or no room", () => {
    expect(fitTitle("", 400, 80, measure(0.6))).toBe(0);
    expect(fitTitle("A", 0, 80, measure(0.6))).toBe(0);
  });
});
