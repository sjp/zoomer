import type { Rgb } from "../color";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget } from "../lowres";
import {
  type Board,
  buildRun,
  createMarbles,
  LIFT_SPEED,
  MARBLE_R,
  type MarbleSide,
  fadeMarbles,
  placeMarbles,
  setMarbleCount,
  pointAt,
  type Run,
  stepMarbles,
} from "./marblerun-sim";
import { type MarbleGlass, MAX_MARBLES, marblerunMeta } from "./marblerun.meta";
import { wrap } from "../math";
import { HASH32_GLSL } from "../noise";
import { createSpriteBatch, polygonStrip, QUAD } from "../sprites";
import { defineEffect } from "../types";
import { createChangeKey } from "../change-key";

const g = glslFloat;

/** Backdrop pass: about 4 reference px per texel. It is soft and static. */
const BACKDROP_TEXEL_REF = 4;
/** Most wooden pieces: panel, frame, lift and cap, posts, rails. */
const MAX_BOARDS = 24;
/** Lift screw thread pitch (frame heights). */
const SCREW_PITCH = 0.03;
/** Warm light from the upper left. */
const LIGHT: Rgb = [1, 0.93, 0.82];
const LIGHT_DIR = [-0.55, 0.835] as const;
/** Shadows: offset (frame heights, away from the light), blur and opacity. */
const BACK_SHADOW = [0.009, -0.013, 0.012] as const;
const FRONT_SHADOW = [0.004, -0.006, 0.003] as const;
const MARBLE_SHADOW = [0.006, -0.009, 1.3] as const;
const SHADOW_ALPHA = 0.38;
/** The birch panel, which the marbles' refraction shows upside down. */
const PANEL: Rgb = [0.86, 0.75, 0.57];

/** Glass colours, picked by marble index. */
const PALETTE: readonly Rgb[] = [
  [0.16, 0.36, 0.9],
  [0.95, 0.58, 0.14],
  [0.13, 0.68, 0.36],
  [0.86, 0.16, 0.22],
  [0.1, 0.64, 0.72],
  [0.58, 0.3, 0.86],
  [0.95, 0.84, 0.2],
  [0.95, 0.44, 0.36],
];
const CLEAR_GLASS: Rgb = [0.9, 0.97, 0.96];
const MILKY: Rgb = [0.97, 0.95, 0.9];

/**
 * A soft, out-of-focus room behind the run: a warm wall, a window's glow on the
 * far side, a table top along the bottom and a vignette. Static.
 */
const BACKDROP_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
/** Low-res px -> frame heights. */
uniform vec2 uPxToH;
/** Frame width in frame heights. */
uniform float uAspect;
/** 1 when the run is on the right, so the window is on the left; 0 otherwise. */
uniform float uRight;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy * uPxToH;
  vec3 top = vec3(0.74, 0.69, 0.62);
  vec3 low = vec3(0.6, 0.53, 0.45);
  vec3 col = mix(low, top, smoothstep(0.0, 1.0, p.y));
  // The window: a big blurred bright pane on the side away from the run.
  float wx = mix(uAspect * 0.78, uAspect * 0.22, uRight);
  vec2 w = abs(p - vec2(wx, 0.66)) - vec2(0.2, 0.24);
  float pane = 1.0 - smoothstep(-0.05, 0.16, max(w.x, w.y));
  col += vec3(0.2, 0.2, 0.18) * pane;
  col += vec3(0.1, 0.08, 0.05) * exp(-3.0 * dot(p - vec2(wx, 0.5), p - vec2(wx, 0.5)));
  // The table top the run stands on, out of focus.
  float table = 1.0 - smoothstep(0.02, 0.07, p.y);
  col = mix(col, vec3(0.4, 0.28, 0.19), table);
  vec2 v = p / vec2(uAspect, 1.0) - 0.5;
  col *= 1.0 - 0.4 * dot(v, v);
  outColor = vec4(col, 1.0);
}
`;

/** Shadow uniform: offset xy, blur (or scale), and 1 for the shadow pass. */
const BOARD_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** The piece's centre line A -> B. */
layout(location = 1) in vec4 aSeg;
/** Half-thickness, kind, tint, screw phase. */
layout(location = 2) in vec4 aBox;
uniform vec2 uToClip;
uniform float uPx;
uniform vec4 uShadow;
out vec2 vLocal;
out vec2 vWorld;
flat out vec4 vBox;
flat out vec4 vAxes;
flat out float vHalfLen;
void main() {
  vec2 d = aSeg.zw - aSeg.xy;
  float len = length(d);
  vec2 dir = len > 0.0 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  // Local +y always faces up (or left on uprights), so rails keep their groove on top.
  if (nrm.y < 0.0 || (nrm.y == 0.0 && nrm.x > 0.0)) nrm = -nrm;
  float pad = 2.0 * uPx + uShadow.z * uShadow.w;
  vLocal = aCorner * vec2(0.5 * len + pad, aBox.x + pad);
  vec2 centre = 0.5 * (aSeg.xy + aSeg.zw) + uShadow.xy * uShadow.w;
  vWorld = centre + dir * vLocal.x + nrm * vLocal.y;
  vBox = aBox;
  vAxes = vec4(dir, nrm);
  vHalfLen = 0.5 * len;
  gl_Position = vec4(vWorld * uToClip - 1.0, 0.0, 1.0);
}
`;

/**
 * Wooden pieces, premultiplied: a rounded box with wood grain along its length,
 * bevelled edges lit from the upper left, a groove along each rail's top, and
 * the lift's turning screw thread. The shadow pass draws the box as soft black.
 */
const BOARD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vWorld;
flat in vec4 vBox;
flat in vec4 vAxes;
flat in float vHalfLen;
uniform float uPx;
uniform vec4 uShadow;
uniform float uShadowAlpha;
uniform vec3 uLight;
uniform vec2 uLDir;
out vec4 outColor;
${HASH32_GLSL}
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p)) + 8192);
  return float(hash32(q.x * 1973u + hash32(q.y))) * (1.0 / 4294967295.0);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float hw = vBox.x;
  // Kinds as in marblerun-sim.ts: panel, frame, rail, post, lift.
  float kind = vBox.y;
  float rr = min(0.5 * hw, 0.003);
  vec2 qd = abs(vLocal) - vec2(vHalfLen, hw) + rr;
  float sdf = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - rr;
  if (uShadow.w > 0.5) {
    float s = uShadowAlpha * (1.0 - smoothstep(-uShadow.z, uShadow.z, sdf));
    outColor = vec4(0.0, 0.0, 0.0, s);
    return;
  }
  float cov = clamp(0.5 - sdf / uPx, 0.0, 1.0);
  vec3 base = kind < 0.5 ? vec3(${g(PANEL[0])}, ${g(PANEL[1])}, ${g(PANEL[2])})
    : kind < 1.5 ? vec3(0.78, 0.6, 0.4)
    : kind < 2.5 ? vec3(0.8, 0.55, 0.32)
    : kind < 3.5 ? vec3(0.62, 0.42, 0.25)
    : vec3(0.5, 0.34, 0.2);
  base *= 1.0 + 0.08 * vBox.z;
  // Grain along the piece: wavy rings across its thickness, with fibres.
  vec2 gp = vLocal + vBox.z * 7.3;
  float warp = noise(vec2(gp.x * 5.0, gp.y * 40.0));
  float rings = 0.5 + 0.5 * sin(gp.y * 620.0 + warp * 5.0 + gp.x * 3.0);
  float fibre = noise(vec2(gp.x * 30.0, gp.y * 900.0));
  vec3 col = base * (0.86 + 0.1 * rings * rings + 0.06 * fibre);

  // Bevel: the edge facing the light is bright, the far one shaded.
  float inset = -sdf;
  vec2 side = qd.x > qd.y ? vec2(sign(vLocal.x), 0.0) : vec2(0.0, sign(vLocal.y));
  vec2 outward = side.x * vAxes.xy + side.y * vAxes.zw;
  float bw = kind < 0.5 ? 0.004 : min(0.0035, 0.6 * hw);
  float bev = 1.0 - smoothstep(0.0, bw, inset);
  col *= 1.0 + 0.4 * bev * dot(outward, uLDir);

  float t = vLocal.y / hw;
  if (kind > 1.5 && kind < 2.5) {
    // Rail: a shaded groove just under the top lip, and a lighter lip.
    float groove = smoothstep(0.15, 0.3, t) * (1.0 - smoothstep(0.62, 0.75, t));
    col *= 1.0 - 0.3 * groove;
    col *= 1.0 + 0.18 * smoothstep(0.75, 0.9, t);
    col *= 0.94 + 0.06 * t;
  } else if (kind > 3.5) {
    // Lift: a turned screw, its thread climbing with the phase.
    float nx = clamp(t, -1.0, 1.0);
    float cyl = sqrt(1.0 - nx * nx);
    float w = vLocal.x / ${g(SCREW_PITCH)} - vBox.w + 0.35 * nx;
    float crest = 1.0 - smoothstep(0.18, 0.32, abs(fract(w) - 0.5));
    vec3 thread = vec3(0.86, 0.66, 0.42) * (0.9 + 0.1 * rings);
    col = mix(col * 0.75, thread, crest);
    col *= 0.4 + 0.7 * cyl;
    col += uLight * 0.18 * exp(-pow((nx - 0.4) / 0.2, 2.0)) * (0.5 + 0.5 * crest);
  }
  col *= uLight * (0.86 + 0.14 * vWorld.y);
  outColor = vec4(col * cov, cov);
}
`;

const MARBLE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre, spin angle, style (0 swirl, 1 cat's eye). */
layout(location = 1) in vec4 aPos;
/** Body tint, core variation. */
layout(location = 2) in vec4 aBody;
/** Core colour, opacity (fading in or out). */
layout(location = 3) in vec4 aCore;
uniform vec2 uToClip;
uniform float uPx;
/** Shadow offset xy, size scale, 1 for the shadow pass. */
uniform vec4 uShadow;
out vec2 vP;
flat out vec4 vPos;
flat out vec4 vBody;
flat out vec4 vCore;
void main() {
  float rad = ${g(MARBLE_R)} * mix(1.0, uShadow.z, uShadow.w) + 1.5 * uPx;
  vec2 c = aPos.xy + uShadow.xy * uShadow.w;
  vP = aCorner * rad / ${g(MARBLE_R)};
  vPos = aPos;
  vBody = aBody;
  vCore = aCore;
  gl_Position = vec4((c + aCorner * rad) * uToClip - 1.0, 0.0, 1.0);
}
`;

/**
 * A glass marble, premultiplied, as an analytic sphere: the panel behind seen
 * upside down through the glass and tinted, darker towards the thick rim; a
 * swirl ribbon or cat's-eye vanes turned by the spin; a caustic glow on the
 * side away from the light, a sharp highlight and a rim sheen. The shadow
 * pass draws a soft shadow with a spot of coloured light focused in it.
 */
const MARBLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vPos;
flat in vec4 vBody;
flat in vec4 vCore;
uniform float uPx;
uniform vec4 uShadow;
uniform float uShadowAlpha;
uniform vec3 uLight;
out vec4 outColor;
void main() {
  vec2 p = vP;
  float r2 = dot(p, p);
  vec3 tint = vBody.rgb;
  if (uShadow.w > 0.5) {
    float r = sqrt(r2);
    float s = uShadowAlpha * (1.0 - smoothstep(0.45, 1.25, r));
    vec2 c = p - vec2(-0.12, 0.18);
    vec3 caustic = tint * uLight * 0.3 * exp(-9.0 * dot(c, c));
    outColor = vec4(caustic, s) * vCore.a;
    return;
  }
  float r = sqrt(r2);
  float cov = clamp((1.0 - r) * ${g(MARBLE_R)} / uPx + 0.5, 0.0, 1.0);
  float nz = sqrt(max(1.0 - r2, 0.0));
  vec3 n = vec3(p, nz);
  float fres = pow(1.0 - nz, 2.0);

  // The panel behind, flipped by the lens: lit wood at the bottom, shade at the top.
  vec3 bg = vec3(${g(PANEL[0])}, ${g(PANEL[1])}, ${g(PANEL[2])}) * uLight
    * (0.45 + 0.65 * smoothstep(0.7, -0.9, p.y));
  vec3 col = bg * mix(tint, tint * tint * 0.7, fres);

  // The core, magnified a little, turning with the spin. Sampling through the
  // inverse rotation turns the pattern by +spin (counter-clockwise, y up), so a
  // marble rolling right (negative spin) turns clockwise and rolls forwards.
  float cs = cos(vPos.z);
  float sn = sin(vPos.z);
  vec2 q = mat2(cs, -sn, sn, cs) * p / 0.85;
  float ql = length(q);
  float depth = 1.0 - smoothstep(0.62, 0.95, ql);
  float band;
  if (vPos.w > 0.5) {
    // Cat's eye: three curved vanes from the centre.
    float a = atan(q.y, q.x) + 0.25 * ql;
    band = 1.0 - smoothstep(0.07, 0.15, abs(sin(1.5 * a)) * ql);
  } else {
    // A twisted ribbon and a thinner thread beside it.
    float ph = vBody.w * 6.2832;
    float b1 = abs(q.y - 0.3 * sin(2.4 * q.x + ph));
    float b2 = abs(q.y + 0.42 - 0.18 * sin(3.1 * q.x + ph * 1.7));
    band = max(1.0 - smoothstep(0.08, 0.15, b1), 0.7 * (1.0 - smoothstep(0.03, 0.07, b2)));
  }
  vec3 core = vCore.rgb * uLight * (0.45 + 0.55 * nz) * (0.85 + 0.3 * smoothstep(0.2, -0.6, q.y));
  col = mix(col, core, band * depth);

  // Light focused through the glass onto its lower right.
  vec2 c = p - vec2(0.38, -0.42);
  col += tint * uLight * 0.45 * exp(-7.0 * dot(c, c));
  // Highlight, a softer bloom round it, and the rim's reflection.
  vec3 L = normalize(vec3(-0.5, 0.72, 0.6));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float nh = max(dot(n, H), 0.0);
  col += uLight * (1.3 * pow(nh, 120.0) + 0.12 * pow(nh, 10.0));
  col += uLight * 0.16 * fres * smoothstep(-0.6, 0.6, p.y);
  outColor = vec4(col * cov, cov) * vCore.a;
}
`;

/** Floats per board: aSeg, aBox. */
const BOARD_ATTRIBUTES = [4, 4] as const;
/** Floats per marble: aPos, aBody, aCore. */
const MARBLE_ATTRIBUTES = [4, 4, 4] as const;

/** Writes `boards` into the batch from instance `first`; returns the next free instance. */
function writeBoards(data: Float32Array, stride: number, first: number, boards: Board[]): number {
  let k = first;
  for (const b of boards) {
    if (k >= MAX_BOARDS) {
      break;
    }
    const o = k * stride;
    data[o] = b.ax;
    data[o + 1] = b.ay;
    data[o + 2] = b.bx;
    data[o + 3] = b.by;
    data[o + 4] = b.half;
    data[o + 5] = b.kind;
    data[o + 6] = b.tint;
    data[o + 7] = 0;
    k++;
  }
  return k;
}

/**
 * A wooden marble run down one side of the frame: glass marbles roll along
 * sloping rails, drop to the next one with a small bounce, and ride a turning
 * screw lift back to the top.
 *
 * Passes: the room backdrop at low resolution, re-rendered only when it
 * changes and upscaled every frame; the panel's shadow and the panel; the
 * frame, lift, posts and rails' shadows and the pieces; then the marbles'
 * shadows and the marbles, as instanced octagons.
 */
export const marblerun = defineEffect(marblerunMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const program = (vs: string, fs: string) => scopedProgram(gl, scope, vs, fs);
      const bgu = createUniforms(gl, program(FULLSCREEN_VERTEX, BACKDROP_FRAGMENT), [
        "uPxToH",
        "uAspect",
        "uRight",
      ]);
      const bu = createUniforms(gl, program(BOARD_VERTEX, BOARD_FRAGMENT), [
        "uToClip",
        "uPx",
        "uShadow",
        "uShadowAlpha",
        "uLight",
        "uLDir",
      ]);
      const mu = createUniforms(gl, program(MARBLE_VERTEX, MARBLE_FRAGMENT), [
        "uToClip",
        "uPx",
        "uShadow",
        "uShadowAlpha",
        "uLight",
      ]);
      const boardBatch = scope.own(createSpriteBatch(gl, MAX_BOARDS, BOARD_ATTRIBUTES, [QUAD]));
      const marbleBatch = scope.own(
        createSpriteBatch(gl, MAX_MARBLES, MARBLE_ATTRIBUTES, [polygonStrip(8)]),
      );

      const marbles = createMarbles(MAX_MARBLES);
      const point = new Float64Array(2);
      let run: Run | null = null;
      let runKey = "";
      let placed = -1;
      let backCount = 0;
      let boardCount = 0;
      let liftBoard = -1;
      /** Lift travel (frame heights), unwrapped in float64. */
      let liftTravel = 0;

      let width = 1;
      let height = 1;
      const backdropKey = createChangeKey(1);

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          const scale = v.scale > 0 ? v.scale : height / 1080;
          target.resize(width, height, Math.max(1, BACKDROP_TEXEL_REF * scale));
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const aspect = width / height;
          const side: MarbleSide = p.side === "left" ? "left" : "right";
          const key = `${String(p.levels)}|${side}|${String(aspect)}`;
          if (key !== runKey || !run) {
            run = buildRun(p.levels, side, aspect);
            runKey = key;
            placed = -1;
            backCount = writeBoards(boardBatch.data, boardBatch.stride, 0, run.back);
            boardCount = writeBoards(boardBatch.data, boardBatch.stride, backCount, run.front);
            liftBoard = backCount + run.liftIndex < MAX_BOARDS ? backCount + run.liftIndex : -1;
          }
          if (placed !== p.marbles) {
            // A new run spreads the marbles afresh; a new count only adds or removes some.
            if (placed < 0) {
              placeMarbles(run, marbles, p.marbles);
            } else {
              setMarbleCount(run, marbles, p.marbles);
            }
            placed = p.marbles;
          }
          fadeMarbles(marbles, Math.min(Math.max(dt, 0), 0.1));
          const time = Math.min(Math.max(dt, 0), 0.1) * Math.max(0, p.speed);
          stepMarbles(run, marbles, time);
          liftTravel += time * LIFT_SPEED;

          // 1. The room, re-rendered only when it changes, upscaled every frame.
          backdropKey.setText(0, side);
          if (target.needsRedraw(backdropKey)) {
            target.bind();
            gl.useProgram(bgu.program);
            bgu.f2(
              "uPxToH",
              target.fullWidth / target.width / height,
              target.fullHeight / target.height / height,
            );
            bgu.f1("uAspect", aspect);
            bgu.f1("uRight", side === "right" ? 1 : 0);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }
          target.blit();
          gl.viewport(0, 0, width, height);

          // 2. The wooden pieces, each layer's shadows first.
          if (liftBoard >= 0) {
            boardBatch.data[liftBoard * boardBatch.stride + 7] = wrap(
              liftTravel / SCREW_PITCH,
              0,
              1,
            );
          }
          boardBatch.upload(boardCount);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.useProgram(bu.program);
          bu.f2("uToClip", 2 / aspect, 2);
          bu.f1("uPx", 1 / height);
          bu.f1("uShadowAlpha", SHADOW_ALPHA);
          bu.v3("uLight", LIGHT);
          bu.f2("uLDir", LIGHT_DIR[0], LIGHT_DIR[1]);
          bu.f4("uShadow", BACK_SHADOW[0], BACK_SHADOW[1], BACK_SHADOW[2], 1);
          boardBatch.draw(0, backCount);
          bu.f4("uShadow", 0, 0, 0, 0);
          boardBatch.draw(0, backCount);
          bu.f4("uShadow", FRONT_SHADOW[0], FRONT_SHADOW[1], FRONT_SHADOW[2], 1);
          boardBatch.draw(backCount, boardCount - backCount);
          bu.f4("uShadow", 0, 0, 0, 0);
          boardBatch.draw(backCount, boardCount - backCount);

          // 3. The marbles.
          const n = marbles.count;
          if (n > 0) {
            const d = marbleBatch.data;
            const stride = marbleBatch.stride;
            const glass: MarbleGlass =
              p.glass === "clear" || p.glass === "cats" ? p.glass : "mixed";
            for (let i = 0; i < n; i++) {
              pointAt(run, marbles.s[i], point);
              const o = i * stride;
              const hue = PALETTE[i % PALETTE.length];
              const body = glass === "mixed" ? hue : CLEAR_GLASS;
              const core =
                glass === "mixed" ? (i % 3 === 0 ? PALETTE[(i + 3) % PALETTE.length] : MILKY) : hue;
              d[o] = point[0];
              d[o + 1] = point[1];
              d[o + 2] = marbles.spin[i];
              d[o + 3] = glass === "cats" ? 1 : 0;
              d[o + 4] = glass === "mixed" ? 0.35 + 0.65 * body[0] : body[0];
              d[o + 5] = glass === "mixed" ? 0.35 + 0.65 * body[1] : body[1];
              d[o + 6] = glass === "mixed" ? 0.35 + 0.65 * body[2] : body[2];
              d[o + 7] = (i * 0.618034) % 1;
              d[o + 8] = core[0];
              d[o + 9] = core[1];
              d[o + 10] = core[2];
              const l = marbles.life[i];
              d[o + 11] = l * l * (3 - 2 * l);
            }
            marbleBatch.upload(n);
            gl.useProgram(mu.program);
            mu.f2("uToClip", 2 / aspect, 2);
            mu.f1("uPx", 1 / height);
            mu.f1("uShadowAlpha", SHADOW_ALPHA);
            mu.v3("uLight", LIGHT);
            mu.f4("uShadow", MARBLE_SHADOW[0], MARBLE_SHADOW[1], MARBLE_SHADOW[2], 1);
            marbleBatch.draw(0, n);
            mu.f4("uShadow", 0, 0, 1, 0);
            marbleBatch.draw(0, n);
          }
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
