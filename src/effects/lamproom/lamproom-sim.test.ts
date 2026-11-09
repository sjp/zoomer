import { describe, expect, it } from "vitest";
import { MAX_PERIOD, MIN_PERIOD } from "./lamproom.meta";
import {
  advanceLens,
  BAND_SIZE,
  BEAM_PEAK,
  beamLevel,
  buildBandTable,
  CAM_Z,
  cameraX,
  clampPeriod,
  cloudDensity,
  createWeatherLook,
  easeWeather,
  FACE_HALF,
  facing,
  LAMP_Y,
  LENS_AT,
  LENS_R,
  LENS_Y0,
  LENS_Y1,
  lensBox,
  lensProfile,
  lensRadius,
  moonX,
  project,
  riseSeconds,
  sampleTiled,
  towardCamera,
  WALK_R,
  WEATHER,
  WEATHER_EASE,
  wrapAngle,
} from "./lamproom-sim";

const DT = 1 / 60;

/** The beam's brightness every frame for `seconds`, from a lens angle of `start`. */
function trace(period: number, beam: number, seconds: number, start = 0.3): number[] {
  const out: number[] = [];
  let angle = start;
  for (let t = 0; t < seconds; t += DT) {
    out.push(beamLevel(angle, beam));
    angle = advanceLens(angle, DT, period);
  }
  return out;
}

describe("beam brightness", () => {
  it("is periodic, a pass every `period` seconds", () => {
    for (const period of [MIN_PERIOD, 23, MAX_PERIOD]) {
      for (const t of [0, 1.7, 4.2, 9.9]) {
        const a = advanceLens(0.4, t, period);
        const b = advanceLens(a, period, period);
        expect(beamLevel(b, 0.8)).toBeCloseTo(beamLevel(a, 0.8), 9);
      }
      // Exactly one rise to the peak per period.
      const levels = trace(period, 1, 3 * period);
      let peaks = 0;
      for (let i = 1; i < levels.length - 1; i++) {
        if (
          levels[i] > levels[i - 1] &&
          levels[i] >= levels[i + 1] &&
          levels[i] > 0.5 * BEAM_PEAK
        ) {
          peaks++;
        }
      }
      expect(peaks).toBeGreaterThanOrEqual(2);
      expect(peaks).toBeLessThanOrEqual(3);
    }
  });

  it("is continuous: no frame-to-frame jumps", () => {
    for (const period of [MIN_PERIOD, 30, MAX_PERIOD]) {
      const levels = trace(period, 1, 2 * period);
      let worst = 0;
      for (let i = 1; i < levels.length; i++) {
        worst = Math.max(worst, Math.abs(levels[i] - levels[i - 1]));
      }
      // Never more than a few per cent of the peak in one frame.
      expect(worst).toBeLessThan(0.03 * BEAM_PEAK);
    }
    // And as a function of angle, across the wrap.
    let worstStep = 0;
    for (let a = -7; a < 7; a += 0.001) {
      // Math.max passes a NaN through, so a NaN step still fails below.
      worstStep = Math.max(worstStep, Math.abs(beamLevel(a + 0.001, 1) - beamLevel(a, 1)));
    }
    expect(worstStep).toBeLessThan(0.01 * BEAM_PEAK);
  });

  it("is capped at BEAM_PEAK, whatever the params", () => {
    for (const beam of [0, 0.5, 1, 2, 1e9, Number.NaN, -1]) {
      for (let a = 0; a < 7; a += 0.01) {
        const v = beamLevel(a, beam);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(BEAM_PEAK);
      }
    }
    expect(beamLevel(0, 1)).toBeCloseTo(BEAM_PEAK);
    expect(beamLevel(Math.PI, 1)).toBeCloseTo(BEAM_PEAK);
    expect(beamLevel(Math.PI / 2, 1)).toBe(0);
    expect(beamLevel(0, 0)).toBe(0);
  });

  it("rises over at least 1 s at the fastest period", () => {
    expect(riseSeconds(MIN_PERIOD)).toBeGreaterThanOrEqual(1.5);
    for (const period of [MIN_PERIOD, 15, MAX_PERIOD, 1, -5, Number.NaN]) {
      const levels = trace(period, 1, 2.5 * Math.max(clampPeriod(period), 1));
      // Find a rise: the frames from first light to the peak, and from 10% to 90% of it.
      const peak = levels.indexOf(Math.max(...levels));
      let start = peak;
      while (start > 0 && levels[start - 1] > 0 && levels[start - 1] < levels[start]) {
        start--;
      }
      let lo = peak;
      while (lo > 0 && levels[lo - 1] >= 0.1 * BEAM_PEAK) {
        lo--;
      }
      let hi = lo;
      while (hi < peak && levels[hi] < 0.9 * BEAM_PEAK) {
        hi++;
      }
      expect((peak - start) * DT).toBeGreaterThanOrEqual(1.5);
      expect((hi - lo) * DT).toBeGreaterThanOrEqual(1);
    }
  });

  it("clamps the period to its range", () => {
    expect(clampPeriod(1)).toBe(MIN_PERIOD);
    expect(clampPeriod(1000)).toBe(MAX_PERIOD);
    expect(clampPeriod(Number.NaN)).toBeGreaterThanOrEqual(MIN_PERIOD);
    expect(advanceLens(1, Number.NaN, 20)).toBe(1);
    expect(advanceLens(1, -1, 20)).toBe(1);
  });

  it("faces the camera smoothly, and only within FACE_HALF", () => {
    expect(facing(0)).toBe(1);
    expect(facing(FACE_HALF)).toBe(0);
    expect(facing(-FACE_HALF * 1.01)).toBe(0);
    expect(facing(2 * Math.PI)).toBeCloseTo(1);
    expect(facing(0.3)).toBeCloseTo(facing(-0.3));
    expect(wrapAngle(3 * Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1);
  });
});

describe("layout", () => {
  it("draws the lens as a beehive, widest at the lamp, on a base ring under a crown", () => {
    expect(lensProfile(LENS_Y0 - 0.01)).toBeGreaterThan(0);
    expect(lensProfile(LENS_Y1 + 0.01)).toBeGreaterThan(0);
    expect(lensProfile(LAMP_Y)).toBe(LENS_R);
    expect(lensRadius(LAMP_Y)).toBe(LENS_R);
    expect(lensRadius(LENS_Y1)).toBeLessThan(lensRadius(LENS_Y0));
    expect(lensRadius(LENS_Y0 - 0.01)).toBe(0);
    expect(lensRadius(LENS_Y1 + 0.01)).toBe(0);
    for (let y = LENS_Y0; y <= LENS_Y1; y += 0.01) {
      expect(lensRadius(y)).toBeGreaterThan(0);
      expect(lensRadius(y)).toBeLessThanOrEqual(LENS_R);
    }
  });

  for (const aspect of [16 / 9, 4 / 3, 21 / 9]) {
    it(`keeps the lens out of the middle at ${aspect.toFixed(2)}`, () => {
      const third = aspect / 3;
      const left = lensBox("left", aspect);
      const right = lensBox("right", aspect);
      // LENS_AT in from the side, or further in where the room runs out, but never in the middle third.
      expect(left.lampX).toBeGreaterThan(LENS_AT * aspect - 1e-9);
      expect(left.x1).toBeLessThan(third + 0.05);
      // The right is the left's mirror image.
      expect(right.lampX).toBeCloseTo(aspect - left.lampX);
      expect(right.x0).toBeCloseTo(aspect - left.x1);
      for (const box of [left, right]) {
        // Whole lens and crown in frame, top to bottom.
        expect(box.y0).toBeGreaterThan(0);
        expect(box.y1).toBeLessThan(1);
      }
      // The camera stands inside the walkway.
      expect(Math.hypot(cameraX("left", aspect), CAM_Z)).toBeLessThan(WALK_R);
    });
  }

  it("mirrors the camera and moon by side", () => {
    expect(cameraX("right", 16 / 9)).toBeCloseTo(-cameraX("left", 16 / 9));
    expect(moonX("left") + moonX("right")).toBeCloseTo(1);
    // The moon is across from the lens.
    expect(moonX("left")).toBeGreaterThan(0.5);
    const c = towardCamera("left", 16 / 9, { x: 0, z: 0 });
    expect(Math.hypot(c.x, c.z)).toBeCloseTo(1);
    expect(c.z).toBeLessThan(0);
  });

  it("projects points behind the camera as hidden", () => {
    const p = { x: -1, y: -1 };
    expect(project(0, 0, CAM_Z - 1, "left", 16 / 9, p)).toBe(false);
    expect(p.x).toBe(-1);
    expect(project(0, LAMP_Y, 0, "left", 16 / 9, p)).toBe(true);
  });
});

describe("band table", () => {
  const table = buildBandTable();

  it("peaks where the beam falls and repeats smoothly", () => {
    expect(table.length).toBe(BAND_SIZE);
    expect(table[0]).toBe(255);
    expect(Math.abs(table[0] - table[BAND_SIZE - 1])).toBeLessThan(8);
    for (let i = 1; i < BAND_SIZE; i++) {
      expect(Math.abs(table[i] - table[i - 1])).toBeLessThan(70);
    }
  });

  it("has thin bands between the beams", () => {
    const mid = table.slice(BAND_SIZE / 4, (3 * BAND_SIZE) / 4);
    expect(Math.max(...mid)).toBeGreaterThan(40);
    expect(Math.min(...mid)).toBeLessThan(10);
  });
});

describe("weather", () => {
  it("snaps on the first frame, then rolls in over WEATHER_EASE", () => {
    const look = createWeatherLook();
    easeWeather(look, "calm", 0, true);
    expect(look).toEqual(WEATHER.calm);
    easeWeather(look, "storm", WEATHER_EASE / 2);
    expect(look.storm).toBeCloseTo(0.5);
    expect(look.swell).toBeGreaterThan(WEATHER.calm.swell);
    expect(look.swell).toBeLessThan(WEATHER.storm.swell);
    easeWeather(look, "storm", WEATHER_EASE);
    expect(look).toEqual(WEATHER.storm);
    // Unknown values fall back to clouds.
    easeWeather(look, "fog", 0, true);
    expect(look).toEqual(WEATHER.clouds);
  });

  it("rains and raises the sea only in a storm", () => {
    expect(WEATHER.calm.rain).toBe(0);
    expect(WEATHER.clouds.rain).toBe(0);
    expect(WEATHER.storm.rain).toBeGreaterThan(0);
    expect(WEATHER.storm.swell).toBeGreaterThan(WEATHER.clouds.swell);
  });
});

describe("clouds", () => {
  it("thicken with cover", () => {
    let prev = -1;
    for (let cover = 0; cover <= 1; cover += 0.1) {
      const d = cloudDensity(0.55, 0.5, cover);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(cloudDensity(0.5, 0.5, 0)).toBe(0);
    expect(cloudDensity(0.7, 0.7, 1)).toBe(1);
  });

  it("sample a tiling texture as the GPU does", () => {
    const size = 4;
    const data = new Uint8Array(size * size * 2);
    for (let i = 0; i < size * size; i++) {
      data[i * 2] = i * 10;
      data[i * 2 + 1] = 255;
    }
    // Texel centres return the texel.
    expect(sampleTiled(data, size, 2, 0, 1.5 / size, 2.5 / size)).toBeCloseTo(
      (2 * 4 + 1) * (10 / 255),
    );
    expect(sampleTiled(data, size, 2, 1, 0.3, 0.7)).toBeCloseTo(1);
    // Halfway between two texels.
    expect(sampleTiled(data, size, 2, 0, 1 / size, 0.5 / size)).toBeCloseTo(5 / 255);
    // Tiles repeat.
    expect(sampleTiled(data, size, 2, 0, 0.3 + 3, 0.6 - 2)).toBeCloseTo(
      sampleTiled(data, size, 2, 0, 0.3, 0.6),
    );
  });
});
