/**
 * Card rects for the Dashboard, in whole device pixels (y down), for any canvas
 * size. Sizes are set at 1080p and scaled. Pure layout maths: no GL, no canvas.
 *
 * A title line and a row of KPI tiles run along the top. Below them:
 *
 * - Simple: the line chart fills the body.
 * - Full: the line chart sits in the middle, placed so its plot (gridlines and a
 *   soft area fill, nothing else) covers the frame's middle third, where the
 *   speaker sits; its value labels fall just left of that third and its title
 *   and legend sit along the top. The bar chart and donut stack in the left
 *   column and the table fills the right one.
 */
import { KPI_COUNT } from "./dashboard-sim";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const rect = (): Rect => ({ x: 0, y: 0, w: 0, h: 0 });

/** Reference sizes (px at 1080p). */
const MARGIN = 22;
const GAP = 14;
const TITLE_H = 52;
const KPI_H = 132;
/** Padding inside a card, its header strip (title and legend), and the line chart's axes. */
export const PAD = 18;
export const HEADER = 62;
export const AXIS_W = 54;
export const X_AXIS = 28;
/** The bar chart's share of the left column. */
const BAR_SHARE = 0.54;

interface DashboardLayout {
  title: Rect;
  kpis: Rect[];
  /** The line chart card in each density. */
  lineSimple: Rect;
  lineFull: Rect;
  bars: Rect;
  donut: Rect;
  table: Rect;
}

export function createLayout(): DashboardLayout {
  return {
    title: rect(),
    kpis: Array.from({ length: KPI_COUNT }, rect),
    lineSimple: rect(),
    lineFull: rect(),
    bars: rect(),
    donut: rect(),
    table: rect(),
  };
}

export function setRect(r: Rect, x: number, y: number, w: number, h: number): Rect {
  r.x = Math.round(x);
  r.y = Math.round(y);
  r.w = Math.max(0, Math.round(x + w) - r.x);
  r.h = Math.max(0, Math.round(y + h) - r.y);
  return r;
}

/** Fills `out` with the layout for a `width` x `height` frame at `scale` (px per reference px). */
export function dashboardLayout(
  width: number,
  height: number,
  scale: number,
  out: DashboardLayout,
): DashboardLayout {
  const s = scale > 0 ? scale : height / 1080;
  const m = MARGIN * s;
  const g = GAP * s;
  setRect(out.title, m, m * 0.5, width - 2 * m, TITLE_H * s);
  const kpiY = m * 0.5 + TITLE_H * s;
  const kpiW = (width - 2 * m - (KPI_COUNT - 1) * g) / KPI_COUNT;
  for (let i = 0; i < KPI_COUNT; i++) {
    setRect(out.kpis[i], m + i * (kpiW + g), kpiY, kpiW, KPI_H * s);
  }
  const bodyTop = kpiY + KPI_H * s + g;
  const bodyH = Math.max(0, height - m - bodyTop);
  setRect(out.lineSimple, m, bodyTop, width - 2 * m, bodyH);

  // Full: the line chart's plot runs from a third of the way across to just
  // past two thirds (by the width of the value labels, so the card is centred).
  const side = (PAD + AXIS_W) * s;
  const lineX = Math.floor(width / 3 - side);
  const lineR = Math.ceil((2 * width) / 3 + side);
  setRect(out.lineFull, lineX, bodyTop, Math.max(0, lineR - lineX), bodyH);
  const colW = Math.max(0, lineX - g - m);
  const barH = (bodyH - g) * BAR_SHARE;
  setRect(out.bars, m, bodyTop, colW, barH);
  setRect(out.donut, m, bodyTop + barH + g, colW, Math.max(0, bodyH - barH - g));
  setRect(out.table, lineR + g, bodyTop, Math.max(0, width - m - lineR - g), bodyH);
  return out;
}

/** The line chart's plot inside its `card`. */
export function linePlot(card: Rect, scale: number, out: Rect): Rect {
  const left = Math.round((PAD + AXIS_W) * scale);
  const top = Math.round(HEADER * scale);
  const right = Math.round(PAD * scale);
  const bottom = Math.round((X_AXIS + PAD * 0.5) * scale);
  out.x = card.x + left;
  out.y = card.y + top;
  out.w = Math.max(0, card.w - left - right);
  out.h = Math.max(0, card.h - top - bottom);
  return out;
}

/** Blends rect `a` towards `b` by `t` into `out` (unrounded). */
export function mixRect(a: Rect, b: Rect, t: number, out: Rect): Rect {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.w = a.w + (b.w - a.w) * t;
  out.h = a.h + (b.h - a.h) * t;
  return out;
}
