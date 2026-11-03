import {
  BOX_W,
  BOX_X,
  blindsLightBand,
  createShape,
  EDGE_X0,
  EDGE_XK,
  EDGE_Y0,
  EDGE_YK,
  FALLOFF,
  HALF_DUTY,
  layoutShape,
  sunColor,
  sunLevelAt,
} from "./blinds-sim";
import { type Rgb, unitRgbMemo } from "./color";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { approach, wrap } from "./math";
import { buildPeriodicNoiseTexture, createNoise, createRng } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { blindsMeta, MAX_MOTES } from "./blinds.meta";
import { defineEffect } from "./types";

/** Plaster noise texture: texels per side, lattice cells per side, and its tile size in reference px. */
const PLASTER_SIZE = 128;
const PLASTER_PERIOD = 8;
const PLASTER_TILE = 560;
/** Largest plaster modulation (fraction of the wall brightness) at plaster 1. */
const PLASTER_AMP = 0.08;
/** Ambient light on the wall: level, a slightly cool tint, and the falloff to the bottom. */
const AMBIENT = 0.55;
const AMBIENT_TINT: Rgb = [0.95, 0.98, 1.05];
const AMBIENT_BOTTOM = 0.8;
/** Sun brightness on the wall at a full stripe, before clouds. */
const SUN_GAIN = 0.62;
/** Sun-angle drift: amplitude in degrees, period in seconds, and seconds to ease it on or off. */
const DRIFT_DEG = 6;
const DRIFT_PERIOD = 300;
const DRIFT_EASE = 8;
/** Mote extent radius in reference px, drift speed in px/s, settling speed in px/s. */
const MOTE_RADIUS = 7;
const MOTE_PX = 4;
const MOTE_SETTLE = 1;
/** Mote brightness (additive, fraction of the light colour) at a full stripe. */
const MOTE_GAIN = 0.55;
/** Seconds a mote takes to fade in when the count rises. */
const FADE_IN = 1;
const TAU = Math.PI * 2;

/**
 * Wall and stripes in one analytic pass, with one plaster fetch. The band maths
 * matches `blindsLightBand` in blinds-sim.ts.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision mediump sampler2D;
in vec2 vUv;
uniform sampler2D uPlaster;
/** Reference-unit position (1080 tall, y down) = gl_FragCoord.xy * xy + zw. */
uniform vec4 uPix;
/** Band centre x, y, stripe slope (dy/dx), 1 / half-width. */
uniform vec4 uBand;
/** 1 / band height, slats, window side (+1 right, -1 left), plaster amplitude. */
uniform vec4 uStripe;
/** Penumbra in stripe periods at the window end, and its growth to the far end. */
uniform vec2 uPen;
/** Ambient-lit wall at the top and bottom of the frame. */
uniform vec3 uWallTop;
uniform vec3 uWallBottom;
/** Sun colour on the wall (albedo, light colour, cloud level and tint folded in). */
uniform vec3 uSun;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy * uPix.xy + uPix.zw;
  float dx = p.x - uBand.x;
  float xn = dx * uBand.w;
  float w = (p.y - uBand.y - uBand.z * dx) * uStripe.x;
  float t = clamp(0.5 - 0.5 * xn * uStripe.z, 0.0, 1.0);
  float pen = uPen.x + uPen.y * t;
  float g = abs(fract((w + 0.5) * uStripe.y) - 0.5);
  float s = 1.0 - smoothstep(${glslFloat(HALF_DUTY)} - 0.5 * pen, ${glslFloat(HALF_DUTY)} + 0.5 * pen, g);
  float ex = ${glslFloat(EDGE_X0)} + ${glslFloat(EDGE_XK)} * t;
  float ey = ${glslFloat(EDGE_Y0)} + ${glslFloat(EDGE_YK)} * t;
  float m = (1.0 - smoothstep(1.0 - ex, 1.0 + ex, abs(xn)))
    * (1.0 - smoothstep(0.5 - ey, 0.5 + ey, abs(w)));
  float light = s * m * (1.0 - ${glslFloat(FALLOFF)} * t);
  float plaster = 1.0 + (texture(uPlaster, p * ${glslFloat(1 / PLASTER_TILE)}).r - 0.5) * uStripe.w;
  vec3 wall = mix(uWallTop, uWallBottom, clamp(p.y * ${glslFloat(1 / 1080)}, 0.0, 1.0));
  vec3 c = (wall + uSun * light) * plaster;
  // Sub-LSB dither: the wall is a wide, shallow gradient.
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

const MOTE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, extent radius (device px, y down). */
layout(location = 1) in vec3 aMote;
/** Additive colour times brightness. */
layout(location = 2) in vec3 aColor;
uniform vec2 uResolution;
out vec2 vLocal;
flat out vec3 vColor;
${TO_CLIP_GLSL}
void main() {
  vLocal = aCorner;
  vColor = aColor;
  gl_Position = pxToClip(aMote.xy + aCorner * aMote.z, uResolution);
}
`;

const MOTE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in vec3 vColor;
out vec4 outColor;
void main() {
  float t = max(1.0 - dot(vLocal, vLocal), 0.0);
  float halo = t * t;
  float core = halo * halo;
  core *= core;
  outColor = vec4(vColor * (0.25 * halo + core), 0.0);
}
`;

/**
 * Late-afternoon sun through venetian blinds: soft slatted stripes on a plain
 * wall, dimmed now and then by a passing cloud, with a few dust motes glinting in
 * the lit stripes. One analytic full-screen pass plus up to 80 small sprites.
 */
export const blinds = defineEffect(blindsMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uPlaster",
        "uPix",
        "uBand",
        "uStripe",
        "uPen",
        "uWallTop",
        "uWallBottom",
        "uSun",
      ]);
      gl.useProgram(program);
      u.i1("uPlaster", 0);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const plasterTex = scope.add(
        createDataTexture(gl, {
          width: PLASTER_SIZE,
          height: PLASTER_SIZE,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(PLASTER_SIZE, [{ period: PLASTER_PERIOD, seed: 25 }]),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );

      const moteProgram = scope.add(createProgram(gl, MOTE_VERTEX, MOTE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const moteU = createUniforms(gl, moteProgram, ["uResolution"]);
      const motes = scope.own(
        createSpriteBatch(gl, MAX_MOTES, [3, 3], [polygonStrip(8, Math.PI / 8)]),
      );

      const wallRgb = unitRgbMemo();
      const lightRgb = unitRgbMemo();
      const noise = createNoise(25);
      const shape = createShape();
      const sunRgb: Rgb = [0, 0, 0];
      const wallSun: Rgb = [0, 0, 0];
      const moteRgb: Rgb = [0, 0, 0];

      // Motes live in band coordinates (xn across the footprint, w across the
      // stripes), so layout changes carry them along and they wrap where the
      // mask is zero.
      const rng = createRng(0x25b1d5);
      const mx = new Float32Array(MAX_MOTES);
      const mw = new Float32Array(MAX_MOTES);
      const heading = new Float32Array(MAX_MOTES);
      const sizeK = new Float32Array(MAX_MOTES);
      const seed = new Float32Array(MAX_MOTES);
      const life = new Float32Array(MAX_MOTES);
      for (let i = 0; i < MAX_MOTES; i++) {
        mx[i] = (rng() * 2 - 1) * BOX_X;
        mw[i] = (rng() * 2 - 1) * BOX_W;
        heading[i] = rng() * TAU;
        sizeK[i] = 0.6 + rng() * 0.8;
        seed[i] = rng() * 100;
      }
      let live = 0;

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      // CPU-only time, kept unwrapped in float64.
      let time = 0;
      let drift = 1;

      return {
        resize(v) {
          ({ width, height, scale } = v);
          refWidth = v.width / v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          time += dt;
          drift = approach(drift, p.sunDrift ? 1 : 0, dt / DRIFT_EASE);
          const angle = p.angle + drift * DRIFT_DEG * Math.sin((time * TAU) / DRIFT_PERIOD);
          layoutShape(shape, p.position, refWidth, angle, p.slats, p.softness);

          const level = sunLevelAt(noise, time, p.clouds);
          const light = lightRgb(p.lightColor);
          const wall = wallRgb(p.wallColor);
          sunColor(sunRgb, light, level, SUN_GAIN);
          for (let i = 0; i < 3; i++) wallSun[i] = wall[i] * sunRgb[i];

          gl.useProgram(program);
          const inv = 1 / scale;
          u.f4("uPix", inv, -inv, 0, height * inv);
          u.f4("uBand", shape.cx, shape.cy, shape.slope, 1 / shape.halfW);
          u.f4("uStripe", 1 / shape.bandH, shape.slats, shape.side, p.plaster * PLASTER_AMP);
          u.f2("uPen", shape.pen0, shape.penK);
          const a = AMBIENT;
          const b = AMBIENT * AMBIENT_BOTTOM;
          const t = AMBIENT_TINT;
          u.f3("uWallTop", wall[0] * a * t[0], wall[1] * a * t[1], wall[2] * a * t[2]);
          u.f3("uWallBottom", wall[0] * b * t[0], wall[1] * b * t[1], wall[2] * b * t[2]);
          u.v3("uSun", wallSun);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, plasterTex);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          // Dust: drift in band space, lit by the same stripe function as the wall.
          const target = Math.min(Math.max(0, Math.floor(p.dust)), MAX_MOTES);
          const n = (live = growLive(life, live, target));
          const inStep = dt / FADE_IN;
          const outStep = dt / FADE_OUT;
          sunColor(moteRgb, light, level, MOTE_GAIN);
          const invHalfW = 1 / shape.halfW;
          const invBandH = 1 / shape.bandH;
          const noiseT = time * 0.05;
          const data = motes.data;
          const stride = motes.stride;
          let visible = 0;
          for (let i = 0; i < n; i++) {
            heading[i] += noise.noise2(noiseT, seed[i]) * 0.5 * dt;
            const sp = MOTE_PX * sizeK[i];
            const vx = Math.cos(heading[i]) * sp;
            const vy = Math.sin(heading[i]) * sp + MOTE_SETTLE;
            const xn = wrap(mx[i] + vx * invHalfW * dt, -BOX_X, 2 * BOX_X);
            const w = wrap(mw[i] + (vy - shape.slope * vx) * invBandH * dt, -BOX_W, 2 * BOX_W);
            mx[i] = xn;
            mw[i] = w;
            const l = stepLife(life, i, target, inStep, outStep);
            // A gentle glint as each mote tumbles.
            const glint = 0.7 + 0.3 * Math.sin(time * 1.1 + seed[i]);
            const k = blindsLightBand(xn, w, shape) * glint * l * l;
            if (k <= 0.004) continue;
            const x = shape.cx + xn * shape.halfW;
            const y = shape.cy + w * shape.bandH + shape.slope * (x - shape.cx);
            const o = visible * stride;
            data[o] = x * scale;
            data[o + 1] = y * scale;
            data[o + 2] = MOTE_RADIUS * sizeK[i] * scale + 1;
            data[o + 3] = moteRgb[0] * k;
            data[o + 4] = moteRgb[1] * k;
            data[o + 5] = moteRgb[2] * k;
            visible++;
          }
          live = trimLive(life, live, target);

          if (visible > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            motes.upload(visible);
            gl.useProgram(moteProgram);
            moteU.f2("uResolution", width, height);
            motes.draw(0, visible);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
