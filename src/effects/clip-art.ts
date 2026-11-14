/**
 * Naive clip-art drawing on a 2D canvas, the way free clip art looked: flat
 * fills with hard dark outlines, built from ellipses, polygons and a few curves,
 * with big friendly eyes and one lazy white highlight. Shapes are drawn in
 * whatever units the caller has scaled the context to (a unit square, usually);
 * `startClipArt` sets the pen for that.
 */

type Ctx = OffscreenCanvasRenderingContext2D;

/** The hard outline colour. */
export const OUTLINE = "#1d1a1a";
/** Outline width, in unit-square units. */
export const LINE = 0.022;
export const WHITE = "#ffffff";
export const PINK = "#ff9ab8";

/** Sets the outline pen: `LINE` wide, round joins and caps, `OUTLINE` coloured. */
export function startClipArt(ctx: Ctx): void {
  ctx.lineWidth = LINE;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = OUTLINE;
}

/** A filled, outlined ellipse. */
export function blob(
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
  rotation = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/** A filled, outlined polygon. */
export function shape(
  ctx: Ctx,
  points: readonly (readonly [number, number])[],
  fill: string,
): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.stroke();
}

/** A stroked quadratic curve from (x0, y0) through control (cx, cy) to (x1, y1). */
export function curve(
  ctx: Ctx,
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(cx, cy, x1, y1);
  ctx.stroke();
}

/**
 * A pupil of an eye of radius `r` at (x, y), looking by (`lookX`, `lookY`)
 * radii: a dark disc with a glint. It stays inside the eye's white for looks
 * up to 1.
 */
export function pupil(ctx: Ctx, x: number, y: number, r: number, lookX = 0, lookY = 0.2): void {
  const px = x + lookX * r * 0.4;
  const py = y + lookY * r * 0.4;
  ctx.beginPath();
  ctx.ellipse(px, py, r * 0.52, r * 0.58, 0, 0, Math.PI * 2);
  ctx.fillStyle = OUTLINE;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(px - r * 0.2, py - r * 0.24, r * 0.17, 0, Math.PI * 2);
  ctx.fillStyle = WHITE;
  ctx.fill();
}

/**
 * A big friendly eye of radius `r`: white, a pupil looking by (`lookX`, `lookY`)
 * radii and a glint; or, blinking, a closed lid's happy curve.
 */
export function eye(
  ctx: Ctx,
  x: number,
  y: number,
  r: number,
  blink: boolean,
  lookX = 0,
  lookY = 0.2,
): void {
  if (blink) {
    curve(ctx, x - r * 0.9, y, x, y + r * 0.8, x + r * 0.9, y);
    return;
  }
  blob(ctx, x, y, r, r * 1.08, WHITE);
  pupil(ctx, x, y, r, lookX, lookY);
}

/** The one lazy white highlight: a soft-edged streak with no outline. */
export function highlight(
  ctx: Ctx,
  x: number,
  y: number,
  rx: number,
  ry: number,
  rotation: number,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rotation, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fill();
}
