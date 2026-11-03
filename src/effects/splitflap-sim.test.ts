import { describe, expect, it } from "vitest";
import {
  boardLayout,
  boardLine,
  cellIdle,
  clockLabel,
  createBoard,
  createLayout,
  createMinuteClock,
  flapAngle,
  GLYPH_COUNT,
  GLYPHS,
  maxChangeTime,
  nextGlyph,
  resetCells,
  setTargets,
  stepBoard,
  stepsTo,
  textPages,
  tickClock,
} from "./splitflap-sim";

/** The board's size in the effect. */
const BOARD_COLS = 22;
const MAX_ROWS = 6;

const line = (text: string, cols = BOARD_COLS, align: "left" | "centre" = "left") => {
  const out = new Uint8Array(cols);
  boardLine(text, cols, out, 0, align);
  return Array.from(out, (g) => GLYPHS[g]).join("");
};

describe("boardLine", () => {
  it("uppercases, drops accents and shows unknown characters as blanks", () => {
    expect(line("Zürich 東京 ok~", 16)).toBe("ZURICH    OK    ");
  });

  it("truncates a long line rather than wrapping it", () => {
    expect(line("THE QUICK BROWN FOX JUMPS OVER", 10)).toBe("THE QUICK ");
  });

  it("centres a short line", () => {
    expect(line("12:34", 9, "centre")).toBe("  12:34  ");
  });

  it("writes at an offset and leaves the rest alone", () => {
    const out = new Uint8Array(6).fill(1);
    boardLine("Z", 2, out, 2);
    expect(Array.from(out, (g) => GLYPHS[g]).join("")).toBe("AAZ AA");
  });
});

describe("textPages", () => {
  it("chunks lines into pages and drops trailing blank lines", () => {
    expect(textPages("A\nB\nC\n\n", 2)).toEqual([["A", "B"], ["C"]]);
    expect(textPages("A\n\nC", 3)).toEqual([["A", "", "C"]]);
  });

  it("always has a page", () => {
    expect(textPages("", 3)).toEqual([[]]);
    expect(textPages("\n \n", 3)).toEqual([[]]);
  });
});

describe("cell flips", () => {
  it("step forwards round the drum", () => {
    expect(stepsTo(0, 3)).toBe(3);
    expect(stepsTo(3, 0)).toBe(GLYPH_COUNT - 3);
    expect(stepsTo(5, 5)).toBe(0);
  });

  it("reach every target in a bounded time, one glyph at a time in drum order", () => {
    const cols = BOARD_COLS;
    const rows = MAX_ROWS;
    const n = cols * rows;
    const board = createBoard(cols, rows);
    // Start from every glyph somewhere, head for every glyph somewhere.
    const start = new Uint8Array(n).map((_, i) => (i * 7) % GLYPH_COUNT);
    const target = new Uint8Array(n).map((_, i) => (i * 13 + 5) % GLYPH_COUNT);
    resetCells(board, start, n);
    setTargets(board, target, n, 0);
    const prev = Uint8Array.from(board.cur);
    const dt = 1 / 60;
    const limit = maxChangeTime(cols, rows);
    let t = 0;
    let badStep = 0;
    let moving = true;
    while (moving && t < limit + 1) {
      moving = stepBoard(board, dt, n);
      t += dt;
      for (let i = 0; i < n; i++) {
        if (board.cur[i] !== prev[i] && board.cur[i] !== (prev[i] + 1) % GLYPH_COUNT) badStep++;
        prev[i] = board.cur[i];
      }
    }
    expect(badStep).toBe(0);
    expect(moving).toBe(false);
    expect(t).toBeLessThanOrEqual(limit + dt);
    expect(Array.from(board.cur)).toEqual(Array.from(target));
    expect(Array.from(board.phase).every((p) => p === 0)).toBe(true);
  });

  it("stay put with nothing to do and ignore bad time steps", () => {
    const board = createBoard(4, 1);
    expect(stepBoard(board, 1, 4)).toBe(false);
    setTargets(board, Uint8Array.of(3, 0, 0, 0), 4, 0);
    stepBoard(board, Number.NaN, 4);
    stepBoard(board, -1, 4);
    expect(board.cur[0]).toBe(0);
    expect(board.phase[0]).toBe(0);
  });

  it("ripple: later columns and rows start later", () => {
    const board = createBoard(BOARD_COLS, 2);
    const n = BOARD_COLS * 2;
    setTargets(board, new Uint8Array(n).fill(10), n, 3);
    expect(board.delay[BOARD_COLS - 1]).toBeGreaterThan(board.delay[0]);
    expect(board.delay[BOARD_COLS]).toBeGreaterThan(board.delay[0]);
  });

  it("keep flipping towards a new target set mid-change", () => {
    const board = createBoard(1, 1);
    setTargets(board, Uint8Array.of(20), 1, 0);
    for (let k = 0; k < 30; k++) stepBoard(board, 1 / 30, 1);
    const mid = board.cur[0];
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(20);
    setTargets(board, Uint8Array.of(2), 1, 1);
    expect(board.delay[0]).toBe(0);
    for (let k = 0; k < 600 && !cellIdle(board, 0); k++) stepBoard(board, 1 / 30, 1);
    expect(board.cur[0]).toBe(2);
  });

  it("show the next glyph above while flipping and the same one at rest", () => {
    const board = createBoard(1, 1);
    expect(nextGlyph(board, 0)).toBe(0);
    setTargets(board, Uint8Array.of(GLYPH_COUNT - 1), 1, 0);
    board.cur[0] = GLYPH_COUNT - 1 - 1;
    expect(nextGlyph(board, 0)).toBe(GLYPH_COUNT - 1);
  });
});

describe("flapAngle", () => {
  it("runs continuously and monotonically from 0 to π", () => {
    expect(flapAngle(0)).toBe(0);
    expect(flapAngle(1)).toBeCloseTo(Math.PI, 12);
    let worst = 0;
    let backwards = 0;
    let prev = 0;
    for (let k = 1; k <= 1000; k++) {
      const a = flapAngle(k / 1000);
      worst = Math.max(worst, Math.abs(a - prev));
      if (a < prev) backwards++;
      prev = a;
    }
    expect(backwards).toBe(0);
    expect(worst).toBeLessThan(0.01);
    expect(flapAngle(-1)).toBe(0);
    expect(flapAngle(2)).toBeCloseTo(Math.PI, 12);
  });
});

describe("boardLayout", () => {
  it("fits across the top, inside the frame, growing down with the rows", () => {
    const out = createLayout();
    for (const aspect of [16 / 9, 4 / 3, 21 / 9, 9 / 16]) {
      const small = { ...boardLayout(aspect, BOARD_COLS, 2, MAX_ROWS, out) };
      const h2 = small.housing[3];
      const big = boardLayout(aspect, BOARD_COLS, MAX_ROWS, MAX_ROWS, out);
      expect(big.cellW).toBeCloseTo(small.cellW, 12);
      expect(big.housing[3]).toBeGreaterThan(h2);
      expect(big.housing[0]).toBeGreaterThanOrEqual(0);
      expect(big.housing[2]).toBeLessThanOrEqual(aspect);
      expect(big.housing[3]).toBeLessThan(0.55);
      const lastCellRight = big.x + (BOARD_COLS - 1) * big.pitchX + big.cellW;
      expect(lastCellRight).toBeLessThan(big.housing[2]);
      expect(big.housing[2] - lastCellRight).toBeCloseTo(big.x - big.housing[0], 9);
    }
  });
});

describe("clock", () => {
  it("formats 24-hour HH:MM", () => {
    expect(clockLabel(0)).toBe("00:00");
    expect(clockLabel(9 * 60 + 5)).toBe("09:05");
    expect(clockLabel(23 * 60 + 59)).toBe("23:59");
    expect(clockLabel(1440 + 61)).toBe("01:01");
  });

  it("updates once a minute, reading the time only then", () => {
    const c = createMinuteClock();
    let reads = 0;
    const local = (ms: number) => {
      reads++;
      return Math.floor(ms / 60000) + 600;
    };
    // Half a minute past a minute boundary.
    const t0 = 1_700_000_040_000 + 30_000;
    let changes = 0;
    // Three and a half minutes of 60 fps frames: the first read, then three new minutes.
    for (let k = 0; k < 60 * 210; k++) if (tickClock(c, t0 + (k * 1000) / 60, local)) changes++;
    expect(changes).toBe(4);
    expect(reads).toBe(4);
    // A wall clock set back an hour is noticed at once.
    expect(tickClock(c, t0 - 3_600_000, local)).toBe(true);
  });
});
