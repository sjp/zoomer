import { hexToUnitRgb, type Rgb } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "../gl";
import {
  createTruchet,
  FADING,
  gridLayout,
  MAX_FLIPS,
  palette,
  STARTED,
  COMPLETED,
  styleIndex,
  TONES,
  type GridLayout,
  type TruchetPalette,
  type TruchetSim,
} from "./truchet-sim";
import { BAND_WIDTH_MAX, truchetMeta } from "./truchet.meta";
import { defineEffect } from "../types";

/** Outline half width in px at 1080p, and its floor in device px. */
const OUTLINE_HALF = 1.25;
const OUTLINE_MIN = 0.6;
/** How much of the band colour tints the inside of an outlined band. */
const OUTLINE_FILL = 0.2;
/** Shaded style: light direction (x right, y up, z towards the viewer), ambient and diffuse. */
const LIGHT = normalize([-0.42, 0.5, 0.76]);
const SHADE_AMBIENT = 0.6;
const SHADE_DIFFUSE = 0.5;
/** Shaded style: contact shadow strength, and its reach past the band edge in tiles. */
const SHADOW = 0.28;
const SHADOW_REACH = 0.12;
/** Gap behind a turning tile, as a fraction of the mean background. */
const GAP_SHADE = 0.8;
/**
 * Calm centre: how far towards the flat mean background the middle third is
 * pulled, and the ramp (in multiples of the third's half width) over which it eases out.
 */
const CALM_STRENGTH = 0.5;
const CALM_RAMP = [0.7, 1.5] as const;

function normalize(v: number[]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * One full-resolution pass. Per pixel: find the tile, fetch its texel, turn the
 * local coordinate by the tile's eased flip angle, mirror for orientation 1, then
 * the exact distance to the two quarter-circle arcs gives a one-pixel
 * anti-aliased band. The regions between arcs take one of two background tones
 * by the parity of the lattice vertex they hold.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uTiles;
/** Grid origin (device px, bottom-left), 1 / tile px, tile px. */
uniform vec4 uGrid;
uniform vec2 uCells;
/** Eased flip progress per slot; slot 0 is "not flipping" and stays 0. */
uniform float uFlip[${String(MAX_FLIPS + 1)}];
uniform vec3 uBand[${String(TONES)}];
uniform vec3 uBgA;
uniform vec3 uBgB;
uniform vec3 uGap;
/** Mean background, the calm centre's target. */
uniform vec3 uFlat;
uniform int uStyle;
/** Band half width (tiles) and outline half width (device px). */
uniform vec2 uWidth;
uniform float uPathColors;
/** Calm centre: centre x (device px), 1 / half width of the middle third (device px), strength. */
uniform vec3 uCalm;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 g = (gl_FragCoord.xy - uGrid.xy) * uGrid.z;
  ivec2 cell = clamp(ivec2(floor(g)), ivec2(0), ivec2(uCells) - 1);
  uvec4 tile = texelFetch(uTiles, cell, 0);
  float tilePx = uGrid.w;

  // Turn: the tile's content is rotated by ang, so sample it at R(-ang) q.
  float e = uFlip[int(min(tile.r >> 2, ${String(MAX_FLIPS)}u))];
  float ang = e * ${glslFloat(Math.PI / 2)} * ((tile.r & 2u) != 0u ? -1.0 : 1.0);
  float c = cos(ang);
  float s = sin(ang);
  vec2 q0 = g - vec2(cell) - 0.5;
  vec2 q = vec2(c * q0.x + s * q0.y, c * q0.y - s * q0.x);
  // Outside the turned square (only while turning) is the gap behind the tile.
  float inside = clamp(1.0 - (max(abs(q.x), abs(q.y)) - 0.5) * tilePx, 0.0, 1.0);

  // Orientation 1 is the mirror image of 0: arcs around (-1/2, -1/2) and (1/2, 1/2).
  uint o = tile.r & 1u;
  float m = o == 1u ? -1.0 : 1.0;
  vec2 qm = vec2(q.x * m, q.y);
  vec2 dA = qm + 0.5;
  vec2 dB = qm - 0.5;
  float rA = length(dA);
  float rB = length(dB);
  float sA = rA - 0.5;
  float sB = rB - 0.5;
  bool nearA = abs(sA) < abs(sB);
  float sd = nearA ? sA : sB;

  // Regions: a corner region holds its lattice vertex, the middle one the other two.
  // Turning swaps which vertices the regions hold, so their tones cross-fade.
  uint corner = (uint(cell.x + cell.y) & 1u) ^ o;
  uint par = (rA < 0.5 || rB < 0.5) ? corner : corner ^ 1u;
  float pf = mix(float(par), 1.0 - float(par), e);
  vec3 bg = mix(uBgA, uBgB, pf);

  vec3 band = uBand[0];
  if (uPathColors > 0.5) {
    uint bits = nearA ? tile.g : tile.g >> 4;
    vec3 from = uBand[int(min(bits & 3u, ${String(TONES - 1)}u))];
    vec3 to = uBand[int(min((bits >> 2) & 3u, ${String(TONES - 1)}u))];
    band = mix(from, to, float(tile.b) * ${glslFloat(1 / 255)});
  }

  float hw = uWidth.x;
  float hwPx = hw * tilePx;
  float dpx = abs(sd) * tilePx;
  float cov = clamp(hwPx + 0.5 - dpx, 0.0, 1.0);
  vec3 col;
  if (uStyle == 1) {
    float line = clamp(uWidth.y + 0.5 - abs(dpx - hwPx), 0.0, 1.0);
    col = mix(bg, mix(bg, band, ${glslFloat(OUTLINE_FILL)}), cov);
    col = mix(col, band, line);
  } else if (uStyle == 2) {
    // A raised, rounded band: the normal tilts across it along the arc's radius.
    vec2 radial = (nearA ? dA / max(rA, 1e-4) : dB / max(rB, 1e-4)) * vec2(m, 1.0);
    radial = vec2(c * radial.x - s * radial.y, s * radial.x + c * radial.y);
    float u = clamp(sd / hw, -1.0, 1.0);
    vec3 n = vec3(radial * u, sqrt(max(1.0 - u * u, 0.0)));
    float lit = ${glslFloat(SHADE_AMBIENT)} + ${glslFloat(SHADE_DIFFUSE)}
      * max(dot(n, vec3(${LIGHT.map((v) => glslFloat(v)).join(", ")})), 0.0);
    float shadow = 1.0 - ${glslFloat(SHADOW)}
      * (1.0 - smoothstep(hwPx, hwPx + ${glslFloat(SHADOW_REACH)} * tilePx, dpx));
    col = mix(bg * shadow, band * lit, cov);
  } else {
    col = mix(bg, band, cov);
  }
  col = mix(uGap, col, inside);

  float w = 1.0 - smoothstep(${glslFloat(CALM_RAMP[0])}, ${glslFloat(CALM_RAMP[1])},
    abs(gl_FragCoord.x - uCalm.x) * uCalm.y);
  col = mix(col, uFlat, uCalm.z * w);
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

interface PaletteData {
  bands: Float32Array;
  bgA: Rgb;
  bgB: Rgb;
  flat: Rgb;
  gap: Rgb;
}

/** Every palette's uniforms, built once. */
const PALETTE_DATA = new Map<TruchetPalette, PaletteData>();
function paletteData(name: string): PaletteData {
  const p = palette(name);
  let d = PALETTE_DATA.get(p);
  if (!d) {
    const bands = new Float32Array(TONES * 3);
    p.bands.forEach((hex, i) => {
      bands.set(hexToUnitRgb(hex), i * 3);
    });
    const bgA = hexToUnitRgb(p.bgA);
    const bgB = hexToUnitRgb(p.bgB);
    const flat: Rgb = [(bgA[0] + bgB[0]) / 2, (bgA[1] + bgB[1]) / 2, (bgA[2] + bgB[2]) / 2];
    const gap: Rgb = [flat[0] * GAP_SHADE, flat[1] * GAP_SHADE, flat[2] * GAP_SHADE];
    d = { bands, bgA, bgB, flat, gap };
    PALETTE_DATA.set(p, d);
  }
  return d;
}

/**
 * A calm grid of Truchet tiles: quarter-circle arcs join into long winding paths,
 * and now and then a tile slowly turns 90 degrees, rewiring the paths around it.
 * One full-resolution pass with one texel fetch per pixel; the small tile texture
 * is uploaded only when a flip starts or ends, or a path colour is fading.
 */
export const truchet = defineEffect(truchetMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uTiles",
        "uGrid",
        "uCells",
        "uFlip",
        "uBand",
        "uBgA",
        "uBgB",
        "uGap",
        "uFlat",
        "uStyle",
        "uWidth",
        "uPathColors",
        "uCalm",
      ]);
      gl.useProgram(program);
      u.i1("uTiles", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));

      let tex: WebGLTexture | null = null;
      scope.defer(() => {
        if (tex) {
          gl.deleteTexture(tex);
        }
        tex = null;
      });
      let sim: TruchetSim | undefined;
      let data = new Uint8Array(4);
      const flips = new Float32Array(MAX_FLIPS + 1);
      const sentFlips = new Float32Array(MAX_FLIPS + 1).fill(Number.NaN);

      let width = 1;
      let height = 1;
      let scale = 1;
      let layout: GridLayout | undefined;
      let layoutTile = Number.NaN;
      let lastPalette: PaletteData | undefined;

      /** Lays the grid out for the current size and tile size, rebuilding the sim if its shape or seed changed. */
      function ensureGrid(tileSize: number, seed: number) {
        const tilePx = Math.max(1, tileSize) * scale;
        if (!layout || tilePx !== layoutTile) {
          layout = gridLayout(width, height, tilePx);
          layoutTile = tilePx;
        }
        const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
        if (sim && sim.cols === layout.cols && sim.rows === layout.rows && sim.seed === s) {
          return;
        }
        sim = createTruchet({
          cols: layout.cols,
          rows: layout.rows,
          seed: s,
          from: sim?.seed === s ? sim : undefined,
        });
        data = new Uint8Array(4 * sim.cols * sim.rows);
        sim.encode(data);
        if (tex) {
          gl.deleteTexture(tex);
        }
        tex = null;
        tex = createDataTexture(gl, {
          width: sim.cols,
          height: sim.rows,
          internalFormat: gl.RGBA8UI,
          format: gl.RGBA_INTEGER,
          type: gl.UNSIGNED_BYTE,
          data,
          filter: gl.NEAREST,
        });
        sentFlips.fill(Number.NaN);
      }

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
          layout = undefined;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          gl.useProgram(program);
          ensureGrid(p.tileSize, p.seed);
          const g = layout;
          const s = sim;
          const t = tex;
          if (!g || !s || !t) {
            throw new Error("truchet: ensureGrid left no layout, sim or texture");
          }

          const flags = s.step(dt, p.flipRate);
          gl.activeTexture(gl.TEXTURE0);
          if (flags & (STARTED | COMPLETED | FADING)) {
            s.encode(data);
            updateDataTexture(gl, t, s.cols, s.rows, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, t);
          }

          s.flipProgress(flips);
          let flipsChanged = false;
          for (let k = 0; k <= MAX_FLIPS; k++) {
            if (flips[k] !== sentFlips[k]) {
              sentFlips[k] = flips[k];
              flipsChanged = true;
            }
          }
          if (flipsChanged) {
            gl.uniform1fv(u.loc.uFlip, sentFlips);
          }

          u.f4("uGrid", g.ox, g.oy, 1 / g.tilePx, g.tilePx);
          u.f2("uCells", s.cols, s.rows);

          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uBand, pal.bands);
          }
          u.v3("uBgA", pal.bgA);
          u.v3("uBgB", pal.bgB);
          u.v3("uFlat", pal.flat);
          u.v3("uGap", pal.gap);
          u.i1("uStyle", styleIndex(p.style));
          const band = Math.min(Math.max(p.bandWidth, 0.01), BAND_WIDTH_MAX);
          u.f2("uWidth", band / 2, Math.max(OUTLINE_HALF * scale, OUTLINE_MIN));
          u.f1("uPathColors", p.pathColors ? 1 : 0);
          u.f3("uCalm", width / 2, 6 / width, p.calmCentre ? CALM_STRENGTH : 0);

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
