/**
 * The split-flap glyph atlas, shared by Split-Flap Board and the Victorian Time
 * Machine's date counter: every glyph on the drum (`GLYPHS`) drawn white on
 * black with a system font into its own padded tile of an R8 texture, and the
 * GLSL that samples one glyph from it.
 */
import { glslFloat, resetUnpackState } from "../gl";
import { GLYPH_COUNT, GLYPHS } from "./splitflap-sim";
import { SANS_FONT_STACK } from "../canvas-texture";

/** Glyph tiles per row of the atlas. */
export const ATLAS_COLS = 8;
/** Blank texels around each atlas tile, so linear filtering never reads a neighbour. */
export const ATLAS_PAD = 2;
/** A system font stack for the glyphs: a bold grotesque, as on real boards. */
const FONT_FAMILY = SANS_FONT_STACK;
/** Cap height as a fraction of the cell height, and the widest a glyph may be. */
const CAP_FRACTION = 0.56;
const MAX_GLYPH_WIDTH = 0.82;

/** A text metric, or `fallback` when it's missing, zero or NaN. */
const metricOr = (value: number | undefined, fallback: number) =>
  value === undefined || value === 0 || Number.isNaN(value) ? fallback : value;

/** Where the glyphs sit in the atlas, as fractions of its size (u, v pairs). */
export interface GlyphAtlasMetrics {
  /** The pitch between tiles. */
  tile: [number, number];
  /** The blank pad before a tile's glyph area. */
  pad: [number, number];
  /** A glyph area: one cell. */
  glyph: [number, number];
}

/**
 * Draws each glyph white on black into its own padded tile of `cw` x `ch`
 * pixels (red = coverage) and uploads it to `texture` as R8 with linear
 * filtering. Leaves no texture bound. Returns where the tiles sit, for the
 * `GLYPH_AT_GLSL` uniforms.
 */
export function drawGlyphAtlas(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  cw: number,
  ch: number,
): GlyphAtlasMetrics {
  const tileW = cw + 2 * ATLAS_PAD;
  const tileH = ch + 2 * ATLAS_PAD;
  const canvas = new OffscreenCanvas(
    ATLAS_COLS * tileW,
    Math.ceil(GLYPH_COUNT / ATLAS_COLS) * tileH,
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Split-flap glyph atlas: no 2D context");
  }
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  // Size the font so its capitals are CAP_FRACTION of the cell tall.
  let size = ch * 0.78;
  ctx.font = `bold ${String(size)}px ${FONT_FAMILY}`;
  // Typed loosely: the tests' fake 2D context returns undefined from every method.
  const capMetrics = ctx.measureText("H") as TextMetrics | undefined;
  const capRatio = metricOr(capMetrics?.actualBoundingBoxAscent, 0.72 * size) / size;
  size = (CAP_FRACTION * ch) / Math.max(0.5, capRatio);
  ctx.font = `bold ${String(size)}px ${FONT_FAMILY}`;
  const cap = capRatio * size;
  Array.from(GLYPHS).forEach((g, i) => {
    if (g === " ") {
      return;
    }
    const x = (i % ATLAS_COLS) * tileW + ATLAS_PAD;
    const y = Math.floor(i / ATLAS_COLS) * tileH + ATLAS_PAD;
    const metrics = ctx.measureText(g) as TextMetrics | undefined;
    const w = metricOr(metrics?.width, 0);
    const squeeze = w > MAX_GLYPH_WIDTH * cw ? (MAX_GLYPH_WIDTH * cw) / w : 1;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cw, ch);
    ctx.clip();
    ctx.translate(x + cw / 2, y + ch / 2 + cap / 2);
    ctx.scale(squeeze, 1);
    ctx.fillText(g, 0, 0);
    ctx.restore();
  });
  gl.bindTexture(gl.TEXTURE_2D, texture);
  resetUnpackState(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, canvas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return {
    tile: [tileW / canvas.width, tileH / canvas.height],
    pad: [ATLAS_PAD / canvas.width, ATLAS_PAD / canvas.height],
    glyph: [cw / canvas.width, ch / canvas.height],
  };
}

/**
 * `float glyphAt(float g, vec2 uv)`: glyph `g`'s coverage at `uv` (0..1 across
 * the cell, y up). Needs the uniforms `uAtlas`, and `uTile`, `uPad` and
 * `uGlyphSize` set from `GlyphAtlasMetrics`.
 */
export const GLYPH_AT_GLSL = /* glsl */ `
uniform sampler2D uAtlas;
/** Tile pitch, pad and glyph area as fractions of the atlas. */
uniform vec2 uTile;
uniform vec2 uPad;
uniform vec2 uGlyphSize;
float glyphAt(float g, vec2 uv) {
  vec2 tile = vec2(mod(g, ${glslFloat(ATLAS_COLS)}), floor(g / ${glslFloat(ATLAS_COLS)}));
  return texture(uAtlas, tile * uTile + uPad + vec2(uv.x, 1.0 - uv.y) * uGlyphSize).r;
}
`;
