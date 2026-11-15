import {
  buildCar,
  buildLights,
  buildScene,
  CAR_SPACING,
  LIGHT_FLOATS,
  MAT_BOGIE,
  MAT_CAR,
  MAT_COLUMN,
  MAT_CONCRETE,
  MAT_HEAD,
  MAT_PINE_DARK,
  MAT_PINE_LIGHT,
  MAT_RAIL,
  MAT_ROOF,
  MAT_SEAT,
  MAT_SPINE,
  MAT_TRUNK,
  MAT_WHEEL,
  MATERIAL_COUNT,
  type Mesh,
  ROTATING,
  STAR_DISTANCE,
  VERTEX_FLOATS,
  WHEEL_CENTRE,
  WHEEL_PERIOD,
} from "./rollercoaster-mesh";
import { buildTrack, frameAt } from "./rollercoaster-track";
import {
  type Camera,
  createCamera,
  rideCamera,
  sideCamera,
  sideSpeeds,
  tableAt,
} from "./rollercoaster-view";
import {
  type CoasterColour,
  type CoasterTime,
  MAX_CARS,
  rollercoasterMeta,
} from "./rollercoaster.meta";
import { createColorEase } from "../color";
import {
  beginFrame,
  createDepthTarget,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type Scope,
  scopedProgram,
  withScope,
} from "../gl";
import { clamp, smoothstep, wrap } from "../math";
import { VALUE_NOISE_GLSL } from "../noise";
import { defineEffect } from "../types";

const g = glslFloat;
const TAU = Math.PI * 2;

/** The 3D pass renders at most this many px tall, multisampled, and is scaled up. */
const MAX_PASS_HEIGHT = 1440;
/** Seconds for each half of the dip to black when the view changes. */
const VIEW_DIP_SECONDS = 0.5;
/** Seconds for a time-of-day or colour change to ease over. */
const EASE_SECONDS = 1.5;
/** Where the train starts: just short of the lift's crest, metres before it. */
const START_BEFORE_CREST = 12;
/** Bulbs nearer the ride-along camera than this fade out, metres. */
const RIDE_LIGHT_FADE = 14;
/** Smallest a bulb is drawn, in reference px of radius. */
const MIN_BULB_PX = 1.1;

/**
 * Time of day, as floats: sky top, horizon, direction to the sun (or moon),
 * its light, ambient light, grass, fog, near and far hills, the disc's colour,
 * the disc's angular radius, its glow, the stars, the bulbs, the fog density.
 */
const TIME_FLOATS = 35;
const TIMES: Record<CoasterTime, readonly number[]> = {
  day: [
    0.24,
    0.5,
    0.86,
    0.74,
    0.85,
    0.95,
    -0.45,
    0.72,
    0.53,
    1,
    0.95,
    0.86,
    0.46,
    0.54,
    0.66,
    0.34,
    0.52,
    0.22,
    0.75,
    0.85,
    0.94,
    0.36,
    0.5,
    0.42,
    0.56,
    0.67,
    0.74,
    1,
    1,
    0.9,
    0,
    0.12,
    0,
    0,
    1 / 1300,
  ],
  sunset: [
    0.2,
    0.24,
    0.5,
    1,
    0.6,
    0.36,
    0.24,
    0.07,
    -0.97,
    1,
    0.66,
    0.4,
    0.38,
    0.32,
    0.44,
    0.26,
    0.3,
    0.17,
    0.94,
    0.6,
    0.44,
    0.3,
    0.21,
    0.3,
    0.58,
    0.4,
    0.44,
    1,
    0.82,
    0.55,
    0.028,
    0.75,
    0,
    0.55,
    1 / 900,
  ],
  night: [
    0.015,
    0.025,
    0.075,
    0.07,
    0.09,
    0.17,
    -0.3,
    0.14,
    -0.94,
    0.3,
    0.36,
    0.5,
    0.08,
    0.09,
    0.14,
    0.06,
    0.08,
    0.06,
    0.06,
    0.08,
    0.15,
    0.025,
    0.035,
    0.06,
    0.045,
    0.055,
    0.1,
    0.95,
    0.95,
    0.86,
    0.013,
    0.18,
    1,
    1,
    1 / 1000,
  ],
};

/** Palette entries: rgb and specular strength. The scheme sets the coaster's own colours. */
const SCHEMES: Record<CoasterColour, Record<number, readonly number[]>> = {
  red: {
    [MAT_RAIL]: [0.82, 0.16, 0.12, 0.9],
    [MAT_SPINE]: [0.68, 0.13, 0.1, 0.7],
    [MAT_COLUMN]: [0.9, 0.9, 0.88, 0.4],
    [MAT_CAR]: [0.15, 0.36, 0.82, 0.8],
  },
  teal: {
    [MAT_RAIL]: [0.1, 0.62, 0.6, 0.9],
    [MAT_SPINE]: [0.08, 0.5, 0.5, 0.7],
    [MAT_COLUMN]: [0.92, 0.89, 0.8, 0.4],
    [MAT_CAR]: [0.98, 0.66, 0.15, 0.8],
  },
  yellow: {
    [MAT_RAIL]: [0.98, 0.78, 0.12, 0.9],
    [MAT_SPINE]: [0.9, 0.64, 0.1, 0.7],
    [MAT_COLUMN]: [0.2, 0.36, 0.72, 0.5],
    [MAT_CAR]: [0.86, 0.18, 0.14, 0.8],
  },
  purple: {
    [MAT_RAIL]: [0.52, 0.28, 0.84, 0.9],
    [MAT_SPINE]: [0.42, 0.22, 0.7, 0.7],
    [MAT_COLUMN]: [0.22, 0.74, 0.62, 0.5],
    [MAT_CAR]: [0.96, 0.4, 0.62, 0.8],
  },
};
const FIXED: Record<number, readonly number[]> = {
  [MAT_CONCRETE]: [0.62, 0.6, 0.56, 0.1],
  [MAT_ROOF]: [0.88, 0.86, 0.82, 0.2],
  [MAT_PINE_DARK]: [0.11, 0.27, 0.15, 0.04],
  [MAT_PINE_LIGHT]: [0.2, 0.37, 0.17, 0.04],
  [MAT_TRUNK]: [0.3, 0.21, 0.14, 0],
  [MAT_WHEEL]: [0.9, 0.9, 0.92, 0.5],
  [MAT_SEAT]: [0.12, 0.12, 0.14, 0.2],
  [MAT_HEAD]: [0.82, 0.62, 0.48, 0.1],
  [MAT_BOGIE]: [0.2, 0.2, 0.22, 0.5],
};
/** The whole palette for a colour scheme: its own colours over the fixed ones. */
function buildPalette(scheme: CoasterColour): Float32Array {
  const out = new Float32Array(MATERIAL_COUNT * 4);
  for (let m = 0; m < MATERIAL_COUNT; m++) {
    out.set(SCHEMES[scheme][m] ?? FIXED[m], m * 4);
  }
  return out;
}
const PALETTES: Record<CoasterColour, Float32Array> = {
  red: buildPalette("red"),
  teal: buildPalette("teal"),
  yellow: buildPalette("yellow"),
  purple: buildPalette("purple"),
};

const isTime = (v: string): v is CoasterTime => v in TIMES;
const isScheme = (v: string): v is CoasterColour => v in SCHEMES;

/** The fog both the sky's ground and the meshes fade into with distance. */
const FOG_GLSL = /* glsl */ `
vec3 applyFog(vec3 col, float dist, vec3 fog, float density) {
  return mix(col, fog, 1.0 - exp(-dist * density));
}
`;

/**
 * Sky, distant hills and the grassy ground, from each pixel's view ray: a
 * gradient up from the horizon, the sun's or moon's disc and glow, two
 * layers of hills whose height follows the ray's bearing (so they stay put
 * as the ride camera turns), and the ground plane, mottled and fogged.
 */
const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uTan;
uniform vec3 uSkyTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uDisc;
uniform vec3 uGround;
uniform vec3 uFog;
uniform vec3 uHillNear;
uniform vec3 uHillFar;
uniform vec4 uMisc;
out vec4 outColor;
${DITHER_GLSL}
${VALUE_NOISE_GLSL}
${FOG_GLSL}
void main() {
  vec3 dir = normalize(uFwd + (vUv.x * 2.0 - 1.0) * uTan.x * uRight + (vUv.y * 2.0 - 1.0) * uTan.y * uUp);
  vec3 sun = normalize(uSunDir);
  vec3 col;
  if (dir.y >= 0.0) {
    col = mix(uHorizon, uSkyTop, pow(smoothstep(0.0, 0.7, dir.y), 0.55));
    float c = max(dot(dir, sun), 0.0);
    col += uDisc * uMisc.y * (0.35 * pow(c, 10.0) + 0.5 * pow(c, 120.0));
    float size = uMisc.x;
    col = mix(col, uDisc, size > 0.0 ? smoothstep(cos(size), cos(size * 0.8), c) : 0.0);
    float az = atan(dir.x, -dir.z);
    float far = 0.04 + 0.02 * sin(az * 3.0 + 1.3) + 0.012 * sin(az * 7.0 + 0.4) + 0.005 * sin(az * 17.0 + 2.0);
    float near = 0.02 + 0.012 * sin(az * 4.0 + 2.6) + 0.007 * sin(az * 11.0 + 1.1) + 0.003 * sin(az * 27.0);
    // Hazier towards their feet, as the air between thickens.
    if (dir.y < far) {
      col = mix(uHillFar, uHorizon, 0.25 + 0.35 * (1.0 - dir.y / far));
    }
    if (dir.y < near) {
      col = mix(uHillNear, uFog, 0.45 * (1.0 - dir.y / near));
    }
  } else {
    float t = uEye.y / max(-dir.y, 1e-4);
    vec2 p = uEye.xz + dir.xz * t;
    float n = vnoise(p / 38.0, 3.0) * 0.6 + vnoise(p / 11.0, 7.0) * 0.4;
    col = uGround * (0.82 + 0.3 * n);
    col = applyFog(col, t, uFog, uMisc.z);
  }
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Turns the Ferris wheel's moving parts about its axle (z). */
const WHEEL_TURN_GLSL = /* glsl */ `
vec3 turnWheel(vec3 p, vec4 wheel) {
  float c = cos(wheel.w);
  float s = sin(wheel.w);
  vec2 d = p.xy - wheel.xy;
  return vec3(wheel.xy + vec2(c * d.x - s * d.y, s * d.x + c * d.y), p.z);
}
`;

const SCENE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aMat;
uniform mat4 uViewProj;
uniform vec4 uWheel;
out vec3 vPos;
out vec3 vNormal;
flat out int vMat;
${WHEEL_TURN_GLSL}
void main() {
  int m = int(aMat + 0.5);
  vec3 p = aPos;
  vec3 n = aNormal;
  if (m >= ${String(ROTATING)}) {
    m -= ${String(ROTATING)};
    p = turnWheel(p, uWheel);
    n = turnWheel(n + uWheel.xyz, vec4(uWheel.xyz, uWheel.w)) - uWheel.xyz;
  }
  vPos = p;
  vNormal = n;
  vMat = m;
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

/** One car per instance: its middle and the track's tangent and normal there. */
const CAR_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aMat;
layout(location = 3) in vec3 aOrigin;
layout(location = 4) in vec3 aTangent;
layout(location = 5) in vec3 aUp;
uniform mat4 uViewProj;
out vec3 vPos;
out vec3 vNormal;
flat out int vMat;
void main() {
  vec3 side = cross(aTangent, aUp);
  vec3 p = aOrigin + aTangent * aPos.x + aUp * aPos.y + side * aPos.z;
  vPos = p;
  vNormal = aTangent * aNormal.x + aUp * aNormal.y + side * aNormal.z;
  vMat = int(aMat + 0.5);
  gl_Position = uViewProj * vec4(p, 1.0);
}
`;

/**
 * Sun (or moon) and sky light with a glint on the steel, a faint rim of the
 * horizon's colour at grazing angles, and fog with distance.
 */
const MESH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
flat in int vMat;
uniform vec4 uPalette[${String(MATERIAL_COUNT)}];
uniform vec3 uEye;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uGround;
uniform vec3 uFog;
uniform float uFogDensity;
out vec4 outColor;
${DITHER_GLSL}
${FOG_GLSL}
void main() {
  vec4 m = uPalette[vMat];
  vec3 N = normalize(vNormal);
  vec3 L = normalize(uSunDir);
  vec3 V = uEye - vPos;
  float dist = length(V);
  V /= dist;
  float diff = max(dot(N, L), 0.0);
  vec3 amb = mix(uGround * 0.7, uAmbient, N.y * 0.5 + 0.5);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(N, H), 0.0), 48.0) * m.a;
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0) * (0.15 + 0.25 * m.a);
  vec3 col = m.rgb * (amb + uSunColor * diff) + uSunColor * spec + uFog * rim;
  col = applyFog(col, dist, uFog, uFogDensity);
  outColor = vec4(col + dither8(gl_FragCoord.xy), 1.0);
}
`;

/**
 * Bulbs and stars as camera-facing quads: bulbs sized in metres (never under
 * a pixel or so), stars in px at a fixed distance from the eye, the wheel's
 * bulbs turned with it. Each kind has its own brightness; near the ride-along
 * camera, bulbs fade out.
 */
const LIGHT_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aI0;
layout(location = 2) in vec4 aI1;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform vec4 uWheel;
uniform vec3 uKinds;
/** 1 / tanHalf, aspect, NDC per px, px per reference px. */
uniform vec4 uProj;
/** Bulbs nearer the eye than this fade out (0: never). */
uniform float uNearFade;
out vec2 vCorner;
out vec3 vColour;
${WHEEL_TURN_GLSL}
void main() {
  int kind = int(aI1.w + 0.5);
  vec3 p = aI0.xyz;
  float k = uKinds.x;
  if (kind == 1) {
    p = turnWheel(p, uWheel);
    k = uKinds.y;
  } else if (kind == 2) {
    p = uEye + p * ${g(STAR_DISTANCE)};
    k = uKinds.z;
  }
  vec4 c = uViewProj * vec4(p, 1.0);
  float w = max(c.w, 1e-3);
  // Radius in NDC heights: stars in reference px, bulbs in metres but at least a px or so.
  float r = kind == 2 ? aI0.w * uProj.w * uProj.z
                      : max(aI0.w * uProj.x / w, max(1.0, ${g(MIN_BULB_PX)} * uProj.w) * uProj.z);
  float fade = kind != 2 && uNearFade > 0.0 ? smoothstep(uNearFade * 0.3, uNearFade, distance(p, uEye)) : 1.0;
  vCorner = aCorner;
  vColour = aI1.rgb * k * fade;
  gl_Position = c + vec4(aCorner * vec2(r / uProj.y, r) * w, 0.0, 0.0);
}
`;

const LIGHT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vColour;
out vec4 outColor;
void main() {
  float d2 = dot(vCorner, vCorner);
  if (d2 > 1.0) {
    discard;
  }
  float a = exp(-d2 * 5.0) + smoothstep(0.16, 0.04, d2);
  outColor = vec4(vColour * a, 1.0);
}
`;

const COMPOSITE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
uniform float uBright;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  outColor = vec4(texture(uScene, vUv).rgb * uBright + dither8(gl_FragCoord.xy), 1.0);
}
`;

const SKY_UNIFORMS = [
  "uEye",
  "uRight",
  "uUp",
  "uFwd",
  "uTan",
  "uSkyTop",
  "uHorizon",
  "uSunDir",
  "uDisc",
  "uGround",
  "uFog",
  "uHillNear",
  "uHillFar",
  "uMisc",
] as const;
const MESH_UNIFORMS = [
  "uViewProj",
  "uWheel",
  "uPalette",
  "uEye",
  "uSunDir",
  "uSunColor",
  "uAmbient",
  "uGround",
  "uFog",
  "uFogDensity",
] as const;
const LIGHT_UNIFORMS = ["uViewProj", "uEye", "uWheel", "uKinds", "uProj", "uNearFade"] as const;

/** Uploads a mesh into a new vertex array: position, normal, material at locations 0–2. */
function meshVao(gl: WebGL2RenderingContext, scope: Scope, mesh: Mesh): WebGLVertexArrayObject {
  const vao = scope.add(gl.createVertexArray(), (v) => {
    gl.deleteVertexArray(v);
  });
  const vbo = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  const ibo = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
  const stride = VERTEX_FLOATS * 4;
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 24);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
  return vao;
}

/**
 * A steel rollercoaster in a park, seen from the side or from the front seat.
 *
 * The circuit, its frames and the train's physical speed are built once on
 * the CPU (`rollercoaster-track.ts`); the train moves along it at that speed,
 * soft-capped in the side view so its motion stays codec-friendly. Each frame draws,
 * into a multisampled target at most 1440 px tall: the sky, hills and ground
 * from each pixel's view ray; one static indexed mesh for the track, ties,
 * columns, station, trees and the Ferris wheel (its moving parts turned in the
 * vertex shader); the cars as instances of one small mesh; then the bulbs and
 * stars as additive billboards. A last pass scales it onto the canvas with
 * dither and the dip to black used when the view changes.
 */
export const rollercoaster = defineEffect(rollercoasterMeta, {
  create(gl) {
    return withScope((scope) => {
      const track = buildTrack();
      const scene = buildScene(track);
      const car = buildCar();
      const lights = buildLights(track);
      const lightCount = lights.length / LIGHT_FLOATS;

      const triangle = scope.own(createFullscreenTriangle(gl));
      const sky = createUniforms(
        gl,
        scopedProgram(gl, scope, FULLSCREEN_VERTEX, SKY_FRAGMENT),
        SKY_UNIFORMS,
      );
      const sceneU = createUniforms(
        gl,
        scopedProgram(gl, scope, SCENE_VERTEX, MESH_FRAGMENT),
        MESH_UNIFORMS,
      );
      const carU = createUniforms(
        gl,
        scopedProgram(gl, scope, CAR_VERTEX, MESH_FRAGMENT),
        MESH_UNIFORMS,
      );
      const lightU = createUniforms(
        gl,
        scopedProgram(gl, scope, LIGHT_VERTEX, LIGHT_FRAGMENT),
        LIGHT_UNIFORMS,
      );
      const comp = createUniforms(
        gl,
        scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT),
        ["uScene", "uBright"],
      );
      gl.useProgram(comp.program);
      comp.i1("uScene", 0);
      gl.useProgram(null);

      const sceneVao = meshVao(gl, scope, scene);
      const carVao = meshVao(gl, scope, car);
      const carData = new Float32Array(MAX_CARS * 9);
      const carBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(carVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, carBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, carData.byteLength, gl.DYNAMIC_DRAW);
      for (let k = 0; k < 3; k++) {
        gl.enableVertexAttribArray(3 + k);
        gl.vertexAttribPointer(3 + k, 3, gl.FLOAT, false, 36, k * 12);
        gl.vertexAttribDivisor(3 + k, 1);
      }

      const lightVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const cornerBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      const lightBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(lightVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
        gl.STATIC_DRAW,
      );
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, lightBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, lights, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, LIGHT_FLOATS * 4, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, LIGHT_FLOATS * 4, 16);
      gl.vertexAttribDivisor(2, 1);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      const pass = createDepthTarget(gl, scope, { msaa: true });

      const side = createCamera();
      const ride = createCamera();
      const sideTable = new Float64Array(track.count);
      const frame = new Float64Array(12);
      const timeEase = createColorEase(TIME_FLOATS);
      const paletteEase = createColorEase(MATERIAL_COUNT * 4);

      let width = 1;
      let height = 1;
      let passHeight = 1;
      let aspect = 16 / 9;
      let s = track.crest - START_BEFORE_CREST;
      let wheelAngle = 0;
      /** Whether the ride-along view is on show (the first frame takes the one asked for). */
      let shownRide = false;
      let started = false;
      /** Brightness of the dip to black while the view changes; 1 when settled. */
      let dip = 1;
      /** Palette changes so far, and the one each mesh program last received. */
      let paletteVersion = 0;
      let scenePalette = -1;
      let carPalette = -1;
      /** This frame's camera, time-of-day values and palette, for `meshUniforms`. */
      let cam: Camera = side;
      let time = timeEase.value;
      let palette = paletteEase.value;

      /** Binds a mesh program and brings its uniforms up to date for this frame. */
      const meshUniforms = (u: typeof sceneU, isScene: boolean) => {
        gl.useProgram(u.program);
        gl.uniformMatrix4fv(u.loc.uViewProj, false, cam.viewProj);
        if ((isScene ? scenePalette : carPalette) !== paletteVersion) {
          gl.uniform4fv(u.loc.uPalette, palette);
          if (isScene) {
            scenePalette = paletteVersion;
          } else {
            carPalette = paletteVersion;
          }
        }
        u.f4("uWheel", WHEEL_CENTRE[0], WHEEL_CENTRE[1], WHEEL_CENTRE[2], wheelAngle);
        u.v3("uEye", cam.eye);
        u.f3("uSunDir", time[6], time[7], time[8]);
        u.f3("uSunColor", time[9], time[10], time[11]);
        u.f3("uAmbient", time[12], time[13], time[14]);
        u.f3("uGround", time[15], time[16], time[17]);
        u.f3("uFog", time[18], time[19], time[20]);
        u.f1("uFogDensity", time[34]);
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          aspect = width / height;
          const k = Math.min(1, MAX_PASS_HEIGHT / height);
          passHeight = Math.max(1, Math.round(height * k));
          pass.resize(Math.max(1, Math.round(width * k)), passHeight);
          sideCamera(track, aspect, side);
          sideSpeeds(track, aspect, sideTable);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, Math.min(dt, 0.1));

          // 1. The view: a change dips to black, switches at the bottom and comes back.
          const wantRide = p.view === "ride";
          if (!started) {
            started = true;
            shownRide = wantRide;
          }
          if (wantRide === shownRide) {
            dip = Math.min(1, dip + step / VIEW_DIP_SECONDS);
          } else {
            dip = Math.max(0, dip - step / VIEW_DIP_SECONDS);
            if (dip === 0) {
              shownRide = wantRide;
            }
          }

          // 2. The train: capped across the side view, at its physical speed riding along.
          const table = shownRide ? track.speed : sideTable;
          const speed = clamp(p.speed, 0, 1);
          s = wrap(s + speed * tableAt(track, table, s) * step, 0, track.length);
          wheelAngle = wrap(wheelAngle + (TAU / WHEEL_PERIOD) * step, 0, TAU);
          const cars = clamp(Math.round(p.cars), 1, MAX_CARS);
          for (let c = 0; c < cars; c++) {
            frameAt(track, s - c * CAR_SPACING, frame);
            for (let k = 0; k < 9; k++) {
              carData[c * 9 + k] = frame[k];
            }
          }

          // 3. Time of day and colours, eased.
          time = timeEase.step(TIMES[isTime(p.time) ? p.time : "sunset"], step, EASE_SECONDS);
          palette = paletteEase.step(
            PALETTES[isScheme(p.colour) ? p.colour : "red"],
            step,
            EASE_SECONDS,
          );
          if (paletteEase.moving || paletteVersion === 0) {
            paletteVersion++;
          }

          cam = shownRide ? ride : side;
          if (shownRide) {
            rideCamera(track, s, aspect, ride);
          }

          const target = pass.target;
          if (!target) {
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }
          pass.bind();

          // 4. Sky, hills and ground.
          gl.useProgram(sky.program);
          sky.v3("uEye", cam.eye);
          sky.v3("uRight", cam.right);
          sky.v3("uUp", cam.up);
          sky.v3("uFwd", cam.fwd);
          sky.f2("uTan", cam.tanHalf * cam.aspect, cam.tanHalf);
          sky.f3("uSkyTop", time[0], time[1], time[2]);
          sky.f3("uHorizon", time[3], time[4], time[5]);
          sky.f3("uSunDir", time[6], time[7], time[8]);
          sky.f3("uDisc", time[27], time[28], time[29]);
          sky.f3("uGround", time[15], time[16], time[17]);
          sky.f3("uFog", time[18], time[19], time[20]);
          sky.f3("uHillNear", time[21], time[22], time[23]);
          sky.f3("uHillFar", time[24], time[25], time[26]);
          sky.f4("uMisc", time[30], time[31], time[34], 0);
          triangle.draw();

          // 5. The scene mesh and the cars, depth-tested.
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LESS);
          gl.depthMask(true);
          gl.clearDepth(1);
          gl.clear(gl.DEPTH_BUFFER_BIT);
          meshUniforms(sceneU, true);
          gl.bindVertexArray(sceneVao);
          gl.drawElements(gl.TRIANGLES, scene.indices.length, gl.UNSIGNED_INT, 0);
          meshUniforms(carU, false);
          gl.bindVertexArray(carVao);
          gl.bindBuffer(gl.ARRAY_BUFFER, carBuffer);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, carData, 0, cars * 9);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          gl.drawElementsInstanced(gl.TRIANGLES, car.indices.length, gl.UNSIGNED_INT, 0, cars);

          // 6. Bulbs and stars, added over it, hidden behind anything nearer.
          const bulbs = p.lights ? time[33] : 0;
          const stars = time[32];
          if (bulbs > 0.002 || stars > 0.002) {
            gl.useProgram(lightU.program);
            gl.uniformMatrix4fv(lightU.loc.uViewProj, false, cam.viewProj);
            lightU.v3("uEye", cam.eye);
            lightU.f4("uWheel", WHEEL_CENTRE[0], WHEEL_CENTRE[1], WHEEL_CENTRE[2], wheelAngle);
            lightU.f3("uKinds", bulbs, bulbs, stars);
            lightU.f4("uProj", 1 / cam.tanHalf, cam.aspect, 2 / passHeight, passHeight / 1080);
            lightU.f1("uNearFade", shownRide ? RIDE_LIGHT_FADE : 0);
            gl.depthMask(false);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE);
            gl.bindVertexArray(lightVao);
            gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lightCount);
            gl.disable(gl.BLEND);
            gl.depthMask(true);
          }
          gl.bindVertexArray(null);
          gl.disable(gl.DEPTH_TEST);
          pass.resolve();

          // 7. Onto the canvas, through the view-change dip.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(comp.program);
          comp.f1("uBright", smoothstep(0, 1, dip));
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, target.texture);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
