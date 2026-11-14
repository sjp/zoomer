import { describe, expect, it } from "vitest";
import {
  COLUMN_HEADS,
  createFocusLayout,
  focusLayout,
  gridArea,
  gridShape,
  gridTiles,
  PAD,
  PANEL_TITLE,
  type Rect,
  TILE_HEADER,
  tileTextWidths,
  TOP_BAR,
} from "./trading-layout";
import { BOOK_LEVELS, MAX_STOCKS } from "./trading-sim";

const SIZES = [
  ["16:9", 1920, 1080],
  ["4:3", 1440, 1080],
  ["21:9", 2560, 1080],
  ["portrait", 1080, 1920],
  ["4K", 3840, 2160],
] as const;

const inside = (r: Rect, w: number, h: number) => {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(w);
  expect(r.y + r.h).toBeLessThanOrEqual(h);
};
const overlaps = (a: Rect, b: Rect) =>
  a.w > 0 &&
  b.w > 0 &&
  a.h > 0 &&
  b.h > 0 &&
  a.x < b.x + b.w &&
  b.x < a.x + a.w &&
  a.y < b.y + b.h &&
  b.y < a.y + a.h;

describe("grid shape", () => {
  it.each([
    [4, 2, 2],
    [6, 3, 2],
    [9, 3, 3],
  ])("puts %d tiles in %d x %d at 16:9", (count, cols, rows) => {
    const area = gridArea(1920, 1080, 1, { x: 0, y: 0, w: 0, h: 0 });
    expect(gridShape(count, area.w, area.h)).toEqual([cols, rows]);
  });

  it.each(SIZES.flatMap(([name, w, h]) => [4, 5, 6, 7, 8, 9].map((n) => [name, w, h, n] as const)))(
    "fits every tile at %s with %d tiles, without overlaps",
    (_name, w, h, count) => {
      const tiles = new Float64Array(4 * MAX_STOCKS);
      const middle = gridTiles(count, w, h, h / 1080, tiles);
      const rects: Rect[] = [];
      for (let i = 0; i < count; i++) {
        const r = {
          x: tiles[4 * i],
          y: tiles[4 * i + 1],
          w: tiles[4 * i + 2],
          h: tiles[4 * i + 3],
        };
        inside(r, w, h);
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        for (const o of rects) {
          expect(overlaps(r, o)).toBe(false);
        }
        rects.push(r);
      }
      expect(middle).toBeLessThan(count);
      // The middle tile, where there is one, covers the frame's centre.
      const r = middle >= 0 ? rects[middle] : { x: 0, y: 0, w: w, h: h };
      expect(r.x).toBeLessThan(w / 2);
      expect(r.x + r.w).toBeGreaterThan(w / 2);
      expect(r.y).toBeLessThan(h / 2);
      expect(r.y + r.h).toBeGreaterThan(h / 2);
    },
  );

  it.each(SIZES)("sizes tile text to fit the narrowest tile at %s", (_name, w, h) => {
    const [left, right] = tileTextWidths(w, h, h / 1080);
    const tiles = new Float64Array(4 * MAX_STOCKS);
    for (let count = 4; count <= MAX_STOCKS; count++) {
      gridTiles(count, w, h, h / 1080, tiles);
      for (let i = 0; i < count; i++) {
        expect(left + right + 2 * PAD * (h / 1080)).toBeLessThanOrEqual(tiles[4 * i + 2]);
        expect(TILE_HEADER * (h / 1080)).toBeLessThan(tiles[4 * i + 3] / 2);
      }
    }
  });
});

describe("focus layout", () => {
  it.each(SIZES)("keeps every panel on screen and apart at %s", (_name, w, h) => {
    const l = createFocusLayout();
    focusLayout(w, h, h / 1080, l);
    const panels = [l.top, l.watch, l.chart, l.book, l.trades, l.strip];
    for (const p of panels) {
      inside(p, w, h);
    }
    for (let i = 0; i < panels.length; i++) {
      for (let j = i + 1; j < panels.length; j++) {
        expect(overlaps(panels[i], panels[j])).toBe(false);
      }
    }
    expect(l.plot.w).toBeGreaterThan(0);
    expect(l.plot.h).toBeGreaterThan(0);
    // The plot, volume pane and axes sit inside the chart panel.
    for (const r of [l.plot, l.volume, l.timeAxis]) {
      expect(r.x).toBeGreaterThanOrEqual(l.chart.x);
      expect(r.x + r.w).toBeLessThanOrEqual(l.chart.x + l.chart.w);
      expect(r.y + r.h).toBeLessThanOrEqual(l.chart.y + l.chart.h);
    }
    // The chart covers the middle of the frame, where the speaker sits.
    expect(l.chart.x).toBeLessThan(w / 3);
    expect(l.chart.x + l.chart.w).toBeGreaterThan((2 * w) / 3);
  });

  it("fits every watchlist and book row inside its panel", () => {
    const l = createFocusLayout();
    focusLayout(1920, 1080, 1, l);
    expect(l.top.h).toBe(TOP_BAR);
    expect(l.watchRowsY).toBe(l.watch.y + PANEL_TITLE + COLUMN_HEADS);
    expect(l.watchRowsY + MAX_STOCKS * l.watchRow).toBeLessThanOrEqual(l.watch.y + l.watch.h);
    expect(l.bookRowsY + (2 * BOOK_LEVELS + 1) * l.bookRow).toBeLessThanOrEqual(
      l.book.y + l.book.h,
    );
    expect(l.tradeRows.y + l.tradeRows.h).toBeLessThanOrEqual(l.trades.y + l.trades.h);
    expect(l.tradeRows.h / l.tradeRow).toBeGreaterThanOrEqual(8);
  });

  it("drops the side columns on narrow frames", () => {
    const l = createFocusLayout();
    focusLayout(1080, 1920, 1920 / 1080, l);
    expect(l.book.w).toBe(0);
    expect(l.watch.w).toBe(0);
    expect(l.chart.w).toBeGreaterThan(0);
  });
});
