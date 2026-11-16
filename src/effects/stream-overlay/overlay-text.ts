/**
 * The stream overlays' shared 2D drawing: the translucent rounded panel they
 * all sit on, the font, text that fits its space, figures that don't jiggle,
 * and the colour a chat username gets. Everything draws on the overlay layer's
 * canvas at device-pixel size; sizes are given at 1080p and multiplied by
 * `scale` (height / 1080).
 *
 * These run when an overlay redraws something that changed, never every frame,
 * so they may allocate.
 */
import { SANS_FONT_STACK } from "../canvas-texture";
import { hexToRgb } from "../color";
import { hash32 } from "../noise";

type Ctx = OffscreenCanvasRenderingContext2D;

/** The overlays' font stack: a system sans-serif, no bundled font. */
export const OVERLAY_FONT_STACK = SANS_FONT_STACK;

/** A CSS font for `px` device pixels in the overlay font, at `weight`. */
export function overlayFont(px: number, weight = 400): string {
  return `${String(weight)} ${String(Math.max(1, Math.round(px)))}px ${OVERLAY_FONT_STACK}`;
}

/** Panel geometry at 1080p: corner radius, inner padding, accent strip height. */
export const PANEL_RADIUS = 12;
export const PANEL_PADDING = 14;
const PANEL_STRIP = 3;

/** The panels' fill (a deep blue-violet black) and text colours. */
const PANEL_FILL: readonly [number, number, number] = [14, 12, 24];
export const PANEL_TEXT = "#f2f0fa";
export const PANEL_MUTED = "#a9a3bf";

/** `#rrggbb` with an alpha, as a CSS colour. */
export function cssRgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${String(r)}, ${String(g)}, ${String(b)}, ${String(clamp01(alpha))})`;
}

const clamp01 = (x: number) => (x > 0 ? (x < 1 ? x : 1) : 0);

/**
 * Draws the shared panel: a rounded rect filled with the dark panel colour at
 * `opacity` (the scene's `ovOpacity`), a faint light rim, and with `accent` a
 * thin strip of that colour along the top. Stays inside the rect (whole
 * pixels), so clearing the rect clears it.
 */
export function drawPanel(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  opacity: number,
  accent: string | null = null,
): void {
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  const pw = Math.round(w);
  const ph = Math.round(h);
  if (pw <= 0 || ph <= 0) {
    return;
  }
  const r = Math.min(PANEL_RADIUS * scale, pw / 2, ph / 2);
  const [fr, fg, fb] = PANEL_FILL;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x0, y0, pw, ph, r);
  ctx.fillStyle = `rgba(${String(fr)}, ${String(fg)}, ${String(fb)}, ${String(clamp01(opacity))})`;
  ctx.fill();
  ctx.clip();
  if (accent !== null) {
    ctx.fillStyle = accent;
    ctx.fillRect(x0, y0, pw, Math.max(1, Math.round(PANEL_STRIP * scale)));
  }
  // The rim: a hairline just inside the edge, so the clip keeps it in the rect.
  const line = Math.max(1, Math.round(scale));
  ctx.beginPath();
  ctx.roundRect(x0 + line / 2, y0 + line / 2, pw - line, ph - line, Math.max(0, r - line / 2));
  ctx.lineWidth = line;
  ctx.strokeStyle = `rgba(255, 255, 255, ${String(0.1 * clamp01(opacity + 0.15))})`;
  ctx.stroke();
  ctx.restore();
}

/**
 * The width of `text` in the context's current font, or 0 where the context
 * gives no metrics (a stand-in canvas without text support).
 */
function textWidth(ctx: Ctx, text: string): number {
  return (ctx.measureText(text) as TextMetrics | undefined)?.width ?? 0;
}

/**
 * `text` cut to fit `maxWidth` in the context's current font, with an ellipsis
 * where it was cut. Text that fits comes back unchanged; "" if not even the
 * ellipsis fits. Counts in code points, so it never splits a surrogate pair.
 */
export function fitText(ctx: Ctx, text: string, maxWidth: number): string {
  if (!(maxWidth > 0)) {
    return "";
  }
  if (textWidth(ctx, text) <= maxWidth) {
    return text;
  }
  const chars = Array.from(text);
  const fits = (n: number) =>
    textWidth(ctx, `${chars.slice(0, n).join("").trimEnd()}…`) <= maxWidth;
  if (!fits(0)) {
    return "";
  }
  // The most characters that fit with the ellipsis: binary search, widths only grow.
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return `${chars.slice(0, lo).join("").trimEnd()}…`;
}

/**
 * Draws one line of `text` in `font` and `colour`, vertically centred on `y`,
 * aligned at `x`, cut with an ellipsis to `maxWidth` (see `fitText`). Returns
 * the width drawn.
 */
export function fillLine(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  font: string,
  colour: string,
  maxWidth: number,
  align: CanvasTextAlign = "left",
): number {
  ctx.font = font;
  const shown = fitText(ctx, text, maxWidth);
  if (shown === "") {
    return 0;
  }
  ctx.fillStyle = colour;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(shown, Math.round(x), Math.round(y));
  return textWidth(ctx, shown);
}

const isDigit = (c: string) => c >= "0" && c <= "9";

/** The widest digit's width in the context's current font. */
function digitWidth(ctx: Ctx): number {
  let digit = 0;
  for (let d = 0; d <= 9; d++) {
    digit = Math.max(digit, textWidth(ctx, String(d)));
  }
  return digit;
}

/**
 * The width `fillTabular` gives `text` in `font` (setting it on the context),
 * for sizing a column of figures before drawing them.
 */
export function measureTabular(ctx: Ctx, text: string, font: string): number {
  ctx.font = font;
  const digit = digitWidth(ctx);
  let width = 0;
  for (const c of text) {
    width += isDigit(c) ? digit : textWidth(ctx, c);
  }
  return width;
}

/**
 * Draws `text` (a timer such as `1:04:09.3`) with every digit in a cell as
 * wide as the font's widest digit, so the figures stay put as they count:
 * the 2D canvas has no tabular-figures setting. Other characters (`:`, `.`,
 * `-`, `+`) keep their own width. Vertically centred on `y`, aligned at `x`
 * (left, right or center). Returns the total width.
 */
export function fillTabular(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  font: string,
  colour: string,
  align: CanvasTextAlign = "left",
): number {
  ctx.font = font;
  const digit = digitWidth(ctx);
  const chars = Array.from(text);
  const widths = chars.map((c) => (isDigit(c) ? digit : textWidth(ctx, c)));
  const total = widths.reduce((a, b) => a + b, 0);
  let left = x;
  if (align === "right" || align === "end") {
    left = x - total;
  } else if (align === "center") {
    left = x - total / 2;
  }
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cy = Math.round(y);
  for (let i = 0; i < chars.length; i++) {
    ctx.fillText(chars[i], left + widths[i] / 2, cy);
    left += widths[i];
  }
  return total;
}

/**
 * Username colours: bright, distinct hues that read on the dark panel at any
 * opacity, none of them a platform's brand colour.
 */
export const USERNAME_COLOURS: readonly string[] = [
  "#ff7a7a",
  "#ffa25c",
  "#ffd257",
  "#c4e65a",
  "#6fe38a",
  "#4fe0c8",
  "#5cc8ff",
  "#7f9cff",
  "#b18cff",
  "#e98cff",
  "#ff8cc6",
  "#ffb3a1",
];

/** A stable 32-bit hash of a string's code points. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h = hash32(h ^ (ch.codePointAt(0) ?? 0));
  }
  return h >>> 0;
}

/** The colour a username always gets: a hash of the name picks from `USERNAME_COLOURS`. */
export function usernameColour(name: string): string {
  return USERNAME_COLOURS[hashString(name) % USERNAME_COLOURS.length];
}
