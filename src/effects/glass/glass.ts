import { hexToUnitRgb } from "../color";
import {
  ambientAt,
  driftUniform,
  GRID_ORIGIN,
  JITTER,
  leadStyle,
  palette,
  PALETTE_SIZE,
  PALETTES,
  sunAt,
} from "./glass-sim";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "../noise";
import { glassMeta } from "./glass.meta";
import { VORONOI_GLSL } from "../voronoi";
import { defineEffect } from "../types";

/** Glass texture: texels per side, its tile in reference px, and lattice cells per side of each channel. */
const TEX_SIZE = 128;
const TEX_TILE = 256;
/** R: broad ripples (~64 px features); G: fine noise thresholded into seed bubbles. */
const RIPPLE_PERIOD = 4;
const SEEDY_PERIOD = 32;
/** Brightness modulation at `texture` = 1 for rippled panes, and bubble brightness for seedy ones. */
const RIPPLE_AMP = 0.24;
const SEEDY_AMP = 0.3;
/** Pane brightness lift at its centre, and the per-pane brightness spread of old glass. */
const CENTRE_GLOW = 0.14;
const PANE_SPREAD = 0.16;
/** Sun patch radii in frame heights, and its peak added light at `light` = 1. */
const SUN_RX = 0.6;
const SUN_RY = 0.42;
const SUN_GAIN = 0.62;
/** The lead highlight's light direction (y down: from the upper left), and bloom strength. */
const LIGHT_DIR = [-0.6, -0.8] as const;
const BLOOM = 0.3;

/** Every palette as PALETTE_SIZE rgb triples (0..1), built once. */
const PALETTE_DATA = new Map<readonly string[], Float32Array>(
  Object.values(PALETTES).map((colors) => {
    const data = new Float32Array(PALETTE_SIZE * 3);
    colors.forEach((hex, i) => {
      data.set(hexToUnitRgb(hex), i * 3);
    });
    return [colors, data];
  }),
);
const paletteData = (name: string) => {
  const data = PALETTE_DATA.get(palette(name));
  if (!data) {
    throw new Error(`glass: no palette data for "${name}"`);
  }
  return data;
};

/**
 * One full-screen pass: a 3x3 jittered-Voronoi search (`VORONOI_GLSL`, whose JS
 * twin the glass-sim tests prove exact), the exact distance to the pane's
 * edge for constant-width anti-aliased lead, one glass-texture fetch, and the
 * analytic sun patch.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
uniform sampler2D uGlass;
/** Reference position (1080 tall, y down) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Grid position = reference position * x + yz. */
uniform vec3 uGrid;
/** Shared drift path point, pre-scaled (see driftUniform). */
uniform vec2 uDrift;
/** Device px per cell. */
uniform float uCellPx;
/** Lead half width in device px, opacity, and highlight strength. */
uniform vec3 uLead;
uniform vec3 uLeadColor;
/** Sun centre (reference px), and 1 / radii (reference px). */
uniform vec4 uSun;
/** Ambient level and sun gain. */
uniform vec2 uLight;
/** Cells to texture tiles, and texture strength. */
uniform vec2 uTex;
uniform vec3 uPalette[${String(PALETTE_SIZE)}];
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
/**
 * Glass seeds: the jitter maps two hash bytes from the square onto a disc, and the
 * drift rotates the shared path point by the seed's own hash vector.
 */
vec2 voronoiOffset(uint h) {
  vec4 b = vec4(uvec4(h, h >> 8, h >> 16, h >> 24) & 255u) * ${glslFloat(2 / 255)} - 1.0;
  float sg = (h & 1u) == 1u ? 1.0 : -1.0;
  vec2 cs = vec2(uDrift.x, uDrift.y * sg);
  vec2 jit = ${glslFloat(JITTER)} * b.xy * sqrt(1.0 - 0.5 * b.yx * b.yx);
  return jit + vec2(b.z * cs.x - b.w * cs.y, b.w * cs.x + b.z * cs.y);
}
${VORONOI_GLSL}
void main() {
  vec2 ref = gl_FragCoord.xy * uPix.xy + uPix.zw;
  vec2 g = ref * uGrid.x + uGrid.yz;

  // Pane under this pixel, and the exact distance to its edge.
  VoronoiCell v = voronoiCell(g);
  vec2 a = v.seed;
  float f1 = v.f1;
  float edge = v.edge;
  vec2 nrm = v.normal;
  uint bestH = v.hash;

  // Pane: palette colour, old-glass brightness spread, centre glow, texture.
  uint ph = hash32(bestH ^ 0x5bd1e995u);
  vec3 pane = uPalette[int(ph & ${String(PALETTE_SIZE - 1)}u)];
  float spread = 1.0 + ${glslFloat(PANE_SPREAD)} * (float((ph >> 26) & 63u) * ${glslFloat(1 / 63)} - 0.5);
  float glow = 1.0 + ${glslFloat(CENTRE_GLOW)} * max(1.0 - f1 * 2.5, 0.0);
  vec2 offs = vec2(uvec2(ph >> 8, ph >> 16) & 255u) * ${glslFloat(1 / 256)};
  vec2 tex = texture(uGlass, (g - a) * uTex.x + offs).rg;
  float seedy = ((ph >> 24) & 3u) == 0u ? 1.0 : 0.0;
  float ripple = (tex.r - 0.5) * 2.0 * ${glslFloat(RIPPLE_AMP)};
  float bubble = smoothstep(0.66, 0.74, tex.g) * ${glslFloat(SEEDY_AMP)};
  float texMod = 1.0 + uTex.y * mix(ripple, bubble + 0.4 * ripple, seedy);

  // Light: ambient plus the soft sun ellipse.
  vec2 q = (ref - uSun.xy) * uSun.zw;
  float light = uLight.x + uLight.y * exp(-2.0 * dot(q, q));
  vec3 lit = pane * (light * spread * glow);
  vec3 glass = lit * texMod;

  // Lead: box-filtered coverage of a constant-width line, with a highlight on
  // the side facing the light and a little bloom from bright panes near its edge.
  float dpx = edge * uCellPx;
  float cov = clamp(uLead.x + 0.5 - dpx, 0.0, 1.0) * uLead.y;
  float x = clamp(dpx / uLead.x, 0.0, 1.0);
  float facing = max(dot(-nrm, vec2(${glslFloat(LIGHT_DIR[0])}, ${glslFloat(LIGHT_DIR[1])})), 0.0);
  float hl = uLead.z * facing * (1.0 - smoothstep(0.0, 0.3, abs(x - 0.55)));
  vec3 lead = uLeadColor * (1.0 - 0.15 * x) + hl + lit * (${glslFloat(BLOOM)} * x * x);

  vec3 c = mix(glass, lead, cov);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * A stained-glass window lit from behind: jewel-toned Voronoi panes in dark lead,
 * a soft patch of sun crossing slowly, and panes that breathe as their seeds
 * drift on small closed paths. One full-resolution pass with one texture fetch.
 */
export const glass = defineEffect(glassMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, [
        "uGlass",
        "uPix",
        "uGrid",
        "uDrift",
        "uCellPx",
        "uLead",
        "uLeadColor",
        "uSun",
        "uLight",
        "uTex",
        "uPalette",
      ]);
      gl.useProgram(program);
      u.i1("uGlass", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const glassTex = scope.add(
        createDataTexture(gl, {
          width: TEX_SIZE,
          height: TEX_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(TEX_SIZE, [
            { period: RIPPLE_PERIOD, seed: 40 },
            { period: SEEDY_PERIOD, seed: 41 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const drift = [0, 0];
      const sun = [0, 0];
      let width = 1;
      let height = 1;
      let scale = 1;
      // CPU-only time, kept unwrapped in float64; only cos/sin of it are uploaded.
      let time = 0;
      let lastPalette: Float32Array | undefined;
      let lastLead = Number.NaN;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
          lastLead = Number.NaN;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          gl.useProgram(program);

          const inv = 1 / scale;
          const refW = width * inv;
          const refH = height * inv;
          u.f4("uPix", inv, -inv, 0, refH);
          // Cells anchored on the frame centre, so changing the pane size scales from there.
          const cellSize = Math.max(1, p.cellSize);
          const k = 1 / cellSize;
          u.f3("uGrid", k, GRID_ORIGIN - 0.5 * refW * k, GRID_ORIGIN - 0.5 * refH * k);
          u.f1("uCellPx", cellSize * scale);
          u.f2("uTex", cellSize / TEX_TILE, Math.min(Math.max(p.texture, 0), 1));
          driftUniform(time, p.drift, drift);
          u.f2("uDrift", drift[0], drift[1]);

          if (p.leadWidth !== lastLead) {
            lastLead = p.leadWidth;
            const [hw, alpha, hl] = leadStyle(p.leadWidth, scale);
            u.f3("uLead", hw, alpha, hl);
          }
          u.rgb("uLeadColor", p.leadColor);

          sunAt(time, sun);
          u.f4("uSun", sun[0] * refW, sun[1] * refH, 1 / (SUN_RX * 1080), 1 / (SUN_RY * 1080));
          u.f2("uLight", ambientAt(time), SUN_GAIN * Math.min(Math.max(p.light, 0), 1));

          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uPalette, pal);
          }

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, glassTex);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
