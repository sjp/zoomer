/**
 * The clip-art critters of Graphic Design Is My Passion, drawn with a 2D canvas
 * from ellipses, triangles and a few curves: hard dark outlines, flat fills, one
 * lazy white highlight and big friendly eyes, the way free clip art looked.
 *
 * Each critter is one draw function in `CRITTERS`, keyed by its `critter`
 * select value, drawing into a unit square (y down) with its feet near the
 * bottom (`CRITTER_FEET` in the sim) in one of three poses: eyes open, blinking,
 * or its idle touch. Adding a critter is one draw function here plus one select
 * option in the meta.
 */
import { paintCanvas } from "../canvas-texture";
import { blob, curve, eye, highlight, LINE, OUTLINE, PINK, shape, startClipArt } from "../clip-art";
import { FRAME_BLINK, FRAME_IDLE } from "./passion-sim";
import { CRITTER_OPTIONS, type CritterId } from "./passion.meta";

type Ctx = OffscreenCanvasRenderingContext2D;

/** Poses per critter, the atlas's columns: eyes open, blinking, idle touch. */
export const CRITTER_FRAMES = 3;

/** What a pose changes: closed eyes, or the critter's own idle touch. */
interface Pose {
  blink: boolean;
  idle: boolean;
}

type DrawCritter = (ctx: Ctx, pose: Pose) => void;

/** Lumpy green body, big white eyes on top, a wide smile and a pale belly. */
const frog: DrawCritter = (ctx, pose) => {
  const green = "#5cc83a";
  blob(ctx, 0.24, 0.83, 0.16, 0.11, green, -0.2);
  blob(ctx, 0.76, 0.83, 0.16, 0.11, green, 0.2);
  blob(ctx, 0.5, 0.66, 0.36, 0.27, green);
  blob(ctx, 0.5, 0.76, 0.22, 0.15, "#dff5a6");
  blob(ctx, 0.37, 0.93, 0.08, 0.035, green);
  blob(ctx, 0.63, 0.93, 0.08, 0.035, green);
  blob(ctx, 0.33, 0.42, 0.13, 0.12, green);
  blob(ctx, 0.67, 0.42, 0.13, 0.12, green);
  // Idle: a sideways glance.
  const look = pose.idle ? 0.9 : 0;
  eye(ctx, 0.33, 0.4, 0.09, pose.blink, look);
  eye(ctx, 0.67, 0.4, 0.09, pose.blink, look);
  curve(ctx, 0.32, 0.57, 0.5, 0.7, 0.68, 0.57);
  ctx.fillStyle = OUTLINE;
  for (const x of [0.46, 0.54]) {
    ctx.beginPath();
    ctx.arc(x, 0.53, 0.008, 0, Math.PI * 2);
    ctx.fill();
  }
  highlight(ctx, 0.27, 0.56, 0.06, 0.025, -0.7);
};

/** Orange tabby sitting upright: triangle ears, three stripes, a curled tail. */
const cat: DrawCritter = (ctx, pose) => {
  const orange = "#f59a2c";
  const stripe = "#c4601a";
  // The curled tail, behind: a thick outlined stroke. Idle: its tip sways.
  const tipX = pose.idle ? 0.93 : 0.88;
  const tipY = pose.idle ? 0.5 : 0.47;
  for (const [width, colour] of [
    [0.085 + 2 * LINE, OUTLINE],
    [0.085, orange],
  ] as const) {
    ctx.lineWidth = width;
    ctx.strokeStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0.62, 0.9);
    ctx.bezierCurveTo(0.92, 0.92, 0.96, 0.7, tipX, tipY);
    ctx.stroke();
  }
  ctx.lineWidth = LINE;
  ctx.strokeStyle = OUTLINE;
  blob(ctx, 0.5, 0.72, 0.24, 0.23, orange);
  blob(ctx, 0.5, 0.76, 0.12, 0.15, "#ffe3bb");
  blob(ctx, 0.41, 0.93, 0.075, 0.04, orange);
  blob(ctx, 0.59, 0.93, 0.075, 0.04, orange);
  // Ears; idle twitches the left one outwards.
  const lean = pose.idle ? -0.05 : 0;
  shape(
    ctx,
    [
      [0.31, 0.34],
      [0.33 + lean, 0.1],
      [0.47, 0.24],
    ],
    orange,
  );
  shape(
    ctx,
    [
      [0.69, 0.34],
      [0.67, 0.1],
      [0.53, 0.24],
    ],
    orange,
  );
  ctx.fillStyle = PINK;
  for (const [a, b, c] of [
    [0.35, 0.16 + lean * 0.6, 0.42],
    [0.65, 0.16, 0.58],
  ]) {
    ctx.beginPath();
    ctx.moveTo(a, 0.3);
    ctx.lineTo(b, 0.17);
    ctx.lineTo(c, 0.26);
    ctx.closePath();
    ctx.fill();
  }
  blob(ctx, 0.5, 0.39, 0.22, 0.19, orange);
  // Three stripes on the forehead.
  ctx.strokeStyle = stripe;
  ctx.lineWidth = LINE * 1.3;
  curve(ctx, 0.44, 0.22, 0.43, 0.26, 0.45, 0.29);
  curve(ctx, 0.5, 0.21, 0.5, 0.26, 0.5, 0.3);
  curve(ctx, 0.56, 0.22, 0.57, 0.26, 0.55, 0.29);
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = LINE;
  eye(ctx, 0.42, 0.37, 0.055, pose.blink);
  eye(ctx, 0.58, 0.37, 0.055, pose.blink);
  shape(
    ctx,
    [
      [0.475, 0.44],
      [0.525, 0.44],
      [0.5, 0.47],
    ],
    PINK,
  );
  curve(ctx, 0.5, 0.47, 0.48, 0.51, 0.45, 0.49);
  curve(ctx, 0.5, 0.47, 0.52, 0.51, 0.55, 0.49);
  ctx.lineWidth = LINE * 0.6;
  for (const s of [-1, 1]) {
    curve(ctx, 0.5 + s * 0.08, 0.46, 0.5 + s * 0.16, 0.44, 0.5 + s * 0.24, 0.45);
    curve(ctx, 0.5 + s * 0.08, 0.48, 0.5 + s * 0.16, 0.48, 0.5 + s * 0.23, 0.5);
  }
  ctx.lineWidth = LINE;
  highlight(ctx, 0.38, 0.28, 0.05, 0.022, -0.5);
};

/** Brown puppy sitting: floppy ears, tongue out, a spot over one eye. */
const dog: DrawCritter = (ctx, pose) => {
  const brown = "#b97a44";
  const dark = "#6f4222";
  // A stubby tail, wagged up when idle.
  blob(ctx, 0.74, 0.8, 0.09, 0.035, brown, pose.idle ? -1.1 : -0.5);
  blob(ctx, 0.5, 0.72, 0.25, 0.23, brown);
  blob(ctx, 0.5, 0.77, 0.13, 0.15, "#ecc89c");
  blob(ctx, 0.41, 0.93, 0.08, 0.04, brown);
  blob(ctx, 0.59, 0.93, 0.08, 0.04, brown);
  blob(ctx, 0.5, 0.4, 0.23, 0.2, brown);
  // The spot over the left eye.
  ctx.beginPath();
  ctx.ellipse(0.41, 0.35, 0.075, 0.065, 0.3, 0, Math.PI * 2);
  ctx.fillStyle = dark;
  ctx.fill();
  blob(ctx, 0.5, 0.49, 0.12, 0.085, "#ecc89c");
  // Floppy ears; idle perks the right one up a little.
  blob(ctx, 0.28, 0.43, 0.07, 0.15, dark, 0.35);
  blob(
    ctx,
    pose.idle ? 0.73 : 0.72,
    pose.idle ? 0.38 : 0.43,
    0.07,
    0.15,
    dark,
    pose.idle ? -0.9 : -0.35,
  );
  eye(ctx, 0.42, 0.36, 0.06, pose.blink);
  eye(ctx, 0.58, 0.36, 0.06, pose.blink);
  blob(ctx, 0.5, 0.45, 0.045, 0.03, OUTLINE);
  blob(ctx, 0.53, 0.56, 0.035, 0.05, PINK);
  curve(ctx, 0.43, 0.5, 0.47, 0.54, 0.5, 0.5);
  curve(ctx, 0.5, 0.5, 0.53, 0.54, 0.57, 0.5);
  highlight(ctx, 0.4, 0.27, 0.05, 0.02, -0.4);
};

/** Yellow duckling: orange beak and feet, a tuft on its head. */
const duck: DrawCritter = (ctx, pose) => {
  const yellow = "#ffdc3a";
  const wing = "#f2bf16";
  const orange = "#ff8c1a";
  blob(ctx, 0.4, 0.94, 0.09, 0.035, orange);
  blob(ctx, 0.6, 0.94, 0.09, 0.035, orange);
  blob(ctx, 0.5, 0.73, 0.26, 0.2, yellow);
  // Little wings; idle gives them a flap.
  const flap = pose.idle ? 0.5 : 0;
  blob(ctx, 0.26, 0.71, 0.07, 0.12, wing, 0.3 + flap);
  blob(ctx, 0.74, 0.71, 0.07, 0.12, wing, -0.3 - flap);
  blob(ctx, 0.5, 0.42, 0.18, 0.17, yellow);
  // The tuft: three curls.
  curve(ctx, 0.5, 0.26, 0.46, 0.18, 0.42, 0.2);
  curve(ctx, 0.5, 0.26, 0.5, 0.17, 0.53, 0.16);
  curve(ctx, 0.5, 0.26, 0.55, 0.2, 0.59, 0.21);
  eye(ctx, 0.43, 0.39, 0.055, pose.blink);
  eye(ctx, 0.57, 0.39, 0.055, pose.blink);
  blob(ctx, 0.5, 0.5, 0.09, 0.03, orange);
  blob(ctx, 0.5, 0.47, 0.1, 0.035, orange);
  highlight(ctx, 0.4, 0.32, 0.045, 0.02, -0.6);
};

/** White rabbit: long pink-lined ears, a cotton tail, a pink nose. */
const bunny: DrawCritter = (ctx, pose) => {
  const white = "#fbfbf8";
  blob(ctx, 0.75, 0.84, 0.07, 0.065, white);
  blob(ctx, 0.5, 0.73, 0.23, 0.21, white);
  blob(ctx, 0.4, 0.94, 0.09, 0.04, white);
  blob(ctx, 0.6, 0.94, 0.09, 0.04, white);
  // Ears; idle flops the right one sideways.
  const flop = pose.idle ? 0.55 : 0.12;
  const ears: [number, number, number][] = [
    [0.42, 0.21, -0.12],
    [pose.idle ? 0.63 : 0.58, pose.idle ? 0.23 : 0.21, flop],
  ];
  for (const [x, y, r] of ears) {
    blob(ctx, x, y, 0.055, 0.17, white, r);
    ctx.beginPath();
    ctx.ellipse(x, y + 0.01, 0.025, 0.12, r, 0, Math.PI * 2);
    ctx.fillStyle = PINK;
    ctx.fill();
  }
  blob(ctx, 0.5, 0.43, 0.19, 0.17, white);
  ctx.fillStyle = "#ffc6d6";
  for (const x of [0.38, 0.62]) {
    ctx.beginPath();
    ctx.ellipse(x, 0.48, 0.035, 0.02, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  eye(ctx, 0.43, 0.4, 0.05, pose.blink);
  eye(ctx, 0.57, 0.4, 0.05, pose.blink);
  blob(ctx, 0.5, 0.47, 0.025, 0.018, PINK);
  curve(ctx, 0.5, 0.49, 0.48, 0.53, 0.45, 0.51);
  curve(ctx, 0.5, 0.49, 0.52, 0.53, 0.55, 0.51);
  highlight(ctx, 0.4, 0.33, 0.045, 0.02, -0.5);
};

/** Points of a regular hexagon of radius `r` round (x, y). */
const hexagon = (x: number, y: number, r: number) =>
  Array.from({ length: 6 }, (_, k): [number, number] => [
    x + r * Math.cos((k * Math.PI) / 3),
    y + r * Math.sin((k * Math.PI) / 3),
  ]);

/** Green turtle side-on, facing right: a hexagon-patterned shell and a small smile. */
const turtle: DrawCritter = (ctx, pose) => {
  const green = "#7fd04e";
  const shell = "#3f9a3a";
  shape(
    ctx,
    [
      [0.17, 0.84],
      [0.08, 0.87],
      [0.18, 0.89],
    ],
    green,
  );
  for (const x of [0.28, 0.43, 0.56, 0.69]) {
    blob(ctx, x, 0.89, 0.05, 0.065, green);
  }
  // Neck and head; idle lifts the head a touch.
  const lift = pose.idle ? 0.04 : 0;
  blob(ctx, 0.76, 0.77 - lift / 2, 0.08, 0.06, green, -0.4);
  blob(ctx, 0.84, 0.69 - lift, 0.1, 0.085, green);
  eye(ctx, 0.86, 0.66 - lift, 0.035, pose.blink, 0.6, 0);
  curve(ctx, 0.85, 0.73 - lift, 0.89, 0.755 - lift, 0.925, 0.72 - lift);
  // The shell: a dome, its plates a hexagon pattern, a pale rim along the bottom.
  ctx.beginPath();
  ctx.ellipse(0.47, 0.84, 0.32, 0.3, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = shell;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.lineWidth = LINE * 0.8;
  for (const [x, y] of [
    [0.47, 0.66],
    [0.31, 0.75],
    [0.63, 0.75],
    [0.39, 0.86],
    [0.55, 0.86],
    [0.2, 0.86],
    [0.74, 0.86],
  ]) {
    shape(ctx, hexagon(x, y, 0.075), "#64bd4c");
  }
  ctx.restore();
  ctx.lineWidth = LINE;
  ctx.beginPath();
  ctx.ellipse(0.47, 0.84, 0.32, 0.3, 0, Math.PI, Math.PI * 2);
  ctx.closePath();
  ctx.stroke();
  blob(ctx, 0.47, 0.845, 0.34, 0.035, "#e6c768");
  highlight(ctx, 0.35, 0.62, 0.06, 0.022, -0.5);
};

/** The draw function per `critter` select value. */
export const CRITTERS: Record<CritterId, DrawCritter> = { frog, cat, dog, duck, bunny, turtle };

/** Draws one critter's pose `frame` (open, blinking or idle) in the unit square. */
export function drawCritter(ctx: Ctx, critter: CritterId, frame: number): void {
  ctx.save();
  startClipArt(ctx);
  CRITTERS[critter](ctx, { blink: frame === FRAME_BLINK, idle: frame === FRAME_IDLE });
  ctx.restore();
}

/**
 * The critter atlas: one row per critter in select order, one column per pose,
 * `cell` px square each. Null where there is no canvas (tests).
 */
export function paintCritterAtlas(cell: number): OffscreenCanvas | null {
  return paintCanvas(cell * CRITTER_FRAMES, cell * CRITTER_OPTIONS.length, (ctx) => {
    CRITTER_OPTIONS.forEach((o, row) => {
      for (let frame = 0; frame < CRITTER_FRAMES; frame++) {
        ctx.save();
        ctx.translate(frame * cell, row * cell);
        ctx.scale(cell, cell);
        drawCritter(ctx, o.value, frame);
        ctx.restore();
      }
    });
  });
}
