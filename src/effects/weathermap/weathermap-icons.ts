/**
 * The Weather Forecast Map's symbols, painted on a 2D canvas: the eight weather
 * icons and the H and L pressure letters, in two looks. Classic is flat colour
 * with dark outlines and a hard shadow, like the old magnetic symbols; modern
 * is glossy, with gradients and a soft glow.
 */
import { SANS_FONT_STACK } from "../canvas-texture";
import { linearGradient, radialGradient } from "../meme-art";
import type { IconId } from "./weathermap-sim";

type Ctx = OffscreenCanvasRenderingContext2D;
export type MapStyle = "classic" | "modern";

const OUTLINE = "#262a30";

/** Casts the shadow of whatever is drawn next: hard and offset for classic, a soft glow for modern. */
function shadow(ctx: Ctx, style: MapStyle, size: number, glow = "rgba(0,0,0,0.45)") {
  if (style === "classic") {
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0.03 * size;
    ctx.shadowOffsetY = 0.03 * size;
  } else {
    ctx.shadowColor = glow;
    ctx.shadowBlur = 0.12 * size;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0.02 * size;
  }
}

function noShadow(ctx: Ctx) {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

/** A cloud of width `w` centred on (x, y): three puffs on a flat base, as one path. */
function cloudPath(ctx: Ctx, x: number, y: number, w: number) {
  ctx.beginPath();
  const puff = (px: number, py: number, r: number) => {
    ctx.moveTo(x + px * w + r * w, y + py * w);
    ctx.arc(x + px * w, y + py * w, r * w, 0, Math.PI * 2);
  };
  puff(-0.24, 0.06, 0.2);
  puff(0.02, -0.08, 0.27);
  puff(0.26, 0.05, 0.2);
  ctx.roundRect(x - 0.44 * w, y + 0.02 * w, 0.88 * w, 0.24 * w, 0.12 * w);
}

/**
 * Fills the cloud path, outlined for classic (the outline is stroked first and
 * twice as wide, so only its outer half shows round the union of the puffs).
 */
function cloud(ctx: Ctx, style: MapStyle, x: number, y: number, w: number, tone: number) {
  cloudPath(ctx, x, y, w);
  if (style === "classic") {
    shadow(ctx, style, w);
    ctx.lineWidth = 0.09 * w;
    ctx.strokeStyle = OUTLINE;
    ctx.lineJoin = "round";
    ctx.stroke();
    noShadow(ctx);
    const v = Math.round(255 - 70 * tone);
    ctx.fillStyle = `rgb(${String(v)},${String(v)},${String(Math.min(255, v + 6))})`;
    ctx.fill();
  } else {
    shadow(ctx, style, w);
    const top = Math.round(255 - 60 * tone);
    const bottom = Math.round(196 - 90 * tone);
    ctx.fillStyle = linearGradient(ctx, x, y - 0.35 * w, x, y + 0.26 * w, [
      [0, `rgb(${String(top)},${String(top)},${String(Math.min(255, top + 8))})`],
      [1, `rgb(${String(bottom)},${String(bottom + 6)},${String(bottom + 22)})`],
    ]);
    ctx.fill();
    noShadow(ctx);
  }
}

function sun(ctx: Ctx, style: MapStyle, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    const s = 0.22;
    ctx.moveTo(x + Math.cos(a - s) * r * 1.15, y + Math.sin(a - s) * r * 1.15);
    ctx.lineTo(x + Math.cos(a) * r * 1.7, y + Math.sin(a) * r * 1.7);
    ctx.lineTo(x + Math.cos(a + s) * r * 1.15, y + Math.sin(a + s) * r * 1.15);
    ctx.closePath();
  }
  if (style === "classic") {
    shadow(ctx, style, r * 3);
    ctx.fillStyle = "#ff9d1c";
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.12 * r;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    noShadow(ctx);
    ctx.fillStyle = "#ffd422";
    ctx.fill();
  } else {
    shadow(ctx, style, r * 3, "rgba(255,170,40,0.75)");
    ctx.fillStyle = radialGradient(ctx, x, y, r * 1.7, [
      [0, "#ffe680"],
      [1, "#ff9a1a"],
    ]);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = radialGradient(ctx, x - 0.3 * r, y - 0.35 * r, r * 1.3, [
      [0, "#fffbe0"],
      [0.45, "#ffd23a"],
      [1, "#ff9f0f"],
    ]);
    ctx.fill();
    noShadow(ctx);
  }
}

/** A raindrop of height `h` hanging from (x, y). */
function drop(ctx: Ctx, style: MapStyle, x: number, y: number, h: number) {
  const r = 0.32 * h;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.bezierCurveTo(x + 0.15 * h, y + 0.35 * h, x + r, y + h - 1.6 * r, x + r, y + h - r);
  ctx.arc(x, y + h - r, r, 0, Math.PI);
  ctx.bezierCurveTo(x - r, y + h - 1.6 * r, x - 0.15 * h, y + 0.35 * h, x, y);
  if (style === "classic") {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.14 * h;
    ctx.stroke();
    ctx.fillStyle = "#1f6fe0";
  } else {
    ctx.fillStyle = linearGradient(ctx, x, y, x, y + h, [
      [0, "#a6dcff"],
      [1, "#2a7de8"],
    ]);
  }
  ctx.fill();
}

function bolt(ctx: Ctx, style: MapStyle, x: number, y: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(x + 0.12 * h, y);
  ctx.lineTo(x - 0.22 * h, y + 0.55 * h);
  ctx.lineTo(x + 0.02 * h, y + 0.55 * h);
  ctx.lineTo(x - 0.12 * h, y + h);
  ctx.lineTo(x + 0.28 * h, y + 0.4 * h);
  ctx.lineTo(x + 0.04 * h, y + 0.4 * h);
  ctx.lineTo(x + 0.22 * h, y);
  ctx.closePath();
  ctx.lineJoin = "round";
  if (style === "classic") {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.09 * h;
    ctx.stroke();
    ctx.fillStyle = "#ffd21f";
  } else {
    shadow(ctx, style, h, "rgba(255,220,60,0.8)");
    ctx.fillStyle = linearGradient(ctx, x, y, x, y + h, [
      [0, "#fff7a8"],
      [1, "#ffbf1a"],
    ]);
  }
  ctx.fill();
  noShadow(ctx);
}

function flake(ctx: Ctx, style: MapStyle, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3 + Math.PI / 2;
    ctx.moveTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.lineCap = "round";
  if (style === "classic") {
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 0.55 * r;
    ctx.stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.28 * r;
  } else {
    shadow(ctx, style, r * 4, "rgba(160,220,255,0.9)");
    ctx.strokeStyle = "#f2fbff";
    ctx.lineWidth = 0.3 * r;
  }
  ctx.stroke();
  noShadow(ctx);
}

function fogBars(ctx: Ctx, style: MapStyle, x: number, y: number, s: number) {
  const bars = [
    [-0.36, 0.0, 0.62],
    [-0.28, 0.15, 0.7],
    [-0.4, 0.3, 0.6],
  ] as const;
  for (const [dx, dy, w] of bars) {
    ctx.beginPath();
    ctx.roundRect(x + dx * s, y + dy * s - 0.045 * s, w * s, 0.09 * s, 0.045 * s);
    if (style === "classic") {
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 0.05 * s;
      ctx.stroke();
      ctx.fillStyle = "#d9dde2";
    } else {
      ctx.fillStyle = "rgba(225,232,240,0.85)";
    }
    ctx.fill();
  }
}

/** Paints `icon` in `style`, `size` px across, centred on (x, y). */
export function drawIcon(
  ctx: Ctx,
  icon: IconId,
  style: MapStyle,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();
  const s = size;
  switch (icon) {
    case "sun":
      sun(ctx, style, x, y, 0.24 * s);
      break;
    case "suncloud":
      sun(ctx, style, x - 0.16 * s, y - 0.14 * s, 0.17 * s);
      cloud(ctx, style, x + 0.08 * s, y + 0.1 * s, 0.68 * s, 0);
      break;
    case "cloud":
      cloud(ctx, style, x, y + 0.02 * s, 0.88 * s, 0.15);
      break;
    case "rain":
      cloud(ctx, style, x, y - 0.1 * s, 0.82 * s, 0.35);
      drop(ctx, style, x - 0.16 * s, y + 0.18 * s, 0.24 * s);
      drop(ctx, style, x + 0.14 * s, y + 0.2 * s, 0.24 * s);
      break;
    case "heavyrain":
      cloud(ctx, style, x, y - 0.12 * s, 0.86 * s, 0.75);
      drop(ctx, style, x - 0.25 * s, y + 0.15 * s, 0.24 * s);
      drop(ctx, style, x - 0.04 * s, y + 0.22 * s, 0.24 * s);
      drop(ctx, style, x + 0.17 * s, y + 0.15 * s, 0.24 * s);
      break;
    case "thunder":
      cloud(ctx, style, x, y - 0.12 * s, 0.86 * s, 0.9);
      bolt(ctx, style, x + 0.02 * s, y + 0.06 * s, 0.38 * s);
      drop(ctx, style, x - 0.24 * s, y + 0.17 * s, 0.2 * s);
      break;
    case "snow":
      cloud(ctx, style, x, y - 0.1 * s, 0.82 * s, 0.3);
      flake(ctx, style, x - 0.17 * s, y + 0.27 * s, 0.09 * s);
      flake(ctx, style, x + 0.15 * s, y + 0.3 * s, 0.09 * s);
      break;
    case "fog":
      cloud(ctx, style, x + 0.04 * s, y - 0.14 * s, 0.6 * s, 0.25);
      fogBars(ctx, style, x, y + 0.12 * s, s);
      break;
  }
  ctx.restore();
}

/** Paints a pressure letter ("H" or "L") in `style`, `size` px tall, centred on (x, y). */
export function drawPressureLetter(
  ctx: Ctx,
  letter: "H" | "L",
  style: MapStyle,
  x: number,
  y: number,
  size: number,
): void {
  ctx.save();
  ctx.font = `800 ${String(Math.round(size))}px ${SANS_FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  if (style === "classic") {
    shadow(ctx, style, size);
    ctx.lineWidth = 0.16 * size;
    ctx.strokeStyle = "#ffffff";
    ctx.strokeText(letter, x, y);
    noShadow(ctx);
    ctx.fillStyle = letter === "H" ? "#1c4fb0" : "#c8261f";
  } else {
    shadow(ctx, style, size, letter === "H" ? "rgba(90,190,255,0.95)" : "rgba(255,110,80,0.95)");
    ctx.fillStyle = "#ffffff";
  }
  ctx.fillText(letter, x, y);
  ctx.restore();
}
