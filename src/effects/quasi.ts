import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  withScope,
} from "./gl";
import {
  advanceDrift,
  advancePhase,
  centreIndex,
  centreOffset,
  footprintGain,
  MAX_WAVES,
  PALETTE_STOPS,
  paletteData,
  TAU,
  toneScale,
  wavelengthPx,
  waveCount,
  writeDirections,
  writeWaves,
} from "./quasi-sim";
import { quasiMeta } from "./quasi.meta";
import { defineEffect } from "./types";

/**
 * One full-resolution pass with no texture fetches: n cosines (5–11), a soft
 * saturating tone curve and a four-stop palette. The wave frequency and the
 * pixel-footprint low-pass are uniform over the frame, so the anti-aliasing gain
 * comes from the CPU (`footprintGain`) instead of a per-pixel `fwidth`.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Per wave: direction times angular frequency (per device px), and phase offset. */
uniform vec3 uWave[${MAX_WAVES}];
uniform int uN;
/** Gain on the raw cosine sum, and contrast (0 to 1). */
uniform vec2 uTone;
uniform vec3 uPal[${PALETTE_STOPS}];
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 x = gl_FragCoord.xy;
  float s = 0.0;
  for (int k = 0; k < ${MAX_WAVES}; k++) {
    if (k >= uN) break;
    s += cos(dot(x, uWave[k].xy) + uWave[k].z);
  }
  float g = s * uTone.x;
  float t = 0.5 + 0.5 * uTone.y * g * inversesqrt(1.0 + g * g);
  float p = t * ${PALETTE_STOPS - 1}.0;
  vec3 c = mix(uPal[0], uPal[1], clamp(p, 0.0, 1.0));
  c = mix(c, uPal[2], clamp(p - 1.0, 0.0, 1.0));
  c = mix(c, uPal[3], clamp(p - 2.0, 0.0, 1.0));
  outColor = vec4(c + dither8(x), 1.0);
}
`;

/**
 * Quasicrystal: 5 to 11 plane waves at evenly spaced angles sum to a soft,
 * never-repeating pattern; their shared phase advances so it flows from a centre.
 */
export const quasi = defineEffect(quasiMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, ["uWave", "uN", "uTone", "uPal"]);
      const triangle = scope.own(createFullscreenTriangle(gl));

      const dirs = new Float64Array(2 * MAX_WAVES);
      const waves = new Float32Array(3 * MAX_WAVES);
      const centre = new Float64Array(2);
      let dirsN = 0;
      let lastPalette: Float32Array | undefined;
      let phase = 0;
      let drift = 0;

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
          drift = advanceDrift(drift, dt);
          const n = waveCount(p.symmetry);
          if (n !== dirsN) {
            dirsN = n;
            writeDirections(n, dirs);
          }
          const lambda = wavelengthPx(p.scale, scale);
          const f = TAU / lambda;
          centreOffset(centreIndex(p.centre), drift, centre);
          writeWaves(
            dirs,
            n,
            f,
            phase,
            width / 2 + centre[0] * height,
            height / 2 + centre[1] * height,
            waves,
          );
          gl.uniform3fv(u.loc.uWave, waves);
          u.i1("uN", n);
          const contrast = Number.isFinite(p.contrast) ? Math.min(Math.max(p.contrast, 0), 1) : 0;
          u.f2("uTone", toneScale(n, footprintGain(lambda)), contrast);

          const pal = paletteData(p.palette);
          if (pal !== lastPalette) {
            lastPalette = pal;
            gl.uniform3fv(u.loc.uPal, pal);
          }

          triangle.draw();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
