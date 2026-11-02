import type { Rgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createGradientBackground,
  createProgram,
  createUniforms,
  createRenderTarget,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createLowResTarget, lowResSize, QUALITY_OPTIONS, qualityDivisor } from "./lowres";
import { createRng, hash32, HASH32_GLSL } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect } from "./types";
import {
  createRainSim,
  DEFAULT_CONFIG,
  instanceCapacity,
  resizeRainSim,
  stepRainSim,
  wipeStampCapacity,
  writeDropInstances,
  writeWipeStamps,
} from "./windowrain-sim";
import { wrap } from "./math";
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { unitRgbMemo } from "./color";

const MAX_LIGHTS = 150;
/** Background divisors: the background is heavily defocused, so it can be very low-res. */
const BG_DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** The background only drifts, so it is re-rendered at this rate (Hz). */
const BG_RATE = 10;
/** Light drift in reference px/s. */
const DRIFT_PX = 2.5;
/**
 * Drop lens: a drop shows the background around its centre, inverted and
 * minified by this factor (a ball lens's wide, flipped view), so the defocused
 * lights read smaller and crisper through the drop.
 */
const LENS = 2;
/** Refraction offsets are stored in the drop map as +-OFFSET_RANGE reference px. */
const OFFSET_RANGE = 128;
/** 8-bit value meaning "no offset", and the scale from [-1, 1] to stored units. */
const ENC_MID = 128 / 255;
const ENC_SCALE = 127 / 255;
/** Fog mask texel size in reference px. */
const FOG_TEXEL = 4;
/** Seconds for wiped glass to fog over completely. */
const REFOG_SECONDS = 30;
/** Fog spreading back into wiped areas, as a blend fraction per second. */
const FOG_DIFFUSE = 0.6;
/** Wipe disc radius relative to the drop radius. */
const WIPE_GROW = 1.25;
/**
 * Most distance between wipe stamps along a runner's step, relative to its
 * radius: the wipe disc's fully clear core (half its radius), so a fast step at
 * a low frame rate leaves no gap.
 */
const WIPE_STAMP_SPACING = 0.5 * WIPE_GROW;

/** Background light: soft additive disc, colour mixed between the two light colours. */
const LIGHT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down) and intensity. */
layout(location = 1) in vec4 aLight;
/** Colour mix, 0 = colour 1, 1 = colour 2. */
layout(location = 2) in float aMix;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vAlpha;
flat out float vMix;
${TO_CLIP_GLSL}
void main() {
  vec2 px = aLight.xy + aCorner * aLight.z;
  vLocal = aCorner;
  vAlpha = aLight.w;
  vMix = aMix;
  gl_Position = pxToClip(px, uResolution);
}
`;

const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
flat in float vAlpha;
flat in float vMix;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform float uEdge;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float a = 1.0 - smoothstep(1.0 - uEdge, 1.0, d);
  outColor = vec4(mix(uColor1, uColor2, vMix) * (a * vAlpha), 0.0);
}
`;

/**
 * Drop sprites, shared by the drop-map and fog-wipe passes. Each drop is an
 * octagon around an ellipse (stretched vertically while running).
 */
const DROP_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down) and vertical stretch. */
layout(location = 1) in vec4 aDrop;
layout(location = 2) in float aFade;
uniform vec2 uResolution;
uniform float uInvScale;
uniform float uGrow;
uniform float uMargin;
/** Unit-ellipse coordinates, y up. */
out vec2 vLocal;
/** Offset from the centre in reference px, y up. */
out vec2 vRel;
flat out float vFade;
${TO_CLIP_GLSL}
void main() {
  float s = aDrop.w;
  vec2 radii = aDrop.z * uGrow * vec2(inversesqrt(s), s);
  // Grow by the target's texel size, so the anti-aliased edge is never clipped.
  vec2 ext = radii + uMargin;
  vec2 offset = aCorner * ext;
  vec2 px = aDrop.xy + offset;
  vLocal = offset / radii * vec2(1.0, -1.0);
  vRel = offset * uInvScale * vec2(1.0, -1.0);
  vFade = aFade;
  gl_Position = pxToClip(px, uResolution);
}
`;

/**
 * Drop map: RG = refraction offset (encoded), B = dome height, A = coverage.
 * Drawn without blending in priority order (runners last), so each pixel holds
 * exactly one drop's surface and overlaps are well defined.
 */
const DROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vRel;
flat in float vFade;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float cov = clamp((1.0 - d) / max(fwidth(d), 1e-4) + 0.5, 0.0, 1.0);
  if (cov <= 0.0) discard;
  float h = sqrt(max(1.0 - d * d, 0.0));
  // Sample the background at centre - LENS * rel: inverted and minified.
  vec2 off = vRel * (${glslFloat(-(1 + LENS) / OFFSET_RANGE)} * vFade);
  vec2 enc = clamp(${glslFloat(ENC_MID)} + off * ${glslFloat(ENC_SCALE)}, ${glslFloat(1 / 255)}, 1.0);
  outColor = vec4(enc, h, cov * vFade);
}
`;

/**
 * Fog step (ping-pong, low res): spread a little from the 4 neighbours, add the
 * refog amount, and round stochastically to whole 8-bit levels so a slow refog
 * progresses at its true average rate. 1 = fogged, 0 = clear.
 */
const FOG_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrev;
/** Refog this frame, in 8-bit levels. */
uniform float uAdd;
uniform float uDiffuse;
uniform uint uSeed;
out vec4 outColor;
${HASH32_GLSL}void main() {
  ivec2 q = ivec2(gl_FragCoord.xy);
  ivec2 m = textureSize(uPrev, 0) - 1;
  float c = texelFetch(uPrev, q, 0).r;
  float n = texelFetch(uPrev, ivec2(min(q.x + 1, m.x), q.y), 0).r
    + texelFetch(uPrev, ivec2(max(q.x - 1, 0), q.y), 0).r
    + texelFetch(uPrev, ivec2(q.x, min(q.y + 1, m.y)), 0).r
    + texelFetch(uPrev, ivec2(q.x, max(q.y - 1, 0)), 0).r;
  float v = mix(c, n * 0.25, uDiffuse);
  float r = float(hash32(uint(q.y) * 8192u + uint(q.x) + uSeed) >> 8u) * (1.0 / 16777216.0);
  v = floor(v * 255.0 + uAdd + r) * (1.0 / 255.0);
  outColor = vec4(clamp(v, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

/** Fog wipe: a soft disc, combined with MIN blending, so drops clear the fog. */
const WIPE_FRAGMENT = /* glsl */ `#version 300 es
precision mediump float;
in vec2 vLocal;
in vec2 vRel;
flat in float vFade;
out vec4 outColor;
void main() {
  float v = smoothstep(0.5, 1.0, length(vLocal));
  outColor = vec4(mix(1.0, v, vFade), 0.0, 0.0, 1.0);
}
`;

const LIGHT_LEN = Math.hypot(-0.45, 0.55, 0.7);
/** Direction towards the specular highlight's light (unit length). */
const LIGHT_DIR = [-0.45 / LIGHT_LEN, 0.55 / LIGHT_LEN, 0.7 / LIGHT_LEN] as const;

/**
 * Full-res composite (the low-res target's blit): one drop-map fetch, one
 * background fetch at the refracted position, plus one fog fetch when enabled.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D uDrops;
uniform sampler2D uFog;
/** Decoded offset [-1, 1] to uv. */
uniform vec2 uOffsetScale;
uniform float uFogOn;
uniform vec3 uFogTint;
/** Unit vector towards the specular light, normalised in JS. */
const vec3 LIGHT_DIR = vec3(${glslFloat(LIGHT_DIR[0])}, ${glslFloat(LIGHT_DIR[1])}, ${glslFloat(LIGHT_DIR[2])});
vec4 composite(vec2 uv) {
  vec4 d = texture(uDrops, uv);
  vec2 dir = (d.xy - ${glslFloat(ENC_MID)}) * ${glslFloat(1 / ENC_SCALE)};
  float cov = d.a;
  vec3 col = texture(uLowRes, uv + dir * uOffsetScale).rgb;
  // Through the drop, the view is a little brighter and clearer.
  col *= 1.0 + 0.15 * cov;
  if (uFogOn > 0.5) {
    float fog = texture(uFog, uv).r * (1.0 - cov);
    col = mix(col, col * 0.5 + uFogTint, fog);
  }
  float h = d.z;
  // Normal from the dome: the offset points away from the surface direction.
  float len2 = dot(dir, dir);
  vec2 nxy = len2 > 1e-6 ? -dir * inversesqrt(len2) * sqrt(max(1.0 - h * h, 0.0)) : vec2(0.0);
  float spec = pow(max(dot(vec3(nxy, h), LIGHT_DIR), 0.0), 40.0) * cov;
  float rim = cov * (1.0 - smoothstep(0.0, 0.45, h));
  col = col * (1.0 - 0.55 * rim) + spec * 0.7;
  return vec4(col, 1.0);
}
`;

/**
 * Looking through a rainy window at night: defocused city lights behind glass
 * covered in droplets. Larger drops break loose and run down, wiping the small
 * droplets in their path and leaving trails; each drop refracts an inverted view
 * of the lights. Optional condensation fogs the glass, except where drops have
 * wiped it.
 *
 * Passes: (1) background gradient + bokeh lights into a low-res target, only at
 * `BG_RATE`; (2) all drops, one instanced draw, into a ~1080p RGBA8 drop map;
 * (3) with fog, a tiny R8 ping-pong refog step plus runner wipes (MIN blend);
 * (4) the full-res composite as the low-res target's blit.
 */
export const windowRain = defineEffect({
  id: "windowrain",
  name: "Rain on a Window",
  description: "Raindrops run down a night window in front of blurred city lights.",
  params: {
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.01, default: 0.5 },
    speed: { kind: "number", label: "Runner speed", min: 0, max: 3, step: 0.05, default: 1 },
    lights: {
      kind: "number",
      label: "Background lights",
      min: 0,
      max: MAX_LIGHTS,
      step: 1,
      default: 60,
    },
    blur: { kind: "number", label: "Background blur", min: 0, max: 1, step: 0.01, default: 0.6 },
    lightColor1: { kind: "color", label: "Light colour 1", default: "#ffb05c" },
    lightColor2: { kind: "color", label: "Light colour 2", default: "#5cb8ff" },
    background: { kind: "color", label: "Background", default: "#0b1020" },
    fog: { kind: "boolean", label: "Fogged glass", default: false },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const rng = createRng(Math.random() * 0xffffffff);
      const sim = createRainSim(1920, 1080, rng);
      const capacity = instanceCapacity(DEFAULT_CONFIG) + wipeStampCapacity(DEFAULT_CONFIG);

      const octagon = polygonStrip(8, Math.PI / 8);
      const drops = scope.own(createSpriteBatch(gl, capacity, [4, 1], [octagon]));
      const lightBatch = scope.own(createSpriteBatch(gl, MAX_LIGHTS, [4, 1], [octagon]));
      const gradient = scope.own(createGradientBackground(gl));
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const triangle = scope.own(createFullscreenTriangle(gl));

      const lightProgram = scope.add(createProgram(gl, LIGHT_VERTEX, LIGHT_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const dropProgram = scope.add(createProgram(gl, DROP_VERTEX, DROP_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const wipeProgram = scope.add(createProgram(gl, DROP_VERTEX, WIPE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const fogProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FOG_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const lightU = createUniforms(gl, lightProgram, [
        "uResolution",
        "uColor1",
        "uColor2",
        "uEdge",
      ]);
      const dropNames = ["uResolution", "uInvScale", "uGrow", "uMargin"] as const;
      const dropU = createUniforms(gl, dropProgram, dropNames);
      const wipeU = createUniforms(gl, wipeProgram, dropNames);
      const fogU = createUniforms(gl, fogProgram, ["uPrev", "uAdd", "uDiffuse", "uSeed"]);
      const compU = createUniforms(gl, target.program, [
        "uDrops",
        "uFog",
        "uOffsetScale",
        "uFogOn",
        "uFogTint",
      ]);
      gl.useProgram(dropProgram);
      dropU.f1("uGrow", 1);
      gl.useProgram(wipeProgram);
      wipeU.f1("uGrow", WIPE_GROW);
      gl.useProgram(fogProgram);
      fogU.i1("uPrev", 0);
      gl.useProgram(target.program);
      compU.i1("uDrops", 1);
      compU.i1("uFog", 2);
      gl.useProgram(null);

      // Background lights, reference units.
      const lx = new Float32Array(MAX_LIGHTS);
      const ly = new Float32Array(MAX_LIGHTS);
      const lSize = new Float32Array(MAX_LIGHTS);
      const lMix = new Float32Array(MAX_LIGHTS);
      const lBright = new Float32Array(MAX_LIGHTS);
      const lDrift = new Float32Array(MAX_LIGHTS);
      /** Count fade (see `fade.ts`): lights added or removed by the count fade in or out. */
      const lLife = new Float32Array(MAX_LIGHTS);
      /** Lights drawn: the count plus any still fading out; NaN before the first frame. */
      let liveLights = Number.NaN;
      let refWidth = 1920;
      for (let i = 0; i < MAX_LIGHTS; i++) {
        lx[i] = rng() * refWidth;
        // City lights crowd the lower part of the view.
        ly[i] = 1080 * (0.15 + 0.9 * Math.sqrt(rng()));
        lSize[i] = 0.6 + rng() * 0.8;
        lMix[i] = rng() < 0.5 ? rng() * 0.3 : 0.7 + rng() * 0.3;
        lBright[i] = 0.25 + rng() * 0.6;
        lDrift[i] = (rng() - 0.5) * 2;
      }

      const lightColor1 = unitRgbMemo();
      const lightColor2 = unitRgbMemo();
      const bgColor = unitRgbMemo();
      const top: Rgb = [0, 0, 0];
      const fogTint: Rgb = [0, 0, 0];

      let dropTarget: RenderTarget | null = null;
      let dropW = 0;
      let dropH = 0;
      let fogTargets: RenderTarget[] = [];
      let fogCurrent = 0;
      let fogW = 0;
      let fogH = 0;
      const FOG_CLEAR = new Float32Array([1, 0, 0, 1]);
      const DROP_CLEAR = new Float32Array([ENC_MID, ENC_MID, 0, 0]);
      const INVALIDATE = [gl.COLOR_ATTACHMENT0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let frameNo = 0;
      let bgTimer = Infinity;
      // Inputs the background was last drawn with; any change redraws it at once.
      let bgLights = -1;
      let bgBlur = -1;
      let bgC1: Rgb | null = null;
      let bgC2: Rgb | null = null;
      let bgBack: Rgb | null = null;
      let lastBack: Rgb | null = null;

      const makeTarget = (w: number, h: number, format: GLenum): RenderTarget => {
        const t = createRenderTarget(gl, w, h, format);
        // R8 and RGBA8 are always colour-renderable in WebGL2.
        if (!t) throw new Error("Window rain: render target is not renderable");
        return t;
      };
      scope.defer(() => {
        dropTarget?.dispose();
        for (const t of fogTargets) t.dispose();
      });

      /** The drop map is about 1080p whatever the canvas size. */
      const ensureDropTarget = () => {
        const div = Math.max(1, scale);
        const w = lowResSize(width, div);
        const h = lowResSize(height, div);
        if (dropTarget && w === dropW && h === dropH) return;
        dropTarget?.dispose();
        dropTarget = null;
        dropTarget = makeTarget(w, h, gl.RGBA8);
        dropW = w;
        dropH = h;
      };

      /**
       * Fog targets, `FOG_TEXEL` reference px per texel. On a resize the current fog
       * is stretched into the new targets, so wiped areas survive; returns true when
       * there was none, and the caller must fill them fully fogged.
       */
      const ensureFogTargets = () => {
        const w = lowResSize(width, FOG_TEXEL * scale);
        const h = lowResSize(height, FOG_TEXEL * scale);
        if (fogTargets.length === 2 && w === fogW && h === fogH) return false;
        const old = fogTargets;
        const keep = old.length === 2 ? old[fogCurrent] : null;
        fogTargets = [];
        try {
          // One at a time, so a throw on the second still leaves the first disposable.
          fogTargets.push(makeTarget(w, h, gl.R8));
          fogTargets.push(makeTarget(w, h, gl.R8));
          if (keep) {
            // Only the current target is read next; the refog step overwrites the other.
            // The fog maps to the whole screen, so whole-to-whole keeps it in place.
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, keep.framebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fogTargets[fogCurrent].framebuffer);
            gl.blitFramebuffer(0, 0, fogW, fogH, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
        } finally {
          for (const t of old) t.dispose();
        }
        fogW = w;
        fogH = h;
        return !keep;
      };

      const drawBackground = (n: number, blur: number, c1: Rgb, c2: Rgb, back: Rgb) => {
        target.bind();
        gradient.draw(top, back);
        if (n === 0) return;
        const data = lightBatch.data;
        const stride = lightBatch.stride;
        const baseR = (25 + 85 * blur) * scale;
        // Bigger, softer discs spread the same light wider.
        const dim = 0.9 / (0.6 + blur);
        for (let i = 0; i < n; i++) {
          const o = i * stride;
          data[o] = lx[i] * scale;
          data[o + 1] = ly[i] * scale;
          data[o + 2] = baseR * lSize[i];
          data[o + 3] = lBright[i] * dim * lLife[i];
          data[o + 4] = lMix[i];
        }
        lightBatch.upload(n);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(lightProgram);
        lightU.f2("uResolution", width, height);
        lightU.v3("uColor1", c1);
        lightU.v3("uColor2", c2);
        lightU.f1("uEdge", 0.25 + 0.7 * blur);
        lightBatch.draw(0, n);
        gl.disable(gl.BLEND);
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
          width = Math.max(1, Math.round(width));
          height = Math.max(1, Math.round(height));
          const newRefWidth = width / scale;
          const k = newRefWidth / refWidth;
          for (let i = 0; i < MAX_LIGHTS; i++) lx[i] *= k;
          refWidth = newRefWidth;
          resizeRainSim(sim, refWidth, 1080);
          bgTimer = Infinity;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          frameNo = (frameNo + 1) >>> 0;
          stepRainSim(sim, dt, p);
          const count = writeDropInstances(sim, drops.data, scale);
          // Wipe stamps go after the runners, so one draw covers both.
          const stamps = p.fog
            ? writeWipeStamps(sim, drops.data, scale, count, WIPE_STAMP_SPACING)
            : 0;
          drops.upload(count + stamps);

          // 1. Background, at a low rate (or at once when its inputs change).
          const prevW = target.width;
          const prevH = target.height;
          target.resize(width, height, qualityDivisor(p.quality, BG_DIVISORS));
          const c1 = lightColor1(p.lightColor1);
          const c2 = lightColor2(p.lightColor2);
          const back = bgColor(p.background);
          if (back !== lastBack) {
            lastBack = back;
            for (let c = 0; c < 3; c++) {
              top[c] = back[c] * 0.45;
              fogTint[c] = back[c] * 0.35 + 0.07;
            }
            gl.useProgram(target.program);
            compU.v3("uFogTint", fogTint);
          }
          bgTimer += dt;
          const lightTarget = Math.min(MAX_LIGHTS, Math.max(0, Math.round(p.lights)));
          if (Number.isNaN(liveLights)) {
            // The first frame shows the lights rather than fading them all in.
            lLife.fill(1);
            liveLights = lightTarget;
          }
          const nLights = (liveLights = growLive(lLife, liveLights, lightTarget));
          const lightStep = dt / FADE_OUT;
          let lightsFading = false;
          for (let i = 0; i < nLights; i++) {
            lx[i] = wrap(lx[i] + lDrift[i] * DRIFT_PX * dt, -200, refWidth + 400);
            const before = lLife[i];
            if (stepLife(lLife, i, lightTarget, lightStep, lightStep) !== before) {
              lightsFading = true;
            }
          }
          liveLights = trimLive(lLife, liveLights, lightTarget);
          if (
            bgTimer >= 1 / BG_RATE ||
            prevW !== target.width ||
            prevH !== target.height ||
            lightsFading ||
            bgLights !== nLights ||
            bgBlur !== p.blur ||
            bgC1 !== c1 ||
            bgC2 !== c2 ||
            bgBack !== back
          ) {
            bgTimer = 0;
            bgLights = nLights;
            bgBlur = p.blur;
            bgC1 = c1;
            bgC2 = c2;
            bgBack = back;
            drawBackground(nLights, p.blur, c1, c2, back);
          }

          // 2. Drop map.
          ensureDropTarget();
          const dt0 = dropTarget;
          if (!dt0) return;
          gl.bindFramebuffer(gl.FRAMEBUFFER, dt0.framebuffer);
          gl.viewport(0, 0, dropW, dropH);
          gl.clearBufferfv(gl.COLOR, 0, DROP_CLEAR);
          gl.disable(gl.BLEND);
          if (count > 0) {
            gl.useProgram(dropProgram);
            dropU.f2("uResolution", width, height);
            dropU.f1("uInvScale", 1 / scale);
            dropU.f1("uMargin", width / dropW);
            drops.draw(0, count);
          }

          // 3. Fog: refog step into the other target, then runners wipe it.
          let fogTex: WebGLTexture | null = null;
          if (p.fog) {
            if (ensureFogTargets()) {
              for (const t of fogTargets) {
                gl.bindFramebuffer(gl.FRAMEBUFFER, t.framebuffer);
                gl.clearBufferfv(gl.COLOR, 0, FOG_CLEAR);
              }
            }
            const src = fogTargets[fogCurrent];
            fogCurrent ^= 1;
            const dst = fogTargets[fogCurrent];
            gl.bindFramebuffer(gl.FRAMEBUFFER, dst.framebuffer);
            gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
            gl.viewport(0, 0, fogW, fogH);
            gl.useProgram(fogProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.texture);
            fogU.f1("uAdd", (255 * dt) / REFOG_SECONDS);
            fogU.f1("uDiffuse", Math.min(1, dt * FOG_DIFFUSE));
            fogU.u1("uSeed", hash32(frameNo));
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
            if (sim.runnersWritten > 0) {
              gl.enable(gl.BLEND);
              gl.blendEquation(gl.MIN);
              gl.useProgram(wipeProgram);
              wipeU.f2("uResolution", width, height);
              wipeU.f1("uInvScale", 1 / scale);
              wipeU.f1("uMargin", width / fogW);
              drops.draw(sim.runnerFirst, sim.runnersWritten + stamps);
              gl.blendEquation(gl.FUNC_ADD);
              gl.disable(gl.BLEND);
            }
            fogTex = dst.texture;
          } else if (fogTargets.length > 0) {
            // Free the fog targets while fog is off: they are re-created fully fogged anyway.
            for (const t of fogTargets) t.dispose();
            fogTargets = [];
          }

          // 4. Composite to the canvas.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, dt0.texture);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, fogTex);
          gl.useProgram(target.program);
          compU.f1("uFogOn", p.fog ? 1 : 0);
          compU.f2("uOffsetScale", (OFFSET_RANGE * scale) / width, (OFFSET_RANGE * scale) / height);
          target.blit();
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
