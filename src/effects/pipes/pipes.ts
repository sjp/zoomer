import {
  BEND_RADIUS,
  brightness,
  CAP_LENGTH,
  createPipes,
  DIRS,
  growth,
  PALETTE_SIZE,
  PIECE_BALL,
  PIECE_CAP,
  PIECE_ELBOW,
  type Pipes,
  updatePipes,
} from "./pipes-sim";
import { cameraMatrix, maxSegmentRate, ORBIT_RATE, tubeMesh } from "./pipes-view";
import { type PipesJoints, pipesMeta } from "./pipes.meta";
import {
  beginFrame,
  createFullscreenTriangle,
  createRenderTarget,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  type Scope,
  scopedProgram,
  type Uniforms,
  withScope,
} from "../gl";
import { approach, smoothstep, wrap } from "../math";
import { defineEffect } from "../types";

const g = glslFloat;
const TAU = Math.PI * 2;

/** Sizes in node spacings. The ball is wider than the pipe; caps are a short, wider collar. */
const PIPE_RADIUS = 0.2;
const BALL_RADIUS = 0.3;
const CAP_RADIUS = 0.25;
/** Where a pipe meets a ball's surface, measured from the ball's centre along the pipe. */
const CREASE = Math.sqrt(BALL_RADIUS * BALL_RADIUS - PIPE_RADIUS * PIPE_RADIUS);

/** Sides round each pipe, and bands along the elbows and balls. */
const SIDES = 16;
const ROUND_BANDS = 12;
/** Floats per piece instance: four vec4s. */
const INSTANCE_FLOATS = 16;
/** Classic style's pixel, in reference (1080p) px. */
const CLASSIC_PIXEL = 3;
/** Seconds for each half of the dip to black and back when the style changes. */
const STYLE_DIP_SECONDS = 0.5;
/** Seconds for the orbit to spin up to speed or settle to a stop. */
const ORBIT_EASE_SECONDS = 3;

/** The classic set: red, green, blue, yellow, cyan, magenta, white, orange. */
const PALETTE = new Float32Array([
  0.86, 0.07, 0.05, 0.08, 0.78, 0.12, 0.1, 0.22, 0.92, 0.92, 0.82, 0.08, 0.08, 0.8, 0.86, 0.84, 0.1,
  0.8, 0.85, 0.85, 0.85, 0.95, 0.47, 0.05,
]);
if (PALETTE.length !== PALETTE_SIZE * 3) {
  throw new Error("pipes: palette size mismatch");
}

/** Key light, in view space (right, up, towards the viewer): upper left, in front. */
const LIGHT_VIEW = (() => {
  const v = [-0.45, 0.62, 0.64];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
})();

/**
 * Bends the shared tube mesh into each piece: a straight tube (or cap) along
 * its axis, a ball swelling from the pipe's width to its own as it grows, or a
 * quarter-torus elbow from the incoming direction to the outgoing one, swept
 * as it grows. Growth is the fraction of the piece's own stretch of its step's
 * path covered so far (`uGrow` of the whole path; 1 for finished pieces).
 * Classic lights per vertex, as 90s fixed-function hardware did; Modern passes
 * what the fragment shader needs.
 */
const pieceVertex = (classic: boolean) => /* glsl */ `#version 300 es
layout(location = 0) in vec4 aMesh;
/** Position (tube start or joint centre), kind (0 tube, 1 ball, 2 elbow). */
layout(location = 1) in vec4 aI0;
/** Axis or incoming direction; length, ball radius or bend radius. */
layout(location = 2) in vec4 aI1;
/** Outgoing direction (tubes: ball at start, ball at end, 0); pipe radius. */
layout(location = 3) in vec4 aI2;
/** Colour index, path start, path length, whole path. */
layout(location = 4) in vec4 aI3;
uniform mat4 uViewProj;
uniform float uGrow;
uniform vec3 uPalette[${String(PALETTE_SIZE)}];
uniform vec3 uEye;
uniform vec3 uLight;
${
  classic
    ? "out vec3 vColour;"
    : `out vec3 vPos;
out vec3 vNormal;
out float vAlong;
flat out vec3 vBase;
flat out int vKind;
flat out vec3 vA;
flat out vec3 vB;
flat out float vLength;`
}
void main() {
  float f = clamp((uGrow * aI3.w - aI3.y) / aI3.z, 0.0, 1.0);
  int kind = int(aI0.w + 0.5);
  float c = cos(aMesh.y);
  float s = sin(aMesh.y);
  vec3 A = aI1.xyz;
  vec3 B = aI2.xyz;
  float r = aI2.w;
  vec3 p;
  vec3 n;
  float along = 0.0;
  float len = 0.0;
  if (kind == 1) {
    float a = aMesh.x * 3.14159265;
    vec3 d = vec3(sin(a) * c, cos(a), sin(a) * s);
    p = aI0.xyz + d * mix(r, aI1.w, f);
    n = d;
  } else if (kind == 2) {
    float R = aI1.w;
    float th = aMesh.x * f * 1.57079633;
    vec3 radial = sin(th) * A - cos(th) * B;
    vec3 tangent = cos(th) * A + sin(th) * B;
    vec3 ring = c * radial + s * cross(A, B);
    p = aI0.xyz + (B - A) * R + radial * R + ring * (r * aMesh.z);
    n = aMesh.w != 0.0 ? tangent * aMesh.w : ring;
  } else {
    vec3 e1 = abs(A.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 ring = c * e1 + s * cross(A, e1);
    len = aI1.w;
    along = aMesh.x * len * f;
    p = aI0.xyz + A * along + ring * (r * aMesh.z);
    n = aMesh.w != 0.0 ? A * aMesh.w : ring;
  }
  vec3 base = uPalette[int(aI3.x + 0.5)];
  gl_Position = uViewProj * vec4(p, 1.0);
${
  classic
    ? `  vec3 V = normalize(uEye - p);
  vec3 H = normalize(uLight + V);
  float diff = max(dot(n, uLight), 0.0);
  float spec = pow(max(dot(n, H), 0.0), 24.0);
  vColour = base * (0.22 + 0.78 * diff) + 0.75 * spec;`
    : `  vPos = p;
  vNormal = n;
  vAlong = along;
  vBase = base;
  vKind = kind;
  vA = A;
  vB = B;
  vLength = len;`
}
}
`;

const CLASSIC_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vColour;
out vec4 outColor;
void main() {
  outColor = vec4(vColour, 1.0);
}
`;

/**
 * Modern: per-pixel Phong with a tight highlight, soft occlusion in the creases
 * where a pipe enters a ball joint, and a faint reflection of a dim studio
 * (lighter above, dark below) rising towards grazing angles.
 */
const MODERN_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in float vAlong;
flat in vec3 vBase;
flat in int vKind;
flat in vec3 vA;
flat in vec3 vB;
flat in float vLength;
uniform vec3 uEye;
uniform vec3 uLight;
out vec4 outColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uEye - vPos);
  float ao = 1.0;
  if (vKind == 0) {
    float a = vB.x * exp(-max(vAlong - ${g(CREASE)}, 0.0) * 9.0);
    float b = vB.y * exp(-max(vLength - vAlong - ${g(CREASE)}, 0.0) * 9.0);
    ao -= 0.45 * (a + b);
  } else if (vKind == 1) {
    ao -= 0.45 * (smoothstep(0.4, 0.78, dot(N, -vA)) + smoothstep(0.4, 0.78, dot(N, vB)));
  }
  vec3 H = normalize(uLight + V);
  float diff = max(dot(N, uLight), 0.0);
  float spec = pow(max(dot(N, H), 0.0), 70.0);
  vec3 col = vBase * (0.16 * ao + 0.84 * diff * mix(1.0, ao, 0.6)) + 0.85 * spec * ao;
  vec3 R = reflect(-V, N);
  vec3 env = mix(vec3(0.01), vec3(0.3, 0.31, 0.33), smoothstep(-0.2, 0.7, R.y));
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  col += env * fres * 0.6 * ao;
  outColor = vec4(col, 1.0);
}
`;

/** The cached or live scene to the canvas, scaled by the fade, with sub-LSB dither. */
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

const PIECE_UNIFORMS = ["uViewProj", "uGrow", "uPalette", "uEye", "uLight"] as const;
type PieceUniforms = Uniforms<(typeof PIECE_UNIFORMS)[number]>;

/**
 * One mesh drawn once per piece, from an append-only instance buffer: pieces
 * `0 .. frozen - 1` are finished, of which `0 .. cached - 1` are already in
 * the cached image; the rest are still growing.
 */
interface PieceBatch {
  readonly data: Float32Array;
  count: number;
  frozen: number;
  cached: number;
  /** Uploads the pieces appended since the last upload. */
  upload: () => void;
  draw: (first: number, count: number) => void;
  /** Forgets every piece, for a new round. */
  clear: () => void;
}

function createPieceBatch(
  gl: WebGL2RenderingContext,
  scope: Scope,
  mesh: Float32Array,
  capacity: number,
): PieceBatch {
  const vao = scope.add(gl.createVertexArray(), (v) => {
    gl.deleteVertexArray(v);
  });
  const meshBuffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  const instanceBuffer = scope.add(gl.createBuffer(), (b) => {
    gl.deleteBuffer(b);
  });
  const data = new Float32Array(capacity * INSTANCE_FLOATS);
  const vertices = mesh.length / 4;
  const stride = INSTANCE_FLOATS * 4;
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, meshBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, mesh, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data.byteLength, gl.DYNAMIC_DRAW);
  for (let loc = 1; loc <= 4; loc++) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, (loc - 1) * 16);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  let uploaded = 0;
  const batch: PieceBatch = {
    data,
    count: 0,
    frozen: 0,
    cached: 0,
    upload() {
      if (batch.count <= uploaded) {
        return;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        uploaded * stride,
        data,
        uploaded * INSTANCE_FLOATS,
        (batch.count - uploaded) * INSTANCE_FLOATS,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      uploaded = batch.count;
    },
    draw(first, count) {
      if (count <= 0) {
        return;
      }
      // No base instance in WebGL2: point the instance attributes at the first piece.
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
      for (let loc = 1; loc <= 4; loc++) {
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, stride, first * stride + (loc - 1) * 16);
      }
      gl.drawArraysInstanced(gl.TRIANGLES, 0, vertices, count);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    },
    clear() {
      batch.count = 0;
      batch.frozen = 0;
      batch.cached = 0;
      uploaded = 0;
    },
  };
  return batch;
}

/** Writes piece `i` of the log into its batch's instance data. */
function writePiece(s: Pipes, i: number, tubes: PieceBatch, rounds: PieceBatch): void {
  const kind = s.kind[i];
  const round = kind === PIECE_BALL || kind === PIECE_ELBOW;
  const batch = round ? rounds : tubes;
  const d = batch.data;
  const o = batch.count * INSTANCE_FLOATS;
  batch.count++;
  const cell = s.node[i];
  const dims = s.dims;
  const x = (cell % dims.x) - (dims.x - 1) / 2;
  const y = (Math.floor(cell / dims.x) % dims.y) - (dims.y - 1) / 2;
  const z = Math.floor(cell / (dims.x * dims.y)) - (dims.z - 1) / 2;
  const a = DIRS[s.dirA[i]];
  const b = s.dirB[i] >= 0 ? DIRS[s.dirB[i]] : DIRS[0];
  if (round) {
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = kind === PIECE_BALL ? 1 : 2;
    d[o + 7] = kind === PIECE_BALL ? BALL_RADIUS : BEND_RADIUS;
    d[o + 8] = b[0];
    d[o + 9] = b[1];
    d[o + 10] = b[2];
  } else {
    const cap = kind === PIECE_CAP;
    const back = cap ? -CAP_LENGTH / 2 : s.trimStart[i] * BEND_RADIUS;
    d[o] = x + a[0] * back;
    d[o + 1] = y + a[1] * back;
    d[o + 2] = z + a[2] * back;
    d[o + 3] = 0;
    d[o + 7] = cap ? CAP_LENGTH : s.pathLength[i];
    d[o + 8] = cap ? 0 : s.ballStart[i];
    d[o + 9] = cap ? 0 : s.ballEnd[i];
    d[o + 10] = 0;
  }
  d[o + 4] = a[0];
  d[o + 5] = a[1];
  d[o + 6] = a[2];
  d[o + 11] = kind === PIECE_CAP ? CAP_RADIUS : PIPE_RADIUS;
  d[o + 12] = s.pieceColour[i];
  d[o + 13] = s.pathStart[i];
  d[o + 14] = s.pathLength[i];
  d[o + 15] = s.pathTotal[i];
}

const isClassic = (style: string) => style === "classic";

const isJoints = (v: string): v is PipesJoints => v === "balls" || v === "elbows" || v === "mixed";

/**
 * The Windows 3D Pipes screensaver: shiny pipes growing a segment at a time
 * through a hidden 3D grid, turning at ball joints or elbows, until the
 * picture fades to black and starts again.
 *
 * Every piece is an instance of one of two meshes (a plain tube for pipes and
 * caps, a banded one bent into balls and elbows), drawn with a depth buffer
 * into an offscreen image. Finished pieces never change, so they are drawn
 * once into a cached colour and depth image; each frame copies it and draws
 * only the growing ends over it, then scales it onto the canvas with the fade.
 * The cache is redrawn whole on a resize, a style change, a new round, and
 * every frame while the camera orbits. Classic draws at a third of the
 * reference resolution with per-vertex lighting; Modern draws at full
 * resolution with per-pixel lighting, crease shading and a faint reflection.
 */
export const pipes = defineEffect(pipesMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const pieceUniforms = (classic: boolean): PieceUniforms => {
        const fs = classic ? CLASSIC_FRAGMENT : MODERN_FRAGMENT;
        const u = createUniforms(
          gl,
          scopedProgram(gl, scope, pieceVertex(classic), fs),
          PIECE_UNIFORMS,
        );
        gl.useProgram(u.program);
        gl.uniform3fv(u.loc.uPalette, PALETTE);
        return u;
      };
      const classicU = pieceUniforms(true);
      const modernU = pieceUniforms(false);
      const cu = createUniforms(
        gl,
        scopedProgram(gl, scope, FULLSCREEN_VERTEX, COMPOSITE_FRAGMENT),
        ["uScene", "uBright"],
      );
      gl.useProgram(cu.program);
      cu.i1("uScene", 0);
      gl.useProgram(null);

      const sim = createPipes(pipesMeta.params.seed.default);
      const tubes = createPieceBatch(gl, scope, tubeMesh(1, SIDES), sim.capacity);
      const rounds = createPieceBatch(gl, scope, tubeMesh(ROUND_BANDS, SIDES), sim.capacity);

      const cacheDepth = scope.add(gl.createRenderbuffer(), (r) => {
        gl.deleteRenderbuffer(r);
      });
      const workDepth = scope.add(gl.createRenderbuffer(), (r) => {
        gl.deleteRenderbuffer(r);
      });
      /** Finished pieces, and the frame (cache plus growing ends): colour with depth. */
      let cache: RenderTarget | null = null;
      let work: RenderTarget | null = null;
      scope.defer(() => {
        cache?.dispose();
        work?.dispose();
      });
      let cacheValid = false;

      let width = 1;
      let height = 1;
      let scale = 1;
      let shownClassic = isClassic(pipesMeta.params.style.default);
      /** Brightness of the dip to black while the style changes; 1 when settled. */
      let dip = 1;
      /** Whether a frame has run yet: the first one takes the style asked for without a dip. */
      let started = false;
      let yaw = 0;
      let omega = 0;
      const viewProj = new Float32Array(16);
      const eye = new Float32Array(3);
      const light = new Float32Array(3);
      let camAspect = Number.NaN;
      let camYaw = Number.NaN;
      /** Camera changes so far, and the one each program last received. */
      let camVersion = 0;
      let classicCam = -1;
      let modernCam = -1;
      let drawnRound = -1;
      let written = 0;
      let frozenScan = 0;

      const withDepth = (target: RenderTarget | null, depth: WebGLRenderbuffer) => {
        if (!target) {
          return;
        }
        gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, target.width, target.height);
        gl.bindRenderbuffer(gl.RENDERBUFFER, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      };

      /** (Re)creates the cache and frame images at the shown style's resolution. */
      const allocTargets = () => {
        cache?.dispose();
        work?.dispose();
        cache = null;
        work = null;
        const px = shownClassic ? CLASSIC_PIXEL * scale : 1;
        const w = Math.max(1, Math.min(width, Math.round(width / px)));
        const h = Math.max(1, Math.min(height, Math.round(height / px)));
        cache = createRenderTarget(gl, w, h, gl.RGBA8, { filter: gl.NEAREST });
        work = createRenderTarget(gl, w, h, gl.RGBA8, { filter: gl.NEAREST });
        withDepth(cache, cacheDepth);
        withDepth(work, workDepth);
        cacheValid = false;
      };

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / 1080;
          allocTargets();
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;

          // 1. Orbit, then growth capped so the sliding end stays codec-friendly.
          omega = approach(omega, p.orbit ? ORBIT_RATE : 0, (ORBIT_RATE * dt) / ORBIT_EASE_SECONDS);
          if (omega > 0) {
            yaw = wrap(yaw + omega * dt, 0, TAU);
          }
          const rate = Math.min(p.speed, maxSegmentRate(aspect, yaw, omega));
          const joints = isJoints(p.joints) ? p.joints : "mixed";
          updatePipes(sim, dt, rate, p.count, joints, p.fill, p.seed);

          // 2. A style change dips to black, switches at the bottom and comes back.
          const classic = isClassic(p.style);
          if (!started) {
            started = true;
            if (classic !== shownClassic) {
              shownClassic = classic;
              // Allocates the asked-for style's images, on the first frame only.
              allocTargets();
            }
          }
          if (classic === shownClassic) {
            dip = Math.min(1, dip + dt / STYLE_DIP_SECONDS);
          } else {
            dip = Math.max(0, dip - dt / STYLE_DIP_SECONDS);
            if (dip === 0) {
              shownClassic = classic;
              // Allocates the new style's images, once per style change.
              allocTargets();
            }
          }

          // 3. The camera, when the aspect or orbit moved it.
          if (aspect !== camAspect || yaw !== camYaw) {
            camAspect = aspect;
            camYaw = yaw;
            cameraMatrix(aspect, yaw, viewProj, eye);
            const sy = Math.sin(yaw);
            const cy = Math.cos(yaw);
            light[0] = LIGHT_VIEW[0] * cy + LIGHT_VIEW[2] * sy;
            light[1] = LIGHT_VIEW[1];
            light[2] = -LIGHT_VIEW[0] * sy + LIGHT_VIEW[2] * cy;
            camVersion++;
            cacheValid = false;
          }

          // 4. New pieces into the instance buffers; a new round starts them afresh.
          if (sim.round !== drawnRound) {
            drawnRound = sim.round;
            tubes.clear();
            rounds.clear();
            written = 0;
            frozenScan = 0;
            cacheValid = false;
          }
          while (written < sim.count) {
            writePiece(sim, written, tubes, rounds);
            written++;
          }
          tubes.upload();
          rounds.upload();
          while (frozenScan < sim.frozen) {
            const k = sim.kind[frozenScan];
            if (k === PIECE_BALL || k === PIECE_ELBOW) {
              rounds.frozen++;
            } else {
              tubes.frozen++;
            }
            frozenScan++;
          }

          const c = cache;
          const w = work;
          if (!c || !w) {
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            return;
          }
          const u = shownClassic ? classicU : modernU;
          gl.useProgram(u.program);
          if ((u === classicU ? classicCam : modernCam) !== camVersion) {
            gl.uniformMatrix4fv(u.loc.uViewProj, false, viewProj);
            if (u === classicU) {
              classicCam = camVersion;
            } else {
              modernCam = camVersion;
            }
          }
          u.f3("uEye", eye[0], eye[1], eye[2]);
          u.f3("uLight", light[0], light[1], light[2]);
          gl.enable(gl.DEPTH_TEST);
          gl.depthFunc(gl.LESS);
          gl.depthMask(true);

          // 5. Finished pieces into the cache: all of them after an invalidation, else the new ones.
          if (!cacheValid) {
            c.bind();
            gl.clearColor(0, 0, 0, 1);
            gl.clearDepth(1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            tubes.cached = 0;
            rounds.cached = 0;
            cacheValid = true;
          }
          if (tubes.cached < tubes.frozen || rounds.cached < rounds.frozen) {
            c.bind();
            u.f1("uGrow", 1);
            tubes.draw(tubes.cached, tubes.frozen - tubes.cached);
            rounds.draw(rounds.cached, rounds.frozen - rounds.cached);
            tubes.cached = tubes.frozen;
            rounds.cached = rounds.frozen;
          }

          // 6. The growing ends over a copy of the cache, depth-tested against it.
          let scene = c;
          if (tubes.count > tubes.frozen || rounds.count > rounds.frozen) {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, c.framebuffer);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, w.framebuffer);
            gl.blitFramebuffer(
              0,
              0,
              c.width,
              c.height,
              0,
              0,
              w.width,
              w.height,
              gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT,
              gl.NEAREST,
            );
            w.bind();
            u.f1("uGrow", growth(sim));
            tubes.draw(tubes.frozen, tubes.count - tubes.frozen);
            rounds.draw(rounds.frozen, rounds.count - rounds.frozen);
            scene = w;
          }
          gl.disable(gl.DEPTH_TEST);

          // 7. Onto the canvas, scaled by the round's fade and the style dip.
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.viewport(0, 0, width, height);
          gl.useProgram(cu.program);
          cu.f1("uBright", brightness(sim) * smoothstep(0, 1, dip));
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, scene.texture);
          triangle.draw();
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
