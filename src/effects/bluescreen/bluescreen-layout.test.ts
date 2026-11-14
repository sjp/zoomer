import { describe, expect, it } from "vitest";
import {
  BAND,
  CLASSIC_COLS,
  CLASSIC_PROMPT,
  CLEAR_LEFT,
  layoutClassic,
  layoutFor,
  layoutKernel,
  layoutModern,
  type Measure,
  REF_HEIGHT,
  textBoxes,
  wrapLine,
} from "./bluescreen-layout";
import { type BlueStyle, CLASSIC_CHARS, TRACE_ROWS } from "./bluescreen-sim";
import { bluescreenMeta, CODE_LENGTH, MESSAGE_LENGTH, MESSAGE_LINES } from "./bluescreen.meta";

/** Wide letters everywhere, a little wider than most real fonts. */
const measure: Measure = (text, kind) => Array.from(text).length * (kind === "mono" ? 0.6 : 0.62);

const LONGEST_MESSAGE = Array.from({ length: MESSAGE_LINES }, () =>
  "W".repeat(MESSAGE_LENGTH),
).join("\n");
const LONGEST_WORDS = Array.from({ length: MESSAGE_LINES }, () =>
  "WWWWW ".repeat(8).slice(0, MESSAGE_LENGTH),
).join("\n");
const LONGEST_CODE = "W".repeat(CODE_LENGTH);
const DEFAULT_MESSAGE = bluescreenMeta.params.text.default;
const DEFAULT_CODE = bluescreenMeta.params.code.default;

const ASPECTS: [string, number][] = [
  ["16:9", 16 / 9],
  ["4:3", 4 / 3],
  ["21:9", 21 / 9],
  ["9:16", 9 / 16],
];
const STYLES: BlueStyle[] = ["modern", "classic", "kernel"];
const TEXTS: [string, string, string][] = [
  ["default", DEFAULT_MESSAGE, DEFAULT_CODE],
  ["longest", LONGEST_MESSAGE, LONGEST_CODE],
  ["longest words", LONGEST_WORDS, LONGEST_CODE],
];
const CASES = STYLES.flatMap((style) =>
  ASPECTS.flatMap(([name, aspect]) =>
    TEXTS.map(([which, message, code]) => [style, name, which, aspect, message, code] as const),
  ),
);

describe("wrapLine", () => {
  const widthOf = (s: string) => s.length;
  it("breaks between words", () => {
    expect(wrapLine("aa bb cc dd", 5, widthOf)).toEqual(["aa bb", "cc dd"]);
  });
  it("cuts a word too long for a line", () => {
    expect(wrapLine("abcdefgh ij", 3, widthOf)).toEqual(["abc", "def", "gh", "ij"]);
  });
  it("keeps an empty line", () => {
    expect(wrapLine("", 3, widthOf)).toEqual([""]);
  });
});

describe("blue screen layout", () => {
  it.each(CASES)(
    "fits %s text at %s (%s) in the frame, clear of the middle",
    (style, _name, _which, aspect, message, code) => {
      const refWidth = REF_HEIGHT * aspect;
      const layout = layoutFor(style, message, code, refWidth, measure);
      const boxes = textBoxes(layout);
      expect(boxes.length).toBeGreaterThan(3);
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(refWidth + 1e-6);
        expect(b.y + b.h).toBeLessThanOrEqual(REF_HEIGHT + 1e-6);
      }
      // Below the upper third, text keeps to the left column, clear of the middle.
      const below = boxes.filter((b) => b.y + b.h > BAND * REF_HEIGHT + 1e-6);
      for (const b of below) {
        expect(b.x + b.w).toBeLessThanOrEqual(CLEAR_LEFT * refWidth + 1e-6);
      }
    },
  );

  it("keeps the default text readable on a 16:9 frame", () => {
    const modern = layoutModern(DEFAULT_MESSAGE, DEFAULT_CODE, 1920, measure);
    expect(modern.runs[0].size).toBeGreaterThan(100);
    expect(modern.percentSize).toBeGreaterThan(20);
    const classic = layoutClassic(DEFAULT_MESSAGE, DEFAULT_CODE, 1920);
    expect(classic.dot).toBeGreaterThanOrEqual(1.5);
    expect(classic.cols).toBeLessThanOrEqual(CLASSIC_COLS);
    const kernel = layoutKernel(DEFAULT_CODE, 1920, measure);
    expect(kernel.size).toBeGreaterThan(14);
    expect(kernel.log.h).toBeCloseTo(TRACE_ROWS * kernel.lineHeight);
  });

  it.each(ASPECTS)("ends the Classic page with the prompt and its cursor (%s)", (_n, aspect) => {
    const layout = layoutClassic(LONGEST_MESSAGE, LONGEST_CODE, REF_HEIGHT * aspect);
    const last = layout.lines.at(-1) ?? "";
    expect(CLASSIC_PROMPT.startsWith(last.trim())).toBe(true);
    for (const line of layout.lines) {
      expect(Array.from(line).length).toBeLessThanOrEqual(layout.cols);
    }
    expect(layout.cursor.y).toBeGreaterThan(layout.y + (layout.lines.length - 1) * 9 * layout.dot);
  });

  it("draws the Classic page only in characters its font has", () => {
    const layout = layoutClassic("Ünïcode “quotes” & semis; ☃", "STOP_CODE{1}", 1920);
    for (const line of layout.lines) {
      for (const ch of line) {
        expect(CLASSIC_CHARS).toContain(ch);
      }
    }
  });

  it("shows the stop code in every style", () => {
    const modern = layoutModern(DEFAULT_MESSAGE, "ABC_DEF", 1920, measure);
    expect(modern.runs.some((r) => r.text.includes("ABC_DEF"))).toBe(true);
    const classic = layoutClassic(DEFAULT_MESSAGE, "ABC_DEF", 1920);
    expect(classic.lines.join(" ")).toContain("ABC_DEF");
    const kernel = layoutKernel("ABC_DEF", 1920, measure);
    expect(kernel.runs[0].text).toContain("ABC_DEF");
  });
});
