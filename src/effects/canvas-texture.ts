/**
 * Textures drawn with a 2D canvas: labels, signs, screens and boards that the
 * Scenes (and a few other effects) letter with a system font on an
 * `OffscreenCanvas` and upload whole.
 */
import { resetUnpackState, type Scope } from "./gl";

/** A clean system sans-serif stack; no font is bundled. */
export const SANS_FONT_STACK = `"Helvetica Neue", Helvetica, Arial, "Liberation Sans", "DejaVu Sans", sans-serif`;

export interface CanvasTextureOptions {
  /** Min and mag filter. Defaults to `gl.LINEAR`. */
  filter?: GLenum;
  /** Premultiply the canvas's colour by its alpha on upload. Defaults to false. */
  premultiply?: boolean;
}

export interface CanvasTexture {
  readonly texture: WebGLTexture;
  /**
   * Replaces the texture with `source`, or with one transparent texel for null.
   * Leaves texture unit 0 active with nothing bound.
   */
  upload: (source: TexImageSource | null) => void;
}

/**
 * A clamped texture for canvas uploads, owned by `scope` and holding one
 * transparent texel until the first upload.
 */
export function createCanvasTexture(
  gl: WebGL2RenderingContext,
  scope: Scope,
  options: CanvasTextureOptions = {},
): CanvasTexture {
  const filter = options.filter ?? gl.LINEAR;
  const premultiply = options.premultiply ?? false;
  const texture = scope.add(gl.createTexture(), (t) => {
    gl.deleteTexture(t);
  });
  const upload = (source: TexImageSource | null) => {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    resetUnpackState(gl);
    if (source) {
      if (premultiply) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      }
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      if (premultiply) {
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      }
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        1,
        1,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        new Uint8Array(4),
      );
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  };
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  upload(null);
  return { texture, upload };
}

/**
 * Draws on a new `width` x `height` OffscreenCanvas and returns it, or null where
 * there is no OffscreenCanvas or 2D context (old browsers, tests).
 */
export function paintCanvas(
  width: number,
  height: number,
  draw: (ctx: OffscreenCanvasRenderingContext2D) => void,
): OffscreenCanvas | null {
  if (typeof OffscreenCanvas === "undefined") {
    return null;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  draw(ctx);
  return canvas;
}
