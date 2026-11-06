import {
  advanceCaustics,
  buildReef,
  CAUSTIC_RATES,
  createReef,
  cycleSeed,
  INSTANCE_ATTRIBUTES,
  MAX_INSTANCES,
  paletteFor,
  SLOTS,
} from "./coral-sim";
import { coralMeta, MAX_GROWTH, MIN_GROWTH } from "./coral.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createGrowthClock, GROWTH_GLSL } from "./growth";
import { createLowResTarget } from "./lowres";
import { clamp } from "./math";
import { createSpriteBatch, QUAD } from "./sprites";
import { defineEffect } from "./types";

const F = glslFloat;

/** The cycle at growth speed 1: a few minutes to grow, a hold, then a fade before the regrowth. */
const CYCLE = { grow: 240, hold: 90, melt: 25 };
/** Open part-way through the first growth, so there is coral to see straight away. */
const START = 0.4 * CYCLE.grow;
/** Water pass divisor at 1080p; it scales with the frame so its cost stays fixed. */
const WATER_DIVISOR = 2;
/** Seconds the canvas aspect must hold still before the reef is rebuilt for it. */
const RESIZE_SETTLE = 0.3;
/** Caustic cells per frame height. */
const CAUSTIC_FREQ = 11;
/** Brain-coral groove frequency, radians per 1080p pixel. */
const GROOVE_FREQ = 0.45;

/**
 * The water at reduced resolution: the depth gradient, a faint glow under the
 * surface, a sandy floor and one octave of warped-lattice caustics. Alpha carries
 * the caustic light alone, for the coral pass to sample.
 */
const WATER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res pixel to frame heights (x 0..aspect, y 0..1 up). */
uniform vec2 uToUnits;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uSand;
uniform vec3 uLight;
/** Caustic phases, each wrapped to 0..2pi. */
uniform vec4 uPhase;
/** Caustic strength (0 off). */
uniform float uCaustic;
out vec4 outColor;

float caustic(vec2 p) {
  vec2 q = p * ${F(CAUSTIC_FREQ)};
  vec2 w = q + 0.9 * vec2(sin(q.y * 0.83 + uPhase.x), sin(q.x * 0.91 + uPhase.y));
  float v = sin(w.x + uPhase.z) + sin(w.y + uPhase.w);
  float line = 1.0 - smoothstep(0.0, 0.55, abs(v));
  return line * line;
}

void main() {
  vec2 p = gl_FragCoord.xy * uToUnits;
  float y = p.y;
  vec3 c = mix(uDeep, uMid, smoothstep(0.0, 0.55, y));
  c = mix(c, uTop, smoothstep(0.45, 1.0, y));
  c += uTop * (0.18 * exp2(-(1.0 - y) * 14.0));
  float sy = 0.045 + 0.012 * sin(p.x * 3.1 + 1.3) + 0.006 * sin(p.x * 7.3 + 0.4);
  float sand = smoothstep(sy + 0.008, sy - 0.008, y);
  c = mix(c, uSand * (0.7 + 0.3 * y / sy), sand);
  // Caustics fade with height above the floor, and are strongest on the sand.
  float k = uCaustic * caustic(p) * (1.0 - smoothstep(0.1, 0.75, y));
  c += uLight * k * (0.1 + 0.25 * sand);
  outColor = vec4(c, k);
}
`;

/**
 * One coral part per instance: a capsule tapering from r0 to r1, or (kind 1) a
 * mound disc. The vertex shader clips it by arrival: a capsule's visible length
 * grows from its start point, a disc's radius from zero. Unrevealed parts
 * collapse off screen. Positions are in frame heights, y up.
 */
const CORAL_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSeg;
layout(location = 2) in vec4 aShape;
layout(location = 3) in vec4 aStyle;
layout(location = 4) in float aPale;
uniform vec2 uResolution;
/** Growth level (the reveal threshold). */
uniform float uLevel;
uniform vec3 uColors[${String(SLOTS)}];
${GROWTH_GLSL}
${TO_CLIP_GLSL}
out vec2 vLocal;
/** Visible length, start radius, end radius (px), kind. */
flat out vec4 vGeom;
/** Unit direction (px, y down). */
flat out vec2 vDir;
/** Arrival at the start and at the visible end. */
flat out vec2 vArrive;
/** Colour, then pale, fog and phase. */
flat out vec3 vColor;
flat out vec3 vTone;

void main() {
  float f = segmentReveal(aShape.z, aShape.w, uLevel);
  float h = uResolution.y;
  bool disc = aStyle.y > 0.5;
  vec2 a = vec2(aSeg.x, 1.0 - aSeg.y) * h;
  vec2 d = disc ? vec2(0.0) : (vec2(aSeg.z, 1.0 - aSeg.w) * h - a) * f;
  float r0 = aShape.x * h;
  float rEnd = disc ? r0 * f : mix(r0, aShape.y * h, f);
  float rStart = disc ? rEnd : r0;
  float len = length(d);
  vec2 dir = len > 1e-4 ? d / len : vec2(0.0, -1.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Room for the anti-aliased edge, and for a disc's bumpy rim.
  float ext = max(rStart, rEnd) * (disc ? 1.15 : 1.0) + 1.0;
  float u = aCorner.x < 0.0 ? -ext : len + ext;
  float v = aCorner.y * ext;
  vLocal = vec2(u, v);
  vGeom = vec4(len, rStart, rEnd, aStyle.y);
  vDir = dir;
  vArrive = vec2(aShape.z, mix(aShape.z, aShape.w, f));
  vColor = uColors[int(aStyle.x + 0.5)];
  vTone = vec3(aPale, aStyle.z, aStyle.w);
  gl_Position = f > 0.0 ? pxToClip(a + dir * u + nrm * v, uResolution) : vec4(2.0, 2.0, 2.0, 1.0);
}
`;

/**
 * Coral shading: anti-aliased coverage, a fake cylinder (capsule) or dome (disc)
 * normal lit from above, paler fresh growth and thin tips, brain-coral grooves on
 * discs, the caustic light from the water pass, fog towards the water behind,
 * and the fade at the end of a cycle. Output is premultiplied.
 */
const CORAL_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vGeom;
flat in vec2 vDir;
flat in vec2 vArrive;
flat in vec3 vColor;
flat in vec3 vTone;
uniform sampler2D uWater;
uniform vec2 uResolution;
/** Growth level, fade (0..1), caustic gain, groove radians per px. */
uniform vec4 uLook;
uniform vec3 uTip;
uniform vec3 uLight;
out vec4 outColor;

const vec3 LIGHT = vec3(-0.35, -0.75, 0.56);
const float TAU = 6.2831853;

void main() {
  float len = vGeom.x;
  float x = clamp(vLocal.x, 0.0, len);
  float s = len > 1e-4 ? x / len : 0.0;
  vec2 q = vec2(vLocal.x - x, vLocal.y);
  float r = mix(vGeom.y, vGeom.z, s);
  bool disc = vGeom.w > 0.5;
  float dist = length(q);
  if (disc) {
    // Lumpy outline: two low harmonics of the angle, phased per disc.
    float ang = atan(q.y, q.x) + TAU * vTone.z;
    r *= 1.0 + 0.06 * sin(3.0 * ang) + 0.035 * sin(7.0 * ang + 1.7);
  }
  float cover = clamp(r + 0.5 - dist, 0.0, 1.0);
  if (cover <= 0.0) discard;

  // Normal in the part's frame, then in screen space (y down) for the light.
  vec2 n2 = q / max(r, 0.5);
  n2 *= min(1.0, inversesqrt(max(dot(n2, n2), 1e-6)));
  float nz = sqrt(max(0.0, 1.0 - dot(n2, n2)));
  vec2 dir = vDir;
  vec2 ns = dir * n2.x + vec2(-dir.y, dir.x) * n2.y;
  float lambert = max(0.0, dot(vec3(ns, nz), LIGHT));
  vec3 c = vColor * (0.32 + 0.8 * lambert);

  if (disc) {
    vec2 g = vLocal * uLook.w;
    float groove = sin(g.x + 1.6 * sin(g.y * 0.7 + TAU * vTone.z) + 0.5 * g.y);
    c *= 1.0 - 0.22 * smoothstep(0.55, 1.0, groove) * nz;
  }

  // Fresh growth near the advancing tip is paler, as are thin tips.
  float age = uLook.x - mix(vArrive.x, vArrive.y, s);
  float pale = max(vTone.x, 1.0 - smoothstep(0.0, 0.05, age));
  c = mix(c, uTip * (0.45 + 0.6 * lambert), 0.55 * pale);

  vec4 water = texture(uWater, gl_FragCoord.xy / uResolution);
  c += uLight * (uLook.z * water.a * (0.35 + 0.65 * max(0.0, -ns.y) + 0.3 * nz));
  c = mix(c, water.rgb, vTone.y * 0.6);
  c = mix(c, water.rgb, uLook.y);
  outColor = vec4(c * cover, cover);
}
`;

/**
 * Coral growth: a reef skeleton precomputed once per cycle on the CPU (see
 * `coral-sim.ts`, about 10 ms) and revealed by the shared growth clock
 * (`growth.ts`) in the vertex shader, over low-res water with one caustic octave.
 *
 * Per frame: the water pass at 1/4 of the pixels at 4K (one fetch per pixel to
 * upscale), then a few thousand instanced capsules and discs, each pixel of coral
 * shading one water fetch and a few ALU ops. The instance buffer is uploaded
 * only when the reef is rebuilt.
 */
export const coral = defineEffect(coralMeta, {
  create(gl) {
    return withScope((scope) => {
      const waterProgram = scope.add(createProgram(gl, FULLSCREEN_VERTEX, WATER_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const coralProgram = scope.add(createProgram(gl, CORAL_VERTEX, CORAL_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const batch = scope.own(createSpriteBatch(gl, MAX_INSTANCES, INSTANCE_ATTRIBUTES, [QUAD]));
      const wu = createUniforms(gl, waterProgram, [
        "uToUnits",
        "uTop",
        "uMid",
        "uDeep",
        "uSand",
        "uLight",
        "uPhase",
        "uCaustic",
      ]);
      const cu = createUniforms(gl, coralProgram, [
        "uResolution",
        "uLevel",
        "uColors",
        "uWater",
        "uLook",
        "uTip",
        "uLight",
      ]);
      gl.useProgram(coralProgram);
      cu.i1("uWater", 1);

      const reef = createReef(MAX_INSTANCES);
      const colors = new Float32Array(SLOTS * 3);
      const phases = new Float32Array(CAUSTIC_RATES.length);
      const clock = createGrowthClock(CYCLE, START);
      let builtKey = "";
      let builtAspect = 0;
      let resizeWait = 0;
      let paletteKey = "";

      let width = 1;
      let height = 1;
      let aspect = 1;
      let scale = 1;

      return {
        resize(v) {
          width = Math.max(1, Math.floor(v.width));
          height = Math.max(1, Math.floor(v.height));
          aspect = width / height;
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          const seed = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
          const growth = Number.isFinite(p.growth) ? clamp(p.growth, MIN_GROWTH, MAX_GROWTH) : 1;
          const s = clock.advance(step, growth, p.cycle);
          advanceCaustics(phases, step);

          // Rebuild the reef for a new cycle, seed, layout param or (settled) aspect.
          if (aspect !== builtAspect) resizeWait += step;
          else resizeWait = 0;
          const cs = cycleSeed(seed, s.cycle);
          const key = `${String(cs)}|${String(p.density)}|${String(p.height)}`;
          if (key !== builtKey || resizeWait >= RESIZE_SETTLE || builtAspect === 0) {
            buildReef(cs, aspect, p.density, p.height, reef);
            batch.data.set(reef.data.subarray(0, reef.count * batch.stride));
            batch.upload(reef.count);
            builtKey = key;
            builtAspect = aspect;
            resizeWait = 0;
          }

          const pal = paletteFor(p.palette);
          const caustic = p.caustics ? 1 : 0;

          // Water, at reduced resolution.
          target.resize(width, height, Math.max(WATER_DIVISOR, Math.round(WATER_DIVISOR * scale)));
          gl.useProgram(waterProgram);
          target.bind();
          wu.f2("uToUnits", aspect / target.width, 1 / target.height);
          wu.v3("uTop", pal.top);
          wu.v3("uMid", pal.mid);
          wu.v3("uDeep", pal.deep);
          wu.v3("uSand", pal.sand);
          wu.v3("uLight", pal.light);
          wu.f4("uPhase", phases[0], phases[1], phases[2], phases[3]);
          wu.f1("uCaustic", caustic);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();

          // Coral, alpha-blended over the water, far colonies first.
          gl.useProgram(coralProgram);
          if (p.palette !== paletteKey) {
            paletteKey = p.palette;
            for (let i = 0; i < SLOTS; i++) colors.set(pal.coral[i], i * 3);
            gl.uniform3fv(cu.loc.uColors, colors);
          }
          cu.f2("uResolution", width, height);
          cu.f1("uLevel", s.level);
          cu.f4("uLook", s.level, s.melt, 0.5 * caustic, GROOVE_FREQ / scale);
          cu.v3("uTip", pal.tip);
          cu.v3("uLight", pal.light);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, target.texture);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          batch.draw(0, reef.count);
          gl.disable(gl.BLEND);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
