/**
 * The Flying Toasters sprite atlas, drawn with a 2D canvas: three frames of a
 * winged chrome toaster (wings up, mid, down) and a slice of toast at three
 * levels of doneness, in a grid of `ATLAS_COLS` x `ATLAS_ROWS` square cells in
 * the order the simulation numbers them (see `FLAP_CYCLE` and `TOAST_CELL`).
 *
 * The Classic atlas is drawn small and then snapped to hard-edged pixels in the
 * web-safe palette, for a nearest-neighbour upscale; the Modern one is drawn at
 * the sprites' on-screen size with smooth edges and a faint glow.
 */
import { paintCanvas } from "../canvas-texture";

export const ATLAS_COLS = 3;
export const ATLAS_ROWS = 2;
/** Cell side of the Classic atlas, px: chunky pixels once upscaled. */
export const CLASSIC_CELL = 64;

type Ctx = OffscreenCanvasRenderingContext2D;

/** Wing angle (radians from +x, y down) and length (cell units) per flap frame: up, mid, down. */
const WING_ANGLE = [-1.3, -0.45, 0.6] as const;
const WING_LENGTH = [0.46, 0.5, 0.42] as const;
/** The way each frame's feathers fan out: back from a raised or level wing, up from a lowered one. */
const WING_FAN = [1, 1, -1] as const;

/** Crust, crumb and side-edge colours per doneness: light, golden, dark. */
const TOAST_COLORS = [
  ["#c8914a", "#f3dc9e", "#9a6a30"],
  ["#9c5a22", "#dca552", "#6e3c14"],
  ["#4e2a10", "#8a5426", "#2e180a"],
] as const;

const OUTLINE = "#161616";

/** The front-face corners of the toaster's body, and the oblique depth offset. */
const BODY_LEFT = 0.16;
const BODY_RIGHT = 0.72;
const BODY_TOP = 0.5;
const BODY_BOTTOM = 0.86;
const DEPTH_X = 0.14;
const DEPTH_Y = -0.1;

/** A point on the top face: `a` along the length (0 left to 1 right), `d` into depth (0 front). */
const topPoint = (a: number, d: number): [number, number] => [
  BODY_LEFT + a * (BODY_RIGHT - BODY_LEFT) + d * DEPTH_X,
  BODY_TOP + d * DEPTH_Y,
];

/**
 * A linear (4 coordinates) or radial (6) gradient through evenly spaced `colors`,
 * or the first colour where the canvas is a stand-in that makes no gradients (tests).
 */
function gradient(
  ctx: Ctx,
  at: readonly number[],
  colors: readonly string[],
): CanvasGradient | string {
  const g = (
    at.length === 4
      ? ctx.createLinearGradient(at[0], at[1], at[2], at[3])
      : ctx.createRadialGradient(at[0], at[1], at[2], at[3], at[4], at[5])
  ) as CanvasGradient | undefined;
  if (!g) {
    return colors[0];
  }
  colors.forEach((c, i) => {
    g.addColorStop(i / (colors.length - 1), c);
  });
  return g;
}

function polygon(ctx: Ctx, points: readonly (readonly [number, number])[]): void {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i][0], points[i][1]);
  }
  ctx.closePath();
}

/** Feathers per wing. */
const FEATHERS = 5;

/**
 * Traces part `k` of a wing at the origin pointing along `angle`: feathers 0 to
 * `FEATHERS - 1`, from the leading edge back, then the covert (`k === FEATHERS`).
 */
function wingPart(ctx: Ctx, k: number, angle: number, fan: number, length: number): void {
  ctx.beginPath();
  if (k < FEATHERS) {
    const len = length * (1 - 0.1 * k);
    const a = angle + fan * k * 0.2;
    ctx.ellipse(
      Math.cos(a) * len * 0.52,
      Math.sin(a) * len * 0.52,
      len * 0.5,
      0.055,
      a,
      0,
      Math.PI * 2,
    );
  } else {
    const a = angle + fan * 0.1;
    ctx.ellipse(
      Math.cos(a) * length * 0.36,
      Math.sin(a) * length * 0.36,
      length * 0.4,
      0.075,
      a,
      0,
      Math.PI * 2,
    );
  }
}

/**
 * One wing from shoulder (`x`, `y`), pointing along `angle`: a fan of long
 * feathers spreading towards the trailing side (`fan` is +1 or -1, the way the
 * fan turns), under a long rounded covert along the leading edge. Smooth wings
 * outline every feather and draw its shaft; pixel-art ones (`silhouette`) are
 * outlined only round the outside, since inner lines break up at low resolution.
 */
function drawWing(
  ctx: Ctx,
  x: number,
  y: number,
  angle: number,
  fan: number,
  length: number,
  fill: string,
  shaft: string,
  line: number,
  silhouette: boolean,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = line;
  ctx.fillStyle = fill;
  ctx.strokeStyle = OUTLINE;
  if (silhouette) {
    for (let k = 0; k <= FEATHERS; k++) {
      wingPart(ctx, k, angle, fan, length);
      ctx.stroke();
    }
    for (let k = 0; k <= FEATHERS; k++) {
      wingPart(ctx, k, angle, fan, length);
      ctx.fill();
    }
    ctx.restore();
    return;
  }
  for (let k = FEATHERS - 1; k >= 0; k--) {
    wingPart(ctx, k, angle, fan, length);
    ctx.fill();
    ctx.stroke();
    // The feather's shaft.
    const len = length * (1 - 0.1 * k);
    const a = angle + fan * k * 0.2;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * len * 0.45, Math.sin(a) * len * 0.45);
    ctx.lineTo(Math.cos(a) * len * 0.92, Math.sin(a) * len * 0.92);
    ctx.strokeStyle = shaft;
    ctx.stroke();
    ctx.strokeStyle = OUTLINE;
  }
  wingPart(ctx, FEATHERS, angle, fan, length);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** A two-slot chrome toaster in three-quarter view, facing left, with wings at `frame`. */
function drawToaster(ctx: Ctx, frame: number, line: number, pixel: boolean): void {
  const angle = WING_ANGLE[frame];
  const length = WING_LENGTH[frame];
  const fan = WING_FAN[frame];
  const [backX, backY] = topPoint(0.5, 0.7);
  const [frontX, frontY] = topPoint(0.42, 0.1);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // The far wing, behind the body and a little shaded.
  drawWing(ctx, backX, backY, angle - 0.12, fan, length * 0.85, "#d9dbe0", "#b4b8c0", line, pixel);

  // Feet.
  ctx.fillStyle = OUTLINE;
  for (const fx of [0.28, 0.64]) {
    ctx.beginPath();
    ctx.ellipse(fx, BODY_BOTTOM + 0.012, 0.045, 0.022, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Right end face, in shadow, with the lever's slot and knob.
  const end: [number, number][] = [
    [BODY_RIGHT, BODY_TOP],
    [BODY_RIGHT + DEPTH_X, BODY_TOP + DEPTH_Y],
    [BODY_RIGHT + DEPTH_X, BODY_BOTTOM + DEPTH_Y],
    [BODY_RIGHT, BODY_BOTTOM],
  ];
  polygon(ctx, end);
  ctx.fillStyle = gradient(ctx, [BODY_RIGHT, 0, BODY_RIGHT + DEPTH_X, 0], ["#8d939c", "#555a62"]);
  ctx.fill();
  ctx.lineWidth = line;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  const slotX = BODY_RIGHT + DEPTH_X * 0.5;
  const slotY = BODY_TOP + DEPTH_Y * 0.5;
  polygon(ctx, [
    [slotX - 0.012, slotY + 0.05],
    [slotX + 0.012, slotY + 0.035],
    [slotX + 0.012, slotY + 0.2],
    [slotX - 0.012, slotY + 0.215],
  ]);
  ctx.fillStyle = "#1e1f22";
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(slotX - 0.01, slotY + 0.06, 0.1, 0.04, 0.015);
  ctx.fillStyle = "#2a2b2e";
  ctx.fill();
  ctx.stroke();

  // Top face, catching the light, with its two bread slots.
  const top: [number, number][] = [
    [BODY_LEFT, BODY_TOP],
    [BODY_RIGHT, BODY_TOP],
    [BODY_RIGHT + DEPTH_X, BODY_TOP + DEPTH_Y],
    [BODY_LEFT + DEPTH_X, BODY_TOP + DEPTH_Y],
  ];
  polygon(ctx, top);
  ctx.fillStyle = gradient(
    ctx,
    [BODY_LEFT, BODY_TOP, BODY_RIGHT, BODY_TOP + DEPTH_Y],
    ["#c9cdd3", "#ffffff", "#b9bec6"],
  );
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1e1f22";
  for (const d of [0.3, 0.68]) {
    polygon(ctx, [
      topPoint(0.12, d - 0.1),
      topPoint(0.88, d - 0.1),
      topPoint(0.88, d + 0.1),
      topPoint(0.12, d + 0.1),
    ]);
    ctx.fill();
  }

  // Front face: polished chrome, a bright band reflecting the sky and a dark one the ground.
  const w = BODY_RIGHT - BODY_LEFT;
  const h = BODY_BOTTOM - BODY_TOP;
  // Evenly spaced stops: light, dark, light, dark, darker.
  const front = gradient(
    ctx,
    [0, BODY_TOP, 0, BODY_BOTTOM],
    ["#f2f3f5", "#a3a9b2", "#eceef1", "#7b8089", "#4b4f57"],
  );
  ctx.beginPath();
  ctx.roundRect(BODY_LEFT, BODY_TOP, w, h, [0.01, 0.01, 0.05, 0.05]);
  ctx.fillStyle = front;
  ctx.fill();
  ctx.save();
  ctx.clip();
  // A diagonal glint across the chrome.
  polygon(ctx, [
    [BODY_LEFT + 0.08, BODY_TOP],
    [BODY_LEFT + 0.17, BODY_TOP],
    [BODY_LEFT + 0.05, BODY_BOTTOM],
    [BODY_LEFT - 0.04, BODY_BOTTOM],
  ]);
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.roundRect(BODY_LEFT, BODY_TOP, w, h, [0.01, 0.01, 0.05, 0.05]);
  ctx.stroke();
  // A seam along the base.
  ctx.beginPath();
  ctx.moveTo(BODY_LEFT + 0.02, BODY_BOTTOM - 0.05);
  ctx.lineTo(BODY_RIGHT - 0.02, BODY_BOTTOM - 0.05);
  ctx.lineWidth = line * 0.7;
  ctx.stroke();

  // The near wing, over the body.
  drawWing(ctx, frontX, frontY, angle, fan, length, "#ffffff", "#c9ccd2", line, pixel);
}

/** The outline of a slice of bread, in slice units (about 1 wide, y down). */
function slicePath(ctx: Ctx, inset: number): void {
  const s = 1 - inset;
  ctx.beginPath();
  ctx.moveTo(-0.42 * s, 0.42 * s);
  ctx.lineTo(-0.42 * s, -0.1 * s);
  ctx.bezierCurveTo(-0.62 * s, -0.2 * s, -0.55 * s, -0.52 * s, -0.25 * s, -0.48 * s);
  ctx.bezierCurveTo(-0.1 * s, -0.56 * s, 0.1 * s, -0.56 * s, 0.25 * s, -0.48 * s);
  ctx.bezierCurveTo(0.55 * s, -0.52 * s, 0.62 * s, -0.2 * s, 0.42 * s, -0.1 * s);
  ctx.lineTo(0.42 * s, 0.42 * s);
  ctx.closePath();
}

/** A flat slice of toast, tilted back a little, at doneness `level` (0 light to 2 dark). */
function drawToast(ctx: Ctx, level: number, line: number, flat: boolean): void {
  const [crust, crumb, edge] = TOAST_COLORS[level];
  ctx.save();
  ctx.translate(0.5, 0.52);
  // Lying tilted towards the viewer, turned a little, about 0.55 of the cell across.
  ctx.transform(0.55, -0.07, 0.16, 0.4, 0, 0);
  ctx.lineJoin = "round";
  // Undo the transform's average scale, so the outline matches the toasters'.
  ctx.lineWidth = line / 0.47;
  ctx.strokeStyle = OUTLINE;
  // The slice's thickness, then its face.
  ctx.save();
  ctx.translate(0, 0.12);
  slicePath(ctx, 0);
  ctx.fillStyle = edge;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
  slicePath(ctx, 0);
  ctx.fillStyle = crust;
  ctx.fill();
  ctx.stroke();
  slicePath(ctx, 0.16);
  // A flat crumb in Classic, where a gradient would posterise into rings.
  ctx.fillStyle = flat ? crumb : gradient(ctx, [-0.08, -0.12, 0.05, 0, 0, 0.5], [crumb, crust]);
  ctx.fill();
  ctx.restore();
}

/**
 * Draws every cell of the atlas into `ctx`, `cell` px square each. Classic uses
 * a heavier outline, which survives the snap to whole pixels.
 */
function drawCells(ctx: Ctx, cell: number, classic: boolean, glow: boolean): void {
  const line = classic ? 0.04 : 0.018;
  for (let i = 0; i < ATLAS_COLS * ATLAS_ROWS; i++) {
    const x = (i % ATLAS_COLS) * cell;
    const y = Math.floor(i / ATLAS_COLS) * cell;
    const draw = (c: Ctx) => {
      if (i < 3) {
        drawToaster(c, i, line, classic);
      } else {
        drawToast(c, i - 3, line, classic);
      }
    };
    // With a glow, the cell is drawn on its own and composited with a soft
    // shadow, so the glow follows the sprite's silhouette.
    const sprite = glow
      ? paintCanvas(cell, cell, (c) => {
          c.scale(cell, cell);
          draw(c);
        })
      : null;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cell, cell);
    ctx.clip();
    if (sprite) {
      ctx.shadowColor = i < 3 ? "rgba(220, 230, 255, 0.35)" : "rgba(255, 190, 110, 0.3)";
      ctx.shadowBlur = cell * 0.05;
      ctx.drawImage(sprite, x, y);
    } else {
      ctx.translate(x, y);
      ctx.scale(cell, cell);
      draw(ctx);
    }
    ctx.restore();
  }
}

/** Pixels whose channels differ by less than this count as grey when pixelating. */
const GREY_TOLERANCE = 24;

/**
 * Snaps RGBA pixels to the Classic look in place: alpha to fully opaque or fully
 * clear, colours to the web-safe palette (each channel a multiple of 51), and
 * clear pixels to transparent black. Near-greys snap to a grey of the palette.
 */
export function pixelate(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 0;
      continue;
    }
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < GREY_TOLERANCE) {
      // Near-greys (the chrome) snap to one grey, so rounding each channel apart
      // doesn't tint them.
      const grey = Math.round((r + g + b) / 3 / 51) * 51;
      data[i] = grey;
      data[i + 1] = grey;
      data[i + 2] = grey;
    } else {
      data[i] = Math.round(r / 51) * 51;
      data[i + 1] = Math.round(g / 51) * 51;
      data[i + 2] = Math.round(b / 51) * 51;
    }
    data[i + 3] = 255;
  }
}

/** The Classic atlas, `CLASSIC_CELL` px cells snapped to pixels, or null without a canvas. */
export function paintClassicAtlas(): OffscreenCanvas | null {
  const w = ATLAS_COLS * CLASSIC_CELL;
  const h = ATLAS_ROWS * CLASSIC_CELL;
  return paintCanvas(w, h, (ctx) => {
    drawCells(ctx, CLASSIC_CELL, true, false);
    // Absent only where the canvas is a stand-in (tests).
    const image = ctx.getImageData(0, 0, w, h) as ImageData | undefined;
    if (image) {
      pixelate(image.data);
      ctx.putImageData(image, 0, 0);
    }
  });
}

/** The Modern atlas at `cell` px per cell, or null without a canvas. */
export function paintModernAtlas(cell: number): OffscreenCanvas | null {
  return paintCanvas(ATLAS_COLS * cell, ATLAS_ROWS * cell, (ctx) => {
    drawCells(ctx, cell, false, true);
  });
}
