import { SANS_FONT_STACK } from "../canvas-texture";
import {
  type AutoRangeOptions,
  autoRange,
  CORNER_TOP_LEFT,
  CORNER_TOP_RIGHT,
  coverTicks,
  createAxisRange,
  createChartRenderer,
  createStepSlide,
  createTicks,
  formatCompact,
  formatFixed,
  formatPercent,
  formatTickCompact,
  kickSlide,
  minTweenSeconds,
  niceTicks,
  pushArc,
  pushArea,
  pushPolyline,
  pushRect,
  pushRoundRect,
  rangeShiftPx,
  settleSlide,
  stepAxis,
  stepSlide,
  type StepSlide,
  tickAt,
  tweenAxis,
  valueY,
} from "../charts";
import { createColorEase, hexToUnitRgb } from "../color";
import { beginFrame, withScope } from "../gl";
import { approach, clamp, smoothstep } from "../math";
import { sanitizeText } from "../params";
import { type StepClock, takeSteps } from "../step-clock";
import { createTextLayer, TEXT_PALETTE_FLOATS, TEXT_ROLES } from "../text-layer";
import { defineEffect } from "../types";
import {
  AXIS_W,
  createLayout,
  dashboardLayout,
  HEADER,
  linePlot,
  mixRect,
  PAD,
  type Rect,
  rect,
  setRect,
  X_AXIS,
} from "./dashboard-layout";
import {
  BAR_GROUPS,
  countTo,
  createCountUp,
  createDashboard,
  type CountUp,
  type Dashboard,
  DONUT_SEGMENTS,
  KPI_COUNT,
  type KpiDef,
  kpiChange,
  LINE_SERIES,
  snapCount,
  stepCount,
  stepDashboard,
  TABLE_ROWS,
  UPDATE_BARS,
  UPDATE_DONUT,
  UPDATE_KPI,
  UPDATE_LINE,
  UPDATE_TABLE,
  walkAt,
} from "./dashboard-sim";
import { dashboardMeta, MAX_PACE, MIN_PACE } from "./dashboard.meta";

/** Points across the line chart (four weeks of days), and across a KPI sparkline. */
export const LINE_POINTS = 28;
const SPARK_POINTS = 14;
/** Seconds the line chart and sparklines take to step one point left. */
export const STEP_SECONDS = 0.8;
/** Seconds for a KPI or total to count to a new figure, and bars, slices and table bars to ease. */
const COUNT_SECONDS = 1;
const VALUE_EASE = 1;
/** Seconds for theme and palette changes, card fades, and each half of a variation swap. */
const COLOR_EASE = 1.2;
const CARD_FADE = 1;
const SWAP_HALF = 0.5;
/** Shortest move of the line chart card on a density change, s (longer moves keep to the codec limits). */
const MOVE_MIN = 1;
/** Changed-value tint: peak opacity, ramp in and total seconds. */
const TINT_PEAK = 0.2;
const TINT_RAMP = 0.15;
const TINT_SECONDS = 1.2;
/** Most updates run in one frame. */
const MAX_TICKS_PER_FRAME = 2;
/** Chart vertices, and text regions a frame. */
const MESH_CAPACITY = 20000;
const MAX_QUADS = 40;
/** Card corner radius, line width and sparkline width (reference px). */
const RADIUS = 12;
const LINE_WIDTH = 2;
const SPARK_WIDTH = 1.6;
/** A labelled day on the line chart's time axis every this many points, and label slots kept. */
const LABEL_EVERY = 7;
const LABEL_SLOTS = 8;
/** Width of a time-axis label slot (reference px). */
const LABEL_W = 84;
/** A card header's legend line, below its title (reference px from the card's top). */
const LEGEND_Y = 46;
/** Target gap between the line chart's gridlines (reference px). */
const GRID_GAP = 90;

const LINE_RANGE: AutoRangeOptions = {
  pad: 0.14,
  edge: 0.05,
  minFill: 0.5,
  minSpan: 0,
  minSeconds: 1,
};

/** Palette slots: one RGB triple each. */
const BG = 0;
const CARD = 1;
const GRID = 2;
const TEXT = 3;
const MUTED = 4;
const GOOD = 5;
const BAD = 6;
const TINT = 7;
const SERIES = 8;
const SERIES_COUNT = 4;
const COLORS = SERIES + SERIES_COUNT;

const THEMES: Record<string, readonly string[]> = {
  dark: ["#0e1116", "#171b22", "#232934", "#e7eaf0", "#8a93a3", "#3fb37f", "#e5675f", "#3987e5"],
  light: ["#eef1f5", "#ffffff", "#e6eaf0", "#1b2029", "#69717f", "#17864d", "#c8413c", "#2a78d6"],
};

/**
 * Categorical series colours per palette, for each theme: distinct hues, each
 * stepped for its surface, in an order whose neighbours stay apart under the
 * common colour-vision deficiencies. Mono is one hue in ordered steps.
 */
const PALETTES: Record<string, Record<string, readonly string[]>> = {
  cool: {
    light: ["#2a78d6", "#1baf7a", "#6250d6", "#e87ba4"],
    dark: ["#3987e5", "#199e70", "#9085e9", "#d55181"],
  },
  warm: {
    light: ["#eb6834", "#6250d6", "#eda100", "#e87ba4"],
    dark: ["#d95926", "#9085e9", "#c98500", "#d55181"],
  },
  mono: {
    light: ["#104281", "#2a78d6", "#6da7ec", "#9ec5f4"],
    dark: ["#b7d3f6", "#6da7ec", "#3987e5", "#1c5cab"],
  },
};

/** Each theme and palette as one block of floats, `COLORS` triples: `SCHEMES[theme][palette]`. */
const SCHEMES: Record<string, Record<string, Float32Array>> = {};
for (const [theme, base] of Object.entries(THEMES)) {
  SCHEMES[theme] = {};
  for (const [name, series] of Object.entries(PALETTES)) {
    const out = new Float32Array(COLORS * 3);
    [...base, ...series[theme]].forEach((hex, i) => {
      out.set(hexToUnitRgb(hex), i * 3);
    });
    SCHEMES[theme][name] = out;
  }
}

const BAR_LEGEND = ["This week", "Last week"] as const;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** Fonts at one scale, built on resize. */
interface Fonts {
  title: string;
  subtitle: string;
  card: string;
  legend: string;
  kpiLabel: string;
  kpiNum: string;
  chip: string;
  axis: string;
  cell: string;
  cellNum: string;
  total: string;
}

function makeFonts(s: number): Fonts {
  const px = (n: number) => String(Math.max(4, Math.round(n * s))) + "px " + SANS_FONT_STACK;
  return {
    title: "600 " + px(26),
    subtitle: "400 " + px(14),
    card: "600 " + px(15),
    legend: "400 " + px(13),
    kpiLabel: "500 " + px(14),
    kpiNum: "600 " + px(34),
    chip: "600 " + px(13),
    axis: "400 " + px(12),
    cell: "400 " + px(14),
    cellNum: "500 " + px(14),
    total: "600 " + px(28),
  };
}

/** The width of `t` in the context's font (0 where the context can't measure). */
const measure = (ctx: OffscreenCanvasRenderingContext2D, t: string): number =>
  (ctx.measureText(t) as TextMetrics | undefined)?.width ?? 0;

/** Changed-value tint opacity `age` seconds after the change. */
const tintAlpha = (age: number): number =>
  TINT_PEAK * smoothstep(0, TINT_RAMP, age) * (1 - smoothstep(TINT_RAMP, TINT_SECONDS, age));

/** A KPI's figure as text. */
function kpiText(k: KpiDef, v: number): string {
  const n = formatFixed(v, k.decimals);
  return k.kind === "money" ? "$" + n : k.kind === "percent" ? n + "%" : n;
}

const moneyOr = (money: boolean, text: string) => (money ? "$" + text : text);

/**
 * A business dashboard for a made-up company: a title, four KPI tiles, a line
 * chart and (in the Full density) a bar chart, a donut and a table, on rounded
 * cards. Every card, bar, slice and line is a triangle in one chart mesh rebuilt
 * each frame (a few thousand vertices); all text sits on one device-pixel canvas
 * (`text-layer.ts`) that redraws only what an update changed, coloured by role so
 * theme and palette changes ease on the GPU. Motion is stepped and eased: a KPI
 * counting up, the line chart stepping a day left, bars and slices easing, a tint
 * fading behind a changed value.
 */
export const dashboard = defineEffect(dashboardMeta, {
  create(gl) {
    return withScope((scope) => {
      const chart = createChartRenderer(gl, scope, MESH_CAPACITY);
      const mesh = chart.mesh;
      const text = createTextLayer(gl, scope, MAX_QUADS);
      const ease = createColorEase(COLORS * 3);
      const col: Float32Array[] = [];
      for (let i = 0; i < COLORS; i++) {
        col.push(ease.value.subarray(i * 3, i * 3 + 3));
      }
      const C = (i: number) => col[i];
      const textPalette = new Float32Array(TEXT_PALETTE_FLOATS);

      const layout = createLayout();
      const line = rect();
      const lineFrom = rect();
      const lineTo = rect();
      const plot = rect();
      const fullPlot = rect();
      const barPlot = rect();
      const lineRange = createAxisRange();
      const barRange = createAxisRange();
      const range: AutoRangeOptions = { ...LINE_RANGE };
      const ticks = createTicks();
      const clock: StepClock = { acc: 0 };
      const lineSlide = createStepSlide(STEP_SECONDS);
      const sparkSlides: StepSlide[] = [];
      const kpiCounts: CountUp[] = [];
      for (let i = 0; i < KPI_COUNT; i++) {
        sparkSlides.push(createStepSlide(STEP_SECONDS));
        kpiCounts.push(createCountUp(0, COUNT_SECONDS));
      }
      const totalCount = createCountUp(0, COUNT_SECONDS);
      /** Eased bar values (this period, then the previous), slice values and table values. */
      const barEase = createColorEase(2 * BAR_GROUPS);
      const barTarget = new Float64Array(2 * BAR_GROUPS);
      const donutEase = createColorEase(DONUT_SEGMENTS);
      const donutTarget = new Float64Array(DONUT_SEGMENTS);
      const tableEase = createColorEase(TABLE_ROWS);
      const tableTarget = new Float64Array(TABLE_ROWS);
      const kpiAge = new Float32Array(KPI_COUNT).fill(99);
      const barAge = new Float32Array(BAR_GROUPS).fill(99);
      const donutAge = new Float32Array(DONUT_SEGMENTS).fill(99);
      const tableAge = new Float32Array(TABLE_ROWS).fill(99);
      /** Measured at paint time: chip widths, and legend swatch offsets from the text's left. */
      const chipW = new Float32Array(KPI_COUNT);
      const lineLegendX = new Float32Array(LINE_SERIES);
      const barLegendX = new Float32Array(2);
      /** The day shown in each time-axis label slot (-1 for none). */
      const slotDay = new Float64Array(LABEL_SLOTS).fill(-1);
      const xs = new Float32Array(LINE_POINTS + 4);
      const ys = new Float32Array(LINE_POINTS + 4);

      let width = 1;
      let height = 1;
      let scale = 1;
      let fonts = makeFonts(1);
      let data: Dashboard | null = null;
      /** The newest line point's day at the start, and that day's date (ms). */
      let startDay = 0;
      let startMs = 0;
      let started = false;
      let painted = false;
      let rawTitle: string | null = null;
      let title = "";
      /** Line card move between densities: progress and seconds. */
      let moveT = 1;
      let moveSeconds = MOVE_MIN;
      let wantFull = true;
      /** Opacity of the Full-only cards. */
      let fullLevel = 1;
      let swapPhase = 0;
      let swapT = 0;
      let paintedLo = 0;
      let paintedHi = 0;
      let paintedBarHi = 0;
      /** Text canvas extras: the y-label column (right of the frame) and the bands below it. */
      let axisColX = 0;
      let headerBandY = 0;
      let slotBandY = 0;

      // ---- Text painters (they run on an update or a change, never every frame).

      const fill = (
        t: string,
        x: number,
        y: number,
        role: string,
        align: CanvasTextAlign,
        font: string,
        maxWidth?: number,
      ): number => {
        const ctx = text.ctx;
        if (!ctx) {
          return 0;
        }
        ctx.font = font;
        ctx.fillStyle = role;
        ctx.textAlign = align;
        ctx.textBaseline = "middle";
        if (maxWidth !== undefined && maxWidth > 0) {
          ctx.fillText(t, x, y, maxWidth);
          return Math.min(maxWidth, measure(ctx, t));
        }
        ctx.fillText(t, x, y);
        return measure(ctx, t);
      };
      const S = (n: number) => Math.round(n * scale);

      const paintTitle = () => {
        const r = layout.title;
        text.clear(r.x, r.y, r.w, r.h);
        fill(title, r.x, r.y + r.h / 2, TEXT_ROLES.primary, "left", fonts.title, r.w * 0.62);
        fill(
          "Last 28 days  ·  All regions",
          r.x + r.w,
          r.y + r.h / 2,
          TEXT_ROLES.muted,
          "right",
          fonts.subtitle,
          r.w * 0.34,
        );
      };

      const kpiNumberBand = (i: number, out: Rect) => {
        const r = layout.kpis[i];
        return setRect(out, r.x + S(PAD) - 2, r.y + S(46), r.w * 0.56, S(44));
      };
      const band = rect();

      const paintKpiNumber = (d: Dashboard, i: number) => {
        kpiNumberBand(i, band);
        text.clear(band.x, band.y, band.w, band.h);
        fill(
          kpiText(d.kpis[i], kpiCounts[i].value),
          band.x + 2,
          band.y + band.h / 2,
          TEXT_ROLES.primary,
          "left",
          fonts.kpiNum,
          band.w - 4,
        );
      };

      const paintKpi = (d: Dashboard, i: number) => {
        const r = layout.kpis[i];
        if (r.w <= 0) {
          return;
        }
        text.clear(r.x, r.y, r.w, r.h);
        const x = r.x + S(PAD);
        fill(d.kpis[i].label, x, r.y + S(26), TEXT_ROLES.muted, "left", fonts.kpiLabel, r.w * 0.5);
        paintKpiNumber(d, i);
        const change = kpiChange(d.kpiWalks[i]);
        const good = change >= 0 === d.kpis[i].goodUp;
        const chipText = (change >= 0 ? "▲ " : "▼ ") + formatFixed(Math.abs(change) * 100, 1) + "%";
        const cy = r.y + S(111);
        const w = fill(
          chipText,
          x + S(9),
          cy,
          good ? TEXT_ROLES.up : TEXT_ROLES.down,
          "left",
          fonts.chip,
        );
        chipW[i] = w + S(18);
        fill("vs last week", x + chipW[i] + S(8), cy, TEXT_ROLES.muted, "left", fonts.legend);
      };

      /** Title and legend for a card's header at (`x`, `y`); records each swatch's offset from `x`. */
      const paintHeader = (
        x: number,
        y: number,
        w: number,
        heading: string,
        names: readonly string[],
        swatchX: Float32Array,
      ) => {
        fill(heading, x, y + S(22), TEXT_ROLES.primary, "left", fonts.card, w);
        let lx = 0;
        for (let i = 0; i < names.length && i < swatchX.length; i++) {
          swatchX[i] = lx;
          lx += S(16);
          lx += fill(names[i], x + lx, y + S(LEGEND_Y), TEXT_ROLES.muted, "left", fonts.legend);
          lx += S(20);
        }
      };

      const paintLineHeader = (d: Dashboard) => {
        const w = layout.lineSimple.w;
        text.clear(0, headerBandY, w, S(HEADER));
        paintHeader(S(PAD), headerBandY, w - 2 * S(PAD), d.lineTitle, d.lineNames, lineLegendX);
      };

      /** The line chart's value labels, in the column right of the frame, at the plot's height. */
      const paintLineAxis = (d: Dashboard) => {
        const p = fullPlot;
        if (!lineRange.ready || p.h <= 0) {
          return;
        }
        const colW = S(AXIS_W);
        text.clear(axisColX, p.y - S(12), colW, p.h + S(24));
        niceTicks(
          lineRange.lo,
          lineRange.hi,
          Math.max(2, Math.floor(p.h / (GRID_GAP * scale))),
          ticks,
        );
        const maxAbs = Math.max(
          Math.abs(tickAt(ticks, 0)),
          Math.abs(tickAt(ticks, ticks.count - 1)),
        );
        for (let i = 0; i < ticks.count; i++) {
          const v = tickAt(ticks, i);
          const y = valueY(v, lineRange, p.y, p.y + p.h);
          if (y >= p.y - 1 && y <= p.y + p.h + 1) {
            fill(
              moneyOr(d.lineMoney, formatTickCompact(v, ticks.step, maxAbs)),
              axisColX + colW - S(10),
              y,
              TEXT_ROLES.muted,
              "right",
              fonts.axis,
            );
          }
        }
        paintedLo = lineRange.lo;
        paintedHi = lineRange.hi;
      };

      /** Repaints any time-axis label slot whose day changed. */
      const paintSlots = (d: Dashboard) => {
        const newest = d.lineWalks[0].steps - 1;
        const w = S(LABEL_W);
        const h = S(X_AXIS);
        for (let b = 0; b <= LINE_POINTS + 1; b++) {
          const day = newest - b;
          if (day % LABEL_EVERY !== 0 || day < 0) {
            continue;
          }
          const slot = (day / LABEL_EVERY) % LABEL_SLOTS;
          if (slotDay[slot] === day) {
            continue;
          }
          slotDay[slot] = day;
          const x = slot * w;
          text.clear(x, slotBandY, w, h);
          // Allocates: a date, once per new label (one a week of updates).
          const date = new Date(startMs + (day - startDay) * DAY_MS);
          fill(
            MONTHS[date.getMonth()] + " " + String(date.getDate()),
            x + w / 2,
            slotBandY + h / 2,
            TEXT_ROLES.muted,
            "center",
            fonts.axis,
          );
        }
      };

      const barPlotOf = (card: Rect, out: Rect) =>
        setRect(
          out,
          card.x + S(PAD + 44),
          card.y + S(HEADER),
          card.w - S(2 * PAD + 44),
          card.h - S(HEADER + PAD + 24),
        );

      const paintBarAxis = (d: Dashboard) => {
        const c = layout.bars;
        const p = barPlot;
        if (c.w <= 0 || p.h <= 0 || p.w <= 0 || !barRange.ready) {
          return;
        }
        const x = c.x + S(PAD);
        // Below the header's legend, down to the group labels.
        text.clear(x, p.y - S(8), p.x - x, p.h + S(16));
        niceTicks(0, barRange.hi, 4, ticks);
        const maxAbs = Math.abs(tickAt(ticks, ticks.count - 1));
        for (let i = 0; i < ticks.count; i++) {
          const v = tickAt(ticks, i);
          const y = valueY(v, barRange, p.y, p.y + p.h);
          if (y >= p.y - 1 && y <= p.y + p.h + 1) {
            fill(
              moneyOr(d.barMoney, formatTickCompact(v, ticks.step, maxAbs)),
              p.x - S(10),
              y,
              TEXT_ROLES.muted,
              "right",
              fonts.axis,
            );
          }
        }
        paintedBarHi = barRange.hi;
      };

      const paintBars = (d: Dashboard) => {
        const c = layout.bars;
        if (c.w <= 0 || c.h <= 0) {
          return;
        }
        text.clear(c.x, c.y, c.w, c.h);
        paintHeader(c.x + S(PAD), c.y, c.w - 2 * S(PAD), d.barTitle, BAR_LEGEND, barLegendX);
        const p = barPlot;
        const gw = p.w / BAR_GROUPS;
        for (let g = 0; g < BAR_GROUPS; g++) {
          fill(
            d.barGroups[g],
            p.x + (g + 0.5) * gw,
            p.y + p.h + S(14),
            TEXT_ROLES.muted,
            "center",
            fonts.axis,
            gw - S(4),
          );
        }
        paintBarAxis(d);
      };

      /** The donut's centre, radius and legend column (left edge, first row, row height). */
      const donut = { cx: 0, cy: 0, r: 0, lx: 0, ly: 0, row: 0 };
      const donutGeometry = () => {
        const c = layout.donut;
        const top = c.y + S(44);
        const h = c.h - S(44) - S(PAD);
        donut.r = Math.max(0, Math.min(h / 2, c.w * 0.21));
        donut.cx = c.x + S(PAD) + donut.r + S(8);
        donut.cy = top + h / 2;
        donut.lx = donut.cx + donut.r + S(32);
        donut.row = Math.min(S(34), h / DONUT_SEGMENTS);
        donut.ly = donut.cy - (donut.row * DONUT_SEGMENTS) / 2;
      };

      const paintDonutTotal = (d: Dashboard) => {
        const r = donut.r * 0.62;
        if (r <= 0) {
          return;
        }
        text.clear(donut.cx - r, donut.cy - S(26), 2 * r, S(32));
        fill(
          moneyOr(d.donutMoney, formatCompact(totalCount.value)),
          donut.cx,
          donut.cy - S(10),
          TEXT_ROLES.primary,
          "center",
          fonts.total,
          2 * r,
        );
      };

      const paintDonut = (d: Dashboard) => {
        const c = layout.donut;
        if (c.w <= 0 || c.h <= 0) {
          return;
        }
        text.clear(c.x, c.y, c.w, c.h);
        fill(d.donutTitle, c.x + S(PAD), c.y + S(24), TEXT_ROLES.primary, "left", fonts.card, c.w);
        paintDonutTotal(d);
        fill("Total", donut.cx, donut.cy + S(18), TEXT_ROLES.muted, "center", fonts.legend);
        let sum = 0;
        for (let i = 0; i < DONUT_SEGMENTS; i++) {
          sum += donutTarget[i];
        }
        const right = c.x + c.w - S(PAD);
        for (let i = 0; i < DONUT_SEGMENTS; i++) {
          const y = donut.ly + (i + 0.5) * donut.row;
          fill(
            d.donutNames[i],
            donut.lx + S(18),
            y,
            TEXT_ROLES.muted,
            "left",
            fonts.legend,
            Math.max(1, right - donut.lx - S(80)),
          );
          fill(
            formatFixed(sum > 0 ? (100 * donutTarget[i]) / sum : 0, 1) + "%",
            right,
            y,
            TEXT_ROLES.primary,
            "right",
            fonts.cellNum,
          );
        }
      };

      /** Table rows: first row's top, and the row height. */
      const tableRows = { y: 0, h: 0 };
      const tableGeometry = () => {
        const c = layout.table;
        tableRows.y = c.y + S(HEADER + 16);
        tableRows.h = Math.max(0, Math.min(S(56), (c.y + c.h - S(PAD) - tableRows.y) / TABLE_ROWS));
      };
      /** Table columns: the share bar's left and width, and the right edges of value and change. */
      const cols = { bar: 0, barW: 0, value: 0, change: 0 };
      const tableCols = (c: Rect) => {
        cols.bar = c.x + Math.round(c.w * 0.42);
        cols.barW = Math.round(c.w * 0.22);
        cols.value = c.x + Math.round(c.w * 0.8);
        cols.change = c.x + c.w - S(PAD);
        return cols;
      };

      const paintTable = (d: Dashboard) => {
        const c = layout.table;
        if (c.w <= 0 || c.h <= 0) {
          return;
        }
        text.clear(c.x, c.y, c.w, c.h);
        fill(d.tableTitle, c.x + S(PAD), c.y + S(24), TEXT_ROLES.primary, "left", fonts.card, c.w);
        const k = tableCols(c);
        const hy = c.y + S(HEADER + 2);
        fill("Name", c.x + S(PAD), hy, TEXT_ROLES.muted, "left", fonts.axis);
        fill("Share", k.bar, hy, TEXT_ROLES.muted, "left", fonts.axis);
        fill("Value", k.value, hy, TEXT_ROLES.muted, "right", fonts.axis);
        fill("Change", k.change, hy, TEXT_ROLES.muted, "right", fonts.axis);
        for (let i = 0; i < TABLE_ROWS; i++) {
          const w = d.tableWalks[i];
          const y = tableRows.y + (i + 0.5) * tableRows.h;
          fill(
            d.tableNames[i],
            c.x + S(PAD),
            y,
            TEXT_ROLES.primary,
            "left",
            fonts.cell,
            k.bar - c.x - S(PAD + 12),
          );
          fill(
            moneyOr(d.tableMoney, formatCompact(walkAt(w, 0))),
            k.value,
            y,
            TEXT_ROLES.primary,
            "right",
            fonts.cellNum,
          );
          const before = walkAt(w, 1);
          const change = before > 0 ? (walkAt(w, 0) - before) / before : 0;
          fill(
            formatPercent(change, 1),
            k.change,
            y,
            change < 0 ? TEXT_ROLES.down : TEXT_ROLES.up,
            "right",
            fonts.cellNum,
          );
        }
      };

      /** Sizes the canvas and paints everything. */
      const paintAll = (d: Dashboard) => {
        const colW = S(AXIS_W);
        axisColX = width;
        headerBandY = height;
        slotBandY = height + S(HEADER);
        const w = Math.max(width + colW, layout.lineSimple.w, LABEL_SLOTS * S(LABEL_W));
        if (!text.resize(w, height + S(HEADER) + S(X_AXIS))) {
          return;
        }
        text.clear(0, 0, text.width, text.height);
        slotDay.fill(-1);
        paintTitle();
        for (let i = 0; i < KPI_COUNT; i++) {
          paintKpi(d, i);
        }
        paintLineHeader(d);
        paintLineAxis(d);
        paintSlots(d);
        paintBars(d);
        paintDonut(d);
        paintTable(d);
        painted = true;
      };

      // ---- Data.

      const setTargets = (d: Dashboard) => {
        for (let g = 0; g < BAR_GROUPS; g++) {
          barTarget[g] = d.barNow[g];
          barTarget[BAR_GROUPS + g] = d.barPrev[g];
        }
        let sum = 0;
        for (let i = 0; i < DONUT_SEGMENTS; i++) {
          donutTarget[i] = walkAt(d.donutWalks[i], 0);
          sum += donutTarget[i];
        }
        for (let i = 0; i < TABLE_ROWS; i++) {
          tableTarget[i] = walkAt(d.tableWalks[i], 0);
        }
        return sum;
      };

      /** The bar axis's top for the current targets: the last of the nice ticks covering the bars. */
      const barTop = () => {
        let max = 0;
        for (let i = 0; i < 2 * BAR_GROUPS; i++) {
          max = Math.max(max, barTarget[i]);
        }
        coverTicks(0, max * 1.05, ticks);
        return tickAt(ticks, ticks.count - 1);
      };

      /** Shows `d` as it is now, without easing. */
      const adopt = (d: Dashboard) => {
        startDay = d.lineWalks[0].steps - 1;
        const now = new Date();
        startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime();
        settleSlide(lineSlide);
        for (let i = 0; i < KPI_COUNT; i++) {
          settleSlide(sparkSlides[i]);
          snapCount(kpiCounts[i], walkAt(d.kpiWalks[i], 0));
        }
        snapCount(totalCount, setTargets(d));
        barEase.snap();
        donutEase.snap();
        tableEase.snap();
        lineRange.ready = false;
        barRange.ready = false;
        tweenAxis(barRange, 0, barTop(), 0);
        barRange.ready = true;
        kpiAge.fill(99);
        barAge.fill(99);
        donutAge.fill(99);
        tableAge.fill(99);
        painted = false;
      };

      const onTick = (d: Dashboard, flags: number) => {
        const sum = setTargets(d);
        if (flags & UPDATE_LINE) {
          kickSlide(lineSlide, 1);
          // A burst of updates never glides more than one step.
          lineSlide.from = Math.min(lineSlide.from, 1);
          lineSlide.offset = Math.min(lineSlide.offset, 1);
          if (painted) {
            paintSlots(d);
          }
        }
        for (let i = 0; i < KPI_COUNT; i++) {
          if (flags & (UPDATE_KPI << i)) {
            countTo(kpiCounts[i], walkAt(d.kpiWalks[i], 0));
            kickSlide(sparkSlides[i], 1);
            sparkSlides[i].from = Math.min(sparkSlides[i].from, 1);
            sparkSlides[i].offset = Math.min(sparkSlides[i].offset, 1);
            kpiAge[i] = 0;
            if (painted) {
              paintKpi(d, i);
            }
          }
        }
        if (flags & UPDATE_BARS) {
          barAge.fill(0);
          const top = barTop();
          if (top !== barRange.toHi) {
            const shift = rangeShiftPx(0, barRange.hi, 0, top, barPlot.h);
            tweenAxis(barRange, 0, top, Math.max(VALUE_EASE, minTweenSeconds(shift / scale)));
          }
        }
        if (flags & UPDATE_DONUT) {
          countTo(totalCount, sum);
          donutAge.fill(0);
          if (painted) {
            paintDonut(d);
          }
        }
        if (flags & UPDATE_TABLE) {
          tableAge.fill(0);
          if (painted) {
            paintTable(d);
          }
        }
      };

      // ---- Geometry.

      const card = (r: Rect, a: number) => {
        if (r.w > 0 && r.h > 0) {
          pushRoundRect(mesh, r.x, r.y, r.x + r.w, r.y + r.h, S(RADIUS), C(CARD), a);
        }
      };

      /** A round dot of radius `r` (whole px) centred near (`x`, `y`). */
      const dot = (x: number, y: number, r: number, c: number, a: number) => {
        const cx = Math.round(x);
        const cy = Math.round(y);
        pushRoundRect(mesh, cx - r, cy - r, cx + r, cy + r, r, C(c), a);
      };

      /** A legend swatch: a short rounded bar. */
      const swatch = (x: number, y: number, c: number, a: number) => {
        pushRoundRect(mesh, x, y - S(4), x + S(10), y + S(4), S(2), C(c), a);
      };

      const drawKpi = (d: Dashboard, i: number, a: number) => {
        const r = layout.kpis[i];
        if (r.w <= 0 || r.h <= 0) {
          return;
        }
        card(r, a);
        const x = r.x + S(PAD);
        const change = kpiChange(d.kpiWalks[i]);
        const good = change >= 0 === d.kpis[i].goodUp;
        const cy = r.y + S(111);
        pushRoundRect(
          mesh,
          x,
          cy - S(11),
          x + chipW[i],
          cy + S(11),
          S(11),
          C(good ? GOOD : BAD),
          a * 0.16,
        );
        const tint = tintAlpha(kpiAge[i]);
        if (tint > 0) {
          kpiNumberBand(i, band);
          pushRoundRect(
            mesh,
            band.x - S(6),
            band.y,
            band.x + band.w,
            band.y + band.h,
            S(6),
            C(TINT),
            a * tint,
          );
        }
        // The sparkline: the KPI's recent values, scaled to their own range, stepping left.
        const w = d.kpiWalks[i];
        const left = r.x + Math.round(r.w * 0.6);
        const right = r.x + r.w - S(PAD);
        const top = r.y + S(48);
        const bottom = r.y + S(96);
        if (right - left < S(20)) {
          return;
        }
        let lo = Infinity;
        let hi = -Infinity;
        for (let b = 0; b <= SPARK_POINTS; b++) {
          const v = walkAt(w, b);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        const span = Math.max(hi - lo, hi * 0.01);
        const sp = (right - left) / (SPARK_POINTS - 1);
        const off = sparkSlides[i].offset * sp;
        let n = 0;
        for (let b = SPARK_POINTS; b >= 0; b--) {
          xs[n] = right - b * sp + off;
          ys[n] = bottom - ((walkAt(w, b) - lo) / span) * (bottom - top);
          n++;
        }
        clipLine(n, left, right);
        if (clipCount >= 2) {
          pushArea(mesh, xs, ys, clipFrom, clipCount, bottom, C(SERIES), 0.16 * a, 0);
          pushPolyline(mesh, xs, ys, clipFrom, clipCount, SPARK_WIDTH * scale, C(SERIES), a);
        }
      };

      /** First and count of the clipped line points, set by `clipLine`. */
      let clipFrom = 0;
      let clipCount = 0;
      /** Clips points `0 .. n - 1` of xs / ys (x ascending) to [left, right], interpolating the ends. */
      const clipLine = (n: number, left: number, right: number) => {
        let i0 = 0;
        while (i0 < n && xs[i0] < left) {
          i0++;
        }
        if (i0 >= n) {
          clipCount = 0;
          return;
        }
        if (i0 > 0) {
          const t = (left - xs[i0 - 1]) / (xs[i0] - xs[i0 - 1]);
          ys[i0 - 1] += (ys[i0] - ys[i0 - 1]) * t;
          xs[i0 - 1] = left;
          i0--;
        }
        let i1 = n - 1;
        while (i1 > i0 && xs[i1] > right) {
          i1--;
        }
        if (i1 < n - 1) {
          const t = (right - xs[i1]) / (xs[i1 + 1] - xs[i1]);
          ys[i1 + 1] = ys[i1] + (ys[i1 + 1] - ys[i1]) * t;
          xs[i1 + 1] = right;
          i1++;
        }
        clipFrom = i0;
        clipCount = i1 - i0 + 1;
      };

      const drawLine = (d: Dashboard, a: number) => {
        card(line, a);
        const p = plot;
        if (p.w <= 0 || p.h <= 0 || !lineRange.ready) {
          return;
        }
        // Legend swatches beside the names in the header.
        const lx = line.x + S(PAD);
        for (let i = 0; i < LINE_SERIES; i++) {
          if (lineLegendX[i] + S(10) < line.w - 2 * S(PAD)) {
            swatch(lx + lineLegendX[i], line.y + S(LEGEND_Y), SERIES + i, a);
          }
        }
        niceTicks(
          lineRange.lo,
          lineRange.hi,
          Math.max(2, Math.floor(p.h / (GRID_GAP * scale))),
          ticks,
        );
        for (let i = 0; i < ticks.count; i++) {
          const gy = Math.round(valueY(tickAt(ticks, i), lineRange, p.y, p.y + p.h));
          if (gy >= p.y && gy <= p.y + p.h) {
            pushRect(mesh, p.x, gy, p.x + p.w, gy + 1, C(GRID), a);
          }
        }
        const sp = p.w / (LINE_POINTS - 1);
        const off = lineSlide.offset * sp;
        const newest = d.lineWalks[0].steps - 1;
        // Day gridlines at the labelled days, moving with the points.
        for (let b = 0; b <= LINE_POINTS; b++) {
          if ((newest - b) % LABEL_EVERY === 0) {
            const x = Math.round(p.x + p.w - b * sp + off);
            if (x >= p.x && x <= p.x + p.w) {
              pushRect(mesh, x, p.y, x + 1, p.y + p.h, C(GRID), a);
            }
          }
        }
        pushRect(mesh, p.x, p.y + p.h, p.x + p.w, p.y + p.h + Math.max(1, S(1)), C(MUTED), a * 0.4);
        for (let s = LINE_SERIES - 1; s >= 0; s--) {
          const w = d.lineWalks[s];
          let n = 0;
          for (let b = LINE_POINTS; b >= 0; b--) {
            xs[n] = p.x + p.w - b * sp + off;
            ys[n] = clamp(valueY(walkAt(w, b), lineRange, p.y, p.y + p.h), p.y, p.y + p.h);
            n++;
          }
          const endY = ys[n - 1];
          const endX = xs[n - 1];
          clipLine(n, p.x, p.x + p.w);
          if (clipCount >= 2) {
            pushArea(mesh, xs, ys, clipFrom, clipCount, p.y + p.h, C(SERIES + s), 0.12 * a, 0);
            pushPolyline(mesh, xs, ys, clipFrom, clipCount, LINE_WIDTH * scale, C(SERIES + s), a);
          }
          // The newest point: a dot with a ring of card colour, once it is inside the plot.
          const edge = clamp((p.x + p.w - endX) / (0.25 * sp) + 1, 0, 1);
          if (edge > 0) {
            dot(endX, endY, S(6), CARD, a * edge);
            dot(endX, endY, S(4), SERIES + s, a * edge);
          }
        }
      };

      const drawBars = (a: number) => {
        const c = layout.bars;
        if (c.w <= 0 || c.h <= 0 || a <= 0) {
          return;
        }
        card(c, a);
        for (let i = 0; i < 2; i++) {
          swatch(c.x + S(PAD) + barLegendX[i], c.y + S(LEGEND_Y), SERIES + i, a);
        }
        const p = barPlot;
        if (p.w <= 0 || p.h <= 0 || !barRange.ready) {
          return;
        }
        niceTicks(0, barRange.hi, 4, ticks);
        for (let i = 0; i < ticks.count; i++) {
          const gy = Math.round(valueY(tickAt(ticks, i), barRange, p.y, p.y + p.h));
          if (gy >= p.y && gy < p.y + p.h) {
            pushRect(mesh, p.x, gy, p.x + p.w, gy + 1, C(GRID), a);
          }
        }
        const gw = p.w / BAR_GROUPS;
        const bw = Math.max(1, Math.round(gw * 0.26));
        const gap = Math.max(1, S(3));
        const base = p.y + p.h;
        for (let g = 0; g < BAR_GROUPS; g++) {
          const cx = Math.round(p.x + (g + 0.5) * gw);
          const tint = tintAlpha(barAge[g]);
          if (tint > 0) {
            pushRoundRect(
              mesh,
              cx - bw - gap - S(6),
              p.y,
              cx + bw + gap + S(6),
              base,
              S(6),
              C(TINT),
              a * tint * 0.6,
            );
          }
          for (let k = 0; k < 2; k++) {
            const v = barEase.value[k * BAR_GROUPS + g];
            const top = clamp(valueY(v, barRange, p.y, base), p.y, base);
            const x0 = k === 0 ? cx - bw - Math.floor(gap / 2) : cx + Math.ceil(gap / 2);
            pushRoundRect(
              mesh,
              x0,
              top,
              x0 + bw,
              base,
              S(4),
              C(SERIES + k),
              a,
              CORNER_TOP_LEFT | CORNER_TOP_RIGHT,
            );
          }
        }
        pushRect(mesh, p.x, base, p.x + p.w, base + Math.max(1, S(1)), C(MUTED), a * 0.5);
      };

      const drawDonut = (a: number) => {
        const c = layout.donut;
        if (c.w <= 0 || c.h <= 0 || a <= 0) {
          return;
        }
        card(c, a);
        const r = donut.r;
        if (r <= S(8)) {
          return;
        }
        let sum = 0;
        for (let i = 0; i < DONUT_SEGMENTS; i++) {
          sum += Math.max(0, donutEase.value[i]);
        }
        if (!(sum > 0)) {
          return;
        }
        // A gap of a couple of pixels between slices, in card colour.
        const gap = (2 * scale) / r;
        let a0 = 0;
        for (let i = 0; i < DONUT_SEGMENTS; i++) {
          const sweep = (2 * Math.PI * Math.max(0, donutEase.value[i])) / sum;
          if (sweep > gap) {
            pushArc(
              mesh,
              donut.cx,
              donut.cy,
              r * 0.66,
              r,
              a0 + gap / 2,
              a0 + sweep - gap / 2,
              C(SERIES + i),
              a,
            );
          }
          a0 += sweep;
          const y = donut.ly + (i + 0.5) * donut.row;
          const tint = tintAlpha(donutAge[i]);
          if (tint > 0) {
            const right = c.x + c.w - S(PAD);
            pushRoundRect(
              mesh,
              right - S(64),
              y - S(12),
              right + S(6),
              y + S(12),
              S(6),
              C(TINT),
              a * tint,
            );
          }
          swatch(donut.lx, y, SERIES + i, a);
        }
      };

      const drawTable = (a: number) => {
        const c = layout.table;
        if (c.w <= 0 || c.h <= 0 || a <= 0) {
          return;
        }
        card(c, a);
        const k = tableCols(c);
        let max = 0;
        for (let i = 0; i < TABLE_ROWS; i++) {
          max = Math.max(max, tableEase.value[i]);
        }
        const t = Math.max(1, S(1));
        for (let i = 0; i < TABLE_ROWS; i++) {
          const y = tableRows.y + i * tableRows.h;
          pushRect(mesh, c.x + S(PAD), y, c.x + c.w - S(PAD), y + t, C(GRID), a);
          const tint = tintAlpha(tableAge[i]);
          if (tint > 0) {
            pushRoundRect(
              mesh,
              k.value - S(70),
              y + S(8),
              k.change + S(6),
              y + tableRows.h - S(8),
              S(6),
              C(TINT),
              a * tint,
            );
          }
          const my = y + tableRows.h / 2;
          const bw = max > 0 ? (k.barW * Math.max(0, tableEase.value[i])) / max : 0;
          pushRoundRect(mesh, k.bar, my - S(4), k.bar + k.barW, my + S(4), S(4), C(GRID), a);
          pushRoundRect(mesh, k.bar, my - S(4), k.bar + bw, my + S(4), S(4), C(SERIES), a);
        }
      };

      /** Queues a text region at its own position, clipped to [clipL, clipR] across. */
      const quadClipped = (
        sx: number,
        sy: number,
        sw: number,
        sh: number,
        dx: number,
        dy: number,
        alpha: number,
        clipL: number,
        clipR: number,
      ) => {
        const x0 = Math.max(dx, clipL);
        const x1 = Math.min(dx + sw, clipR);
        if (x1 > x0) {
          text.quad(sx + x0 - dx, sy, x1 - x0, sh, x0, dy, x1 - x0, sh, alpha);
        }
      };
      const same = (r: Rect, alpha: number) => {
        if (r.w > 0 && r.h > 0) {
          text.quad(r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h, alpha);
        }
      };

      /** Queues the text of the title, KPI tiles and side cards. */
      const queueText = (ca: number, fa: number) => {
        same(layout.title, ca);
        for (let i = 0; i < KPI_COUNT; i++) {
          same(layout.kpis[i], ca);
        }
        if (fa > 0) {
          same(layout.bars, fa);
          same(layout.donut, fa);
          same(layout.table, fa);
        }
      };

      /** Queues the line chart's text: header and value labels follow the card, day labels their points. */
      const queueLineText = (d: Dashboard, ca: number) => {
        const lx = Math.round(line.x);
        const ly = Math.round(line.y);
        const lw = Math.round(line.w);
        quadClipped(0, headerBandY, layout.lineSimple.w, S(HEADER), lx, ly, ca, lx, lx + lw);
        const p = plot;
        if (p.w > 0 && p.h > 0 && lineRange.ready) {
          const colW = S(AXIS_W);
          const top = p.y - S(12);
          text.quad(axisColX, top, colW, p.h + S(24), p.x - colW, top, colW, p.h + S(24), ca);
          const sp = p.w / (LINE_POINTS - 1);
          const off = lineSlide.offset * sp;
          const newest = d.lineWalks[0].steps - 1;
          const w = S(LABEL_W);
          for (let b = 0; b <= LINE_POINTS + 1; b++) {
            const day = newest - b;
            if (day % LABEL_EVERY !== 0 || day < 0) {
              continue;
            }
            const slot = (day / LABEL_EVERY) % LABEL_SLOTS;
            if (slotDay[slot] !== day) {
              continue;
            }
            const x = p.x + p.w - b * sp + off;
            const edge = clamp(Math.min(x - p.x, p.x + p.w - x) / (0.5 * sp) + 1, 0, 1);
            quadClipped(
              slot * w,
              slotBandY,
              w,
              S(X_AXIS),
              Math.round(x - w / 2),
              p.y + p.h + S(4),
              ca * edge,
              lx + S(PAD) * 0.5,
              lx + lw - S(PAD) * 0.5,
            );
          }
        }
      };

      /** Lays the line card and its plot out for this frame. */
      const placeLine = (t: number) => {
        mixRect(lineFrom, lineTo, smoothstep(0, 1, t), line);
        line.x = Math.round(line.x);
        line.y = Math.round(line.y);
        line.w = Math.round(line.w);
        line.h = Math.round(line.h);
        linePlot(line, scale, plot);
      };

      const relayout = () => {
        dashboardLayout(width, height, scale, layout);
        linePlot(layout.lineFull, scale, fullPlot);
        barPlotOf(layout.bars, barPlot);
        donutGeometry();
        tableGeometry();
        const target = wantFull ? layout.lineFull : layout.lineSimple;
        Object.assign(lineFrom, target);
        Object.assign(lineTo, target);
        moveT = 1;
        placeLine(1);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          fonts = makeFonts(scale);
          relayout();
          painted = false;
          lineRange.ready = false;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const pace = clamp(p.pace, MIN_PACE, MAX_PACE);
          const full = p.density !== "simple";

          if (!started || !data) {
            // Allocates: the first frame builds the data and settles the layout.
            started = true;
            data = createDashboard(p.seed);
            wantFull = full;
            fullLevel = full ? 1 : 0;
            relayout();
            adopt(data);
            ease.snap();
          }

          // A new variation fades the screen out, swaps the data, and fades back in.
          if (swapPhase === 0 && data.seed !== p.seed) {
            swapPhase = 1;
            swapT = 0;
          }
          if (swapPhase === 1) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              // Allocates: new data, once per variation change.
              data = createDashboard(p.seed);
              adopt(data);
              swapPhase = 2;
              swapT = 0;
            }
          } else if (swapPhase === 2) {
            swapT = Math.min(1, swapT + step / SWAP_HALF);
            if (swapT >= 1) {
              swapPhase = 0;
            }
          }
          const d = data;
          const ca =
            swapPhase === 1
              ? 1 - smoothstep(0, 1, swapT)
              : swapPhase === 2
                ? smoothstep(0, 1, swapT)
                : 1;

          if (p.title !== rawTitle) {
            rawTitle = p.title;
            title = sanitizeText(dashboardMeta.params.title, p.title).trim();
            if (painted) {
              paintTitle();
            }
          }

          // Updates every `pace` seconds (a new pace applies from the next one).
          const n = takeSteps(clock, 1 / pace, step, MAX_TICKS_PER_FRAME);
          for (let i = 0; i < n; i++) {
            onTick(d, stepDashboard(d));
          }

          // Density: the line card moves to its new rect; the other cards fade.
          if (full !== wantFull) {
            wantFull = full;
            Object.assign(lineFrom, line);
            Object.assign(lineTo, full ? layout.lineFull : layout.lineSimple);
            const far = Math.max(
              Math.abs(lineTo.x - lineFrom.x),
              Math.abs(lineTo.x + lineTo.w - lineFrom.x - lineFrom.w),
            );
            moveSeconds = Math.max(MOVE_MIN, minTweenSeconds(far / scale));
            moveT = 0;
          }
          if (moveT < 1) {
            moveT = Math.min(1, moveT + step / moveSeconds);
            placeLine(moveT);
          }
          fullLevel = approach(fullLevel, full ? 1 : 0, step / CARD_FADE);

          // Eased state: colours, slides, counts, values, axes and tints.
          const scheme = (SCHEMES[p.theme] ?? SCHEMES.dark)[p.palette] ?? SCHEMES.dark.cool;
          ease.step(scheme, step, COLOR_EASE);
          for (let k = 0; k < 3; k++) {
            textPalette[k] = col[TEXT][k];
            textPalette[3 + k] = col[MUTED][k];
            textPalette[6 + k] = col[GOOD][k];
            textPalette[9 + k] = col[BAD][k];
            textPalette[12 + k] = col[CARD][k];
          }
          stepSlide(lineSlide, step);
          for (let i = 0; i < KPI_COUNT; i++) {
            stepSlide(sparkSlides[i], step);
            kpiAge[i] += step;
          }
          barEase.step(barTarget, step, VALUE_EASE);
          donutEase.step(donutTarget, step, VALUE_EASE);
          tableEase.step(tableTarget, step, VALUE_EASE);
          for (let i = 0; i < BAR_GROUPS; i++) {
            barAge[i] += step;
          }
          for (let i = 0; i < DONUT_SEGMENTS; i++) {
            donutAge[i] += step;
          }
          for (let i = 0; i < TABLE_ROWS; i++) {
            tableAge[i] += step;
          }
          stepAxis(barRange, step);
          if (plot.h > 0) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let s = 0; s < LINE_SERIES; s++) {
              for (let b = 0; b <= LINE_POINTS; b++) {
                const v = walkAt(d.lineWalks[s], b);
                lo = Math.min(lo, v);
                hi = Math.max(hi, v);
              }
            }
            range.minSpan = hi * 0.05;
            autoRange(lineRange, lo, hi, plot.h, scale, range);
            stepAxis(lineRange, step);
          }

          // Text: painted whole when first needed; then numbers while they count and
          // axis labels while their axis moves.
          if (!painted) {
            paintAll(d);
          } else {
            for (let i = 0; i < KPI_COUNT; i++) {
              if (stepCount(kpiCounts[i], step)) {
                paintKpiNumber(d, i);
              }
            }
            if (stepCount(totalCount, step)) {
              paintDonutTotal(d);
            }
            if (rangeShiftPx(paintedLo, paintedHi, lineRange.lo, lineRange.hi, fullPlot.h) >= 0.5) {
              paintLineAxis(d);
            }
            if (rangeShiftPx(0, paintedBarHi, 0, barRange.hi, barPlot.h) >= 0.5) {
              paintBarAxis(d);
            }
          }
          text.flush();

          // Geometry, then the text over it: the rest of the page, then the line card.
          mesh.count = 0;
          const fa = ca * smoothstep(0, 1, fullLevel);
          for (let i = 0; i < KPI_COUNT; i++) {
            drawKpi(d, i, ca);
          }
          drawBars(fa);
          drawDonut(fa);
          drawTable(fa);
          // The line card last: it moves over the side cards on a density change.
          const lineFirst = mesh.count;
          drawLine(d, ca);
          chart.upload();

          gl.clearColor(col[BG][0], col[BG][1], col[BG][2], 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          chart.draw(width, height, 0, lineFirst);
          if (painted) {
            queueText(ca, fa);
            text.draw(width, height, textPalette);
          }
          chart.draw(width, height, lineFirst, mesh.count - lineFirst);
          if (painted) {
            queueLineText(d, ca);
            text.draw(width, height, textPalette);
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
