import { describe, expect, it } from "vitest";
import { createLayout, inMiddleThird, MAX_COLS, MAX_ROWS, sheetLayout } from "./spreadsheet-layout";

const sizes = [
  [1920, 1080],
  [1280, 720],
  [3840, 2160],
  [2560, 1080],
] as const;
const zooms = [0.8, 1, 1.25, 1.6];

describe("spreadsheet layout", () => {
  it.each(sizes.flatMap(([w, h]) => zooms.map((z) => [w, h, z] as const)))(
    "keeps both tables in the outer thirds at %d x %d, zoom %d",
    (w, h, z) => {
      const L = sheetLayout(w, h, h / 1080, z, createLayout());
      expect(L.sparseMiddle).toBe(true);
      expect(L.leftCols).toBeGreaterThan(0);
      expect(L.leftItems).toBeGreaterThan(0);
      for (let c = 0; c <= L.leftCols; c++) {
        expect(inMiddleThird(L, c)).toBe(false);
      }
      expect(L.rightStart).toBeGreaterThan(L.leftCols + 1);
      for (let c = L.rightStart; c <= L.rightStart + L.rightCols; c++) {
        expect(inMiddleThird(L, c)).toBe(false);
        expect(c).toBeLessThan(L.fullCols);
      }
      // Tables keep a totals row and a blank row on screen.
      expect(L.leftItems + 3).toBeLessThanOrEqual(L.fullRows);
      expect(L.rightItems + 3).toBeLessThanOrEqual(L.fullRows);
    },
  );

  it.each(sizes)(
    "floats the chart below the right table, in the right third, at %d x %d",
    (w, h) => {
      const L = sheetLayout(w, h, h / 1080, 1, createLayout());
      const c = L.chart;
      expect(c.w).toBeGreaterThan(0);
      expect(c.x).toBeGreaterThanOrEqual((2 * w) / 3);
      expect(c.x + c.w).toBeLessThanOrEqual(w);
      expect(c.y).toBeGreaterThanOrEqual(L.cellsTop + (L.rightItems + 2) * L.rowH);
      expect(c.y + c.h).toBeLessThanOrEqual(L.cellsBottom);
    },
  );

  it.each([
    [1, 1],
    [60, 1080],
    [1920, 60],
    [16, 9],
  ])("stays within its limits on a %d x %d frame", (w, h) => {
    const L = sheetLayout(w, h, h / 1080, 1, createLayout());
    expect(L.colCount).toBeLessThanOrEqual(MAX_COLS);
    expect(L.rowCount).toBeLessThanOrEqual(MAX_ROWS);
    expect(L.rowH).toBeGreaterThanOrEqual(1);
    expect(L.leftCols + 1).toBeLessThanOrEqual(Math.max(1, L.fullCols));
  });
});
