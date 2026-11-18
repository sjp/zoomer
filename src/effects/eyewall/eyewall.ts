import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { lowResSize } from "../lowres";
import { smoothstep } from "../math";
import { VALUE_FBM_GLSL, VALUE_NOISE_GLSL } from "../noise";
import { createSpriteBatch, QUAD } from "../sprites";
import { defineEffect } from "../types";
import {
  ALMOND_HALF_WIDTH,
  ALMOND_LOWER,
  ALMOND_UPPER,
  createWall,
  eyeAlpha,
  eyeClosure,
  eyeFadeOpen,
  eyePupil,
  inFrame,
  IRIS_RADIUS,
  IRIS_TRAVEL_X,
  IRIS_TRAVEL_Y,
  MAX_EYES,
  SOCKET_ASPECT,
  stepWall,
  type WallParams,
} from "./eyewall-sim";
import { eyewallMeta } from "./eyewall.meta";

/** The surface is smooth: it is baked at half resolution, once per size. */
const SURFACE_DIVISOR = 2;
/** Seconds a surface or iris change takes. */
const SURFACE_EASE = 1.5;
const IRIS_EASE = 1.5;

/**
 * Each surface: base and highlight colours, the lids' colour, and how much of
 * the baked mottle, grain and folds it shows.
 */
const SURFACES: Record<string, { base: string; light: string; lid: string; mix: number[] }> = {
  shadow: { base: "#090707", light: "#1e1816", lid: "#3a302c", mix: [1, 0, 0.45] },
  flesh: { base: "#2b1413", light: "#5c2e29", lid: "#7a463e", mix: [0.9, 0, 1] },
  bark: { base: "#140e09", light: "#382819", lid: "#4d3b2b", mix: [0.35, 1, 0.3] },
};

/** Iris palettes. Mixed draws mostly from the others, with a few pale eyes. */
const BROWN = ["#5a3a22", "#6b4423", "#4a2f1c", "#7a5230", "#3d2717"];
const BLUE = ["#4a6f94", "#5d84a8", "#3d5f80", "#6f93b0"];
const GREEN = ["#5b7a4a", "#6a8550", "#4f6b45", "#7a7f45"];
const PALE = ["#8f969a", "#a3a8aa", "#7f878c", "#9aa09c"];
const IRISES: Record<string, string[]> = {
  mixed: [...BROWN, ...BROWN, ...BLUE, ...GREEN, PALE[0]],
  brown: BROWN,
  blue: BLUE,
  green: GREEN,
  pale: PALE,
};
const IRIS_RGB: Record<string, Float32Array> = Object.fromEntries(
  Object.entries(IRISES).map(([key, hexes]) => {
    const out = new Float32Array(hexes.length * 3);
    hexes.forEach((hex, i) => {
      out.set(hexToUnitRgb(hex), i * 3);
    });
    return [key, out];
  }),
);

/** The key light and vignette, shared by the wall and the eyes, so the eyes sit in the same light. */
const LIGHT_GLSL = /* glsl */ `
uniform vec2 uResolution;
uniform vec2 uKey;
float keyLight(vec2 px) {
  vec2 q = (px - uKey) / uResolution.y;
  vec2 v = (px - 0.5 * uResolution) / uResolution.y;
  return 1.25 / (1.0 + 0.45 * dot(q, q)) * max(0.0, 1.0 - 0.3 * dot(v, v));
}
`;

/** The wall's patterns, baked once per size: mottle, grain (vertical, for bark) and soft folds. */
const BAKE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uInvHeight;
out vec4 outColor;
${VALUE_NOISE_GLSL}
${VALUE_FBM_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uInvHeight;
  float mottle = fbm(p * 3.5, 11.0);
  float grain = 0.65 * fbm(vec2(p.x * 16.0, p.y * 1.2), 23.0)
    + 0.35 * vnoise(vec2(p.x * 55.0, p.y * 3.0), 29.0);
  float ridge = 1.0 - abs(2.0 * fbm(p * 2.2 + 3.7, 37.0) - 1.0);
  outColor = vec4(mottle, grain, ridge, 1.0);
}
`;

/** The wall: one fetch of the baked patterns, coloured by the eased surface and lit. */
const SURFACE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSurface;
uniform vec3 uBase;
uniform vec3 uLight;
uniform vec3 uMix;
out vec4 outColor;
${LIGHT_GLSL}
${DITHER_GLSL}
void main() {
  vec3 s = texture(uSurface, vUv).rgb;
  float t = (smoothstep(0.25, 0.75, s.r) * uMix.x + smoothstep(0.2, 0.8, s.g) * uMix.y)
    / max(uMix.x + uMix.y, 1e-3);
  vec3 c = mix(uBase, uLight, t);
  c *= mix(1.0, 0.45 + 0.8 * smoothstep(0.4, 1.0, s.b), uMix.z);
  c *= keyLight(vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y));
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * One eye per instance, on a quad fitted to its socket. `vLocal` is in socket
 * radii from the centre, y up.
 */
const EYE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y and socket radius (device px, y down), and fade. */
layout(location = 1) in vec4 aEye;
/** Iris colour, and lid closure. */
layout(location = 2) in vec4 aIris;
/** Pupil offset (travel units, y down), pupil size (iris radii) and a 0..1 variant. */
layout(location = 3) in vec4 aGaze;
out vec2 vLocal;
flat out vec4 vIris;
flat out vec4 vGaze;
flat out float vAlpha;
flat out float vLight;
flat out float vStreak;
flat out vec2 vCatch;
${LIGHT_GLSL}
${TO_CLIP_GLSL}
void main() {
  float r = aEye.z;
  // A pixel more each way, so the socket's soft edge is never clipped.
  vec2 ext = vec2(r + 1.0, ${glslFloat(SOCKET_ASPECT)} * r + 1.0);
  vLocal = vec2(aCorner.x, -aCorner.y) * ext / r;
  vIris = aIris;
  vGaze = vec4(aGaze.x * ${glslFloat(IRIS_TRAVEL_X)}, -aGaze.y * ${glslFloat(IRIS_TRAVEL_Y)}, aGaze.zw);
  vAlpha = aEye.w;
  // A floor of light, so eyes in the dark corner still carry the image.
  vLight = 0.3 + 0.8 * keyLight(aEye.xy);
  // Streaks round the iris fade out where they would be finer than a few pixels.
  vStreak = smoothstep(2.0, 4.0, 6.2832 * ${glslFloat(IRIS_RADIUS)} * r / 47.0);
  // The catchlight sits towards the key light, fixed in the socket, not on the pupil.
  vec2 toKey = normalize(uKey - aEye.xy);
  vCatch = vec2(toKey.x, -toKey.y) * 0.2;
  gl_Position = pxToClip(aEye.xy + aCorner * ext, uResolution);
}
`;

const EYE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vIris;
flat in vec4 vGaze;
flat in float vAlpha;
flat in float vLight;
flat in float vStreak;
flat in vec2 vCatch;
uniform vec3 uLid;
out vec4 outColor;
const float AW = ${glslFloat(ALMOND_HALF_WIDTH)};
const float HU = ${glslFloat(ALMOND_UPPER)};
const float HL = ${glslFloat(ALMOND_LOWER)};
const float IRIS = ${glslFloat(IRIS_RADIUS)};
void main() {
  vec2 p = vLocal;
  float closure = vIris.a;
  float variant = vGaze.w;

  // The opening: an almond between two lid curves; the upper lid comes down to
  // meet the lower, which rises a little, as the eye closes.
  float xn = p.x / AW;
  float f = max(0.0, 1.0 - xn * xn);
  float lower = -HL * f * (1.0 - 0.3 * closure);
  float upper = mix(HU * pow(f, 0.75), lower, closure);
  float d = min(upper - p.y, p.y - lower);
  float open = smoothstep(0.0, 1.5 * fwidth(p.y), d);

  // Sclera: off-white, darker and faintly pink and veined towards the corners.
  float corner = smoothstep(0.45, 1.0, abs(xn));
  vec3 ball = vec3(0.8, 0.77, 0.72) * (1.0 - 0.45 * corner * corner);
  float vy = p.y * 30.0 + sin(p.x * 17.0 + variant * 40.0) * 1.8 + variant * 9.0;
  float veinW = fwidth(vy);
  float vein = (1.0 - smoothstep(0.0, 0.18 + veinW, abs(sin(vy)))) * (1.0 - smoothstep(0.3, 0.8, veinW));
  ball = mix(ball, vec3(0.72, 0.42, 0.4), corner * (0.25 + 0.35 * vein));

  // Iris: radial streaks fixed to the screen (never turning), a dark outer
  // ring and a lighter ring round the pupil.
  vec2 q = p - vGaze.xy;
  float rq = length(q) / IRIS;
  float ea = fwidth(rq);
  float ang = atan(q.y, abs(q.x) < 1e-5 ? 1e-5 : q.x);
  float streak = 0.55 * sin(ang * 47.0 + variant * 60.0) + 0.45 * sin(ang * 29.0 + rq * 4.0 + variant * 23.0);
  vec3 iris = vIris.rgb * (1.0 + 0.3 * streak * vStreak);
  iris *= mix(1.0, 0.35, smoothstep(0.72, 1.0, rq));
  iris *= 1.0 + 0.4 * (1.0 - smoothstep(vGaze.z, vGaze.z + 0.35, rq));
  ball = mix(ball, iris, 1.0 - smoothstep(1.0 - ea, 1.0 + ea, rq));
  ball = mix(ball, vec3(0.015), 1.0 - smoothstep(vGaze.z - ea, vGaze.z + ea, rq));
  // The upper lid's soft shadow over the top of the eye, then the light.
  ball *= mix(0.4, 1.0, smoothstep(0.0, 0.2, upper - p.y)) * vLight;
  vec2 k = p - vCatch;
  ball += 0.55 * vLight * exp(-dot(k, k) * 400.0);

  // Skin: the lids and socket, the surface's lid colour, a crease above the
  // eye, shadow round the opening, and the socket's rim sinking into the wall.
  float e = length(vec2(p.x, p.y / ${glslFloat(SOCKET_ASPECT)}));
  vec3 skin = uLid * vLight * (0.7 + 0.3 * smoothstep(1.0, 0.2, e) + 0.15 * (p.y - 0.5 * p.x));
  float crease = abs(p.y - (HU + 0.13) * pow(f, 0.6));
  skin *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 0.05, crease)) * f * smoothstep(-0.02, 0.05, p.y);
  float rim = max(-d, abs(p.x) - AW);
  skin *= mix(0.25, 1.0, smoothstep(0.0, 0.12, rim));
  skin *= mix(1.0, 0.5, smoothstep(0.55, 0.95, e));

  vec3 color = mix(skin, ball, open);
  float alpha = max(1.0 - smoothstep(0.6, 1.0, e), open) * vAlpha;
  outColor = vec4(color * alpha, alpha);
}
`;

/** Floats per eye instance: [cx, cy, r, alpha], [iris rgb, closure], [pupil x, y, size, variant]. */
const STRIDE = 12;

/**
 * A wall of eyes watching a slowly drifting point near the middle of the frame:
 * a baked, lit surface, then one instanced quad per eye shading sclera, iris,
 * lids and socket analytically.
 */
export const eyewall = defineEffect(eyewallMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const bakeProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BAKE_FRAGMENT);
      const bakeU = createUniforms(gl, bakeProgram, ["uInvHeight"]);
      const surfaceProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, SURFACE_FRAGMENT);
      const surfaceU = createUniforms(gl, surfaceProgram, [
        "uSurface",
        "uBase",
        "uLight",
        "uMix",
        "uResolution",
        "uKey",
      ]);
      const eyeProgram = scopedProgram(gl, scope, EYE_VERTEX, EYE_FRAGMENT);
      const eyeU = createUniforms(gl, eyeProgram, ["uResolution", "uKey", "uLid"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_EYES, [4, 4, 4], [QUAD]));
      if (batch.stride !== STRIDE) {
        throw new Error("Eye Wall: instance stride mismatch");
      }
      gl.useProgram(surfaceProgram);
      surfaceU.i1("uSurface", 0);

      let baked: RenderTarget | null = null;
      scope.defer(() => baked?.dispose());
      let bakedFresh = false;

      const surfaceTargets: Record<string, Float32Array> = {};
      for (const [key, s] of Object.entries(SURFACES)) {
        const t = new Float32Array(12);
        t.set(hexToUnitRgb(s.base), 0);
        t.set(hexToUnitRgb(s.light), 3);
        t.set(hexToUnitRgb(s.lid), 6);
        t.set(s.mix, 9);
        surfaceTargets[key] = t;
      }
      const surfaceEase = createColorEase(12);

      // Each eye's iris colour, easing from `irisFrom` to `irisTo` on a palette change.
      const irisFrom = new Float32Array(MAX_EYES * 3);
      const irisTo = new Float32Array(MAX_EYES * 3);
      const iris = new Float32Array(MAX_EYES * 3);
      let irisKey = "";
      let irisLayout = Number.NaN;
      let irisCount = -1;
      let irisT = 1;

      const wall = createWall(1);
      const wp: WallParams = {
        density: 0,
        clearing: 0,
        blink: 0,
        events: 0,
        seed: 1,
        halfWidth: 16 / 18,
      };

      let width = 1;
      let height = 1;

      /** Fills `irisTo` from the palette `key`, each eye's pick and a little shade of its own. */
      const fillIrisTargets = (key: string) => {
        const pal = IRIS_RGB[key] ?? IRIS_RGB.mixed;
        const n = pal.length / 3;
        const { layout } = wall;
        for (let i = 0; i < layout.count; i++) {
          const pick = layout.pick[i];
          const c = Math.min(n - 1, Math.floor(pick * n)) * 3;
          const shade = 0.85 + 0.3 * ((pick * 7.31) % 1);
          irisTo[i * 3] = pal[c] * shade;
          irisTo[i * 3 + 1] = pal[c + 1] * shade;
          irisTo[i * 3 + 2] = pal[c + 2] * shade;
        }
      };

      const stepIris = (key: string, dt: number) => {
        const { layout } = wall;
        if (layout.seed !== irisLayout || layout.count !== irisCount) {
          // A new layout's eyes are all shut and faded out: take the colours at once.
          irisLayout = layout.seed;
          irisCount = layout.count;
          irisKey = key;
          fillIrisTargets(key);
          iris.set(irisTo);
          irisT = 1;
          return;
        }
        if (key !== irisKey) {
          irisKey = key;
          irisFrom.set(iris);
          fillIrisTargets(key);
          irisT = 0;
        }
        if (irisT >= 1) {
          return;
        }
        irisT = Math.min(1, irisT + dt / IRIS_EASE);
        const f = smoothstep(0, 1, irisT);
        for (let i = 0; i < layout.count * 3; i++) {
          iris[i] = irisFrom[i] + (irisTo[i] - irisFrom[i]) * f;
        }
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          wp.halfWidth = width / height / 2;
          const bw = lowResSize(width, SURFACE_DIVISOR);
          const bh = lowResSize(height, SURFACE_DIVISOR);
          if (!baked || baked.width !== bw || baked.height !== bh) {
            baked?.dispose();
            baked = null;
            baked = createRenderTarget(gl, bw, bh, gl.RGBA8);
            if (!baked) {
              throw new Error("Eye Wall: RGBA8 target is not renderable");
            }
            bakedFresh = false;
          }
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          wp.density = p.density;
          wp.clearing = p.clearing;
          wp.blink = p.blink;
          wp.events = p.events;
          wp.seed = p.seed;
          stepWall(wall, step, wp);
          stepIris(p.iris, step);
          const surface = surfaceEase.step(
            surfaceTargets[p.surface] ?? surfaceTargets.shadow,
            step,
            SURFACE_EASE,
          );
          const keyX = 0.15 * width;
          const keyY = -0.35 * height;

          if (!baked) {
            return;
          }
          if (!bakedFresh) {
            bakedFresh = true;
            baked.bind();
            gl.disable(gl.BLEND);
            gl.useProgram(bakeProgram);
            bakeU.f1("uInvHeight", 1 / baked.height);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          gl.useProgram(surfaceProgram);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, baked.texture);
          surfaceU.f3("uBase", surface[0], surface[1], surface[2]);
          surfaceU.f3("uLight", surface[3], surface[4], surface[5]);
          surfaceU.f3("uMix", surface[9], surface[10], surface[11]);
          surfaceU.f2("uResolution", width, height);
          surfaceU.f2("uKey", keyX, keyY);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // The eyes, in their sockets.
          const { layout } = wall;
          const data = batch.data;
          const hw = wp.halfWidth;
          let n = 0;
          for (let i = 0; i < layout.count; i++) {
            const life = wall.life[i];
            const x = layout.x[i];
            const y = layout.y[i];
            const r = layout.r[i];
            if (life === 0 || !inFrame(x, y, r, hw)) {
              continue;
            }
            const o = n * STRIDE;
            data[o] = width * 0.5 + x * height;
            data[o + 1] = height * 0.5 + y * height;
            data[o + 2] = r * height;
            data[o + 3] = eyeAlpha(life);
            data[o + 4] = iris[i * 3];
            data[o + 5] = iris[i * 3 + 1];
            data[o + 6] = iris[i * 3 + 2];
            data[o + 7] = Math.max(eyeClosure(wall, i), 1 - eyeFadeOpen(life));
            data[o + 8] = wall.px[i];
            data[o + 9] = wall.py[i];
            data[o + 10] = eyePupil(wall, i);
            data[o + 11] = layout.variant[i];
            n++;
          }
          if (n === 0) {
            return;
          }
          batch.upload(n);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(eyeProgram);
          eyeU.f2("uResolution", width, height);
          eyeU.f2("uKey", keyX, keyY);
          eyeU.f3("uLid", surface[6], surface[7], surface[8]);
          batch.draw(0, n);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
