/**
 * The painted parts of Stonks, with no GL: the caption (bold white with a drop
 * shadow on the terminal, rainbow WordArt on the slide), the big bevelled
 * arrow, and the ticker items and axis labels drawn into the text layer in its
 * role colours.
 */
import { paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { linearGradient, rainbowStops, drawOutlinedText } from "../meme-art";
import { TEXT_ROLES } from "../text-layer";
import { formatGain, formatPrice, type TickerItem } from "./stonks-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

export type StyleId = "terminal" | "clipart";

/** The early-2000s presentation WordArt stack; no font is bundled. */
const WORDART_FONT_STACK = `"Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;

/** A canvas font string for `style`'s caption at `px` px. */
const captionFont = (style: StyleId, px: number): string =>
  `900 ${String(px)}px ${style === "clipart" ? WORDART_FONT_STACK : SANS_FONT_STACK}`;

/** Measures `text` in `font`, in px; undefined where there is nothing to measure with. */
type Measure = (text: string, font: string) => number | undefined;

/** A measurer on its own 1 x 1 canvas, or one that measures nothing without a canvas. */
export function createMeasure(): Measure {
  let ctx: Ctx | null | undefined;
  return (text, font) => {
    if (ctx === undefined) {
      const canvas = paintCanvas(1, 1, () => undefined);
      ctx = canvas ? canvas.getContext("2d") : null;
    }
    if (!ctx) {
      return undefined;
    }
    ctx.font = font;
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(text) as TextMetrics | undefined;
    return metrics === undefined ? undefined : metrics.width;
  };
}

/** A guess at a bold string's width, for when it can't be measured. */
const guessWidth = (text: string, px: number) => Array.from(text).length * 0.68 * px;

/** The WordArt's slant, as x per y. */
const SLANT = 0.18;

/**
 * The caption's font size (px) and canvas size: `px` shrunk so the text fits
 * `maxWidth`, with room round it for the outline, shadow and slant.
 */
function captionSize(
  text: string,
  style: StyleId,
  px: number,
  maxWidth: number,
  measure: Measure,
): { px: number; width: number; height: number } {
  const w = measure(text, captionFont(style, px)) ?? guessWidth(text, px);
  const fit = w > 0 ? Math.min(px, (px * maxWidth) / w) : px;
  const size = Math.max(4, Math.floor(fit));
  const textW = (w * size) / px;
  const pad = Math.ceil(size * (style === "clipart" ? 0.12 + SLANT : 0.12));
  return {
    px: size,
    width: Math.max(1, Math.ceil(textW + 2 * pad)),
    height: Math.max(1, Math.ceil(size * 1.3 + pad)),
  };
}

/**
 * The caption on a transparent canvas: bold white with a soft drop shadow for
 * the terminal, a slanted rainbow WordArt with a dark outline and a hard grey
 * shadow for the slide. Null where there is no canvas.
 */
export function paintCaption(
  text: string,
  style: StyleId,
  px: number,
  maxWidth: number,
  measure: Measure,
): OffscreenCanvas | null {
  const s = captionSize(text, style, px, maxWidth, measure);
  return paintCanvas(s.width, s.height, (ctx) => {
    ctx.font = captionFont(style, s.px);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const base = s.px * 1.02;
    const pad = Math.ceil(s.px * 0.12);
    if (style === "terminal") {
      ctx.shadowColor = "rgba(0, 0, 0, 0.65)";
      ctx.shadowBlur = s.px * 0.08;
      ctx.shadowOffsetX = s.px * 0.03;
      ctx.shadowOffsetY = s.px * 0.04;
      ctx.fillStyle = "#ffffff";
      ctx.fillText(text, pad, base + pad / 2);
      return;
    }
    // WordArt: slanted, a hard grey shadow, then the outlined rainbow.
    ctx.setTransform(1, 0, -SLANT, 1, s.px * SLANT, 0);
    ctx.fillStyle = "rgba(60, 60, 80, 0.45)";
    ctx.fillText(text, pad + s.px * 0.05, base + pad / 2 + s.px * 0.05);
    const fill = linearGradient(ctx, pad, 0, s.width - pad, 0, rainbowStops());
    drawOutlinedText(ctx, text, pad, base + pad / 2, fill, "#1b2350", Math.max(2, s.px * 0.06));
  });
}

/**
 * The arrow's outline in a unit square (0..1, y down), pointing up and to the
 * right: a chunky shaft and a wide head.
 */
const ARROW_ANGLE = -Math.PI * 0.22;
const ARROW_SHAPE = [
  [-0.42, -0.1],
  [0.1, -0.1],
  [0.1, -0.24],
  [0.44, 0],
  [0.1, 0.24],
  [0.1, 0.1],
  [-0.42, 0.1],
] as const;

function arrowPath(ctx: Ctx, size: number): void {
  const c = Math.cos(ARROW_ANGLE);
  const s = Math.sin(ARROW_ANGLE);
  ctx.beginPath();
  ARROW_SHAPE.forEach(([x, y], k) => {
    const px = (0.5 + x * c - y * s) * size;
    const py = (0.5 + x * s + y * c) * size;
    if (k === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  });
  ctx.closePath();
}

/**
 * The big arrow on a `size` px square canvas, bevelled with a gradient across
 * it. The terminal one is in greys and lit with a glow, for the shader to tint
 * with the line's colour; the slide one is orange to red with a dark outline
 * and a drop shadow. Null where there is no canvas.
 */
export function paintArrow(style: StyleId, size: number): OffscreenCanvas | null {
  const px = Math.max(8, Math.round(size));
  return paintCanvas(px, px, (ctx) => {
    // The bevel runs across the shaft: lit on its upper-left edge, shaded below.
    const ux = Math.sin(ARROW_ANGLE) * 0.24 * px;
    const uy = -Math.cos(ARROW_ANGLE) * 0.24 * px;
    const cx = px / 2;
    const cy = px / 2;
    ctx.lineJoin = "round";
    if (style === "terminal") {
      ctx.shadowColor = "rgba(255, 255, 255, 0.7)";
      ctx.shadowBlur = px * 0.06;
      arrowPath(ctx, px);
      ctx.fillStyle = linearGradient(ctx, cx + ux, cy + uy, cx - ux, cy - uy, [
        [0, "#ffffff"],
        [0.45, "#d8d8d8"],
        [0.55, "#9a9a9a"],
        [1, "#6a6a6a"],
      ]);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1, px * 0.008);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.translate(px * 0.025, px * 0.035);
    arrowPath(ctx, px);
    ctx.fillStyle = "rgba(40, 40, 60, 0.35)";
    ctx.fill();
    ctx.restore();
    arrowPath(ctx, px);
    ctx.fillStyle = linearGradient(ctx, cx + ux, cy + uy, cx - ux, cy - uy, [
      [0, "#ffd36b"],
      [0.45, "#ff8a1f"],
      [0.55, "#f05a14"],
      [1, "#b52b0c"],
    ]);
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, px * 0.012);
    ctx.strokeStyle = "#5a1a08";
    ctx.stroke();
  });
}

// ---------------------------------------------------------------------------
// Text layer art

/** The ticker's fonts: a bold symbol, then the figures. */
const tickerSymbolFont = (px: number) => `700 ${String(px)}px ${SANS_FONT_STACK}`;
const tickerFigureFont = (px: number) => `500 ${String(px)}px ${SANS_FONT_STACK}`;
const labelFont = (px: number) => `500 ${String(px)}px ${SANS_FONT_STACK}`;

/**
 * The widest symbol and figures an item reserves room for, so a price change
 * never moves the tape. Prices and gains past a million read "1.23e403", whose
 * exponent keeps growing: five exponent digits last over a year of uptime.
 */
const WIDEST_SYMBOL = "DIAMND";
const WIDEST_FIGURES = "▲ 0.00e00000 +0.00e00000%";

/** The gap between items and between an item's symbol and figures, in ems. */
const ITEM_GAP_EM = 1.6;
const INNER_GAP_EM = 0.45;

/** Where an item starts in its slot, in ems: half the gap leads, half trails. */
export const TICKER_INDENT_EM = ITEM_GAP_EM / 2;

/** Width of a ticker item's slot at `px` px, gap included. */
export function tickerSlotWidth(px: number, measure: Measure): number {
  const sym = measure(WIDEST_SYMBOL, tickerSymbolFont(px)) ?? guessWidth(WIDEST_SYMBOL, px);
  const fig = measure(WIDEST_FIGURES, tickerFigureFont(px)) ?? guessWidth(WIDEST_FIGURES, px);
  return Math.ceil(sym + fig + (INNER_GAP_EM + ITEM_GAP_EM) * px);
}

/**
 * A ticker item drawn on the text layer at (x, y), left and middle aligned,
 * `px` px tall: the symbol in the primary role, then "▲ price +gain" in the up
 * role. The caller clears the slot first.
 */
export function drawTickerItem(ctx: Ctx, item: TickerItem, x: number, y: number, px: number): void {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = tickerSymbolFont(px);
  ctx.fillStyle = TEXT_ROLES.primary;
  ctx.fillText(item.symbol, x, y);
  const w = (ctx.measureText(item.symbol) as TextMetrics | undefined)?.width;
  ctx.font = tickerFigureFont(px);
  ctx.fillStyle = TEXT_ROLES.up;
  ctx.fillText(
    "▲ " + formatPrice(item.price) + " " + formatGain(item.open, item.price),
    x + (w ?? guessWidth(item.symbol, px)) + INNER_GAP_EM * px,
    y,
  );
}

/** An axis label for price `log10` at (x, y), left and middle aligned, in the muted role. */
export function drawAxisLabel(ctx: Ctx, log10: number, x: number, y: number, px: number): void {
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = labelFont(px);
  ctx.fillStyle = TEXT_ROLES.muted;
  ctx.fillText(formatPrice(log10), x, y);
}
