/**
 * Loading Screen's key art: three made-up paintings (a misty valley with a
 * ruined arch, a docked ship under a gas giant, a forest shrine with lanterns),
 * each painted once per size on a 2D canvas, plus the few small lights that
 * move or flicker on top of them and the fog that drifts across them.
 *
 * Painting units: the painting's height is 1 and its width its aspect, and
 * features sit at a fixed offset from the centre (in heights), so a painting
 * composes the same way at every aspect, only showing more or less at the sides.
 */
import { createRng } from "../noise";
import type { ArtId } from "./loadingscreen.meta";

/** The `art` param's value as an `ArtId` (an unknown value shows the ruins). */
export function toArtId(value: string): ArtId {
  return value === "spaceport" || value === "forest" ? value : "ruins";
}

/** The fog the shader drifts across a painting: strength, band centre and half-height (0..1 down), colour. */
interface Fog {
  readonly strength: number;
  readonly centre: number;
  readonly half: number;
  readonly colour: readonly [number, number, number];
}

export const ART_FOG: Readonly<Record<ArtId, Fog>> = {
  ruins: { strength: 0.5, centre: 0.68, half: 0.14, colour: [0.82, 0.8, 0.84] },
  spaceport: { strength: 0.12, centre: 0.86, half: 0.08, colour: [0.45, 0.32, 0.55] },
  forest: { strength: 0.35, centre: 0.76, half: 0.12, colour: [0.78, 0.84, 0.7] },
};

/** Floats per light from `artLights`: u, v (painting, 0..1, y down), radius (painting heights), strength, r, g, b. */
export const LIGHT_STRIDE = 7;
/** The most lights a painting has. */
export const MAX_LIGHTS = 8;

/** A feature's x in painting units, `off` heights from the centre, kept on the painting. */
const at = (aspect: number, off: number) => {
  const half = aspect / 2;
  // On a narrow painting, pull far-off features in so they still show.
  const reach = Math.max(0.05, Math.min(Math.abs(off), half - 0.08));
  return half + Math.sign(off) * reach;
};

/** A soft blink: 0.25..1 over `period` seconds (at least 2 s, so never faster than 0.5 Hz). */
const blink = (t: number, period: number, phase: number) =>
  0.625 + 0.375 * Math.cos((2 * Math.PI * (t + phase)) / Math.max(2, period));

/**
 * Writes the lights of `art` at `t` seconds for a painting of `aspect` into
 * `out` (`MAX_LIGHTS` x `LIGHT_STRIDE` floats) and returns how many there are.
 * The space port's beacons blink softly and two shuttles glide along the
 * outer thirds; the forest's lanterns flicker gently. The ruins have none.
 */
export function artLights(art: ArtId, aspect: number, t: number, out: Float32Array): number {
  const a = Math.max(0.2, aspect);
  let n = 0;
  const put = (x: number, y: number, r: number, s: number, rgb: readonly number[]) => {
    const o = n * LIGHT_STRIDE;
    out[o] = x / a;
    out[o + 1] = y;
    out[o + 2] = r;
    out[o + 3] = s;
    out[o + 4] = rgb[0];
    out[o + 5] = rgb[1];
    out[o + 6] = rgb[2];
    n++;
  };
  if (art === "spaceport") {
    const red = [1, 0.32, 0.25];
    const white = [0.85, 0.92, 1];
    const ship = at(a, 0.5);
    put(ship, 0.535, 0.012, blink(t, 3, 0), red);
    put(ship + 0.22, 0.5, 0.01, blink(t, 4, 1.3), white);
    put(at(a, -0.62), 0.5, 0.009, blink(t, 3.6, 0.7), red);
    put(at(a, 0.86), 0.47, 0.009, blink(t, 2.8, 2.1), red);
    // Shuttles glide across the outer thirds, fading in and out at the ends of their runs.
    for (let k = 0; k < 2; k++) {
      const period = k === 0 ? 70 : 90;
      const p = (t / period + k * 0.37) % 1;
      const fade = Math.min(1, p / 0.15, (1 - p) / 0.15);
      const left = k === 0;
      const x0 = left ? at(a, -0.95) : at(a, 0.5);
      const x1 = left ? at(a, -0.5) : at(a, 0.95);
      const x = left ? x0 + (x1 - x0) * p : x1 - (x1 - x0) * p;
      const y = (left ? 0.2 : 0.14) + 0.04 * p;
      put(x, y, 0.006, 0.9 * fade, white);
    }
  } else if (art === "forest") {
    const warm = [1, 0.66, 0.3];
    const lanterns = [
      [0.48, 0.7],
      [0.74, 0.7],
      [-0.55, 0.42],
      [-0.72, 0.36],
    ];
    for (let i = 0; i < lanterns.length; i++) {
      const [off, y] = lanterns[i];
      // Two slow waves: a gentle, uneven flicker well under 1 Hz.
      const f = 0.85 + 0.09 * Math.sin(t * 2.1 + i * 1.7) + 0.06 * Math.sin(t * 3.3 + i * 2.9 + 1);
      put(at(a, off), y, 0.035, 0.55 * f, warm);
    }
  }
  return n;
}

type Ctx = OffscreenCanvasRenderingContext2D;

/** A ridge line across the painting: a seeded sum of sines about `base`. */
function ridge(
  ctx: Ctx,
  w: number,
  h: number,
  seed: number,
  base: number,
  amp: number,
  fill: string,
) {
  const rng = createRng(seed);
  const waves = [0, 1, 2, 3].map((i) => ({
    f: (2 + i * 3.1 + rng() * 2) / h,
    p: rng() * 6.283,
    a: amp / (1 + i * 1.3),
  }));
  ctx.beginPath();
  ctx.moveTo(0, h);
  const steps = 160;
  for (let i = 0; i <= steps; i++) {
    const x = (i / steps) * w;
    let y = base;
    for (const wv of waves) {
      y -= Math.sin(x * wv.f + wv.p) * wv.a;
    }
    ctx.lineTo(x, y * h);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/** A horizontal band of soft colour, fading out above and below its centre. */
function band(ctx: Ctx, w: number, h: number, y: number, half: number, rgb: string, alpha: number) {
  const g = ctx.createLinearGradient(0, (y - half) * h, 0, (y + half) * h) as
    | CanvasGradient
    | undefined;
  if (!g) {
    return;
  }
  g.addColorStop(0, `rgba(${rgb},0)`);
  g.addColorStop(0.5, `rgba(${rgb},${String(alpha)})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, (y - half) * h, w, 2 * half * h);
}

/** A soft round glow. */
function glow(ctx: Ctx, x: number, y: number, r: number, rgb: string, alpha: number) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r) as CanvasGradient | undefined;
  if (!g) {
    return;
  }
  g.addColorStop(0, `rgba(${rgb},${String(alpha)})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
}

/** A vertical gradient over the whole painting. */
function sky(ctx: Ctx, w: number, h: number, stops: readonly (readonly [number, string])[]) {
  const g = ctx.createLinearGradient(0, 0, 0, h) as CanvasGradient | undefined;
  if (!g) {
    return;
  }
  for (const [o, c] of stops) {
    g.addColorStop(o, c);
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Brush texture: faint light and dark dabs all over, so flat areas read as paint. */
function dabs(ctx: Ctx, w: number, h: number, seed: number) {
  const rng = createRng(seed);
  const count = Math.min(9000, Math.round((w * h) / 350));
  const size = h * 0.005;
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const light = rng() < 0.5;
    ctx.fillStyle = light ? "rgba(255,248,235,0.03)" : "rgba(10,8,20,0.035)";
    ctx.beginPath();
    ctx.ellipse(x, y, size * (0.6 + rng()), size * (0.25 + 0.3 * rng()), rng() * 3.14, 0, 6.283);
    ctx.fill();
  }
}

function paintRuins(ctx: Ctx, w: number, h: number) {
  const a = w / h;
  const x = (off: number) => at(a, off) * h;
  sky(ctx, w, h, [
    [0, "#1f2b48"],
    [0.3, "#4d5a7e"],
    [0.5, "#c99a86"],
    [0.58, "#efc193"],
    [1, "#2b3141"],
  ]);
  glow(ctx, x(-0.3), 0.5 * h, 0.7 * h, "255,206,150", 0.5);
  glow(ctx, x(-0.3), 0.52 * h, 0.08 * h, "255,236,200", 0.8);
  ridge(ctx, w, h, 11, 0.52, 0.07, "#8a8aa6");
  band(ctx, w, h, 0.55, 0.06, "236,214,200", 0.55);
  ridge(ctx, w, h, 23, 0.6, 0.06, "#636b88");
  band(ctx, w, h, 0.63, 0.05, "220,206,206", 0.5);
  ridge(ctx, w, h, 37, 0.7, 0.045, "#3f4862");
  band(ctx, w, h, 0.72, 0.05, "200,196,210", 0.4);
  // The valley floor.
  ridge(ctx, w, h, 41, 0.8, 0.02, "#283041");
  sky(ctx, w, h, [
    [0.7, "rgba(20,24,34,0)"],
    [1, "rgba(14,16,24,0.85)"],
  ]);

  // Broken columns far off on the left.
  ctx.fillStyle = "#59607a";
  for (const [off, top, wide] of [
    [-0.62, 0.6, 0.022],
    [-0.55, 0.63, 0.02],
    [-0.75, 0.62, 0.018],
  ]) {
    ctx.fillRect(x(off) - (wide * h) / 2, top * h, wide * h, (0.71 - top) * h);
  }

  // The arch on its mound, lit from the low sun on the left.
  const cx = x(0.48);
  const ground = 0.76 * h;
  ctx.fillStyle = "#222836";
  ctx.beginPath();
  ctx.ellipse(cx, ground + 0.03 * h, 0.32 * h, 0.06 * h, 0, Math.PI, 0);
  ctx.fill();
  const pillar = 0.055 * h;
  const span = 0.2 * h;
  const spring = ground - 0.26 * h;
  const stone = "#5f5b66";
  const lit = "#c6a38c";
  const pillarAt = (px: number, top: number, jag: number) => {
    ctx.fillStyle = stone;
    ctx.beginPath();
    ctx.moveTo(px - pillar / 2, ground);
    ctx.lineTo(px - pillar / 2, top);
    ctx.lineTo(px - pillar / 6, top - jag);
    ctx.lineTo(px + pillar / 5, top + jag * 0.5);
    ctx.lineTo(px + pillar / 2, top - jag * 0.3);
    ctx.lineTo(px + pillar / 2, ground);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = lit;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(px - pillar / 2, top, pillar * 0.22, ground - top);
    ctx.globalAlpha = 1;
  };
  pillarAt(cx - span / 2 - pillar / 2, spring, 0);
  pillarAt(cx + span / 2 + pillar / 2, spring + 0.07 * h, 0.012 * h);
  // Voussoirs round the arch, with a few fallen out on the right.
  const inner = span / 2;
  const outer = inner + pillar;
  const blocks = 11;
  for (let i = 0; i < blocks; i++) {
    if (i >= 7) {
      continue;
    }
    const a0 = Math.PI + (i / blocks) * Math.PI + 0.012;
    const a1 = Math.PI + ((i + 1) / blocks) * Math.PI - 0.012;
    ctx.beginPath();
    ctx.arc(cx, spring, outer, a0, a1);
    ctx.arc(cx, spring, inner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = i < 4 ? lit : stone;
    ctx.globalAlpha = i < 4 ? 0.85 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  // Fallen blocks.
  ctx.fillStyle = stone;
  ctx.fillRect(cx + span * 0.75, ground - 0.025 * h, 0.05 * h, 0.025 * h);
  ctx.fillRect(cx + span * 0.95, ground - 0.018 * h, 0.035 * h, 0.018 * h);
  ctx.fillRect(cx - span * 0.95, ground - 0.015 * h, 0.03 * h, 0.015 * h);
  band(ctx, w, h, 0.77, 0.04, "210,200,214", 0.35);
}

function paintSpacePort(ctx: Ctx, w: number, h: number) {
  const a = w / h;
  const x = (off: number) => at(a, off) * h;
  sky(ctx, w, h, [
    [0, "#060716"],
    [0.45, "#191340"],
    [0.75, "#3d2252"],
    [1, "#0b0a16"],
  ]);
  const rng = createRng(77);
  for (let i = 0; i < 360; i++) {
    const sx = rng() * w;
    const sy = rng() * 0.72 * h;
    const b = 0.25 + 0.6 * rng() * rng();
    ctx.fillStyle = `rgba(230,236,255,${b.toFixed(3)})`;
    const r = Math.max(0.6, h * 0.0012 * (0.6 + rng()));
    ctx.fillRect(sx, sy, r, r);
  }
  // The gas giant, its ring behind and in front.
  const px = x(-0.5);
  const py = 0.3 * h;
  const pr = 0.4 * h;
  const ring = (start: number, end: number) => {
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-0.28);
    ctx.beginPath();
    ctx.ellipse(0, 0, pr * 1.75, pr * 0.32, 0, start, end);
    ctx.strokeStyle = "rgba(226,196,168,0.4)";
    ctx.lineWidth = 0.022 * h;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,226,196,0.25)";
    ctx.lineWidth = 0.006 * h;
    ctx.stroke();
    ctx.restore();
  };
  ring(Math.PI, 2 * Math.PI);
  ctx.save();
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, 2 * Math.PI);
  ctx.clip();
  const colours = ["#d39a6a", "#b8714d", "#e8c49a", "#9a5a45", "#e0b080", "#c7865c"];
  let y = py - pr;
  let k = 0;
  while (y < py + pr) {
    const bh = (0.02 + 0.05 * rng()) * h;
    ctx.fillStyle = colours[k % colours.length];
    ctx.beginPath();
    ctx.moveTo(px - pr, y + bh);
    for (let i = 0; i <= 24; i++) {
      const bx = px - pr + (i / 24) * 2 * pr;
      ctx.lineTo(bx, y + Math.sin(i * 0.9 + k) * 0.004 * h);
    }
    ctx.lineTo(px + pr, y + bh + 0.01 * h);
    ctx.lineTo(px - pr, y + bh + 0.01 * h);
    ctx.closePath();
    ctx.fill();
    y += bh;
    k++;
  }
  // Night side: lit from the upper right.
  const shade = ctx.createRadialGradient(
    px + 0.35 * pr,
    py - 0.3 * pr,
    0.1 * pr,
    px + 0.1 * pr,
    py,
    1.15 * pr,
  ) as CanvasGradient | undefined;
  if (shade) {
    shade.addColorStop(0, "rgba(8,6,24,0)");
    shade.addColorStop(0.45, "rgba(8,6,24,0.3)");
    shade.addColorStop(0.85, "rgba(8,6,24,0.85)");
    shade.addColorStop(1, "rgba(8,6,24,0.95)");
    ctx.fillStyle = shade;
    ctx.fillRect(px - pr, py - pr, 2 * pr, 2 * pr);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(px, py, pr, -1.6, 0.4);
  ctx.strokeStyle = "rgba(255,206,170,0.35)";
  ctx.lineWidth = 0.008 * h;
  ctx.stroke();
  ring(0, Math.PI);
  glow(ctx, px, py, pr * 1.4, "180,120,140", 0.12);

  // The port: towers and gantries along the bottom.
  band(ctx, w, h, 0.74, 0.08, "120,70,140", 0.35);
  ctx.fillStyle = "#0e0c1c";
  ctx.fillRect(0, 0.76 * h, w, 0.24 * h);
  const towers = createRng(91);
  for (let tx = 0; tx < w;) {
    const tw = (0.03 + 0.06 * towers()) * h;
    const th = (0.03 + 0.14 * towers() * towers()) * h;
    ctx.fillStyle = towers() < 0.5 ? "#100e20" : "#141127";
    ctx.fillRect(tx, 0.76 * h - th, tw, th + 1);
    // Lit windows.
    for (let j = 0; j < 6; j++) {
      if (towers() < 0.55) {
        ctx.fillStyle = towers() < 0.7 ? "rgba(255,196,120,0.7)" : "rgba(150,200,255,0.7)";
        ctx.fillRect(
          tx + towers() * (tw - 0.006 * h),
          0.76 * h - th + towers() * th,
          0.004 * h,
          0.003 * h,
        );
      }
    }
    tx += tw + towers() * 0.03 * h;
  }
  // Masts the far beacons sit on.
  ctx.fillStyle = "#121026";
  ctx.fillRect(x(-0.62) - 0.004 * h, 0.5 * h, 0.008 * h, 0.27 * h);
  ctx.fillRect(x(0.86) - 0.004 * h, 0.47 * h, 0.008 * h, 0.3 * h);

  // The docked ship: a long wedge, its upper edge caught by the planet's light.
  const sx = x(0.5);
  const hull = (dx: number, dy: number) => [sx + dx * h, dy * h] as const;
  const outline = [
    hull(-0.3, 0.605),
    hull(-0.12, 0.55),
    hull(0.08, 0.53),
    hull(0.16, 0.49),
    hull(0.24, 0.5),
    hull(0.25, 0.56),
    hull(0.3, 0.6),
    hull(0.28, 0.66),
    hull(-0.08, 0.67),
  ];
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (const [ox, oy] of outline) {
    ctx.lineTo(ox, oy);
  }
  ctx.closePath();
  ctx.fillStyle = "#17172a";
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < 5; i++) {
    ctx.lineTo(outline[i][0], outline[i][1]);
  }
  ctx.strokeStyle = "rgba(255,190,150,0.55)";
  ctx.lineWidth = 0.004 * h;
  ctx.stroke();
  // Hull panels and a row of ports.
  ctx.fillStyle = "rgba(120,130,170,0.18)";
  ctx.fillRect(sx - 0.1 * h, 0.585 * h, 0.3 * h, 0.006 * h);
  for (let i = 0; i < 9; i++) {
    ctx.fillStyle = "rgba(160,210,255,0.55)";
    ctx.fillRect(sx + (-0.06 + i * 0.03) * h, 0.6 * h, 0.006 * h, 0.004 * h);
  }
  // Engine glow and a gantry to the nearest tower.
  glow(ctx, sx + 0.29 * h, 0.62 * h, 0.04 * h, "120,180,255", 0.5);
  ctx.fillStyle = "#0f0d1e";
  ctx.fillRect(sx - 0.02 * h, 0.66 * h, 0.012 * h, 0.1 * h);
  ctx.fillRect(sx + 0.18 * h, 0.66 * h, 0.012 * h, 0.1 * h);
  ctx.fillRect(sx - 0.05 * h, 0.7 * h, 0.3 * h, 0.008 * h);
}

function paintForest(ctx: Ctx, w: number, h: number) {
  const a = w / h;
  const x = (off: number) => at(a, off) * h;
  sky(ctx, w, h, [
    [0, "#24382c"],
    [0.4, "#7f9670"],
    [0.55, "#b9c28e"],
    [0.75, "#4f6248"],
    [1, "#151d15"],
  ]);
  const rng = createRng(53);
  const trunks = (count: number, fill: string, wide: number, alpha: number) => {
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha;
    for (let i = 0; i < count; i++) {
      const tx = rng() * w;
      const tw = wide * (0.5 + rng()) * h;
      ctx.beginPath();
      ctx.moveTo(tx - tw / 2, h);
      ctx.lineTo(tx - tw * 0.35, 0);
      ctx.lineTo(tx + tw * 0.35, 0);
      ctx.lineTo(tx + tw / 2, h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  trunks(Math.round(26 * a), "#8fa486", 0.018, 0.5);
  band(ctx, w, h, 0.55, 0.15, "220,226,190", 0.35);
  trunks(Math.round(12 * a), "#5c7258", 0.035, 0.75);

  // Light shafts slanting down from the upper left.
  ctx.globalCompositeOperation = "lighter";
  const shafts = createRng(17);
  for (let i = 0; i < 6; i++) {
    const sx = (shafts() * 1.2 - 0.1) * w;
    const sw = (0.03 + 0.06 * shafts()) * h;
    const g = ctx.createLinearGradient(sx, 0, sx + 0.35 * h, h) as CanvasGradient | undefined;
    if (!g) {
      continue;
    }
    g.addColorStop(0, "rgba(255,236,180,0.16)");
    g.addColorStop(0.8, "rgba(255,236,180,0.03)");
    g.addColorStop(1, "rgba(255,236,180,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx + sw, 0);
    ctx.lineTo(sx + sw * 2.2 + 0.4 * h, h);
    ctx.lineTo(sx + 0.4 * h, h);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";

  // The ground and a pale path towards the shrine.
  ctx.fillStyle = "#1d281b";
  ctx.beginPath();
  ctx.moveTo(0, 0.8 * h);
  ctx.quadraticCurveTo(w / 2, 0.76 * h, w, 0.79 * h);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "rgba(170,160,130,0.25)";
  ctx.beginPath();
  ctx.moveTo(x(0.61) - 0.03 * h, 0.775 * h);
  ctx.lineTo(x(0.61) + 0.03 * h, 0.775 * h);
  ctx.lineTo(x(0.2) + 0.18 * h, h);
  ctx.lineTo(x(0.2) - 0.08 * h, h);
  ctx.closePath();
  ctx.fill();

  // The shrine: a small hall with a sweeping roof on a stone base.
  const cx = x(0.61);
  const base = 0.775 * h;
  ctx.fillStyle = "#4a4a44";
  ctx.fillRect(cx - 0.09 * h, base - 0.02 * h, 0.18 * h, 0.02 * h);
  ctx.fillStyle = "#3a2820";
  ctx.fillRect(cx - 0.065 * h, base - 0.11 * h, 0.13 * h, 0.09 * h);
  ctx.fillStyle = "rgba(255,190,110,0.5)";
  ctx.fillRect(cx - 0.02 * h, base - 0.08 * h, 0.04 * h, 0.06 * h);
  ctx.fillStyle = "#231a17";
  ctx.beginPath();
  ctx.moveTo(cx - 0.12 * h, base - 0.1 * h);
  ctx.quadraticCurveTo(cx - 0.07 * h, base - 0.115 * h, cx - 0.04 * h, base - 0.17 * h);
  ctx.lineTo(cx + 0.04 * h, base - 0.17 * h);
  ctx.quadraticCurveTo(cx + 0.07 * h, base - 0.115 * h, cx + 0.12 * h, base - 0.1 * h);
  ctx.lineTo(cx + 0.1 * h, base - 0.105 * h);
  ctx.lineTo(cx - 0.1 * h, base - 0.105 * h);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(255,230,180,0.35)";
  ctx.lineWidth = 0.003 * h;
  ctx.stroke();

  // Stone lanterns by the shrine, and paper lanterns hanging on the left.
  const lantern = (off: number, y: number, hanging: boolean) => {
    const lx = x(off);
    glow(ctx, lx, y * h, 0.09 * h, "255,170,80", 0.35);
    if (hanging) {
      ctx.strokeStyle = "#1a1612";
      ctx.lineWidth = 0.002 * h;
      ctx.beginPath();
      ctx.moveTo(lx, 0);
      ctx.lineTo(lx, (y - 0.02) * h);
      ctx.stroke();
      ctx.fillStyle = "#e8873c";
      ctx.beginPath();
      ctx.ellipse(lx, y * h, 0.012 * h, 0.02 * h, 0, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.fillStyle = "#56544c";
      ctx.fillRect(lx - 0.008 * h, y * h, 0.016 * h, (0.775 - y) * h);
      ctx.fillRect(lx - 0.02 * h, (y - 0.03) * h, 0.04 * h, 0.008 * h);
      ctx.fillStyle = "#ffcf8a";
      ctx.fillRect(lx - 0.01 * h, (y - 0.02) * h, 0.02 * h, 0.018 * h);
      ctx.fillStyle = "#56544c";
      ctx.fillRect(lx - 0.016 * h, y * h, 0.032 * h, 0.006 * h);
    }
  };
  lantern(0.48, 0.7, false);
  lantern(0.74, 0.7, false);
  lantern(-0.55, 0.42, true);
  lantern(-0.72, 0.36, true);

  // Near trunks framing the edges, and the canopy's shade above.
  ctx.fillStyle = "#0f160f";
  for (const [fx, wide] of [
    [0.02, 0.1],
    [0.12, 0.05],
    [0.99, 0.12],
  ]) {
    const tx = fx * w;
    const tw = wide * h;
    ctx.beginPath();
    ctx.moveTo(tx - tw / 2, h);
    ctx.lineTo(tx - tw * 0.4, 0);
    ctx.lineTo(tx + tw * 0.4, 0);
    ctx.lineTo(tx + tw / 2, h);
    ctx.closePath();
    ctx.fill();
  }
  sky(ctx, w, h, [
    [0, "rgba(10,18,10,0.7)"],
    [0.18, "rgba(10,18,10,0)"],
  ]);
}

/** Paints `art` on `ctx`, a canvas `w` x `h` px. */
export function paintArt(ctx: Ctx, art: ArtId, w: number, h: number): void {
  if (art === "spaceport") {
    paintSpacePort(ctx, w, h);
  } else if (art === "forest") {
    paintForest(ctx, w, h);
  } else {
    paintRuins(ctx, w, h);
  }
  dabs(ctx, w, h, art === "spaceport" ? 5 : art === "forest" ? 6 : 4);
}
