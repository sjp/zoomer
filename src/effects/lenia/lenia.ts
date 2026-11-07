import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  resetUnpackState,
  updateDataTexture,
  withScope,
} from "../gl";
import {
  advanceLife,
  buildPaletteLut,
  createLife,
  type FieldStats,
  gridSize,
  isLightPalette,
  judgeStats,
  LUT_SIZE,
  MAX_STEP_RATE,
  MIXED_SECONDS,
  PATCH_SIZE,
  packState,
  pickSpawnSpot,
  readStats,
  restartLife,
  RULES,
  type RuleId,
  seedField,
  spawnPatch,
  speciesFor,
  STATS_SECONDS,
  STATS_SIZE,
  statsTile,
  type StepClock,
  takeSteps,
  TAPS,
  TRAIL_STEPS,
} from "./lenia-sim";
import { leniaMeta } from "./lenia.meta";
import { createRng } from "../noise";
import { defineEffect } from "../types";

/**
 * Decoding the RGBA8 state: A is 16 bits (r = high byte, g = low byte), b is the
 * trail. The decode is linear in r and g, so it holds for linearly filtered
 * samples too: a filtered fetch between two cells decodes to the same mix of
 * their A values.
 */
const DECODE_GLSL = /* glsl */ `
float decodeA(vec4 t) {
  return dot(t.rg, vec2(${glslFloat(65280 / 65535)}, ${glslFloat(255 / 65535)}));
}
`;

/**
 * One Lenia step per cell: U = K * A from the tap table (each pair read with one
 * linear fetch on either side of the cell, see `buildTaps`), then
 * A' = clamp(A + dt * G(U)), packed back into 16 bits. The trail keeps the larger
 * of A' and its old value less a fixed fade. Mirrors `leniaStep` in lenia-sim.ts.
 */
const STEP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uState;
/** 1 / grid size. */
uniform vec2 uInvSize;
/** Per pair: x offset (fractional), y offset, weight. */
uniform vec3 uTaps[${String(TAPS.count)}];
uniform float uMu;
/** 1 / (2 sigma^2). */
uniform float uGrowthK;
uniform float uDt;
out vec4 outColor;
${DECODE_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy;
  float u = 0.0;
  for (int i = 0; i < ${String(TAPS.count)}; i++) {
    vec3 t = uTaps[i];
    u += t.z * (decodeA(texture(uState, (p + t.xy) * uInvSize))
      + decodeA(texture(uState, (p - t.xy) * uInvSize)));
  }
  vec4 self = round(texelFetch(uState, ivec2(p), 0) * 255.0) * (1.0 / 255.0);
  float d = u - uMu;
  float a = clamp(decodeA(self) + uDt * (2.0 * exp(-d * d * uGrowthK) - 1.0), 0.0, 1.0);
  float q = round(a * 65535.0);
  float hi = floor(q * (1.0 / 256.0));
  float trail = max(a, self.b - ${glslFloat(1 / TRAIL_STEPS)});
  outColor = vec4(hi * (1.0 / 255.0), (q - hi * 256.0) * (1.0 / 255.0), trail, 1.0);
}
`;

/**
 * Stats for the life cycle: each texel summarises a uTile-sized tile of the grid
 * as (mean A, largest A, 1 if the tile has cells), read back asynchronously.
 */
const STATS_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uState;
uniform ivec2 uTile;
uniform ivec2 uSize;
out vec4 outColor;
${DECODE_GLSL}
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * uTile;
  float sum = 0.0;
  float top = 0.0;
  float cells = 0.0;
  for (int y = 0; y < uTile.y; y++) {
    for (int x = 0; x < uTile.x; x++) {
      ivec2 p = o + ivec2(x, y);
      if (p.x >= uSize.x || p.y >= uSize.y) continue;
      float a = decodeA(texelFetch(uState, p, 0));
      sum += a;
      top = max(top, a);
      cells += 1.0;
    }
  }
  outColor = cells > 0.0 ? vec4(sum / cells, top, 1.0, 1.0) : vec4(0.0);
}
`;

/** Offset of the four glow / slope taps, in cells. */
const GLOW_CELLS = 1.5;

/**
 * Full-resolution composite. A smooth (cubic B-spline) upscale of A and the
 * trail, interpolated between the previous and current step so motion stays
 * smooth at low step rates (four bilinear fetches from each); four more
 * bilinear fetches of the current state GLOW_CELLS away
 * give a soft glow (their mean) and the slope for the emboss (their
 * differences). Density maps through the palette, scaled by the life cycle's
 * fade, then the emboss shades it as lit from the top left; plus dither.
 */
const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uState;
/** The state one step earlier. */
uniform sampler2D uPrev;
uniform sampler2D uPalette;
/** Grid size in cells. */
uniform vec2 uSize;
/** How far from the previous state to the current one to show, 0..1. */
uniform float uMix;
uniform float uTrail;
uniform float uFade;
uniform float uEmboss;
out vec4 outColor;
${DECODE_GLSL}
${DITHER_GLSL}
vec2 at(vec2 cell) {
  vec4 t = texture(uState, cell / uSize);
  return vec2(decodeA(t), t.b);
}
vec2 atMixed(vec2 cell) {
  vec2 uv = cell / uSize;
  vec4 t = mix(texture(uPrev, uv), texture(uState, uv), uMix);
  return vec2(decodeA(t), t.b);
}
/** Cubic B-spline sample at a position in cells (GPU Gems 2, ch. 20). */
vec2 cubic(vec2 pos) {
  vec2 p = pos - 0.5;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 f2 = f * f;
  vec2 f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1;
  vec2 g1 = w2 + w3;
  vec2 h0 = i - 0.5 + w1 / g0;
  vec2 h1 = i + 1.5 + w3 / g1;
  return g0.y * (g0.x * atMixed(h0) + g1.x * atMixed(vec2(h1.x, h0.y)))
    + g1.y * (g0.x * atMixed(vec2(h0.x, h1.y)) + g1.x * atMixed(h1));
}
const vec3 LIGHT = vec3(-0.55, 0.55, 0.63) / 0.63;
void main() {
  vec2 pos = vUv * uSize;
  vec2 s = cubic(pos);
  float l = at(pos - vec2(${glslFloat(GLOW_CELLS)}, 0.0)).x;
  float r = at(pos + vec2(${glslFloat(GLOW_CELLS)}, 0.0)).x;
  float d = at(pos - vec2(0.0, ${glslFloat(GLOW_CELLS)})).x;
  float u = at(pos + vec2(0.0, ${glslFloat(GLOW_CELLS)})).x;
  float glow = 0.25 * (l + r + d + u);
  float v = max(s.x, s.y * uTrail) + 0.3 * glow;
  float t = clamp(v * uFade, 0.0, 1.0);
  vec3 c = texture(uPalette, vec2(t * ${glslFloat((LUT_SIZE - 1) / LUT_SIZE)} + ${glslFloat(0.5 / LUT_SIZE)}, 0.5)).rgb;
  vec3 n = normalize(vec3((l - r) * uEmboss, (d - u) * uEmboss, 1.0));
  c *= clamp(dot(n, LIGHT), 0.6, 1.4);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Emboss slope gain per unit of A difference across the glow taps (fades with uFade). */
const EMBOSS = 2.5;
/** Weight of the trail against the creatures at trail 1. */
const TRAIL_WEIGHT = 0.5;

/**
 * Lenia: a continuous cellular automaton whose gliders and rotators drift
 * across the frame (see lenia-sim.ts for the model and its sources).
 *
 * The field is a ping-pong pair of RGBA8 targets GRID_W cells across, A packed
 * into 16 bits plus an 8-bit trail, so it runs without float render targets and
 * filters in hardware (the decode is linear). Each frame runs at most one step,
 * at `speed` * MAX_STEP_RATE steps per second: one fragment per cell sums the
 * ring kernel from a uniform tap table. A full-resolution composite upscales the
 * field smoothly and maps it through a palette with a glow and an emboss.
 *
 * Every STATS_SECONDS the field is summarised per tile into a small target and
 * read back asynchronously (pixel-pack buffer and fence). The life cycle fades
 * the field out and reseeds it when it dies or fills up (and, for "mixed",
 * every MIXED_SECONDS with the next rule); while it lives, missing creatures are
 * topped up by writing fresh seed patches into empty tiles.
 */
export const lenia = defineEffect(leniaMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = (fragment: string) =>
        scope.add(createProgram(gl, FULLSCREEN_VERTEX, fragment), (p) => {
          gl.deleteProgram(p);
        });
      const stepProgram = program(STEP_FRAGMENT);
      const statsProgram = program(STATS_FRAGMENT);
      const compositeProgram = program(COMPOSITE_FRAGMENT);
      const step = createUniforms(gl, stepProgram, [
        "uState",
        "uInvSize",
        "uTaps",
        "uMu",
        "uGrowthK",
        "uDt",
      ]);
      const stats = createUniforms(gl, statsProgram, ["uState", "uTile", "uSize"]);
      const composite = createUniforms(gl, compositeProgram, [
        "uState",
        "uPrev",
        "uPalette",
        "uSize",
        "uMix",
        "uTrail",
        "uFade",
        "uEmboss",
      ]);
      gl.useProgram(stepProgram);
      step.i1("uState", 0);
      gl.uniform3fv(step.loc.uTaps, TAPS.data);
      gl.useProgram(statsProgram);
      stats.i1("uState", 0);
      gl.useProgram(compositeProgram);
      composite.i1("uState", 0);
      composite.i1("uPalette", 1);
      composite.i1("uPrev", 2);
      gl.useProgram(null);

      const triangle = scope.own(createFullscreenTriangle(gl));
      const lutBytes = new Uint8Array(LUT_SIZE * 4);
      let paletteKey = "bioluminescent";
      const lut = scope.add(
        createDataTexture(gl, {
          width: LUT_SIZE,
          height: 1,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPaletteLut(paletteKey, lutBytes),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      // Stats readback: a small RGBA8 target, read into a pixel-pack buffer and
      // collected a frame or more later once its fence has signalled.
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
      let readback = statsTarget !== null;
      let fence: WebGLSync | null = null;
      let fenceGeneration = 0;
      let generation = 0;
      scope.defer(() => {
        if (fence) {
          gl.deleteSync(fence);
        }
        fence = null;
      });
      const fieldStats: FieldStats = { mean: 0, max: 0 };
      const life = createLife();

      /** The ping-pong pair; empty until the first frame, or if allocation failed. */
      let targets: RenderTarget[] = [];
      let current = 0;
      let gridW = 0;
      let gridH = 0;
      const deleteTargets = () => {
        for (const t of targets) {
          t.dispose();
        }
        targets = [];
      };
      scope.defer(deleteTargets);
      let field = new Float32Array(0);
      let fieldBytes = new Uint8Array(0);
      const patch = new Float32Array(PATCH_SIZE * PATCH_SIZE);
      const patchBytes = new Uint8Array(PATCH_SIZE * PATCH_SIZE * 4);
      const spot = new Int32Array(2);

      let width = 1;
      let height = 1;
      const clock: StepClock = { acc: 0 };
      let seedNo = 0;
      /** Index into the species' rule list, advanced on each reseed. */
      let ruleIndex = 0;
      let ruleId: RuleId = "orbium";
      let statsTimer = 0;
      let spawnRng = createRng(1);
      /** The params the field was seeded with; a change fades out and reseeds. */
      let seededSpecies = "";
      let seededCount = 0;
      let seededSeed = 0;
      const remember = (species: string, count: number, seed: number) => {
        seededSpecies = species;
        seededCount = count;
        seededSeed = seed;
      };
      const INVALIDATE = [gl.COLOR_ATTACHMENT0];

      /** Uploads `bytes` (RGBA8) into a state texture at (x, y). */
      const upload = (
        target: RenderTarget,
        x: number,
        y: number,
        w: number,
        h: number,
        bytes: Uint8Array,
      ) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, target.texture);
        resetUnpackState(gl);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        gl.bindTexture(gl.TEXTURE_2D, null);
      };

      /** Seeds a fresh field for the params and restarts the life cycle. */
      const reseed = (species: string, count: number, seed: number) => {
        const sp = speciesFor(species);
        ruleId = sp.rules[ruleIndex % sp.rules.length];
        seedNo++;
        const s = seed * 1000 + seedNo;
        seedField(s, ruleId, sp.soup, count, gridW, gridH, field);
        packState(field, fieldBytes);
        // Both targets, so the composite's interpolation starts from the new field.
        for (const t of targets) {
          upload(t, 0, 0, gridW, gridH, fieldBytes);
        }
        spawnRng = createRng(s + 17);
        restartLife(life);
        statsTimer = 0;
        generation++;
      };

      const regrid = (w: number, h: number) => {
        deleteTargets();
        gridW = w;
        gridH = h;
        const opts = { filter: gl.LINEAR, wrap: gl.REPEAT };
        const a = createRenderTarget(gl, w, h, gl.RGBA8, opts);
        const b = a && createRenderTarget(gl, w, h, gl.RGBA8, opts);
        if (!a || !b) {
          a?.dispose();
          console.warn(`lenia: can't allocate a ${String(w)}x${String(h)} grid`);
          return;
        }
        targets = [a, b];
        current = 0;
        field = new Float32Array(w * h);
        fieldBytes = new Uint8Array(w * h * 4);
      };

      /** Renders the tile stats and starts reading them back. */
      const requestStats = () => {
        if (!statsTarget) {
          return;
        }
        const [tx, ty] = statsTile(gridW, gridH);
        statsTarget.bind();
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.viewport(
          0,
          0,
          Math.min(STATS_SIZE, Math.ceil(gridW / tx)),
          Math.min(STATS_SIZE, Math.ceil(gridH / ty)),
        );
        gl.useProgram(statsProgram);
        gl.uniform2i(stats.loc.uTile, tx, ty);
        gl.uniform2i(stats.loc.uSize, gridW, gridH);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, targets[current].texture);
        triangle.draw();
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.readPixels(0, 0, STATS_SIZE, STATS_SIZE, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? null;
        if (!fence) {
          readback = false;
        }
        fenceGeneration = generation;
      };

      /** Collects a finished readback, if any; true if fresh stats arrived. */
      const collectStats = (): boolean => {
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
        readStats(statsBytes, fieldStats);
        return true;
      };

      /** Writes one fresh seed patch into an empty part of the field, if there is one. */
      const spawn = (soup: boolean) => {
        if (!pickSpawnSpot(statsBytes, gridW, gridH, spawnRng, spot)) {
          return;
        }
        spawnPatch(spawnRng(), ruleId, soup, patch);
        // The current target only: the composite blends the patch in over one step.
        packState(patch, patchBytes);
        upload(targets[current], spot[0], spot[1], PATCH_SIZE, PATCH_SIZE, patchBytes);
        life.quiet = 0;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const [w, h] = gridSize(width, height);
          const count = Math.round(p.count);
          const same =
            p.species === seededSpecies && count === seededCount && p.seed === seededSeed;
          if (w !== gridW || h !== gridH) {
            regrid(w, h);
            if (targets.length === 2) {
              ruleIndex = 0;
              reseed(p.species, count, p.seed);
              remember(p.species, count, p.seed);
            }
          }

          if (p.palette !== paletteKey) {
            paletteKey = p.palette;
            gl.activeTexture(gl.TEXTURE1);
            updateDataTexture(
              gl,
              lut,
              LUT_SIZE,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              buildPaletteLut(paletteKey, lutBytes),
            );
            gl.bindTexture(gl.TEXTURE_2D, null);
            gl.activeTexture(gl.TEXTURE0);
          }
          if (targets.length < 2) {
            gl.clearColor(lutBytes[0] / 255, lutBytes[1] / 255, lutBytes[2] / 255, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }

          // Life cycle: a param change or the "mixed" timer fades out, then reseeds.
          const sp = speciesFor(p.species);
          if (!same && life.phase !== "out") {
            life.phase = "out";
          }
          const cycle = sp.rules.length > 1 ? MIXED_SECONDS : 0;
          if (advanceLife(life, dt, cycle)) {
            // Same params: move on to the species' next rule. New params: start over.
            ruleIndex = same ? ruleIndex + 1 : 0;
            reseed(p.species, count, p.seed);
            remember(p.species, count, p.seed);
          }
          if (collectStats()) {
            const n = judgeStats(life, fieldStats, count, ruleId, gridW * gridH);
            for (let i = 0; i < n; i++) {
              spawn(sp.soup);
            }
          }

          const rule = RULES[ruleId];
          if (takeSteps(clock, p.speed * MAX_STEP_RATE, dt, 1) > 0) {
            const src = targets[current];
            current ^= 1;
            const dst = targets[current];
            dst.bind();
            gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE);
            gl.useProgram(stepProgram);
            step.f2("uInvSize", 1 / gridW, 1 / gridH);
            step.f1("uMu", rule.mu);
            step.f1("uGrowthK", 1 / (2 * rule.sigma * rule.sigma));
            step.f1("uDt", 1 / rule.T);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, src.texture);
            triangle.draw();
            gl.bindTexture(gl.TEXTURE_2D, null);
            life.quiet++;
          }

          statsTimer += dt;
          if (readback && !fence && statsTimer >= STATS_SECONDS) {
            statsTimer = 0;
            requestStats();
          }

          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(compositeProgram);
          composite.f2("uSize", gridW, gridH);
          composite.f1("uMix", clock.acc);
          composite.f1("uTrail", p.trail * TRAIL_WEIGHT);
          composite.f1("uFade", life.fade);
          composite.f1("uEmboss", EMBOSS * life.fade * (isLightPalette(paletteKey) ? 0.6 : 1));
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, targets[current ^ 1].texture);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, lut);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, targets[current].texture);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
