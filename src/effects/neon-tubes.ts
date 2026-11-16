/**
 * Neon tubes from text, shared by the effects that draw neon lettering (Neon
 * Sign, Just Chatting Corner): the lettering is drawn once with a system font,
 * turned into a distance field to the strokes' centrelines on the CPU and a
 * blurred low-res copy that lights the wall, with mounting clips along each
 * line; the shader shades tubes from the field with `NEON_EMIT_GLSL`. Also the
 * slow shimmer and the warm-up.
 *
 * Lengths are in reference px (a 1080px-tall frame) unless they say otherwise,
 * so nothing here is rebuilt on a resize that keeps the aspect ratio.
 */
import { glslFloat } from "./gl";
import { clamp, smoothstep } from "./math";

/** The reference frame height: lengths in reference px are fractions of this. */
const REF_HEIGHT = 1080;

/**
 * A rounded system font stack at a light weight, so the strokes are thin and even
 * like bent tube. No font is bundled.
 */
const NEON_FONT_FAMILY = `ui-rounded, "SF Pro Rounded", "Varela Round", "Nunito", "Quicksand", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const NEON_FONT_WEIGHT = 300;
/** Advance per code point, in ems, when the font can't be measured. */
const FALLBACK_ADVANCE = 0.6;

// Tubes.
/** Tube radius, in font sizes, and its smallest value (reference px). */
const TUBE_RADIUS_EM = 0.034;
const MIN_TUBE_RADIUS = 2;
/** Distance-field texel size (reference px). */
export const FIELD_TEXEL = 1.5;
/** How far the halo reaches beyond the tube centre, in tube radii. */
const HALO_RADII = 12;

// Wall glow.
/** Glow texel size (reference px) and the blur's box radius in texels (three passes). */
export const GLOW_TEXEL = 16;
const GLOW_BLUR = 5;
/** Margin around the field's box, in glow texels: wider than the blur reaches, so the edges stay black. */
export const GLOW_MARGIN = 3 * GLOW_BLUR + 3;

/** A line's advance width in ems when the font can't be measured. */
export function fallbackWidthEm(line: string): number {
  return Array.from(line).length * FALLBACK_ADVANCE;
}

/**
 * The lines' advance widths in ems in the neon font, measured on a canvas, or
 * estimated when the font can't be measured.
 */
export function measureLines(lines: readonly string[]): number[] {
  const measure = new OffscreenCanvas(1, 1).getContext("2d");
  if (measure) {
    measure.font = `${String(NEON_FONT_WEIGHT)} 100px ${NEON_FONT_FAMILY}`;
  }
  return lines.map((l) => {
    // Undefined without a context, and from the tests' fake one, whose methods all return undefined.
    const metrics = measure?.measureText(l);
    const w = metrics?.width;
    return typeof w === "number" && w > 0 ? w / 100 : fallbackWidthEm(l);
  });
}

/** Tube radius (reference px) for a font size in frame heights. */
export function tubeRadius(font: number): number {
  return Math.max(MIN_TUBE_RADIUS, TUBE_RADIUS_EM * font * REF_HEIGHT);
}

/**
 * The field's grid: the lettering's box plus the halo's reach, in texels of
 * `FIELD_TEXEL` reference px. `left`/`top` are the grid's origin (reference px).
 */
interface FieldGrid {
  left: number;
  top: number;
  cols: number;
  rows: number;
  /** Margin around the lettering, in texels. */
  pad: number;
}

/** A box of lettering: left, top, width and height (frame heights, y down). */
interface TubeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function fieldGrid(layout: TubeBox, radius: number): FieldGrid {
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
    if (f[q] === Infinity) {
      continue;
    }
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
    while (z[k + 1] < q) {
      k++;
    }
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
  for (let i = 0; i < w * h; i++) {
    out[i] = mask[i] === target ? 0 : Infinity;
  }
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      f[y] = out[y * w + x];
    }
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) {
      out[y * w + x] = d[y];
    }
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      f[x] = out[row + x];
    }
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) {
      out[row + x] = d[x];
    }
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
  if (!mask.subarray(0, w * h).includes(1)) {
    return { dist, halfStroke: 0 };
  }
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
    for (let i = -r; i <= r; i++) {
      if (i >= 0 && i < len) {
        acc += src[base + i * step];
      }
    }
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = acc * norm;
      const out = i - r;
      const inn = i + r + 1;
      if (out >= 0) {
        acc -= src[base + out * step];
      }
      if (inn < len) {
        acc += src[base + inn * step];
      }
    }
  }
}

interface GlowGrid {
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
      if (dist[y * field.cols + x] >= radius) {
        continue;
      }
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
        if (first < 0) {
          first = x;
        }
        last = x;
        break;
      }
    }
  }
  if (first < 0) {
    return [];
  }
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
      if (x < 0 || x >= cols) {
        continue;
      }
      for (let y = top; y < bottom; y++) {
        if (dist[y * cols + x] >= on) {
          continue;
        }
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
const CLIP_HALF_W = 0.9;
const CLIP_HALF_H = 2.4;

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
const RIPPLE_W1 = (TAU * 12) / SHIMMER_PERIOD;
const RIPPLE_W2 = (TAU * 17) / SHIMMER_PERIOD;
const BREATH_W = (TAU * 5) / SHIMMER_PERIOD;
/** Spatial wavenumbers (rad per reference px): wavelengths of about 420 and 260 px. */
const RIPPLE_K1 = TAU / 420;
const RIPPLE_K2 = TAU / 260;

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

/** Placed lettering: a `TubeBox` with its font and how its lines are anchored. */
interface TubeLettering extends TubeBox {
  /** Font size (frame heights). */
  font: number;
  /** Distance between line centres, in font sizes. */
  pitch: number;
  /** Canvas text alignment and the x every line is anchored at (frame heights). */
  align: "left" | "center" | "right";
  anchor: number;
}

/** A float texture's size and texels, row by row from the top. */
interface TubeTexture {
  cols: number;
  rows: number;
  data: Float32Array;
}

/** What `buildNeonTubes` makes: the textures, where they go and the tubes' size. */
interface NeonTubes {
  /**
   * RGBA: centreline distance (reference px) to line 1's and line 2's tubes,
   * then the clips' coverage and their top-to-bottom shade.
   */
  field: TubeTexture;
  /** RG: the light line 1's and line 2's tubes cast on the wall. */
  glow: TubeTexture;
  /** The field's and the glow's boxes: left, top (reference px), then 1 / width, 1 / height. */
  fieldBox: [number, number, number, number];
  glowBox: [number, number, number, number];
  /** Tube radius and the halo's reach (reference px). */
  radius: number;
  reach: number;
}

/**
 * Draws `lines` (each with its colour index, 0 or 1, and in that order down
 * the lettering) at `layout` with the neon font, and builds the tubes'
 * distance field with up to `maxClips` clips a line, and the blurred light they
 * throw on the wall.
 */
export function buildNeonTubes(
  lines: readonly { text: string; index: number }[],
  layout: TubeLettering,
  maxClips: number,
): NeonTubes {
  const radius = tubeRadius(layout.font);
  const reach = HALO_RADII * radius;
  const grid = fieldGrid(layout, radius);
  const { cols, rows } = grid;
  const toTexel = REF_HEIGHT / FIELD_TEXEL;

  // Line 1 in red, line 2 in green, so each gets its own field.
  const canvas = new OffscreenCanvas(cols, rows);
  const ctx = canvas.getContext("2d");
  const rowCentre = (k: number) =>
    (layout.y + (k + 0.5) * layout.pitch * layout.font) * toTexel - grid.top / FIELD_TEXEL;
  let pixels: Uint8ClampedArray | undefined;
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cols, rows);
    ctx.globalCompositeOperation = "lighter";
    ctx.font = `${String(NEON_FONT_WEIGHT)} ${String(layout.font * toTexel)}px ${NEON_FONT_FAMILY}`;
    ctx.textAlign = layout.align;
    ctx.textBaseline = "middle";
    const ax = layout.anchor * toTexel - grid.left / FIELD_TEXEL;
    lines.forEach((l, k) => {
      ctx.fillStyle = l.index === 0 ? "#f00" : "#0f0";
      ctx.fillText(l.text, ax, rowCentre(k));
    });
    const image = ctx.getImageData(0, 0, cols, rows) as ImageData | undefined;
    pixels = image?.data;
  }
  const masks = [new Uint8Array(cols * rows), new Uint8Array(cols * rows)];
  if (pixels) {
    for (let i = 0; i < cols * rows; i++) {
      masks[0][i] = pixels[4 * i] > 127 ? 1 : 0;
      masks[1][i] = pixels[4 * i + 1] > 127 ? 1 : 0;
    }
  }
  const dists = masks.map((m) => centrelineDistance(m, cols, rows, reach).dist);

  // Clips along each line's tubes.
  const cover = new Float32Array(cols * rows);
  const shade = new Float32Array(cols * rows);
  const halfPitch = Math.trunc(0.5 * layout.pitch * layout.font * toTexel);
  lines.forEach((l, k) => {
    const c = rowCentre(k);
    const top = Math.max(0, Math.floor(c - halfPitch));
    const bottom = Math.min(rows, Math.ceil(c + halfPitch));
    const mid = c + 0.08 * layout.font * toTexel;
    const dist = dists[l.index];
    for (const [x, y] of placeClips(dist, cols, top, bottom, mid, radius, maxClips)) {
      drawClip(cover, shade, cols, rows, x, y, radius);
    }
  });

  const data = new Float32Array(cols * rows * 4);
  for (let i = 0; i < cols * rows; i++) {
    data[4 * i] = dists[0][i];
    data[4 * i + 1] = dists[1][i];
    data[4 * i + 2] = cover[i];
    data[4 * i + 3] = shade[i];
  }

  const gg = glowGrid(grid);
  const g0 = glowField(dists[0], grid, gg, radius);
  const g1 = glowField(dists[1], grid, gg, radius);
  const glow = new Float32Array(gg.cols * gg.rows * 2);
  for (let i = 0; i < g0.length; i++) {
    glow[2 * i] = g0[i];
    glow[2 * i + 1] = g1[i];
  }

  return {
    field: { cols, rows, data },
    glow: { cols: gg.cols, rows: gg.rows, data: glow },
    fieldBox: [grid.left, grid.top, 1 / (cols * FIELD_TEXEL), 1 / (rows * FIELD_TEXEL)],
    glowBox: [gg.left, gg.top, 1 / (gg.cols * GLOW_TEXEL), 1 / (gg.rows * GLOW_TEXEL)],
    radius,
    reach,
  };
}

/**
 * GLSL for `vec3 neonEmit(float d, vec3 c, vec4 tube)`: one line's light at
 * centreline distance `d` (reference px) in colour `c`, a tube body with a
 * white-hot core, then its halo. `tube` is the tube's radius, the halo's reach,
 * the core's width (in radii) and the edge's softness (reference px).
 */
export const NEON_EMIT_GLSL = /* glsl */ `
vec3 neonEmit(float d, vec3 c, vec4 tube) {
  float r = tube.x;
  float body = 1.0 - smoothstep(r - tube.w, r + tube.w, d);
  float x = d / (tube.z * r);
  vec3 lit = mix(c * 1.3, vec3(1.0), 0.85 * exp(-x * x)) * body;
  float halo = 0.55 * exp(-d / (1.4 * r)) + 0.16 * exp(-d / (4.5 * r));
  halo *= 1.0 - smoothstep(0.5 * tube.y, tube.y, d);
  return lit + c * halo * (1.0 - body);
}
`;
