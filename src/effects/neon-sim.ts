/**
 * The pure logic behind the neon sign (neon.ts): where the text goes, the
 * distance field its tubes are shaded from, the blurred light it casts on the
 * wall, where the mounting clips sit, and the slow shimmer and warm-up.
 *
 * Lengths are in reference px (a 1080px-tall frame) unless they say otherwise,
 * so nothing here is rebuilt on a resize that keeps the aspect ratio.
 */
import { glslFloat } from "./gl";
import { clamp, smoothstep } from "./math";
import type { NeonPosition } from "./neon.meta";

/** The reference frame height: lengths in reference px are fractions of this. */
export const REF_HEIGHT = 1080;

// Layout, in frame heights.
/** Gap above the sign's lettering. */
export const TOP_MARGIN = 0.07;
/** Gap between the lettering and the frame's side edge. */
export const SIDE_MARGIN = 0.06;
/** Largest font size, for a short phrase. */
export const MAX_FONT = 0.14;
/** Distance between line centres, in font sizes. */
export const LINE_PITCH = 1.2;
/** Tallest the lettering may be, so the sign stays in the upper part of the frame. */
export const REGION_HEIGHT = 0.32;
/** Advance per code point, in ems, when the font can't be measured. */
export const FALLBACK_ADVANCE = 0.6;

// Tubes.
/** Tube radius, in font sizes, and its smallest value (reference px). */
export const TUBE_RADIUS_EM = 0.034;
export const MIN_TUBE_RADIUS = 2;
/** Distance-field texel size (reference px). */
export const FIELD_TEXEL = 1.5;
/** How far the halo reaches beyond the tube centre, in tube radii. */
export const HALO_RADII = 12;

// Wall glow.
/** Glow texel size (reference px) and the blur's box radius in texels (three passes). */
export const GLOW_TEXEL = 16;
export const GLOW_BLUR = 5;
/** Margin around the field's box, in glow texels: wider than the blur reaches, so the edges stay black. */
export const GLOW_MARGIN = 3 * GLOW_BLUR + 3;

/** Width of the lettering's region (frame heights) at this aspect ratio. */
export function regionWidth(aspect: number, position: NeonPosition): number {
  if (position === "centre")
    return Math.max(0.1, Math.min(aspect - 2 * SIDE_MARGIN, 0.62 * aspect));
  return Math.max(0.1, 0.42 * aspect - SIDE_MARGIN);
}

export interface SignLayout {
  /** Font size (frame heights). */
  font: number;
  /** The lettering's box: left, top, width and height (frame heights, y down). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The region the box must fit inside: left, top, width and height. */
  region: [number, number, number, number];
  /** Canvas text alignment and the x every line is anchored at (frame heights). */
  align: "left" | "center" | "right";
  anchor: number;
}

/**
 * Sizes and places the lettering: as large as `MAX_FONT` allows, shrunk so the
 * widest line fits the region's width and every line fits its height.
 * `widthsEm` are the lines' advance widths at a font size of 1.
 */
export function signLayout(
  aspect: number,
  position: NeonPosition,
  widthsEm: readonly number[],
): SignLayout {
  const lines = Math.max(1, widthsEm.length);
  const widest = Math.max(1e-3, ...widthsEm);
  const rw = regionWidth(aspect, position);
  const font = Math.min(MAX_FONT, rw / widest, REGION_HEIGHT / (lines * LINE_PITCH));
  const w = widest * font;
  const h = lines * LINE_PITCH * font;
  const rx =
    position === "left"
      ? SIDE_MARGIN
      : position === "right"
        ? aspect - SIDE_MARGIN - rw
        : 0.5 * (aspect - rw);
  const x = position === "left" ? rx : position === "right" ? rx + rw - w : 0.5 * (aspect - w);
  const align = position === "left" ? "left" : position === "right" ? "right" : "center";
  const anchor = position === "left" ? x : position === "right" ? x + w : 0.5 * aspect;
  return {
    font,
    x,
    y: TOP_MARGIN,
    w,
    h,
    region: [rx, TOP_MARGIN, rw, REGION_HEIGHT],
    align,
    anchor,
  };
}

/** The lines the sign shows, with their index (0 or 1, for the colour); empty lines are dropped. */
export function signLines(text: string): { text: string; index: number }[] {
  return text
    .split("\n")
    .map((line, index) => ({ text: line.trim(), index }))
    .filter((l) => l.text.length > 0);
}

/** A line's advance width in ems when the font can't be measured. */
export function fallbackWidthEm(line: string): number {
  return Array.from(line).length * FALLBACK_ADVANCE;
}

/** Tube radius (reference px) for a font size in frame heights. */
export function tubeRadius(font: number): number {
  return Math.max(MIN_TUBE_RADIUS, TUBE_RADIUS_EM * font * REF_HEIGHT);
}

/**
 * The field's grid: the lettering's box plus the halo's reach, in texels of
 * `FIELD_TEXEL` reference px. `left`/`top` are the grid's origin (reference px).
 */
export interface FieldGrid {
  left: number;
  top: number;
  cols: number;
  rows: number;
  /** Margin around the lettering, in texels. */
  pad: number;
}

export function fieldGrid(layout: SignLayout, radius: number): FieldGrid {
  const pad = Math.ceil((HALO_RADII * radius + 4) / FIELD_TEXEL);
  const cols = Math.ceil((layout.w * REF_HEIGHT) / FIELD_TEXEL) + 2 * pad;
  const rows = Math.ceil((layout.h * REF_HEIGHT) / FIELD_TEXEL) + 2 * pad;
  return {
    left: layout.x * REF_HEIGHT - pad * FIELD_TEXEL,
    top: layout.y * REF_HEIGHT - pad * FIELD_TEXEL,
    cols,
    rows,
    pad,
  };
}

/**
 * Felzenszwalb and Huttenlocher's 1D squared distance transform of `f` (length
 * `n`) into `d`, with scratch `v` (n ints) and `z` (n + 1 floats).
 */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (f[v[k]] === Infinity) {
      v[k] = q;
      continue;
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = f[v[k]] === Infinity ? Infinity : dq * dq + f[v[k]];
  }
}

/**
 * Exact squared Euclidean distance (in texels) from each texel to the nearest
 * texel where `mask` equals `target`; Infinity everywhere if there is none.
 */
export function squaredDistance(
  mask: Uint8Array,
  w: number,
  h: number,
  target: number,
): Float64Array {
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] === target ? 0 : Infinity;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = out[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) out[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = out[row + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[row + x] = d[x];
  }
  return out;
}

/**
 * Distance (reference px) from each texel to the centreline of the strokes in
 * `mask` (1 = ink), clamped to `maxDist`. System fonts are filled outlines, not
 * single strokes, so this approximates the centreline from the signed distance:
 * the strokes' half-width is twice the mean inside distance (exact for a band of
 * even width), and the centreline distance is the signed distance plus that.
 * Returns the half-width in reference px too. An empty mask is `maxDist` everywhere.
 */
export function centrelineDistance(
  mask: Uint8Array,
  w: number,
  h: number,
  maxDist: number,
): { dist: Float32Array; halfStroke: number } {
  const dist = new Float32Array(w * h).fill(maxDist);
  // A one-line sign leaves line 2's mask empty: skip its transforms.
  if (!mask.subarray(0, w * h).includes(1)) return { dist, halfStroke: 0 };
  const toInk = squaredDistance(mask, w, h, 1);
  const toGap = squaredDistance(mask, w, h, 0);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 1 && toGap[i] !== Infinity) {
      sum += Math.sqrt(toGap[i]) - 0.5;
      count++;
    }
  }
  const half = count > 0 ? (2 * sum) / count : 0;
  for (let i = 0; i < w * h; i++) {
    const signed =
      mask[i] === 1
        ? toGap[i] === Infinity
          ? -half
          : 0.5 - Math.sqrt(toGap[i])
        : Math.sqrt(toInk[i]) - 0.5;
    dist[i] = clamp((signed + half) * FIELD_TEXEL, 0, maxDist);
  }
  return { dist, halfStroke: half * FIELD_TEXEL };
}

/** One box-blur pass of radius `r` along rows (`horizontal`) or columns, `src` into `dst`. */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  r: number,
  horizontal: boolean,
): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const step = horizontal ? 1 : w;
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = horizontal ? l * w : l;
    let acc = 0;
    for (let i = -r; i <= r; i++) if (i >= 0 && i < len) acc += src[base + i * step];
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * norm;
      const out = i - r;
      const inn = i + r + 1;
      if (out >= 0) acc -= src[base + out * step];
      if (inn < len) acc += src[base + inn * step];
    }
  }
}

export interface GlowGrid {
  /** Origin (reference px) and size (texels of `GLOW_TEXEL`). */
  left: number;
  top: number;
  cols: number;
  rows: number;
}

export function glowGrid(field: FieldGrid): GlowGrid {
  const cols = Math.ceil((field.cols * FIELD_TEXEL) / GLOW_TEXEL) + 2 * GLOW_MARGIN;
  const rows = Math.ceil((field.rows * FIELD_TEXEL) / GLOW_TEXEL) + 2 * GLOW_MARGIN;
  return {
    left: field.left - GLOW_MARGIN * GLOW_TEXEL,
    top: field.top - GLOW_MARGIN * GLOW_TEXEL,
    cols,
    rows,
  };
}

/**
 * The light a line of tubes casts on the wall: the fraction of each glow texel
 * the tubes (centreline distance under `radius`) cover, blurred by three box
 * passes into a soft, roughly Gaussian falloff. `dist` is the field over `field`;
 * the result covers `glow` and is zero at its edges.
 */
export function glowField(
  dist: Float32Array,
  field: FieldGrid,
  glow: GlowGrid,
  radius: number,
): Float32Array {
  const a = new Float32Array(glow.cols * glow.rows);
  const per = FIELD_TEXEL / GLOW_TEXEL;
  const area = per * per;
  for (let y = 0; y < field.rows; y++) {
    const gy = Math.floor(y * per) + GLOW_MARGIN;
    for (let x = 0; x < field.cols; x++) {
      if (dist[y * field.cols + x] >= radius) continue;
      const gx = Math.floor(x * per) + GLOW_MARGIN;
      a[gy * glow.cols + gx] += area;
    }
  }
  const b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, glow.cols, glow.rows, GLOW_BLUR, true);
    boxPass(b, a, glow.cols, glow.rows, GLOW_BLUR, false);
  }
  return a;
}

/**
 * Mounting clips for one line: up to `max` points on the tubes, spread evenly
 * across the line's ink and as near the line's middle (`midRow`, texels) as the
 * strokes allow, searching rows `top` to `bottom`. Points are in texels.
 */
export function placeClips(
  dist: Float32Array,
  cols: number,
  top: number,
  bottom: number,
  midRow: number,
  radius: number,
  max: number,
): [number, number][] {
  const on = 0.35 * radius;
  let first = -1;
  let last = -1;
  for (let x = 0; x < cols; x++) {
    for (let y = top; y < bottom; y++) {
      if (dist[y * cols + x] < on) {
        if (first < 0) first = x;
        last = x;
        break;
      }
    }
  }
  if (first < 0) return [];
  const span = last - first;
  const count = clamp(Math.round((span * FIELD_TEXEL) / 170), 1, max);
  const out: [number, number][] = [];
  const reach = Math.max(2, Math.round(radius / FIELD_TEXEL));
  for (let k = 0; k < count; k++) {
    const target = first + (count === 1 ? 0.5 : 0.1 + (0.8 * k) / (count - 1)) * span;
    let best: [number, number] | null = null;
    let bestCost = Infinity;
    for (let dx = -6 * reach; dx <= 6 * reach; dx++) {
      const x = Math.round(target) + dx;
      if (x < 0 || x >= cols) continue;
      for (let y = top; y < bottom; y++) {
        if (dist[y * cols + x] >= on) continue;
        const cost = Math.abs(y - midRow) + 0.6 * Math.abs(dx);
        if (cost < bestCost) {
          bestCost = cost;
          best = [x, y];
        }
      }
    }
    if (best && !out.some(([x, y]) => Math.hypot(x - best[0], y - best[1]) < 4 * reach)) {
      out.push(best);
    }
  }
  return out;
}

/** A clip's half-width and half-height, in tube radii. */
export const CLIP_HALF_W = 0.9;
export const CLIP_HALF_H = 2.4;

/**
 * Draws a clip at (cx, cy) (texels) into `cover` (coverage 0–1, antialiased) and
 * `shade` (0 at its top to 1 at its bottom) over a `cols` x `rows` grid.
 */
export function drawClip(
  cover: Float32Array,
  shade: Float32Array,
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  radius: number,
): void {
  const hw = (CLIP_HALF_W * radius) / FIELD_TEXEL;
  const hh = (CLIP_HALF_H * radius) / FIELD_TEXEL;
  const r = Math.min(hw, hh) * 0.6;
  const x0 = Math.max(0, Math.floor(cx - hw - 1));
  const x1 = Math.min(cols - 1, Math.ceil(cx + hw + 1));
  const y0 = Math.max(0, Math.floor(cy - hh - 1));
  const y1 = Math.min(rows - 1, Math.ceil(cy + hh + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const qx = Math.abs(x - cx) - hw + r;
      const qy = Math.abs(y - cy) - hh + r;
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
      const a = clamp(0.5 - d, 0, 1);
      const i = y * cols + x;
      if (a > cover[i]) {
        cover[i] = a;
        shade[i] = clamp((y - (cy - hh)) / (2 * hh), 0, 1);
      }
    }
  }
}

// Shimmer: two slow travelling ripples along the tubes and a slower breath of the
// whole sign. Every angular frequency is a whole multiple of 2π / SHIMMER_PERIOD,
// so time wraps to that period without a jump.
/** Seconds after which the shimmer repeats exactly. */
export const SHIMMER_PERIOD = 120;
const TAU = 2 * Math.PI;
/** Amplitudes at shimmer 1: together under 10% of the brightness. */
export const RIPPLE_A1 = 0.04;
export const RIPPLE_A2 = 0.025;
export const BREATH_A = 0.015;
/** Angular frequencies (rad/s): 0.1, 0.142 and 0.042 Hz. */
export const RIPPLE_W1 = (TAU * 12) / SHIMMER_PERIOD;
export const RIPPLE_W2 = (TAU * 17) / SHIMMER_PERIOD;
export const BREATH_W = (TAU * 5) / SHIMMER_PERIOD;
/** Spatial wavenumbers (rad per reference px): wavelengths of about 420 and 260 px. */
export const RIPPLE_K1 = TAU / 420;
export const RIPPLE_K2 = TAU / 260;

/** The whole sign's slow breath: a brightness factor near 1. */
export function breath(t: number, amount: number): number {
  return 1 + amount * BREATH_A * Math.sin(BREATH_W * t);
}

/** Brightness factor at reference-px x along the sign, at time t (s). Mirrors `SHIMMER_GLSL`. */
export function shimmerAt(x: number, t: number, amount: number): number {
  const ripple =
    RIPPLE_A1 * Math.sin(RIPPLE_K1 * x - RIPPLE_W1 * t) +
    RIPPLE_A2 * Math.sin(RIPPLE_K2 * x + RIPPLE_W2 * t + 1.7);
  return breath(t, amount) + amount * ripple;
}

/**
 * GLSL for `float ripple(float x, float t)`: the travelling part of `shimmerAt`
 * at shimmer 1 (the effect adds the breath, computed once on the CPU).
 */
export const SHIMMER_GLSL = /* glsl */ `
float ripple(float x, float t) {
  return ${glslFloat(RIPPLE_A1)} * sin(${glslFloat(RIPPLE_K1)} * x - ${glslFloat(RIPPLE_W1)} * t)
    + ${glslFloat(RIPPLE_A2)} * sin(${glslFloat(RIPPLE_K2)} * x + ${glslFloat(RIPPLE_W2)} * t + 1.7);
}
`;

/** Seconds the tubes take to warm up to full brightness after the effect starts. */
export const WARM_UP = 3.5;

/** Brightness during the warm-up: a smooth, monotonic rise from 0 to 1. */
export function warmUp(t: number): number {
  return smoothstep(0, WARM_UP, t);
}
