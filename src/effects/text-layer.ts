/**
 * Crisp, recolourable text for screen-like effects (dashboards, terminals,
 * spreadsheets): labels drawn with a 2D canvas at device-pixel size, uploaded a
 * dirty rect at a time, and copied to the screen texel for texel.
 *
 * The canvas holds no real colours. Each piece of text is drawn in one of a few
 * role colours (`TEXT_ROLES`: pure channel mixes that never overlap, since no two
 * labels do), and the shader maps each role to a colour from a palette uniform.
 * A theme change, or swapping the up and down colours, then eases on the GPU
 * without redrawing a single glyph.
 *
 * The canvas is a free-form atlas: an effect draws labels wherever it likes and
 * then draws regions of it with `quad`, each mapped to a screen rect with its
 * own opacity. A region drawn at its own size and whole-pixel position copies
 * texel for texel; a moved region (a list row sliding in, an axis stepping
 * along) or a scaled one samples bilinearly while it moves.
 */
import { createCanvasAtlas } from "./canvas-texture";
import { createUniforms, type Scope, scopedProgram } from "./gl";

/**
 * The fill style for each text role. Drawn on a transparent canvas and uploaded
 * premultiplied, a glyph of role R at coverage c reads back as c times R's
 * channels, and the shader tells the roles apart by which channels are lit.
 */
export const TEXT_ROLES = {
  /** Main text. */
  primary: "#ff0000",
  /** Labels, units and other secondary text. */
  muted: "#00ff00",
  /** Rising values. */
  up: "#0000ff",
  /** Falling values. */
  down: "#ff00ff",
  /** Text on a filled chip or tag, in the background colour. */
  inverse: "#00ffff",
} as const;

/** Floats in the palette `draw` takes: an RGB triple per role, in `TEXT_ROLES` order. */
export const TEXT_PALETTE_FLOATS = 15;

/** Floats per region-quad vertex: screen position, canvas position, opacity. */
const QUAD_STRIDE = 5;

const VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aSrc;
layout(location = 2) in float aAlpha;
uniform vec2 uResolution;
uniform vec2 uTexSize;
out vec2 vUv;
out float vAlpha;
void main() {
  vUv = aSrc / uTexSize;
  vAlpha = aAlpha;
  gl_Position = vec4(aPos.x / uResolution.x * 2.0 - 1.0, 1.0 - aPos.y / uResolution.y * 2.0, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
// highp: the atlas is screen-sized, past what mediump texture coordinates resolve.
precision highp float;
uniform sampler2D uTex;
uniform vec3 uRoles[5];
in vec2 vUv;
in float vAlpha;
out vec4 outColor;
void main() {
  vec4 t = texture(uTex, vUv);
  // Down lights red and blue, inverse green and blue; what's left is single-channel.
  float down = min(t.r, t.b);
  float inverse = min(t.g, t.b);
  float primary = t.r - down;
  float muted = t.g - inverse;
  float up = max(0.0, t.b - down - inverse);
  vec3 c = primary * uRoles[0] + muted * uRoles[1] + up * uRoles[2] + down * uRoles[3] + inverse * uRoles[4];
  outColor = vec4(c, t.a) * vAlpha;
}
`;

export interface TextLayer {
  /**
   * The 2D context to draw on, or null before `resize` or where there is no
   * `OffscreenCanvas`. Draw only on areas cleared with `clear`, so the upload
   * picks them up.
   */
  readonly ctx: OffscreenCanvasRenderingContext2D | null;
  readonly width: number;
  readonly height: number;
  /**
   * Makes the canvas `width` x `height` and clears it all. Returns whether there
   * is a canvas to draw on. A no-op (keeping the contents) if the size is unchanged.
   */
  resize: (width: number, height: number) => boolean;
  /** Frees the canvas and the texture's storage; `resize` brings them back. */
  release: () => void;
  /** Clears a rect of the canvas and marks it for upload. */
  clear: (x: number, y: number, w: number, h: number) => void;
  /** Uploads the rects cleared (and drawn on) since the last flush. */
  flush: () => void;
  /**
   * Draws `text` in `role` (a `TEXT_ROLES` colour) and `font`, vertically
   * centred on `y` and aligned at `x` (both rounded to whole pixels), squeezed
   * into `maxWidth`. Draws nothing without a canvas, for empty text or for no width.
   */
  fill: (
    text: string,
    x: number,
    y: number,
    role: string,
    font: string,
    maxWidth: number,
    align?: CanvasTextAlign,
  ) => void;
  /**
   * Queues the canvas rect (`sx`, `sy`, `sw`, `sh`) to be drawn to the screen
   * rect (`dx`, `dy`, `dw`, `dh`) at opacity `alpha`.
   */
  quad: (
    sx: number,
    sy: number,
    sw: number,
    sh: number,
    dx: number,
    dy: number,
    dw: number,
    dh: number,
    alpha: number,
  ) => void;
  /**
   * Draws the queued quads on a `width` x `height` target, colouring each role
   * from `palette` (see `TEXT_PALETTE_FLOATS`), and empties the queue.
   * Premultiplied output: blend with `ONE, ONE_MINUS_SRC_ALPHA`. Leaves texture
   * unit 0 active with nothing bound, and no vertex array bound.
   */
  draw: (width: number, height: number, palette: Float32Array) => void;
}

/** A text layer of up to `maxQuads` regions a frame, owned by `scope`. */
export function createTextLayer(
  gl: WebGL2RenderingContext,
  scope: Scope,
  maxQuads: number,
): TextLayer {
  const program = scopedProgram(gl, scope, VERTEX, FRAGMENT);
  const u = createUniforms(gl, program, ["uResolution", "uTexSize", "uTex", "uRoles"]);
  gl.useProgram(program);
  u.i1("uTex", 0);
  gl.useProgram(null);

  const atlas = createCanvasAtlas(gl, scope);

  const vao = scope.add(gl.createVertexArray(), (v) => {
    gl.deleteVertexArray(v);
  });
  const buffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  const verts = new Float32Array(maxQuads * 6 * QUAD_STRIDE);
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW);
  const bytes = QUAD_STRIDE * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, bytes, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 2, gl.FLOAT, false, bytes, 8);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, bytes, 16);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);

  let quads = 0;

  const put = (o: number, x: number, y: number, s: number, t: number, a: number) => {
    verts[o] = x;
    verts[o + 1] = y;
    verts[o + 2] = s;
    verts[o + 3] = t;
    verts[o + 4] = a;
  };

  return {
    get ctx() {
      return atlas.ctx;
    },
    get width() {
      return atlas.width;
    },
    get height() {
      return atlas.height;
    },
    resize: atlas.resize,
    release: atlas.release,
    clear: atlas.clear,
    flush: atlas.flush,
    fill(text, x, y, role, font, maxWidth, align = "left") {
      const ctx = atlas.ctx;
      if (!ctx || !(maxWidth > 0) || text.length === 0) {
        return;
      }
      ctx.font = font;
      ctx.fillStyle = role;
      ctx.textAlign = align;
      ctx.textBaseline = "middle";
      ctx.fillText(text, Math.round(x), Math.round(y), maxWidth);
    },
    quad(sx, sy, sw, sh, dx, dy, dw, dh, alpha) {
      if (!(alpha > 0) || !(sw > 0) || !(sh > 0) || !(dw > 0) || !(dh > 0) || quads >= maxQuads) {
        return;
      }
      const o = quads * 6 * QUAD_STRIDE;
      const s = QUAD_STRIDE;
      put(o, dx, dy, sx, sy, alpha);
      put(o + s, dx + dw, dy, sx + sw, sy, alpha);
      put(o + 2 * s, dx, dy + dh, sx, sy + sh, alpha);
      put(o + 3 * s, dx + dw, dy, sx + sw, sy, alpha);
      put(o + 4 * s, dx + dw, dy + dh, sx + sw, sy + sh, alpha);
      put(o + 5 * s, dx, dy + dh, sx, sy + sh, alpha);
      quads++;
    },
    draw(targetWidth, targetHeight, palette) {
      const n = quads;
      quads = 0;
      if (n === 0 || !atlas.ready) {
        return;
      }
      gl.useProgram(program);
      u.f2("uResolution", targetWidth, targetHeight);
      u.f2("uTexSize", atlas.width, atlas.height);
      gl.uniform3fv(u.loc.uRoles, palette, 0, TEXT_PALETTE_FLOATS);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts, 0, n * 6 * QUAD_STRIDE);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, n * 6);
      gl.bindVertexArray(null);
      gl.bindTexture(gl.TEXTURE_2D, null);
    },
  };
}
