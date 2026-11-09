/**
 * Pure JS parts of the snowy window effect (snowwindow.ts): the window layouts
 * (pane rectangles) and the condensation mask built on the CPU. Nothing here
 * touches GL, so it is all unit tested.
 *
 * Units: "height units", where the canvas is 1 tall and `aspect` wide, with y up
 * from the bottom edge (matching `gl_FragCoord / height`).
 */
import { clamp } from "../math";
import { createNoise, createRng, fbm2, type Noise } from "../noise";

/** A rectangle in height units: left, bottom, right, top. */
export type Rect = readonly [x0: number, y0: number, x1: number, y1: number];

/** Frame width at the sides and the top. */
export const FRAME_SIDE = 0.05;
export const FRAME_TOP = 0.05;
/** Bottom rail and sill, together. */
export const FRAME_BOTTOM = 0.11;
/** Glazing bar width. */
export const BAR = 0.03;
/** Height of the top row of panes in the four-pane layout. */
export const TOP_BAND = 0.15;
/** Most panes in any layout. */
export const MAX_PANES = 6;

export type LayoutId = "four" | "six" | "frame";

/** The layout for a select value; unknown values fall back to four panes. */
export const layoutId = (value: string): LayoutId =>
  value === "six" || value === "frame" ? value : "four";

export type SceneId = "pines" | "village" | "plain";
const SCENES: readonly SceneId[] = ["pines", "village", "plain"];

/** The shader's index for a scene select value; unknown values fall back to pines. */
export const sceneIndex = (value: string): number =>
  Math.max(0, (SCENES as readonly string[]).indexOf(value));

/**
 * Where the speaker's face and shoulders usually sit: the middle third across,
 * from just above the sill to three quarters up. Four panes and the bare frame
 * keep their bars out of it.
 */
export const faceArea = (aspect: number): Rect => [aspect / 3, 0.2, (aspect * 2) / 3, 0.75];

/**
 * The window opening inside the frame. On a very narrow canvas the side frame
 * thins so the opening stays on the canvas.
 */
export const interior = (aspect: number): Rect => {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const side = Math.min(FRAME_SIDE, a * 0.1);
  return [side, FRAME_BOTTOM, a - side, 1 - FRAME_TOP];
};

/** Narrowest pane a row keeps; a row too narrow for its columns drops some. */
const MIN_PANE = BAR;

/**
 * Up to `cols` panes side by side across [x0, x1], with glazing bars between
 * them: as many as fit at least `MIN_PANE` wide.
 */
function row(out: Rect[], x0: number, x1: number, y0: number, y1: number, want: number): void {
  const fit = Math.floor((x1 - x0 + BAR) / (MIN_PANE + BAR));
  const cols = Math.max(1, Math.min(want, fit));
  const w = (x1 - x0 - BAR * (cols - 1)) / cols;
  for (let c = 0; c < cols; c++) {
    const left = x0 + c * (w + BAR);
    out.push([left, y0, c === cols - 1 ? x1 : left + w, y1]);
  }
}

/**
 * The panes of `layout` on a canvas `aspect` wide, bottom row first:
 *
 * - four: a large lower pane and three small ones above one high bar, whose two
 *   short vertical bars stay in the top band;
 * - six: two rows of three, crossing the centre;
 * - frame: the whole opening.
 */
export function windowPanes(layout: LayoutId, aspect: number): Rect[] {
  const [x0, y0, x1, y1] = interior(aspect);
  const panes: Rect[] = [];
  if (layout === "frame") {
    panes.push([x0, y0, x1, y1]);
  } else if (layout === "four") {
    const barTop = y1 - TOP_BAND;
    panes.push([x0, y0, x1, barTop - BAR]);
    row(panes, x0, x1, barTop, y1, 3);
  } else {
    const mid = (y0 + y1) / 2;
    row(panes, x0, x1, y0, mid - BAR / 2, 3);
    row(panes, x0, x1, mid + BAR / 2, y1, 3);
  }
  return panes;
}

/** Index of the pane containing (x, y), or -1 (on the frame or a bar). */
export function paneAt(panes: readonly Rect[], x: number, y: number): number {
  for (let i = 0; i < panes.length; i++) {
    const [x0, y0, x1, y1] = panes[i];
    if (x >= x0 && x < x1 && y >= y0 && y < y1) {
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Condensation
// ---------------------------------------------------------------------------

/** Rows of the condensation mask; its columns follow the aspect ratio. */
export const COND_ROWS = 360;
/** Most columns, for very wide canvases. */
const COND_MAX_COLS = 2048;

/** Size of the condensation mask for a canvas `aspect` wide. */
export function condensationSize(aspect: number): { width: number; height: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return { width: clamp(Math.round(COND_ROWS * a), 1, COND_MAX_COLS), height: COND_ROWS };
}

/**
 * Fog density (0..1) at (x, y) in pane `p`: strongest in its lower corners, with
 * a lighter band along its bottom edge and smaller patches in its top corners,
 * the edge broken up by noise.
 */
export function fogDensity(p: Rect, x: number, y: number, noise: Noise): number {
  const x0 = p[0];
  const y0 = p[1];
  const x1 = p[2];
  const y1 = p[3];
  const reach = Math.min(0.45, 0.8 * Math.min(x1 - x0, y1 - y0));
  const dl = x - x0;
  const dr = x1 - x;
  const db = y - y0;
  const dt = y1 - y;
  const dx = Math.min(dl, dr);
  const corner = 1 - Math.hypot(dx, db) / reach;
  const bottom = 0.55 * (1 - db / (0.4 * reach));
  const top = 0.6 * (1 - Math.hypot(dx, dt) / (0.45 * reach));
  const f = Math.max(corner, bottom, top);
  // Clear glass away from the corners and edges: no noise to evaluate.
  if (f <= 0) {
    return 0;
  }
  const n = fbm2(noise, x * 7, y * 7, 2);
  const g = clamp(f * (1 + 0.45 * n) + 0.08 * n, 0, 1);
  return g * g * (3 - 2 * g);
}

/** Droplets per unit of pane area, before the fog decides where they stick. */
const DROPS_PER_AREA = 50;
/** Droplet radius range, in 1080p px. */
const DROP_MIN_PX = 6;
const DROP_MAX_PX = 14;
/** Fog density a droplet needs to form. */
const DROP_FOG = 0.55;
/**
 * Droplet edge encoding: G = 0.5 + (radius - distance) * texels * DROP_RAMP, so
 * one texel moves G by DROP_RAMP and the shader can find a sharp edge at 0.5.
 */
export const DROP_RAMP = 0.25;

/**
 * Builds the condensation mask for `panes` on a canvas `aspect` wide into `out`
 * (RGBA8, `width` x `height`, row 0 at the bottom): R the fog density, G each
 * droplet's edge distance (0.5 on the edge, see `DROP_RAMP`), B a soft highlight
 * in each droplet, A unused. R is zero outside the panes. Deterministic per `seed`.
 */
export function buildCondensation(
  out: Uint8Array,
  width: number,
  height: number,
  aspect: number,
  panes: readonly Rect[],
  seed: number,
): void {
  out.fill(0);
  const s = Math.floor(clamp(Number.isFinite(seed) ? seed : 0, 0, 1e6));
  const noise = createNoise(s * 31 + 7);
  const rng = createRng(s * 131 + 3);
  const sx = aspect / width;
  const sy = 1 / height;

  // Each pane's texels: those whose centres lie in it (as `paneAt` decides).
  for (const p of panes) {
    const i0 = Math.max(0, Math.ceil(p[0] / sx - 0.5));
    const i1 = Math.min(width, Math.ceil(p[2] / sx - 0.5));
    const j0 = Math.max(0, Math.ceil(p[1] / sy - 0.5));
    const j1 = Math.min(height, Math.ceil(p[3] / sy - 0.5));
    for (let j = j0; j < j1; j++) {
      const y = (j + 0.5) * sy;
      for (let i = i0; i < i1; i++) {
        const v = fogDensity(p, (i + 0.5) * sx, y, noise);
        if (v > 0) {
          out[(j * width + i) * 4] = Math.round(v * 255);
        }
      }
    }
  }

  // Droplets, where the fog is thick enough. Edge distances in texels (rows).
  for (const p of panes) {
    const [x0, y0, x1, y1] = p;
    const drops = Math.round(DROPS_PER_AREA * (x1 - x0) * (y1 - y0));
    for (let d = 0; d < drops; d++) {
      const cx = x0 + rng() * (x1 - x0);
      const cy = y0 + rng() * (y1 - y0);
      const r = (DROP_MIN_PX + (DROP_MAX_PX - DROP_MIN_PX) * rng() ** 2) / 1080;
      if (fogDensity(p, cx, cy, noise) < DROP_FOG) {
        continue;
      }
      // Keep the whole drop on its pane.
      if (cx - r < x0 || cx + r > x1 || cy - r < y0 || cy + r > y1) {
        continue;
      }
      const hx = cx - 0.35 * r;
      const hy = cy + 0.35 * r;
      const hr = 0.35 * r + 0.7 * sy;
      const reach = r + 3 * sy;
      const i0 = Math.max(0, Math.floor((cx - reach) / sx));
      const i1 = Math.min(width - 1, Math.ceil((cx + reach) / sx));
      const j0 = Math.max(0, Math.floor((cy - reach) / sy));
      const j1 = Math.min(height - 1, Math.ceil((cy + reach) / sy));
      for (let j = j0; j <= j1; j++) {
        const y = (j + 0.5) * sy;
        for (let i = i0; i <= i1; i++) {
          const x = (i + 0.5) * sx;
          const o = (j * width + i) * 4;
          const edge = 0.5 + ((r - Math.hypot(x - cx, y - cy)) / sy) * DROP_RAMP;
          const g = Math.round(clamp(edge, 0, 1) * 255);
          if (g > out[o + 1]) {
            out[o + 1] = g;
          }
          const h = clamp(1 - Math.hypot(x - hx, y - hy) / hr, 0, 1);
          const b = Math.round(h * h * 255);
          if (b > out[o + 2]) {
            out[o + 2] = b;
          }
        }
      }
    }
  }
}
