/**
 * Charts for the dashboard-style effects (trading screens, business dashboards,
 * spreadsheets): "nice" axis ticks and number formatting, axis ranges that rescale
 * smoothly, the eased one-step slide a chart makes when a new point or candle
 * arrives, and a batched triangle mesh for the marks themselves (rects, bars,
 * candles, antialiased lines, area fills and donut arcs), drawn by one small
 * program.
 *
 * Everything is in device pixels with y down (the 2D canvas convention), so chart
 * geometry lines up texel for texel with labels drawn on a canvas. The layout and
 * mesh code is plain maths with no GL, so it can be unit-tested; only
 * `createChartRenderer` touches the context. Nothing here allocates per call
 * except the string formatters, which run only when a label changes.
 */
import { createUniforms, type Scope, scopedProgram } from "./gl";
import { smoothstep } from "./math";
import { EASE_PEAK, MAX_FEATURE_PX_PER_FRAME, pxPerReferenceFrame } from "./motion-limits";

// ---------------------------------------------------------------------------
// Ticks and number formatting

/** Evenly spaced axis ticks: `count` values `first + i * step`. */
export interface Ticks {
  first: number;
  step: number;
  count: number;
  /** Decimal places that show every tick exactly. */
  decimals: number;
}

export const createTicks = (): Ticks => ({ first: 0, step: 1, count: 0, decimals: 0 });

const NICE_MANTISSAS = [1, 2, 2.5, 5];

/**
 * The smallest "nice" step (1, 2, 2.5 or 5 times a power of ten) that divides
 * `span` into at most `maxSteps` intervals. Returns 1 for an empty or invalid span.
 */
export function niceStep(span: number, maxSteps: number): number {
  if (!(span > 0) || !Number.isFinite(span)) {
    return 1;
  }
  const raw = span / Math.max(1, Math.floor(maxSteps));
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of NICE_MANTISSAS) {
    // A hair of slack, so 0.3 / 3 picks 0.1 rather than 0.2.
    if (m * mag >= raw * (1 - 1e-9)) {
      return m * mag;
    }
  }
  return 10 * mag;
}

/** Decimal places needed to write every multiple of `step` exactly (at most 10). */
export function stepDecimals(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) {
    return 0;
  }
  let d = 0;
  let s = step;
  while (d < 10 && Math.abs(s - Math.round(s)) > 1e-7 * Math.max(1, s)) {
    d++;
    s *= 10;
  }
  return d;
}

/**
 * Fills `out` with the nice ticks inside [`lo`, `hi`], about `target` intervals
 * apart at most, and returns it.
 */
export function niceTicks(lo: number, hi: number, target: number, out: Ticks): Ticks {
  if (!(hi > lo) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    out.first = Number.isFinite(lo) ? lo : 0;
    out.step = 1;
    out.count = Number.isFinite(lo) ? 1 : 0;
    out.decimals = 0;
    return out;
  }
  const step = niceStep(hi - lo, target);
  // `+ 0` turns a -0 (from a range starting at zero) into 0.
  const first = Math.ceil(lo / step - 1e-9) * step + 0;
  out.first = first;
  out.step = step;
  out.count = Math.max(0, Math.floor((hi - first) / step + 1e-9) + 1);
  out.decimals = stepDecimals(step);
  return out;
}

/** Fewest and most ticks `coverTicks` gives, and the count it prefers. */
export const COVER_MIN_TICKS = 4;
export const COVER_MAX_TICKS = 7;
const COVER_PREFERRED = 5.5;

/**
 * Fills `out` with nice ticks that cover [`lo`, `hi`]: the first at or below
 * `lo`, the last at or above `hi`, 4 to 7 in all, as tight around the range as
 * those allow. For an axis that should end on a labelled value, such as a bar
 * chart's. An empty range is widened by a tenth of its size (or by one at zero).
 */
export function coverTicks(lo: number, hi: number, out: Ticks): Ticks {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    out.first = 0;
    out.step = 1;
    out.count = 0;
    out.decimals = 0;
    return out;
  }
  let a = Math.min(lo, hi);
  let b = Math.max(lo, hi);
  if (!(b - a > Math.max(Math.abs(a), Math.abs(b)) * 1e-9)) {
    const pad = Math.abs(a) > 0 ? Math.abs(a) * 0.1 : 1;
    a -= pad;
    b += pad;
  }
  const span = b - a;
  const mag = 10 ** Math.floor(Math.log10(span / COVER_PREFERRED));
  let bestScore = Infinity;
  for (let e = -1; e <= 1; e++) {
    for (const m of NICE_MANTISSAS) {
      const step = m * mag * 10 ** e;
      const i0 = Math.floor(a / step + 1e-9);
      const i1 = Math.ceil(b / step - 1e-9);
      const count = i1 - i0 + 1;
      if (count < COVER_MIN_TICKS || count > COVER_MAX_TICKS) {
        continue;
      }
      // Tightest cover first; between equals, nearest the preferred count.
      const score = ((i1 - i0) * step) / span + 0.01 * Math.abs(count - COVER_PREFERRED);
      if (score < bestScore) {
        bestScore = score;
        out.first = i0 * step + 0;
        out.step = step;
        out.count = count;
      }
    }
  }
  out.decimals = stepDecimals(out.step);
  return out;
}

/** Tick `i` of `t`. */
export const tickAt = (t: Ticks, i: number): number => t.first + i * t.step;

/** `v` with `decimals` places and thousands separators, such as "12,345.60". */
export function formatFixed(v: number, decimals: number): string {
  if (!Number.isFinite(v)) {
    return "-";
  }
  const s = Math.abs(v).toFixed(Math.max(0, Math.min(10, Math.floor(decimals))));
  const dot = s.indexOf(".");
  const whole = dot < 0 ? s : s.slice(0, dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // A value that rounds to zero shows no sign.
  const negative = v < 0 && Number(s) !== 0;
  return (negative ? "-" : "") + grouped + (dot < 0 ? "" : s.slice(dot));
}

/** `v` with an explicit sign: "+1.25", "-0.40", and "0.00" for zero. */
export function formatSigned(v: number, decimals: number): string {
  const s = formatFixed(v, decimals);
  return s !== "-" && !s.startsWith("-") && Number(s.replace(/,/g, "")) !== 0 ? "+" + s : s;
}

/** A fraction as a signed percentage: 0.0123 → "+1.23%". */
export const formatPercent = (fraction: number, decimals = 2): string =>
  formatSigned(fraction * 100, decimals) + "%";

/** A count in a few characters: 950, 12.4K, 3.21M, 1.05B. */
export function formatCompact(v: number): string {
  if (!Number.isFinite(v)) {
    return "-";
  }
  const a = Math.abs(v);
  if (a < 999.5) {
    // A value that rounds to zero shows no sign; 999.5 and up round to "1.00K" below.
    const n = Math.round(a);
    return (v < 0 && n !== 0 ? "-" : "") + n.toString();
  }
  const sign = v < 0 ? "-" : "";
  const [div, unit] = a < 999.5e3 ? [1e3, "K"] : a < 999.5e6 ? [1e6, "M"] : [1e9, "B"];
  const n = a / div;
  return sign + n.toFixed(n < 9.995 ? 2 : n < 99.95 ? 1 : 0) + unit;
}

/**
 * Axis tick `v` in a few characters, on a shared unit picked by `maxAbs` (the
 * largest tick's size), with the decimal places a `step` apart needs: ticks
 * 0..3000 every 500 read "0", "0.5K", "1.0K" ... "3.0K".
 */
export function formatTickCompact(v: number, step: number, maxAbs: number): string {
  if (!Number.isFinite(v)) {
    return "-";
  }
  if (Math.abs(v) < Math.abs(step) * 1e-6) {
    return "0";
  }
  const a = Math.abs(maxAbs);
  const [div, unit] =
    a >= 1e9 ? [1e9, "B"] : a >= 1e6 ? [1e6, "M"] : a >= 1e3 ? [1e3, "K"] : [1, ""];
  return formatFixed(v / div, stepDecimals(step / div)) + unit;
}

/** Decimal places for a price of about `price`: 2 normally, more for pennies. */
export const priceDecimals = (price: number): number =>
  Math.abs(price) >= 1 || !(Math.abs(price) > 0) ? 2 : Math.abs(price) >= 0.1 ? 3 : 4;

// ---------------------------------------------------------------------------
// Motion

/** Reference frame height (px) that `MAX_FEATURE_PX_PER_FRAME` is measured at. */
const REFERENCE_HEIGHT = 1080;

/**
 * The shortest smoothstep move of `refPx` reference pixels (at 1080p) that stays
 * within `MAX_FEATURE_PX_PER_FRAME` at its peak speed, in seconds.
 */
export function minTweenSeconds(refPx: number): number {
  if (!(refPx > 0) || !Number.isFinite(refPx)) {
    return 0;
  }
  // Px per reference frame at one second's duration; it scales as 1 / seconds.
  const perFrameAtOneSecond = pxPerReferenceFrame((EASE_PEAK * refPx) / REFERENCE_HEIGHT);
  return perFrameAtOneSecond / MAX_FEATURE_PX_PER_FRAME;
}

/**
 * Peak speed of a smoothstep move of `refPx` reference pixels over `seconds`, in
 * px per reference frame (1080p, 30 fps): what `MAX_FEATURE_PX_PER_FRAME` limits.
 */
export const tweenPeakPxPerFrame = (refPx: number, seconds: number): number =>
  seconds > 0
    ? pxPerReferenceFrame((EASE_PEAK * Math.abs(refPx)) / REFERENCE_HEIGHT / seconds)
    : Infinity;

/**
 * The eased step a chart takes when a new point or candle arrives: the content
 * jumps back by one step (`kickSlide`) and `offset` eases from there to 0, so the
 * chart moves one step in a short glide instead of scrolling continuously.
 */
export interface StepSlide {
  /** Current offset, px; add it to every mark's position. */
  offset: number;
  /** The offset the glide started from. */
  from: number;
  /** Glide progress, 0..1; 1 at rest. */
  t: number;
  /** Seconds per glide. */
  seconds: number;
}

export const createStepSlide = (seconds: number): StepSlide => ({
  offset: 0,
  from: 0,
  t: 1,
  seconds,
});

/** Starts a glide of `amount` px (the content moved by -`amount`), from wherever it is now. */
export function kickSlide(s: StepSlide, amount: number): void {
  s.from = s.offset + amount;
  s.offset = s.from;
  s.t = 0;
}

/** Advances the glide by `dt` seconds and returns the offset. */
export function stepSlide(s: StepSlide, dt: number): number {
  if (s.t < 1) {
    s.t = s.seconds > 0 && dt >= 0 ? Math.min(1, s.t + dt / s.seconds) : 1;
    s.offset = s.t >= 1 ? 0 : s.from * (1 - smoothstep(0, 1, s.t));
  }
  return s.offset;
}

/** Ends any glide at once. */
export function settleSlide(s: StepSlide): void {
  s.offset = 0;
  s.from = 0;
  s.t = 1;
}

// ---------------------------------------------------------------------------
// Axis ranges

/**
 * A value axis that rescales smoothly: `lo`..`hi` is shown, tweening with a
 * smoothstep from (`fromLo`, `fromHi`) to (`toLo`, `toHi`).
 */
export interface AxisRange {
  lo: number;
  hi: number;
  fromLo: number;
  fromHi: number;
  toLo: number;
  toHi: number;
  /** Tween progress 0..1; 1 at rest. */
  t: number;
  seconds: number;
  /** False until the first `snapAxis` (or `autoRange`). */
  ready: boolean;
}

export const createAxisRange = (): AxisRange => ({
  lo: 0,
  hi: 1,
  fromLo: 0,
  fromHi: 1,
  toLo: 0,
  toHi: 1,
  t: 1,
  seconds: 1,
  ready: false,
});

/** Shows `lo`..`hi` at once. */
export function snapAxis(r: AxisRange, lo: number, hi: number): void {
  r.lo = r.fromLo = r.toLo = lo;
  r.hi = r.fromHi = r.toHi = hi;
  r.t = 1;
  r.ready = true;
}

/** Tweens from what is shown now to `lo`..`hi` over `seconds`. */
export function tweenAxis(r: AxisRange, lo: number, hi: number, seconds: number): void {
  r.fromLo = r.lo;
  r.fromHi = r.hi;
  r.toLo = lo;
  r.toHi = hi;
  r.seconds = seconds;
  r.t = seconds > 0 ? 0 : 1;
  if (r.t >= 1) {
    r.lo = lo;
    r.hi = hi;
  }
}

/** Advances the tween by `dt` seconds. Returns whether the shown range changed. */
export function stepAxis(r: AxisRange, dt: number): boolean {
  if (r.t >= 1) {
    return false;
  }
  r.t = r.seconds > 0 && dt >= 0 ? Math.min(1, r.t + dt / r.seconds) : 1;
  const f = smoothstep(0, 1, r.t);
  r.lo = r.fromLo + (r.toLo - r.fromLo) * f;
  r.hi = r.fromHi + (r.toHi - r.fromHi) * f;
  return true;
}

/**
 * How far (px) any value on a `plotPx`-tall axis moves when the shown range goes
 * from `lo`..`hi` to `nlo`..`nhi`. The move is linear in the value, so the most
 * any visible value moves is at one end of the old range.
 */
export function rangeShiftPx(
  lo: number,
  hi: number,
  nlo: number,
  nhi: number,
  plotPx: number,
): number {
  if (!(hi > lo) || !(nhi > nlo)) {
    return 0;
  }
  const at = (v: number) => ((v - lo) / (hi - lo) - (v - nlo) / (nhi - nlo)) * plotPx;
  return Math.max(Math.abs(at(lo)), Math.abs(at(hi)));
}

/** The smallest half span `autoRange` shows, relative to the data's size (at least 1). */
const MIN_HALF_SPAN = 1e-6;

/** How `autoRange` fits an axis to its data. */
export interface AutoRangeOptions {
  /** Room left above and below the data, as a share of its span. */
  pad: number;
  /** Rescale when the data comes within this share of the span of either edge. */
  edge: number;
  /** Rescale when the data fills less than this share of the span. */
  minFill: number;
  /** The smallest span shown, in value units (so flat data doesn't zoom in on noise). */
  minSpan: number;
  /** The shortest rescale, s. Larger moves take longer, within the codec motion limits. */
  minSeconds: number;
}

/**
 * Keeps an axis fitted to data spanning `dataLo`..`dataHi`: the target range
 * changes only when the data nears an edge or shrinks well inside it, so the
 * axis sits still most of the time, and each change tweens slowly enough that
 * no gridline moves faster than the codec limits on a `plotPx`-tall plot at
 * `scale` (device px per reference px). The first call snaps. Returns whether
 * it retargeted.
 */
export function autoRange(
  r: AxisRange,
  dataLo: number,
  dataHi: number,
  plotPx: number,
  scale: number,
  o: AutoRangeOptions,
): boolean {
  if (!Number.isFinite(dataLo) || !Number.isFinite(dataHi) || dataHi < dataLo) {
    return false;
  }
  const mid = (dataLo + dataHi) / 2;
  // A tiny floor keeps flat data with no `minSpan` from collapsing the span to 0.
  const minHalf = Math.max(o.minSpan / 2, Math.max(1, Math.abs(mid)) * MIN_HALF_SPAN);
  const span = r.toHi - r.toLo;
  const fits =
    r.ready &&
    span > 0 &&
    dataLo >= r.toLo + o.edge * span &&
    dataHi <= r.toHi - o.edge * span &&
    (dataHi - dataLo >= o.minFill * span || span <= 2 * minHalf * (1 + 1e-9));
  if (fits) {
    return false;
  }
  const half = Math.max((dataHi - dataLo) * (0.5 + o.pad), minHalf);
  const lo = mid - half;
  const hi = mid + half;
  if (!r.ready) {
    snapAxis(r, lo, hi);
    return true;
  }
  const shift = rangeShiftPx(r.lo, r.hi, lo, hi, plotPx);
  const seconds = Math.max(o.minSeconds, minTweenSeconds(shift / (scale > 0 ? scale : 1)));
  tweenAxis(r, lo, hi, seconds);
  return true;
}

/**
 * Device y of value `v` on a plot from `top` to `bottom` showing `r`; the middle
 * of the plot for an empty range.
 */
export const valueY = (v: number, r: AxisRange, top: number, bottom: number): number =>
  r.hi > r.lo ? bottom - ((v - r.lo) / (r.hi - r.lo)) * (bottom - top) : (top + bottom) / 2;

// ---------------------------------------------------------------------------
// Mesh

/**
 * Floats per vertex: position (px), then the edge pair (signed distance across
 * the mark in px, and its half width), then straight RGBA.
 */
export const CHART_STRIDE = 8;

/** Anything holding a colour's r, g, b in [0] to [2] (0..1). */
type Rgb = ArrayLike<number>;

/** A growable-to-capacity triangle list; marks past the capacity are dropped. */
export interface ChartMesh {
  readonly data: Float32Array;
  /** Vertices written. */
  count: number;
  readonly capacity: number;
}

export const createChartMesh = (capacity: number): ChartMesh => ({
  data: new Float32Array(capacity * CHART_STRIDE),
  count: 0,
  capacity,
});

/** A half width that counts as solid everywhere: rects and area fills. */
const SOLID = 1e4;

function vertex(
  m: ChartMesh,
  x: number,
  y: number,
  d: number,
  hw: number,
  c: Rgb,
  a: number,
): void {
  const o = m.count * CHART_STRIDE;
  const v = m.data;
  v[o] = x;
  v[o + 1] = y;
  v[o + 2] = d;
  v[o + 3] = hw;
  v[o + 4] = c[0];
  v[o + 5] = c[1];
  v[o + 6] = c[2];
  v[o + 7] = a;
  m.count++;
}

/** Whether `n` more vertices fit. */
const room = (m: ChartMesh, n: number) => m.count + n <= m.capacity;

/**
 * A solid rect from (`x0`, `y0`) to (`x1`, `y1`), edges snapped to whole pixels so
 * it lands crisply (at least one pixel across where it has any size at all).
 */
export function pushRect(
  m: ChartMesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  a: number,
): void {
  if (!(a > 0) || !room(m, 6)) {
    return;
  }
  const l = Math.round(Math.min(x0, x1));
  let r = Math.round(Math.max(x0, x1));
  const t = Math.round(Math.min(y0, y1));
  let b = Math.round(Math.max(y0, y1));
  if (r === l) {
    if (x0 === x1) {
      return;
    }
    r = l + 1;
  }
  if (b === t) {
    if (y0 === y1) {
      return;
    }
    b = t + 1;
  }
  if (!Number.isFinite(l + r + t + b)) {
    return;
  }
  // Two triangles; the edge pair marks every point solid.
  vertex(m, l, t, 0, SOLID, c, a);
  vertex(m, r, t, 0, SOLID, c, a);
  vertex(m, l, b, 0, SOLID, c, a);
  vertex(m, r, t, 0, SOLID, c, a);
  vertex(m, r, b, 0, SOLID, c, a);
  vertex(m, l, b, 0, SOLID, c, a);
}

/**
 * Horizontal gridlines `lineW` px thick across the plot (`x`, `y`, `w`, `h`) at
 * each of `ticks`, placed by `r` and rounded to whole pixels. A line that lands
 * above the plot or on or below its bottom edge is skipped (on the bottom edge
 * kept with `withBottom`).
 */
export function pushGridlines(
  m: ChartMesh,
  ticks: Ticks,
  r: AxisRange,
  x: number,
  y: number,
  w: number,
  h: number,
  c: Rgb,
  a: number,
  lineW = 1,
  withBottom = false,
): void {
  for (let i = 0; i < ticks.count; i++) {
    const gy = Math.round(valueY(tickAt(ticks, i), r, y, y + h));
    if (gy >= y && (withBottom ? gy <= y + h : gy < y + h)) {
      pushRect(m, x, gy, x + w, gy + lineW, c, a);
    }
  }
}

/**
 * A solid quad through (`x0`, `y0`), (`x1`, `y1`), (`x2`, `y2`), (`x3`, `y3`) in
 * order round its edge, not snapped: for slanted faces, such as the top and side
 * of a bar drawn in 3D. Its edges aren't antialiased.
 */
export function pushQuad(
  m: ChartMesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x3: number,
  y3: number,
  c: Rgb,
  a: number,
): void {
  if (!(a > 0) || !room(m, 6) || !Number.isFinite(x0 + y0 + x1 + y1 + x2 + y2 + x3 + y3)) {
    return;
  }
  vertex(m, x0, y0, 0, SOLID, c, a);
  vertex(m, x1, y1, 0, SOLID, c, a);
  vertex(m, x2, y2, 0, SOLID, c, a);
  vertex(m, x0, y0, 0, SOLID, c, a);
  vertex(m, x2, y2, 0, SOLID, c, a);
  vertex(m, x3, y3, 0, SOLID, c, a);
}

/** Corner flags for `pushRoundRect`. */
export const CORNER_TOP_LEFT = 1;
export const CORNER_TOP_RIGHT = 2;
/** The bottom corners are 4 (right) and 8 (left); all four is 15. */
const ALL_CORNERS = 15;

/** Most segments in a rounded corner. */
const MAX_CORNER_SEGMENTS = 16;

/**
 * A solid rect from (`x0`, `y0`) to (`x1`, `y1`) with the `corners` (flags above)
 * rounded to `radius` px and antialiased, its edges snapped to whole pixels like
 * `pushRect`. The pieces never overlap, so a translucent card has no seams. The
 * radius is cut to half the shorter side; under a pixel it is a plain rect.
 */
export function pushRoundRect(
  m: ChartMesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  c: Rgb,
  a: number,
  corners: number = ALL_CORNERS,
): void {
  const l = Math.round(Math.min(x0, x1));
  const r = Math.round(Math.max(x0, x1));
  const t = Math.round(Math.min(y0, y1));
  const b = Math.round(Math.max(y0, y1));
  const rad = Math.floor(Math.min(radius, (r - l) / 2, (b - t) / 2));
  if (!(rad >= 1) || (corners & ALL_CORNERS) === 0 || !Number.isFinite(l + r + t + b)) {
    pushRect(m, l, t, r, b, c, a);
    return;
  }
  if (!(a > 0)) {
    return;
  }
  const segments = Math.min(
    MAX_CORNER_SEGMENTS,
    Math.max(2, Math.ceil(((Math.PI / 2) * rad) / ARC_SEGMENT_PX)),
  );
  // Bands: the middle, full width; then top and bottom between the corner squares.
  pushRect(m, l, t + rad, r, b - rad, c, a);
  pushRect(m, l + rad, t, r - rad, t + rad, c, a);
  pushRect(m, l + rad, b - rad, r - rad, b, c, a);
  // Each corner: a quarter fan whose edge distance runs from 0 at the centre to
  // the radius plus one pixel of fringe at the rim, so it fades out at `rad`.
  for (let k = 0; k < 4; k++) {
    const flag = 1 << k;
    const right = k === 1 || k === 2;
    const bottom = k >= 2;
    const cx = right ? r - rad : l + rad;
    const cy = bottom ? b - rad : t + rad;
    if ((corners & flag) === 0) {
      pushRect(m, cx, cy, right ? r : l, bottom ? b : t, c, a);
      continue;
    }
    if (!room(m, 3 * segments)) {
      return;
    }
    // Clockwise from twelve o'clock: top-left spans 270..360, top-right 0..90 and so on.
    const start = (k === 0 ? 3 : k - 1) * (Math.PI / 2);
    const ext = rad + 1;
    let px = cx + Math.sin(start) * ext;
    let py = cy - Math.cos(start) * ext;
    for (let i = 1; i <= segments; i++) {
      const ang = start + ((Math.PI / 2) * i) / segments;
      const qx = cx + Math.sin(ang) * ext;
      const qy = cy - Math.cos(ang) * ext;
      vertex(m, cx, cy, 0, rad, c, a);
      vertex(m, px, py, ext, rad, c, a);
      vertex(m, qx, qy, ext, rad, c, a);
      px = qx;
      py = qy;
    }
  }
}

/** Writes the quad (p0 ± e0) to (p1 ± e1) with the edge distance ±`ext` across it. */
function quadAcross(
  m: ChartMesh,
  x0: number,
  y0: number,
  ex0: number,
  ey0: number,
  x1: number,
  y1: number,
  ex1: number,
  ey1: number,
  ext: number,
  hw: number,
  c: Rgb,
  a: number,
): void {
  vertex(m, x0 + ex0, y0 + ey0, ext, hw, c, a);
  vertex(m, x1 + ex1, y1 + ey1, ext, hw, c, a);
  vertex(m, x0 - ex0, y0 - ey0, -ext, hw, c, a);
  vertex(m, x1 + ex1, y1 + ey1, ext, hw, c, a);
  vertex(m, x1 - ex1, y1 - ey1, -ext, hw, c, a);
  vertex(m, x0 - ex0, y0 - ey0, -ext, hw, c, a);
}

/** An antialiased straight line `width` px wide, with butt ends. */
export function pushLine(
  m: ChartMesh,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  c: Rgb,
  a: number,
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (!(a > 0) || !(len > 0) || !(width > 0) || !room(m, 6) || !Number.isFinite(len)) {
    return;
  }
  const hw = width / 2;
  // One pixel of fringe beyond the half width, for the antialiased edge.
  const ext = hw + 1;
  const nx = (-dy / len) * ext;
  const ny = (dx / len) * ext;
  quadAcross(m, x0, y0, nx, ny, x1, y1, nx, ny, ext, hw, c, a);
}

/** The clipped run of a line's points, set by `clipLine`. */
export interface LineClip {
  from: number;
  count: number;
}

/**
 * Clips points `0 .. n - 1` of `xs` / `ys` (x ascending) to [left, right] in
 * place: the first point outside each end moves onto the edge, interpolated, so
 * the line runs right up to it. Sets `out` to the run left inside (count 0 when
 * every point is left of `left`) and returns its count.
 */
export function clipLine(
  xs: { [i: number]: number },
  ys: { [i: number]: number },
  n: number,
  left: number,
  right: number,
  out: LineClip,
): number {
  let i0 = 0;
  while (i0 < n && xs[i0] < left) {
    i0++;
  }
  if (i0 >= n) {
    out.from = 0;
    out.count = 0;
    return 0;
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
  out.from = i0;
  out.count = i1 - i0 + 1;
  return out.count;
}

/** Longest a miter may get, as a multiple of the half width, before it is cut short. */
const MITER_LIMIT = 2.5;

/**
 * An antialiased polyline through points `from .. from + n - 1` of `xs`, `ys`,
 * `width` px wide, with mitred joins (so a translucent line doesn't darken at
 * its joints).
 */
export function pushPolyline(
  m: ChartMesh,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  from: number,
  n: number,
  width: number,
  c: Rgb,
  a: number,
): void {
  if (!(a > 0) || n < 2 || !(width > 0) || !room(m, 6 * (n - 1))) {
    return;
  }
  const hw = width / 2;
  const ext = hw + 1;
  let px = 0;
  let py = 0;
  let pex = 0;
  let pey = 0;
  // Unit normal of the segment into the current point; none before the first.
  let n0x = 0;
  let n0y = 0;
  let kept = false;
  for (let i = 0; i < n; i++) {
    const x = xs[from + i];
    const y = ys[from + i];
    // A repeat of the last point adds no segment, and its zero normal would bend
    // the joints either side of it, so skip it.
    if (kept && x === px && y === py) {
      continue;
    }
    // Unit normal of the segment out of point i, to the next point that differs.
    let j = i + 1;
    while (j < n && xs[from + j] === x && ys[from + j] === y) {
      j++;
    }
    let n1x = n0x;
    let n1y = n0y;
    if (j < n) {
      const dx = xs[from + j] - x;
      const dy = ys[from + j] - y;
      const l = Math.hypot(dx, dy) || 1;
      n1x = -dy / l;
      n1y = dx / l;
    }
    if (!kept) {
      n0x = n1x;
      n0y = n1y;
    }
    let mx = n0x + n1x;
    let my = n0y + n1y;
    const ml = Math.hypot(mx, my);
    if (ml > 1e-6) {
      mx /= ml;
      my /= ml;
    } else {
      mx = n1x;
      my = n1y;
    }
    // Lengthen the miter so the line keeps its width through the bend.
    const cos = mx * n1x + my * n1y;
    const k = Math.min(MITER_LIMIT, 1 / Math.max(1 / MITER_LIMIT, cos));
    const ex = mx * ext * k;
    const ey = my * ext * k;
    if (kept && Number.isFinite(px + py + x + y)) {
      quadAcross(m, px, py, pex, pey, x, y, ex, ey, ext, hw, c, a);
    }
    kept = true;
    px = x;
    py = y;
    pex = ex;
    pey = ey;
    n0x = n1x;
    n0y = n1y;
  }
}

/**
 * The fill under a polyline (points `from .. from + n - 1`) down to `baseY`,
 * fading from `topAlpha` along the line to `baseAlpha` at the base.
 */
export function pushArea(
  m: ChartMesh,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  from: number,
  n: number,
  baseY: number,
  c: Rgb,
  topAlpha: number,
  baseAlpha: number,
): void {
  if (!(topAlpha > 0 || baseAlpha > 0) || n < 2 || !room(m, 6 * (n - 1))) {
    return;
  }
  for (let i = 0; i + 1 < n; i++) {
    const x0 = xs[from + i];
    const y0 = ys[from + i];
    const x1 = xs[from + i + 1];
    const y1 = ys[from + i + 1];
    if (!Number.isFinite(x0 + y0 + x1 + y1)) {
      continue;
    }
    vertex(m, x0, y0, 0, SOLID, c, topAlpha);
    vertex(m, x1, y1, 0, SOLID, c, topAlpha);
    vertex(m, x0, baseY, 0, SOLID, c, baseAlpha);
    vertex(m, x1, y1, 0, SOLID, c, topAlpha);
    vertex(m, x1, baseY, 0, SOLID, c, baseAlpha);
    vertex(m, x0, baseY, 0, SOLID, c, baseAlpha);
  }
}

/**
 * A candlestick centred on `cx`: a `bodyWidth` body from `yOpen` to `yClose` (at
 * least one pixel tall) and a `wickWidth` wick from `yHigh` to `yLow`, both
 * pixel-snapped.
 */
export function pushCandle(
  m: ChartMesh,
  cx: number,
  bodyWidth: number,
  wickWidth: number,
  yOpen: number,
  yClose: number,
  yHigh: number,
  yLow: number,
  c: Rgb,
  a: number,
): void {
  const ww = Math.max(1, Math.round(wickWidth));
  const wx = Math.round(cx - ww / 2);
  pushRect(m, wx, Math.min(yHigh, yLow), wx + ww, Math.max(yHigh, yLow), c, a);
  const bw = Math.max(1, Math.round(bodyWidth));
  const bx = Math.round(cx - bw / 2);
  const top = Math.round(Math.min(yOpen, yClose));
  const bottom = Math.max(top + 1, Math.round(Math.max(yOpen, yClose)));
  pushRect(m, bx, top, bx + bw, bottom, c, a);
}

/** Device px per arc segment along the outer edge: small enough to look round. */
const ARC_SEGMENT_PX = 4;
const MAX_ARC_SEGMENTS = 128;

/**
 * A donut segment around (`cx`, `cy`) between radii `r0` and `r1`, from angle
 * `a0` to `a1` in radians, clockwise from twelve o'clock, with antialiased inner
 * and outer edges. An `r0` under a pixel (such as 0, or -1 for a dot with a solid
 * centre) draws a filled pie as a fan, so a translucent one doesn't overlap itself
 * at the centre.
 */
export function pushArc(
  m: ChartMesh,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  c: Rgb,
  a: number,
): void {
  const sweep = a1 - a0;
  if (!(a > 0) || !(r1 > r0) || !(Math.abs(sweep) > 0) || !Number.isFinite(sweep)) {
    return;
  }
  const segments = Math.min(
    MAX_ARC_SEGMENTS,
    Math.max(1, Math.ceil((Math.abs(sweep) * r1) / ARC_SEGMENT_PX)),
  );
  if (!room(m, 6 * segments)) {
    return;
  }
  const hw = (r1 - r0) / 2;
  const mid = (r0 + r1) / 2;
  const ext = hw + 1;
  let s0 = Math.sin(a0);
  let c0 = Math.cos(a0);
  for (let i = 1; i <= segments; i++) {
    const t = a0 + (sweep * i) / segments;
    const s1 = Math.sin(t);
    const c1 = Math.cos(t);
    if (mid < ext) {
      // The inner fringe would cross the centre (a filled dot, `r0` <= 0), so the
      // segments overlap there: stop it at the centre, as a fan, with the edge
      // distance it has there.
      const out = mid + ext;
      vertex(m, cx + s0 * out, cy - c0 * out, ext, hw, c, a);
      vertex(m, cx + s1 * out, cy - c1 * out, ext, hw, c, a);
      vertex(m, cx, cy, -mid, hw, c, a);
      s0 = s1;
      c0 = c1;
      continue;
    }
    // Points on the mid radius, pushed out and in along the radius by `ext`.
    quadAcross(
      m,
      cx + s0 * mid,
      cy - c0 * mid,
      s0 * ext,
      -c0 * ext,
      cx + s1 * mid,
      cy - c1 * mid,
      s1 * ext,
      -c1 * ext,
      ext,
      hw,
      c,
      a,
    );
    s0 = s1;
    c0 = c1;
  }
}

// ---------------------------------------------------------------------------
// Renderer

const CHART_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aEdge;
layout(location = 2) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vEdge;
out vec4 vColor;
void main() {
  vEdge = aEdge;
  vColor = aColor;
  gl_Position = vec4(aPos.x / uResolution.x * 2.0 - 1.0, 1.0 - aPos.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const CHART_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vEdge;
in vec4 vColor;
out vec4 outColor;
void main() {
  // Coverage across a line or arc: full inside the half width, a one-pixel ramp at the edge.
  float cover = clamp(vEdge.y + 0.5 - abs(vEdge.x), 0.0, 1.0) * min(1.0, 2.0 * vEdge.y);
  float a = vColor.a * cover;
  outColor = vec4(vColor.rgb * a, a);
}
`;

/** A chart mesh and the program that draws it. */
export interface ChartRenderer {
  readonly mesh: ChartMesh;
  /** Uploads the mesh's vertices; call once a frame after writing them. */
  upload: () => void;
  /**
   * Draws vertices `first .. first + count - 1` on a `width` x `height` target.
   * The output is premultiplied: blend with `ONE, ONE_MINUS_SRC_ALPHA`. Leaves
   * the program bound and no vertex array bound.
   */
  draw: (width: number, height: number, first: number, count: number) => void;
}

/** A chart mesh of up to `capacity` vertices with its buffer and program, owned by `scope`. */
export function createChartRenderer(
  gl: WebGL2RenderingContext,
  scope: Scope,
  capacity: number,
): ChartRenderer {
  const mesh = createChartMesh(capacity);
  const program = scopedProgram(gl, scope, CHART_VERTEX, CHART_FRAGMENT);
  const u = createUniforms(gl, program, ["uResolution"]);
  const vao = scope.add(gl.createVertexArray(), (v) => {
    gl.deleteVertexArray(v);
  });
  const buffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.data.byteLength, gl.DYNAMIC_DRAW);
  const bytes = CHART_STRIDE * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, bytes, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, bytes, 16);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  return {
    mesh,
    upload() {
      if (mesh.count > 0) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.data, 0, mesh.count * CHART_STRIDE);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
    },
    draw(width, height, first, count) {
      const n = Math.min(count, mesh.count - first);
      if (n <= 0) {
        return;
      }
      gl.useProgram(program);
      u.f2("uResolution", width, height);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, first, n);
      gl.bindVertexArray(null);
    },
  };
}
