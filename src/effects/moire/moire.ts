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
import {
  advancePhase,
  DOT_FRACTION,
  DOTS,
  EDGE_SOFTNESS,
  LAYER_OPACITY,
  layerCount,
  layerPose,
  LINE_FRACTION,
  MAX_LAYERS,
  motionIndex,
  paletteData,
  patternKinds,
  spacingPx,
  writeLayerMap,
  type LayerPose,
  type PaletteData,
} from "./moire-sim";
import { moireMeta } from "./moire.meta";
import { defineEffect } from "../types";

/**
 * Centre vignette (always on, no param): how much of the layers' strength is
 * taken away in the middle of the frame, and the ramp over which it eases out, in
 * multiples of the ellipse that covers the centre third (half axes: a sixth of the
 * width, VIGNETTE_HEIGHT of the height).
 */
const VIGNETTE = 0.4;
const VIGNETTE_RAMP = [0.6, 1.6] as const;
const VIGNETTE_HEIGHT = 0.5;
/** Anti-aliasing ramp, in px, added to the soft edge on each side. */
const AA_PX = 0.75;

/**
 * One full-resolution pass with no texture fetches. Per layer: an affine map from
 * the pixel to pattern space, the distance to the nearest ring, line or dot, and a
 * soft smoothstep edge whose width includes the pixel footprint (the map has a
 * uniform scale, so it's exact and needs no `fwidth`). Layers multiply the paper
 * like overlaid transparencies, and the moiré appears on its own.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform mat2 uM[${String(MAX_LAYERS)}];
uniform vec2 uO[${String(MAX_LAYERS)}];
uniform vec3 uTint[${String(MAX_LAYERS)}];
uniform int uKind[${String(MAX_LAYERS)}];
/** Per layer: mark half width and edge half width (pattern units), and strength. */
uniform vec3 uEdge[${String(MAX_LAYERS)}];
uniform int uLayers;
uniform vec3 uBg;
/** Vignette: centre (device px), and 1 / its half axes (device px). */
uniform vec4 uVig;
out vec4 outColor;
${DITHER_GLSL}
float cover(int kind, vec2 p, vec2 e) {
  float d;
  if (kind == 0) {
    float r = length(p);
    d = abs(r - floor(r + 0.5));
  } else if (kind == 1) {
    d = abs(p.x - floor(p.x + 0.5));
  } else {
    d = length(p - floor(p + 0.5));
  }
  return 1.0 - smoothstep(e.x - e.y, e.x + e.y, d);
}
void main() {
  vec2 x = gl_FragCoord.xy;
  float calm = 1.0 - ${glslFloat(VIGNETTE)} * (1.0 - smoothstep(${glslFloat(VIGNETTE_RAMP[0])},
    ${glslFloat(VIGNETTE_RAMP[1])}, length((x - uVig.xy) * uVig.zw)));
  vec3 col = uBg;
  for (int i = 0; i < ${String(MAX_LAYERS)}; i++) {
    if (i >= uLayers) break;
    vec2 p = uM[i] * x + uO[i];
    float c = cover(uKind[i], p, uEdge[i].xy);
    col *= mix(vec3(1.0), uTint[i], c * uEdge[i].z * calm);
  }
  outColor = vec4(col + dither8(x), 1.0);
}
`;

/**
 * Two or three overlaid patterns of rings, lines or dots turn, drift or breathe
 * slowly against each other; their broad interference bands do the moving.
 */
export const moire = defineEffect(moireMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FRAGMENT);
      const u = createUniforms(gl, program, [
        "uM",
        "uO",
        "uTint",
        "uKind",
        "uEdge",
        "uLayers",
        "uBg",
        "uVig",
      ]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const m = new Float32Array(4 * MAX_LAYERS);
      const o = new Float32Array(2 * MAX_LAYERS);
      const edge = new Float32Array(3 * MAX_LAYERS);
      const kinds = new Int32Array(MAX_LAYERS);
      const pose: LayerPose = { cx: 0, cy: 0, angle: 0, scale: 1 };
      let lastKinds: readonly number[] | undefined;
      let lastPalette: PaletteData | undefined;
      let phase = 0;

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          gl.useProgram(program);

          phase = advancePhase(phase, dt, p.speed);
          const motion = motionIndex(p.motion);
          const layers = layerCount(p.layers);
          const base = spacingPx(p.spacing, scale);
          const contrast = Number.isFinite(p.contrast) ? Math.min(Math.max(p.contrast, 0), 1) : 0;

          const k = patternKinds(p.pattern);
          if (k !== lastKinds) {
            lastKinds = k;
            for (let i = 0; i < MAX_LAYERS; i++) {
              kinds[i] = k[i];
            }
            gl.uniform1iv(u.loc.uKind, kinds);
          }
          for (let i = 0; i < MAX_LAYERS; i++) {
            layerPose(i, motion, phase, pose);
            writeLayerMap(pose, base, width, height, scale, i, m, o);
            const layerPx = base * pose.scale;
            edge[3 * i] = (k[i] === DOTS ? DOT_FRACTION : LINE_FRACTION) / 2;
            edge[3 * i + 1] = EDGE_SOFTNESS + AA_PX / layerPx;
            edge[3 * i + 2] = contrast * LAYER_OPACITY[i];
          }
          gl.uniformMatrix2fv(u.loc.uM, false, m);
          gl.uniform2fv(u.loc.uO, o);
          gl.uniform3fv(u.loc.uEdge, edge);
          u.i1("uLayers", layers);

          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uTint, pal.tints);
          }
          u.v3("uBg", pal.bg);
          u.f4("uVig", width / 2, height / 2, 6 / width, 1 / (VIGNETTE_HEIGHT * height));

          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
