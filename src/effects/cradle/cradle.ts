import { hexToUnitRgb, type Rgb } from "../color";
import {
  ballAngle,
  ballCount,
  BASE_H,
  baseHalf,
  BALL_R,
  cornerSide,
  createLayout,
  createView,
  cradleLayout,
  finishOf,
  liftedCount,
  PIVOT_Y,
  PIVOT_Z,
  postX,
  project,
  restX,
  ROD_R,
  rotateDir,
  sceneOf,
  sortByDepth,
  STRING_LEN,
  STRING_W,
  swingRadians,
  swingState,
  type CradleView,
  type ScenePalette,
} from "./cradle-sim";
import { BALLS_RANGE, cradleMeta } from "./cradle.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import { approach } from "../math";
import { defineEffect } from "../types";
import { PAINT_OVER_GLSL } from "../sdf-glsl";
import { createChangeKey } from "../change-key";

/** Room pass: about 4 reference px per texel. The room is all out of focus. */
const ROOM_TEXEL_REF = 4;
/** How fast the amplitude follows the `swing` param (rad/s), so a change never jumps. */
const AMP_RATE = 0.5;
const MAX_BALLS = BALLS_RANGE[1];

const g = glslFloat;

/**
 * The room at low resolution: a wall gradient, the desk across the bottom (a
 * seamless sweep in the studio), a soft pool of light and a vignette. Static,
 * so it re-renders only when the scene, the side or the canvas changes.
 */
const ROOM_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> height units. */
uniform vec2 uPxToH;
/** Frame size in height units (aspect, 1). */
uniform vec2 uFrame;
/** +1 if the cradle is on the right, -1 left. */
uniform float uSide;
uniform vec3 uWallTop;
uniform vec3 uWallBottom;
uniform vec3 uDeskFar;
uniform vec3 uDeskNear;
/** The desk's back edge (height units) and its softness. */
uniform vec2 uDesk;
/** The light pool's colour times strength, and its centre from the outer edge and radius. */
uniform vec3 uGlow;
uniform vec3 uGlowAt;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  vec2 o = vec2(uSide > 0.0 ? uFrame.x - p.x : p.x, p.y);
  vec3 wall = mix(uWallBottom, uWallTop, smoothstep(0.0, 1.0, p.y));
  float t = clamp(p.y / uDesk.x, 0.0, 1.0);
  vec3 desk = mix(uDeskNear, uDeskFar, t * t);
  float onDesk = 1.0 - smoothstep(uDesk.x - uDesk.y, uDesk.x + uDesk.y, p.y);
  vec3 col = mix(wall, desk, onDesk);
  // The pool of light, flattened on the desk by the perspective.
  vec2 gq = (o - uGlowAt.xy) / uGlowAt.z;
  gq.y *= mix(1.0, 2.5, onDesk);
  col += uGlow * exp(-2.0 * dot(gq, gq));
  vec2 v = p / uFrame - 0.5;
  col *= 1.0 - 0.45 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * The cradle at full resolution in its box, premultiplied over the room, in
 * cradle view units (see cradle-sim.ts): the base's contact shadow on the desk,
 * the base's visible faces (with the balls' shadows on its top), the back half
 * of the frame and the strings, the balls far to near, then the front strings
 * and frame. Each ball is an analytic sphere reflecting an analytic studio
 * (gradient plus two soft rectangular lights) and, one bounce deep, its
 * neighbours. Coverage antialiasing throughout.
 */
const CRADLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** One device px in height units. */
uniform float uPx;
/** The world origin on screen (height units) and height units per cradle unit. */
uniform vec3 uOrigin;
/** View rotation: cos and sin of the yaw, cos and sin of the pitch. */
uniform vec4 uView;
uniform int uCount;
/** Balls far to near: view centre (x, y, depth towards the viewer). */
uniform vec4 uBall[${String(MAX_BALLS)}];
/** The same balls' world x and y, for their shadows. */
uniform vec2 uBallW[${String(MAX_BALLS)}];
/** Strings, back and front: pivot (view xy), eyelet (view xy). */
uniform vec4 uStrB[${String(MAX_BALLS)}];
uniform vec4 uStrF[${String(MAX_BALLS)}];
/** Frame rods: three behind the balls, then three in front. */
uniform vec4 uRod[6];
/** The base's three visible faces as counter-clockwise quads (top first), and their colours. */
uniform vec2 uFace[12];
uniform vec3 uFaceCol[3];
/** The base's half-length, half-depth and height (world). */
uniform vec3 uBase;
/** Ball finish: reflectance at normal incidence, diffuse colour, glint strength. */
uniform vec3 uF0;
uniform vec3 uDiffuse;
uniform float uGlint;
uniform vec3 uFrameCol;
uniform vec3 uStringCol;
/** The environment: sky, horizon, desk, and world up in view space. */
uniform vec3 uEnvTop;
uniform vec3 uEnvHor;
uniform vec3 uEnvDesk;
uniform vec3 uUp;
/** Two lights (view space): direction, rectangle axes, (half w, half h, soft, bars), colour. */
uniform vec3 uLDir[2];
uniform vec3 uLX[2];
uniform vec3 uLY[2];
uniform vec4 uLSize[2];
uniform vec3 uLCol[2];
out vec4 outColor;
${DITHER_GLSL}

/** One device px in cradle units, set by main. */
float pxU;
float cov(float sd) { return clamp(0.5 - sd / pxU, 0.0, 1.0); }
${PAINT_OVER_GLSL}

vec3 envLight(vec3 r, int k) {
  float d = dot(r, uLDir[k]);
  if (d <= 0.05) return vec3(0.0);
  vec2 uv = vec2(dot(r, uLX[k]), dot(r, uLY[k])) / d;
  vec4 s = uLSize[k];
  vec2 e = abs(uv) - s.xy;
  float m = (1.0 - smoothstep(-s.z, s.z, e.x)) * (1.0 - smoothstep(-s.z, s.z, e.y));
  if (s.w > 0.0) {
    // Window mullions and a transom.
    float f = (uv.x / (2.0 * s.x) + 0.5) * (s.w + 1.0);
    float dm = abs(f - floor(f + 0.5)) * 2.0 * s.x / (s.w + 1.0);
    float bar = 1.0 - smoothstep(0.012, 0.03, dm);
    bar = max(bar, 1.0 - smoothstep(0.012, 0.03, abs(uv.y - 0.25 * s.y)));
    m *= 1.0 - 0.85 * bar;
  }
  return uLCol[k] * m;
}
/** The studio seen along view direction r. */
vec3 env(vec3 r) {
  float e = dot(r, uUp);
  vec3 sky = mix(uEnvHor, uEnvTop, smoothstep(0.0, 0.8, e));
  // The desk below, darkening straight down where the base is.
  vec3 below = mix(uEnvDesk, uEnvDesk * 0.3, smoothstep(0.55, 0.9, -e));
  vec3 c = mix(below, sky, smoothstep(-0.08, 0.08, e));
  return c + envLight(r, 0) + envLight(r, 1);
}
/** The world point (x, z) on the plane y = h seen at view position q. */
vec2 onPlane(vec2 q, float h) {
  float z1 = (h * uView.z - q.y) / uView.w;
  return vec2(q.x * uView.x - z1 * uView.y, q.x * uView.y + z1 * uView.x);
}
float quadSd(vec2 p, int f) {
  float d = -1e9;
  for (int k = 0; k < 4; k++) {
    vec2 a = uFace[f * 4 + k];
    vec2 e = uFace[f * 4 + (k + 1) % 4] - a;
    d = max(d, dot(p - a, normalize(vec2(e.y, -e.x))));
  }
  return d;
}
/** A shaded, round frame rod from s.xy to s.zw. */
void rod(inout vec4 acc, vec2 q, vec4 s) {
  vec2 pa = q - s.xy;
  vec2 ba = s.zw - s.xy;
  vec2 dv = pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float l = length(dv);
  float c = cov(l - ${g(ROD_R)});
  if (c <= 0.0) return;
  vec2 nxy = dv / max(l, ${g(ROD_R)});
  vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
  vec3 r = vec3(0.0, 0.0, -1.0) + 2.0 * n.z * n;
  vec3 col = uFrameCol * (0.4 + 0.8 * max(dot(n, uLDir[0]), 0.0)) + env(r) * 0.12;
  over(acc, min(col, vec3(1.0)), c);
}
/** A thin string from s.xy to s.zw, faded rather than thinned below a pixel. */
void cord(inout vec4 acc, vec2 q, vec4 s) {
  vec2 pa = q - s.xy;
  vec2 ba = s.zw - s.xy;
  float l = length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
  float w = max(${g(STRING_W)}, 0.5 * pxU);
  float c = cov(l - w) * (${g(STRING_W)} / w);
  if (c > 0.0) over(acc, uStringCol, 0.8 * c);
}
void ball(inout vec4 acc, vec2 q, int i) {
  vec4 b = uBall[i];
  vec2 d = q - b.xy;
  float l = length(d);
  float c = cov(l - 1.0);
  if (c <= 0.0) return;
  vec2 nxy = d / max(l, 1.0);
  vec3 n = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
  vec3 r = vec3(0.0, 0.0, -1.0) + 2.0 * n.z * n;
  // The neighbours, one bounce deep: the nearest ball the reflected ray hits.
  vec3 pos = b.xyz + n;
  float tBest = 1e9;
  int hit = -1;
  for (int j = 0; j < uCount; j++) {
    if (j == i) continue;
    vec3 oc = pos - uBall[j].xyz;
    float bb = dot(oc, r);
    float disc = bb * bb - dot(oc, oc) + 1.0;
    if (disc <= 0.0) continue;
    float t = -bb - sqrt(disc);
    if (t > 1e-3 && t < tBest) {
      tBest = t;
      hit = j;
    }
  }
  vec3 refl;
  if (hit >= 0) {
    vec3 n2 = normalize(pos + r * tBest - uBall[hit].xyz);
    refl = env(reflect(r, n2)) * uF0 * 0.9;
  } else {
    refl = env(r);
  }
  vec3 F = uF0 + (1.0 - uF0) * pow(1.0 - n.z, 5.0);
  vec3 col = refl * F + uDiffuse * (1.0 - F) * (0.3 + max(dot(n, uLDir[0]), 0.0));
  // A sharp glint of the key light.
  col += uLCol[0] * (uGlint * 0.15 * pow(max(dot(r, uLDir[0]), 0.0), 300.0));
  over(acc, min(col, vec3(1.0)), c);
}
void main() {
  vec2 p = gl_FragCoord.xy * uPx;
  vec2 q = (p - uOrigin.xy) / uOrigin.z;
  pxU = uPx / uOrigin.z;
  vec4 acc = vec4(0.0);

  // The base's soft contact shadow on the desk.
  vec2 w = onPlane(q, 0.0);
  vec2 e = abs(w) - uBase.xy;
  float sd = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  acc.a = 0.55 * (1.0 - smoothstep(-0.3, 1.2, sd));

  // The base, with the balls' shadows on its top.
  for (int f = 0; f < 3; f++) {
    float c = cov(quadSd(q, f));
    if (c <= 0.0) continue;
    vec3 col = uFaceCol[f];
    if (f == 0) {
      vec2 t = onPlane(q, uBase.z);
      float sh = 1.0;
      for (int i = 0; i < uCount; i++) {
        vec2 bw = uBallW[i];
        float h = bw.y - uBase.z - 1.0;
        float rad = 0.85 + 0.2 * h;
        float soft = 0.35 + 0.3 * h;
        float dd = length(vec2(t.x - bw.x, t.y));
        sh *= 1.0 - 0.6 / (1.0 + 0.4 * h) * (1.0 - smoothstep(rad - soft, rad + soft, dd));
      }
      col *= sh;
    }
    over(acc, col, c);
  }
  for (int k = 0; k < 3; k++) rod(acc, q, uRod[k]);
  for (int i = 0; i < uCount; i++) cord(acc, q, uStrB[i]);
  for (int i = 0; i < uCount; i++) ball(acc, q, i);
  for (int i = 0; i < uCount; i++) cord(acc, q, uStrF[i]);
  for (int k = 3; k < 6; k++) rod(acc, q, uRod[k]);
  // Same dither pattern as the room's blit, weighted so the blend keeps its sum.
  outColor = vec4(acc.rgb + dither8(gl_FragCoord.xy) * acc.a, acc.a);
}
`;

const tmp = new Float64Array(3);

/** Projects world (x, y, z) and writes view x, y into out[o], out[o + 1]. */
function put2(v: CradleView, x: number, y: number, z: number, out: Float32Array, o: number): void {
  project(v, x, y, z, tmp);
  out[o] = tmp[0];
  out[o + 1] = tmp[1];
}

/** Writes a world direction, normalised and rotated into view space, at out[o..o+2]. */
function putDir(v: CradleView, x: number, y: number, z: number, out: Float32Array, o: number) {
  const l = Math.hypot(x, y, z) || 1;
  rotateDir(v, x / l, y / l, z / l, tmp);
  out[o] = tmp[0];
  out[o + 1] = tmp[1];
  out[o + 2] = tmp[2];
}

/** Static per (side, count, scene): the frame rods, the base faces and the lights. */
interface Statics {
  rods: Float32Array;
  faces: Float32Array;
  faceCols: Float32Array;
  lDir: Float32Array;
  lX: Float32Array;
  lY: Float32Array;
  lSize: Float32Array;
  lCol: Float32Array;
  up: Float32Array;
  stringCol: Rgb;
}

function buildStatics(v: CradleView, count: number, scene: ScenePalette, out: Statics): void {
  const px = postX(count);
  const [bx, bz] = baseHalf(count);
  const r = out.rods;
  // Back posts and bar, then front ones.
  for (let k = 0; k < 2; k++) {
    const z = k === 0 ? -PIVOT_Z : PIVOT_Z;
    const o = k * 12;
    put2(v, -px, BASE_H, z, r, o);
    put2(v, -px, PIVOT_Y, z, r, o + 2);
    put2(v, px, BASE_H, z, r, o + 4);
    put2(v, px, PIVOT_Y, z, r, o + 6);
    put2(v, -px, PIVOT_Y, z, r, o + 8);
    put2(v, px, PIVOT_Y, z, r, o + 10);
  }
  // Visible faces: the top, the front (+z) and the end facing the viewer.
  const sx = v.sy > 0 ? -1 : 1;
  const f = out.faces;
  const quads: readonly (readonly [number, number, number])[][] = [
    [
      [-bx, BASE_H, -bz],
      [bx, BASE_H, -bz],
      [bx, BASE_H, bz],
      [-bx, BASE_H, bz],
    ],
    [
      [-bx, 0, bz],
      [bx, 0, bz],
      [bx, BASE_H, bz],
      [-bx, BASE_H, bz],
    ],
    [
      [sx * bx, 0, -bz],
      [sx * bx, 0, bz],
      [sx * bx, BASE_H, bz],
      [sx * bx, BASE_H, -bz],
    ],
  ];
  quads.forEach((quad, qi) => {
    quad.forEach(([x, y, z], k) => {
      put2(v, x, y, z, f, qi * 8 + k * 2);
    });
    // Make it counter-clockwise on screen.
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const a = qi * 8 + k * 2;
      const b = qi * 8 + ((k + 1) % 4) * 2;
      area += f[a] * f[b + 1] - f[b] * f[a + 1];
    }
    if (area < 0) {
      // Swap corners 1 and 3.
      const a = qi * 8 + 2;
      const b = qi * 8 + 6;
      [f[a], f[b]] = [f[b], f[a]];
      [f[a + 1], f[b + 1]] = [f[b + 1], f[a + 1]];
    }
  });
  // Lights: world directions mirrored to the side, then into view space.
  const key = scene.lights[0].dir;
  const kl = Math.hypot(key[0], key[1], key[2]);
  const kx = (key[0] * v.side) / kl;
  const ky = key[1] / kl;
  const kz = key[2] / kl;
  const frame = hexToUnitRgb(scene.frame);
  const top = hexToUnitRgb(scene.envTop);
  const normals = [
    [0, 1, 0],
    [0, 0, 1],
    [sx, 0, 0],
  ];
  normals.forEach(([nx, ny, nz], qi) => {
    const lit = 0.35 + 0.9 * Math.max(0, nx * kx + ny * ky + nz * kz);
    for (let c = 0; c < 3; c++) {
      out.faceCols[qi * 3 + c] = frame[c] * lit + top[c] * 0.05;
    }
  });
  scene.lights.forEach((light, k) => {
    const l = Math.hypot(light.dir[0], light.dir[1], light.dir[2]);
    const dx = (light.dir[0] * v.side) / l;
    const dy = light.dir[1] / l;
    const dz = light.dir[2] / l;
    putDir(v, dx, dy, dz, out.lDir, k * 3);
    // Rectangle axes: horizontal (up x d), then d x horizontal.
    const hx = dz;
    const hz = -dx;
    putDir(v, hx, 0, hz, out.lX, k * 3);
    putDir(v, dy * hz, dz * hx - dx * hz, -dy * hx, out.lY, k * 3);
    out.lSize.set([light.size[0], light.size[1], light.size[2], light.bars], k * 4);
    const col = hexToUnitRgb(light.color);
    for (let c = 0; c < 3; c++) {
      out.lCol[k * 3 + c] = col[c] * light.intensity;
    }
  });
  putDir(v, 0, 1, 0, out.up, 0);
  const hor = hexToUnitRgb(scene.envHorizon);
  for (let c = 0; c < 3; c++) {
    out.stringCol[c] = 0.85 * (0.7 * hor[c] + 0.3);
  }
}

/**
 * A Newton's cradle on a desk in a bottom corner: the end balls swing out and
 * click back in turn, the middle balls stay still, and the polished balls
 * mirror a soft studio.
 *
 * Passes: the room at 1/4 resolution, re-rendered only when it changes and
 * upscaled with dither every frame; then the cradle in one scissored
 * full-resolution box. The swing and the layout come from cradle-sim.ts.
 */
export const cradle = defineEffect(cradleMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (fs: string) => scopedProgram(gl, scope, FULLSCREEN_VERTEX, fs);

      const roomProgram = program(ROOM_FRAGMENT);
      const ru = createUniforms(gl, roomProgram, [
        "uPxToH",
        "uFrame",
        "uSide",
        "uWallTop",
        "uWallBottom",
        "uDeskFar",
        "uDeskNear",
        "uDesk",
        "uGlow",
        "uGlowAt",
      ]);
      const cradleProgram = program(CRADLE_FRAGMENT);
      const cu = createUniforms(gl, cradleProgram, [
        "uPx",
        "uOrigin",
        "uView",
        "uCount",
        "uBall",
        "uBallW",
        "uStrB",
        "uStrF",
        "uRod",
        "uFace",
        "uFaceCol",
        "uBase",
        "uF0",
        "uDiffuse",
        "uGlint",
        "uFrameCol",
        "uStringCol",
        "uEnvTop",
        "uEnvHor",
        "uEnvDesk",
        "uUp",
        "uLDir",
        "uLX",
        "uLY",
        "uLSize",
        "uLCol",
      ]);

      const rightView = createView(1);
      const leftView = createView(-1);
      const layout = createLayout();
      const state = new Float64Array(4);
      const ballView = new Float64Array(MAX_BALLS * 3);
      const ballWorld = new Float64Array(MAX_BALLS * 2);
      const depth = new Float64Array(MAX_BALLS);
      const order = new Int32Array(MAX_BALLS);
      const uBall = new Float32Array(MAX_BALLS * 4);
      const uBallW = new Float32Array(MAX_BALLS * 2);
      const uStrB = new Float32Array(MAX_BALLS * 4);
      const uStrF = new Float32Array(MAX_BALLS * 4);
      const statics: Statics = {
        rods: new Float32Array(24),
        faces: new Float32Array(24),
        faceCols: new Float32Array(9),
        lDir: new Float32Array(6),
        lX: new Float32Array(6),
        lY: new Float32Array(6),
        lSize: new Float32Array(8),
        lCol: new Float32Array(6),
        up: new Float32Array(3),
        stringCol: [0, 0, 0],
      };
      /** The inputs the statics and the room were built from. */
      const staticKey = createChangeKey(3);
      const roomKey = createChangeKey(2);

      let time = 0;
      let amp = Number.NaN;
      let width = 1;
      let height = 1;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, ROOM_TEXEL_REF * scale));
          gl.useProgram(roomProgram);
          ru.f2(
            "uPxToH",
            target.fullWidth / target.width / height,
            target.fullHeight / target.height / height,
          );
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          time += step;
          const goal = swingRadians(p.swing);
          amp = Number.isNaN(amp) ? goal : approach(amp, goal, AMP_RATE * step);

          const count = ballCount(p.balls);
          const lifted = liftedCount(p.lifted, count);
          const view = cornerSide(p.corner) < 0 ? leftView : rightView;
          const scene = sceneOf(p.scene);
          cradleLayout(aspect, p.size, count, view, layout);

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          roomKey.setText(0, p.scene);
          roomKey.set(1, view.side);
          if (target.needsRedraw(roomKey)) {
            target.bind();
            gl.useProgram(roomProgram);
            ru.f2("uFrame", aspect, 1);
            ru.f1("uSide", view.side);
            ru.rgb("uWallTop", scene.wallTop);
            ru.rgb("uWallBottom", scene.wallBottom);
            ru.rgb("uDeskFar", scene.deskFar);
            ru.rgb("uDeskNear", scene.deskNear);
            ru.f2("uDesk", scene.deskY, scene.deskSoft);
            const glow = hexToUnitRgb(scene.glow);
            const s = scene.glowStrength;
            ru.f3("uGlow", glow[0] * s, glow[1] * s, glow[2] * s);
            ru.f3("uGlowAt", scene.glowAt[0], scene.glowAt[1], scene.glowAt[2]);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();

          // 2. The cradle, premultiplied, in its box.
          gl.viewport(0, 0, width, height);
          gl.useProgram(cradleProgram);
          staticKey.setText(0, p.scene);
          staticKey.set(1, view.side);
          staticKey.set(2, count);
          if (staticKey.take()) {
            buildStatics(view, count, scene, statics);
            const [bx, bz] = baseHalf(count);
            gl.uniform4fv(cu.loc.uRod, statics.rods);
            gl.uniform2fv(cu.loc.uFace, statics.faces);
            gl.uniform3fv(cu.loc.uFaceCol, statics.faceCols);
            gl.uniform3fv(cu.loc.uLDir, statics.lDir);
            gl.uniform3fv(cu.loc.uLX, statics.lX);
            gl.uniform3fv(cu.loc.uLY, statics.lY);
            gl.uniform4fv(cu.loc.uLSize, statics.lSize);
            gl.uniform3fv(cu.loc.uLCol, statics.lCol);
            cu.v3("uUp", statics.up);
            cu.v3("uStringCol", statics.stringCol);
            cu.f3("uBase", bx, bz, BASE_H);
          }
          cu.f1("uPx", 1 / height);
          cu.f3("uOrigin", layout.ox, layout.oy, layout.unit);
          cu.f4("uView", view.cy, view.sy, view.cp, view.sp);
          cu.i1("uCount", count);
          cu.rgb("uFrameCol", scene.frame);
          cu.rgb("uEnvTop", scene.envTop);
          cu.rgb("uEnvHor", scene.envHorizon);
          cu.rgb("uEnvDesk", scene.envDesk);
          const finish = finishOf(p.finish);
          cu.v3("uF0", finish.f0);
          cu.v3("uDiffuse", finish.base);
          cu.f1("uGlint", finish.glint);

          // The balls: pose, project, sort far to near; strings from both pivots.
          swingState(time, amp, state);
          for (let i = 0; i < count; i++) {
            const a = ballAngle(i, count, lifted, state);
            const s = Math.sin(a);
            const c = Math.cos(a);
            const x0 = restX(i, count);
            const x = x0 + STRING_LEN * s;
            const y = PIVOT_Y - STRING_LEN * c;
            ballWorld[i * 2] = x;
            ballWorld[i * 2 + 1] = y;
            project(view, x, y, 0, ballView, i * 3);
            depth[i] = ballView[i * 3 + 2];
            // The eyelet on top of the ball, towards the pivot axis.
            const o = i * 4;
            put2(view, x0, PIVOT_Y, -PIVOT_Z, uStrB, o);
            put2(view, x0, PIVOT_Y, PIVOT_Z, uStrF, o);
            project(view, x - BALL_R * s, y + BALL_R * c, 0, tmp);
            uStrB[o + 2] = uStrF[o + 2] = tmp[0];
            uStrB[o + 3] = uStrF[o + 3] = tmp[1];
          }
          sortByDepth(depth, count, order);
          for (let k = 0; k < count; k++) {
            const i = order[k];
            uBall[k * 4] = ballView[i * 3];
            uBall[k * 4 + 1] = ballView[i * 3 + 1];
            uBall[k * 4 + 2] = ballView[i * 3 + 2];
            uBallW[k * 2] = ballWorld[i * 2];
            uBallW[k * 2 + 1] = ballWorld[i * 2 + 1];
          }
          gl.uniform4fv(cu.loc.uBall, uBall);
          gl.uniform2fv(cu.loc.uBallW, uBallW);
          gl.uniform4fv(cu.loc.uStrB, uStrB);
          gl.uniform4fv(cu.loc.uStrF, uStrF);

          const x0 = Math.max(0, Math.floor(layout.box[0] * height));
          const y0 = Math.max(0, Math.floor(layout.box[1] * height));
          const x1 = Math.min(width, Math.ceil(layout.box[2] * height));
          const y1 = Math.min(height, Math.ceil(layout.box[3] * height));
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          triangle.draw();

          gl.disable(gl.BLEND);
          gl.disable(gl.SCISSOR_TEST);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
