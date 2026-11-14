/**
 * The deliberately cheesy look the meme effects share: a novelty font stack
 * that falls back to `cursive`, a palette of clashing colours picked per word,
 * WordArt's rainbow, and canvas helpers for outlined caption text and gradients
 * that survive the tests' stand-in canvas. Nothing here touches GL.
 */
import { paintCanvas } from "./canvas-texture";
import { hash32 } from "./noise";

/** The cheesy font stack; whatever the browser falls back to looks the part. No font is bundled. */
const MEME_FONT_STACK = `Papyrus, "Comic Sans MS", "Chalkboard SE", "Comic Neue", cursive`;

/** A canvas font string for the meme stack at `weight` and `px` px. */
export const memeFont = (weight: number, px: number) =>
  `${String(weight)} ${String(px)}px ${MEME_FONT_STACK}`;

/** The clashing colours: yellow, lime, magenta, orange, cyan. */
export const CLASHING_COLORS = ["#ffe800", "#8dff1a", "#ff2bd6", "#ff8a00", "#14e4ff"] as const;

/** A WordArt rainbow, left to right. */
const RAINBOW = ["#ff2a2a", "#ff9a1f", "#ffe81f", "#3fdc3f", "#2a8cff", "#9a3dff"] as const;

/**
 * Item `index`'s colour (an index into `CLASHING_COLORS`) for `seed`, given the
 * item before it had `previous` (-1 for none): a hash of the seed and index,
 * moved on when it would match its neighbour.
 */
function clashingColor(seed: number, index: number, previous: number): number {
  const n = CLASHING_COLORS.length;
  const h = hash32(Math.floor(seed) * 977 + index * 7919 + 101);
  const c = h % n;
  return c === previous ? (c + 1 + (hash32(h) % (n - 1))) % n : c;
}

/**
 * The colours of `count` items in reading order (indices into
 * `CLASHING_COLORS`), for `seed`: no two neighbours match, and each depends only
 * on the items before it, so adding items leaves the earlier ones' colours alone.
 */
export function clashingColors(seed: number, count: number): number[] {
  const out: number[] = [];
  let previous = -1;
  for (let i = 0; i < count; i++) {
    previous = clashingColor(seed, i, previous);
    out.push(previous);
  }
  return out;
}

type Ctx = OffscreenCanvasRenderingContext2D;
type Stops = readonly (readonly [number, string])[];

// The tests' stand-in canvas returns undefined where a browser returns a gradient.
const addStops = (g: CanvasGradient | undefined, stops: Stops): CanvasGradient | string => {
  if (!g) {
    return stops[0][1];
  }
  for (const [at, colour] of stops) {
    g.addColorStop(at, colour);
  }
  return g;
};

/**
 * A linear gradient through `stops` (offset, colour), or the first colour where
 * the canvas is a stand-in that makes no gradients (tests).
 */
export const linearGradient = (
  ctx: Ctx,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  stops: Stops,
): CanvasGradient | string => addStops(ctx.createLinearGradient(x0, y0, x1, y1), stops);

/** Like `linearGradient`, radial from (x, y) out to radius `r`. */
export const radialGradient = (
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  stops: Stops,
): CanvasGradient | string => addStops(ctx.createRadialGradient(x, y, 0, x, y, r), stops);

/** `RAINBOW` as gradient stops, evenly spaced. */
export const rainbowStops = (): Stops =>
  RAINBOW.map((c, k) => [k / (RAINBOW.length - 1), c] as const);

/**
 * Draws `text` at (x, y) the way meme captions are: a round-jointed outline
 * `outlineWidth` px wide in `outline`, then the fill over it. The font, baseline
 * and alignment are the caller's.
 */
export function drawOutlinedText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  fill: CanvasGradient | string,
  outline: string,
  outlineWidth: number,
): void {
  ctx.lineJoin = "round";
  ctx.lineWidth = outlineWidth;
  ctx.strokeStyle = outline;
  ctx.fillStyle = fill;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

/** Measures `text`'s advance in ems, or undefined where it can't be measured. */
type MeasureEm = (text: string) => number | undefined;

/**
 * A measurer in ems of the font `font(px)` gives (the meme stack at normal
 * weight by default), or one that always gives undefined where there is no
 * canvas to measure with.
 */
export function createEmMeasure(
  font: (px: number) => string = (px) => memeFont(400, px),
): MeasureEm {
  let ctx: Ctx | null | undefined;
  return (text) => {
    if (ctx === undefined) {
      const canvas = paintCanvas(1, 1, () => undefined);
      ctx = canvas ? canvas.getContext("2d") : null;
    }
    if (!ctx) {
      return undefined;
    }
    ctx.font = font(100);
    // Undefined from the tests' stand-in context, whose methods return nothing.
    const metrics = ctx.measureText(text) as TextMetrics | undefined;
    return metrics === undefined ? undefined : metrics.width / 100;
  };
}
