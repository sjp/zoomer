import { describe, expect, it } from "vitest";
import { MAX_FEATURE_PX_PER_FRAME, MAX_PATTERN_HZ } from "../motion-limits";
import {
  BEAM_APEX,
  beamAt,
  BEAM_LENGTH,
  BEAM_DIR,
  cinemaFit,
  createShow,
  CURTAIN_FOLDS,
  CURTAIN_OUTER,
  CURTAIN_SECONDS,
  curtainFolds,
  curtainLead,
  DIM_SECONDS,
  MAX_MOTES,
  moteCount,
  MOTE_FLOATS,
  SHOW_SECONDS,
  stepShow,
  toFilm,
  toView,
  writeMote,
} from "./cinema-sim";

const DT = 1 / 60;

describe("the show's transition", () => {
  it.each([true, false])("starts settled (playing: %s)", (playing) => {
    const s = createShow();
    stepShow(s, DT, playing);
    expect(s.house).toBe(playing ? 0 : 1);
    expect(s.beam).toBe(playing ? 1 : 0);
    expect(s.curtains).toBe(playing ? 1 : 0);
  });

  it("dims the house over 3 s, then fades the beam up and parts the curtains", () => {
    const s = createShow();
    stepShow(s, DT, false);
    let last = { house: s.house, beam: s.beam, curtains: s.curtains };
    let earlyLight = 0;
    for (let t = 0; t < SHOW_SECONDS + 1; t += DT) {
      stepShow(s, DT, true);
      expect(s.house).toBeLessThanOrEqual(last.house);
      expect(s.beam).toBeGreaterThanOrEqual(last.beam);
      expect(s.curtains).toBeGreaterThanOrEqual(last.curtains);
      // Nothing starts before the house is dark.
      earlyLight = Math.max(earlyLight, s.t < DIM_SECONDS ? s.beam + s.curtains : 0);
      last = { house: s.house, beam: s.beam, curtains: s.curtains };
    }
    expect(earlyLight).toBe(0);
    expect(last).toEqual({ house: 0, beam: 1, curtains: 1 });
    expect(CURTAIN_SECONDS).toBeGreaterThanOrEqual(6);
    expect(CURTAIN_SECONDS).toBeLessThanOrEqual(8);
  });

  it.each([1, 2.5, 4, 6.5, 9])("reverses smoothly from %s s in", (at) => {
    const s = createShow();
    stepShow(s, DT, false);
    for (let t = 0; t < at; t += DT) {
      stepShow(s, DT, true);
    }
    const mid = { house: s.house, beam: s.beam, curtains: s.curtains };
    stepShow(s, DT, false);
    // One frame back: barely moved, and back the way it came.
    expect(Math.abs(s.house - mid.house)).toBeLessThan(0.01);
    expect(s.house).toBeGreaterThanOrEqual(mid.house);
    expect(s.beam).toBeLessThanOrEqual(mid.beam);
    expect(s.curtains).toBeLessThanOrEqual(mid.curtains);
    let last = { house: s.house, beam: s.beam, curtains: s.curtains };
    for (let t = 0; t < SHOW_SECONDS + 1; t += DT) {
      stepShow(s, DT, false);
      expect(s.house).toBeGreaterThanOrEqual(last.house);
      expect(s.beam).toBeLessThanOrEqual(last.beam);
      expect(s.curtains).toBeLessThanOrEqual(last.curtains);
      // No level jumps: the steepest smoothstep over the shortest stage.
      expect(Math.abs(s.house - last.house)).toBeLessThanOrEqual((1.5 * DT) / DIM_SECONDS + 1e-9);
      last = { house: s.house, beam: s.beam, curtains: s.curtains };
    }
    expect(last).toEqual({ house: 1, beam: 0, curtains: 0 });
  });

  it("ignores bad time steps", () => {
    const s = createShow();
    stepShow(s, DT, true);
    stepShow(s, Number.NaN, false);
    stepShow(s, -1, false);
    expect(s.t).toBe(SHOW_SECONDS);
  });
});

describe("the beam", () => {
  it("is brightest near the lens and dark behind it", () => {
    const near = beamAt(BEAM_APEX[0] + BEAM_DIR[0] * 0.1, BEAM_APEX[1] + BEAM_DIR[1] * 0.1);
    const far = beamAt(BEAM_APEX[0] + BEAM_DIR[0] * 0.6, BEAM_APEX[1] + BEAM_DIR[1] * 0.6);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0.2);
    expect(beamAt(BEAM_APEX[0] - BEAM_DIR[0] * 0.1, BEAM_APEX[1] - BEAM_DIR[1] * 0.1)).toBe(0);
  });

  it("stays out of the lower half of the middle third at 16:9", () => {
    const halfW = 16 / 9 / 2;
    for (let x = -halfW / 3; x <= halfW / 3; x += 0.005) {
      for (let y = -0.5; y <= 0; y += 0.005) {
        expect(beamAt(x, y)).toBe(0);
      }
    }
  });

  it("passes above a typical head", () => {
    // A head-and-shoulders crop's head at 16:9: an ellipse about the middle.
    let most = 0;
    for (let a = 0; a < 2 * Math.PI; a += 0.02) {
      for (let k = 0; k <= 1; k += 0.1) {
        most = Math.max(most, beamAt(0.14 * k * Math.cos(a), 0.09 + 0.18 * k * Math.sin(a)));
      }
    }
    expect(most).toBeLessThan(0.05);
  });

  it("leaves the frame before its far end at every aspect", () => {
    for (const aspect of [9 / 16, 4 / 3, 16 / 9, 21 / 9]) {
      const fit = cinemaFit(aspect);
      const halfW = aspect / (2 * fit);
      const halfH = 0.5 / fit;
      const x = BEAM_APEX[0] + BEAM_DIR[0] * BEAM_LENGTH * 0.85;
      const y = BEAM_APEX[1] + BEAM_DIR[1] * BEAM_LENGTH * 0.85;
      expect(Math.abs(x) > halfW || Math.abs(y) > halfH).toBe(true);
    }
  });
});

describe("the dust motes", () => {
  it("asks for more motes with more dust, up to the cap", () => {
    expect(moteCount(0)).toBe(0);
    expect(moteCount(0.5)).toBe(MAX_MOTES / 2);
    expect(moteCount(1)).toBe(MAX_MOTES);
    expect(moteCount(7)).toBe(MAX_MOTES);
    expect(moteCount(Number.NaN)).toBe(0);
  });

  it("shine only inside the beam, never brighter than it", () => {
    const out = new Float32Array(MOTE_FLOATS);
    let lit = 0;
    for (let i = 0; i < MAX_MOTES; i++) {
      for (let t = 0; t < 300; t += 7.3) {
        writeMote(i, t, out, 0);
        expect(out[3]).toBeGreaterThanOrEqual(0);
        expect(out[3]).toBeLessThanOrEqual(beamAt(out[0], out[1]) + 1e-6);
        if (out[3] > 0.05) {
          lit++;
        }
      }
    }
    expect(lit).toBeGreaterThan(MAX_MOTES);
  });

  it.each([0, 37, 159])("mote %i drifts slowly, and wraps only where it's dark", (i) => {
    const a = new Float32Array(MOTE_FLOATS);
    const b = new Float32Array(MOTE_FLOATS);
    const frame = 1 / 30;
    let fastest = 0;
    let wraps = 0;
    let brightestWrap = 0;
    for (let t = 0; t < 400; t += frame) {
      writeMote(i, t, a, 0);
      writeMote(i, t + frame, b, 0);
      const px = Math.hypot(b[0] - a[0], b[1] - a[1]) * 1080;
      // More than a pixel a frame is a wrap back to the lens; it must happen in the dark.
      const wrapped = px > 1;
      wraps += wrapped ? 1 : 0;
      brightestWrap = Math.max(brightestWrap, wrapped ? Math.max(a[3], b[3]) : 0);
      fastest = Math.max(fastest, wrapped ? 0 : px);
    }
    expect(fastest).toBeLessThan(MAX_FEATURE_PX_PER_FRAME);
    expect(brightestWrap).toBeLessThan(0.01);
    expect(wraps).toBeLessThan(10);
  });
});

describe("params", () => {
  it("fall back to the defaults for unknown values", () => {
    expect(toFilm("western")).toBe("western");
    expect(toFilm("nope")).toBe("drama");
    expect(toView("screen")).toBe("screen");
    expect(toView("nope")).toBe("projector");
  });
});

describe("the curtains", () => {
  it("overlap when closed and tuck behind the drapes when open", () => {
    expect(curtainLead(0)).toBeLessThan(0);
    expect(curtainLead(1)).toBeGreaterThan(CURTAIN_OUTER);
    expect(curtainFolds(curtainLead(0.3), 0.3)).toBe(0);
    expect(curtainFolds(CURTAIN_OUTER, 0)).toBeCloseTo(CURTAIN_FOLDS, 9);
  });

  it("never sweep their folds across a point faster than the codec limit", () => {
    // Run the show from before to playing, and watch the folds pass fixed points.
    const s = createShow();
    stepShow(s, DT, false);
    let last = s.curtains;
    let fastest = 0;
    for (let t = 0; t < SHOW_SECONDS + 1; t += DT) {
      stepShow(s, DT, true);
      for (let ax = 0; ax < CURTAIN_OUTER; ax += 0.01) {
        // Only where the curtain is: past its leading edge at both ends of the step.
        const shown = ax > curtainLead(Math.max(last, s.curtains));
        const hz = Math.abs(curtainFolds(ax, s.curtains) - curtainFolds(ax, last)) / DT;
        fastest = Math.max(fastest, shown ? hz : 0);
      }
      last = s.curtains;
    }
    expect(fastest).toBeGreaterThan(1);
    expect(fastest).toBeLessThan(MAX_PATTERN_HZ);
  });
});
