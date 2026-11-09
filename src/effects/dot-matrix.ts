/**
 * Dot-matrix lettering for the Scenes' screens (first drawn for Mission Control):
 * a 5x7 dot-matrix font for CRTs and wall screens, seven-segment masks for big
 * clocks and countdowns, and the "text page", a small grid of glyph indices the
 * composite shader reads lines from.
 * All pure, so the font and formatting can be tested.
 *
 * In the text page, `RANDOM_DIGIT` marks a cell the shader fills with a digit
 * hashed from the line and its tick count, so the numbers can change without
 * re-uploading anything.
 */

/** Columns of dots per glyph, and rows. */
export const GLYPH_W = 5;
export const GLYPH_H = 7;

/**
 * The glyphs, in index order, each as seven rows of five dots, top first. Index
 * 0 is the space. (A list, since an object would put the digits' keys first.)
 */
const FONT: readonly (readonly [string, string])[] = [
  [" ", ".....|.....|.....|.....|.....|.....|....."],
  ["0", ".###.|#...#|#..##|#.#.#|##..#|#...#|.###."],
  ["1", "..#..|.##..|..#..|..#..|..#..|..#..|.###."],
  ["2", ".###.|#...#|....#|...#.|..#..|.#...|#####"],
  ["3", "#####|...#.|..#..|...#.|....#|#...#|.###."],
  ["4", "...#.|..##.|.#.#.|#..#.|#####|...#.|...#."],
  ["5", "#####|#....|####.|....#|....#|#...#|.###."],
  ["6", "..##.|.#...|#....|####.|#...#|#...#|.###."],
  ["7", "#####|....#|...#.|..#..|.#...|.#...|.#..."],
  ["8", ".###.|#...#|#...#|.###.|#...#|#...#|.###."],
  ["9", ".###.|#...#|#...#|.####|....#|...#.|.##.."],
  ["A", ".###.|#...#|#...#|#####|#...#|#...#|#...#"],
  ["B", "####.|#...#|#...#|####.|#...#|#...#|####."],
  ["C", ".###.|#...#|#....|#....|#....|#...#|.###."],
  ["D", "###..|#..#.|#...#|#...#|#...#|#..#.|###.."],
  ["E", "#####|#....|#....|####.|#....|#....|#####"],
  ["F", "#####|#....|#....|####.|#....|#....|#...."],
  ["G", ".###.|#...#|#....|#.###|#...#|#...#|.####"],
  ["H", "#...#|#...#|#...#|#####|#...#|#...#|#...#"],
  ["I", ".###.|..#..|..#..|..#..|..#..|..#..|.###."],
  ["J", "..###|...#.|...#.|...#.|...#.|#..#.|.##.."],
  ["K", "#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#"],
  ["L", "#....|#....|#....|#....|#....|#....|#####"],
  ["M", "#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#"],
  ["N", "#...#|#...#|##..#|#.#.#|#..##|#...#|#...#"],
  ["O", ".###.|#...#|#...#|#...#|#...#|#...#|.###."],
  ["P", "####.|#...#|#...#|####.|#....|#....|#...."],
  ["Q", ".###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#"],
  ["R", "####.|#...#|#...#|####.|#.#..|#..#.|#...#"],
  ["S", ".####|#....|#....|.###.|....#|....#|####."],
  ["T", "#####|..#..|..#..|..#..|..#..|..#..|..#.."],
  ["U", "#...#|#...#|#...#|#...#|#...#|#...#|.###."],
  ["V", "#...#|#...#|#...#|#...#|#...#|.#.#.|..#.."],
  ["W", "#...#|#...#|#...#|#.#.#|#.#.#|#.#.#|.#.#."],
  ["X", "#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#"],
  ["Y", "#...#|#...#|.#.#.|..#..|..#..|..#..|..#.."],
  ["Z", "#####|....#|...#.|..#..|.#...|#....|#####"],
  [".", ".....|.....|.....|.....|.....|.##..|.##.."],
  ["-", ".....|.....|.....|#####|.....|.....|....."],
  [":", ".....|.##..|.##..|.....|.##..|.##..|....."],
  ["+", ".....|..#..|..#..|#####|..#..|..#..|....."],
  ["/", ".....|....#|...#.|..#..|.#...|#....|....."],
];
const FONT_ROWS: ReadonlyMap<string, string> = new Map(FONT);

/** Every character the font has, in glyph-index order. */
export const GLYPHS = FONT.map(([ch]) => ch).join("");
export const GLYPH_COUNT = GLYPHS.length;
/** Glyph index of "0"; the other digits follow it in order. */
export const DIGIT_0 = GLYPHS.indexOf("0");
/** Text page code for "a digit the shader picks": outside the glyph range. */
export const RANDOM_DIGIT = 255;

/** Glyph index of a character (0, the space, for any it lacks). Lowercase reads as capitals. */
export function glyphIndex(ch: string): number {
  const i = GLYPHS.indexOf(ch.toUpperCase());
  return i < 0 ? 0 : i;
}

/** The glyph's dots, top row first: `GLYPH_H` strings of `GLYPH_W` "#" or ".". */
export function glyphRows(ch: string): string[] {
  return (FONT_ROWS.get(ch.toUpperCase()) ?? FONT[0][1]).split("|");
}

/**
 * The font as an R8 texture of `GLYPH_W * GLYPH_COUNT` x (`GLYPH_H` + 1) texels.
 * Row 0 is the glyphs' bottom row of dots (255 lit, 0 dark), up to row 6, their
 * top; row 7 holds each glyph's share of lit dots, for drawing text too small to
 * show its dots.
 */
export function buildFontTexture(): Uint8Array {
  const width = GLYPH_W * GLYPH_COUNT;
  const out = new Uint8Array(width * (GLYPH_H + 1));
  for (let g = 0; g < GLYPH_COUNT; g++) {
    const rows = glyphRows(GLYPHS[g] ?? " ");
    let lit = 0;
    for (let r = 0; r < GLYPH_H; r++) {
      const row = rows[GLYPH_H - 1 - r] ?? "";
      for (let c = 0; c < GLYPH_W; c++) {
        if (row[c] === "#") {
          out[r * width + g * GLYPH_W + c] = 255;
          lit++;
        }
      }
    }
    const share = Math.round((lit / (GLYPH_W * GLYPH_H)) * 255);
    for (let c = 0; c < GLYPH_W; c++) {
      out[GLYPH_H * width + g * GLYPH_W + c] = share;
    }
  }
  return out;
}

/*
 * Seven-segment masks. Bits 0-6 are the segments a (top), b (top right),
 * c (bottom right), d (bottom), e (bottom left), f (top left) and g (middle);
 * bit 7 is a short vertical bar through the middle (for "+"), and bit 8 the two
 * dots of a colon.
 */
const SEG: Readonly<Record<string, number>> = {
  "0": 0b0111111,
  "1": 0b0000110,
  "2": 0b1011011,
  "3": 0b1001111,
  "4": 0b1100110,
  "5": 0b1101101,
  "6": 0b1111101,
  "7": 0b0000111,
  "8": 0b1111111,
  "9": 0b1101111,
  "-": 0b1000000,
  "+": 0b11000000,
  ":": 0b100000000,
  // Lowercase t (d, e, f, g), and the letters of HOLD.
  T: 0b1111000,
  H: 0b1110110,
  O: 0b0111111,
  L: 0b0111000,
  D: 0b1011110,
};

/** The seven-segment mask for each glyph index (0 for glyphs it can't show). */
export function sevenSegmentMasks(): number[] {
  const out: number[] = [];
  for (const ch of GLYPHS) {
    out.push(SEG[ch] ?? 0);
  }
  return out;
}

/** Columns and lines of the text page. */
export const PAGE_COLS = 32;
export const PAGE_LINES = 48;

/** The text page's lines, by purpose. */
export const LINE = {
  /** Wall telemetry: one line per row of the screen. */
  telemetry: 0,
  clock: 12,
  countdown: 13,
  clockLabel: 14,
  countdownLabel: 15,
  /** Labels over the wall graphs, one each. */
  graphLabels: 16,
  /** Number patterns for the console CRTs' scrolling lines. */
  patterns: 20,
  /** Header lines for the console CRTs. */
  headers: 36,
  mapLabel: 44,
} as const;

export const TELEMETRY_LINES = 10;
export const TELEMETRY_COLS = 24;
export const PATTERN_COUNT = 16;
export const HEADER_COUNT = 8;
/** Columns of text on a console CRT. */
export const CRT_COLS = 8;
export const WALL_GRAPHS = 3;

/** Wall telemetry: a label and a pattern of digits ('#' is a digit that ticks over). */
const TELEMETRY: readonly string[] = [
  "ALT     ###.#   ###.##  ",
  "VEL   #####.#   ####.#  ",
  "GAMMA   -#.##   +#.###  ",
  "AZ      ###.##  ###.##  ",
  "APO     ###.#   ###.#   ",
  "PERI    ###.#   ###.#   ",
  "INCL     ##.##   ##.##  ",
  "RANGE  ####.#  ####.#   ",
  "WT     #####   #####    ",
  "DELTA V  ###.#  ###.#   ",
];

const PATTERNS: readonly string[] = [
  "## ####",
  "#### ###",
  "-#.## ##",
  "### ## #",
  "+##.## #",
  "#.### ##",
  "## ## ##",
  "#### #.#",
  "###.# ##",
  "-## ####",
  "# ### ##",
  "##.# ###",
  "########",
  "### -#.#",
  "+#.#  ##",
  "## ### #",
];

const HEADERS: readonly string[] = ["TRAJ", "GUID", "COMM", "PROP", "ELEC", "ENV", "TLM", "NAV"];

const GRAPH_LABELS = ["CABIN PRESS", "BUS VOLTS", "SIGNAL"] as const;

/** Writes `text` into line `line` of the page, padded with spaces, '#' as `RANDOM_DIGIT`. */
export function writeLine(page: Uint8Array, line: number, text: string): void {
  const base = line * PAGE_COLS;
  for (let c = 0; c < PAGE_COLS; c++) {
    const ch = text[c] ?? " ";
    page[base + c] = ch === "#" ? RANDOM_DIGIT : glyphIndex(ch);
  }
}

/** The page with every fixed line written; the clock and countdown lines start blank. */
export function buildTextPage(): Uint8Array {
  const page = new Uint8Array(PAGE_COLS * PAGE_LINES);
  TELEMETRY.forEach((t, i) => {
    writeLine(page, LINE.telemetry + i, t);
  });
  GRAPH_LABELS.forEach((t, i) => {
    writeLine(page, LINE.graphLabels + i, t);
  });
  PATTERNS.forEach((t, i) => {
    writeLine(page, LINE.patterns + i, t);
  });
  HEADERS.forEach((t, i) => {
    writeLine(page, LINE.headers + i, t);
  });
  writeLine(page, LINE.mapLabel, "GROUND TRACK");
  return page;
}

/** The console CRTs' patterns and headers, for checking they fit. */
export const CRT_TEXT: readonly string[] = [...PATTERNS, ...HEADERS];

/** Every string the page holds, for checking the font covers them. */
export const PAGE_TEXT: readonly string[] = [
  ...TELEMETRY,
  ...PATTERNS,
  ...HEADERS,
  ...GRAPH_LABELS,
  "GROUND TRACK",
];
