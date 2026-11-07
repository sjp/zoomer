import { describe, expect, it } from "vitest";
import {
  approachSky,
  BANK_MIN_GAP,
  BANK_SLOT,
  bankAt,
  bankVisit,
  buildGlyphAtlas,
  createBankVisit,
  createJetSky,
  createPass,
  GLYPH_BLANK,
  GLYPH_CELL,
  GLYPH_COUNT,
  GLYPH_DOT,
  GLYPH_ROWS,
  MAX_BANK,
  MAX_PASS_GAP,
  MIN_PASS_GAP,
  PASS_LENGTH,
  PASS_PEAK,
  passAt,
  passStart,
  READOUT_GLYPHS,
  READOUTS,
  readingDim,
  readingGlyphs,
  readingKey,
  ROLL_MAX,
  ROLL_MIN,
  SKIES,
} from "./jetcockpit-sim";

const SEEDS = [0, 7, 42, 999];

describe("bank", () => {
  it("stays within the steepest bank, scaled by the amount", () => {
    for (const seed of SEEDS) {
      for (const amount of [0, 0.5, 1]) {
        for (let t = 0; t < 3000; t += 0.13) {
          expect(Math.abs(bankAt(t, seed, amount))).toBeLessThanOrEqual(MAX_BANK * amount + 1e-12);
        }
      }
    }
  });

  it("is smooth: it never rolls faster than the gentlest ease allows", () => {
    // The quintic ease's steepest slope is 15/8 of its average.
    const maxRate = (MAX_BANK * 15) / 8 / ROLL_MIN;
    const dt = 0.02;
    for (const seed of SEEDS) {
      let last = bankAt(0, seed, 1);
      let lastRate = 0;
      for (let t = dt; t < 2000; t += dt) {
        const a = bankAt(t, seed, 1);
        const rate = (a - last) / dt;
        expect(Math.abs(rate)).toBeLessThanOrEqual(maxRate * 1.01);
        // No kinks: the roll rate itself changes gradually.
        expect(Math.abs(rate - lastRate)).toBeLessThan(0.002);
        last = a;
        lastRate = rate;
      }
    }
  });

  it("returns to level after every bank, with a level gap before the next", () => {
    const v = createBankVisit();
    for (const seed of SEEDS) {
      let banks = 0;
      for (let slot = 0; slot < 60; slot++) {
        bankVisit(slot, seed, v);
        const end = v.start + 2 * v.roll + v.hold;
        expect(v.roll).toBeGreaterThanOrEqual(ROLL_MIN);
        expect(v.roll).toBeLessThanOrEqual(ROLL_MAX);
        if (v.angle === 0) {
          continue;
        }
        banks++;
        expect(v.start).toBeGreaterThanOrEqual(slot * BANK_SLOT);
        expect(end).toBeLessThanOrEqual((slot + 1) * BANK_SLOT - BANK_MIN_GAP + 1e-9);
        expect(Math.abs(bankAt(v.start, seed, 1))).toBeLessThan(1e-12);
        expect(Math.abs(bankAt(end, seed, 1))).toBeLessThan(1e-12);
        expect(Math.abs(bankAt(v.start + v.roll + v.hold / 2, seed, 1))).toBeGreaterThan(
          0.4 * MAX_BANK,
        );
        // Level all through the gap after it.
        for (let t = end + 0.01; t < (slot + 1) * BANK_SLOT; t += 0.5) {
          expect(bankAt(t, seed, 1)).toBe(0);
        }
      }
      // About one a minute.
      expect(banks).toBeGreaterThan(40);
    }
  });

  it("holds level with no bank, and at bad times", () => {
    for (let t = 0; t < 600; t += 0.7) {
      expect(bankAt(t, 7, 0)).toBe(0);
    }
    expect(bankAt(Number.NaN, 7, 1)).toBe(0);
    expect(bankAt(-5, 7, 1)).toBe(0);
  });
});

describe("near clouds", () => {
  it("pass every 20 to 60 seconds", () => {
    expect(MIN_PASS_GAP).toBe(20);
    expect(MAX_PASS_GAP).toBe(60);
    for (const seed of SEEDS) {
      for (let k = 0; k < 200; k++) {
        const gap = passStart(k + 1, seed) - passStart(k, seed);
        expect(gap).toBeGreaterThanOrEqual(MIN_PASS_GAP);
        expect(gap).toBeLessThanOrEqual(MAX_PASS_GAP);
        expect(PASS_LENGTH).toBeLessThan(gap);
      }
    }
  });

  it("thicken over more than a second, never past the peak, and clear completely", () => {
    const pass = createPass();
    for (const seed of SEEDS) {
      const start = passStart(3, seed);
      let peakAt = start;
      let peak = 0;
      for (let t = start; t < start + PASS_LENGTH; t += 0.01) {
        const level = passAt(t, seed, 1, pass).level;
        expect(level).toBeLessThanOrEqual(PASS_PEAK);
        if (level > peak) {
          peak = level;
          peakAt = t;
        }
      }
      expect(peak).toBeGreaterThan(0.95 * PASS_PEAK);
      // From clear to half its peak alone takes a good half second; all the way, over a second.
      expect(peakAt - start).toBeGreaterThanOrEqual(1);
      expect(passAt(start - 0.01, seed, 1, pass).level).toBe(0);
      expect(passAt(start + PASS_LENGTH + 0.01, seed, 1, pass).level).toBe(0);
    }
  });

  it("change gradually, and not at all in a clear sky", () => {
    const pass = createPass();
    const dt = 0.02;
    let last = 0;
    for (let t = 0; t < 600; t += dt) {
      const level = passAt(t, 42, 1, pass).level;
      // Far below a flash: under 1.6 peak per second at the steepest.
      expect(Math.abs(level - last) / dt).toBeLessThan(1.6 * PASS_PEAK);
      last = level;
      expect(passAt(t, 42, 0, pass).level).toBe(0);
    }
  });
});

describe("displays", () => {
  it("draw every glyph inside its cell, clear of the margins", () => {
    const atlas = buildGlyphAtlas();
    const w = GLYPH_CELL * GLYPH_COUNT;
    expect(atlas.length).toBe(w * GLYPH_ROWS);
    for (let g = 0; g < GLYPH_COUNT; g++) {
      let lit = 0;
      let marginLit = 0;
      for (let y = 0; y < GLYPH_ROWS; y++) {
        for (let x = 0; x < GLYPH_CELL; x++) {
          const on = atlas[y * w + g * GLYPH_CELL + x] > 0;
          const margin = x === 0 || y === 0 || x === GLYPH_CELL - 1 || y === GLYPH_ROWS - 1;
          lit += on ? 1 : 0;
          marginLit += on && margin ? 1 : 0;
        }
      }
      expect(marginLit).toBe(0);
      // Digits, the dash and the point are drawn; the rest are blank.
      expect(lit > 0).toBe(g <= GLYPH_DOT);
    }
  });

  it("change each reading now and then, holding it in between", () => {
    for (const seed of SEEDS) {
      for (let line = 0; line < READOUTS; line++) {
        let changes = 0;
        let last = readingKey(line, seed, 0);
        let lastChange = -Infinity;
        let shortest = Infinity;
        for (let t = 0; t < 900; t += 0.1) {
          const key = readingKey(line, seed, t);
          if (key !== last) {
            changes++;
            shortest = Math.min(shortest, t - lastChange);
            lastChange = t;
            last = key;
          }
        }
        // Slowly: a few times a minute at most, but not frozen.
        expect(changes).toBeGreaterThan(5);
        expect(changes).toBeLessThan(60);
        expect(shortest).toBeGreaterThan(3);
      }
    }
  });

  it("dims readings only partly and briefly", () => {
    let dimmed = 0;
    for (let t = 0; t < 900; t += 0.1) {
      const d = readingDim(0, 7, t);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
      if (d > 0) {
        dimmed++;
      }
    }
    expect(dimmed).toBeLessThan(9000 * 0.3);
  });

  it("writes right-aligned digits, with a point where the reading has decimals", () => {
    const out = new Float32Array(READOUTS * READOUT_GLYPHS);
    for (const seed of SEEDS) {
      for (let key = 0; key < 50; key++) {
        for (let line = 0; line < READOUTS; line++) {
          readingGlyphs(line, seed, key, out, line * READOUT_GLYPHS);
        }
        for (const g of out) {
          expect(Number.isInteger(g)).toBe(true);
          expect(g === GLYPH_BLANK || (g >= 0 && g <= GLYPH_DOT)).toBe(true);
        }
        // The last glyph is always a digit, and a blank never follows a digit.
        for (let line = 0; line < READOUTS; line++) {
          const o = line * READOUT_GLYPHS;
          expect(out[o + READOUT_GLYPHS - 1]).toBeLessThan(10);
          let seenDigit = false;
          let blankAfterDigit = false;
          for (let i = 0; i < READOUT_GLYPHS; i++) {
            const blank = out[o + i] === GLYPH_BLANK;
            blankAfterDigit ||= blank && seenDigit;
            seenDigit ||= !blank;
          }
          expect(blankAfterDigit).toBe(false);
        }
        // 0.xx: a leading zero before the point.
        expect(out[READOUT_GLYPHS]).toBe(0);
        expect(out[READOUT_GLYPHS + 1]).toBe(GLYPH_DOT);
      }
    }
  });
});

describe("sky", () => {
  it("eases from one time of day to another without a jump", () => {
    const sky = createJetSky(SKIES.day);
    let last = sky.zenith[0];
    const step = Math.abs(SKIES.night.zenith[0] - SKIES.day.zenith[0]);
    for (let i = 0; i < 600; i++) {
      approachSky(sky, SKIES.night, 1 / 60);
      expect(Math.abs(sky.zenith[0] - last)).toBeLessThan(step * 0.05);
      last = sky.zenith[0];
    }
    expect(sky.zenith[0]).toBeCloseTo(SKIES.night.zenith[0], 3);
    expect(sky.stars).toBeCloseTo(1, 3);
    // The copy is its own: the preset is untouched.
    expect(SKIES.day.stars).toBe(0);
  });

  it("keeps the sun or moon above the horizon", () => {
    for (const sky of Object.values(SKIES)) {
      expect(sky.sunY).toBeGreaterThan(0);
    }
  });
});
