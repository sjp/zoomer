import type { Rgb } from "./color";
import { beginFrame, createProgram, getUniforms, TO_CLIP_GLSL, withScope } from "./gl";
import { createRng } from "./noise";
import { createGradientBackground, createSpriteBatch, polygonStrip } from "./sprites";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";
import { wrap } from "./math";
import { unitRgbMemo } from "./color";

const MAX_POINTS = 400;
/** Most links drawn per frame; beyond this, the rest are dropped. */
export const LINK_CAP = 8192;
/** Reference drift speed in px/s at 1080p for a speed of 1. */
const DRIFT_PX = 14;
/** Seconds a point takes to fade in after appearing. */
const FADE_IN = 1.5;
/** Links fainter than this (premultiplied, 0..1) are skipped: invisible after 8-bit rounding. */
const MIN_LINK_ALPHA = 0.5 / 255;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Pure logic: wrapping and the uniform-grid neighbour search.
// ---------------------------------------------------------------------------

/** Link opacity for a link of length `t` times the link distance: `(1 - t)²`, 0 beyond 1. */
export function linkFalloff(t: number): number {
  const u = 1 - t;
  return u > 0 ? u * u : 0;
}

/**
 * Uniform grid of point indices, rebuilt each frame by counting sort. Arrays grow
 * only when the cell count increases (on resize or a link distance change).
 */
export interface LinkGrid {
  cols: number;
  rows: number;
  minX: number;
  minY: number;
  cell: number;
  /** Start of each cell's run in `order`; `cellCount + 1` entries are valid. */
  cellStart: Int32Array;
  /** Fill cursor per cell, scratch for the sort. */
  cursor: Int32Array;
  /** Point indices sorted by cell. */
  order: Int32Array;
  /** Cell of each point. */
  cellOf: Int32Array;
}

export function createLinkGrid(maxPoints: number): LinkGrid {
  return {
    cols: 0,
    rows: 0,
    minX: 0,
    minY: 0,
    cell: 1,
    cellStart: new Int32Array(1),
    cursor: new Int32Array(1),
    order: new Int32Array(maxPoints),
    cellOf: new Int32Array(maxPoints),
  };
}

/**
 * Bins points `0 .. n-1` into cells of side `cell` covering `[minX, minX + spanX) ×
 * [minY, minY + spanY)`. Points outside are clamped into the border cells.
 */
export function buildGrid(
  grid: LinkGrid,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  n: number,
  minX: number,
  minY: number,
  spanX: number,
  spanY: number,
  cell: number,
): void {
  const cols = Math.max(1, Math.ceil(spanX / cell));
  const rows = Math.max(1, Math.ceil(spanY / cell));
  const cells = cols * rows;
  if (grid.cellStart.length < cells + 1) {
    grid.cellStart = new Int32Array(cells + 1);
    grid.cursor = new Int32Array(cells);
  }
  grid.cols = cols;
  grid.rows = rows;
  grid.minX = minX;
  grid.minY = minY;
  grid.cell = cell;
  const { cellStart, cursor, order, cellOf } = grid;
  cellStart.fill(0, 0, cells + 1);
  const inv = 1 / cell;
  for (let i = 0; i < n; i++) {
    let cx = Math.floor((xs[i] - minX) * inv);
    let cy = Math.floor((ys[i] - minY) * inv);
    cx = cx < 0 ? 0 : cx >= cols ? cols - 1 : cx;
    cy = cy < 0 ? 0 : cy >= rows ? rows - 1 : cy;
    const c = cy * cols + cx;
    cellOf[i] = c;
    cellStart[c + 1]++;
  }
  for (let c = 0; c < cells; c++) {
    cellStart[c + 1] += cellStart[c];
    cursor[c] = cellStart[c];
  }
  for (let i = 0; i < n; i++) order[cursor[cellOf[i]]++] = i;
}

/**
 * Finds every pair of points closer than `maxDist` (which must not exceed the grid's
 * cell size), visiting each cell's own points and a half stencil of 4 neighbours
 * (right, and the three below), so each pair of the 9-cell neighbourhood is tested
 * once. Writes the pair to `outA`/`outB` and its length divided by `maxDist` to
 * `outT`. Stops at `cap` links; returns the number written.
 */
export function findLinks(
  grid: LinkGrid,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  maxDist: number,
  outA: Int32Array | Uint16Array,
  outB: Int32Array | Uint16Array,
  outT: Float32Array,
  cap: number,
): number {
  const { cols, rows, cellStart, order } = grid;
  const max2 = maxDist * maxDist;
  const inv = 1 / maxDist;
  let count = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = cy * cols + cx;
      const start = cellStart[c];
      const end = cellStart[c + 1];
      if (start === end) continue;
      for (let s = start; s < end; s++) {
        const i = order[s];
        const x = xs[i];
        const y = ys[i];
        // k = 0: rest of own cell; 1: right; 2..4: below-left, below, below-right.
        for (let k = 0; k < 5; k++) {
          let from: number;
          let to: number;
          if (k === 0) {
            from = s + 1;
            to = end;
          } else {
            const nx = k === 1 ? cx + 1 : cx + k - 3;
            const ny = k === 1 ? cy : cy + 1;
            if (nx < 0 || nx >= cols || ny >= rows) continue;
            const nc = ny * cols + nx;
            from = cellStart[nc];
            to = cellStart[nc + 1];
          }
          for (let q = from; q < to; q++) {
            const j = order[q];
            const dx = xs[j] - x;
            const dy = ys[j] - y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= max2) continue;
            if (count >= cap) return count;
            outA[count] = i;
            outB[count] = j;
            outT[count] = Math.sqrt(d2) * inv;
            count++;
          }
        }
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Shaders.
// ---------------------------------------------------------------------------

/** One dot per instance on an octagon (apothem 1) fitted to the disc plus AA edge. */
const POINT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down) and opacity. */
layout(location = 1) in vec4 aPoint;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vRadius;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  // Dots under a pixel are drawn a pixel wide at proportionally lower opacity.
  float r = max(aPoint.z, 0.6);
  float ext = r + 0.5;
  vLocal = aCorner * ext;
  vRadius = r;
  vAlpha = aPoint.w * (aPoint.z * aPoint.z) / (r * r);
  vec2 px = aPoint.xy + vLocal;
  gl_Position = pxToClip(px, uResolution);
}
`;

const POINT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vRadius;
flat in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float a = clamp(vRadius + 0.5 - length(vLocal), 0.0, 1.0) * vAlpha;
  outColor = vec4(uColor * a, a);
}
`;

// ---------------------------------------------------------------------------
// Effect.
// ---------------------------------------------------------------------------

/**
 * "Plexus" network: dots drift slowly and hairlines join every pair closer than the
 * link distance, fading as `(1 - d/maxDist)²` so links appear and vanish smoothly.
 */
export const constellation = defineEffect({
  id: "constellation",
  name: "Constellation Network",
  description:
    "Slowly drifting points joined by fine lines that fade in and out with distance, the classic plexus tech background.",
  params: {
    count: { kind: "number", label: "Points", min: 50, max: MAX_POINTS, step: 1, default: 140 },
    linkDistance: {
      kind: "number",
      label: "Link distance (fraction of height)",
      min: 0.05,
      max: 0.3,
      step: 0.005,
      default: 0.17,
    },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 4, step: 0.05, default: 0.8 },
    depth: { kind: "number", label: "Depth", min: 0, max: 1, step: 0.01, default: 0.6 },
    pointSize: { kind: "number", label: "Point size", min: 0.5, max: 6, step: 0.1, default: 2.2 },
    lineWidth: { kind: "number", label: "Line width", min: 0.25, max: 3, step: 0.05, default: 1 },
    lineOpacity: {
      kind: "number",
      label: "Line opacity",
      min: 0.05,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    pointColor: { kind: "color", label: "Point colour", default: "#d6ecff" },
    lineColor: { kind: "color", label: "Line colour", default: "#5aa9ff" },
    backgroundTop: { kind: "color", label: "Background top colour", default: "#040814" },
    backgroundBottom: { kind: "color", label: "Background bottom colour", default: "#0b1a33" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));
      const pointProgram = scope.add(createProgram(gl, POINT_VERTEX, POINT_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const pointLoc = getUniforms(gl, pointProgram, ["uResolution", "uColor"]);
      const points = scope.own(
        createSpriteBatch(gl, MAX_POINTS, [4], [polygonStrip(8, Math.PI / 8)]),
      );
      const streaks = scope.own(createStreakRenderer(gl, LINK_CAP));

      const bgTop = unitRgbMemo();
      const bgBottom = unitRgbMemo();
      const pointRgb = unitRgbMemo();
      const lineRgb = unitRgbMemo();
      // Last uploaded uniform inputs (colours are memoised references).
      let pointSetColor: Rgb | null = null;
      let pointSetW = 0;
      let pointSetH = 0;

      // Positions in reference px (1080 per frame height), y down.
      const xs = new Float32Array(MAX_POINTS);
      const ys = new Float32Array(MAX_POINTS);
      /** 0 = far, 1 = near. */
      const z = new Float32Array(MAX_POINTS);
      const sizeVar = new Float32Array(MAX_POINTS);
      const heading = new Float32Array(MAX_POINTS);
      const turnRate = new Float32Array(MAX_POINTS);
      const turnPhase = new Float32Array(MAX_POINTS);
      const life = new Float32Array(MAX_POINTS);
      /** Per-frame depth factor in [1 - depth, 1]. */
      const near = new Float32Array(MAX_POINTS);

      const grid = createLinkGrid(MAX_POINTS);
      const linkA = new Uint16Array(LINK_CAP);
      const linkB = new Uint16Array(LINK_CAP);
      const linkT = new Float32Array(LINK_CAP);

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      let time = 0;
      let prevCount = 0;

      const rng = createRng(0x51a7);
      for (let i = 0; i < MAX_POINTS; i++) {
        xs[i] = rng() * refWidth;
        ys[i] = rng() * 1080;
        z[i] = rng();
        sizeVar[i] = 0.7 + rng() * 0.6;
        heading[i] = rng() * TAU;
        turnRate[i] = 0.05 + rng() * 0.15;
        turnPhase[i] = rng() * TAU;
      }

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const k = newRefWidth / refWidth;
          for (let i = 0; i < MAX_POINTS; i++) xs[i] *= k;
          ({ width, height, scale } = v);
          refWidth = newRefWidth;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time = (time + dt) % 10000;
          const n = Math.min(Math.floor(p.count), MAX_POINTS);
          for (let i = prevCount; i < n; i++) life[i] = 0;
          prevCount = n;

          // Off-screen margin of one link distance, so links fade out before a wrap.
          const dist = p.linkDistance * 1080;
          const minX = -dist;
          const minY = -dist;
          const spanX = refWidth + 2 * dist;
          const spanY = 1080 + 2 * dist;
          const drift = p.speed * DRIFT_PX * dt;
          const fadeStep = dt / FADE_IN;
          const depth = p.depth;

          for (let i = 0; i < n; i++) {
            const k = 1 - depth * (1 - z[i]);
            near[i] = k;
            heading[i] += Math.sin(time * turnRate[i] + turnPhase[i]) * dt * 0.25;
            const step = drift * (0.35 + 0.65 * k);
            xs[i] = wrap(xs[i] + Math.cos(heading[i]) * step, minX, spanX);
            ys[i] = wrap(ys[i] + Math.sin(heading[i]) * step, minY, spanY);
            life[i] = Math.min(1, life[i] + fadeStep);
          }

          // Links.
          buildGrid(grid, xs, ys, n, minX, minY, spanX, spanY, dist);
          const links = findLinks(grid, xs, ys, dist, linkA, linkB, linkT, LINK_CAP);
          const lc = lineRgb(p.lineColor);
          const halfWidth = p.lineWidth * 0.5 * scale;
          const sd = streaks.data;
          let drawn = 0;
          for (let l = 0; l < links; l++) {
            const a = linkA[l];
            const b = linkB[l];
            const la = life[a];
            const lb = life[b];
            const alpha =
              p.lineOpacity *
              linkFalloff(linkT[l]) *
              (0.3 + 0.35 * (near[a] + near[b])) *
              (la < lb ? la : lb);
            if (alpha < MIN_LINK_ALPHA) continue;
            const o = drawn * STREAK_FLOATS;
            sd[o] = xs[a] * scale;
            sd[o + 1] = ys[a] * scale;
            sd[o + 2] = xs[b] * scale;
            sd[o + 3] = ys[b] * scale;
            sd[o + 4] = lc[0] * alpha;
            sd[o + 5] = lc[1] * alpha;
            sd[o + 6] = lc[2] * alpha;
            sd[o + 7] = halfWidth;
            drawn++;
          }

          // Points (only those on screen).
          const pd = points.data;
          const ps = points.stride;
          const baseRadius = p.pointSize * scale;
          let dots = 0;
          for (let i = 0; i < n; i++) {
            const k = near[i];
            const r = baseRadius * sizeVar[i] * (0.45 + 0.55 * k);
            const x = xs[i] * scale;
            const y = ys[i] * scale;
            if (x < -r - 1 || y < -r - 1 || x > width + r + 1 || y > height + r + 1) continue;
            const o = dots * ps;
            pd[o] = x;
            pd[o + 1] = y;
            pd[o + 2] = r;
            pd[o + 3] = (0.3 + 0.7 * k) * life[i];
            dots++;
          }

          // 1. Background.
          background.draw(bgTop(p.backgroundTop), bgBottom(p.backgroundBottom));

          // 2. Lines, additive (streaks set their own blend state).
          if (drawn > 0) {
            streaks.upload(drawn);
            streaks.draw(drawn, width, height);
          }

          // 3. Points, premultiplied over.
          if (dots > 0) {
            points.upload(dots);
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(pointProgram);
            const pc = pointRgb(p.pointColor);
            if (pc !== pointSetColor) {
              gl.uniform3fv(pointLoc.uColor, pc);
              pointSetColor = pc;
            }
            if (pointSetW !== width || pointSetH !== height) {
              gl.uniform2f(pointLoc.uResolution, width, height);
              pointSetW = width;
              pointSetH = height;
            }
            points.draw(0, dots);
          }
          gl.disable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
