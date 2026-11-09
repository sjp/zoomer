import { hexToUnitRgb, type Rgb } from "../color";
import {
  advanceCells,
  CENTRE_EDGES,
  type CellsOptions,
  type CellsSim,
  createCellsSim,
  MAX_CELLS,
  packCells,
  palette,
  PALETTES,
  resizeCellsSim,
} from "./cells-sim";
import { cellsMeta } from "./cells.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { defineEffect } from "../types";

/** Reference frame height: the simulation works in px at 1080p. */
const REF_H = 1080;
/** Membrane falloff (1/e distance from the edge), reference px. */
const MEMBRANE_PX = 4.5;
/** Membrane opacity over the body, and the halo it casts into the medium. */
const MEMBRANE = 0.85;
const HALO = 0.35;
/** Nucleus radius as a fraction of the cell radius, and its opacity. */
const NUCLEUS_R = 0.3;
const NUCLEUS = 0.55;
/** Body brightness at the cell centre and its drop towards the rim (the inner gradient). */
const BODY_CENTRE = 1.05;
const BODY_FALL = 0.14;
/** How far the calm centre pulls colours towards the palette's mean (lower contrast). */
const CALM_FLATTEN = 0.3;

/** Palette slots uploaded to `uPal`: medium, body (tone 0, 1), membrane, nucleus, mean. */
const PAL_SLOTS = 6;

/** Every palette as PAL_SLOTS rgb triples (0..1), built once. */
const PALETTE_DATA = new Map<readonly string[], Float32Array>(
  Object.values(PALETTES).map((colors) => {
    const [medium, bodyA, bodyB, membrane, nucleus] = colors.map((v) => hexToUnitRgb(v));
    // The scene's average colour: mostly body, some membrane and medium.
    const average = (c: number) =>
      0.3 * (bodyA[c] + bodyB[c]) + 0.2 * membrane[c] + 0.2 * medium[c];
    const mean: Rgb = [average(0), average(1), average(2)];
    const data = new Float32Array(PAL_SLOTS * 3);
    [medium, bodyA, bodyB, membrane, nucleus, mean].forEach((rgb, i) => {
      data.set(rgb, i * 3);
    });
    return [colors, data];
  }),
);
const paletteData = (name: string) => {
  const data = PALETTE_DATA.get(palette(name));
  if (!data) {
    throw new Error(`cells: no palette data for "${name}"`);
  }
  return data;
};

/**
 * One low-res pass: per pixel, the nearest cell of the power diagram (brute force
 * over every cell), then the exact distance to its boundary (the nearest radical
 * line, as in Stained Glass's distance-to-edge shading) and to its own disc. The
 * membrane peaks at that edge; the body has a soft inner gradient and a nucleus.
 * Daughters still pinching apart share one smoothly merged outline, and the wall
 * between them fades in as they separate.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Per cell: centre (reference px, y down), r², r. */
uniform vec4 uCell[${String(MAX_CELLS)}];
/** Per cell: tone, sister serial, merge (0 unless pinching apart), nucleus strength. */
uniform vec4 uInfo[${String(MAX_CELLS)}];
uniform int uCount;
/** Reference position = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Medium, body (tone 0), body (tone 1), membrane, nucleus, mean. */
uniform vec3 uPal[${String(PAL_SLOTS)}];
/** 1 / membrane falloff, anti-alias half width (both reference px), nuclei on, calm centre on. */
uniform vec4 uStyle;
/** 1 / reference width, and dither on (when rendering straight to the canvas). */
uniform vec2 uFrame;
out vec4 outColor;
${DITHER_GLSL}

float smax(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / max(k, 1e-4);
  return max(a, b) + h * h * k * 0.25;
}

float nucleus(vec2 p, vec4 c, float strength) {
  return strength * (1.0 - smoothstep(0.7, 1.0, length(p - c.xy) / (c.w * ${glslFloat(NUCLEUS_R)} + 1e-3)));
}

void main() {
  vec2 p = gl_FragCoord.xy * uPix.xy + uPix.zw;

  // Nearest cell by power distance |p - c|² - r².
  float d1 = 1e20;
  int i1 = 0;
  for (int i = 0; i < ${String(MAX_CELLS)}; i++) {
    if (i >= uCount) break;
    vec4 c = uCell[i];
    vec2 d = p - c.xy;
    float pd = dot(d, d) - c.z;
    if (pd < d1) {
      d1 = pd;
      i1 = i;
    }
  }

  // Exact distance to the cell's boundary: the nearest radical line. A pinching
  // sister's line is kept apart, to fade in as they separate.
  vec4 a = uCell[i1];
  vec4 ai = uInfo[i1];
  float edge = 1e20;
  float sisEdge = 1e20;
  int sis = -1;
  for (int k = 0; k < ${String(MAX_CELLS)}; k++) {
    if (k >= uCount) break;
    if (k == i1) continue;
    vec4 c = uCell[k];
    vec2 d = p - c.xy;
    vec2 ab = c.xy - a.xy;
    float e = (dot(d, d) - c.z - d1) * 0.5 * inversesqrt(max(dot(ab, ab), 1e-4));
    if (ai.z > 0.0 && uInfo[k].z > 0.0 && uInfo[k].y == ai.y) {
      sisEdge = e;
      sis = k;
    } else {
      edge = min(edge, e);
    }
  }

  // Signed distance into the cell's disc (positive inside); merged with a sister's.
  float rad = a.w - length(p - a.xy);
  float nuc = nucleus(p, a, ai.w);
  float wall = 0.0;
  if (sis >= 0) {
    vec4 b = uCell[sis];
    float m = ai.z;
    rad = smax(rad, b.w - length(p - b.xy), m * a.w * 0.6);
    nuc = max(nuc, nucleus(p, b, uInfo[sis].w));
    float s = max(sisEdge, 0.0) * uStyle.x;
    wall = exp(-s * s) * (1.0 - m);
  }

  float t = max(min(edge, rad), 0.0) * uStyle.x;
  float membrane = max(exp(-t * t), wall);
  float q = clamp(1.0 - rad / max(a.w, 1e-3), 0.0, 1.0);
  vec3 body = mix(uPal[1], uPal[2], ai.x) * (${glslFloat(BODY_CENTRE)} - ${glslFloat(BODY_FALL)} * q * q);
  vec3 cell = mix(body, uPal[4], nuc * ${glslFloat(NUCLEUS)} * uStyle.z);
  cell = mix(cell, uPal[3], membrane * ${glslFloat(MEMBRANE)});

  // Medium between cells, lit by a soft halo from nearby membranes.
  float o = max(-rad, 0.0) * uStyle.x * 0.6;
  vec3 medium = mix(uPal[0], uPal[3], exp(-o * o) * ${glslFloat(HALO)});
  vec3 col = mix(medium, cell, smoothstep(-uStyle.y, uStyle.y, rad));

  // Calm centre: lower contrast in the middle third.
  float u = abs(p.x * uFrame.x - 0.5);
  float calm = (1.0 - smoothstep(${glslFloat(CENTRE_EDGES[0])}, ${glslFloat(CENTRE_EDGES[1])}, u)) * uStyle.w;
  col = mix(col, uPal[5], ${glslFloat(CALM_FLATTEN)} * calm);

  outColor = vec4(col + uFrame.y * dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A soft microscope view of living cells: a power diagram of simulated discs that
 * pack, jostle, grow and divide (`cells-sim.ts`), shaded in one reduced-resolution
 * pass with a brute-force loop over the cells, then upscaled with dither. The
 * pass re-renders only when the simulation steps (60 Hz).
 */
export const cells = defineEffect(cellsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, [
        "uCell",
        "uInfo",
        "uCount",
        "uPix",
        "uPal",
        "uStyle",
        "uFrame",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));

      const cellData = new Float32Array(MAX_CELLS * 4);
      const infoData = new Float32Array(MAX_CELLS * 4);
      const opts: CellsOptions = { count: 0, division: 0, motion: 0, calm: true };
      let sim: CellsSim | null = null;
      let seed = Number.NaN;
      let width = 1;
      let height = 1;
      let scale = 1;
      let lastPalette: Float32Array | undefined;
      /** Set when the low-res image must be redrawn even if the simulation didn't step. */
      let dirty = true;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / REF_H;
          dirty = true;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const refW = width / scale;
          opts.count = p.cells;
          opts.division = p.division;
          opts.motion = p.motion;
          opts.calm = p.calmCentre;
          if (!sim || p.seed !== seed) {
            seed = p.seed;
            sim = createCellsSim(p.seed, opts, refW, REF_H);
            dirty = true;
          }
          resizeCellsSim(sim, refW, REF_H);
          if (advanceCells(sim, dt, opts) > 0) {
            dirty = true;
          }

          target.resize(width, height, qualityDivisor(p.quality));
          gl.useProgram(program);
          const lw = target.width;
          const lh = target.height;
          const px = refW / lw;
          const py = REF_H / lh;
          if (u.f4("uPix", px, -py, 0, REF_H)) {
            dirty = true;
          }
          if (u.f4("uStyle", 1 / MEMBRANE_PX, px, p.nuclei ? 1 : 0, p.calmCentre ? 1 : 0)) {
            dirty = true;
          }
          if (u.f2("uFrame", 1 / refW, target.direct ? 1 : 0)) {
            dirty = true;
          }
          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uPal, pal);
            dirty = true;
          }

          // The canvas isn't preserved, so a direct target redraws every frame.
          if (dirty || target.direct) {
            const n = packCells(sim, cellData, infoData);
            u.i1("uCount", n);
            gl.uniform4fv(u.loc.uCell, cellData, 0, n * 4);
            gl.uniform4fv(u.loc.uInfo, infoData, 0, n * 4);
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            dirty = false;
          }
          target.blit();
          // Unbind the low-res texture so it is never sampled while it is a render target.
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
