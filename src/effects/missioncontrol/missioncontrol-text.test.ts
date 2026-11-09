import { describe, expect, it } from "vitest";
import {
  buildFontTexture,
  buildTextPage,
  CRT_COLS,
  CRT_TEXT,
  DIGIT_0,
  GLYPH_COUNT,
  GLYPH_H,
  GLYPH_W,
  GLYPHS,
  glyphIndex,
  glyphRows,
  LINE,
  PAGE_COLS,
  PAGE_LINES,
  PAGE_TEXT,
  RANDOM_DIGIT,
  SEG_COLON,
  SEG_COLON_MASK,
  SEG_DIGIT,
  SEG_GAP,
  SEG_LINE_MAX,
  sevenSegmentMasks,
  sevenSegWidth,
  writeLine,
} from "../dot-matrix";
import {
  countdownText,
  createLaunchState,
  launchAt,
  localTimeText,
  missionTimeText,
} from "./missioncontrol-sim";

describe("dot-matrix font", () => {
  it("has seven rows of five dots for every glyph, and a blank space", () => {
    for (const ch of GLYPHS) {
      const rows = glyphRows(ch);
      expect(rows).toHaveLength(GLYPH_H);
      for (const r of rows) {
        expect(r).toMatch(/^[#.]{5}$/);
      }
    }
    expect(glyphIndex(" ")).toBe(0);
    // The shaders pick a digit as DIGIT_0 plus 0 to 9.
    expect(GLYPHS.slice(DIGIT_0, DIGIT_0 + 10)).toBe("0123456789");
    expect(glyphRows(" ").join("")).not.toContain("#");
  });

  it("covers every character the screens show", () => {
    const labels = [
      "MISSION ELAPSED TIME",
      "LOCAL TIME",
      "LAUNCH",
      "LAUNCH  STANDBY",
      "GROUND TRACK   REV 0001",
    ];
    for (const text of [...PAGE_TEXT, ...labels]) {
      for (const ch of text.replaceAll("#", "")) {
        expect(GLYPHS).toContain(ch);
      }
    }
    expect(GLYPH_COUNT).toBeLessThan(RANDOM_DIGIT);
  });

  it("fits the console CRTs' lines in their columns", () => {
    for (const text of CRT_TEXT) {
      expect(text.length).toBeLessThanOrEqual(CRT_COLS);
    }
  });

  it("puts each glyph's bottom row first in the texture, with its share of lit dots above", () => {
    const tex = buildFontTexture();
    const w = GLYPH_W * GLYPH_COUNT;
    expect(tex).toHaveLength(w * (GLYPH_H + 1));
    const one = glyphIndex("1");
    // "1" has a full-width base and a single dot at the top centre.
    expect([...tex.subarray(one * GLYPH_W, one * GLYPH_W + 5)]).toEqual([0, 255, 255, 255, 0]);
    expect([
      ...tex.subarray((GLYPH_H - 1) * w + one * GLYPH_W, (GLYPH_H - 1) * w + one * GLYPH_W + 5),
    ]).toEqual([0, 0, 255, 0, 0]);
    const lit = glyphRows("1").join("").split("#").length - 1;
    expect(tex[GLYPH_H * w + one * GLYPH_W]).toBe(Math.round((lit / 35) * 255));
    expect(tex[GLYPH_H * w]).toBe(0);
  });
});

describe("seven-segment masks", () => {
  const masks = sevenSegmentMasks();

  it("light the right segments for each digit", () => {
    const count = (m: number) => m.toString(2).split("1").length - 1;
    const segs = [6, 2, 5, 5, 4, 5, 6, 3, 7, 6];
    for (let d = 0; d <= 9; d++) {
      expect(count(masks[glyphIndex(String(d))] ?? 0)).toBe(segs[d]);
    }
    // "1" is the two right-hand segments.
    expect(masks[glyphIndex("1")]).toBe(0b0000110);
  });

  it("can show every clock and countdown character", () => {
    const s = createLaunchState();
    const texts = [missionTimeText(123456), "23:59:59", countdownText(s, false)];
    s.phase = "countdown";
    s.display = 30;
    texts.push(countdownText(s, true));
    s.phase = "flight";
    s.display = 65;
    texts.push(countdownText(s, true));
    for (const text of texts) {
      for (const ch of text.replaceAll(" ", "")) {
        expect(masks[glyphIndex(ch)]).toBeGreaterThan(0);
      }
    }
  });
});

describe("text page", () => {
  it("writes lines padded with spaces, with random digits marked", () => {
    const page = buildTextPage();
    expect(page).toHaveLength(PAGE_COLS * PAGE_LINES);
    writeLine(page, LINE.clock, "1#:");
    const row = page.subarray(LINE.clock * PAGE_COLS, (LINE.clock + 1) * PAGE_COLS);
    expect(row[0]).toBe(glyphIndex("1"));
    expect(row[1]).toBe(RANDOM_DIGIT);
    expect(row[2]).toBe(glyphIndex(":"));
    expect([...row.subarray(3)].every((c) => c === 0)).toBe(true);
  });

  it("keeps its lines apart", () => {
    const starts = Object.values(LINE).toSorted((a, b) => a - b);
    expect(new Set(starts).size).toBe(starts.length);
    expect(Math.max(...starts)).toBeLessThan(PAGE_LINES);
  });
});

describe("sevenSegWidth", () => {
  const masks = sevenSegmentMasks();

  /**
   * The shader's `sevenSegLine` layout: each character's cell is a digit wide,
   * or a colon's width where its mask is the colon, with a gap after each.
   * Returns where the last character's cell ends.
   */
  const shaderWidth = (text: string) => {
    let at = 0;
    let end = 0;
    for (const ch of text) {
      const w = masks[glyphIndex(ch)] === SEG_COLON_MASK ? SEG_COLON : SEG_DIGIT;
      end = at + w;
      at += w + SEG_GAP;
    }
    return end;
  };

  it("is zero for no text and one digit for one", () => {
    expect(sevenSegWidth("")).toBe(0);
    expect(sevenSegWidth("7")).toBeCloseTo(SEG_DIGIT, 12);
    expect(sevenSegWidth(":")).toBeCloseTo(SEG_COLON, 12);
  });

  it("counts colons narrow and a gap between characters", () => {
    expect(sevenSegWidth("12:34")).toBeCloseTo(4 * SEG_DIGIT + SEG_COLON + 4 * SEG_GAP, 12);
  });

  it("matches the shader's layout for the clocks it shows, so they centre", () => {
    const texts = [
      missionTimeText(0),
      missionTimeText(86400 * 999 + 3599),
      localTimeText(new Date(2026, 0, 1, 23, 59, 58)),
      countdownText(createLaunchState(), true),
    ];
    const launch = createLaunchState();
    for (let t = 0; t < 2000; t += 7) {
      texts.push(countdownText(launchAt(t, 600, launch), true));
    }
    for (const text of texts) {
      expect(text.length).toBeLessThanOrEqual(SEG_LINE_MAX);
      expect(sevenSegWidth(text)).toBeCloseTo(shaderWidth(text), 12);
    }
  });
});
