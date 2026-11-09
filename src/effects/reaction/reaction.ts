import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  withScope,
  scopedProgram,
  floatRenderable,
  createRenderTarget,
} from "../gl";
import { clamp } from "../math";
import {
  advanceCycle,
  advanceDrift,
  createCycle,
  createStats,
  cycleFront,
  DA,
  DB,
  driftedFeedKill,
  DT,
  FRONT_BAND,
  LAP_CORNER,
  LAP_EDGE,
  makeSpots,
  COVER_B,
  presetFor,
  readStats,
  resetSettle,
  restartCycle,
  RETREAT_KILL,
  sampleCycle,
  SPOT_B,
  SPOT_COUNT,
  SPOT_U,
  STATS_SIZE,
  statsTile,
  wantsSample,
} from "./reaction-sim";
import { reactionMeta } from "./reaction.meta";
import { defineEffect } from "../types";
import { type StepClock, takeSteps } from "../step-clock";
import { createPingPong } from "../gpu-sim";

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
/** Retreat front, in half-widths from the centre line (see cycleFront); negative: none. */
uniform float uFront;
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
  // Extra kill behind the retreat front (retreatKill in reaction-sim.ts).
  float d = abs(gl_FragCoord.x / uSize.x - 0.5) * 2.0;
  float kill = uFeedKill.y + ${glslFloat(RETREAT_KILL)} * clamp((uFront - d) * ${glslFloat(1 / FRONT_BAND)}, 0.0, 1.0);
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
uniform vec3 uSpots[${String(SPOT_COUNT)}];
void main() {
  float inside = 0.0;
  for (int i = 0; i < ${String(SPOT_COUNT)}; i++) {
    vec2 d = gl_FragCoord.xy - uSpots[i].xy * uSize;
    float r = uSpots[i].z;
    inside = max(inside, step(dot(d, d), r * r));
  }
  outColor = encodeState(inside * vec2(${glslFloat(SPOT_U)}, ${glslFloat(SPOT_B)}));
}
`;

/**
 * Coverage stats for the life cycle: each texel summarises a uTile-sized tile of
 * the grid as (covered fraction, largest B, 1 if the tile has cells). Run only
 * every SAMPLE_STEPS steps into a ${STATS_SIZE}x${STATS_SIZE} target and read back asynchronously.
 */
const statsFragment = (codec: string) => /* glsl */ `${header(codec)}
uniform ivec2 uTile;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * uTile;
  ivec2 m = ivec2(uSize) - 1;
  float lit = 0.0;
  float cells = 0.0;
  float top = 0.0;
  for (int y = 0; y < uTile.y; y++) {
    for (int x = 0; x < uTile.x; x++) {
      ivec2 p = o + ivec2(x, y);
      if (p.x > m.x || p.y > m.y) continue;
      float b = fetchState(p).y;
      lit += step(${glslFloat(COVER_B)}, b);
      cells += 1.0;
      top = max(top, b);
    }
  }
  outColor = cells > 0.0 ? vec4(lit / cells, top, 1.0, 1.0) : vec4(0.0);
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
 *
 * With `regrow` on, a finished pattern holds for `hold` seconds, then retreats
 * from the centre back to the sides it grew in from and, once the grid is empty,
 * reseeds with new spots (see the life cycle in reaction-sim.ts). Finished and
 * empty are judged from a coverage readback every SAMPLE_STEPS steps.
 */
export const reaction = defineEffect(reactionMeta, {
  create(gl) {
    return withScope((scope) => {
      // Half-float state if it's renderable here, else the packed 8-bit fallback.
      const packed = !floatRenderable(gl, gl.RG16F);
      const codec = packed ? CODEC_PACKED : CODEC_FLOAT;
      const format = packed ? gl.RGBA8 : gl.RG16F;
      const filter = packed ? gl.NEAREST : gl.LINEAR;

      const program = (fragment: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fragment);
      const stepProgram = program(stepFragment(codec));
      const seedProgram = program(seedFragment(codec));
      const resampleProgram = program(resampleFragment(codec));
      const displayProgram = program(displayFragment(codec));
      const statsProgram = program(statsFragment(codec));
      const step = createUniforms(gl, stepProgram, ["uState", "uSize", "uFeedKill", "uFront"]);
      const statsU = createUniforms(gl, statsProgram, ["uState", "uSize", "uTile"]);
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
      gl.useProgram(statsProgram);
      statsU.i1("uState", 0);
      gl.useProgram(null);

      // Coverage readback: a small RGBA8 target, read into a pixel-pack buffer and
      // fetched a frame or more later once its fence has signalled, so the CPU
      // never waits on the GPU.
      const statsTarget = createRenderTarget(gl, STATS_SIZE, STATS_SIZE, gl.RGBA8, {
        filter: gl.NEAREST,
      });
      if (statsTarget) {
        scope.add(statsTarget, (t) => {
          t.dispose();
        });
      }
      const statsBytes = new Uint8Array(STATS_SIZE * STATS_SIZE * 4);
      const pbo = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, statsBytes.byteLength, gl.STREAM_READ);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      /** False once a fence couldn't be made: the cycle then runs on its step fallbacks. */
      let readback = statsTarget !== null;
      let fence: WebGLSync | null = null;
      /** Reseeds so far when the pending readback was taken; stale results are dropped. */
      let fenceGeneration = 0;
      let generation = 0;
      scope.defer(() => {
        if (fence) {
          gl.deleteSync(fence);
        }
        fence = null;
      });
      const stats = createStats();
      const cycle = createCycle();
      const triangle = scope.own(createFullscreenTriangle(gl));

      /** The ping-pong pair; not ready until the first frame, or if allocation failed. */
      const pair = scope.own(createPingPong(gl, format, { filter }));

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

      /** Writes fresh seed spots into the current target and restarts the cycle. */
      const reseed = () => {
        restartCycle(cycle);
        generation++;
        const dst = pair.src;
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
        const resampled = pair.ready;
        const ok = pair.resize(w, h, {
          carry: (old, into) => {
            into.bind();
            gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
            gl.useProgram(resampleProgram);
            resample.f2("uSize", old.width, old.height);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, old.texture);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
          },
        });
        if (!ok) {
          console.warn(`reaction: can't allocate a ${String(w)}x${String(h)} simulation grid`);
        } else if (!resampled) {
          reseed();
        } else {
          // Stats in flight, and the tiles sampled so far, describe the old grid.
          generation++;
          resetSettle(cycle);
        }
      };

      /** Renders the coverage stats and starts reading them back. */
      const requestStats = (grid: RenderTarget) => {
        if (!statsTarget) {
          return;
        }
        const [tx, ty] = statsTile(grid.width, grid.height);
        statsTarget.bind();
        // Texels past the grid read back as empty tiles.
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(
          0,
          0,
          Math.min(STATS_SIZE, Math.ceil(grid.width / tx)),
          Math.min(STATS_SIZE, Math.ceil(grid.height / ty)),
        );
        gl.useProgram(statsProgram);
        statsU.f2("uSize", grid.width, grid.height);
        gl.uniform2i(statsU.loc.uTile, tx, ty);
        gl.bindTexture(gl.TEXTURE_2D, grid.texture);
        triangle.draw();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.readPixels(0, 0, STATS_SIZE, STATS_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? null;
        if (!fence) {
          readback = false;
          if (import.meta.env.DEV) {
            // oxlint-disable-next-line eslint/no-console -- dev-only diagnostics, behind import.meta.env.DEV
            console.info("reaction: no fence; cycle runs on its fallbacks");
          }
        }
        fenceGeneration = generation;
      };

      /** Collects a finished readback, if any; true if the cycle asks for a reseed. */
      const collectStats = (regrow: boolean): boolean => {
        if (!fence || gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
          return false;
        }
        gl.deleteSync(fence);
        fence = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, statsBytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        if (fenceGeneration !== generation) {
          return false;
        }
        const reseedNow = sampleCycle(cycle, readStats(statsBytes, stats), regrow);
        if (import.meta.env.DEV) {
          // oxlint-disable-next-line eslint/no-console -- dev-only diagnostics, behind import.meta.env.DEV
          console.debug(
            `reaction: ${cycle.phase}, coverage ${stats.coverage.toFixed(3)}, max B ${stats.maxB.toFixed(2)}, still ${String(cycle.still)}`,
          );
        }
        return reseedNow;
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
          if (w !== pair.width || h !== pair.height) {
            regrid(w, h);
          }
          if (!pair.ready) {
            const c = color1(p.color1);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
            gl.clearColor(c[0], c[1], c[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }
          if (p.reseed !== reseedKey) {
            // The first frame only records the toggle: the grid was just seeded.
            if (reseedKey !== undefined) {
              reseed();
            }
            reseedKey = p.reseed;
          }
          const regrow = p.regrow;

          phase = advanceDrift(phase, dt);
          driftedFeedKill(presetFor(p.pattern), p.drift, phase, feedKill);
          const n = takeSteps(clock, p.speed, dt, MAX_STEPS);
          gl.activeTexture(gl.TEXTURE0);
          if (n > 0) {
            gl.useProgram(stepProgram);
            step.f2("uSize", pair.src.width, pair.src.height);
            step.f2("uFeedKill", feedKill[0], feedKill[1]);
            step.f1("uFront", regrow ? cycleFront(cycle, pair.src.width) : -1);
            for (let i = 0; i < n; i++) {
              const { src, dst } = pair;
              pair.swap();
              dst.bind();
              // Every cell is overwritten, so tiled GPUs need not load the old contents.
              gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
              gl.bindTexture(gl.TEXTURE_2D, src.texture);
              triangle.draw();
            }
          }

          // Life cycle: grow, hold, retreat, clear, then reseed.
          const before = cycle.phase;
          let again = advanceCycle(cycle, n, dt, pair.src.width, p.hold, regrow);
          again = collectStats(regrow) || again;
          if (import.meta.env.DEV && (again || cycle.phase !== before)) {
            // Allocates only to log a phase change in development.
            // oxlint-disable-next-line eslint/no-console -- dev-only diagnostics, behind import.meta.env.DEV
            console.info(`reaction: ${before} -> ${again ? "reseed" : cycle.phase}`);
          }
          if (again) {
            reseed();
          } else if (regrow && readback && !fence && wantsSample(cycle)) {
            requestStats(pair.src);
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(displayProgram);
          // The live grid, which lags the wanted size if an allocation failed.
          const grid = pair.src;
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
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
