import { createChangeKey } from "../change-key";
import {
  buildBillowTexture,
  buildLedge,
  CAM_HEIGHT,
  createDawnClock,
  createDawnState,
  fillPeakTable,
  FOCAL,
  layoutPeaks,
  LEDGE_COLUMNS,
  LEDGE_TOP,
  ledgeWidth,
  PEAK_COLUMNS,
  peakCount,
  sampleDawn,
  SUN_RADIUS,
  SUN_X,
  sunDirection,
} from "./cloudsea-sim";
import { cloudseaMeta } from "./cloudsea.meta";
import { CLOUD_TOPS_GLSL, driftTops } from "./cloudsea-tops";
import {
  beginFrame,
  createColumnTable,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { clamp, smoothstep, wrap } from "../math";
import { defineEffect } from "../types";

const f = glslFloat;

/** The whole scene is soft; only the ledge is drawn sharp, in the blit. */
const DIVISORS = { high: 2, balanced: 3, low: 4 } as const;
/** Billow texture side. */
const BILLOW_SIZE = 128;

/** Distance haze per world unit: half the far cloud sea is haze by about 28 units. */
const HAZE_K = 0.025;
/** Drift toward the viewer and across, world units per second at `drift` 1. */
const DRIFT_Z = 0.04;
const DRIFT_X = 0.012;
/** Cirrus streak tiles per height unit, across and up, and their drift (tiles per second at drift 1). */
const CIRRUS_NX = 0.16;
const CIRRUS_NY = 2.6;
const CIRRUS_DRIFT = 0.0015;
/** How far the mist around the peaks' feet rises above the cloud line, height units. */
const MIST_HEIGHT = 0.05;
/** Phase speed of the mist's slow undulation, radians per second at drift 1. */
const MIST_SPEED = 0.05;

/**
 * Low-res pass: the dawn sky with its sun, glow and cirrus; the distant peaks
 * from the column table; and below the cloud line the cloud sea, a ray-plane
 * intersection per pixel shaded from three octaves of the billow texture (height
 * and gradient in one fetch each), faded with distance by the pixel's footprint.
 */
const SCENE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;

/** Peaks: height above the cloud line, offset from the crest, haze; across the width. */
uniform sampler2D uPeaks;
/** Billows: height, d/du, d/dv (each 0..1 for -1..1); tiles. */
uniform sampler2D uBillow;
/** Low-res px to height units (x, y), 1 / aspect, cloud line height. */
uniform vec4 uFrame;
/** Sun centre (height units), disc radius, how lit the peaks' sunny faces are. */
uniform vec4 uSun;
/** Light direction for the cloud tops (world). */
uniform vec3 uLight;
/** Billow gradient scale, glow strength, mist phase, unused. */
uniform vec4 uMisc;
/** Octave uv offsets: (0.xy, 1.xy) and (2.xy, cirrus.xy). */
uniform vec4 uOffA;
uniform vec4 uOffB;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uGlow;
uniform vec3 uLightCol;
uniform vec3 uShade;
uniform vec3 uHaze;
uniform vec3 uRock;

out vec4 outColor;

const float FOCAL = ${f(FOCAL)};
const float CAM_HEIGHT = ${f(CAM_HEIGHT)};
const float HAZE_K = ${f(HAZE_K)};
const float CIRRUS_NX = ${f(CIRRUS_NX)};
const float CIRRUS_NY = ${f(CIRRUS_NY)};
const float MIST_HEIGHT = ${f(MIST_HEIGHT)};
${CLOUD_TOPS_GLSL}

vec3 sky(vec2 p) {
  float t = clamp((p.y - uFrame.w) / (1.0 - uFrame.w), 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.4, t));
  col = mix(col, uZenith, smoothstep(0.22, 1.0, t));
  // Thin cirrus, catching the light.
  float n = textureLod(uBillow, vec2(p.x * CIRRUS_NX, p.y * CIRRUS_NY) + uOffB.zw, 0.0).r;
  float streak = smoothstep(0.66, 0.86, n) * smoothstep(0.1, 0.3, t) * (1.0 - smoothstep(0.65, 0.95, t));
  col = mix(col, uLightCol, 0.22 * streak);
  // Sun glow and disc.
  float d = length(p - uSun.xy);
  float glow = uMisc.y * (0.55 * exp(-7.0 * d) + 0.3 * exp(-2.2 * d) * (1.0 - t));
  col = mix(col, uGlow, clamp(glow, 0.0, 1.0));
  float disc = 1.0 - smoothstep(uSun.z * 0.9, uSun.z, d);
  return mix(col, mix(uGlow, vec3(1.0), 0.65), disc);
}

/** Peak table row at x (height units). */
vec4 peakAt(float x) {
  return textureLod(uPeaks, vec2(x * uFrame.z, 0.5), 0.0);
}

vec3 clouds(vec2 p, float aspect) {
  float below = uFrame.w - p.y;
  float z = FOCAL * CAM_HEIGHT / below;
  vec2 w = vec2((p.x - 0.5 * aspect) * CAM_HEIGHT / below, z);
  // World units per low-res pixel along the view: the worst axis.
  float foot = z * z * uFrame.y / (FOCAL * CAM_HEIGHT);
  vec2 g;
  float h = cloudTops(w, foot, uOffA, uOffB.xy, uMisc.x, g);
  vec3 n = normalize(vec3(-RELIEF * g.x, 1.0, -RELIEF * g.y));
  float diffuse = clamp(dot(n, uLight) * 0.6 + 0.45, 0.0, 1.0);
  float top = smoothstep(-0.6, 0.7, h);
  vec3 col = mix(uShade, uLightCol, diffuse * mix(0.4, 1.0, top));
  // Forward scatter: looking toward the sun, the billow tops glow.
  vec2 view = normalize(vec2(p.x - 0.5 * aspect, FOCAL));
  vec2 sunward = normalize(vec2(uSun.x - 0.5 * aspect, FOCAL));
  float toward = pow(max(dot(view, sunward), 0.0), 40.0) * uMisc.y;
  float haze = 1.0 - exp(-HAZE_K * z);
  // Strongest toward the distance, where the light skims the tops.
  col += uGlow * toward * (0.1 + 0.2 * top) * (0.4 + 0.6 * haze);
  col = mix(col, uHaze, haze);
  // The glow on the far cloud sea under the sun.
  return mix(col, uGlow, clamp(toward * haze * 0.6, 0.0, 1.0));
}

void main() {
  vec2 p = gl_FragCoord.xy * uFrame.xy;
  float aspect = 1.0 / uFrame.z;
  if (p.y < uFrame.w) {
    outColor = vec4(clouds(p, aspect), 1.0);
    return;
  }
  vec3 col = sky(p);
  vec4 pk = peakAt(p.x);
  float gap = uFrame.w + pk.r - p.y;
  float px = uFrame.y;
  if (gap > -2.0 * px) {
    // Slope-aware coverage, as in the misty ridges, so steep flanks don't stair-step.
    // Well inside the rock, skip the slope fetches.
    float cover = 1.0;
    if (gap < 12.0 * px) {
      float s = (peakAt(p.x + px).r - peakAt(p.x - px).r) / (2.0 * px);
      cover = clamp(gap / (px * sqrt(1.0 + s * s)) + 0.5, 0.0, 1.0);
    }
    // Sunny faces: the side of the crest toward the sun, the crest line wandering with height.
    float above = p.y - uFrame.w;
    float crest = p.x - pk.g;
    float side = sign(uSun.x - crest);
    float wander = 0.012 * sin(above * 70.0 + crest * 13.0) * smoothstep(0.0, 0.15, above);
    float lit = smoothstep(-0.004, 0.004, (pk.g + wander) * side) * uSun.w;
    vec3 rock = mix(uRock, uLightCol * 0.85, lit * (0.55 + 0.45 * smoothstep(0.0, 0.2, above)));
    rock = mix(rock, col, pk.b);
    // Feet lost in the cloud, under a slowly undulating mist line.
    float mist = 1.0 - smoothstep(-0.005, MIST_HEIGHT, above - 0.012 * sin(p.x * 17.0 + uMisc.z));
    rock = mix(rock, uHaze, mist);
    col = mix(col, rock, cover);
  }
  outColor = vec4(col, 1.0);
}
`;

/** Full-res blit: upscales the scene and draws the foreground ledge over it, sharp. */
const COMPOSITE = /* glsl */ `
uniform sampler2D uLedgeTab;
/** Ledge width (height units; 0 = off), 1 / canvas height, canvas height px, rim width px. */
uniform vec4 uLedge;
uniform vec3 uLedgeCol;
uniform vec3 uRim;

const float LEDGE_N = ${f(LEDGE_COLUMNS)};
const float LEDGE_LIMIT = ${f(LEDGE_TOP * 1.5)};

float ledgeAt(float u) {
  return textureLod(uLedgeTab, vec2((clamp(u, 0.0, 1.0) * (LEDGE_N - 1.0) + 0.5) / LEDGE_N, 0.5), 0.0).r;
}

vec4 composite(vec2 uv) {
  vec3 c = texture(uLowRes, uv).rgb;
  vec2 p = gl_FragCoord.xy * uLedge.y;
  if (uLedge.x > 0.0 && p.x < uLedge.x && p.y < LEDGE_LIMIT) {
    float u = p.x / uLedge.x;
    float h = ledgeAt(u);
    float du = 1.0 / (LEDGE_N - 1.0);
    float s = (ledgeAt(u + du) - ledgeAt(u - du)) / (2.0 * du * uLedge.x);
    // Distance to the edge in px, slope-aware.
    float d = (h - p.y) * uLedge.z / sqrt(1.0 + s * s);
    float cover = clamp(d + 0.5, 0.0, 1.0);
    float rim = 1.0 - smoothstep(0.0, uLedge.w, d);
    c = mix(c, uLedgeCol + uRim * rim, cover);
  }
  return vec4(c, 1.0);
}
`;

/**
 * A view from a mountaintop over a sea of cloud at dawn. The cloud tops are a
 * ray-plane intersection per pixel, shaded from three octaves of a tiling noise
 * texture that carries its own gradient; distant peaks rise through them from a
 * column table, and the sky runs through the dawn palette from pre-dawn to golden
 * light. Everything renders at reduced resolution except the foreground ledge,
 * which the blit draws sharp.
 */
export const cloudsea = defineEffect(cloudseaMeta, {
  create(gl) {
    return withScope((scope) => {
      const scene = scope.add(createProgram(gl, FULLSCREEN_VERTEX, SCENE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl, { composite: COMPOSITE }));
      const peakTable = scope.own(createColumnTable(gl, PEAK_COLUMNS, 4));
      const ledgeTable = scope.own(createColumnTable(gl, LEDGE_COLUMNS, 1));
      const billow = buildBillowTexture(BILLOW_SIZE, 0xc10d);
      const billowTexture = scope.add(
        createDataTexture(gl, {
          width: BILLOW_SIZE,
          height: BILLOW_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: billow.data,
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const u = createUniforms(gl, scene, [
        "uPeaks",
        "uBillow",
        "uFrame",
        "uSun",
        "uLight",
        "uMisc",
        "uOffA",
        "uOffB",
        "uZenith",
        "uMid",
        "uHorizon",
        "uGlow",
        "uLightCol",
        "uShade",
        "uHaze",
        "uRock",
      ]);
      const cu = createUniforms(gl, target.program, ["uLedgeTab", "uLedge", "uLedgeCol", "uRim"]);
      gl.useProgram(scene);
      u.i1("uPeaks", 0);
      u.i1("uBillow", 1);
      gl.useProgram(target.program);
      cu.i1("uLedgeTab", 1);
      gl.useProgram(null);

      const dawn = createDawnState();
      const clock = createDawnClock();
      const light: [number, number, number] = [0, 0, 0];
      const ledgeCol: [number, number, number] = [0, 0, 0];
      const rim: [number, number, number] = [0, 0, 0];
      /** uv offsets per octave and the cirrus, wrapped to one tile. */
      const offsets = new Float64Array(8);
      let mistPhase = 0;
      const peakKey = createChangeKey(3);
      const ledgeKey = createChangeKey(1);
      const sizeKey = createChangeKey(3);

      let width = 1;
      let height = 1;
      let scale = 1;
      /** Set by `track` when a scene uniform uploads, meaning the cached scene is stale. */
      let changed = false;
      const track = (uploaded: boolean) => {
        if (uploaded) {
          changed = true;
        }
      };

      return {
        resize(v) {
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          changed = false;
          const aspect = width / height;

          const divisor = qualityDivisor(p.quality, DIVISORS);
          sizeKey.set(0, width);
          sizeKey.set(1, height);
          sizeKey.set(2, divisor);
          if (sizeKey.take()) {
            target.resize(width, height, divisor);
            changed = true;
          }

          gl.useProgram(scene);
          gl.activeTexture(gl.TEXTURE0);
          const seed = Math.floor(clamp(p.seed, 0, 1e6));
          peakKey.set(0, peakCount(p.peaks));
          peakKey.set(1, seed);
          peakKey.set(2, aspect);
          if (peakKey.take()) {
            fillPeakTable(peakTable.data, layoutPeaks(p.peaks, seed), aspect);
            peakTable.upload();
            changed = true;
          } else {
            gl.bindTexture(gl.TEXTURE_2D, peakTable.texture);
          }
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, billowTexture);
          gl.activeTexture(gl.TEXTURE0);

          // Time of day.
          const hour = clock.step(dt, p.timeOfDay, p.cycle);
          sampleDawn(hour, dawn);
          sunDirection(aspect, dawn.sunY, light);

          // Drift, wrapped per octave to one tile of its own uv space.
          const drift = Math.max(0, p.drift);
          if (drift > 0 && dt > 0) {
            const vx = DRIFT_X * drift * dt;
            const vz = DRIFT_Z * drift * dt;
            driftTops(offsets, vx, vz);
            offsets[6] = wrap(offsets[6] + CIRRUS_DRIFT * drift * dt, 0, 1);
            mistPhase = wrap(mistPhase + MIST_SPEED * drift * dt, 0, Math.PI * 2);
          }

          const line = clamp(p.cloudLine, 0.2, 0.8);
          track(u.f4("uFrame", aspect / target.width, 1 / target.height, 1 / aspect, line));
          const sunVisible = smoothstep(-SUN_RADIUS, SUN_RADIUS * 0.5, dawn.sunY);
          track(
            u.f4(
              "uSun",
              SUN_X * aspect,
              line + dawn.sunY,
              SUN_RADIUS,
              0.35 + 0.65 * smoothstep(-0.08, 0.02, dawn.sunY),
            ),
          );
          track(u.v3("uLight", light));
          track(
            u.f4(
              "uMisc",
              billow.slopeScale,
              dawn.glowStrength * (0.6 + 0.4 * sunVisible),
              mistPhase,
              0,
            ),
          );
          track(u.f4("uOffA", offsets[0], offsets[1], offsets[2], offsets[3]));
          track(u.f4("uOffB", offsets[4], offsets[5], offsets[6], offsets[7]));
          track(u.v3("uZenith", dawn.zenith));
          track(u.v3("uMid", dawn.mid));
          track(u.v3("uHorizon", dawn.horizon));
          track(u.v3("uGlow", dawn.glow));
          track(u.v3("uLightCol", dawn.light));
          track(u.v3("uShade", dawn.shade));
          track(u.v3("uHaze", dawn.haze));
          track(u.v3("uRock", dawn.rock));

          // With nothing moving or changing, the cached scene stands.
          if (changed) {
            target.bind();
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          gl.useProgram(target.program);
          gl.activeTexture(gl.TEXTURE1);
          ledgeKey.set(0, seed);
          if (ledgeKey.take()) {
            buildLedge(ledgeTable.data, seed);
            ledgeTable.upload();
          } else {
            gl.bindTexture(gl.TEXTURE_2D, ledgeTable.texture);
          }
          gl.activeTexture(gl.TEXTURE0);
          for (let c = 0; c < 3; c++) {
            ledgeCol[c] = dawn.rock[c] * 0.4;
            rim[c] = dawn.light[c] * 0.18 * sunVisible;
          }
          cu.f4("uLedge", p.ledge ? ledgeWidth(aspect) : 0, 1 / height, height, 2.5 * scale + 0.5);
          cu.v3("uLedgeCol", ledgeCol);
          cu.v3("uRim", rim);
          target.blit();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
