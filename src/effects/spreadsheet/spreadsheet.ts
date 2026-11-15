import { SANS_FONT_STACK } from "../canvas-texture";
import {
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  coverTicks,
  createAxisRange,
  createChartRenderer,
  createTicks,
  formatTickCompact,
  minTweenSeconds,
  niceTicks,
  pushArea,
  pushPolyline,
  pushRect,
  pushRoundRect,
  rangeShiftPx,
  stepAxis,
  tickAt,
  tweenAxis,
  valueY,
} from "../charts";
import { createColorEase, hexToUnitRgb, unitRgbMemo } from "../color";
import { createFadeThrough } from "../fade";
import { beginFrame, withScope } from "../gl";
import { approach, clamp, smoothstep } from "../math";
import { createTextLayer, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import {
  cellRect,
  createLayout,
  MAX_ITEMS,
  MAX_REGIONS,
  type Rect,
  rect,
  sheetLayout,
} from "./spreadsheet-layout";
import {
  cellAddress,
  cellCol,
  cellHighlight,
  cellNegative,
  cellRow,
  cellTable,
  cellText,
  columnName,
  createSheet,
  extentNow,
  formulaBarText,
  HIGHLIGHT_GOOD,
  HIGHLIGHT_NONE,
  PHASE_IDLE,
  PHASE_TYPE,
  reshapeSheet,
  type Sheet,
  stepSheet,
  TAB_NAMES,
  type Table,
  valueAt,
} from "./spreadsheet-sim";
import { MAX_PACE, MAX_ZOOM, MIN_PACE, MIN_ZOOM, spreadsheetMeta } from "./spreadsheet.meta";

/** Seconds for theme and accent changes, the active tab, and the chart showing or hiding. */
const COLOR_EASE = 1.2;
const TAB_EASE = 1;
const CHART_FADE = 1;
/** Seconds for each half of a sheet change (fade out, then in). */
const SWAP_HALF = 0.5;
/** Seconds for chart bars and points to reach new values. */
const VALUE_EASE = 1;
/** Changed-cell tint: peak opacity, ramp in and total seconds. */
const TINT_PEAK = 0.3;
const TINT_RAMP = 0.15;
const TINT_SECONDS = 1.2;
/** Chart vertices, and text regions a frame. */
const MESH_CAPACITY = 40000;
const MAX_QUADS = 32;
/** Toolbar blocks drawn at most. */
const MAX_ICONS = 32;
/** Tint ages per table: rows (items and totals) times number columns. */
const TINT_COLS = 4;
const TINT_STRIDE = (Math.max(MAX_ITEMS, MAX_REGIONS) + 1) * TINT_COLS;
/** Reference sizes: sheet tabs, the chart's padding, title band, value-label column and category labels. */
const TAB_W = 112;
const TAB_GAP = 4;
const CHART_PAD = 14;
const CHART_HEAD = 44;
const CHART_AXIS_W = 46;
const CHART_X_LABELS = 28;

/** Palette slots: one RGB triple each. */
const BG = 0;
const CHROME = 1;
const HEAD = 2;
const GRID = 3;
const ICON = 4;
const TEXT = 5;
const MUTED = 6;
const NEG = 7;
const BORDER = 8;
const SHADOW = 9;
const ACCENT = 10;
const COLORS = 11;

/** Theme colours for every slot but the accent, which comes from its param. */
const THEMES: Record<string, Float32Array> = {};
for (const [name, hexes] of Object.entries({
  light: [
    "#ffffff",
    "#f3f4f6",
    "#eef0f3",
    "#e1e4e8",
    "#cdd2d9",
    "#1f2328",
    "#6b7280",
    "#c62828",
    "#c9ced6",
    "#000000",
  ],
  dark: [
    "#1d2025",
    "#15171b",
    "#262a30",
    "#30353c",
    "#3d434c",
    "#e4e6ea",
    "#959ca6",
    "#ef6b6b",
    "#3a4049",
    "#000000",
  ],
})) {
  const out = new Float32Array(COLORS * 3);
  hexes.forEach((hex, i) => {
    out.set(hexToUnitRgb(hex), i * 3);
  });
  THEMES[name] = out;
}

/** Fonts at one scale and zoom, built on relayout. */
interface Fonts {
  cell: string;
  cellBold: string;
  head: string;
  address: string;
  formula: string;
  tab: string;
  chartTitle: string;
  axis: string;
}

function makeFonts(s: number, z: number): Fonts {
  const px = (n: number) => String(Math.max(4, Math.round(n))) + "px " + SANS_FONT_STACK;
  return {
    cell: "400 " + px(14 * s * z),
    cellBold: "600 " + px(14 * s * z),
    head: "400 " + px(12 * s * z),
    address: "500 " + px(14 * s),
    formula: "400 " + px(15 * s),
    tab: "500 " + px(14 * s),
    chartTitle: "600 " + px(14 * s),
    axis: "400 " + px(12 * s),
  };
}

/** Changed-cell tint opacity `age` seconds after the change. */
const tintAlpha = (age: number): number =>
  TINT_PEAK * smoothstep(0, TINT_RAMP, age) * (1 - smoothstep(TINT_RAMP, TINT_SECONDS, age));

/**
 * A spreadsheet being filled in: toolbar, formula bar, a grid with column letters
 * and row numbers, two small tables in the outer thirds, a floating chart, and
 * sheet tabs along the bottom. Every fill, gridline, selection and chart mark is
 * a triangle in one chart mesh rebuilt each frame (a few thousand vertices); all
 * text sits on one device-pixel canvas (`text-layer.ts`) that redraws only the
 * cells an edit changed, coloured by role so theme and accent changes ease on the
 * GPU. Motion is stepped and eased: the selection walking a cell at a time, a
 * figure typed a character at a time, a tint fading behind recalculated cells,
 * bars easing, and whole sheets fading through on a tab change.
 */
export const spreadsheet = defineEffect(spreadsheetMeta, {
  create(gl) {
    return withScope((scope) => {
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const mesh = chart.mesh;
      const text = createTextLayer(gl, scope, MAX_QUADS);
      const ease = createColorEase(COLORS * 3);
      const target = new Float32Array(COLORS * 3);
      const accentRgb = unitRgbMemo();
      const col: Float32Array[] = [];
      for (let i = 0; i < COLORS; i++) {
        col.push(ease.value.subarray(i * 3, i * 3 + 3));
      }
      const C = (i: number) => col[i];
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);

      const L = createLayout();
      const cell = rect();
      const from = rect();
      const sel = rect();
      const plot = rect();
      const range = createAxisRange();
      const ticks = createTicks();
      // The chart's bar heights (region values) ease like colours do: a block of floats
      // crossfading to a new target. Float32 is plenty for a bar a few hundred px tall.
      const valueEase = createColorEase(MAX_REGIONS);
      const valueTarget = new Float64Array(MAX_REGIONS);
      const tintAge = new Float32Array(2 * TINT_STRIDE).fill(99);
      const tabLevel = new Float32Array(TAB_NAMES.length);
      const iconX = new Float32Array(MAX_ICONS);
      const xs = new Float32Array(MAX_REGIONS);
      const ys = new Float32Array(MAX_REGIONS);

      let width = 1;
      let height = 1;
      let scale = 1;
      let zoom = 1;
      let fonts = makeFonts(1, 1);
      let iconCount = 0;
      let sheet: Sheet | null = null;
      let painted = false;
      let paintedHi = 0;
      /** Sheet change: 1 fading out, 2 fading in; whether the grid fades too (a zoom change). */
      const swap = createFadeThrough(SWAP_HALF);
      let swapGrid = false;
      let chartLevel = 1;
      let lineLevel = 0;
      /** The formula bar as last painted, and the cell last painted while typing. */
      let fRow = -1;
      let fCol = -1;
      let fChars = -1;
      let fVersion = -1;
      let fExt = -1;
      let typedChars = -1;

      // ---- Text painters (they run on an edit or a change, never every frame).

      const fill = (
        t: string,
        x: number,
        y: number,
        role: string,
        align: CanvasTextAlign,
        font: string,
        maxWidth: number,
      ) => {
        const ctx = text.ctx;
        if (!ctx || !(maxWidth > 0)) {
          return;
        }
        ctx.font = font;
        ctx.fillStyle = role;
        ctx.textAlign = align;
        ctx.textBaseline = "middle";
        ctx.fillText(t, Math.round(x), Math.round(y), maxWidth);
      };
      const S = (n: number) => Math.round(n * scale);
      /** Cell text padding. */
      const padX = () => Math.max(2, Math.round(6 * scale * zoom));

      const paintFormula = (s: Sheet) => {
        const e = s.editor;
        const f = L.formula;
        text.clear(0, f.y, width, f.h);
        fRow = e.row;
        fCol = e.col;
        fChars = e.phase === PHASE_TYPE ? e.chars : -1;
        fVersion = s.version;
        fExt = e.ext;
        if (e.phase === PHASE_IDLE) {
          return;
        }
        const a = L.address;
        const address =
          e.ext > 0
            ? cellAddress(e.row, e.col) + ":" + cellAddress(e.row + e.ext, e.col)
            : cellAddress(e.row, e.col);
        fill(
          address,
          a.x + a.w / 2,
          a.y + a.h / 2,
          TEXT_ROLES.primary,
          "center",
          fonts.address,
          a.w - S(8),
        );
        const content =
          e.phase === PHASE_TYPE ? e.text.slice(0, e.chars) : formulaBarText(s, e.row, e.col);
        fill(
          content,
          L.formulaTextX,
          f.y + f.h / 2,
          TEXT_ROLES.primary,
          "left",
          fonts.formula,
          width - L.formulaTextX - S(14),
        );
      };

      const paintHeaders = () => {
        text.clear(0, L.headTop, width, L.headH);
        text.clear(0, L.cellsTop, L.gutterW, L.cellsBottom - L.cellsTop);
        const y = L.headTop + L.headH / 2;
        for (let c = 0; c < L.colCount; c++) {
          const x0 = L.colX[c];
          const w = L.colX[c + 1] - x0;
          fill(columnName(c), x0 + w / 2, y, TEXT_ROLES.muted, "center", fonts.head, w - 2);
        }
        for (let r = 0; r < L.rowCount; r++) {
          fill(
            String(r + 1),
            L.gutterW / 2,
            L.cellsTop + (r + 0.5) * L.rowH,
            TEXT_ROLES.muted,
            "center",
            fonts.head,
            L.gutterW - 2,
          );
        }
      };

      /** Paints item row `r` (the totals at `t.items`, -1 for the header) and column `c` (-1 for the label) of table `ti`. */
      const paintCell = (s: Sheet, ti: number, r: number, c: number) => {
        const t = s.tables[ti];
        cellRect(L, r + 1, t.col0 + 1 + c, cell);
        text.clear(cell.x, cell.y, cell.w, cell.h);
        const e = s.editor;
        const p = padX();
        const y = cell.y + cell.h / 2;
        const maxW = cell.w - 2 * p;
        if (
          e.phase === PHASE_TYPE &&
          e.table === ti &&
          e.row === r + 1 &&
          e.col === t.col0 + 1 + c
        ) {
          fill(
            e.text.slice(0, e.chars),
            cell.x + p,
            y,
            TEXT_ROLES.primary,
            "left",
            fonts.cell,
            maxW,
          );
          return;
        }
        const bold = r < 0 || r === t.items;
        const font = bold ? fonts.cellBold : fonts.cell;
        if (c < 0) {
          const label = r < 0 ? t.title : r === t.items ? "Total" : t.labels[r];
          fill(label, cell.x + p, y, TEXT_ROLES.primary, "left", font, maxW);
        } else if (r < 0) {
          fill(t.specs[c].header, cell.x + cell.w - p, y, TEXT_ROLES.primary, "right", font, maxW);
        } else {
          fill(
            cellText(t, r, c),
            cell.x + cell.w - p,
            y,
            cellNegative(t, r, c) ? TEXT_ROLES.down : TEXT_ROLES.primary,
            "right",
            font,
            maxW,
          );
        }
      };

      const paintSheet = (s: Sheet) => {
        text.clear(L.gutterW, L.cellsTop, width - L.gutterW, L.cellsBottom - L.cellsTop);
        for (let ti = 0; ti < s.tables.length; ti++) {
          const t = s.tables[ti];
          for (let r = -1; r <= t.items; r++) {
            for (let c = -1; c < t.cols; c++) {
              paintCell(s, ti, r, c);
            }
          }
        }
      };

      /** Tab `i`'s rect in the strip. */
      const tabRect = (i: number, out: Rect) => {
        const t = L.tabs;
        out.x = L.gutterW + S(10) + i * (S(TAB_W) + S(TAB_GAP));
        out.y = t.y;
        out.w = S(TAB_W);
        out.h = Math.max(0, t.h - S(6));
        return out;
      };

      /** Tab labels, muted in place and in the accent in a band below the frame. */
      const paintTabs = () => {
        text.clear(0, L.tabs.y, width, L.tabs.h);
        text.clear(0, height, width, L.tabs.h);
        for (let i = 0; i < TAB_NAMES.length; i++) {
          tabRect(i, cell);
          const x = cell.x + cell.w / 2;
          const y = cell.y + cell.h / 2;
          fill(TAB_NAMES[i], x, y, TEXT_ROLES.muted, "center", fonts.tab, cell.w - S(12));
          fill(
            TAB_NAMES[i],
            x,
            y - L.tabs.y + height,
            TEXT_ROLES.up,
            "center",
            fonts.tab,
            cell.w - S(12),
          );
        }
      };

      /** The chart's plot inside its card. */
      const placePlot = () => {
        const c = L.chart;
        plot.x = c.x + S(CHART_PAD + CHART_AXIS_W);
        plot.y = c.y + S(CHART_HEAD);
        plot.w = Math.max(0, c.x + c.w - S(CHART_PAD) - plot.x);
        plot.h = Math.max(0, c.y + c.h - S(CHART_X_LABELS + CHART_PAD / 2) - plot.y);
      };

      const chartTable = (s: Sheet): Table | null =>
        s.chartTable >= 0 ? s.tables[s.chartTable] : null;

      const paintChartAxis = () => {
        const c = L.chart;
        if (plot.w <= 0 || plot.h <= 0 || !range.ready) {
          return;
        }
        const x = c.x + S(CHART_PAD);
        text.clear(x, plot.y - S(10), plot.x - x, plot.h + S(20));
        niceTicks(0, range.hi, 4, ticks);
        const maxAbs = Math.abs(tickAt(ticks, ticks.count - 1));
        for (let i = 0; i < ticks.count; i++) {
          const v = tickAt(ticks, i);
          const y = valueY(v, range, plot.y, plot.y + plot.h);
          if (y >= plot.y - 1 && y <= plot.y + plot.h + 1) {
            fill(
              "$" + formatTickCompact(v, ticks.step, maxAbs),
              plot.x - S(8),
              y,
              TEXT_ROLES.muted,
              "right",
              fonts.axis,
              plot.x - x - S(8),
            );
          }
        }
        paintedHi = range.hi;
      };

      const paintChart = (s: Sheet) => {
        const c = L.chart;
        const t = chartTable(s);
        if (c.w <= 0 || c.h <= 0 || !t) {
          return;
        }
        text.clear(c.x, c.y, c.w, c.h);
        fill(
          t.specs[s.chartCol].header + " by region",
          c.x + S(CHART_PAD),
          c.y + S(22),
          TEXT_ROLES.primary,
          "left",
          fonts.chartTitle,
          c.w - 2 * S(CHART_PAD),
        );
        const slot = plot.w / t.items;
        for (let i = 0; i < t.items; i++) {
          fill(
            t.labels[i],
            plot.x + (i + 0.5) * slot,
            plot.y + plot.h + S(15),
            TEXT_ROLES.muted,
            "center",
            fonts.axis,
            slot - S(4),
          );
        }
        paintChartAxis();
      };

      /** Sizes the canvas and paints everything. */
      const paintAll = (s: Sheet) => {
        if (!text.resize(width, height + L.tabs.h)) {
          return;
        }
        text.clear(0, 0, text.width, text.height);
        paintFormula(s);
        paintHeaders();
        paintSheet(s);
        paintTabs();
        paintChart(s);
        typedChars = -1;
        painted = true;
      };

      // ---- Data.

      const setTargets = (s: Sheet) => {
        const t = chartTable(s);
        valueTarget.fill(0);
        let max = 0;
        if (t) {
          for (let i = 0; i < t.items; i++) {
            valueTarget[i] = valueAt(t, i, s.chartCol);
            max = Math.max(max, valueTarget[i]);
          }
        }
        if (!(max > 0)) {
          return 1;
        }
        coverTicks(0, max * 1.05, ticks);
        return tickAt(ticks, ticks.count - 1);
      };

      /** Shows `s` as it is now, without easing. */
      const adopt = (s: Sheet) => {
        sheet = s;
        valueEase.snap();
        tweenAxis(range, 0, setTargets(s), 0);
        range.ready = true;
        tintAge.fill(99);
        painted = false;
      };

      const relayout = () => {
        sheetLayout(width, height, scale, zoom, L);
        fonts = makeFonts(scale, zoom);
        placePlot();
        // Toolbar blocks in a few groups along the left.
        const size = S(20);
        const gap = S(8);
        let x = S(14);
        iconCount = 0;
        const groups = [3, 4, 3, 5, 2, 3];
        for (const g of groups) {
          for (let i = 0; i < g && iconCount < MAX_ICONS; i++) {
            if (x + size > width * 0.55) {
              break;
            }
            iconX[iconCount++] = x;
            x += size + gap;
          }
          x += S(18);
        }
        painted = false;
      };

      // ---- Geometry (per frame).

      /** The selection rect this frame, into `sel`; returns its opacity. */
      const placeSelection = (s: Sheet): number => {
        const e = s.editor;
        if (e.phase === PHASE_IDLE) {
          return 0;
        }
        cellRect(L, e.row, e.col, cell);
        cellRect(L, e.fromRow, e.fromCol, from);
        let a = 1;
        if (e.jump) {
          if (e.stepT < 0.5) {
            Object.assign(sel, from);
            a = 1 - smoothstep(0, 0.5, e.stepT);
          } else {
            Object.assign(sel, cell);
            a = smoothstep(0.5, 1, e.stepT);
          }
        } else {
          const f = smoothstep(0, 1, e.stepT);
          sel.x = from.x + (cell.x - from.x) * f;
          sel.y = from.y + (cell.y - from.y) * f;
          sel.w = from.w + (cell.w - from.w) * f;
          sel.h = from.h;
        }
        sel.h += extentNow(e) * L.rowH;
        return a;
      };

      const drawChrome = () => {
        const t = L.toolbar;
        pushRect(mesh, 0, t.y, width, t.y + t.h, C(CHROME), 1);
        const size = S(20);
        const iy = t.y + (t.h - size) / 2;
        for (let i = 0; i < iconCount; i++) {
          pushRoundRect(mesh, iconX[i], iy, iconX[i] + size, iy + size, S(4), C(ICON), 1);
        }
        if (width > S(600)) {
          pushRoundRect(mesh, width - S(250), iy, width - S(14), iy + size, S(10), C(ICON), 0.6);
        }
        const one = Math.max(1, S(1));
        pushRect(mesh, 0, t.y + t.h - one, width, t.y + t.h, C(BORDER), 1);
        const f = L.formula;
        pushRect(mesh, 0, f.y + f.h - one, width, f.y + f.h, C(BORDER), 1);
        const a = L.address;
        pushRect(mesh, a.x, a.y, a.x + a.w, a.y + a.h, C(BORDER), 1);
        pushRect(mesh, a.x + one, a.y + one, a.x + a.w - one, a.y + a.h - one, C(BG), 1);
        const dx = L.formulaTextX - S(9);
        pushRect(mesh, dx, a.y + S(3), dx + one, a.y + a.h - S(3), C(ICON), 1);
      };

      const drawGrid = (s: Sheet, ga: number, ca: number, selA: number) => {
        const one = Math.max(1, S(1));
        // Header band, gutter and the frozen header row.
        pushRect(mesh, 0, L.headTop, width, L.cellsTop, C(HEAD), ga);
        pushRect(mesh, 0, L.cellsTop, L.gutterW, L.cellsBottom, C(HEAD), ga);
        pushRect(mesh, L.gutterW, L.cellsTop, width, L.cellsTop + L.rowH, C(HEAD), 0.6 * ga);
        // The selection's column and row light up in the headers.
        const ha = selA * ca;
        if (ha > 0) {
          pushRect(mesh, sel.x, L.headTop, sel.x + sel.w, L.cellsTop, C(ACCENT), 0.18 * ha);
          pushRect(mesh, sel.x, L.cellsTop - S(2), sel.x + sel.w, L.cellsTop, C(ACCENT), ha);
          pushRect(mesh, 0, sel.y, L.gutterW, sel.y + sel.h, C(ACCENT), 0.18 * ha);
          pushRect(mesh, L.gutterW - S(2), sel.y, L.gutterW, sel.y + sel.h, C(ACCENT), ha);
        }
        // Conditional fills and changed-cell tints.
        for (let ti = 0; ti < s.tables.length; ti++) {
          const t = s.tables[ti];
          for (let r = 0; r <= t.items; r++) {
            for (let c = 0; c < t.cols; c++) {
              const h = cellHighlight(t, r, c);
              const tint = tintAlpha(tintAge[ti * TINT_STRIDE + r * TINT_COLS + c]);
              if (h === HIGHLIGHT_NONE && tint <= 0) {
                continue;
              }
              cellRect(L, r + 1, t.col0 + 1 + c, cell);
              if (h !== HIGHLIGHT_NONE) {
                const k = h === HIGHLIGHT_GOOD ? ACCENT : NEG;
                pushRect(mesh, cell.x, cell.y, cell.x + cell.w, cell.y + cell.h, C(k), 0.13 * ca);
              }
              if (tint > 0) {
                pushRect(
                  mesh,
                  cell.x,
                  cell.y,
                  cell.x + cell.w,
                  cell.y + cell.h,
                  C(ACCENT),
                  tint * ca,
                );
              }
            }
          }
        }
        // Gridlines.
        const right = L.colX[L.colCount];
        for (let c = 0; c <= L.colCount; c++) {
          const x = L.colX[c];
          pushRect(mesh, x, L.headTop, x + one, L.cellsBottom, C(c === 0 ? BORDER : GRID), ga);
        }
        for (let r = 0; r <= L.rowCount; r++) {
          const y = L.cellsTop + r * L.rowH;
          if (y <= L.cellsBottom) {
            pushRect(mesh, 0, y, Math.min(width, right), y + one, C(r === 0 ? BORDER : GRID), ga);
          }
        }
        // A rule above each totals row.
        const rule = Math.max(1, Math.round(1.5 * scale * zoom));
        for (const t of s.tables) {
          const y = L.cellsTop + (t.items + 1) * L.rowH;
          pushRect(
            mesh,
            L.colX[t.col0],
            y,
            L.colX[t.col0 + t.cols + 1],
            y + rule,
            C(TEXT),
            0.55 * ca,
          );
        }
      };

      const drawSelection = (a: number) => {
        if (!(a > 0)) {
          return;
        }
        const x0 = Math.round(sel.x);
        const y0 = Math.round(sel.y);
        const x1 = Math.round(sel.x + sel.w);
        const y1 = Math.round(sel.y + sel.h);
        const b = Math.max(2, S(2));
        pushRect(mesh, x0, y0, x1, y1, C(ACCENT), 0.07 * a);
        pushRect(mesh, x0 - 1, y0 - 1, x1 + 1, y0 - 1 + b, C(ACCENT), a);
        pushRect(mesh, x0 - 1, y1 + 1 - b, x1 + 1, y1 + 1, C(ACCENT), a);
        pushRect(mesh, x0 - 1, y0 - 1, x0 - 1 + b, y1 + 1, C(ACCENT), a);
        pushRect(mesh, x1 + 1 - b, y0 - 1, x1 + 1, y1 + 1, C(ACCENT), a);
        // The fill handle: a small square on the corner, ringed in the cell colour.
        const h = Math.max(2, S(4));
        pushRect(mesh, x1 - h - 1, y1 - h - 1, x1 + h + 1, y1 + h + 1, C(BG), a);
        pushRect(mesh, x1 - h, y1 - h, x1 + h, y1 + h, C(ACCENT), a);
      };

      const drawTabs = () => {
        const t = L.tabs;
        const one = Math.max(1, S(1));
        pushRect(mesh, 0, t.y, width, t.y + t.h, C(CHROME), 1);
        pushRect(mesh, 0, t.y, width, t.y + one, C(BORDER), 1);
        // Two neutral blocks in the gutter, where sheet navigation would be.
        const size = S(12);
        const by = t.y + (t.h - size) / 2;
        if (L.gutterW > 2 * size + S(8)) {
          pushRoundRect(mesh, S(6), by, S(6) + size, by + size, S(3), C(ICON), 1);
          pushRoundRect(mesh, S(10) + size, by, S(10) + 2 * size, by + size, S(3), C(ICON), 1);
        }
        for (let i = 0; i < TAB_NAMES.length; i++) {
          const k = smoothstep(0, 1, tabLevel[i]);
          tabRect(i, cell);
          if (k > 0) {
            pushRect(mesh, cell.x, cell.y, cell.x + cell.w, cell.y + cell.h, C(BG), k);
            pushRect(
              mesh,
              cell.x,
              cell.y + cell.h - S(3),
              cell.x + cell.w,
              cell.y + cell.h,
              C(ACCENT),
              k,
            );
          }
          pushRect(
            mesh,
            cell.x + cell.w + S(1),
            cell.y + S(6),
            cell.x + cell.w + S(1) + one,
            cell.y + cell.h - S(6),
            C(ICON),
            1,
          );
        }
      };

      const drawChart = (s: Sheet, a: number) => {
        const c = L.chart;
        const t = chartTable(s);
        if (!(a > 0) || c.w <= 0 || c.h <= 0 || !t) {
          return;
        }
        // A soft shadow, a thin border, then the card.
        const r = S(6);
        pushRoundRect(
          mesh,
          c.x - S(2),
          c.y,
          c.x + c.w + S(2),
          c.y + c.h + S(6),
          r + S(2),
          C(SHADOW),
          0.05 * a,
        );
        pushRoundRect(
          mesh,
          c.x - S(1),
          c.y,
          c.x + c.w + S(1),
          c.y + c.h + S(3),
          r + S(1),
          C(SHADOW),
          0.06 * a,
        );
        pushRoundRect(mesh, c.x, c.y, c.x + c.w, c.y + c.h, r, C(BORDER), a);
        const one = Math.max(1, S(1));
        pushRoundRect(
          mesh,
          c.x + one,
          c.y + one,
          c.x + c.w - one,
          c.y + c.h - one,
          r - one,
          C(BG),
          a,
        );
        if (plot.w <= 0 || plot.h <= 0 || !range.ready) {
          return;
        }
        niceTicks(0, range.hi, 4, ticks);
        for (let i = 0; i < ticks.count; i++) {
          const gy = Math.round(valueY(tickAt(ticks, i), range, plot.y, plot.y + plot.h));
          if (gy >= plot.y && gy < plot.y + plot.h) {
            pushRect(mesh, plot.x, gy, plot.x + plot.w, gy + one, C(GRID), a);
          }
        }
        const base = plot.y + plot.h;
        const slot = plot.w / t.items;
        const bars = a * (1 - smoothstep(0, 1, lineLevel));
        const line = a * smoothstep(0, 1, lineLevel);
        const bw = Math.max(1, Math.round(slot * 0.52));
        for (let i = 0; i < t.items; i++) {
          const cx = plot.x + (i + 0.5) * slot;
          const top = clamp(valueY(valueEase.value[i], range, plot.y, base), plot.y, base);
          xs[i] = cx;
          ys[i] = top;
          if (bars > 0) {
            const x0 = Math.round(cx - bw / 2);
            pushRoundRect(
              mesh,
              x0,
              top,
              x0 + bw,
              base,
              S(3),
              C(ACCENT),
              bars,
              CORNER_TOP_LEFT | CORNER_TOP_RIGHT,
            );
          }
        }
        if (line > 0 && t.items >= 2) {
          pushArea(mesh, xs, ys, 0, t.items, base, C(ACCENT), 0.12 * line, 0);
          pushPolyline(mesh, xs, ys, 0, t.items, 2 * scale, C(ACCENT), line);
          for (let i = 0; i < t.items; i++) {
            const x = Math.round(xs[i]);
            const y = Math.round(ys[i]);
            pushRoundRect(mesh, x - S(5), y - S(5), x + S(5), y + S(5), S(5), C(BG), line);
            pushRoundRect(
              mesh,
              x - S(3.5),
              y - S(3.5),
              x + S(3.5),
              y + S(3.5),
              S(3.5),
              C(ACCENT),
              line,
            );
          }
        }
        pushRect(mesh, plot.x, base, plot.x + plot.w, base + one, C(MUTED), a * 0.5);
      };

      // ---- Text regions (per frame).

      const same = (x: number, y: number, w: number, h: number, alpha: number) => {
        if (w > 0 && h > 0) {
          text.quad(x, y, w, h, x, y, w, h, alpha);
        }
      };

      const queueText = (ga: number, ca: number) => {
        same(0, L.formula.y, width, L.formula.h, ca);
        same(0, L.headTop, width, L.headH, ga);
        same(0, L.cellsTop, L.gutterW, L.cellsBottom - L.cellsTop, ga);
        // Cells, around the chart (whose labels sit on the canvas where it floats).
        const c = L.chart;
        const gh = L.cellsBottom - L.cellsTop;
        if (c.w > 0 && c.h > 0) {
          same(L.gutterW, L.cellsTop, c.x - L.gutterW, gh, ca);
          same(c.x, L.cellsTop, width - c.x, c.y - L.cellsTop, ca);
          same(c.x, c.y + c.h, width - c.x, L.cellsBottom - c.y - c.h, ca);
        } else {
          same(L.gutterW, L.cellsTop, width - L.gutterW, gh, ca);
        }
        for (let i = 0; i < TAB_NAMES.length; i++) {
          const k = smoothstep(0, 1, tabLevel[i]);
          tabRect(i, cell);
          same(cell.x, cell.y, cell.w, cell.h, 1 - k);
          if (k > 0 && cell.w > 0 && cell.h > 0) {
            text.quad(
              cell.x,
              cell.y - L.tabs.y + height,
              cell.w,
              cell.h,
              cell.x,
              cell.y,
              cell.w,
              cell.h,
              k,
            );
          }
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          relayout();
          if (sheet) {
            adopt(reshapeSheet(sheet, L));
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const pace = clamp(p.pace, MIN_PACE, MAX_PACE);
          const wantZoom = clamp(p.zoom, MIN_ZOOM, MAX_ZOOM);

          let s = sheet;
          if (!s) {
            // The first frame lays out at the param zoom and builds the sheet.
            zoom = wantZoom;
            relayout();
            s = createSheet(p.seed, 0, 0, L);
            adopt(s);
            ease.snap();
          }

          // A new variation, cell size or a full sheet fades the sheet out and back in.
          if (swap.idle && (s.seed !== p.seed || wantZoom !== zoom || s.editor.done)) {
            swap.start();
            swapGrid = wantZoom !== zoom;
          }
          if (swap.step(step)) {
            // Allocates: a new sheet, once per change.
            if (wantZoom !== zoom) {
              zoom = wantZoom;
              relayout();
            }
            if (s.seed !== p.seed) {
              s = createSheet(p.seed, s.tab, 0, L);
            } else if (s.editor.done) {
              s = createSheet(s.seed, s.tab + 1, s.generation + 1, L);
            } else {
              s = reshapeSheet(s, L);
            }
            adopt(s);
          }
          const ca = swap.alpha;
          const ga = swapGrid ? ca : 1;

          // The typist works on while the sheet is showing.
          if (!swap.fadingOut) {
            stepSheet(s, step, pace);
          }

          // Eased state: colours, tabs, chart, ages.
          const base = THEMES[p.theme] ?? THEMES.light;
          target.set(base);
          target.set(accentRgb(p.accent), ACCENT * 3);
          ease.step(target, step, COLOR_EASE);
          for (let k = 0; k < 3; k++) {
            textPalette[k] = col[TEXT][k];
            textPalette[3 + k] = col[MUTED][k];
            textPalette[6 + k] = col[ACCENT][k];
            textPalette[9 + k] = col[NEG][k];
            textPalette[12 + k] = col[BG][k];
          }
          for (let i = 0; i < TAB_NAMES.length; i++) {
            tabLevel[i] = approach(tabLevel[i], i === s.tab ? 1 : 0, step / TAB_EASE);
          }
          const showChart = p.chart !== "none";
          chartLevel = approach(chartLevel, showChart ? 1 : 0, step / CHART_FADE);
          if (showChart) {
            lineLevel = approach(lineLevel, p.chart === "line" ? 1 : 0, step / CHART_FADE);
          }
          for (let i = 0; i < tintAge.length; i++) {
            tintAge[i] += step;
          }

          // Text: painted whole when first needed; then the cells an edit changed,
          // the cell being typed, the formula bar and the chart axis as they change.
          if (!painted) {
            paintAll(s);
            s.changeCount = 0;
            s.changesOverflow = false;
          }
          if (s.changeCount > 0 || s.changesOverflow) {
            const top = setTargets(s);
            if (top !== range.toHi) {
              const shift = rangeShiftPx(0, range.hi, 0, top, plot.h);
              tweenAxis(range, 0, top, Math.max(VALUE_EASE, minTweenSeconds(shift / scale)));
            }
            for (let i = 0; i < s.changeCount; i++) {
              const q = s.changes[i];
              const ti = cellTable(q);
              const r = cellRow(q);
              const c = cellCol(q);
              if (c < TINT_COLS) {
                tintAge[ti * TINT_STRIDE + r * TINT_COLS + c] = 0;
              }
              if (painted) {
                paintCell(s, ti, r, c);
              }
            }
            if (s.changesOverflow && painted) {
              // Clearing the sheet clears the chart card's labels too.
              paintSheet(s);
              paintChart(s);
            }
            s.changeCount = 0;
            s.changesOverflow = false;
          }
          const e = s.editor;
          if (painted) {
            if (e.phase === PHASE_TYPE && e.chars !== typedChars) {
              typedChars = e.chars;
              const t = s.tables[e.table];
              paintCell(s, e.table, e.row - 1, e.col - t.col0 - 1);
            } else if (e.phase !== PHASE_TYPE) {
              typedChars = -1;
            }
            const chars = e.phase === PHASE_TYPE ? e.chars : -1;
            if (
              e.row !== fRow ||
              e.col !== fCol ||
              chars !== fChars ||
              s.version !== fVersion ||
              e.ext !== fExt
            ) {
              paintFormula(s);
            }
          }
          valueEase.step(valueTarget, step, VALUE_EASE);
          stepAxis(range, step);
          if (painted && rangeShiftPx(0, paintedHi, 0, range.hi, plot.h) >= 0.5) {
            paintChartAxis();
          }
          text.flush();

          // Geometry: chrome, grid, selection and tabs, then the text over them, then the chart and its labels.
          mesh.count = 0;
          const selA = placeSelection(s) * ca;
          drawChrome();
          drawGrid(s, ga, ca, selA);
          drawSelection(selA);
          drawTabs();
          const chartFirst = mesh.count;
          const chartA = ca * smoothstep(0, 1, chartLevel);
          drawChart(s, chartA);
          chart.upload();

          gl.clearColor(col[BG][0], col[BG][1], col[BG][2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          chart.draw(width, height, 0, chartFirst);
          if (painted) {
            queueText(ga, ca);
            text.draw(width, height, textPalette);
          }
          if (mesh.count > chartFirst) {
            chart.draw(width, height, chartFirst, mesh.count - chartFirst);
            const c = L.chart;
            if (painted && c.w > 0 && c.h > 0) {
              same(c.x, c.y, c.w, c.h, chartA);
              text.draw(width, height, textPalette);
            }
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
