import { describe, expect, it } from "vitest";
import { createLayout, dashboardLayout, linePlot, type Rect, rect } from "./dashboard-layout";

const SIZES = [
  ["16:9", 1920, 1080],
  ["4:3", 1440, 1080],
  ["21:9", 2560, 1080],
  ["4K", 3840, 2160],
] as const;

const inside = (r: Rect, w: number, h: number) => {
  expect(r.x).toBeGreaterThanOrEqual(0);
  expect(r.y).toBeGreaterThanOrEqual(0);
  expect(r.x + r.w).toBeLessThanOrEqual(w);
  expect(r.y + r.h).toBeLessThanOrEqual(h);
};
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("dashboard layout", () => {
  it.each(SIZES)(
    "keeps the line plot's top and height through a density move at %s",
    (_name, w, h) => {
      // The value labels are painted once at the Full plot's height and placed on
      // the moving plot, so both densities' plots must agree vertically.
      const s = h / 1080;
      const L = dashboardLayout(w, h, s, createLayout());
      expect(L.lineSimple.y).toBe(L.lineFull.y);
      expect(L.lineSimple.h).toBe(L.lineFull.h);
      const simple = linePlot(L.lineSimple, s, rect());
      const full = linePlot(L.lineFull, s, rect());
      expect([simple.y, simple.h]).toEqual([full.y, full.h]);
    },
  );

  it.each(SIZES)("fits every Full card at %s without overlaps", (_name, w, h) => {
    const s = h / 1080;
    const L = dashboardLayout(w, h, s, createLayout());
    const cards = [L.title, ...L.kpis, L.lineFull, L.bars, L.donut, L.table];
    cards.forEach((r, i) => {
      inside(r, w, h);
      expect(r.w).toBeGreaterThan(0);
      expect(r.h).toBeGreaterThan(0);
      for (const o of cards.slice(0, i)) {
        expect(overlaps(r, o)).toBe(false);
      }
    });
    // The side columns are wide enough for a chart and a table.
    expect(L.bars.w / s).toBeGreaterThan(330);
    expect(L.table.w / s).toBeGreaterThan(330);
    expect(L.bars.h / s).toBeGreaterThan(250);
    expect(L.donut.h / s).toBeGreaterThan(200);
  });

  it.each(SIZES)("fits the Simple cards at %s without overlaps", (_name, w, h) => {
    const L = dashboardLayout(w, h, h / 1080, createLayout());
    const cards = [L.title, ...L.kpis, L.lineSimple];
    cards.forEach((r, i) => {
      inside(r, w, h);
      for (const o of cards.slice(0, i)) {
        expect(overlaps(r, o)).toBe(false);
      }
    });
  });

  it.each(SIZES)(
    "leaves the middle third to the line chart's plot below the top row at %s",
    (_name, w, h) => {
      const s = h / 1080;
      const L = dashboardLayout(w, h, s, createLayout());
      const card = L.lineFull;
      const plot = linePlot(card, s, rect());
      // The plot covers the middle third...
      expect(plot.x).toBeLessThanOrEqual(Math.ceil(w / 3));
      expect(plot.x + plot.w).toBeGreaterThanOrEqual(Math.floor((2 * w) / 3));
      // ...and nothing dense reaches into the middle third at the plot's height.
      const zone: Rect = {
        x: Math.ceil(w / 3),
        y: plot.y,
        w: Math.floor((2 * w) / 3) - Math.ceil(w / 3),
        h: plot.h,
      };
      const header: Rect = { x: card.x, y: card.y, w: card.w, h: plot.y - card.y };
      const valueLabels: Rect = { x: card.x, y: card.y, w: plot.x - card.x, h: card.h };
      for (const r of [L.title, ...L.kpis, L.bars, L.donut, L.table, header, valueLabels]) {
        expect(overlaps(r, zone)).toBe(false);
      }
      // The KPIs sit along the top, above the zone.
      for (const k of L.kpis) {
        expect(k.y + k.h).toBeLessThanOrEqual(zone.y);
      }
    },
  );

  it.each([
    [60, 1080],
    [1920, 60],
    [1, 1],
    [1080, 1920],
  ])("never gives a negative size at %d x %d", (w, h) => {
    const L = dashboardLayout(w, h, h / 1080, createLayout());
    for (const r of [L.title, ...L.kpis, L.lineFull, L.lineSimple, L.bars, L.donut, L.table]) {
      expect(r.w).toBeGreaterThanOrEqual(0);
      expect(r.h).toBeGreaterThanOrEqual(0);
      const p = linePlot(r, h / 1080, rect());
      expect(p.w).toBeGreaterThanOrEqual(0);
      expect(p.h).toBeGreaterThanOrEqual(0);
    }
  });
});
