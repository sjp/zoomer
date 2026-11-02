import {
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
  resetUnpackState,
} from "./gl";
import {
  buildHearthProfile,
  buildNoiseTexture,
  buildRamp,
  createEmberState,
  emberAlpha,
  type EmberEnv,
  FIRE_U,
  FIRE_V_MAX,
  FIRE_V_MIN,
  type FireLayout,
  fireLayout,
  getPalette,
  hearthMaxHeight,
  NOISE_PERIOD,
  NOISE_SIZE,
  PALETTE_OPTIONS,
  RAMP_SIZE,
  stepEmbers,
} from "./fireplace-model";
import { createLowResTarget, QUALITY_OPTIONS, qualityDivisor } from "./lowres";
import { createNoise, createRng } from "./noise";
import { createSpriteBatch, resetState, unitRgbMemo } from "./sprites";
import { defineEffect } from "./types";

/** Low-res divisors: fire is soft, so even "high" renders below full resolution. */
const DIVISORS = { high: 1.5, balanced: 2, low: 3 } as const;
const MAX_EMBERS = 240;
/** Embers per second at an embers setting of 1. */
const EMBER_RATE = 30;
/** Flame and ember rise speed in reference px/s at a speed of 1. */
const RISE_PX = 160;
/** Noise lattice cells per unit of flame u (half-width) and v (height). */
const CELLS_U = 4;
const CELLS_V = 1.8;
/** Hearth profile columns across the frame. */
const PROFILE_COLUMNS = 512;
/** Width of the fire-lit rim on the logs' top edges, in reference px. */
const RIM_PX = 6;

/** Domain-warp lookup, then three fBm octaves: noise-uv scale and per-second drift. */
const OCTAVES = [
  { scale: 0.5, drift: 0.013, rise: 0.6 },
  { scale: 1, drift: 0.004, rise: 1 },
  { scale: 2.03, drift: -0.01, rise: 1.35 },
  { scale: 4.11, drift: 0.02, rise: 1.8 },
] as const;

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/**
 * Flame field over the fire rectangle only (the low-res target is sized to it):
 * heat = taper(v, u) + fBm(warped, scrolling), mapped through the palette ramp to
 * premultiplied colour. 5 texture fetches per low-res pixel.
 */
const FLAME_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uNoise;
uniform sampler2D uRamp;
/** Low-res pixel -> flame space (u across the half-width, v up the height). */
uniform vec2 uPxScale;
uniform vec2 uPxOffset;
/** Flame space -> noise texture uv. */
uniform vec2 uNoiseScale;
/** Per-octave scroll offsets in noise uv, wrapped to [0, 1) on the CPU. */
uniform vec2 uOff[4];
uniform float uGain;
out vec4 outColor;

void main() {
  vec2 q = gl_FragCoord.xy * uPxScale + uPxOffset;
  float v = q.y;
  float vc = clamp(v, 0.0, ${f(FIRE_V_MAX)});
  // Sideways lick: warp u with a slow noise, more strongly higher up.
  float w = texture(uNoise, q * uNoiseScale * ${f(OCTAVES[0].scale)} + uOff[0]).g - 0.5;
  float u = q.x + w * (0.1 + 0.45 * vc);
  vec2 n = vec2(u, v) * uNoiseScale;
  float fb = texture(uNoise, n + uOff[1]).r * 0.5714
    + texture(uNoise, n * ${f(OCTAVES[2].scale)} + uOff[2]).r * 0.2857
    + texture(uNoise, n * ${f(OCTAVES[3].scale)} + uOff[3]).r * 0.1429;
  // Taller in the middle, short at the sides.
  float env = 1.0 - u * u;
  float ec = clamp(env, 0.0, 1.0);
  float vv = v / (0.2 + 0.8 * ec * ec);
  float heat = (1.0 - vv) * 1.1 + (fb - 0.5) * (1.6 + 3.0 * clamp(vv, 0.0, 1.0)) - 0.05;
  heat *= smoothstep(${f(FIRE_V_MIN)}, 0.05, v) * smoothstep(0.0, 0.35, env) * (1.0 - smoothstep(1.05, ${f(FIRE_V_MAX)}, v));
  // Keep warped licks inside the rectangle so nothing is clipped at its sides.
  heat *= 1.0 - smoothstep(${f(FIRE_U - 0.125)}, ${f(FIRE_U)}, abs(q.x));
  heat = clamp(heat * uGain, 0.0, 1.0);
  outColor = texture(uRamp, vec2(heat * ${f((RAMP_SIZE - 1) / RAMP_SIZE)} + ${f(0.5 / RAMP_SIZE)}, 0.5));
}
`;

/**
 * Full-res composite (the low-res target's blit with a custom body): background
 * plus analytic glow, the upscaled flames over it (premultiplied), and the hearth
 * silhouette from a 1D column-height table with a fire-lit rim.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D uProfile;
uniform vec3 uBg;
/** Glow colour times strength times flicker. */
uniform vec3 uGlow;
uniform vec2 uGlowCenter;
uniform vec2 uGlowInvRadius;
/** Fire rectangle origin and 1 / size, device px. */
uniform vec2 uFireOrigin;
uniform vec2 uFireInvSize;
/** Device px per reference px. */
uniform float uScale;
/** Silhouette's highest point in reference px; negative when logs are off. */
uniform float uProfileMax;
uniform vec3 uLog;
uniform float uRimInv;

vec4 composite(vec2 uv) {
  vec2 px = gl_FragCoord.xy;
  vec2 g = (px - uGlowCenter) * uGlowInvRadius;
  float glow = 1.0 / (1.0 + dot(g, g));
  vec3 col = uBg + uGlow * glow;
  vec2 fu = (px - uFireOrigin) * uFireInvSize;
  if (fu.x >= 0.0 && fu.y >= 0.0 && fu.x <= 1.0 && fu.y <= 1.0) {
    vec4 fl = texture(uLowRes, fu);
    col = col * (1.0 - fl.a) + fl.rgb;
  }
  float yRef = px.y / uScale;
  if (yRef < uProfileMax) {
    float top = texture(uProfile, vec2(uv.x, 0.5)).r;
    float depth = (top - yRef) * uScale;
    float cover = clamp(depth + 0.5, 0.0, 1.0);
    vec3 logc = uLog + uGlow * (glow * 2.0 * exp2(-max(depth, 0.0) * uRimInv));
    col = mix(col, logc, cover);
  }
  return vec4(col, 1.0);
}
`;

/** Embers: per instance centre (device px, y up), half-size and opacity. */
const EMBER_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aEmber;
uniform vec2 uInvResolution;
out vec2 vLocal;
flat out float vAlpha;
void main() {
  vLocal = aCorner;
  vAlpha = aEmber.w;
  vec2 px = aEmber.xy + aCorner * aEmber.z;
  gl_Position = vec4(px * uInvResolution * 2.0 - 1.0, 0.0, 1.0);
}
`;

/** A hot core with a soft halo, added to the frame. */
const EMBER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d2 = dot(vLocal, vLocal) * 9.0;
  float a = (exp2(-d2 * 2.5) + 0.25 * exp2(-d2 * 0.5)) * max(0.0, 1.0 - d2 / 9.0) * vAlpha;
  vec3 c = mix(uColor, vec3(1.0), 0.5 * exp2(-d2 * 4.0));
  outColor = vec4(c * a, 0.0);
}
`;

/** Ember sprite half-size per unit of ember size, in reference px (the halo is 3 radii). */
const EMBER_HALF = 2.2 * 3;

/**
 * A cosy fire: procedural flames (warped, scrolling fBm through a palette ramp)
 * rendered at reduced resolution over just the fire's rectangle, a flickering
 * analytic glow, rising embers and a dark log-and-hearth silhouette.
 */
export const fireplace = defineEffect({
  id: "fireplace",
  name: "Fireplace",
  description: "A cosy fire with flickering flames, rising embers and a warm glow.",
  params: {
    height: {
      kind: "number",
      label: "Flame height",
      min: 0.15,
      max: 0.75,
      step: 0.01,
      default: 0.42,
    },
    intensity: { kind: "number", label: "Intensity", min: 0.3, max: 1.6, step: 0.01, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "wood" },
    embers: {
      kind: "number",
      label: "Embers (0 = off)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.35,
    },
    glow: { kind: "number", label: "Glow", min: 0, max: 1.5, step: 0.01, default: 0.7 },
    logs: { kind: "boolean", label: "Logs and hearth", default: true },
    background: { kind: "color", label: "Background", default: "#0a0604" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    const triangle = createFullscreenTriangle(gl);
    const target = createLowResTarget(gl, { composite: COMPOSITE });

    // The flame shader ignores vUv; an unused vertex output is fine in GLSL ES 3.00.
    const flameProgram = createProgram(gl, FULLSCREEN_VERTEX, FLAME_FRAGMENT);
    const fl = getUniforms(gl, flameProgram, [
      "uNoise",
      "uRamp",
      "uPxScale",
      "uPxOffset",
      "uNoiseScale",
      "uOff",
      "uGain",
    ]);
    gl.useProgram(flameProgram);
    gl.uniform1i(fl.uNoise, 0);
    gl.uniform1i(fl.uRamp, 1);
    gl.uniform2f(fl.uNoiseScale, CELLS_U / NOISE_PERIOD, CELLS_V / NOISE_PERIOD);

    const co = getUniforms(gl, target.program, [
      "uProfile",
      "uBg",
      "uGlow",
      "uGlowCenter",
      "uGlowInvRadius",
      "uFireOrigin",
      "uFireInvSize",
      "uScale",
      "uProfileMax",
      "uLog",
      "uRimInv",
    ]);
    gl.useProgram(target.program);
    gl.uniform1i(co.uProfile, 1);

    const emberProgram = createProgram(gl, EMBER_VERTEX, EMBER_FRAGMENT);
    const em = getUniforms(gl, emberProgram, ["uInvResolution", "uColor"]);
    const batch = createSpriteBatch(gl, MAX_EMBERS, [4]);

    const noiseTex = createDataTexture(gl, {
      width: NOISE_SIZE,
      height: NOISE_SIZE,
      internalFormat: gl.RG8,
      format: gl.RG,
      type: gl.UNSIGNED_BYTE,
      data: buildNoiseTexture(),
      wrap: gl.REPEAT,
    });
    const rampData = new Uint8Array(RAMP_SIZE * 4);
    const rampTex = createDataTexture(gl, {
      width: RAMP_SIZE,
      height: 1,
      internalFormat: gl.RGBA8,
      format: gl.RGBA,
      type: gl.UNSIGNED_BYTE,
      data: rampData,
    });
    const profileData = new Float32Array(PROFILE_COLUMNS);
    const profileTex = createDataTexture(gl, {
      width: PROFILE_COLUMNS,
      height: 1,
      // R16F is filterable in core WebGL2 and accepts FLOAT data.
      internalFormat: gl.R16F,
      format: gl.RED,
      type: gl.FLOAT,
      data: profileData,
    });

    const bgColor = unitRgbMemo();
    const flickerNoise = createNoise(0xf1a3);
    const rng = createRng(0xe4b3);
    const embers = createEmberState(MAX_EMBERS);
    const curl = (x: number, y: number, t: number) =>
      flickerNoise.noise3(x * 0.006, y * 0.006, t * 0.25);
    const offsets = new Float32Array(OCTAVES.length * 2);

    let width = 1;
    let height = 1;
    let scale = 1;
    let refWidth = 1920;
    let time = 0;
    let layout: FireLayout = fireLayout(refWidth, 0.42);
    const env: EmberEnv = { rate: 0, layout, rise: RISE_PX * 0.9, time: 0, top: 1080 };

    /** Inputs the static uniforms and textures were last built from. */
    const built = { width: 0, height: 0, flame: Number.NaN, quality: "", palette: "", logs: false };
    let paletteId = "";
    let glowRgb: readonly number[] = [0, 0, 0];
    let emberRgb: readonly number[] = [0, 0, 0];
    let lastBg: unknown = null;

    /** Recomputes the fire rectangle, low-res target and layout-dependent uniforms. */
    const rebuildLayout = (flameHeight: number, quality: string, logs: boolean) => {
      layout = fireLayout(refWidth, flameHeight);
      env.layout = layout;
      const d = qualityDivisor(quality, DIVISORS);
      // Fire rectangle in device px (y up), clamped to the canvas.
      const x0 = Math.max(0, Math.floor((layout.cx - layout.halfW * FIRE_U) * scale));
      const x1 = Math.min(width, Math.ceil((layout.cx + layout.halfW * FIRE_U) * scale));
      const y0 = Math.max(0, Math.floor((layout.baseY + layout.flameH * FIRE_V_MIN) * scale));
      const y1 = Math.min(height, Math.ceil((layout.baseY + layout.flameH * FIRE_V_MAX) * scale));
      target.resize(Math.max(1, x1 - x0), Math.max(1, y1 - y0), d);
      // The low-res texels cover a whole number of divisor-sized cells.
      const coverW = target.width * d;
      const coverH = target.height * d;

      gl.useProgram(flameProgram);
      gl.uniform2f(fl.uPxScale, d / scale / layout.halfW, d / scale / layout.flameH);
      gl.uniform2f(
        fl.uPxOffset,
        (x0 / scale - layout.cx) / layout.halfW,
        (y0 / scale - layout.baseY) / layout.flameH,
      );

      // Each program's uniforms in one block after its useProgram: a location is
      // only valid while its own program is current.
      gl.useProgram(target.program);
      gl.uniform1f(co.uProfileMax, logs ? hearthMaxHeight(layout) + 1 : -1);
      gl.uniform2f(co.uFireOrigin, x0, y0);
      gl.uniform2f(co.uFireInvSize, 1 / coverW, 1 / coverH);
      gl.uniform1f(co.uScale, scale);
      gl.uniform2f(co.uGlowCenter, layout.cx * scale, (layout.baseY + 0.3 * layout.flameH) * scale);
      gl.uniform2f(
        co.uGlowInvRadius,
        1 / (layout.halfW * 1.3 * scale),
        1 / (layout.flameH * 1.1 * scale),
      );
      gl.uniform1f(co.uRimInv, 1 / (RIM_PX * scale));

      gl.useProgram(emberProgram);
      gl.uniform2f(em.uInvResolution, 1 / width, 1 / height);

      if (logs) {
        buildHearthProfile(profileData, refWidth, layout);
        gl.bindTexture(gl.TEXTURE_2D, profileTex);
        resetUnpackState(gl);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PROFILE_COLUMNS, 1, gl.RED, gl.FLOAT, profileData);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    };

    return {
      resize(v) {
        ({ width, height, scale } = v);
        refWidth = width / scale;
        env.top = height / scale + 20;
        built.width = 0;
      },
      frame(dt, p) {
        const step = Math.min(dt, 0.1) * p.speed;
        time += step;

        if (
          built.width !== width ||
          built.height !== height ||
          built.flame !== p.height ||
          built.quality !== p.quality ||
          built.logs !== p.logs
        ) {
          rebuildLayout(p.height, p.quality, p.logs);
          if (import.meta.env.DEV) {
            const err = gl.getError();
            if (err !== gl.NO_ERROR)
              console.error(`fireplace: GL error 0x${err.toString(16)} in rebuildLayout`);
          }
          built.width = width;
          built.height = height;
          built.flame = p.height;
          built.quality = p.quality;
          built.logs = p.logs;
        }
        if (paletteId !== p.palette) {
          paletteId = p.palette;
          const pal = getPalette(p.palette);
          buildRamp(pal.ramp, RAMP_SIZE, rampData);
          gl.bindTexture(gl.TEXTURE_2D, rampTex);
          resetUnpackState(gl);
          gl.texSubImage2D(
            gl.TEXTURE_2D,
            0,
            0,
            0,
            RAMP_SIZE,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            rampData,
          );
          gl.bindTexture(gl.TEXTURE_2D, null);
          glowRgb = pal.glow;
          emberRgb = pal.ember;
          gl.useProgram(emberProgram);
          gl.uniform3f(em.uColor, emberRgb[0], emberRgb[1], emberRgb[2]);
        }

        // Scroll each octave upwards (flame-height relative) and wrap, so offsets
        // stay precise and changing the height doesn't make them jump.
        const riseV = (RISE_PX * step) / layout.flameH;
        for (let k = 0; k < OCTAVES.length; k++) {
          const o = OCTAVES[k];
          const sx = offsets[k * 2] + o.drift * step;
          const sy = offsets[k * 2 + 1] - riseV * o.rise * o.scale * (CELLS_V / NOISE_PERIOD);
          offsets[k * 2] = sx - Math.floor(sx);
          offsets[k * 2 + 1] = sy - Math.floor(sy);
        }
        // One slow flicker drives both the flames' heat and the glow.
        const flicker =
          flickerNoise.noise2(time * 1.1, 0.3) * 0.65 + flickerNoise.noise2(time * 2.9, 7.7) * 0.35;
        const gain = p.intensity * (0.93 + 0.1 * flicker);
        const glow = p.glow * 0.35 * Math.min(1.3, p.intensity) * (0.85 + 0.2 * flicker);

        // Embers.
        env.rate = p.embers * EMBER_RATE;
        env.time = time;
        stepEmbers(embers, step, env, rng, curl);
        const data = batch.data;
        let visible = 0;
        for (let i = 0; i < embers.count; i++) {
          const a = emberAlpha(embers.age[i], embers.life[i], embers.seed[i], time) * p.intensity;
          if (a <= 0.004) continue;
          const o = visible * 4;
          data[o] = embers.x[i] * scale;
          data[o + 1] = embers.y[i] * scale;
          data[o + 2] = embers.size[i] * EMBER_HALF * scale;
          data[o + 3] = Math.min(1, a);
          visible++;
        }

        resetState(gl, width, height);
        gl.disable(gl.BLEND);

        // 1. Flames into the low-res target, covering only the fire rectangle.
        target.bind();
        gl.useProgram(flameProgram);
        gl.uniform2fv(fl.uOff, offsets);
        gl.uniform1f(fl.uGain, gain);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, rampTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, noiseTex);
        triangle.draw();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        // 2. Full-res composite: background, glow, flames, silhouette.
        gl.viewport(0, 0, width, height);
        gl.useProgram(target.program);
        const bg = bgColor(p.background);
        if (bg !== lastBg) {
          gl.uniform3fv(co.uBg, bg);
          // Logs: much darker than the background, slightly warm.
          gl.uniform3f(co.uLog, bg[0] * 0.3 + 0.006, bg[1] * 0.3 + 0.004, bg[2] * 0.3 + 0.003);
          lastBg = bg;
        }
        gl.uniform3f(co.uGlow, glowRgb[0] * glow, glowRgb[1] * glow, glowRgb[2] * glow);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, profileTex);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        triangle.draw();

        // 3. Embers, additive.
        if (visible > 0) {
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE);
          gl.useProgram(emberProgram);
          batch.upload(visible);
          batch.draw(0, visible);
          gl.disable(gl.BLEND);
        }
      },
      dispose() {
        target.dispose();
        triangle.dispose();
        batch.dispose();
        gl.deleteProgram(flameProgram);
        gl.deleteProgram(emberProgram);
        gl.deleteTexture(noiseTex);
        gl.deleteTexture(rampTex);
        gl.deleteTexture(profileTex);
      },
    };
  },
});
