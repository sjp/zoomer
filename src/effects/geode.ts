import { hexToUnitRgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createGradientBackground,
  createProgram,
  createUniforms,
  DITHER_GLSL,
  glslFloat,
  withScope,
} from "./gl";
import {
  advancePhase,
  CELL,
  CRUST_W,
  ELONG,
  GLINT_EXP,
  GRID_ORIGIN,
  JITTER,
  layout,
  type Layout,
  LEAN,
  LEAN_JITTER,
  LIGHT_PERIOD,
  lightPosition,
  mineral,
  outline,
  type Outline,
  RIM_W,
  RISE_PERIOD,
  ROUGH,
  SHEEN_EXP,
  SLOPE,
} from "./geode-sim";
import { geodeMeta } from "./geode.meta";
import { buildPeriodicNoiseTexture, HASH32_GLSL } from "./noise";
import { defineEffect } from "./types";
import { VORONOI_GLSL } from "./voronoi";

/** Noise texture: texels per side, and geode units one tile covers. */
const TEX_SIZE = 64;
const TILE = 2.5;
/**
 * Channels: R roughens the outline, G grains the crust, B wobbles the agate bands
 * and A the line between crust and agate.
 */
const NOISE_CHANNELS = [
  { period: 8, seed: 1150 },
  { period: 16, seed: 1151 },
  { period: 4, seed: 1152 },
  { period: 8, seed: 1153 },
];
/** Fine crust grit: noise tiles per coarse tile. */
const GRIT = 7;
/** Background: a soft studio gradient, lighter at the top. */
const BG_TOP = hexToUnitRgb("#16131b");
const BG_BOTTOM = hexToUnitRgb("#060508");
/**
 * Drop shadow strength at the outline and falloff length (geode units); by the
 * quad's edge (SHADOW_REACH out) it is below one 8-bit step.
 */
const SHADOW = 0.5;
const SHADOW_LEN = 0.035;
/** Agate: stripes across the rim, wobble of the stripes (rim widths), lit floor and glow. */
const STRIPES = 5.5;
const BAND_WOBBLE = 0.35;
const BAND_LIT = 0.42;
const BAND_GLOW = 0.6;
/** Crystal lighting: ambient and diffuse weights, sheen and glint gains. */
const AMBIENT = 0.4;
const DIFFUSE = 0.85;
const SHEEN = 0.12;
const GLINT_GAIN = 1.6;
/** Darkening deep in the hollow's centre, and in the creases between crystals. */
const DEEP = 0.55;
const CREASE = 0.4;

/** The geode quad: a square around the geode, from gl_VertexID (triangle strip). */
const QUAD_VERTEX = /* glsl */ `#version 300 es
/** Centre (device px), half side (device px), canvas size (device px). */
uniform vec4 uQuad;
uniform vec2 uRes;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 px = uQuad.xy + c * uQuad.z;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
}
`;

/**
 * The geode, over its quad: place the pixel against the noisy oval outline, then
 * shade it as rock crust, agate rim or crystal lining. In the hollow, one Voronoi
 * lookup finds the crystal and the face under the pixel (the face over the nearest
 * cell edge; the second-nearest gives the neighbouring face, blended across the
 * ridge for anti-aliasing), each lit by the point light with a diffuse term, a
 * broad sheen and a narrow glint. Pixels outside the outline get the background
 * gradient and a soft shadow.
 */
const GEODE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
uniform sampler2D uNoise;
/** Geode centre (device px), geode units per device px, 1 / canvas height. */
uniform vec4 uGeo;
/** cos and sin of the geode's rotation. */
uniform vec2 uRot;
/** Outline harmonics k = 2..5: amplitudes and phases. */
uniform vec4 uAmp;
uniform vec4 uPhase;
/** Crystal grid origin (cells), cells per device px, glint gain. */
uniform vec4 uGrid;
/** Light position, local space. */
uniform vec3 uLight;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uBase;
uniform vec3 uTip;
uniform vec3 uBand0;
uniform vec3 uBand1;
uniform vec3 uBand2;
uniform vec3 uCrust;
out vec4 outColor;
${HASH32_GLSL}
${DITHER_GLSL}
/** Crystal seeds: two hash bytes mapped from the square onto a disc (crystalOffset). */
vec2 voronoiOffset(uint h) {
  vec2 b = vec2(uvec2(h, h >> 8) & 255u) * ${glslFloat(2 / 255)} - 1.0;
  return ${glslFloat(JITTER)} * b * sqrt(1.0 - 0.5 * b.yx * b.yx);
}
${VORONOI_GLSL}
/** One crystal face with unit normal n: diffuse, sheen and glint. */
vec3 face(vec3 n, vec3 albedo, vec3 l, vec3 h) {
  float diff = max(dot(n, l), 0.0);
  float nh = max(dot(n, h), 0.0);
  float sheen = pow(nh, ${glslFloat(SHEEN_EXP)});
  float glint = pow(nh, ${glslFloat(GLINT_EXP)});
  return albedo * (${glslFloat(AMBIENT)} + ${glslFloat(DIFFUSE)} * diff)
    + uTip * (${glslFloat(SHEEN)} * sheen)
    + mix(uTip, vec3(1.0), 0.6) * (uGrid.w * glint);
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float px = uGeo.z;
  vec2 d = (frag - uGeo.xy) * px;
  vec2 q = vec2(uRot.x * d.x + uRot.y * d.y, uRot.x * d.y - uRot.y * d.x);
  vec3 bg = mix(uTop, uBottom, 1.0 - frag.y * uGeo.w);

  // Depth inside the noisy oval outline, in geode units.
  vec2 p = vec2(q.x * ${glslFloat(1 / ELONG)}, q.y);
  float rho = length(p);
  float th = rho > 1e-5 ? atan(p.y, p.x) : 0.0;
  vec4 nz = texture(uNoise, q * ${glslFloat(1 / TILE)});
  float r = 1.0 + dot(uAmp, cos(vec4(2.0, 3.0, 4.0, 5.0) * th + uPhase))
    + ${glslFloat(ROUGH)} * (nz.r - 0.5);
  float dep = r - rho;
  bg *= 1.0 - ${glslFloat(SHADOW)} * exp(min(dep, 0.0) * ${glslFloat(1 / SHADOW_LEN)});
  if (dep < -px) {
    outColor = vec4(bg + dither8(frag), 1.0);
    return;
  }

  // Rock crust: grainy grey, darker toward its rounded outer edge.
  float grit = texture(uNoise, q * ${glslFloat(GRIT / TILE)} + vec2(0.31, 0.57)).g;
  vec3 col = uCrust * ((0.55 + 0.3 * nz.g + 0.3 * grit)
    * (0.5 + 0.5 * smoothstep(0.0, ${glslFloat(CRUST_W)}, dep)));

  // Agate: stripes in three colours following the outline, glowing toward the light.
  float crustEdge = ${glslFloat(CRUST_W)} + 0.02 * (nz.a - 0.5);
  if (dep > crustEdge - px) {
    float t = (dep - ${glslFloat(CRUST_W)}) * ${glslFloat(1 / (RIM_W - CRUST_W))}
      + ${glslFloat(BAND_WOBBLE)} * (nz.b - 0.5);
    float s1 = 0.5 + 0.5 * cos(${glslFloat(2 * Math.PI * STRIPES)} * t);
    float s2 = 0.5 + 0.5 * cos(${glslFloat(2 * Math.PI * STRIPES * 0.37)} * t + 1.3);
    vec3 band = mix(uBand1, uBand0, s1);
    band = mix(band, uBand2, 0.6 * s2);
    band = mix(band, uBand0, 0.5 * smoothstep(0.75, 1.0, t));
    float facing = max(dot(q, normalize(uLight.xy)) / max(length(q), 1e-5), 0.0);
    band *= ${glslFloat(BAND_LIT)} + ${glslFloat(BAND_GLOW)} * facing * facing * (0.4 + 0.6 * t);
    col = mix(col, band, smoothstep(crustEdge - px, crustEdge + px, dep));
  }

  // Crystal lining.
  float hollow = dep - ${glslFloat(RIM_W)};
  if (hollow > -px) {
    VoronoiCell v = voronoiCell(q * ${glslFloat(1 / CELL)} + uGrid.xy);
    // The crystal's lean: inward on the walls, plus its own (crystalLean).
    vec2 sq = (v.seed - uGrid.xy) * ${glslFloat(CELL)};
    float len = length(sq);
    float srho = min(length(vec2(sq.x * ${glslFloat(1 / ELONG)}, sq.y)) * ${glslFloat(1 / (1 - RIM_W))}, 1.0);
    float w = len > 1e-9 ? ${glslFloat(LEAN)} * smoothstep(0.15, 1.0, srho) / len : 0.0;
    float phi = float(v.hash >> 24) * ${glslFloat((2 * Math.PI) / 256)};
    vec2 a = -w * sq + ${glslFloat(LEAN_JITTER)} * vec2(cos(phi), sin(phi));
    float k = ${glslFloat(SLOPE[0])} + ${glslFloat((SLOPE[1] - SLOPE[0]) / 255)} * float((v.hash >> 16) & 255u);
    vec3 n1 = normalize(vec3(k * v.normal + a, 1.0));
    vec3 n2 = normalize(vec3(k * v.normal2 + a, 1.0));

    // Pale tips, deep colour at the base, darker deep in the hollow.
    float tip = smoothstep(0.03, 0.45, v.edge);
    float rh = rho / max(r - ${glslFloat(RIM_W)}, 0.1);
    vec3 albedo = mix(uBase, uTip, tip * sqrt(tip)) * mix(${glslFloat(DEEP)}, 1.0, smoothstep(0.0, 0.85, rh));

    vec3 l = normalize(uLight - vec3(q, 0.0));
    vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
    // Blend in the neighbouring face within half a pixel of the ridge between them.
    float ridge = (v.edge2 - v.edge) / max(length(v.normal - v.normal2), 1e-3);
    float cpx = uGrid.z;
    float w2 = clamp(0.5 - ridge / cpx, 0.0, 0.5);
    vec3 c = mix(face(n1, albedo, l, h), face(n2, albedo, l, h), w2);
    // Dark creases where the crystals meet.
    c *= mix(${glslFloat(CREASE)}, 1.0, smoothstep(0.0, max(1.2 * cpx, 0.03), v.edge));
    col = mix(col, c, smoothstep(-px, px, hollow));
  }

  col = mix(bg, col, smoothstep(-px, px, dep));
  outColor = vec4(col + dither8(frag), 1.0);
}
`;

/**
 * Geode: a split geode lining one side of the frame. Hundreds of crystal points
 * (jittered Voronoi cells, each a leaning faceted pyramid) catch a slowly circling
 * point light in smooth glints, inside a rim of agate bands and grey rock crust.
 * A full-screen gradient, then one quad around the geode.
 */
export const geode = defineEffect(geodeMeta, {
  create(gl) {
    return withScope((scope) => {
      const background = scope.own(createGradientBackground(gl));
      const program = scope.add(createProgram(gl, QUAD_VERTEX, GEODE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uQuad",
        "uRes",
        "uNoise",
        "uGeo",
        "uRot",
        "uAmp",
        "uPhase",
        "uGrid",
        "uLight",
        "uTop",
        "uBottom",
        "uBase",
        "uTip",
        "uBand0",
        "uBand1",
        "uBand2",
        "uCrust",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      u.v3("uTop", BG_TOP);
      u.v3("uBottom", BG_BOTTOM);

      const vao = scope.add(gl.createVertexArray(), (v) => gl.deleteVertexArray(v));
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: TEX_SIZE,
          height: TEX_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(TEX_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );

      const place: Layout = { cx: 0, cy: 0, r: 1, angle: 0, half: 1 };
      const light = [0, 0, 1];
      let shape: Outline = outline(0);
      let shapeSeed = Number.NaN;
      let width = 1;
      let height = 1;
      let phase = 0;
      let rise = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const speed = Number.isFinite(p.light) ? Math.max(p.light, 0) : 0;
          phase = advancePhase(phase, dt, speed / LIGHT_PERIOD);
          rise = advancePhase(rise, dt, speed / RISE_PERIOD);
          const glint = Number.isFinite(p.glint) ? Math.min(Math.max(p.glint, 0), 1) : 0;
          const seed = Number.isFinite(p.seed) ? Math.floor(p.seed) : 0;
          if (seed !== shapeSeed) {
            shapeSeed = seed;
            shape = outline(seed);
          }
          layout(p.side, p.size, width / height, shape.tilt, place);
          const m = mineral(p.mineral);

          background.draw(BG_TOP, BG_BOTTOM);

          gl.useProgram(program);
          u.f4("uQuad", place.cx * height, place.cy * height, place.half * height, 0);
          u.f2("uRes", width, height);
          const unitsPerPx = 1 / (place.r * height);
          u.f4("uGeo", place.cx * height, place.cy * height, unitsPerPx, 1 / height);
          u.f2("uRot", Math.cos(place.angle), Math.sin(place.angle));
          u.f4("uAmp", shape.amp[0], shape.amp[1], shape.amp[2], shape.amp[3]);
          u.f4("uPhase", shape.phase[0], shape.phase[1], shape.phase[2], shape.phase[3]);
          u.f4(
            "uGrid",
            GRID_ORIGIN + shape.shiftX,
            GRID_ORIGIN + shape.shiftY,
            unitsPerPx / CELL,
            glint * GLINT_GAIN,
          );
          lightPosition(phase, rise, light);
          u.v3("uLight", light);
          u.rgb("uBase", m.base);
          u.rgb("uTip", m.tip);
          u.rgb("uBand0", m.bands[0]);
          u.rgb("uBand1", m.bands[1]);
          u.rgb("uBand2", m.bands[2]);
          u.rgb("uCrust", m.crust);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          gl.bindVertexArray(vao);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.bindVertexArray(null);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
