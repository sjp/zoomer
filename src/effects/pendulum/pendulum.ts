import type { Rgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import {
  BALL_FLOATS,
  BAR_LINES,
  createPendulumRig,
  LINE_FLOATS,
  SHADOW_FLOATS,
} from "./pendulum-sim";
import { MAX_PENDULUMS, pendulumMeta } from "./pendulum.meta";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { defineEffect } from "../types";

/** Studio backdrop: a charcoal gradient with a soft pool of light behind the rig. */
const BACKDROP_TOP: Rgb = [0.105, 0.11, 0.122];
const BACKDROP_BOTTOM: Rgb = [0.035, 0.037, 0.043];
const SPOT_COLOR: Rgb = [0.075, 0.077, 0.083];

const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uSpotColor;
/** Spot centre (GL px, y up), 1 / x radius, 1 / y radius. */
uniform vec4 uSpot;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec3 c = mix(uBottom, uTop, vUv.y);
  vec2 d = (gl_FragCoord.xy - uSpot.xy) * uSpot.zw;
  float f = max(0.0, 1.0 - dot(d, d));
  c += uSpotColor * (f * f);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Soft shadows: a blurred capsule per instance (zero length for a ball), darkening. */
const SHADOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** End a x, y, end b x, y (device px, y down). */
layout(location = 1) in vec4 aSegment;
/** Radius, blur (device px), alpha, unused. */
layout(location = 2) in vec4 aShape;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vLength;
flat out vec3 vShape;
${TO_CLIP_GLSL}
void main() {
  vec2 a = aSegment.xy;
  vec2 d = aSegment.zw - a;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float ext = aShape.x + aShape.y + 1.0;
  float u = aCorner.x < 0.0 ? -ext : len + ext;
  float v = aCorner.y * ext;
  vLocal = vec2(u, v);
  vLength = len;
  vShape = aShape.xyz;
  gl_Position = pxToClip(a + dir * u + nrm * v, uResolution);
}
`;

const SHADOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vLength;
flat in vec3 vShape;
out vec4 outColor;
void main() {
  float dx = vLocal.x - clamp(vLocal.x, 0.0, vLength);
  float dist = length(vec2(dx, vLocal.y));
  float a = vShape.z * (1.0 - smoothstep(vShape.x - vShape.y, vShape.x + vShape.y, dist));
  outColor = vec4(0.0, 0.0, 0.0, a);
}
`;

const BALL_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y, radius (device px, y down), brightness. */
layout(location = 1) in vec4 aBall;
/** Tint rgb, metal (1 metal, 0 lacquered colour). */
layout(location = 2) in vec4 aTint;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec2 vBall;
flat out vec4 vTint;
${TO_CLIP_GLSL}
void main() {
  float ext = aBall.z + 1.0;
  vLocal = aCorner * ext;
  vBall = aBall.zw;
  vTint = aTint;
  gl_Position = pxToClip(aBall.xy + vec2(aCorner.x, -aCorner.y) * ext, uResolution);
}
`;

/**
 * Analytic sphere: the reflection looks up a made-up studio (dark floor, grey
 * walls, a bright ceiling and a softbox at the key light), plus a sharp specular.
 * Metal is all reflection, tinted; lacquered colour is diffuse plus a Fresnel coat.
 */
const BALL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec2 vBall;
flat in vec4 vTint;
/** Toward the key light, view space (x right, y up, z toward the viewer). */
uniform vec3 uKey;
out vec4 outColor;
void main() {
  float r = vBall.x;
  float d = length(vLocal);
  float cov = clamp(r + 0.5 - d, 0.0, 1.0);
  vec2 u = vLocal / max(r, 1e-3);
  float q = dot(u, u);
  if (q > 1.0) u *= inversesqrt(q);
  float z = sqrt(max(0.0, 1.0 - dot(u, u)));
  vec3 n = vec3(u, z);
  // reflect((0, 0, -1), n).
  vec3 rd = vec3(2.0 * z * n.xy, 2.0 * z * z - 1.0);
  vec3 env = mix(vec3(0.03, 0.03, 0.035), vec3(0.3, 0.31, 0.33), smoothstep(-0.3, 0.05, rd.y));
  env += vec3(0.35) * smoothstep(0.25, 0.9, rd.y);
  float kr = max(dot(rd, uKey), 0.0);
  env += vec3(1.2) * smoothstep(0.86, 0.96, kr);
  float spec = pow(kr, 90.0);
  float diff = max(dot(n, uKey), 0.0);
  float fres = 0.04 + 0.96 * pow(1.0 - z, 5.0);
  vec3 metal = vTint.rgb * env + spec * mix(vTint.rgb, vec3(1.0), 0.5);
  vec3 lacquer = vTint.rgb * (0.1 + 0.8 * diff) + env * (0.06 + 0.5 * fres) + vec3(0.9 * spec);
  vec3 col = mix(lacquer, metal, vTint.a) * vBall.y;
  outColor = vec4(col * cov, cov);
}
`;

/**
 * Pendulum wave: a row of pendulums of graded lengths hanging from a bar, released
 * together, drifting into travelling waves and apparent chaos and back into line
 * once per cycle. The model (`pendulum-sim.ts`) is exact and periodic; the CPU
 * projects the rig each frame. Draw order: backdrop, soft shadows, strings, balls
 * (farthest first), then the bar, which from above lies over the balls.
 */
export const pendulum = defineEffect(pendulumMeta, {
  create(gl) {
    return withScope((scope) => {
      const backdropProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACKDROP_FRAGMENT);
      const bgU = createUniforms(gl, backdropProgram, ["uTop", "uBottom", "uSpotColor", "uSpot"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const shadowProgram = scopedProgram(gl, scope, SHADOW_VERTEX, SHADOW_FRAGMENT);
      const shU = createUniforms(gl, shadowProgram, ["uResolution"]);
      const ballProgram = scopedProgram(gl, scope, BALL_VERTEX, BALL_FRAGMENT);
      const ballU = createUniforms(gl, ballProgram, ["uResolution", "uKey"]);

      const shadows = scope.own(createSpriteBatch(gl, MAX_PENDULUMS + 1, [4, 4], [QUAD]));
      const balls = scope.own(
        createSpriteBatch(gl, MAX_PENDULUMS, [4, 4], [polygonStrip(8, Math.PI / 8)]),
      );
      const strings = scope.own(createStreakRenderer(gl, MAX_PENDULUMS, { blend: "alpha" }));
      const bar = scope.own(createStreakRenderer(gl, BAR_LINES, { blend: "alpha" }));
      if (
        balls.stride !== BALL_FLOATS ||
        shadows.stride !== SHADOW_FLOATS ||
        STREAK_FLOATS !== (LINE_FLOATS as number)
      ) {
        throw new Error("Pendulum: instance layout mismatch");
      }

      const rig = createPendulumRig();
      let width = 1;
      let height = 1;
      let scale = 1;
      let builtKey = "";

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const refWidth = width / scale;
          const key = `${String(p.count)}:${p.view}:${p.placement}:${String(refWidth)}`;
          if (key !== builtKey) {
            builtKey = key;
            rig.configure({ count: p.count, view: p.view, placement: p.placement, refWidth });
          }
          rig.update(dt, { cycle: p.cycle, amplitude: p.amplitude });
          rig.fill(scale, p.finish, balls.data, strings.data, bar.data, shadows.data);
          const st = rig.state;

          // 1. Backdrop.
          gl.useProgram(backdropProgram);
          bgU.v3("uTop", BACKDROP_TOP);
          bgU.v3("uBottom", BACKDROP_BOTTOM);
          bgU.v3("uSpotColor", SPOT_COLOR);
          const spot = st.spot;
          bgU.f4(
            "uSpot",
            spot.x * scale,
            height - spot.y * scale,
            1 / (spot.rx * scale),
            1 / (spot.ry * scale),
          );
          triangle.draw();

          // 2. Soft shadows, premultiplied black over the backdrop.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          shadows.upload(st.shadowCount);
          gl.useProgram(shadowProgram);
          shU.f2("uResolution", width, height);
          shadows.draw(0, st.shadowCount);

          // 3. Strings (source-over lines).
          strings.upload(st.stringCount);
          strings.draw(st.stringCount, width, height);

          // 4. Balls, farthest first, premultiplied source-over.
          balls.upload(st.ballCount);
          gl.useProgram(ballProgram);
          ballU.f2("uResolution", width, height);
          ballU.v3("uKey", st.key);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          balls.draw(0, st.ballCount);

          // 5. The bar.
          bar.upload(st.barCount);
          bar.draw(st.barCount, width, height);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
