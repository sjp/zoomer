/**
 * Blue Screen's 2D canvas drawing: each style's screen (background and the
 * text that only changes with the params), the "NN% complete" line and the
 * kernel log's lines, all at device-pixel size so text copies texel for texel.
 */
import { MONO_FONT_STACK, paintCanvas, SANS_FONT_STACK } from "../canvas-texture";
import { GLYPH_H, GLYPH_W } from "../dot-matrix";
import { hash32 } from "../noise";
import {
  CELL_H,
  CELL_W,
  CLASSIC_TITLE,
  type ClassicLayout,
  type FontKind,
  type KernelLayout,
  type Measure,
  type ModernLayout,
  type BlueLayout,
} from "./bluescreen-layout";
import { type BlueHue, type BlueStyle, classicGlyphRows } from "./bluescreen-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Modern's backgrounds, a little softer than the originals so a codec has an easy time. */
const MODERN_BACKGROUND: Record<BlueHue, string> = {
  blue: "#0b5fae",
  green: "#0f6b3c",
  black: "#111214",
};
const MODERN_INK = "#ffffff";
const CLASSIC_BACKGROUND = "#0b0ba4";
const CLASSIC_INK = "#ffffff";
const CLASSIC_TITLE_BACKGROUND = "#aaaaaa";
const KERNEL_BACKGROUND = "#000000";
const KERNEL_INK = "#c8c8c8";

/** The screen's background colour for a style and hue (the hue is Modern's alone). */
export function screenBackground(style: BlueStyle, hue: BlueHue): string {
  if (style === "classic") {
    return CLASSIC_BACKGROUND;
  }
  return style === "kernel" ? KERNEL_BACKGROUND : MODERN_BACKGROUND[hue];
}

/** The cursor's colour, as unit RGB. */
export const CURSOR_INK: Record<BlueStyle, readonly [number, number, number]> = {
  modern: [1, 1, 1],
  classic: [1, 1, 1],
  kernel: [0.78, 0.78, 0.78],
};

/** The CSS font for a kind of text at `px`. */
function fontFor(kind: FontKind, px: number): string {
  const size = `${String(Math.max(1, Math.round(px * 100) / 100))}px`;
  if (kind === "mono") {
    return `${size} ${MONO_FONT_STACK}`;
  }
  return `${kind === "face" ? "200" : "300"} ${size} ${SANS_FONT_STACK}`;
}

/** Measures text in ems of each kind's font, or undefined where there is no canvas. */
export function createMeasure(): Measure {
  let ctx: Ctx | null | undefined;
  return (text, kind) => {
    if (ctx === undefined) {
      const canvas = paintCanvas(1, 1, () => undefined);
      ctx = canvas ? canvas.getContext("2d") : null;
    }
    if (!ctx) {
      return undefined;
    }
    ctx.font = fontFor(kind, 100);
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(text) as TextMetrics | undefined;
    return metrics === undefined ? undefined : metrics.width / 100;
  };
}

/** Cells across Modern's square of pixel noise. */
const QR_CELLS = 17;

/**
 * Modern's noise square: hashed cells with no finder squares or quiet zone, so
 * it reads as "a code goes here" without being one.
 */
function paintNoise(ctx: Ctx, x: number, y: number, size: number, seed: number) {
  const cell = size / QR_CELLS;
  ctx.fillStyle = MODERN_INK;
  for (let r = 0; r < QR_CELLS; r++) {
    for (let c = 0; c < QR_CELLS; c++) {
      if ((hash32(hash32(seed + 0x51ed27) ^ (r * QR_CELLS + c)) & 3) < 2) {
        const x0 = Math.round(x + c * cell);
        const y0 = Math.round(y + r * cell);
        ctx.fillRect(
          x0,
          y0,
          Math.round(x + (c + 1) * cell) - x0,
          Math.round(y + (r + 1) * cell) - y0,
        );
      }
    }
  }
}

function paintModern(ctx: Ctx, layout: ModernLayout, scale: number, seed: number) {
  ctx.fillStyle = MODERN_INK;
  ctx.textBaseline = "top";
  for (const run of layout.runs) {
    ctx.font = fontFor(run.kind, run.size * scale);
    ctx.fillText(run.text, Math.round(run.x * scale), Math.round(run.y * scale));
  }
  const q = layout.qr;
  paintNoise(ctx, Math.round(q.x * scale), Math.round(q.y * scale), q.w * scale, seed);
}

/** One font dot in device px: whole px where it can be, so the glyphs stay crisp and even. */
function classicDot(layout: ClassicLayout, scale: number): number {
  const exact = layout.dot * scale;
  return exact >= 1 ? Math.floor(exact) : exact;
}

/** Classic's underline cursor after the prompt, device px: x, y, width, height. */
export function classicCursor(layout: ClassicLayout, scale: number, out: Float64Array): void {
  const dot = classicDot(layout, scale);
  const row = layout.lines.length - 1;
  const col = Array.from(layout.lines[row]).length;
  out[0] = Math.round(layout.x * scale) + col * CELL_W * dot;
  out[1] = Math.round(layout.y * scale) + (row * CELL_H + GLYPH_H - 1) * dot;
  out[2] = GLYPH_W * dot;
  out[3] = 2 * dot;
}

/** Draws `text` in the Classic dot font with its top-left at (x, y), device px. */
function paintGlyphs(ctx: Ctx, text: string, x: number, y: number, dot: number) {
  let col = 0;
  for (const ch of text) {
    if (ch !== " ") {
      const rows = classicGlyphRows(ch);
      for (let r = 0; r < GLYPH_H; r++) {
        for (let c = 0; c < GLYPH_W; c++) {
          if (rows[r][c] === "#") {
            const x0 = Math.round(x + (col * CELL_W + c) * dot);
            const y0 = Math.round(y + r * dot);
            ctx.fillRect(x0, y0, Math.max(1, Math.round(dot)), Math.max(1, Math.round(dot)));
          }
        }
      }
    }
    col++;
  }
}

function paintClassic(ctx: Ctx, layout: ClassicLayout, scale: number) {
  const dot = classicDot(layout, scale);
  const x = Math.round(layout.x * scale);
  const y = Math.round(layout.y * scale);
  // The title: grey block, background-coloured letters, centred over the page.
  const titleCol = Math.floor((layout.cols - CLASSIC_TITLE.length) / 2);
  const tx = x + titleCol * CELL_W * dot;
  ctx.fillStyle = CLASSIC_TITLE_BACKGROUND;
  ctx.fillRect(
    Math.round(tx),
    y - Math.round(dot),
    Math.round(CLASSIC_TITLE.length * CELL_W * dot),
    Math.round(CELL_H * dot),
  );
  ctx.fillStyle = CLASSIC_BACKGROUND;
  paintGlyphs(ctx, CLASSIC_TITLE, tx, y, dot);
  ctx.fillStyle = CLASSIC_INK;
  for (let row = 1; row < layout.lines.length; row++) {
    paintGlyphs(ctx, layout.lines[row], x, y + row * CELL_H * dot, dot);
  }
}

function paintKernelHeader(ctx: Ctx, layout: KernelLayout, scale: number) {
  ctx.fillStyle = KERNEL_INK;
  ctx.textBaseline = "top";
  ctx.font = fontFor("mono", layout.size * scale);
  for (const run of layout.runs) {
    ctx.fillText(run.text, Math.round(run.x * scale), Math.round(run.y * scale));
  }
}

/**
 * The whole screen for a layout at `width` x `height` device px: background and
 * every piece of text that only changes with the params.
 */
export function paintScreen(
  layout: BlueLayout,
  hue: BlueHue,
  seed: number,
  width: number,
  height: number,
  scale: number,
): OffscreenCanvas | null {
  return paintCanvas(width, height, (ctx) => {
    ctx.fillStyle = screenBackground(layout.style, hue);
    ctx.fillRect(0, 0, width, height);
    if (layout.style === "modern") {
      paintModern(ctx, layout, scale, seed);
    } else if (layout.style === "classic") {
      paintClassic(ctx, layout, scale);
    } else {
      paintKernelHeader(ctx, layout, scale);
    }
  });
}

/** Modern's count line on a transparent canvas the size of its box, device px. */
export function paintPercent(layout: ModernLayout, text: string, scale: number) {
  const w = Math.max(1, Math.ceil(layout.percent.w * scale) + 4);
  const h = Math.max(1, Math.ceil(layout.percent.h * scale));
  return paintCanvas(w, h, (ctx) => {
    ctx.fillStyle = MODERN_INK;
    ctx.textBaseline = "top";
    ctx.font = fontFor("sans", layout.percentSize * scale);
    ctx.fillText(text, 0, 0);
  });
}

/** The kernel log's line pitch in whole device px, so every line lands on the pixel grid. */
export function logLineHeight(layout: KernelLayout, scale: number): number {
  return Math.max(1, Math.round(layout.lineHeight * scale));
}

/**
 * The kernel log's lines, one under another, on a transparent canvas as wide as
 * the log window and `lines.length` lines tall, device px.
 */
export function paintLog(layout: KernelLayout, lines: readonly string[], scale: number) {
  const lineHeight = logLineHeight(layout, scale);
  const w = Math.max(1, Math.ceil(layout.log.w * scale) + 4);
  const h = Math.max(1, lines.length * lineHeight);
  return paintCanvas(w, h, (ctx) => {
    ctx.fillStyle = KERNEL_INK;
    ctx.textBaseline = "top";
    ctx.font = fontFor("mono", layout.size * scale);
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, i * lineHeight);
    }
  });
}
