import type { Rgb } from "./color";
import {
  beginFrame,
  createGradientBackground,
  createProgram,
  createUniforms,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { approach } from "./math";
import {
  buildPolytope,
  type Polytope,
  projectPolytope,
  PROJECTED_FLOATS,
  rainbow,
  rotationMatrix,
  toShape,
} from "./polytope-sim";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { type PolytopeShape, tesseractMeta } from "./tesseract.meta";
import { defineEffect } from "./types";

/** Most vertices and edges of any shape: the 120-cell. */
const MAX_VERTICES = 600;
const MAX_EDGES = 1200;
/** Streaks per edge: two halo layers and the core. */
const LAYERS = 3;

const TAU = Math.PI * 2;
/** Rotation rates in rad/s at speed 1, in incommensurate ratios (1 : 1/φ : √2 − 1). */
const RATE_XW = 0.16;
const RATE_YZ = RATE_XW / ((1 + Math.sqrt(5)) / 2);
const RATE_XZ = RATE_XW * (Math.SQRT2 - 1);

/** Projected circumradius as a fraction of the frame height. */
const RADIUS_H = 0.2;
/** …and at most this fraction of the width, for portrait frames. */
const RADIUS_W = 0.3;
/** Horizontal centre of the figure, as a fraction of the width. */
const POSITIONS: Record<string, number> = { left: 0.25, right: 0.75, centre: 0.5 };

/**
 * Per-shape line and dot scale (thinner, fainter for dense shapes so the 120-cell
 * doesn't turn into a blob) and halo strength.
 */
const SHAPE_STYLE: Record<PolytopeShape, readonly [width: number, halo: number]> = {
  tesseract: [1, 1],
  cell16: [1, 0.9],
  cell24: [0.85, 0.7],
  cell120: [0.45, 0.3],
};

/** Seconds to fade the figure out (and the next one in) when the shape changes. */
const SWAP_TIME = 0.6;

const COLOURS: Record<string, Rgb> = {
  cyan: [0.3, 0.88, 1],
  magenta: [1, 0.32, 0.85],
  white: [0.9, 0.94, 1],
};

const BACKGROUND_TOP: Rgb = [0.012, 0.016, 0.035];
const BACKGROUND_BOTTOM: Rgb = [0.035, 0.05, 0.1];

/** Soft round dot per vertex, additive; the falloff reaches zero at the octagon's apothem. */
const DOT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y (device px, y down) and radius. */
layout(location = 1) in vec3 aDot;
/** Colour times intensity. */
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(aDot.xy + aCorner * aDot.z, uResolution);
}
`;

const DOT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float f = max(1.0 - length(vLocal), 0.0);
  outColor = vec4(vColor * (f * f), 1.0);
}
`;

/**
 * A regular 4D polytope in glowing wireframe, turning in the XW and YZ planes (and
 * slowly in XZ) and projected with perspective on W, then Z.
 */
export const tesseract = defineEffect(tesseractMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));
      const streaks = scope.own(createStreakRenderer(gl, MAX_EDGES * LAYERS));
      const dotProgram = scope.add(createProgram(gl, DOT_VERTEX, DOT_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const dotU = createUniforms(gl, dotProgram, ["uResolution"]);
      const dots = scope.own(
        createSpriteBatch(gl, MAX_VERTICES, [3, 3], [polygonStrip(8, Math.PI / 8)]),
      );

      const polytopes = new Map<PolytopeShape, Polytope>();
      const polytope = (shape: PolytopeShape) => {
        let poly = polytopes.get(shape);
        if (!poly) {
          poly = buildPolytope(shape);
          polytopes.set(shape, poly);
        }
        return poly;
      };

      const matrix = new Float64Array(16);
      const projected = new Float32Array(MAX_VERTICES * PROJECTED_FLOATS);
      /** Per-vertex colour (before intensity), for the rainbow. */
      const vertexRgb = new Float32Array(MAX_VERTICES * 3);
      const scratch: Rgb = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      // Plane angles, advanced by speed × dt and wrapped to a turn (exact, no jump).
      let xw = 0.35;
      let yz = 0.6;
      let xz = 0.45;
      let shown: PolytopeShape | null = null;
      let fade = 1;
      let cx = -1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);

          // Shape swap: fade out, switch, fade back in.
          const wanted = toShape(p.shape);
          if (shown === null) shown = wanted;
          if (wanted !== shown) {
            fade = Math.max(0, fade - dt / SWAP_TIME);
            if (fade === 0) shown = wanted;
          } else {
            fade = Math.min(1, fade + dt / SWAP_TIME);
          }
          const poly = polytope(shown);
          const [widthK, haloK] = SHAPE_STYLE[shown];

          const turn = dt * p.speed;
          xw = (xw + turn * RATE_XW) % TAU;
          yz = (yz + turn * RATE_YZ) % TAU;
          xz = (xz + turn * RATE_XZ) % TAU;
          rotationMatrix(matrix, xw, yz, xz);
          projectPolytope(poly, matrix, projected);

          // Placement, eased so a position change glides.
          const radius = Math.min(RADIUS_H * height, RADIUS_W * width);
          const target = Math.min(
            Math.max((POSITIONS[p.position] ?? POSITIONS.right) * width, 1.4 * radius),
            width - 1.4 * radius,
          );
          cx = cx < 0 ? target : approach(cx, target, dt * 0.15 * width);
          const cy = 0.5 * height;

          // Vertex colours.
          const rainbowMode = p.colour === "rainbow";
          const fixed = COLOURS[p.colour] ?? COLOURS.cyan;
          for (let i = 0; i < poly.vertexCount; i++) {
            const c = rainbowMode ? rainbow(projected[i * PROJECTED_FLOATS + 2], scratch) : fixed;
            vertexRgb[i * 3] = c[0];
            vertexRgb[i * 3 + 1] = c[1];
            vertexRgb[i * 3 + 2] = c[2];
          }

          // Edges: two faint halo layers and a thin core, sized and lit by nearness.
          const sd = streaks.data;
          const lineK = widthK * scale;
          const halo1 = 0.1 * p.glow * haloK * fade;
          const halo2 = 0.045 * p.glow * haloK * fade;
          let n = 0;
          for (let e = 0; e < poly.edgeCount; e++) {
            const a = poly.edges[e * 2];
            const b = poly.edges[e * 2 + 1];
            const oa = a * PROJECTED_FLOATS;
            const ob = b * PROJECTED_FLOATS;
            const near = 0.5 * (projected[oa + 2] + projected[ob + 2]);
            const light = (0.25 + 0.75 * near) * fade;
            const ax = cx + projected[oa] * radius;
            const ay = cy - projected[oa + 1] * radius;
            const bx = cx + projected[ob] * radius;
            const by = cy - projected[ob + 1] * radius;
            const r = 0.5 * (vertexRgb[a * 3] + vertexRgb[b * 3]);
            const g = 0.5 * (vertexRgb[a * 3 + 1] + vertexRgb[b * 3 + 1]);
            const bl = 0.5 * (vertexRgb[a * 3 + 2] + vertexRgb[b * 3 + 2]);
            const core = (0.5 + 0.9 * near) * lineK;
            for (let layer = 0; layer < LAYERS; layer++) {
              let half = core;
              let k = light;
              if (layer === 0) {
                if (halo2 <= 0) continue;
                half = core + (8 + 10 * near) * lineK;
                k *= halo2;
              } else if (layer === 1) {
                if (halo1 <= 0) continue;
                half = core + (3 + 4 * near) * lineK;
                k *= halo1;
              }
              const o = n * STREAK_FLOATS;
              sd[o] = ax;
              sd[o + 1] = ay;
              sd[o + 2] = bx;
              sd[o + 3] = by;
              sd[o + 4] = r * k;
              sd[o + 5] = g * k;
              sd[o + 6] = bl * k;
              sd[o + 7] = half;
              n++;
            }
          }

          // Vertices: soft glowing points.
          const dd = dots.data;
          const ds = dots.stride;
          const dotK = (0.4 + 0.6 * widthK) * scale;
          const dotLight = (0.45 + 0.35 * p.glow) * fade;
          for (let i = 0; i < poly.vertexCount; i++) {
            const o = i * PROJECTED_FLOATS;
            const near = projected[o + 2];
            const k = (0.3 + 0.7 * near) * dotLight;
            const q = i * ds;
            dd[q] = cx + projected[o] * radius;
            dd[q + 1] = cy - projected[o + 1] * radius;
            dd[q + 2] = (4 + 5 * near) * dotK;
            dd[q + 3] = vertexRgb[i * 3] * k;
            dd[q + 4] = vertexRgb[i * 3 + 1] * k;
            dd[q + 5] = vertexRgb[i * 3 + 2] * k;
          }

          background.draw(BACKGROUND_TOP, BACKGROUND_BOTTOM);
          if (fade <= 0) return;

          streaks.upload(n);
          streaks.draw(n, width, height);

          dots.upload(poly.vertexCount);
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(dotProgram);
          dotU.f2("uResolution", width, height);
          dots.draw(0, poly.vertexCount);
          gl.disable(gl.BLEND);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
