import { hexToUnitRgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
} from "./gl";
import { createRng } from "./noise";
import { defineEffect } from "./types";

const MAX_PARTICLES = 8000;
/** Reference particle speed in px/s at 1080p for a speed of 1. */
const SPEED_PX = 90;
/** Noise frequency per reference pixel for a field detail of 1 (about 1.7 cells per screen height). */
const FIELD_FREQ = 0.0016;
/** Noise time units per second for a field change speed of 1. */
const EVOLVE_RATE = 0.08;
/** Particle lifespan range in seconds, and how long the fade in/out at each end lasts. */
const LIFE_MIN = 4;
const LIFE_SPREAD = 6;
const LIFE_FADE = 1;
/**
 * Extra pull towards empty, as a fraction of the remaining distance to full per
 * second (the 2D version burned two 8-bit levels every 0.1s). Besides the
 * exponential fade this guarantees faint residue reaches exactly empty.
 */
const CLEAN_RATE = 20 / 255;
/** Floats per particle segment instance: x0, y0, x1, y1, colour t, alpha. */
const STRIDE = 6;
const TAU = Math.PI * 2;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const F3 = 1 / 3;
const G3 = 1 / 6;
/** The 12 edge-midpoint gradients of a cube, flattened as x,y,z triples. */
const GRAD3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1,
  0, 1, -1, 0, -1, -1,
]);

/**
 * 3D simplex noise, the same field as `createNoise(seed).noise3` in ./noise (same
 * permutation, same arithmetic), without the per-call array allocations of its
 * simplex ordering, as it runs once per particle per frame.
 */
const createNoise3 = (seed: number) => {
  const rng = createRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  const permMod12 = new Uint8Array(512);
  for (let i = 0; i < 512; i++) {
    perm[i] = p[i & 255];
    permMod12[i] = perm[i] % 12;
  }

  return (x: number, y: number, z: number): number => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    let i2 = 0;
    let j2 = 0;
    let k2 = 0;
    if (x0 >= y0) {
      i2 = 1;
      if (y0 >= z0) {
        i1 = 1;
        j2 = 1;
      } else if (x0 >= z0) {
        i1 = 1;
        k2 = 1;
      } else {
        k1 = 1;
        k2 = 1;
      }
    } else {
      j2 = 1;
      if (y0 < z0) {
        k1 = 1;
        k2 = 1;
      } else if (x0 < z0) {
        j1 = 1;
        k2 = 1;
      } else {
        j1 = 1;
        i2 = 1;
      }
    }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3;
    const y3 = y0 - 1 + 3 * G3;
    const z3 = z0 - 1 + 3 * G3;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      const g = permMod12[ii + perm[jj + perm[kk]]] * 3;
      t0 *= t0;
      n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      const g = permMod12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      t1 *= t1;
      n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      const g = permMod12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      t2 *= t2;
      n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      const g = permMod12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      t3 *= t3;
      n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3);
    }
    return 32 * n;
  };
};

/** 32-bit integer hash (lowbias32), matching the fade shader's. */
const hash32 = (x: number) => {
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
};

/**
 * One anti-aliased line segment per instance, expanded from gl_VertexID into a
 * quad with butt ends. Positions are canvas pixels with y down.
 */
const SEGMENT_VERTEX = /* glsl */ `#version 300 es
precision highp float;

layout(location = 0) in vec4 aSeg;
layout(location = 1) in vec2 aStyle;

uniform vec2 uResolution;
uniform float uHalfWidth;

out float vSide;
out float vT;
out float vAlpha;

const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, -1.0), vec2(1.0, -1.0), vec2(0.0, 1.0),
  vec2(0.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);

void main() {
  vec2 c = CORNERS[gl_VertexID];
  vec2 p0 = aSeg.xy;
  vec2 p1 = aSeg.zw;
  vec2 d = p1 - p0;
  float len = length(d);
  d = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  // One extra pixel each side for the anti-aliased edge.
  float extent = uHalfWidth + 1.0;
  vec2 pos = mix(p0, p1, c.x) + n * (c.y * extent);
  vSide = c.y * extent;
  vT = aStyle.x;
  vAlpha = aStyle.y;
  vec2 clip = pos / uResolution * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}
`;

const SEGMENT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in float vSide;
in float vT;
in float vAlpha;

uniform float uHalfWidth;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
uniform float uThree;
uniform float uLight;

out vec4 outColor;

void main() {
  // Exact coverage of a one-pixel box across the line.
  float coverage = clamp(min(vSide + 0.5, uHalfWidth) - max(vSide - 0.5, -uHalfWidth), 0.0, 1.0);
  vec3 color = uThree > 0.5
    ? (vT < 0.5 ? mix(uColor1, uColor2, vT * 2.0) : mix(uColor2, uColor3, vT * 2.0 - 1.0))
    : mix(uColor1, uColor2, vT);
  // The light layer is stored inverted, so its empty value is zero as well.
  if (uLight > 0.5) color = 1.0 - color;
  outColor = vec4(color, vAlpha * coverage);
}
`;

/**
 * Fades the trail layer towards empty (zero): v * keep - clean * (1 - v). The
 * result is stochastically rounded to a whole level of the fixed-point target, so
 * slow fades progress at the exact average rate instead of stalling above empty.
 */
const FADE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPrev;
/**
 * The fade in target levels, as one multiply-add: (v * keep - clean * (1 - v)) *
 * levels = v * x + y.
 */
uniform vec2 uFade;
/** 1 / levels of the target format: 1023 for 10-bit, 255 for 8-bit. */
uniform float uInvLevels;
/** Per-frame hash seed, so the rounding noise changes every frame. */
uniform uint uSeed;
uniform uint uStride;

out vec4 outColor;

uint hash(uint x) {
  x ^= x >> 16;
  x *= 0x7feb352du;
  x ^= x >> 15;
  x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}

void main() {
  uvec2 q = uvec2(gl_FragCoord.xy);
  vec3 v = texelFetch(uPrev, ivec2(q), 0).rgb;
  float r = float(hash(q.y * uStride + q.x + uSeed) >> 8u) * (1.0 / 16777216.0);
  v = floor(v * uFade.x + uFade.y + r) * uInvLevels;
  outColor = vec4(max(v, 0.0), 1.0);
}
`;

/**
 * Screens (dark) or multiplies (light, from the inverted layer) the trails over the
 * background. Both are bg + k * l: k = 1 - bg for screen, -bg for multiply.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

uniform sampler2D uLayer;
uniform vec3 uBackground;
uniform vec3 uLayerScale;

out vec4 outColor;

void main() {
  vec3 l = texelFetch(uLayer, ivec2(gl_FragCoord.xy), 0).rgb;
  outColor = vec4(uBackground + uLayerScale * l, 1.0);
}
`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

/**
 * Generative-art streams: thousands of particles drift along a slowly evolving
 * noise vector field and leave silky fading trails.
 *
 * Particles are simulated on the CPU; each frame's movement is uploaded as one
 * instanced batch of anti-aliased segments. Trails live on a ping-ponged offscreen
 * layer (RGB10_A2, else RGBA8) whose empty value is zero. Each
 * frame a pass fades the previous layer into the other one, the new segments are
 * blended on top, and the layer is screened over the background (dark backgrounds)
 * or, stored inverted, multiplied over it (light backgrounds), so the visible frame
 * is repainted in full and the background stays clean.
 *
 * At 4K the effect is bound by memory bandwidth, so the layer is 32 bits per pixel
 * rather than half float: 10 bits per channel plus stochastic rounding in the fade
 * keeps long faint trails smooth, and the composite to the 8-bit canvas hides any
 * difference. The fade target is invalidated first, as it is fully overwritten, so
 * tiled GPUs need not load its stale contents.
 */
export const flowfield = defineEffect({
  id: "flowfield",
  name: "Flow Field",
  description: "Thousands of particles follow a slowly shifting current and leave silky trails.",
  params: {
    count: {
      kind: "number",
      label: "Particles",
      min: 500,
      max: MAX_PARTICLES,
      step: 100,
      default: 2500,
    },
    speed: { kind: "number", label: "Speed", min: 0, max: 4, step: 0.05, default: 1 },
    fieldScale: { kind: "number", label: "Field detail", min: 0.2, max: 4, step: 0.05, default: 1 },
    turbulence: { kind: "number", label: "Turbulence", min: 0.1, max: 3, step: 0.05, default: 1 },
    evolve: {
      kind: "number",
      label: "Field change speed",
      min: 0,
      max: 3,
      step: 0.05,
      default: 0.5,
    },
    trail: { kind: "number", label: "Trail length", min: 0, max: 1, step: 0.01, default: 0.7 },
    lineWidth: { kind: "number", label: "Line width", min: 0.5, max: 6, step: 0.1, default: 1.6 },
    opacity: { kind: "number", label: "Opacity", min: 0.05, max: 1, step: 0.01, default: 0.6 },
    color1: { kind: "color", label: "Colour 1", default: "#3fd0ff" },
    color2: { kind: "color", label: "Colour 2", default: "#8a5cff" },
    color3: { kind: "color", label: "Colour 3", default: "#ff6fa8" },
    useColor3: { kind: "boolean", label: "Use colour 3", default: true },
    colorBy: {
      kind: "select",
      label: "Colour by",
      options: [
        { value: "angle", label: "Flow direction" },
        { value: "random", label: "Random per particle" },
      ],
      default: "angle",
    },
    background: { kind: "color", label: "Background", default: "#05060f" },
    seed: { kind: "number", label: "Field seed", min: 1, max: 9999, step: 1, default: 1 },
  },
  context: "webgl2",
  create(gl) {
    const xs = new Float32Array(MAX_PARTICLES);
    const ys = new Float32Array(MAX_PARTICLES);
    const ages = new Float32Array(MAX_PARTICLES);
    const lives = new Float32Array(MAX_PARTICLES);
    const rands = new Float32Array(MAX_PARTICLES);
    const instances = new Float32Array(MAX_PARTICLES * STRIDE);

    const segProgram = createProgram(gl, SEGMENT_VERTEX, SEGMENT_FRAGMENT);
    const fadeProgram = createProgram(gl, FULLSCREEN_VERTEX, FADE_FRAGMENT);
    const compProgram = createProgram(gl, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT);
    const segLoc = getUniforms(gl, segProgram, [
      "uResolution",
      "uHalfWidth",
      "uColor1",
      "uColor2",
      "uColor3",
      "uThree",
      "uLight",
    ]);
    const fadeLoc = getUniforms(gl, fadeProgram, [
      "uPrev",
      "uFade",
      "uInvLevels",
      "uSeed",
      "uStride",
    ]);
    const compLoc = getUniforms(gl, compProgram, ["uLayer", "uBackground", "uLayerScale"]);
    // Uniforms live in their programs, so the samplers only need setting once.
    gl.useProgram(fadeProgram);
    gl.uniform1i(fadeLoc.uPrev, 0);
    gl.useProgram(compProgram);
    gl.uniform1i(compLoc.uLayer, 0);
    gl.useProgram(null);
    const triangle = createFullscreenTriangle(gl);

    const vao = gl.createVertexArray();
    const instanceBuffer = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, STRIDE * 4, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE * 4, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    /** 10-bit layers avoid 8-bit grain in long, faint trails at the same bandwidth. */
    let use10 = true;
    let targets: Target[] = [];
    /** Index of the target holding the latest layer. */
    let current = 0;
    let targetW = 0;
    let targetH = 0;

    let width = 1;
    let height = 1;
    let scale = 1;
    let time = 0;
    let frameNo = 0;
    let active = 0;
    let seedKey = NaN;
    let noise3 = createNoise3(1);
    let rng = createRng(1);
    /** Whether the trail layer is in light mode, or undefined to clear it. */
    let lightMode: boolean | undefined;
    const EMPTY = new Float32Array([0, 0, 0, 1]);
    const INVALIDATE = [gl.COLOR_ATTACHMENT0];
    /** Parsed colour uniforms, cached by hex string. */
    const colorCache = new Map<string, Float32Array>();
    const unitColor = (hex: string) => {
      let c = colorCache.get(hex);
      if (!c) {
        if (colorCache.size > 64) colorCache.clear();
        c = new Float32Array(hexToUnitRgb(hex));
        colorCache.set(hex, c);
      }
      return c;
    };

    const deleteTargets = () => {
      for (const t of targets) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
      targets = [];
    };

    const makeTarget = (tenBit: boolean): Target | null => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, tenBit ? gl.RGB10_A2 : gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (ok) return { tex, fbo };
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
      return null;
    };

    /** (Re)creates both layer targets at the canvas size; they start uncleared. */
    const ensureTargets = () => {
      if (targets.length === 2 && targetW === width && targetH === height) return;
      deleteTargets();
      for (let i = 0; i < 2; i++) {
        let t = makeTarget(use10);
        if (!t && use10) {
          // 10-bit not renderable after all: start over in 8-bit.
          use10 = false;
          deleteTargets();
          i = -1;
          continue;
        }
        if (!t) t = makeTarget(false);
        if (!t) break;
        targets.push(t);
      }
      targetW = width;
      targetH = height;
      lightMode = undefined;
    };

    const spawn = (i: number, randomAge: boolean) => {
      xs[i] = rng() * width;
      ys[i] = rng() * height;
      lives[i] = LIFE_MIN + rng() * LIFE_SPREAD;
      ages[i] = randomAge ? rng() * lives[i] : 0;
      rands[i] = rng();
    };

    const reseed = (seed: number) => {
      noise3 = createNoise3(seed * 131 + 17);
      rng = createRng(seed * 7907 + 3);
      for (let i = 0; i < MAX_PARTICLES; i++) spawn(i, true);
      lightMode = undefined;
    };

    return {
      resize(v) {
        ({ width, height, scale } = v);
        width = Math.max(1, Math.round(width));
        height = Math.max(1, Math.round(height));
        // Resizing clears the layer; respawn so no trail spans the old and new size.
        for (let i = 0; i < MAX_PARTICLES; i++) spawn(i, true);
        lightMode = undefined;
      },
      frame(dt, p) {
        beginFrame(gl, width, height);
        if (p.seed !== seedKey) {
          seedKey = p.seed;
          reseed(p.seed);
        }
        ensureTargets();
        if (targets.length < 2) return;

        gl.activeTexture(gl.TEXTURE0);

        const bg = unitColor(p.background);
        const light = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] > 140 / 255;
        if (light !== lightMode) {
          lightMode = light;
          for (const t of targets) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
            gl.clearBufferfv(gl.COLOR, 0, EMPTY);
          }
        }

        // Fade the previous layer into the other target. The time constant spans 0.1s to 3s.
        const src = targets[current];
        current ^= 1;
        const dst = targets[current];
        const tau = 0.1 * Math.pow(30, p.trail);
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
        // Every pixel is overwritten below, so the old contents need not be loaded.
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
        gl.useProgram(fadeProgram);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        const keep = Math.exp(-dt / tau);
        const clean = Math.min(1, dt * CLEAN_RATE);
        const levels = use10 ? 1023 : 255;
        gl.uniform2f(fadeLoc.uFade, (keep + clean) * levels, -clean * levels);
        gl.uniform1f(fadeLoc.uInvLevels, 1 / levels);
        frameNo = (frameNo + 1) >>> 0;
        gl.uniform1ui(fadeLoc.uSeed, hash32(frameNo));
        gl.uniform1ui(fadeLoc.uStride, width);
        triangle.draw();

        // Newly enabled particles start fresh so they fade in where they appear.
        const n = Math.min(Math.round(p.count), MAX_PARTICLES);
        for (let i = active; i < n; i++) spawn(i, false);
        active = n;

        time += dt * p.evolve * EVOLVE_RATE;
        const freq = (p.fieldScale * FIELD_FREQ) / scale;
        const swirl = TAU * p.turbulence;
        const step = p.speed * SPEED_PX * scale * dt;
        const margin = 10 * scale;
        const byAngle = p.colorBy === "angle";
        let count = 0;

        for (let i = 0; i < n; i++) {
          const age = ages[i] + dt;
          const x = xs[i];
          const y = ys[i];
          if (
            age >= lives[i] ||
            x < -margin ||
            x > width + margin ||
            y < -margin ||
            y > height + margin
          ) {
            spawn(i, false);
            continue;
          }
          ages[i] = age;
          const angle = noise3(x * freq, y * freq, time) * swirl;
          const cos = Math.cos(angle);
          const nx = x + cos * step;
          const ny = y + Math.sin(angle) * step;
          xs[i] = nx;
          ys[i] = ny;

          const life = lives[i];
          const f = smoothstep(0, LIFE_FADE, age) * smoothstep(life, life - LIFE_FADE, age);
          if (f <= 0 || step === 0) continue;
          const o = count * STRIDE;
          instances[o] = x;
          instances[o + 1] = y;
          instances[o + 2] = nx;
          instances[o + 3] = ny;
          // Map direction smoothly around the circle: colour 1 one way, colour 3 the other.
          instances[o + 4] = byAngle ? 0.5 - 0.5 * cos : rands[i];
          instances[o + 5] = p.opacity * f;
          count++;
        }

        if (count > 0) {
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(segProgram);
          gl.uniform2f(segLoc.uResolution, width, height);
          gl.uniform1f(segLoc.uHalfWidth, Math.max(0.5, p.lineWidth * scale) / 2);
          gl.uniform3fv(segLoc.uColor1, unitColor(p.color1));
          gl.uniform3fv(segLoc.uColor2, unitColor(p.color2));
          gl.uniform3fv(segLoc.uColor3, unitColor(p.color3));
          gl.uniform1f(segLoc.uThree, p.useColor3 ? 1 : 0);
          gl.uniform1f(segLoc.uLight, light ? 1 : 0);
          gl.bindVertexArray(vao);
          gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, instances, 0, count * STRIDE);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
          gl.bindVertexArray(null);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          gl.disable(gl.BLEND);
        }

        // Full repaint of the visible canvas: the layer composited over the background.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.useProgram(compProgram);
        gl.bindTexture(gl.TEXTURE_2D, dst.tex);
        gl.uniform3fv(compLoc.uBackground, bg);
        if (light) gl.uniform3f(compLoc.uLayerScale, -bg[0], -bg[1], -bg[2]);
        else gl.uniform3f(compLoc.uLayerScale, 1 - bg[0], 1 - bg[1], 1 - bg[2]);
        triangle.draw();
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      dispose() {
        deleteTargets();
        gl.deleteProgram(segProgram);
        gl.deleteProgram(fadeProgram);
        gl.deleteProgram(compProgram);
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(instanceBuffer);
        triangle.dispose();
      },
    };
  },
});
