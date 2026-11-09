import {
  buildFrostFieldSteps,
  cycleSeed,
  fieldSize,
  MAX_LIGHTS,
  MAX_MELT_BIAS,
  MAX_TREES,
  MELT_RADIAL,
  NEVER,
  reachLimit,
  REACH_PENALTY,
  sceneLayout,
  THICKEN,
  type FrostField,
} from "./frost-sim";
import { frostMeta, MAX_GROWTH, MIN_GROWTH } from "./frost.meta";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  updateDataTexture,
  withScope,
  scopedProgram,
} from "../gl";
import { createGrowthClock, GROWTH_GLSL, meltOffset } from "../growth";
import { createLowResTarget, lowResSize } from "../lowres";
import { clamp, smoothstep } from "../math";
import { createBackgroundBuild, createSettledValue } from "../rebuild";
import { HASH32_GLSL } from "../noise";
import { defineEffect } from "../types";
import { createChangeKey } from "../change-key";

/** The cycle at growth speed 1: a few minutes to grow, a hold, about a minute to melt. */
const CYCLE = { grow: 180, hold: 75, melt: 60 };
/** Open part-way through the first growth, so there is frost to see straight away. */
const START = 0.4 * CYCLE.grow;
/** Low-res divisors of the scene behind the glass, and of its diffused copy. */
const SCENE_DIVISOR = 4;
const DIFFUSE_DIVISOR = 16;
/** Edge softness of the scene in frame heights: out of focus, and more so behind frost. */
const SCENE_BLUR = 0.012;
const DIFFUSE_BLUR = 0.05;
/** Seconds the canvas aspect must hold still before the field is rebuilt for it. */
const RESIZE_SETTLE = 0.3;
/** Seconds the Variation slider must hold still before a new pattern is built. */
const SEED_SETTLE = 0.3;
/** CPU milliseconds per frame spent building the next field. */
const BUILD_BUDGET_MS = 2;
/**
 * Seconds a newly built pattern takes to grow in to the clock's level when it
 * replaces another mid-cycle (on open, a new seed or a new aspect), so it never
 * pops in fully formed.
 */
const REVEAL_SECONDS = 1.5;
/** Sparkle: cell size in 1080p pixels, and the period of each glint's slow rise and fall. */
const SPARKLE_CELL_PX = 7;
const SPARKLE_PERIOD = 9;

const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
/** Pixel to frame-height units (x 0..aspect, y 0..1 up). */
uniform vec2 uToUnits;
uniform float uAspect;
/** x (0..1 across), y, radius, intensity. */
uniform vec4 uLights[${String(MAX_LIGHTS)}];
uniform vec3 uLightColors[${String(MAX_LIGHTS)}];
uniform int uLightCount;
/** x (0..1 across), base y, height, distance (0 near, 1 far); far to near. */
uniform vec4 uTrees[${String(MAX_TREES)}];
uniform int uTreeCount;
/** Edge half-width in frame heights. */
uniform float uBlur;
/** Phase of the snowy ground's undulation. */
uniform float uGroundPhase;
out vec4 outColor;

const vec3 SKY_TOP = vec3(0.035, 0.07, 0.17);
const vec3 SKY_MID = vec3(0.1, 0.16, 0.33);
const vec3 HORIZON = vec3(0.29, 0.34, 0.55);
const vec3 GLOW = vec3(0.16, 0.08, 0.06);
const vec3 GROUND_FAR = vec3(0.36, 0.42, 0.6);
const vec3 GROUND_NEAR = vec3(0.5, 0.57, 0.74);
const vec3 TREE_NEAR = vec3(0.06, 0.1, 0.15);
const vec3 TREE_FAR = vec3(0.2, 0.25, 0.4);
const vec3 SNOW = vec3(0.55, 0.63, 0.8);

void main() {
  vec2 p = gl_FragCoord.xy * uToUnits;
  float y = p.y;
  vec3 c = mix(HORIZON, SKY_MID, smoothstep(0.18, 0.55, y));
  c = mix(c, SKY_TOP, smoothstep(0.5, 1.0, y));
  float g = (y - 0.22) * 8.0;
  c += GLOW * exp2(-g * g);

  float gy = 0.2 + 0.018 * sin(p.x * 2.3 + uGroundPhase) + 0.01 * sin(p.x * 5.1 + 2.0 * uGroundPhase);
  float ground = smoothstep(gy + uBlur, gy - uBlur, y);
  c = mix(c, mix(GROUND_NEAR, GROUND_FAR, clamp(y / gy, 0.0, 1.0)), ground);

  for (int i = 0; i < ${String(MAX_TREES)}; i++) {
    if (i >= uTreeCount) break;
    vec4 t = uTrees[i];
    float h = (y - t.y) / t.z;
    // Four tiers, each widest at its bottom, on a tapering cone.
    float tier = fract(h * 4.0);
    float hw = 0.32 * t.z * (1.0 - h) * (0.6 + 0.4 * (1.0 - tier));
    float blur = uBlur * (1.0 + 1.5 * t.w);
    float d = abs(p.x - t.x * uAspect) - hw;
    float cover = smoothstep(blur, -blur, d)
      * smoothstep(-blur, blur, h * t.z)
      * smoothstep(blur, -blur, (h - 1.0) * t.z);
    vec3 tc = mix(TREE_NEAR, TREE_FAR, t.w);
    tc = mix(tc, SNOW * (1.0 - 0.3 * t.w), 0.25 + 0.35 * smoothstep(0.55, 0.95, tier));
    c = mix(c, tc, cover);
  }

  for (int i = 0; i < ${String(MAX_LIGHTS)}; i++) {
    if (i >= uLightCount) break;
    vec4 l = uLights[i];
    float d = length(p - vec2(l.x * uAspect, l.y));
    float disc = smoothstep(l.z + uBlur, l.z - uBlur, d);
    float halo = exp2(-d * d / (3.0 * l.z * l.z));
    c += uLightColors[i] * l.w * (0.7 * disc + 0.3 * halo);
  }
  outColor = vec4(c, 1.0);
}
`;

const F = glslFloat;

/**
 * Full-resolution frost over the scene: three fetches of the arrival field (for
 * coverage and a bevelled normal), the scene, and where frosted the diffused scene.
 */
const COMPOSITE = /* glsl */ `
precision highp int;
uniform sampler2D uField;
uniform sampler2D uDiffuse;
/** One field texel in uv. */
uniform vec2 uFieldTexel;
/** Growth level and melt offset (see growth.ts). */
uniform vec2 uGrowth;
/** Coverage limit (edge metric), arrival per metric unit past it, melt bias per metric unit. */
uniform vec3 uReach;
uniform vec3 uTint;
/** Strength, phase (0..1), cells per device pixel. */
uniform vec3 uSparkle;
uniform uint uSparkleSeed;
${GROWTH_GLSL}
${HASH32_GLSL}
const float SOFT = 0.012;
const float INV_THICK = ${F(1 / THICKEN)};
const float BUMP = 1.3;
const float REFRACT = 0.004;
const float MILK = 0.5;
const float LIFT = 0.05;
const float EDGE = 0.16;
const float SPEC = 0.22;
const float SHADE = 0.1;
const float SPARKLE_GAIN = 1.4;
const float SPARKLE_DENSITY = 0.05;
const vec3 LIGHT = vec3(-0.46, 0.56, 0.69);
const vec3 HALFWAY = vec3(-0.25, 0.31, 0.92);
const float TAU = 6.2831853;

/** How long (in arrival units) frost has covered a texel; <= 0 where clear. */
float frostAge(vec2 f) {
  float a = f.x + uReach.y * max(0.0, uReach.x - f.y);
  return growthThreshold(uGrowth, uReach.z * f.y) - a;
}

vec4 composite(vec2 uv) {
  vec3 bg = texture(uLowRes, uv).rgb;
  float g0 = frostAge(texture(uField, uv).rg);
  if (g0 <= 0.0) return vec4(bg, 1.0);
  // Explicit LOD inside the branch: the textures have no mipmaps anyway.
  float gx = frostAge(textureLod(uField, uv + vec2(uFieldTexel.x, 0.0), 0.0).rg);
  float gy = frostAge(textureLod(uField, uv + vec2(0.0, uFieldTexel.y), 0.0).rg);
  float cover = smoothstep(0.0, SOFT, g0);
  float h0 = clamp(g0 * INV_THICK, 0.0, 1.0);
  vec2 grad = vec2(clamp(gx * INV_THICK, 0.0, 1.0), clamp(gy * INV_THICK, 0.0, 1.0)) - h0;
  vec3 n = normalize(vec3(-grad * BUMP, 1.0));

  vec3 diff = textureLod(uDiffuse, uv + n.xy * REFRACT, 0.0).rgb;
  vec3 ice = mix(diff, uTint * 0.8, MILK) + LIFT;
  vec3 c = mix(bg, ice, cover * (0.5 + 0.4 * h0));
  float spec = max(dot(n, HALFWAY), 0.0);
  spec *= spec;
  spec *= spec;
  spec *= spec;
  c += uTint * cover * (EDGE * (1.0 - h0) + SPEC * spec + SHADE * (dot(n, LIGHT) - LIGHT.z));

  vec2 cp = gl_FragCoord.xy * uSparkle.z;
  vec2 cell = floor(cp);
  uint hs = hash32(uint(cell.x) * 0x9e3779b1u ^ hash32(uint(cell.y) ^ uSparkleSeed));
  if (float(hs & 0xffffu) < SPARKLE_DENSITY * 65535.0) {
    float s = max(0.0, sin(TAU * (uSparkle.y + float(hs >> 16u) * (1.0 / 65535.0))));
    s *= s;
    s *= s;
    s *= s;
    vec2 q = fract(cp) - 0.5;
    c += uTint * (uSparkle.x * SPARKLE_GAIN * s * exp2(-40.0 * dot(q, q)) * cover * h0);
  }
  return vec4(c, 1.0);
}
`;

/**
 * Frost ferns: a precomputed arrival-time field (built on the CPU once per cycle,
 * see `frost-sim.ts`) revealed by the shared growth clock (`growth.ts`), over a
 * blurred winter scene that is drawn only when it changes.
 *
 * Per frame: one full-screen composite. Clear pixels cost a field fetch and a
 * scene fetch; frosted pixels add two field fetches for the bevel normal and one
 * fetch of the diffused scene, plus a hash for the sparkle.
 */
export const frost = defineEffect(frostMeta, {
  create(gl) {
    return withScope((scope) => {
      const sceneProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, SCENE_FRAGMENT);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const su = createUniforms(gl, sceneProgram, [
        "uToUnits",
        "uAspect",
        "uLights",
        "uLightColors",
        "uLightCount",
        "uTrees",
        "uTreeCount",
        "uBlur",
        "uGroundPhase",
      ]);
      const cu = createUniforms(gl, target.program, [
        "uField",
        "uDiffuse",
        "uFieldTexel",
        "uGrowth",
        "uReach",
        "uTint",
        "uSparkle",
        "uSparkleSeed",
      ]);
      gl.useProgram(target.program);
      cu.i1("uField", 1);
      cu.i1("uDiffuse", 2);

      let diffuse: RenderTarget | null = null;
      scope.defer(() => diffuse?.dispose());
      let fieldTex: WebGLTexture | null = null;
      scope.defer(() => {
        if (fieldTex) {
          gl.deleteTexture(fieldTex);
        }
      });
      /** No frost anywhere: shown until the first field lands, and while a new cycle's builds. */
      const emptyField = scope.add(
        createDataTexture(gl, {
          width: 1,
          height: 1,
          internalFormat: gl.RG16F,
          format: gl.RG,
          type: gl.FLOAT,
          data: new Float32Array([NEVER, 0]),
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );
      let fieldW = 1;
      let fieldH = 1;
      /** What the uploaded field was built for: seed and size, and the cycle. */
      let appliedBase = Number.NaN;
      let appliedCycle = Number.NaN;
      /** The next cycle's field, built ahead so the cycle boundary only uploads it. */
      let next: { base: number; cycle: number; field: FrostField } | null = null;
      // The field is built a little each frame (about 100 ms of work in all), never in one go.
      // Each build's key is a new number, taken when the base or the cycle wanted changes.
      const build = createBackgroundBuild<number, FrostField>();
      let buildId = 0;
      let buildBase = Number.NaN;
      let buildCycle = Number.NaN;
      const settledSeed = createSettledValue<number>(SEED_SETTLE);
      const settledSize = createSettledValue<number>(RESIZE_SETTLE);
      let reveal = 0;

      const clock = createGrowthClock(CYCLE, START);
      let sparklePhase = 0;

      let width = 1;
      let height = 1;
      let aspect = 1;
      let scale = 1;
      /** The field size the frame's shape wants, packed as width * 65536 + height. */
      const packedFieldSize = (a: number) => {
        const want = fieldSize(a);
        return want.width * 65536 + want.height;
      };
      let wantSize = packedFieldSize(aspect);
      const sceneKey = createChangeKey(5);

      const applyField = (field: FrostField, base: number, cycle: number) => {
        const { width: w, height: h } = field;
        if (fieldTex && w === fieldW && h === fieldH) {
          gl.activeTexture(gl.TEXTURE0);
          updateDataTexture(gl, fieldTex, w, h, gl.RG, gl.FLOAT, field.data);
          gl.bindTexture(gl.TEXTURE_2D, null);
        } else {
          if (fieldTex) {
            gl.deleteTexture(fieldTex);
          }
          fieldTex = null;
          fieldTex = createDataTexture(gl, {
            width: w,
            height: h,
            internalFormat: gl.RG16F,
            format: gl.RG,
            type: gl.FLOAT,
            data: field.data,
          });
        }
        // A different pattern mid-cycle grows in; the next cycle's starts from nothing anyway.
        if (base !== appliedBase) {
          reveal = 0;
        }
        fieldW = w;
        fieldH = h;
        appliedBase = base;
        appliedCycle = cycle;
      };
      /** Steps the build of `base`'s field for `cycle`, and returns it once it completes. */
      const stepBuild = (base: number, seed: number, cycle: number, w: number, h: number) => {
        if (build.building === undefined || base !== buildBase || cycle !== buildCycle) {
          buildBase = base;
          buildCycle = cycle;
          buildId++;
          build.request(buildId, () => buildFrostFieldSteps(cycleSeed(seed, cycle), w, h));
        }
        return build.step(BUILD_BUDGET_MS);
      };

      const drawScene = (scene: string, seed: number, w: number, h: number) => {
        const layout = sceneLayout(scene, seed);
        gl.useProgram(sceneProgram);
        gl.uniform4fv(su.loc.uLights, layout.lights);
        gl.uniform3fv(su.loc.uLightColors, layout.lightColors);
        su.i1("uLightCount", layout.lightCount);
        gl.uniform4fv(su.loc.uTrees, layout.trees);
        su.i1("uTreeCount", layout.treeCount);
        su.f1("uAspect", aspect);
        su.f1("uGroundPhase", (seed % 97) * 0.37);
        target.bind();
        su.f2("uToUnits", aspect / target.width, 1 / target.height);
        su.f1("uBlur", SCENE_BLUR);
        triangle.draw();
        if (diffuse) {
          diffuse.bind();
          su.f2("uToUnits", aspect / w, 1 / h);
          su.f1("uBlur", DIFFUSE_BLUR);
          triangle.draw();
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.floor(v.width));
          height = Math.max(1, Math.floor(v.height));
          aspect = width / height;
          scale = v.scale > 0 ? v.scale : height / 1080;
          wantSize = packedFieldSize(aspect);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const seed = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;

          // Scene targets: redraw only when the scene, the seed or a size changes.
          target.resize(width, height, SCENE_DIVISOR);
          const dw = lowResSize(width, DIFFUSE_DIVISOR);
          const dh = lowResSize(height, DIFFUSE_DIVISOR);
          if (!diffuse || diffuse.width !== dw || diffuse.height !== dh) {
            diffuse?.dispose();
            diffuse = null;
            diffuse = createRenderTarget(gl, dw, dh, gl.RGBA8);
            sceneKey.invalidate();
          }
          sceneKey.setText(0, p.scene);
          sceneKey.set(1, seed);
          sceneKey.set(2, target.width);
          sceneKey.set(3, target.height);
          sceneKey.set(4, aspect);
          if (sceneKey.take()) {
            drawScene(p.scene, seed, dw, dh);
          }

          // Growth clock, and the field for this cycle and frame shape.
          const growth = Number.isFinite(p.growth) ? clamp(p.growth, MIN_GROWTH, MAX_GROWTH) : 1;
          const s = clock.advance(step, growth, p.cycle);
          // Seed and aspect are debounced, so dragging the slider or the window builds once.
          const size = settledSize.update(wantSize, step);
          const fw = Math.floor(size / 65536);
          const fh = size % 65536;
          const fieldSeed = settledSeed.update(seed, step);
          // Seed and size in one number: the size fits in 32 bits.
          const base = fieldSeed * 4294967296 + size;
          if (appliedBase !== base || appliedCycle !== s.cycle) {
            if (next?.base === base && next.cycle === s.cycle) {
              applyField(next.field, base, s.cycle);
              next = null;
            } else {
              const field = stepBuild(base, fieldSeed, s.cycle, fw, fh);
              if (field) {
                applyField(field, base, s.cycle);
              }
            }
          } else if (p.cycle && (next?.base !== base || next.cycle !== s.cycle + 1)) {
            const field = stepBuild(base, fieldSeed, s.cycle + 1, fw, fh);
            if (field) {
              next = { base, cycle: s.cycle + 1, field };
            }
          }
          // The old pattern stays, stretched if need be, until a new seed's or size's lands;
          // a new cycle's pattern would only regrow the old one, so show none until it lands.
          const shown =
            fieldTex !== null && (appliedCycle === s.cycle || appliedBase !== base)
              ? fieldTex
              : emptyField;
          reveal = Math.min(1, reveal + step / REVEAL_SECONDS);
          const level = s.level * smoothstep(0, 1, reveal);
          sparklePhase = (sparklePhase + step / SPARKLE_PERIOD) % 1;

          gl.useProgram(target.program);
          cu.f2("uFieldTexel", 1 / fieldW, 1 / fieldH);
          cu.f2("uGrowth", level, meltOffset(s.melt, MAX_MELT_BIAS));
          cu.f3("uReach", reachLimit(p.coverage), REACH_PENALTY, MELT_RADIAL);
          cu.rgb("uTint", p.tint);
          const sparkle = Number.isFinite(p.sparkle) ? clamp(p.sparkle, 0, 1) : 0;
          cu.f3("uSparkle", sparkle, sparklePhase, 1 / (SPARKLE_CELL_PX * scale));
          cu.u1("uSparkleSeed", cycleSeed(fieldSeed, s.cycle));
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, shown);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, diffuse?.texture ?? null);
          target.blit();
          // Unbind the targets' textures so they are never sampled while rendered to.
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
