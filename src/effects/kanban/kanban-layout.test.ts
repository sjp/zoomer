import { describe, expect, it } from "vitest";
import { boardLayout, cardHeight, columnsShown, isInner } from "./kanban-layout";

describe("kanban layout", () => {
  it.each([
    [1920, 1080, 4],
    [3840, 2160, 4],
    [1440, 1080, 4],
    [1080, 1080, 4],
    [900, 1080, 3],
    [607, 1080, 3],
  ])("shows a four-column set at %i x %i as %i columns", (w, h, n) => {
    expect(columnsShown(w, h / 1080, 4)).toBe(n);
  });

  it("always shows a three-column set as three", () => {
    expect(columnsShown(3840, 2, 3)).toBe(3);
  });

  it.each([
    [1920, 1080, 4],
    [1920, 1080, 3],
    [607, 1080, 4],
    [3840, 2160, 4],
  ])("spreads the columns across %i x %i (%i names), inside the frame", (w, h, names) => {
    const L = boardLayout(w, h, h / 1080, names);
    expect(L.colX[0]).toBeGreaterThan(0);
    expect(L.colX[L.columns - 1] + L.colW).toBeLessThan(w);
    for (let c = 1; c < L.columns; c++) {
      expect(L.colX[c]).toBeGreaterThanOrEqual(L.colX[c - 1] + L.colW);
    }
    // The speaker covers the middle: the gap between the inner columns (or the middle column) is central.
    const mid = L.columns === 4 ? (L.colX[1] + L.colW + L.colX[2]) / 2 : L.colX[1] + L.colW / 2;
    expect(Math.abs(mid - w / 2)).toBeLessThan(2);
  });

  it("keeps the inner columns short and the outer ones full height", () => {
    const L = boardLayout(1920, 1080, 1, 4);
    expect(isInner(4, 0)).toBe(false);
    expect(isInner(4, 1)).toBe(true);
    expect(isInner(4, 3)).toBe(false);
    expect(L.capBottom[1]).toBeLessThan(L.capBottom[0]);
    expect(L.capBottom[1]).toBeLessThan(L.height * 0.65);
    expect(L.capBottom[0]).toBeLessThanOrEqual(L.panelBottom);
  });

  it("scales cards with the frame and shrinks them in narrow columns", () => {
    const hd = boardLayout(1920, 1080, 1, 4);
    const uhd = boardLayout(3840, 2160, 2, 4);
    expect(cardHeight(uhd, 1)).toBe(2 * cardHeight(hd, 1));
    expect(cardHeight(hd, 2)).toBeGreaterThan(cardHeight(hd, 1));
    const narrow = boardLayout(607, 1080, 1, 4);
    expect(narrow.k).toBeLessThan(1);
    expect(narrow.cardW).toBeLessThan(hd.cardW);
  });

  it.each([
    [1, 1],
    [60, 1080],
    [1920, 60],
  ])("stays finite at %i x %i", (w, h) => {
    const L = boardLayout(w, h, h / 1080, 4);
    for (const v of [...L.colX, ...L.capBottom, L.cardW, L.k, cardHeight(L, 2)]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });
});
