/**
 * A camcorder's or VCR's on-screen display: white monospaced text with a dark
 * outline, the two-line date stamp, and a pass that draws premultiplied canvas
 * textures (labels painted with `paintCanvas`) into rectangles of the frame.
 */
import { MONO_FONT_STACK } from "./canvas-texture";
import {
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  type Scope,
  scopedProgram,
} from "./gl";

const MONTHS = [
  "JAN.",
  "FEB.",
  "MAR.",
  "APR.",
  "MAY",
  "JUN.",
  "JUL.",
  "AUG.",
  "SEP.",
  "OCT.",
  "NOV.",
  "DEC.",
] as const;

const two = (n: number) => (n < 10 ? "0" : "") + String(n);

/** White on-screen-display text with a dark outline, as camcorders print it. */
export function osdText(
  ctx: OffscreenCanvasRenderingContext2D,
  px: number,
  x: number,
  y: number,
  text: string,
  align: CanvasTextAlign,
) {
  ctx.font = `bold ${String(Math.round(px))}px ${MONO_FONT_STACK}`;
  ctx.textAlign = align;
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, px * 0.14);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = "#f4f4ee";
  ctx.fillText(text, x, y);
}

/**
 * Paints the date stamp of the time `ms` (local time) on a `w` x `h` canvas,
 * right-aligned in two lines: "PM 3:04:05", "NOV. 14 2026".
 */
export function paintStamp(
  ctx: OffscreenCanvasRenderingContext2D,
  w: number,
  h: number,
  ms: number,
) {
  const d = new Date(ms);
  const hours = d.getHours();
  const line1 = `${hours < 12 ? "AM" : "PM"} ${String(hours % 12 === 0 ? 12 : hours % 12)}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  const line2 = `${MONTHS[d.getMonth()]} ${String(d.getDate())} ${String(d.getFullYear())}`;
  ctx.clearRect(0, 0, w, h);
  osdText(ctx, h / 2.6, w - h * 0.06, h * 0.06, line1, "right");
  osdText(ctx, h / 2.6, w - h * 0.06, h * 0.06 + h / 2.2, line2, "right");
}

/** Draws a premultiplied canvas texture into the viewport (set to its rectangle). */
const OSD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)) * uAlpha;
}
`;

interface OsdDrawer {
  /** Binds the pass and turns on premultiplied blending. */
  begin: () => void;
  /**
   * Draws `tex` (a premultiplied canvas texture) into the rectangle at `x`, `y`
   * from the frame's top-left, `w` x `h` px, at opacity `alpha`; `frameHeight`
   * is the frame's height in px. Call between `begin` and `end`.
   */
  draw: (
    tex: WebGLTexture,
    x: number,
    y: number,
    w: number,
    h: number,
    alpha: number,
    frameHeight: number,
  ) => void;
  /** Turns blending off, unbinds the texture and restores the full `width` x `height` viewport. */
  end: (width: number, height: number) => void;
}

/** The overlay pass, owned by `scope`. */
export function createOsdDrawer(gl: WebGL2RenderingContext, scope: Scope): OsdDrawer {
  const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, OSD_FRAGMENT);
  const triangle = scope.own(createFullscreenTriangle(gl));
  const u = createUniforms(gl, program, ["uTex", "uAlpha"]);
  gl.useProgram(program);
  u.i1("uTex", 0);
  return {
    begin() {
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    },
    draw(tex, x, y, w, h, alpha, frameHeight) {
      gl.viewport(x, frameHeight - y - h, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      u.f1("uAlpha", alpha);
      triangle.draw();
    },
    end(width, height) {
      gl.disable(gl.BLEND);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.viewport(0, 0, width, height);
    },
  };
}
