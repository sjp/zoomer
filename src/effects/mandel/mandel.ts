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
import { createLowResTarget, qualityDivisor } from "../lowres";
import {
  advanceDrift,
  advanceSpin,
  advanceZoom,
  capIndex,
  ESCAPE_R2,
  fadeWeight,
  iterCap,
  loopDoublings,
  PALETTE_SIZE,
  paletteFor,
  paletteMean,
  paletteTexels,
  targetFor,
  writePaletteMap,
  writeView,
  type MandelTarget,
  type Palette,
} from "./mandel-sim";
import { mandelMeta } from "./mandel.meta";
import { defineEffect } from "../types";

/** Share of the headroom above the typical escape count that fades into the interior colour. */
const INTERIOR_BAND = 0.3;
/** Palette cycles per pixel at which a band starts, and finishes, fading to the palette's mean. */
const AA_START = 0.2;
const AA_END = 0.6;
/** Centre dimming falls off as exp(-r² / R²), r in half-heights. */
const DIM_RADIUS = 0.75;

/**
 * One pass per view at the low-res size: z² + c up to the iteration cap, skipping
 * the main cardioid and period-2 bulb, then a smooth escape count through a
 * repeating palette texture. The incoming view of the cross-fade only runs while
 * it has weight (`uFade > 0`, uniform control flow, so derivatives stay defined).
 *
 * Bands finer than a pixel fade to the palette's mean (`fwidth` of the palette
 * coordinate), so filaments read as a soft haze instead of shimmering noise.
 * Escape counts near the cap fade into the interior colour, so the cap (which
 * changes with depth) never pops pixels in or out.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uPalette;
uniform vec2 uCentre;
/** Half the low-res size in px, and 1 / half-height. */
uniform vec3 uFrame;
/** Per view: complex scale-and-turn (xy) and offset (zw). */
uniform vec4 uViewA;
uniform vec4 uViewB;
/** Per view: palette map scale and offset, iteration cap, and cap index. */
uniform vec4 uMapA;
uniform vec4 uMapB;
uniform float uFade;
/** 1 / cycle, palette drift (cycles), interior band (index iterations), dither on. */
uniform vec4 uShade;
uniform vec3 uInterior;
uniform vec3 uMean;
uniform float uDim;
out vec4 outColor;
${DITHER_GLSL}

vec3 shade(vec2 p, vec4 view, vec4 map) {
  vec2 c = uCentre + vec2(view.x * p.x - view.y * p.y, view.y * p.x + view.x * p.y) + view.zw;
  float xq = c.x - 0.25;
  float q = xq * xq + c.y * c.y;
  float bx = c.x + 1.0;
  bool inside = q * (q + xq) <= 0.25 * c.y * c.y || bx * bx + c.y * c.y <= 0.0625;
  int n = inside ? 0 : int(ceil(map.z));
  vec2 z = vec2(0.0);
  float r2 = 0.0;
  float nu = -1.0;
  for (int i = 0; i < n; i++) {
    float x2 = z.x * z.x;
    float y2 = z.y * z.y;
    r2 = x2 + y2;
    if (r2 > ${glslFloat(ESCAPE_R2)}) {
      nu = float(i) + 1.0 - log2(0.5 * log2(r2));
      break;
    }
    z = vec2(x2 - y2 + c.x, 2.0 * z.x * z.y + c.y);
  }
  float idx = nu >= 0.0 ? nu * map.x + map.y : map.w;
  float u = idx * uShade.x + uShade.y;
  float aa = smoothstep(${glslFloat(AA_START)}, ${glslFloat(AA_END)}, fwidth(u));
  vec3 col = mix(textureLod(uPalette, vec2(u, 0.5), 0.0).rgb, uMean, aa);
  return mix(col, uInterior, smoothstep(map.w - uShade.z, map.w, idx));
}

void main() {
  vec2 p = (gl_FragCoord.xy - uFrame.xy) * uFrame.z;
  vec3 col = shade(p, uViewA, uMapA);
  if (uFade > 0.0) col = mix(col, shade(p, uViewB, uMapB), uFade);
  col *= 1.0 - uDim * exp(-dot(p, p) * ${glslFloat(1 / (DIM_RADIUS * DIM_RADIUS))});
  outColor = vec4(col + uShade.w * dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Mandelbrot zoom: an endless slow zoom toward a self-similar point, looped with a
 * cross-fade from the deep view back to the matching shallow one. All zoom maths
 * is float64 on the CPU; the shader gets only a float32 centre and per-view
 * complex offsets relative to it.
 */
export const mandel = defineEffect(mandelMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const u = createUniforms(gl, program, [
        "uPalette",
        "uCentre",
        "uFrame",
        "uViewA",
        "uViewB",
        "uMapA",
        "uMapB",
        "uFade",
        "uShade",
        "uInterior",
        "uMean",
        "uDim",
      ]);
      gl.useProgram(program);
      u.i1("uPalette", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));

      let palette: Palette = paletteFor(mandelMeta.params.palette.default);
      const paletteTex = scope.add(
        createDataTexture(gl, {
          width: PALETTE_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: paletteTexels(palette),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let mean = paletteMean(palette);

      const view = new Float64Array(4);
      const map = new Float64Array(2);

      let width = 1;
      let height = 1;
      let tgt: MandelTarget | undefined;
      let zoom = 0;
      let spin = 0;
      let drift = 0;

      const setView = (t: MandelTarget, name: "uViewA" | "uViewB", depth: number) => {
        writeView(t, depth, spin, view);
        u.f4(name, view[0], view[1], view[2], view[3]);
      };
      const setMap = (t: MandelTarget, name: "uMapA" | "uMapB", depth: number, detail: number) => {
        writePaletteMap(t, depth, map);
        u.f4(name, map[0], map[1], iterCap(t, depth, detail), capIndex(t, detail));
      };

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          target.resize(width, height, qualityDivisor(p.quality));

          const t = targetFor(p.target);
          const loop = loopDoublings(t);
          if (t !== tgt) {
            // A new target starts at the top of its loop rather than mid-way.
            tgt = t;
            zoom = 0;
          }
          zoom = advanceZoom(zoom, dt, p.speed, loop);
          spin = advanceSpin(spin, dt, p.spin);
          drift = advanceDrift(drift, dt);

          const pal = paletteFor(p.palette);
          gl.activeTexture(gl.TEXTURE0);
          if (pal !== palette) {
            palette = pal;
            mean = paletteMean(pal);
            updateDataTexture(
              gl,
              paletteTex,
              PALETTE_SIZE,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              paletteTexels(pal),
            );
          } else {
            gl.bindTexture(gl.TEXTURE_2D, paletteTex);
          }

          target.bind();
          gl.useProgram(program);
          const lw = target.width;
          const lh = target.height;
          u.f3("uFrame", lw / 2, lh / 2, 2 / lh);
          u.f2("uCentre", t.centre[0], t.centre[1]);
          setView(t, "uViewA", zoom);
          setMap(t, "uMapA", zoom, p.detail);
          const fade = fadeWeight(t, zoom);
          u.f1("uFade", fade);
          if (fade > 0) {
            setView(t, "uViewB", zoom - loop);
            setMap(t, "uMapB", zoom - loop, p.detail);
          }
          const capI = capIndex(t, p.detail);
          u.f4(
            "uShade",
            1 / t.cycle,
            drift,
            INTERIOR_BAND * (capI - t.baseIters),
            target.direct ? 1 : 0,
          );
          u.rgb("uInterior", palette.interior);
          u.v3("uMean", mean);
          u.f1("uDim", Number.isFinite(p.dim) ? Math.min(Math.max(p.dim, 0), 1) : 0);
          triangle.draw();

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
