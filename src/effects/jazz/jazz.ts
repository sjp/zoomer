import { createColorEase, hexToUnitRgb } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  scopedProgram,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { buildPeriodicNoiseTexture, VALUE_NOISE_GLSL } from "../noise";
import { createSpriteBatch, QUAD } from "../sprites";
import { defineEffect } from "../types";
import {
  BRISTLES,
  C_BG,
  createJazz,
  createPose,
  type Element,
  forEachVisible,
  K_DOT,
  K_SPLAT,
  MISREGISTER,
  PALETTES,
  type Pose,
  REF_HEIGHT,
  resizeJazz,
  ROLE_COUNT,
  splatDroplet,
  stepJazz,
} from "./jazz-sim";
import { jazzMeta } from "./jazz.meta";

/** Seconds a palette change crossfades. */
const PALETTE_EASE = 1;
/** Most instances drawn in one frame (two layouts crossfading at the smallest scale). */
export const MAX_INSTANCES = 4096;
/** Floats per instance: place, size, params, colour, seed. */
export const INSTANCE_FLOATS = 17;
/** The paper texture: side in texels, and ref px per texel. */
const GRAIN_SIZE = 256;
const GRAIN_TEXEL = 1.2;

const SHAPE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre (ref px, y down), angle, pop scale. */
layout(location = 1) in vec4 aPlace;
/** Quad half extents (ref px), kind, stroke reveal (below 1 painting on, above 1 un-painting). */
layout(location = 2) in vec4 aSize;
layout(location = 3) in vec4 aParam;
/** Straight RGB and opacity. */
layout(location = 4) in vec4 aColor;
layout(location = 5) in float aSeed;
uniform vec2 uResolution;
/** Device px per ref px. */
uniform float uScale;
out vec2 vLocal;
flat out vec4 vSize;
flat out vec4 vParam;
flat out vec4 vColor;
flat out float vSeed;
/** Local units per device px, for the anti-aliased edge. */
flat out float vPx;
${TO_CLIP_GLSL}
void main() {
  float pop = max(aPlace.w, 1e-3);
  float px = 1.0 / (uScale * pop);
  vec2 local = aCorner * (aSize.xy + 1.5 * px);
  vec2 r = vec2(cos(aPlace.z), sin(aPlace.z));
  vec2 w = local * pop;
  vec2 pos = aPlace.xy + vec2(w.x * r.x - w.y * r.y, w.x * r.y + w.y * r.x);
  vLocal = local;
  vSize = aSize;
  vParam = aParam;
  vColor = aColor;
  vSeed = aSeed;
  vPx = px;
  gl_Position = pxToClip(pos * uScale, uResolution);
}
`;

const SHAPE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in vec4 vSize;
flat in vec4 vParam;
flat in vec4 vColor;
flat in float vSeed;
flat in float vPx;
out vec4 outColor;
${VALUE_NOISE_GLSL}

const float BRISTLES = ${glslFloat(BRISTLES)};

float cover(float d) {
  return clamp(0.5 - d / vPx, 0.0, 1.0);
}

/**
 * Whether the stroke shows at local x: below 1, painted on from the start up to
 * that share of its length; 1, all of it; above 1, un-painted from the start.
 */
float revealed(float x, float halfL) {
  float reveal = vSize.w;
  float along = x + halfL;
  if (reveal < 1.0) {
    return cover(along - reveal * 2.0 * halfL);
  }
  return reveal > 1.0 ? cover((reveal - 1.0) * 2.0 * halfL - along) : 1.0;
}

/** A dry-brush swash: coverage, and a per-bristle tone in .y. */
vec2 swash(vec2 p) {
  float halfL = vSize.x;
  float bend = vParam.x;
  float hw = vParam.y;
  float seed = vParam.z;
  float dryness = vParam.w;
  float s = p.x / halfL;
  float u = s * 0.5 + 0.5;
  float cs = clamp(s, -1.0, 1.0);
  float slope = -2.0 * bend * cs / halfL;
  float dy = (p.y - bend * (1.0 - cs * cs)) * inversesqrt(1.0 + slope * slope);
  // A tapered start, then ragged edges along the body.
  float w = hw * mix(0.45, 1.0, smoothstep(0.0, 0.22, u));
  float side = dy > 0.0 ? 19.0 : 0.0;
  w *= 1.0 + 0.07 * (vnoise(vec2(p.x / (0.35 * hw), side), seed) * 2.0 - 1.0);
  float before = -(p.x + halfL);
  float edge = before > 0.0 ? length(vec2(before, dy)) - w : abs(dy) - w;
  float c = cover(edge);
  // Bristles across the stroke, each running dry and ending at its own point.
  float b = clamp(dy / w, -1.0, 1.0) * 0.5 + 0.5;
  float bi = min(floor(b * BRISTLES), BRISTLES - 1.0);
  float bh = hash2(vec2(bi, 3.0), seed);
  float end = 1.0 - 0.1 * bh - 0.04 * hash2(vec2(bi, 9.0), seed);
  c *= cover((u - end) * 2.0 * halfL);
  float dry = dryness * smoothstep(0.35, 1.0, u) * (0.55 + 0.45 * bh);
  float n = vnoise(vec2(p.x / (0.9 * hw), bi * 1.7), seed + 7.0);
  float thr = dry * 1.1 - 0.1;
  c *= smoothstep(thr - 0.05, thr + 0.05, n);
  // Thin streaks of paper between bristles where the brush thins out.
  float f = fract(b * BRISTLES);
  float streak = smoothstep(0.0, 0.18, f) * smoothstep(1.0, 0.82, f);
  c *= mix(1.0, streak, smoothstep(0.15, 0.5, dry));
  return vec2(c * revealed(p.x, halfL), 0.9 + 0.1 * bh);
}

/** A hand-drawn wave (kind 1) or zig-zag (kind 2) line. */
float line(vec2 p, int kind) {
  float bend = vParam.x;
  float amp = vParam.y;
  float wave = vParam.z;
  float th = vParam.w;
  float halfL = max(vSize.x - th, 1e-3);
  float s = clamp(p.x / halfL, -1.0, 1.0);
  float ph = vSeed * 6.2831853;
  float a = amp * (1.0 + 0.15 * sin(p.x / wave * 1.3 + 3.0 * ph));
  float c;
  float dc;
  if (kind == 1) {
    float k = 6.2831853 / wave;
    c = a * sin(k * p.x + ph);
    dc = a * k * cos(k * p.x + ph);
  } else {
    float t = fract(p.x / wave + vSeed);
    c = a * (abs(t - 0.5) * 4.0 - 1.0);
    dc = a * 4.0 / wave * sign(t - 0.5);
  }
  c += bend * (1.0 - s * s);
  dc += -2.0 * bend * s / halfL;
  float dy = (p.y - c) * inversesqrt(1.0 + dc * dc);
  float ex = max(abs(p.x) - halfL, 0.0);
  float d = length(vec2(ex, dy)) - th * (1.0 + 0.12 * sin(p.x / wave * 0.7 + ph));
  return cover(d) * revealed(p.x, halfL);
}

/** Equilateral triangle with half side r (Inigo Quilez). */
float triangle(vec2 p, float r) {
  const float k = 1.7320508;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) {
    p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  }
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

float box(vec2 p, float s) {
  vec2 q = abs(p) - vec2(s);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

void main() {
  vec2 p = vLocal;
  int kind = int(vSize.z + 0.5);
  float c;
  float tone = 1.0;
  if (kind == 0) {
    vec2 sw = swash(p);
    c = sw.x;
    tone = sw.y;
  } else if (kind <= 2) {
    c = line(p, kind);
  } else if (kind == 3) {
    c = cover(length(p) - vParam.x);
  } else if (kind == 4) {
    c = cover(triangle(p, vParam.x * 0.8660254));
  } else if (kind == 5) {
    c = cover(length(vec2(max(abs(p.x) - vParam.x, 0.0), p.y)) - vParam.y);
  } else if (kind == 6) {
    float r = vParam.x;
    c = cover(max(length(p - vec2(0.0, 0.5 * r)) - r, p.y - 0.5 * r));
  } else if (kind == 7) {
    float g = vParam.x;
    vec2 n = vParam.zw;
    vec2 q = p + 0.5 * (n - 1.0) * g;
    vec2 id = clamp(floor(q / g + 0.5), vec2(0.0), n - 1.0);
    c = cover(length(q - id * g) - vParam.y);
  } else if (kind == 8) {
    c = cover(abs(box(p, vParam.x)) - 0.5 * vParam.y);
  } else {
    c = cover(abs(triangle(p, vParam.x * 0.8660254)) - 0.5 * vParam.y);
  }
  float a = vColor.a * c;
  outColor = vec4(vColor.rgb * tone * a, a);
}
`;

/** The paper: a flat colour with faint blotches and fibres from a baked tile. */
const PAPER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform vec3 uPaper;
uniform sampler2D uGrain;
/** Device px per grain tile. */
uniform float uTile;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 uv = gl_FragCoord.xy / uTile;
  vec2 g = texture(uGrain, uv).rg;
  float fibre = texture(uGrain, uv * vec2(0.37, 1.9) + 0.31).g;
  float grain = (g.r - 0.5) * 0.03 + (g.g - 0.5) * 0.025 + (fibre - 0.5) * 0.02;
  vec3 c = uPaper * (1.0 + grain) + vec3(grain * 0.18);
  outColor = vec4(c + dither8(gl_FragCoord.xy), 1.0);
}
`;

/** Writes one instance at `i`; returns the next index. */
function put(
  data: Float32Array,
  i: number,
  x: number,
  y: number,
  angle: number,
  pop: number,
  el: Element,
  kind: number,
  hx: number,
  hy: number,
  reveal: number,
  palette: Float32Array,
  alpha: number,
): number {
  const o = i * INSTANCE_FLOATS;
  const role = el.role;
  const shift = MISREGISTER[role];
  data[o] = x + shift[0];
  data[o + 1] = y + shift[1];
  data[o + 2] = angle;
  data[o + 3] = pop;
  data[o + 4] = hx;
  data[o + 5] = hy;
  data[o + 6] = kind;
  data[o + 7] = reveal;
  data[o + 8] = el.p0;
  data[o + 9] = el.p1;
  data[o + 10] = el.p2;
  data[o + 11] = el.p3;
  data[o + 12] = palette[3 * role];
  data[o + 13] = palette[3 * role + 1];
  data[o + 14] = palette[3 * role + 2];
  data[o + 15] = alpha;
  data[o + 16] = el.rnd;
  return i + 1;
}

/**
 * 90s Jazz: the paper-cup print as a flat full-frame pattern. Every swash,
 * squiggle, shape, splatter drop and bit of confetti is one signed-distance
 * sprite in a single instanced batch, over a baked paper grain; the swashes'
 * bristles and dry gaps are noise in the fragment shader.
 */
export const jazz = defineEffect(jazzMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scopedProgram(gl, scope, SHAPE_VERTEX, SHAPE_FRAGMENT);
      const u = createUniforms(gl, program, ["uResolution", "uScale"]);
      const batch = scope.own(createSpriteBatch(gl, MAX_INSTANCES, [4, 4, 4, 4, 1], [QUAD]));
      if (batch.stride !== INSTANCE_FLOATS) {
        throw new Error("90s Jazz: instance stride mismatch");
      }
      const paperProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, PAPER_FRAGMENT);
      const pu = createUniforms(gl, paperProgram, ["uPaper", "uGrain", "uTile"]);
      const triangle = scope.own(createFullscreenTriangle(gl));
      const grain = scope.add(
        createDataTexture(gl, {
          width: GRAIN_SIZE,
          height: GRAIN_SIZE,
          internalFormat: gl.RG8,
          format: gl.RG,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(GRAIN_SIZE, [
            { period: 16, seed: 9071 },
            { period: 128, seed: 4413 },
          ]),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      const targets: Record<string, Float32Array> = {};
      for (const [key, colors] of Object.entries(PALETTES)) {
        const t = new Float32Array(ROLE_COUNT * 3);
        colors.forEach((hex, i) => {
          t.set(hexToUnitRgb(hex), 3 * i);
        });
        targets[key] = t;
      }
      const ease = createColorEase(ROLE_COUNT * 3);
      const state = createJazz();
      const pose = createPose();
      const drop = { x: 0, y: 0, r: 0 };
      const data = batch.data;
      let palette = ease.value;
      let count = 0;

      const visit = (el: Element, p: Pose) => {
        if (el.kind === K_SPLAT) {
          const c = Math.cos(p.angle);
          const s = Math.sin(p.angle);
          const n = el.p1;
          for (let i = 0; i < n && count < MAX_INSTANCES; i++) {
            splatDroplet(el, i, drop);
            const dx = drop.x * p.pop;
            const dy = drop.y * p.pop;
            const o = count * INSTANCE_FLOATS;
            count = put(
              data,
              count,
              p.x + dx * c - dy * s,
              p.y + dx * s + dy * c,
              0,
              p.pop,
              el,
              K_DOT,
              drop.r,
              drop.r,
              1,
              palette,
              p.alpha,
            );
            // A dot's radius is its first parameter.
            data[o + 8] = drop.r;
          }
          return;
        }
        if (count < MAX_INSTANCES) {
          count = put(
            data,
            count,
            p.x,
            p.y,
            p.angle,
            p.pop,
            el,
            el.kind,
            el.hx,
            el.hy,
            p.reveal,
            palette,
            p.alpha,
          );
        }
      };

      let width = 1;
      let height = 1;
      let scale = 1;

      return {
        resize(v) {
          width = Math.max(1, Math.round(v.width));
          height = Math.max(1, Math.round(v.height));
          scale = v.scale > 0 ? v.scale : height / REF_HEIGHT;
          resizeJazz(state, width / scale, height / scale);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
          stepJazz(state, step, p);
          palette = ease.step(targets[p.palette] ?? targets.classic, step, PALETTE_EASE);

          gl.useProgram(paperProgram);
          pu.f3("uPaper", palette[3 * C_BG], palette[3 * C_BG + 1], palette[3 * C_BG + 2]);
          pu.i1("uGrain", 0);
          pu.f1("uTile", GRAIN_SIZE * GRAIN_TEXEL * scale);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, grain);
          triangle.draw();
          gl.bindTexture(gl.TEXTURE_2D, null);

          count = 0;
          forEachVisible(state, pose, visit);
          if (count > 0) {
            batch.upload(count);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(program);
            u.f2("uResolution", width, height);
            u.f1("uScale", scale);
            batch.draw(0, count);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
