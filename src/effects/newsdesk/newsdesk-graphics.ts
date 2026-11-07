/**
 * The Evening News Desk's on-screen graphics, drawn with a 2D canvas at the
 * frame's device-pixel size so the GPU can copy them texel for texel: the lower
 * third (name and title bars), the ticker's strip of text, and the LIVE tag
 * with the clock. Each is drawn only when its text, colour or size changes.
 */
import type { Rgb } from "../color";
import { barWidth, fitTextSize, type GraphicsLayout, TICKER_ROW, tickerLine } from "./newsdesk-sim";

/** A clean system sans-serif. */
const FONT_FAMILY = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;
/** Capital height as a share of the font size, for centring text in a bar. */
const CAP_RATIO = 0.72;
/** Tallest texture the ticker's rows may stack to. */
const MAX_TICKER_TEXELS = 4096;
/** Widest any other graphic may be, in texels. */
const MAX_GRAPHIC_TEXELS = 4096;
/** The ticker's stories repeat with this between the end and the start. */
const TICKER_JOIN = "   •   ";

/** A drawn graphic: its canvas, ready to upload. */
export interface Graphic {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

/** The ticker's strip: rows of `TICKER_ROW` texels, `rowH` tall, holding one `period` of text. */
export interface TickerStrip extends Graphic {
  period: number;
  rowH: number;
}

type Ctx = OffscreenCanvasRenderingContext2D;

function canvas2d(width: number, height: number): [OffscreenCanvas, Ctx] | null {
  if (typeof OffscreenCanvas === "undefined" || width < 1 || height < 1) {
    return null;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  return ctx ? [canvas, ctx] : null;
}

/** `text`'s width in font sizes at `weight`, or an estimate if the canvas can't measure. */
function emWidth(ctx: Ctx, text: string, weight: number): number {
  if (text === "") {
    return 0;
  }
  ctx.font = `${String(weight)} 100px ${FONT_FAMILY}`;
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const w = (ctx.measureText(text) as TextMetrics | undefined)?.width;
  return typeof w === "number" && w > 0 ? w / 100 : 0.6 * Array.from(text).length;
}

/** A vertical gradient from y0 to y1, or its first colour if the canvas can't make one. */
function vertical(
  ctx: Ctx,
  y0: number,
  y1: number,
  stops: readonly (readonly [number, string])[],
): CanvasGradient | string {
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const grad = ctx.createLinearGradient(0, y0, 0, y1) as CanvasGradient | undefined;
  if (!grad) {
    return stops[0][1];
  }
  for (const [at, colour] of stops) {
    grad.addColorStop(at, colour);
  }
  return grad;
}

const rgbCss = (c: Rgb, k: number, add = 0) =>
  `rgb(${[0, 1, 2].map((i) => String(Math.round(255 * Math.min(1, Math.max(0, c[i] * k + add))))).join(",")})`;

/**
 * The lower third for `name` and `title` (either may be empty, but not both)
 * in the bar colour `accent`, for a frame `frameH` pixels tall: a coloured
 * name bar with a slanted end over a pale title bar. The bars fit the longer
 * line, up to the layout's widest; longer lines shrink to fit that.
 */
export function drawLowerThird(
  name: string,
  title: string,
  accent: Rgb,
  g: GraphicsLayout,
  frameH: number,
): Graphic | null {
  const nh = Math.max(4, Math.round(g.nameH * frameH));
  const th = title === "" ? 0 : Math.max(3, Math.round(g.titleH * frameH));
  const pad = g.pad * frameH;
  const block = Math.round(0.012 * frameH);
  const slant = Math.round(0.25 * nh);
  const probe = canvas2d(1, 1);
  if (!probe) {
    return null;
  }
  const nameEm = emWidth(probe[1], name, 700);
  const titleEm = emWidth(probe[1], title, 600);
  const maxText = Math.max(1, g.maxWidth * frameH - 2 * pad - block - slant);
  const nameSize = fitTextSize(nameEm, (0.44 * nh) / CAP_RATIO, maxText);
  const titleSize = fitTextSize(titleEm, (0.4 * Math.max(th, 1)) / CAP_RATIO, maxText);
  const textW = Math.max(nameEm * nameSize, title === "" ? 0 : titleEm * titleSize);
  const bw = Math.min(
    MAX_GRAPHIC_TEXELS,
    Math.round(barWidth((textW + block + slant) / frameH, g) * frameH),
  );
  const made = canvas2d(bw, nh + th);
  if (!made) {
    return null;
  }
  const [canvas, ctx] = made;
  ctx.clearRect(0, 0, bw, nh + th);

  // The name bar: the accent with a soft sheen, a darker block at its start and a highlight along its top.
  ctx.fillStyle = vertical(ctx, 0, nh, [
    [0, rgbCss(accent, 1.15, 0.06)],
    [0.5, rgbCss(accent, 1)],
    [1, rgbCss(accent, 0.72)],
  ]);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(bw, 0);
  ctx.lineTo(bw - slant, nh);
  ctx.lineTo(0, nh);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = rgbCss(accent, 0.5);
  ctx.fillRect(0, 0, block, nh);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(0, 0, bw - 1, Math.max(1, Math.round(nh * 0.03)));

  // The title bar: pale silver, a touch shorter.
  if (th > 0) {
    ctx.fillStyle = vertical(ctx, nh, nh + th, [
      [0, "#f3f5f9"],
      [1, "#c6cfdc"],
    ]);
    const tw = bw - slant;
    const ts = Math.round(0.25 * th);
    ctx.beginPath();
    ctx.moveTo(0, nh);
    ctx.lineTo(tw, nh);
    ctx.lineTo(tw - ts, nh + th);
    ctx.lineTo(0, nh + th);
    ctx.closePath();
    ctx.fill();
  }

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const x = block + pad;
  if (name !== "") {
    ctx.font = `700 ${String(nameSize)}px ${FONT_FAMILY}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(name, x, nh / 2 + (CAP_RATIO * nameSize) / 2);
  }
  if (th > 0) {
    ctx.font = `600 ${String(titleSize)}px ${FONT_FAMILY}`;
    ctx.fillStyle = "#0c1a36";
    ctx.fillText(title, x, nh + th / 2 + (CAP_RATIO * titleSize) / 2);
  }
  return { canvas, width: bw, height: nh + th };
}

/**
 * The ticker's text, white on clear, once round: its stories joined by bullets,
 * then a bullet back to the start, so the strip repeats seamlessly every
 * `period` texels. A long strip wraps onto rows of `TICKER_ROW` texels.
 */
export function drawTicker(text: string, g: GraphicsLayout, frameH: number): TickerStrip | null {
  const line = tickerLine(text);
  if (line === "") {
    return null;
  }
  const rowH = Math.max(4, Math.round(g.tickerH * frameH));
  const probe = canvas2d(1, 1);
  if (!probe) {
    return null;
  }
  const strip = line + TICKER_JOIN;
  const em = emWidth(probe[1], strip, 600);
  let size = (0.38 * rowH) / CAP_RATIO;
  // Shrink rather than run out of rows.
  const maxRows = Math.max(1, Math.floor(MAX_TICKER_TEXELS / rowH));
  size = Math.min(size, (maxRows * TICKER_ROW - 1) / Math.max(em, 0.01));
  const period = Math.max(1, Math.ceil(em * size));
  const rows = Math.ceil(period / TICKER_ROW);
  const width = Math.min(period, TICKER_ROW);
  const made = canvas2d(width, rows * rowH);
  if (!made) {
    return null;
  }
  const [canvas, ctx] = made;
  ctx.clearRect(0, 0, width, rows * rowH);
  ctx.font = `600 ${String(size)}px ${FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  for (let r = 0; r < rows; r++) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, r * rowH, width, rowH);
    ctx.clip();
    const y = r * rowH + rowH / 2 + (CAP_RATIO * size) / 2;
    ctx.fillText(strip, -r * TICKER_ROW, y);
    ctx.restore();
  }
  return { canvas, width, height: rows * rowH, period, rowH };
}

/** The LIVE tag (white on red) and, beside it, the clock's `time` on dark glass. */
export function drawLiveTag(time: string, g: GraphicsLayout, frameH: number): Graphic | null {
  const h = Math.max(4, Math.round(g.liveH * frameH));
  const probe = canvas2d(1, 1);
  if (!probe) {
    return null;
  }
  const size = (0.42 * h) / CAP_RATIO;
  const liveW = Math.round(emWidth(probe[1], "LIVE", 800) * size + 0.7 * h);
  // Measure a fixed pattern so the box keeps its width as the digits change.
  const clockW = Math.round(emWidth(probe[1], "00:00", 600) * size + 0.7 * h);
  const gap = Math.round(0.18 * h);
  const width = Math.min(MAX_GRAPHIC_TEXELS, liveW + gap + clockW);
  const made = canvas2d(width, h);
  if (!made) {
    return null;
  }
  const [canvas, ctx] = made;
  ctx.clearRect(0, 0, width, h);
  ctx.fillStyle = vertical(ctx, 0, h, [
    [0, "#e2283a"],
    [1, "#a50f1f"],
  ]);
  ctx.fillRect(0, 0, liveW, h);
  ctx.fillStyle = "rgba(6,12,30,0.78)";
  ctx.fillRect(liveW + gap, 0, clockW, h);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  const y = h / 2 + (CAP_RATIO * size) / 2;
  ctx.font = `800 ${String(size)}px ${FONT_FAMILY}`;
  ctx.fillText("LIVE", liveW / 2, y);
  ctx.font = `600 ${String(size)}px ${FONT_FAMILY}`;
  ctx.fillText(time, liveW + gap + clockW / 2, y);
  return { canvas, width, height: h };
}
