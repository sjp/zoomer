import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  updateDataTexture,
  withScope,
} from "./gl";
import { QUALITY_OPTIONS } from "./lowres";
import { HASH32_GLSL } from "./noise";
import {
  advancePhase,
  bodyFromView,
  buildClouds,
  buildSurface,
  CLOUD_H,
  CLOUD_RATE,
  CLOUD_SOFT,
  CLOUD_W,
  cloudShaping,
  FRAMING_OPTIONS,
  mulMat3,
  planetLayout,
  sunDirection,
  sunSide,
  SURFACE_H,
  SURFACE_W,
  TURN_SECONDS,
  WORLD_OPTIONS,
  worldStyle,
} from "./planet-sim";
import { defineEffect } from "./types";

const f = glslFloat;

/** Halo e-folding width outside the disc, as a fraction of the planet radius. */
const HALO_WIDTH = 0.018;
/** Star grid cell (1080p px; at most one star per cell) and the share of cells with a star. */
const STAR_CELL = 9;
const STAR_SHARE = 0.08;
/** Star Gaussian radius (1080p px). */
const STAR_SIGMA = 0.6;
/** City lights at full density and `cities` = 1. */
const CITY_GAIN = 1.4;

const BODY = bodyFromView();
const row = (i: number) => `vec3(${f(BODY[i])}, ${f(BODY[i + 1])}, ${f(BODY[i + 2])})`;

/**
 * One full-screen pass. Per pixel: an analytic orthographic ray-sphere hit, the
 * hit normal tilted into body space, longitude (atan) and latitude (asin), then
 * one surface and one cloud fetch with explicit gradients (the atan wrap would
 * otherwise drop a seam pixel to the smallest mip). Outside the disc: hashed stars
 * and the atmosphere halo.
 */
const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** hash32 needs full 32-bit uints. */
precision highp int;
precision mediump sampler2D;
uniform sampler2D uSurface;
uniform sampler2D uClouds;
/** Disc centre and radius, in px (gl_FragCoord space). */
uniform vec3 uDisc;
/** Surface and cloud rotation, in turns, wrapped to [0, 1). */
uniform vec2 uPhase;
/** Towards the sun: view space, body space, and the Blinn half vector (view space). */
uniform vec3 uSun;
uniform vec3 uSunBody;
uniform vec3 uHalf;
/** Cloud threshold and opacity (0 skips the cloud fetch). */
uniform vec2 uCloud;
/** City-light gain, specular gain. */
uniform vec2 uGain;
uniform vec3 uAtmoDay;
uniform vec3 uAtmoSet;
/** 1 / halo e-folding width, px^-1. */
uniform float uHaloK;
/** Star cell (px), presence threshold (of 256), 1 / (2 sigma^2) (px^-2). */
uniform vec3 uStar;
out vec4 outColor;

const float INV_TAU = 0.15915494309189535;
const float INV_PI = 0.3183098861837907;
const vec3 BX = ${row(0)};
const vec3 BY = ${row(3)};
const vec3 BZ = ${row(6)};
const vec3 SPACE = vec3(0.004, 0.005, 0.01);
const vec3 AMBIENT = vec3(0.008, 0.01, 0.016);
const vec3 SUNSET = vec3(1.0, 0.55, 0.32);
const vec3 CITY = vec3(1.0, 0.66, 0.3);
const vec3 STAR = vec3(0.86, 0.9, 1.0);

${HASH32_GLSL}
${DITHER_GLSL}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 d = fc - uDisc.xy;
  float r = length(d);
  float R = uDisc.z;
  // Inside: the hit normal. Outside: the limb normal at the ray's closest approach.
  vec2 e = d / max(r, R);
  vec3 N = vec3(e, sqrt(max(1.0 - dot(e, e), 0.0)));
  vec3 B = vec3(dot(BX, N), dot(BY, N), dot(BZ, N));
  float u = atan(B.x, B.z) * INV_TAU;
  float v = asin(clamp(B.y, -1.0, 1.0)) * INV_PI + 0.5;
  // Gradients in uniform control flow; u's jump at the atan wrap is removed.
  vec2 gx = vec2(dFdx(u), dFdx(v));
  vec2 gy = vec2(dFdy(u), dFdy(v));
  gx.x -= floor(gx.x + 0.5);
  gy.x -= floor(gy.x + 0.5);

  float ndl = dot(N, uSun);
  float cover = clamp(R - r + 0.5, 0.0, 1.0);
  vec3 atmo = mix(uAtmoSet, uAtmoDay, smoothstep(0.0, 0.45, ndl)) * smoothstep(-0.3, 0.05, ndl);
  float glow = r < R ? pow(1.0 - N.z, 5.0) : exp(-(r - R) * uHaloK);

  vec3 col = SPACE;
  if (cover < 1.0) {
    vec2 cell = floor(fc / uStar.x);
    uint h = hash32(uint(cell.x) * 0x9e3779b9u ^ hash32(uint(cell.y) + 0x632be5abu));
    if (float(h & 255u) < uStar.y) {
      vec2 at = vec2(float((h >> 8) & 255u), float((h >> 16) & 255u)) / 255.0;
      vec2 q = fc - (cell + 0.2 + 0.6 * at) * uStar.x;
      float b = float(h >> 24) / 255.0;
      col += STAR * ((0.05 + 0.9 * b * b) * exp(-dot(q, q) * uStar.z) * (1.0 - min(glow * 2.0, 1.0)));
    }
  }
  if (cover > 0.0) {
    vec4 s = textureGrad(uSurface, vec2(u - uPhase.x, v), gx, gy);
    float cloud = 0.0;
    float shade = 0.0;
    if (uCloud.y > 0.0) {
      vec3 c = textureGrad(uClouds, vec2(u - uPhase.y, v), gx, gy).rgb;
      cloud = smoothstep(uCloud.x, uCloud.x + ${f(CLOUD_SOFT)}, c.r) * uCloud.y;
      // The shadow comes from the cloud on the sun's side: G is east, B west.
      float east = uSunBody.x * B.z - uSunBody.z * B.x;
      shade = smoothstep(uCloud.x, uCloud.x + ${f(CLOUD_SOFT)}, east > 0.0 ? c.g : c.b) * uCloud.y;
    }
    vec3 sunCol = mix(SUNSET, vec3(1.0), smoothstep(0.0, 0.35, ndl));
    vec3 light = max(ndl, 0.0) * sunCol + AMBIENT;
    float gloss = 1.0 - smoothstep(0.3, 0.5, s.a);
    float city = clamp(s.a * 2.0 - 1.01, 0.0, 1.0);
    vec3 ground = s.rgb * (1.0 - 0.4 * shade) * light;
    float spec = pow(max(dot(N, uHalf), 0.0), 60.0) * gloss * uGain.y * smoothstep(0.0, 0.1, ndl);
    ground += sunCol * (spec * (1.0 - cloud));
    vec3 planet = mix(ground, 0.95 * light, cloud);
    float night = 1.0 - smoothstep(-0.12, 0.04, ndl);
    planet += CITY * (city * uGain.x * night * (1.0 - 0.6 * cloud));
    col = mix(col, planet, cover);
  }
  col += atmo * glow;
  outColor = vec4(col + dither8(fc), 1.0);
}
`;

/**
 * A planet seen from orbit, rising from a corner or edge of the frame (or whole in
 * the middle) and turning at an adjustable speed and direction:
 * day side with oceans, land and drifting clouds, night side with city lights, a
 * thin atmosphere glowing at the limb, and stars beyond. The surface and clouds
 * are equirectangular textures built on the CPU when the world or seed changes.
 */
export const planet = defineEffect({
  id: "planet",
  name: "Planet from orbit",
  description:
    "A planet filling a corner or edge of the frame, or whole, turning at an adjustable speed, with day and night sides, clouds, city lights and a glowing atmosphere.",
  params: {
    world: { kind: "select", label: "World", options: WORLD_OPTIONS, default: "earth" },
    framing: { kind: "select", label: "Framing", options: FRAMING_OPTIONS, default: "bottomLeft" },
    size: { kind: "number", label: "Size", min: 0.4, max: 2, step: 0.01, default: 1 },
    rotation: {
      kind: "number",
      label: "Rotation speed",
      min: -20,
      max: 20,
      step: 0.1,
      default: 1,
    },
    sunAngle: { kind: "number", label: "Sun angle", min: 0, max: 180, step: 1, default: 60 },
    clouds: { kind: "number", label: "Clouds", min: 0, max: 1, step: 0.01, default: 0.5 },
    cities: { kind: "number", label: "City lights", min: 0, max: 1, step: 0.01, default: 0.7 },
    seed: { kind: "number", label: "Seed", min: 0, max: 999, step: 1, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const triangle = scope.own(createFullscreenTriangle(gl));
      const u = createUniforms(gl, program, [
        "uSurface",
        "uClouds",
        "uDisc",
        "uPhase",
        "uSun",
        "uSunBody",
        "uHalf",
        "uCloud",
        "uGain",
        "uAtmoDay",
        "uAtmoSet",
        "uHaloK",
        "uStar",
      ]);
      gl.useProgram(program);
      u.i1("uSurface", 0);
      u.i1("uClouds", 1);
      gl.useProgram(null);

      const surfaceData = new Uint8Array(SURFACE_W * SURFACE_H * 4);
      const cloudData = new Uint8Array(CLOUD_W * CLOUD_H * 4);
      const texture = (width: number, height: number, data: Uint8Array) => {
        const tex = scope.add(
          createDataTexture(gl, {
            width,
            height,
            internalFormat: gl.RGBA8,
            format: gl.RGBA,
            type: gl.UNSIGNED_BYTE,
            data,
            wrap: gl.REPEAT,
          }),
          (t) => gl.deleteTexture(t),
        );
        // Longitude repeats; latitude stops at the poles. Mipmaps follow each build.
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };
      const surfaceTex = texture(SURFACE_W, SURFACE_H, surfaceData);
      const cloudTex = texture(CLOUD_W, CLOUD_H, cloudData);

      const layout = new Float64Array(3);
      const sun = new Float64Array(3);
      const side = new Float64Array(2);
      const sunBody = new Float64Array(3);
      const shaping = new Float64Array(2);

      let width = 1;
      let height = 1;
      let scale = 1;
      let builtWorld = "";
      let builtSeed = Number.NaN;
      /** Rotation phases in turns, wrapped to [0, 1) every frame. */
      let surfacePhase = 0;
      let cloudPhase = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);

          // Rebuild the textures (tens of ms) only when the world or seed changes.
          if (p.world !== builtWorld || p.seed !== builtSeed) {
            builtWorld = p.world;
            builtSeed = p.seed;
            buildSurface(p.world, p.seed, surfaceData);
            buildClouds(p.world, p.seed, cloudData);
            gl.activeTexture(gl.TEXTURE0);
            updateDataTexture(
              gl,
              surfaceTex,
              SURFACE_W,
              SURFACE_H,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              surfaceData,
            );
            gl.generateMipmap(gl.TEXTURE_2D);
            updateDataTexture(gl, cloudTex, CLOUD_W, CLOUD_H, gl.RGBA, gl.UNSIGNED_BYTE, cloudData);
            gl.generateMipmap(gl.TEXTURE_2D);
          }

          // Negative speeds spin the planet the other way.
          const turns = (Math.max(0, dt) * p.rotation) / TURN_SECONDS;
          surfacePhase = advancePhase(surfacePhase, turns);
          cloudPhase = advancePhase(cloudPhase, turns * CLOUD_RATE);

          const world = worldStyle(p.world);
          planetLayout(p.framing, p.size, width / height, layout);
          sunSide(p.framing, side);
          sunDirection(p.sunAngle, side[0], sun, side[1]);
          mulMat3(BODY, sun[0], sun[1], sun[2], sunBody);
          // Blinn half vector between the sun and the viewer (+z).
          const hz = sun[2] + 1;
          const hl = Math.hypot(sun[0], sun[1], hz) || 1;
          cloudShaping(p.quality === "low" ? 0 : p.clouds, world, shaping);
          const radius = Math.max(1, layout[2] * height);

          gl.useProgram(program);
          u.f3("uDisc", width / 2 + layout[0] * height, height / 2 + layout[1] * height, radius);
          u.f2("uPhase", surfacePhase, cloudPhase);
          u.f3("uSun", sun[0], sun[1], sun[2]);
          u.f3("uSunBody", sunBody[0], sunBody[1], sunBody[2]);
          u.f3("uHalf", sun[0] / hl, sun[1] / hl, hz / hl);
          u.f2("uCloud", shaping[0], shaping[1]);
          u.f2("uGain", Math.max(0, p.cities) * world.cities * CITY_GAIN, world.specular);
          u.f3("uAtmoDay", world.atmoDay[0], world.atmoDay[1], world.atmoDay[2]);
          u.f3("uAtmoSet", world.atmoSet[0], world.atmoSet[1], world.atmoSet[2]);
          u.f1("uHaloK", 1 / (HALO_WIDTH * radius));
          const cell = Math.max(2, STAR_CELL * scale);
          const sigma = Math.max(0.4, STAR_SIGMA * scale);
          u.f3("uStar", cell, STAR_SHARE * 256, 1 / (2 * sigma * sigma));

          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, cloudTex);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, surfaceTex);
          triangle.draw();
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
