import { describe, expect, it } from "vitest";
import { MAX_PEAKS } from "./cloudsea.meta";
import {
  BILLOW_CELLS,
  buildBillowTexture,
  buildLedge,
  CENTRE_HI,
  CENTRE_LO,
  createDawnClock,
  createDawnState,
  cycleHour,
  cyclePhaseFor,
  DAWN_HOURS,
  DAWN_KEYS,
  type DawnState,
  fillPeakTable,
  fixedHour,
  layoutPeaks,
  LEDGE_COLUMNS,
  LEDGE_TOP,
  ledgeWidth,
  NO_PEAK,
  PEAK_COLUMNS,
  PEAK_FLOATS,
  peakCount,
  planeDistance,
  sampleDawn,
  sideEnvelope,
  sunDirection,
} from "./cloudsea-sim";

/** Every number in a dawn state, flattened, for comparing two of them. */
const flat = (s: DawnState) => [
  ...s.zenith,
  ...s.mid,
  ...s.horizon,
  ...s.glow,
  ...s.light,
  ...s.shade,
  ...s.haze,
  ...s.rock,
  s.glowStrength,
  s.sunY,
];

const maxDiff = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

describe("sampleDawn", () => {
  it("hits each key exactly at its hour", () => {
    const s = createDawnState();
    for (const k of DAWN_KEYS) {
      sampleDawn(k.hour, s);
      expect(s.zenith).toEqual(k.zenith);
      expect(s.mid).toEqual(k.mid);
      expect(s.shade).toEqual(k.shade);
      expect(s.glowStrength).toBeCloseTo(k.glowStrength);
      expect(s.sunY).toBeCloseTo(k.sunY);
    }
  });

  it("is continuous across the whole dawn", () => {
    const a = createDawnState();
    const b = createDawnState();
    const lo = DAWN_HOURS.predawn;
    const hi = DAWN_HOURS.golden;
    const steps = 4000;
    for (let i = 0; i < steps; i++) {
      sampleDawn(lo + ((hi - lo) * i) / steps, a);
      sampleDawn(lo + ((hi - lo) * (i + 1)) / steps, b);
      expect(maxDiff(flat(a), flat(b))).toBeLessThan(0.005);
    }
  });

  it("clamps hours outside the dawn to its ends", () => {
    const a = createDawnState();
    const b = createDawnState();
    expect(flat(sampleDawn(2, a))).toEqual(flat(sampleDawn(DAWN_HOURS.predawn, b)));
    expect(flat(sampleDawn(12, a))).toEqual(flat(sampleDawn(DAWN_HOURS.golden, b)));
  });

  it("raises the sun through the cloud line from pre-dawn to golden", () => {
    const s = createDawnState();
    expect(sampleDawn(DAWN_HOURS.predawn, s).sunY).toBeLessThan(0);
    expect(sampleDawn(DAWN_HOURS.golden, s).sunY).toBeGreaterThan(0);
    let last = -Infinity;
    for (let h = DAWN_HOURS.predawn; h <= DAWN_HOURS.golden; h += 0.01) {
      const y = sampleDawn(h, s).sunY;
      expect(y).toBeGreaterThanOrEqual(last - 1e-12);
      last = y;
    }
  });
});

describe("cycle", () => {
  it("runs from pre-dawn to golden and back, with no seam at the wrap", () => {
    expect(cycleHour(0)).toBeCloseTo(DAWN_HOURS.predawn);
    expect(cycleHour(0.5)).toBeCloseTo(DAWN_HOURS.golden);
    expect(cycleHour(1 - 1e-9)).toBeCloseTo(cycleHour(0), 6);
    expect(cycleHour(3.25)).toBeCloseTo(cycleHour(0.25));
  });

  it("gives a continuous palette over several loops, including the wrap points", () => {
    const a = createDawnState();
    const b = createDawnState();
    const steps = 6000;
    for (let i = 0; i < steps; i++) {
      const p = -0.5 + (3 * i) / steps;
      sampleDawn(cycleHour(p), a);
      sampleDawn(cycleHour(p + 3 / steps), b);
      expect(maxDiff(flat(a), flat(b))).toBeLessThan(0.005);
    }
  });

  it("inverts on the brightening half", () => {
    for (let p = 0; p <= 0.5; p += 0.05) expect(cyclePhaseFor(cycleHour(p))).toBeCloseTo(p, 6);
    expect(cyclePhaseFor(0)).toBe(0);
    expect(cyclePhaseFor(24)).toBeCloseTo(0.5);
  });
});

describe("createDawnClock", () => {
  it("eases toward a newly picked time of day rather than jumping", () => {
    const clock = createDawnClock();
    expect(clock.hour).toBe(DAWN_HOURS.sunrise);
    const first = clock.step(1 / 60, "golden", 8);
    expect(first).toBeGreaterThan(DAWN_HOURS.sunrise);
    expect(first - DAWN_HOURS.sunrise).toBeLessThan(0.01);
    for (let i = 0; i < 600; i++) clock.step(1 / 60, "golden", 8);
    expect(clock.hour).toBe(DAWN_HOURS.golden);
  });

  it("enters the cycle from the current hour and loops in the given time", () => {
    const clock = createDawnClock();
    const h0 = clock.hour;
    const h1 = clock.step(1 / 60, "cycle", 2);
    expect(Math.abs(h1 - h0)).toBeLessThan(0.01);
    // Back to the same hour one full loop (two minutes) later.
    for (let i = 0; i < 120 * 60; i++) clock.step(1 / 60, "cycle", 2);
    expect(clock.hour).toBeCloseTo(h1, 3);
  });

  it("falls back to sunrise for unknown values", () => {
    expect(fixedHour("noon")).toBe(DAWN_HOURS.sunrise);
    expect(fixedHour("toString")).toBe(DAWN_HOURS.sunrise);
    expect(fixedHour("predawn")).toBe(DAWN_HOURS.predawn);
  });
});

describe("camera", () => {
  it("puts the plane farther away toward the cloud line", () => {
    expect(planeDistance(0.5, 0.45)).toBe(Infinity);
    expect(planeDistance(0.45, 0.45)).toBe(Infinity);
    expect(planeDistance(0, 0.45)).toBeLessThan(planeDistance(0.3, 0.45));
  });

  it("gives a unit light direction toward the right, always a little above the clouds", () => {
    const out: [number, number, number] = [0, 0, 0];
    for (const y of [-0.1, 0, 0.1]) {
      sunDirection(16 / 9, y, out);
      expect(Math.hypot(...out)).toBeCloseTo(1);
      expect(out[0]).toBeGreaterThan(0);
      expect(out[1]).toBeGreaterThan(0);
    }
  });
});

describe("buildBillowTexture", () => {
  const size = 128;
  const { data, slopeScale } = buildBillowTexture(size, 5);
  const decode = (x: number, y: number, c: number) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4 + c;
    return (data[i] / 255) * 2 - 1;
  };

  it("is deterministic and uses the byte range", () => {
    expect(buildBillowTexture(size, 5).data).toEqual(data);
    expect(buildBillowTexture(size, 6).data).not.toEqual(data);
    const heights = data.filter((_, i) => i % 4 === 0);
    expect(Math.max(...heights) === 255 || Math.min(...heights) === 0).toBe(true);
    expect(slopeScale).toBeGreaterThan(0);
  });

  it("tiles seamlessly", () => {
    let wrapGap = 0;
    let typical = 0;
    for (let y = 0; y < size; y++) {
      wrapGap = Math.max(wrapGap, Math.abs(decode(size - 1, y, 0) - decode(0, y, 0)));
      typical = Math.max(typical, Math.abs(decode(1, y, 0) - decode(0, y, 0)));
    }
    expect(wrapGap).toBeLessThanOrEqual(typical + 0.02);
  });

  it("stores the gradient of the stored height", () => {
    // Central differences of the decoded height, per tile unit, against the decoded gradient.
    let err = 0;
    let mag = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const du = ((decode(x + 1, y, 0) - decode(x - 1, y, 0)) / 2) * size;
        const dv = ((decode(x, y + 1, 0) - decode(x, y - 1, 0)) / 2) * size;
        err += Math.abs(du - decode(x, y, 1) * slopeScale);
        err += Math.abs(dv - decode(x, y, 2) * slopeScale);
        mag += Math.abs(du) + Math.abs(dv);
      }
    }
    // Finite differences over a texel blur the finest octave, so only roughly.
    expect(err / mag).toBeLessThan(0.35);
    expect(BILLOW_CELLS).toBeGreaterThan(0);
  });
});

describe("peaks", () => {
  const table = new Float32Array(PEAK_COLUMNS * PEAK_FLOATS);
  const column = (x: number) => Math.min(PEAK_COLUMNS - 1, Math.floor(x * PEAK_COLUMNS));
  const none = Math.fround(NO_PEAK);

  it("clamps the count", () => {
    expect(peakCount(-1)).toBe(0);
    expect(peakCount(2.4)).toBe(2);
    expect(peakCount(99)).toBe(MAX_PEAKS);
    expect(peakCount(Number.NaN)).toBe(0);
  });

  it("lays out the asked number of peaks, deterministically, out of the centre third", () => {
    for (let seed = 0; seed < 40; seed++) {
      for (let n = 0; n <= MAX_PEAKS; n++) {
        const peaks = layoutPeaks(n, seed);
        expect(peaks).toHaveLength(n);
        expect(layoutPeaks(n, seed)).toEqual(peaks);
        for (const p of peaks) {
          expect(p.x < CENTRE_LO || p.x > CENTRE_HI).toBe(true);
          expect(p.height).toBeGreaterThan(0);
          expect(p.height).toBeLessThan(0.25);
        }
      }
    }
  });

  it("alternates sides and puts the tallest first", () => {
    for (let seed = 0; seed < 40; seed++) {
      const peaks = layoutPeaks(MAX_PEAKS, seed);
      for (let i = 1; i < peaks.length; i++) {
        expect(peaks[i].x < 0.5).not.toBe(peaks[i - 1].x < 0.5);
        expect(peaks[0].height).toBeGreaterThan(peaks[i].height);
      }
    }
  });

  it("keeps the skyline under the cloud line across the centre third at any aspect", () => {
    for (const aspect of [4 / 3, 16 / 10, 16 / 9, 21 / 9, 32 / 9]) {
      for (let seed = 0; seed < 20; seed++) {
        fillPeakTable(table, layoutPeaks(MAX_PEAKS, seed), aspect);
        // Every column whose centre lies in the centre third.
        const first = Math.ceil(CENTRE_LO * PEAK_COLUMNS - 0.5);
        const last = Math.floor(CENTRE_HI * PEAK_COLUMNS - 0.5);
        for (let c = first; c <= last; c++) {
          expect(table[c * PEAK_FLOATS]).toBe(none);
        }
      }
    }
  });

  it("rises above the cloud line at each crest and is empty with no peaks", () => {
    const peaks = layoutPeaks(3, 9);
    fillPeakTable(table, peaks, 16 / 9);
    for (const p of peaks) {
      expect(table[column(p.x) * PEAK_FLOATS]).toBeGreaterThan(p.height * 0.5);
      expect(Math.abs(table[column(p.x) * PEAK_FLOATS + 1])).toBeLessThan(0.01);
    }
    fillPeakTable(table, [], 16 / 9);
    for (let c = 0; c < PEAK_COLUMNS; c++) expect(table[c * PEAK_FLOATS]).toBe(none);
  });

  it("fades the side bands out before the centre third", () => {
    expect(sideEnvelope(0.1)).toBe(1);
    expect(sideEnvelope(0.9)).toBe(1);
    expect(sideEnvelope(CENTRE_LO)).toBe(0);
    expect(sideEnvelope(0.5)).toBe(0);
    expect(sideEnvelope(CENTRE_HI)).toBe(0);
  });
});

describe("buildLedge", () => {
  it("rises from the corner and falls to nothing at its tip", () => {
    const out = buildLedge(new Float32Array(LEDGE_COLUMNS), 4);
    expect(out[0]).toBeGreaterThan(LEDGE_TOP * 0.7);
    expect(out[LEDGE_COLUMNS - 1]).toBe(0);
    for (const h of out) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(LEDGE_TOP * 1.4);
    }
    expect(buildLedge(new Float32Array(LEDGE_COLUMNS), 4)).toEqual(out);
  });

  it("stays out of the centre third", () => {
    for (const aspect of [1, 4 / 3, 16 / 9, 21 / 9]) {
      expect(ledgeWidth(aspect) / aspect).toBeLessThanOrEqual(CENTRE_LO);
    }
  });
});
