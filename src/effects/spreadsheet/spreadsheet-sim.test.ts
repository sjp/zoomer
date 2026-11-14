import { describe, expect, it } from "vitest";
import { tweenPeakPxPerFrame } from "../charts";
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { cellRect, createLayout, inMiddleThird, rect, sheetLayout } from "./spreadsheet-layout";
import {
  cellCol,
  cellFormula,
  cellTable,
  columnName,
  createSheet,
  EDITS_PER_SHEET,
  extentNow,
  formatMoney,
  formatRatio,
  formulaBarText,
  OP_DIFF,
  OP_IN,
  OP_SHARE,
  OP_SUM,
  PHASE_TYPE,
  reshapeSheet,
  type Sheet,
  stepSheet,
  type Table,
  valueAt,
} from "./spreadsheet-sim";

const layoutAt = (w: number, h: number, zoom: number) =>
  sheetLayout(w, h, h / 1080, zoom, createLayout());

/** Steps `s` for `seconds` at 30 fps, calling `check` after every frame. */
function run(s: Sheet, seconds: number, pace: number, check: () => void) {
  const frames = Math.round(seconds * 30);
  for (let i = 0; i < frames; i++) {
    stepSheet(s, 1 / 30, pace);
    check();
  }
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/** Every total or formula of `t` that doesn't match its inputs, as "row,col". */
function inconsistencies(t: Table): string[] {
  const out: string[] = [];
  for (let c = 0; c < t.cols; c++) {
    const spec = t.specs[c];
    let sum = 0;
    for (let r = 0; r < t.items; r++) {
      const v = valueAt(t, r, c);
      sum += v;
      let want = v;
      if (spec.op === OP_SUM) {
        want = 0;
        for (let k = spec.a; k <= spec.b; k++) {
          want += valueAt(t, r, k);
        }
      } else if (spec.op === OP_DIFF) {
        want = valueAt(t, r, spec.b) - valueAt(t, r, spec.a);
      }
      if (!near(v, want)) {
        out.push(`${String(r)},${String(c)}`);
      }
    }
    const additive = spec.op === OP_IN || spec.op === OP_SUM || spec.op === OP_DIFF;
    const want = additive ? sum : spec.op === OP_SHARE ? 1 : valueAt(t, t.items, c);
    if (!near(valueAt(t, t.items, c), want)) {
      out.push(`total,${String(c)}`);
    }
  }
  return out;
}

describe("sheet model", () => {
  it.each([0, 1, 2])(
    "keeps totals equal to the sum of their inputs after every edit, tab %d",
    (tab) => {
      const L = layoutAt(1920, 1080, 1);
      const s = createSheet(7, tab, 0, L);
      expect(s.tables.length).toBe(2);
      const problems: string[] = [];
      run(s, 240, 2, () => {
        for (const t of s.tables) {
          problems.push(...inconsistencies(t));
        }
      });
      expect(problems).toEqual([]);
      expect(s.version).toBeGreaterThan(20);
    },
  );

  it("keeps the figures a new layout shares with the old one", () => {
    const s = createSheet(3, 1, 0, layoutAt(1920, 1080, 1));
    run(s, 60, 2, () => {});
    const smaller = reshapeSheet(s, layoutAt(1920, 1080, 1.4));
    for (let i = 0; i < smaller.tables.length; i++) {
      const a = s.tables[i];
      const b = smaller.tables[i];
      expect(b.labels).toEqual(a.labels.slice(0, b.items));
      const inputs = (t: Table) =>
        Array.from({ length: b.items }, (_, r) =>
          b.specs.map((spec, c) => (spec.op === OP_IN ? valueAt(t, r, c) : 0)),
        );
      expect(inputs(b)).toEqual(inputs(a));
      expect(inconsistencies(b)).toEqual([]);
    }
  });

  it("writes formulas with real cell references", () => {
    const s = createSheet(1, 1, 0, layoutAt(1920, 1080, 1));
    const t = s.tables[0];
    // Budget, Actual, Variance, Var % in B to E; item rows from row 2.
    expect(cellFormula(t, 0, 2)).toBe("=C2-B2");
    expect(cellFormula(t, 0, 3)).toBe("=D2/B2");
    expect(cellFormula(t, t.items, 0)).toBe(`=SUM(B2:B${String(t.items + 1)})`);
    expect(cellFormula(t, 0, 0)).toBe(String(Math.round(valueAt(t, 0, 0))));
    const right = s.tables[1];
    const share = cellFormula(right, 0, 1);
    const col = columnName(right.col0 + 1);
    expect(share).toBe(`=${col}2/${col}$${String(right.items + 2)}`);
    expect(formulaBarText(s, 0, 0)).toBe("Item");
    expect(formulaBarText(s, t.items + 1, 0)).toBe("Total");
  });

  it("formats figures like a spreadsheet", () => {
    expect(formatMoney(12340)).toBe("$12,340");
    expect(formatMoney(-1230)).toBe("-$1,230");
    expect(formatMoney(-0.2)).toBe("$0");
    expect(formatRatio(0.1234)).toBe("12.3%");
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
  });
});

describe("edit scheduler", () => {
  it("is deterministic per seed", () => {
    const L = layoutAt(1920, 1080, 1);
    const trace = (seed: number) => {
      const s = createSheet(seed, 0, 0, L);
      const out: number[] = [];
      run(s, 120, 3, () => {
        out.push(s.editor.row, s.editor.col, s.editor.phase, s.editor.chars);
      });
      return { out, values: Array.from(s.tables[0].values) };
    };
    expect(trace(5)).toEqual(trace(5));
    expect(trace(5).out).not.toEqual(trace(6).out);
  });

  it.each([
    [1920, 1080, 0.8],
    [1920, 1080, 1],
    [1920, 1080, 1.6],
    [1280, 720, 1.25],
    [3840, 2160, 1],
    [1440, 1080, 1.6],
    [2560, 1080, 1],
    [1080, 1920, 1],
  ])("never selects a cell outside the visible grid at %d x %d, zoom %d", (w, h, zoom) => {
    const L = layoutAt(w, h, zoom);
    for (const seed of [1, 2]) {
      const s = createSheet(seed, seed, 0, L);
      const e = s.editor;
      run(s, 300, 2, () => {
        for (const [row, col] of [
          [e.row, e.col],
          [e.fromRow, e.fromCol],
        ]) {
          expect(row).toBeGreaterThanOrEqual(1);
          expect(row).toBeLessThan(L.fullRows);
          expect(col).toBeGreaterThanOrEqual(1);
          expect(col).toBeLessThan(L.fullCols);
        }
        // A fill's selection stretches down from the selected cell.
        expect(e.row + extentNow(e)).toBeLessThan(L.fullRows);
      });
      expect(e.edits).toBeGreaterThan(10);
    }
  });

  it.each([
    [1920, 1080, 0.8],
    [1920, 1080, 1],
    [1920, 1080, 1.6],
    [2560, 1080, 1.2],
    [1280, 720, 1],
  ])("keeps edits out of the middle third at %d x %d, zoom %d", (w, h, zoom) => {
    const L = layoutAt(w, h, zoom);
    expect(L.sparseMiddle).toBe(true);
    const s = createSheet(4, 0, 0, L);
    const e = s.editor;
    run(s, 300, 2, () => {
      expect(inMiddleThird(L, e.col)).toBe(false);
      expect(inMiddleThird(L, e.fromCol)).toBe(false);
      for (let i = 0; i < s.changeCount; i++) {
        const t = s.tables[cellTable(s.changes[i])];
        expect(inMiddleThird(L, t.col0 + 1 + cellCol(s.changes[i]))).toBe(false);
      }
      s.changeCount = 0;
    });
  });

  it("never shows more typed characters than the value has", () => {
    const s = createSheet(9, 2, 0, layoutAt(1920, 1080, 1));
    let typed = 0;
    let over = 0;
    let mismatched = 0;
    run(s, 200, 2, () => {
      const e = s.editor;
      over += e.chars > e.text.length ? 1 : 0;
      typed += e.phase === PHASE_TYPE ? 1 : 0;
      mismatched += e.phase === PHASE_TYPE && e.text !== String(e.pending) ? 1 : 0;
    });
    expect(typed).toBeGreaterThan(0);
    expect(over).toBe(0);
    expect(mismatched).toBe(0);
  });

  it.each([0.8, 1, 1.6])(
    "walks the selection within the codec motion limits at zoom %d",
    (zoom) => {
      const L = layoutAt(1920, 1080, zoom);
      const s = createSheet(2, 0, 0, L);
      const e = s.editor;
      const a = rect();
      const b = rect();
      let peak = 0;
      run(s, 200, 2, () => {
        cellRect(L, e.fromRow, e.fromCol, a);
        cellRect(L, e.row, e.col, b);
        const ref = Math.hypot(b.x - a.x, b.y - a.y) / L.scale;
        const moving = e.stepT < 1 && !e.jump;
        peak = Math.max(peak, moving ? tweenPeakPxPerFrame(ref, e.stepSeconds) : 0);
      });
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThanOrEqual(MAX_FEATURE_PX_PER_FRAME);
    },
  );

  it("reports the sheet done after its edits, and stops there", () => {
    const s = createSheet(1, 0, 0, layoutAt(1920, 1080, 1));
    run(s, EDITS_PER_SHEET * 8, 2, () => {});
    expect(s.editor.done).toBe(true);
    expect(s.editor.edits).toBe(EDITS_PER_SHEET);
  });

  it("idles on a frame too small for a table", () => {
    const s = createSheet(1, 0, 0, layoutAt(1, 1, 1));
    expect(s.tables.length).toBe(0);
    run(s, 10, 2, () => {});
    expect(s.version).toBe(0);
  });
});
