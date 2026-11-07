import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import {
  CONE_CORE,
  CONE_TAN,
  createDrips,
  createLampGeometry,
  createRain,
  createSplashes,
  DRIP_COUNT,
  FALLING,
  FASCIA_TOP,
  GUTTER_BOTTOM,
  GUTTER_TOP,
  lampGeometry,
  lampLight,
  LAWN_Y,
  LIGHT_R,
  MAX_RAIN,
  MAX_SPLASHES,
  RAIN_MARGIN,
  RAIN_SLANT,
  rainFloor,
  REF_HEIGHT,
  SPLASH_DROPS,
  SPLASH_LIFE,
  splashDroplet,
  stepDrips,
  stepRain,
  stepSplashes,
  STEP_Y,
} from "./porch-sim";
import { type LampSide, porchMeta } from "./porch.meta";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { createStreakRenderer, STREAK_FLOATS } from "../streaks";
import { defineEffect } from "../types";

/** Garden pass: about 3 reference px per texel (divisor 6 at 4K). It is all soft and dark. */
const GARDEN_TEXEL_REF = 3;

/** Rain streak length (reference px) for the farthest and the nearest drops. */
const RAIN_LEN = [20, 46] as const;
/** Rain brightness outside the cone (almost nothing) and inside it, per unit of light. */
const RAIN_AMBIENT = 0.012;
const RAIN_GAIN = 0.85;
/** Far drops fade out over this many reference px above their floor. */
const RAIN_FADE = 90;

/** Drip radius (reference px) as it starts to swell, and when it lets go. */
const DRIP_R = [1.4, 4.6] as const;
/** Falling drips stretch by this many px per px/s of speed (motion blur). */
const DRIP_STRETCH = 0.012;
const DRIP_AMBIENT = 0.05;
const DRIP_GAIN = 1.6;
/** Splash ring: largest radius (reference px), flattening, brightness. */
const SPLASH_R = 26;
const SPLASH_FLAT = 0.28;
const SPLASH_GAIN = 0.9;
const DROPLET_R = 1.8;

/** Lamp glow octagon radius (reference px) and brightness. */
const GLOW_R = 230;
const GLOW_GAIN = 1;

/** Sprite kinds (the colour's alpha). */
const KIND_BLOB = 0;
const KIND_RING = 1;
const KIND_GLOW = 2;
const MAX_SPRITES = DRIP_COUNT + MAX_SPLASHES * (1 + SPLASH_DROPS) + 1;

const vec3 = (c: readonly number[]) => `vec3(${c.map((v) => glslFloat(v)).join(", ")})`;

/** The light cone and falloff; mirrors `coneMask` / `lampLight` in porch-sim.ts. */
const LIGHT_GLSL = /* glsl */ `
/** Lamp x, y (reference px, y down) and unit cone axis. */
uniform vec4 uLamp;
float coneMask(vec2 p) {
  vec2 d = p - uLamp.xy;
  float along = dot(d, uLamp.zw);
  float perp = abs(d.x * uLamp.w - d.y * uLamp.z);
  float r = perp / max(along * ${glslFloat(CONE_TAN)}, 1e-3);
  return along < 0.0 ? 0.0 : 1.0 - smoothstep(${glslFloat(CONE_CORE)}, 1.0, r);
}
float lampLight(vec2 p) {
  vec2 d = p - uLamp.xy;
  return coneMask(p) / (1.0 + dot(d, d) * ${glslFloat(1 / (LIGHT_R * LIGHT_R))});
}
`;

const SKY_TOP = [0.008, 0.011, 0.022];
const SKY_LOW = [0.026, 0.032, 0.05];
const HEDGE = [0.016, 0.026, 0.022];
const FENCE = [0.085, 0.072, 0.06];
const SHRUB = [0.026, 0.05, 0.03];
const LAWN = [0.022, 0.034, 0.024];
const STEP = [0.05, 0.045, 0.042];

/**
 * The garden at low resolution, y down in reference px: night sky, a far hedge,
 * a picket fence, lumpy shrubs in front of it, a lawn, and the wet step with the
 * lamp's reflection. Everything is lit by the cone, plus a faint scatter in the
 * rainy air so the cone itself shows.
 */
const GARDEN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> reference px. */
uniform vec2 uPxToRef;
uniform vec3 uLampColor;
/** Seeded phases for the hedge and shrub outlines, and the picket offset. */
uniform vec4 uShape;
/** Edge softness, reference px (about a texel). */
uniform float uSoft;
out vec4 outColor;
${LIGHT_GLSL}
float cover(float d) {
  return clamp(d / uSoft + 0.5, 0.0, 1.0);
}
void main() {
  vec2 p = vec2(gl_FragCoord.x * uPxToRef.x, ${glslFloat(REF_HEIGHT)} - gl_FragCoord.y * uPxToRef.y);
  float x = p.x;
  float light = lampLight(p);
  vec3 lit = 1.0 + uLampColor * light * 7.0;

  vec3 col = mix(${vec3(SKY_TOP)}, ${vec3(SKY_LOW)}, smoothstep(80.0, 620.0, p.y));

  float hedgeTop = 450.0 + 26.0 * sin(x * 0.0041 + uShape.x) + 14.0 * sin(x * 0.0127 + uShape.y)
    + 5.0 * sin(x * 0.037 + uShape.z);
  col = mix(col, ${vec3(HEDGE)} * (1.0 + uLampColor * light * 3.0), cover(p.y - hedgeTop));

  // Pickets with pointed tops, and two rails.
  float pk = abs(fract(x * ${glslFloat(1 / 46)} + uShape.w) - 0.5) * 46.0;
  float picket = cover(13.0 - pk) * cover(p.y - 590.0 - pk * 0.9);
  float rails = max(cover(6.0 - abs(p.y - 632.0)), cover(6.0 - abs(p.y - 742.0)));
  float fence = max(picket, rails) * cover(${glslFloat(LAWN_Y)} - p.y);
  col = mix(col, ${vec3(FENCE)} * lit * (0.85 + 0.15 * cover(p.y - 640.0)), fence);

  float h = 60.0 * sin(x * 0.0058 + uShape.y * 1.7) + 38.0 * sin(x * 0.0149 + uShape.x * 2.3)
    + 14.0 * sin(x * 0.043 + uShape.z) + 4.0 * sin(x * 0.12 + uShape.w * 6.0);
  float shrubTop = 735.0 - max(h + 34.0, 0.0);
  // Leaves near the top of a mound catch more of the light.
  float rim = 0.55 + 0.45 * smoothstep(90.0, 0.0, p.y - shrubTop);
  col = mix(col, ${vec3(SHRUB)} * (1.0 + uLampColor * light * 6.0 * rim), cover(p.y - shrubTop));

  col = mix(col, ${vec3(LAWN)} * lit, cover(p.y - ${glslFloat(LAWN_Y)}));

  // Light scattered by the rain in the air shows the cone itself.
  col += uLampColor * light * 0.09;

  // The wet step: lit by the cone, a soft streak reflecting the lamp, and a
  // fainter mirror of the lit air above.
  float below = p.y - ${glslFloat(STEP_Y)};
  float dx = x - uLamp.x;
  float w = 16.0 + 0.45 * max(below, 0.0);
  float refl = exp2(-dx * dx / (w * w)) * (0.25 + 0.75 * exp2(-max(below, 0.0) / 110.0));
  float mirror = lampLight(vec2(x, 2.0 * ${glslFloat(STEP_Y)} - p.y));
  float lip = exp2(-below * below / 10.0);
  vec3 stepCol = ${vec3(STEP)} * (1.0 + uLampColor * light * 5.0)
    + uLampColor * (0.32 * refl + 0.05 * mirror + 0.25 * lip * light);
  col = mix(col, stepCol, cover(below));

  outColor = vec4(col, 1.0);
}
`;

const SOFFIT = [0.07, 0.052, 0.04];
const FASCIA = [0.11, 0.1, 0.092];
const GUTTER = [0.12, 0.12, 0.125];

/**
 * The porch roof across the top, at full resolution: soffit boards, the fascia
 * and the round gutter, warmly lit near the lamp. Drawn scissored to the band;
 * the gutter's bottom edge is anti-aliased with alpha.
 */
const ROOF_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform float uScale;
uniform float uHeight;
uniform vec3 uLampColor;
uniform vec4 uLamp;
out vec4 outColor;
float edge(float d) {
  return clamp(d * uScale + 0.5, 0.0, 1.0);
}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) / uScale;
  vec2 d = p - uLamp.xy;
  vec3 lit = 0.55 + uLampColor * (2.4 / (1.0 + dot(d, d) * ${glslFloat(1 / (260 * 260))}));

  float board = fract(p.y * ${glslFloat(1 / 15)});
  float groove = smoothstep(0.0, 0.12, board) * smoothstep(1.0, 0.88, board);
  vec3 col = ${vec3(SOFFIT)} * (0.55 + 0.45 * p.y * ${glslFloat(1 / FASCIA_TOP)}) * (0.75 + 0.25 * groove);
  col = mix(col, ${vec3(FASCIA)}, edge(p.y - ${glslFloat(FASCIA_TOP)}));

  float n = clamp((p.y - ${glslFloat(GUTTER_TOP)}) * ${glslFloat(1 / (GUTTER_BOTTOM - GUTTER_TOP))}, 0.0, 1.0);
  float curve = sin(n * 3.14159);
  float hi = (n - 0.7) * 8.0;
  vec3 gutter = ${vec3(GUTTER)} * (0.45 + 0.55 * curve) + 0.25 * exp2(-hi * hi);
  col = mix(col, gutter, edge(p.y - ${glslFloat(GUTTER_TOP)}));

  outColor = vec4(col * lit, edge(${glslFloat(GUTTER_BOTTOM)} - p.y));
}
`;

/** Additive sprites in device px, y down: drips and droplets, splash rings, the lamp glow. */
const SPRITE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, y (device px, y down) and radii. */
layout(location = 1) in vec4 aSprite;
/** Colour times brightness, kind. */
layout(location = 2) in vec4 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec4 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(aSprite.xy + aCorner * aSprite.zw, uResolution);
}
`;

const SPRITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal);
  float b = max(0.0, 1.0 - d2);
  float shape;
  if (vColor.a < 0.5) {
    shape = b * b;
  } else if (vColor.a < 1.5) {
    shape = max(0.0, 1.0 - abs(sqrt(d2) - 0.75) * 5.0);
  } else {
    float b2 = b * b;
    shape = 0.35 * b2 * b2 + 1.4 * exp2(-d2 * 300.0);
  }
  outColor = vec4(vColor.rgb * shape, 0.0);
}
`;

/**
 * Rain at night from under a porch: a lamp in a top corner throws a soft cone
 * through the rain, which only shows inside it; drips swell on the gutter,
 * fall and splash on the wet step; the garden beyond is dark silhouettes.
 */
export const porch = defineEffect(porchMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) =>
        scope.add(createProgram(gl, vs, fs), (p) => {
          gl.deleteProgram(p);
        });

      const gardenProgram = program(FULLSCREEN_VERTEX, GARDEN_FRAGMENT);
      const gu = createUniforms(gl, gardenProgram, [
        "uPxToRef",
        "uLampColor",
        "uShape",
        "uSoft",
        "uLamp",
      ]);
      const roofProgram = program(FULLSCREEN_VERTEX, ROOF_FRAGMENT);
      const ru = createUniforms(gl, roofProgram, ["uScale", "uHeight", "uLampColor", "uLamp"]);
      const spriteProgram = program(SPRITE_VERTEX, SPRITE_FRAGMENT);
      const su = createUniforms(gl, spriteProgram, ["uResolution"]);
      const sprites = scope.own(
        createSpriteBatch(gl, MAX_SPRITES, [4, 4], [polygonStrip(8, Math.PI / 8)]),
      );
      const streaks = scope.own(createStreakRenderer(gl, MAX_RAIN));

      const lampRgb = unitRgbMemo();
      const lamp = createLampGeometry();
      const droplet = new Float64Array(2);
      let rain = createRain(0, MAX_RAIN);
      let drips = createDrips(0);
      const splashes = createSplashes();
      let simSeed = 0;

      let width = 1;
      let height = 1;
      let scale = 1;
      let builtSide = "";
      let builtWidth = -1;
      let shapeSeed = -1;

      const d = sprites.data;
      /** Sprites written this frame. */
      let m = 0;
      /** Writes one sprite; position and radii in reference px. */
      const put = (
        x: number,
        y: number,
        rx: number,
        ry: number,
        r: number,
        g: number,
        b: number,
        kind: number,
      ) => {
        const o = m * 8;
        d[o] = x * scale;
        d[o + 1] = y * scale;
        d[o + 2] = rx * scale + 0.5;
        d[o + 3] = ry * scale + 0.5;
        d[o + 4] = r;
        d[o + 5] = g;
        d[o + 6] = b;
        d[o + 7] = kind;
        m++;
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          target.resize(width, height, Math.max(1, GARDEN_TEXEL_REF * scale));
          gl.useProgram(gardenProgram);
          gu.f2(
            "uPxToRef",
            target.fullWidth / target.width / scale,
            target.fullHeight / target.height / scale,
          );
          gu.f1("uSoft", Math.max(1.5, (target.fullHeight / target.height / scale) * 1.2));
          gl.useProgram(roofProgram);
          ru.f1("uScale", scale);
          ru.f1("uHeight", height);
          gl.useProgram(spriteProgram);
          su.f2("uResolution", width, height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const refWidth = width / scale;
          const seed = Math.floor(p.seed);
          const side: LampSide = p.lamp === "right" ? "right" : "left";
          const rgb = lampRgb(p.lampColor);
          const rainAmount = clamp(p.rain, 0, 1);
          const wind = clamp(p.wind, -1, 1);

          if (seed !== simSeed) {
            rain = createRain(seed, MAX_RAIN);
            drips = createDrips(seed);
            simSeed = seed;
          }
          if (side !== builtSide || refWidth !== builtWidth) {
            lampGeometry(lamp, side, refWidth);
            builtSide = side;
            builtWidth = refWidth;
          }

          // 1. The garden at low resolution, upscaled with dither.
          target.bind();
          gl.useProgram(gardenProgram);
          if (seed !== shapeSeed) {
            const rng = createRng(hash32(seed + 0x9a7d));
            const tau = Math.PI * 2;
            gu.f4("uShape", rng() * tau, rng() * tau, rng() * tau, rng());
            shapeSeed = seed;
          }
          gu.rgb("uLampColor", p.lampColor);
          gu.f4("uLamp", lamp.x, lamp.y, lamp.ax, lamp.ay);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // 2. Rain: thin additive streaks, bright only where the cone lights them.
          const span = refWidth + 2 * RAIN_MARGIN;
          stepRain(rain, MAX_RAIN, dt, wind, span);
          const wanted = rainAmount * MAX_RAIN;
          const shown = Math.min(MAX_RAIN, Math.ceil(wanted));
          const slant = wind * RAIN_SLANT;
          const norm = 1 / Math.sqrt(1 + slant * slant);
          const sd = streaks.data;
          let n = 0;
          for (let i = 0; i < shown; i++) {
            const depth = rain.depth[i];
            const x = rain.u[i] * span - RAIN_MARGIN;
            const y = rain.y[i];
            const len = RAIN_LEN[0] + (RAIN_LEN[1] - RAIN_LEN[0]) * depth;
            const tx = x - slant * len * norm;
            const ty = y - len * norm;
            const light = lampLight(lamp, x, y - len * 0.5);
            const fade = smoothstep(rainFloor(depth), rainFloor(depth) - RAIN_FADE, y);
            const part = i === shown - 1 ? wanted - i : 1;
            const k =
              (RAIN_AMBIENT + RAIN_GAIN * Math.min(light, 1.2)) *
              rain.glint[i] *
              (0.4 + 0.6 * depth) *
              fade *
              part;
            if (k < 0.002) {
              continue;
            }
            const o = n * STREAK_FLOATS;
            sd[o] = tx * scale;
            sd[o + 1] = ty * scale;
            sd[o + 2] = x * scale;
            sd[o + 3] = y * scale;
            sd[o + 4] = rgb[0] * k;
            sd[o + 5] = rgb[1] * k;
            sd[o + 6] = rgb[2] * k;
            sd[o + 7] = (0.45 + 0.45 * depth) * scale;
            n++;
          }
          if (n > 0) {
            streaks.upload(n);
            streaks.draw(n, width, height);
          }

          // 3. The roof edge across the top, at full resolution, over the rain's start.
          const band = Math.min(height, Math.ceil((GUTTER_BOTTOM + 1) * scale));
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(0, height - band, width, band);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(roofProgram);
          ru.rgb("uLampColor", p.lampColor);
          ru.f4("uLamp", lamp.x, lamp.y, lamp.ax, lamp.ay);
          triangle.draw();
          gl.disable(gl.SCISSOR_TEST);

          // 4. Drips, splashes and the lamp's glow: additive sprites.
          if (p.drips) {
            stepDrips(drips, splashes, dt, 0.5 + rainAmount);
          }
          stepSplashes(splashes, Math.min(dt, 1));
          m = 0;
          // Water catches the lamp's colour, lifted a little towards white.
          const wr = 0.75 * rgb[0] + 0.25;
          const wg = 0.75 * rgb[1] + 0.25;
          const wb = 0.75 * rgb[2] + 0.25;
          if (p.drips) {
            for (let i = 0; i < drips.count; i++) {
              const x = drips.u[i] * refWidth;
              let y: number;
              let rx: number;
              let ry: number;
              if (drips.phase[i] === FALLING) {
                rx = DRIP_R[1] * 0.8;
                ry = DRIP_R[1] + drips.vy[i] * DRIP_STRETCH;
                y = drips.y[i] + ry * 0.5;
              } else {
                const t = drips.t[i] / drips.grow[i];
                rx = DRIP_R[0] + (DRIP_R[1] - DRIP_R[0]) * t;
                ry = rx * (1 + 0.35 * t);
                y = GUTTER_BOTTOM + ry * 0.6;
              }
              const k = (DRIP_AMBIENT + DRIP_GAIN * lampLight(lamp, x, y)) * (DRIP_R[1] / ry);
              put(x, y, rx, ry, wr * k, wg * k, wb * k, KIND_BLOB);
            }
          }
          if (p.splashes) {
            for (let i = 0; i < splashes.max; i++) {
              const age = splashes.age[i];
              if (age >= SPLASH_LIFE) {
                continue;
              }
              const x = splashes.u[i] * refWidth;
              const y = splashes.y[i];
              const t = age / SPLASH_LIFE;
              const light = DRIP_AMBIENT + DRIP_GAIN * lampLight(lamp, x, y);
              const rr = 3 + SPLASH_R * Math.sqrt(t);
              const kr = SPLASH_GAIN * light * (1 - t) * (1 - t);
              put(x, y, rr, rr * SPLASH_FLAT, wr * kr, wg * kr, wb * kr, KIND_RING);
              const kd = light * (1 - t);
              for (let j = 0; j < SPLASH_DROPS; j++) {
                if (!splashDroplet(droplet, splashes.seed[i], j, age)) {
                  continue;
                }
                put(
                  x + droplet[0],
                  y + droplet[1],
                  DROPLET_R,
                  DROPLET_R,
                  wr * kd,
                  wg * kd,
                  wb * kd,
                  KIND_BLOB,
                );
              }
            }
          }
          put(
            lamp.x,
            lamp.y,
            GLOW_R,
            GLOW_R,
            rgb[0] * GLOW_GAIN,
            rgb[1] * GLOW_GAIN,
            rgb[2] * GLOW_GAIN,
            KIND_GLOW,
          );
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(spriteProgram);
          sprites.upload(m);
          sprites.draw(0, m);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
