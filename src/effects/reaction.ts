import { unitRgbMemo } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
} from "./gl";
import { clamp } from "./math";
import {
  advanceDrift,
  DA,
  DB,
  driftedFeedKill,
  DT,
  LAP_CORNER,
  LAP_EDGE,
  makeSpots,
  PATTERN_OPTIONS,
  presetFor,
  SPOT_B,
  SPOT_COUNT,
  SPOT_U,
  type StepClock,
  takeSteps,
} from "./reaction-sim";
import { defineEffect } from "./types";

/** Most simulation steps in one frame, however long it was. */
export const MAX_STEPS = 16;
/** Largest simulation grid side, well inside every GPU's MAX_TEXTURE_SIZE. */
const MAX_GRID = 2048;
/** B concentrations mapped to the ends of the colour ramp (the pattern peaks near 0.4). */
const RAMP_LO = 0.06;
const RAMP_HI = 0.34;
/** Emboss slope gain per cell of B difference at emboss 1. */
const EMBOSS_GAIN = 9;

/**
 * Reading and writing the (u, b) state, u = 1 - A (see reaction-sim.ts). RG16F
 * stores it directly and filters in hardware. The RGBA8 fallback packs each
 * channel into 16 bits (hi, lo bytes; see `pack16`), which can't be filtered, so
 * it samples bilinearly by hand from four texel fetches.
 */
const CODEC_FLOAT = /* glsl */ `
vec2 fetchState(ivec2 p) { return texelFetch(uState, p, 0).rg; }
vec4 encodeState(vec2 s) { return vec4(s, 0.0, 1.0); }
vec2 sampleState(vec2 uv) { return texture(uState, uv).rg; }
`;

const CODEC_PACKED = /* glsl */ `
vec2 fetchState(ivec2 p) {
  vec4 t = round(texelFetch(uState, p, 0) * 255.0);
  return vec2(t.x * 256.0 + t.y, t.z * 256.0 + t.w) * (1.0 / 65535.0);
}
vec4 encodeState(vec2 s) {
  vec2 q = round(clamp(s, 0.0, 1.0) * 65535.0);
  vec2 hi = floor(q * (1.0 / 256.0));
  vec2 lo = q - hi * 256.0;
  return vec4(hi.x, lo.x, hi.y, lo.y) * (1.0 / 255.0);
}
vec2 sampleState(vec2 uv) {
  vec2 p = uv * uSize - 0.5;
  vec2 f = fract(p);
  ivec2 i = ivec2(floor(p));
  ivec2 m = ivec2(uSize) - 1;
  vec2 s00 = fetchState(clamp(i, ivec2(0), m));
  vec2 s10 = fetchState(clamp(i + ivec2(1, 0), ivec2(0), m));
  vec2 s01 = fetchState(clamp(i + ivec2(0, 1), ivec2(0), m));
  vec2 s11 = fetchState(clamp(i + ivec2(1, 1), ivec2(0), m));
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}
`;

/** Shared header: the state sampler, its size in cells, and the codec. */
const header = (codec: string) => /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uState;
/** Size of uState in cells. */
uniform vec2 uSize;
out vec4 outColor;
${codec}
`;

/**
 * One Gray–Scott step per cell: the 3x3 Laplacian (9 fetches, edges clamped) and
 * the reaction, in the u = 1 - A form. Mirrors `grayScottStep` in reaction-sim.ts.
 */
const stepFragment = (codec: string) => /* glsl */ `${header(codec)}
uniform vec2 uFeedKill;
vec2 at(ivec2 p, ivec2 m) { return fetchState(clamp(p, ivec2(0), m)); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 m = ivec2(uSize) - 1;
  vec2 c = fetchState(p);
  vec2 edges = at(p + ivec2(1, 0), m) + at(p - ivec2(1, 0), m)
    + at(p + ivec2(0, 1), m) + at(p - ivec2(0, 1), m);
  vec2 corners = at(p + ivec2(1, 1), m) + at(p + ivec2(-1, 1), m)
    + at(p + ivec2(1, -1), m) + at(p + ivec2(-1, -1), m);
  vec2 lap = ${glslFloat(LAP_EDGE)} * edges + ${glslFloat(LAP_CORNER)} * corners - c;
  float react = (1.0 - c.x) * c.y * c.y;
  float feed = uFeedKill.x;
  float kill = uFeedKill.y;
  vec2 rate = vec2(
    ${glslFloat(DA)} * lap.x + react - feed * c.x,
    ${glslFloat(DB)} * lap.y + react - (feed + kill) * c.y
  );
  outColor = encodeState(clamp(c + ${glslFloat(DT)} * rate, 0.0, 1.0));
}
`;

/** Clears the state to empty (A = 1, B = 0) and stamps the seed spots. */
const seedFragment = (codec: string) => /* glsl */ `${header(codec)}
/** Spots as (x, y in 0..1, radius in cells). */
uniform vec3 uSpots[${SPOT_COUNT}];
void main() {
  float inside = 0.0;
  for (int i = 0; i < ${SPOT_COUNT}; i++) {
    vec2 d = gl_FragCoord.xy - uSpots[i].xy * uSize;
    float r = uSpots[i].z;
    inside = max(inside, step(dot(d, d), r * r));
  }
  outColor = encodeState(inside * vec2(${glslFloat(SPOT_U)}, ${glslFloat(SPOT_B)}));
}
`;

/** Resamples the old state (uState, uSize) into a new grid with one bilinear read. */
const resampleFragment = (codec: string) => /* glsl */ `${header(codec)}
in vec2 vUv;
void main() {
  outColor = encodeState(sampleState(vUv));
}
`;

/**
 * Full-resolution display: bilinear B, a three-stop gradient map and, when
 * emboss is on, a light from the top-left on the slope of B (two more reads).
 */
const displayFragment = (codec: string) => /* glsl */ `${header(codec)}
in vec2 vUv;
/** One cell in uv. */
uniform vec2 uTexel;
uniform vec3 uColor1;
uniform vec3 uColor2;
uniform vec3 uColor3;
/** Slope gain; 0 skips the emboss reads. */
uniform float uEmboss;
${DITHER_GLSL}
/** Light direction (top-left, raised), divided by its z so a flat surface shades to 1. */
const vec3 LIGHT = vec3(-0.55, 0.55, 0.63) / 0.63;
void main() {
  float b = sampleState(vUv).y;
  float t = smoothstep(${glslFloat(RAMP_LO)}, ${glslFloat(RAMP_HI)}, b);
  vec3 c = t < 0.5 ? mix(uColor1, uColor2, t * 2.0) : mix(uColor2, uColor3, t * 2.0 - 1.0);
  if (uEmboss > 0.0) {
    float bx = sampleState(vUv + vec2(uTexel.x, 0.0)).y;
    float by = sampleState(vUv + vec2(0.0, uTexel.y)).y;
    vec3 n = normalize(vec3((b - bx) * uEmboss, (b - by) * uEmboss, 1.0));
    c *= max(dot(n, LIGHT), 0.0);
  }
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Living Turing patterns from a Gray–Scott reaction–diffusion simulation.
 *
 * The state (u = 1 - A, B) lives in two ping-ponged low-resolution targets, one
 * cell per `scale` reference pixels: RG16F when half floats are renderable
 * (EXT_color_buffer_float or EXT_color_buffer_half_float), else RGBA8 with each
 * value packed into 16 bits. Each frame runs a few simulation steps (from `speed`
 * and `dt`, capped at MAX_STEPS with the fraction carried over), then one
 * full-resolution pass gradient-maps B with an optional emboss.
 *
 * State survives resizes and grid-size changes by resampling into the new grid;
 * a pattern change just moves (F, k), which morphs the pattern in place. The state
 * is seeded on create (so also after a context loss) and when `reseed` toggles.
 */
export const reaction = defineEffect({
  id: "reaction",
  name: "Reaction–Diffusion",
  description: "Living Turing patterns (coral, spots, stripes, mazes) slowly grow and reorganise.",
  params: {
    pattern: { kind: "select", label: "Pattern", options: PATTERN_OPTIONS, default: "coral" },
    color1: { kind: "color", label: "Colour 1 (background)", default: "#0a1224" },
    color2: { kind: "color", label: "Colour 2", default: "#1f6f8b" },
    color3: { kind: "color", label: "Colour 3", default: "#f2d89b" },
    scale: { kind: "number", label: "Feature size", min: 2, max: 6, step: 0.25, default: 3 },
    speed: { kind: "number", label: "Speed (steps/s)", min: 0, max: 960, step: 10, default: 240 },
    drift: { kind: "number", label: "Drift", min: 0, max: 1, step: 0.01, default: 0.5 },
    emboss: { kind: "number", label: "Emboss", min: 0, max: 1, step: 0.01, default: 0.5 },
    reseed: { kind: "boolean", label: "Reseed (toggle)", default: false },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      // Half-float state if it's renderable here, else the packed 8-bit fallback.
      const floatExt =
        gl.getExtension("EXT_color_buffer_float") !== null ||
        gl.getExtension("EXT_color_buffer_half_float") !== null;
      let packed = true;
      if (floatExt) {
        const probe = createRenderTarget(gl, 1, 1, gl.RG16F);
        if (probe) {
          packed = false;
          probe.dispose();
        }
      }
      const codec = packed ? CODEC_PACKED : CODEC_FLOAT;
      const format = packed ? gl.RGBA8 : gl.RG16F;
      const filter = packed ? gl.NEAREST : gl.LINEAR;

      const program = (fragment: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fragment), (p) => gl.deleteProgram(p));
      const stepProgram = program(stepFragment(codec));
      const seedProgram = program(seedFragment(codec));
      const resampleProgram = program(resampleFragment(codec));
      const displayProgram = program(displayFragment(codec));
      const step = createUniforms(gl, stepProgram, ["uState", "uSize", "uFeedKill"]);
      const seed = createUniforms(gl, seedProgram, ["uSize", "uSpots"]);
      const resample = createUniforms(gl, resampleProgram, ["uState", "uSize"]);
      const display = createUniforms(gl, displayProgram, [
        "uState",
        "uSize",
        "uTexel",
        "uColor1",
        "uColor2",
        "uColor3",
        "uEmboss",
      ]);
      gl.useProgram(stepProgram);
      step.i1("uState", 0);
      gl.useProgram(resampleProgram);
      resample.i1("uState", 0);
      gl.useProgram(displayProgram);
      display.i1("uState", 0);
      gl.useProgram(null);
      const triangle = scope.own(createFullscreenTriangle(gl));

      /** The ping-pong pair; empty until the first frame, or if allocation failed. */
      let targets: RenderTarget[] = [];
      let current = 0;
      let gridW = 0;
      let gridH = 0;
      const deleteTargets = () => {
        for (const t of targets) t.dispose();
        targets = [];
      };
      scope.defer(deleteTargets);

      let width = 1;
      let height = 1;
      let scale = 1;
      const clock: StepClock = { acc: 0 };
      let phase = 0;
      let seedNo = 0;
      let reseedKey: boolean | undefined;
      const feedKill = new Float64Array(2);
      const spots = new Float32Array(SPOT_COUNT * 3);
      const INVALIDATE = [gl.COLOR_ATTACHMENT0];
      const color1 = unitRgbMemo();

      /** Writes fresh seed spots into the current target. */
      const reseed = () => {
        const dst = targets[current];
        makeSpots(++seedNo, spots);
        dst.bind();
        gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
        gl.useProgram(seedProgram);
        seed.f2("uSize", dst.width, dst.height);
        gl.uniform3fv(seed.loc.uSpots, spots);
        triangle.draw();
      };

      /**
       * Moves the state onto a `w` x `h` grid: resampled from the old grid if there
       * is one, else freshly seeded. A failed allocation keeps the old grid (or none)
       * and is not retried until the wanted size changes.
       */
      const regrid = (w: number, h: number) => {
        const a = createRenderTarget(gl, w, h, format, { filter });
        const b = a && createRenderTarget(gl, w, h, format, { filter });
        gridW = w;
        gridH = h;
        if (!a || !b) {
          a?.dispose();
          console.warn(`reaction: can't allocate a ${w}x${h} simulation grid`);
          return;
        }
        const old = targets.length === 2 ? targets[current] : null;
        if (old) {
          a.bind();
          gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
          gl.useProgram(resampleProgram);
          resample.f2("uSize", old.width, old.height);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, old.texture);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        }
        deleteTargets();
        targets = [a, b];
        current = 0;
        if (!old) reseed();
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          // One cell per `scale` reference pixels, but never smaller than a pixel.
          const cell = Math.max(1, p.scale * scale);
          const w = clamp(Math.ceil(width / cell), 1, MAX_GRID);
          const h = clamp(Math.ceil(height / cell), 1, MAX_GRID);
          if (w !== gridW || h !== gridH) regrid(w, h);
          if (targets.length < 2) {
            const c = color1(p.color1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            gl.clearColor(c[0], c[1], c[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }
          if (p.reseed !== reseedKey) {
            // The first frame only records the toggle: the grid was just seeded.
            if (reseedKey !== undefined) reseed();
            reseedKey = p.reseed;
          }

          phase = advanceDrift(phase, dt);
          driftedFeedKill(presetFor(p.pattern), p.drift, phase, feedKill);
          const n = takeSteps(clock, p.speed, dt, MAX_STEPS);
          gl.activeTexture(gl.TEXTURE0);
          if (n > 0) {
            gl.useProgram(stepProgram);
            step.f2("uSize", targets[0].width, targets[0].height);
            step.f2("uFeedKill", feedKill[0], feedKill[1]);
            for (let i = 0; i < n; i++) {
              const src = targets[current];
              current ^= 1;
              const dst = targets[current];
              dst.bind();
              // Every cell is overwritten, so tiled GPUs need not load the old contents.
              gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
              gl.bindTexture(gl.TEXTURE_2D, src.texture);
              triangle.draw();
            }
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(displayProgram);
          // The live grid, which lags the wanted size if an allocation failed.
          const grid = targets[current];
          gl.bindTexture(gl.TEXTURE_2D, grid.texture);
          display.f2("uSize", grid.width, grid.height);
          display.f2("uTexel", 1 / grid.width, 1 / grid.height);
          display.rgb("uColor1", p.color1);
          display.rgb("uColor2", p.color2);
          display.rgb("uColor3", p.color3);
          display.f1("uEmboss", p.emboss * EMBOSS_GAIN);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
