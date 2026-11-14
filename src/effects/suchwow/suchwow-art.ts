/**
 * Such Background's canvas artwork: each phrase rasterised once, outlined, at
 * its on-screen size, and the clip-art shiba head (eyes open with empty whites,
 * eyes shut, and a pupil the renderer slides about for the side-eye).
 */
import { paintCanvas } from "../canvas-texture";
import { blob, curve, highlight, OUTLINE, pupil, shape, startClipArt, WHITE } from "../clip-art";
import { createEmMeasure, drawOutlinedText, memeFont } from "../meme-art";
import { PHRASE_COLORS } from "./suchwow-sim";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Phrase font weight, and its outline width in ems. */
const WEIGHT = 400;
const OUTLINE_EMS = 0.08;
const PHRASE_OUTLINE = "#1c1c1c";
/** The baseline's depth below the box's middle, ems. */
const BASELINE_EMS = 0.2;

/** A measurer of phrase widths in ems of the phrase font. */
export const createPhraseMeasure = () => createEmMeasure((px) => memeFont(WEIGHT, px));

/**
 * A phrase's sprite: `text` centred in a `width` x `height` px canvas, `font` px
 * high, in `PHRASE_COLORS[color]` with a thin dark outline. Null where there is
 * no canvas (tests).
 */
export function paintPhrase(
  text: string,
  color: number,
  font: number,
  width: number,
  height: number,
): OffscreenCanvas | null {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  return paintCanvas(w, h, (ctx) => {
    ctx.font = memeFont(WEIGHT, font);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    // Lower-case text centres on its x-height, a little under the em's middle.
    const y = h / 2 + BASELINE_EMS * font;
    drawOutlinedText(ctx, text, w / 2, y, PHRASE_COLORS[color], PHRASE_OUTLINE, OUTLINE_EMS * font);
  });
}

// ---------------------------------------------------------------------------
// The shiba

/** Shiba atlas cells, left to right: eyes open (empty whites), eyes shut, pupil. */
export const SHIBA_CELLS = 3;
export const CELL_OPEN = 0;
export const CELL_SHUT = 1;
export const CELL_PUPIL = 2;

/** The eyes' centres and radius, in the head's unit square. */
export const EYE_LEFT_X = 0.385;
export const EYE_RIGHT_X = 0.615;
export const EYE_Y = 0.5;
export const EYE_R = 0.058;
/** The eye radius `pupil` is drawn for in its cell, in cell units (the pupil fills most of it). */
const PUPIL_CELL_R = 0.8;
/** The pupil cell's side, in head units. */
export const PUPIL_CELL = EYE_R / PUPIL_CELL_R;
/** How far the pupil can slide from the eye's centre, in head units (inside the white). */
export const PUPIL_TRAVEL = EYE_R * 0.4;

const TAN = "#e9a04c";
const CREAM = "#fff3dc";
const INNER_EAR = "#f7c99a";

/** The head, eyes open with empty whites or shut, in the unit square. */
export function drawShiba(ctx: Ctx, shut: boolean): void {
  ctx.save();
  startClipArt(ctx);
  // Pointed ears with cream insides.
  for (const s of [-1, 1]) {
    shape(
      ctx,
      [
        [0.5 + s * 0.12, 0.26],
        [0.5 + s * 0.3, 0.06],
        [0.5 + s * 0.36, 0.36],
      ],
      TAN,
    );
    ctx.beginPath();
    ctx.moveTo(0.5 + s * 0.17, 0.27);
    ctx.lineTo(0.5 + s * 0.29, 0.13);
    ctx.lineTo(0.5 + s * 0.32, 0.32);
    ctx.closePath();
    ctx.fillStyle = INNER_EAR;
    ctx.fill();
  }
  // The head, then the cream mask: cheeks and a muzzle.
  blob(ctx, 0.5, 0.56, 0.36, 0.33, TAN);
  ctx.beginPath();
  ctx.ellipse(0.36, 0.7, 0.16, 0.14, 0.3, 0, Math.PI * 2);
  ctx.ellipse(0.64, 0.7, 0.16, 0.14, -0.3, 0, Math.PI * 2);
  ctx.fillStyle = CREAM;
  ctx.fill();
  blob(ctx, 0.5, 0.71, 0.13, 0.1, CREAM);
  // The eyebrow dots.
  ctx.fillStyle = CREAM;
  for (const x of [EYE_LEFT_X, EYE_RIGHT_X]) {
    ctx.beginPath();
    ctx.ellipse(x, EYE_Y - 0.1, 0.035, 0.022, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Eyes: whites for the pupils to slide in, or a shut lid's curve.
  for (const x of [EYE_LEFT_X, EYE_RIGHT_X]) {
    if (shut) {
      curve(ctx, x - EYE_R, EYE_Y, x, EYE_Y + EYE_R * 0.7, x + EYE_R, EYE_Y);
    } else {
      blob(ctx, x, EYE_Y, EYE_R, EYE_R * 1.08, WHITE);
    }
  }
  // Nose and a small, smug mouth.
  shape(
    ctx,
    [
      [0.455, 0.645],
      [0.545, 0.645],
      [0.5, 0.69],
    ],
    OUTLINE,
  );
  curve(ctx, 0.5, 0.69, 0.47, 0.75, 0.42, 0.73);
  curve(ctx, 0.5, 0.69, 0.53, 0.75, 0.58, 0.73);
  highlight(ctx, 0.36, 0.34, 0.06, 0.022, -0.5);
  ctx.restore();
}

/** The pupil, filling the unit square. */
function drawPupil(ctx: Ctx): void {
  pupil(ctx, 0.5, 0.5, PUPIL_CELL_R, 0, 0);
}

/**
 * The shiba atlas: `SHIBA_CELLS` cells of `cell` px in a row (open, shut,
 * pupil). Null where there is no canvas (tests).
 */
export function paintShibaAtlas(cell: number): OffscreenCanvas | null {
  return paintCanvas(cell * SHIBA_CELLS, cell, (ctx) => {
    for (let k = 0; k < SHIBA_CELLS; k++) {
      ctx.save();
      ctx.translate(k * cell, 0);
      ctx.scale(cell, cell);
      if (k === CELL_PUPIL) {
        drawPupil(ctx);
      } else {
        drawShiba(ctx, k === CELL_SHUT);
      }
      ctx.restore();
    }
  });
}
