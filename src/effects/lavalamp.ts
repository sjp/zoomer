import { hexToUnitRgb } from "./color";
import {
  beginFrame,
  createFullscreenTriangle,
  createProgram,
  FULLSCREEN_VERTEX,
  getUniforms,
  resetUnpackState,
} from "./gl";
import { createRng } from "./noise";
import { defineEffect } from "./types";

const MAX_BLOBS = 20;
const TAU = Math.PI * 2;
/** Base blob radius as a fraction of the frame height, for a size of 1. */
const BASE_RADIUS = 0.085;
/**
 * The field is evaluated in "lamp units": the frame is REF_H units tall, matching the
 * old CPU renderer's default (medium) buffer, so EPS and the look carry over unchanged.
 */
const REF_H = 360;
/** Widest aspect ratio the lamp stretches to; wider frames stretch it horizontally. */
const MAX_ASPECT = 4;
/** Field value of the blob surface. */
const THRESHOLD = 1;
/** Softens the 1/d² singularity at blob centres, in lamp units squared. */
const EPS = 0.5;

/** Bound on the pool ripple: |sin a + 0.6 sin b| <= 1.6. */
const POOL_WOB = 1.6;
/**
 * Side of the square pixel tiles the field is bounded over, as a power of two.
 * 16 px tiles are whole GPU warps/wavefronts (8x4 or 8x8), so the per-tile
 * shortcut in the main pass never diverges within one.
 */
const TILE_SHIFT = 4;
const TILE = 1 << TILE_SHIFT;
/** Mask texel values (R8): the tile is all background, or all saturated wax core. */
const MASK_BG = 1;
const MASK_CORE = 0.5;

/** GLSL float literal, so shader constants come from the TS ones above. */
const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

/** Uniforms shared by both passes: the field in lamp units. */
const FIELD_UNIFORMS = /* glsl */ `
uniform vec2 uResolution;
/** Lamp units per device pixel, x and y. */
uniform vec2 uScale;
/**
 * Per blob, (q, c) such that d = p * q + c is the offset from the blob centre
 * pre-scaled by (sqrt(stretch), 1 / sqrt(stretch)), so the field term is r^2 / (d.d + EPS).
 */
uniform vec4 uBlobs[${MAX_BLOBS}];
/** Per blob radius squared, in lamp units squared. */
uniform float uBlobR2[${MAX_BLOBS}];
uniform int uCount;
uniform float uPoolR2;

const int MAX_BLOBS = ${MAX_BLOBS};
const float REF_H = ${f(REF_H)};
const float THRESHOLD = ${f(THRESHOLD)};
const float EPS = ${f(EPS)};
`;

/**
 * Tile classifier, drawn at one fragment per TILE x TILE pixel tile. Each field term
 * falls off monotonically in |d.x| and |d.y|, so evaluating it at the nearest and
 * farthest offsets over the tile's rectangle bounds it exactly; summed, they bound
 * the field. A tile whose upper bound is below every threshold renders as pure
 * background, and one whose lower bound is above them all as pure core colour, so
 * the main pass can skip the field there with no change to the output.
 */
const MASK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
${FIELD_UNIFORMS}
/** Field upper bound below which a pixel is pure background. */
uniform float uBgLimit;
/** Field lower bound above which a pixel is pure saturated core. */
uniform float uCoreLimit;

out vec4 outColor;

const float TILE = ${f(TILE)};
const float POOL_Y_MIN = REF_H * (1.025 - 0.009 * ${f(POOL_WOB)});
const float POOL_Y_MAX = REF_H * (1.025 + 0.009 * ${f(POOL_WOB)});

void main() {
  // The tile's pixel rectangle (slightly generous: whole pixel edges), in lamp units.
  vec2 lo = floor(gl_FragCoord.xy) * TILE;
  vec2 hi = lo + TILE;
  vec2 pMin = vec2(lo.x, uResolution.y - hi.y) * uScale;
  vec2 pMax = vec2(hi.x, uResolution.y - lo.y) * uScale;

  float fieldMax = 0.0;
  float fieldMin = 0.0;
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uCount) break;
    vec4 b = uBlobs[i];
    // q > 0, so the offsets over the rectangle span [a, c] per axis.
    vec2 a = pMin * b.xy + b.zw;
    vec2 c = pMax * b.xy + b.zw;
    vec2 dNear = max(vec2(0.0), max(a, -c));
    vec2 dFar = max(-a, c);
    fieldMax += uBlobR2[i] / (dot(dNear, dNear) + EPS);
    fieldMin += uBlobR2[i] / (dot(dFar, dFar) + EPS);
  }
  float pdNear = max(0.0, POOL_Y_MIN - pMax.y);
  float pdFar = max(0.0, POOL_Y_MAX - pMin.y);
  fieldMax += uPoolR2 / (pdNear * pdNear + EPS);
  fieldMin += uPoolR2 / (pdFar * pdFar + EPS);

  float m = fieldMax < uBgLimit ? ${f(MASK_BG)} : (fieldMin > uCoreLimit ? ${f(MASK_CORE)} : 0.0);
  outColor = vec4(m, 0.0, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
${FIELD_UNIFORMS}
/** Per-tile classification from MASK_FRAGMENT. */
uniform sampler2D uMask;
/** 1 / lamp width in lamp units (height is REF_H). */
uniform float uInvLampW;
/** Pool ripple phases, wrapped to [0, TAU) on the CPU. */
uniform vec2 uPoolPhase;
uniform vec3 uWaxTop;
uniform vec3 uWaxBottom;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform float uGlow;
uniform float uSoftness;

out vec4 outColor;

const int TILE_SHIFT = ${TILE_SHIFT};

void main() {
  // Lamp coordinates, y down like the 2D canvas.
  vec2 p = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y) * uScale;
  float t = clamp((p.y - 0.5) / (REF_H - 1.0), 0.0, 1.0);
  vec3 bg = mix(uBgTop, uBgBottom, t);

  // Whole tiles of background or saturated core don't need the field (see MASK_FRAGMENT).
  float tile = texelFetch(uMask, ivec2(gl_FragCoord.xy) >> TILE_SHIFT, 0).r;
  if (tile > ${f((1 + MASK_CORE) / 2)}) {
    outColor = vec4(clamp(bg, 0.0, 1.0), 1.0);
    return;
  }
  vec3 wax = mix(uWaxTop, uWaxBottom, t);
  if (tile > ${f(MASK_CORE / 2)}) {
    outColor = vec4(clamp(wax + (1.0 - wax) * (uGlow * 0.4), 0.0, 1.0), 1.0);
    return;
  }

  float field = 0.0;
  for (int i = 0; i < MAX_BLOBS; i++) {
    if (i >= uCount) break;
    // Moving wax stretches along its travel, keeping its area (the stretch is in q).
    vec4 b = uBlobs[i];
    vec2 d = p * b.xy + b.zw;
    field += uBlobR2[i] / (dot(d, d) + EPS);
  }

  // Wax pool resting along the bottom, with a slow ripple on its surface.
  float u = p.x * uInvLampW;
  float wob = sin(u * 5.1 + uPoolPhase.x) + 0.6 * sin(u * 9.7 + uPoolPhase.y);
  float poolY = REF_H * (1.025 + 0.009 * wob);
  float pd = max(0.0, poolY - p.y);
  field += uPoolR2 / (pd * pd + EPS);

  float alpha = smoothstep(THRESHOLD - uSoftness, THRESHOLD + uSoftness, field);
  // Inside: a slightly dimmer rim and a core that brightens towards white.
  float core = smoothstep(THRESHOLD, THRESHOLD + 2.6, field);
  float shade = 0.78 + 0.22 * smoothstep(THRESHOLD, THRESHOLD + 0.8, field);
  float lift = uGlow * 0.4 * core * core;
  // Outside: a soft halo of wax colour fading out to about 1.7 radii.
  float h = smoothstep(0.38, THRESHOLD, field);
  float halo = uGlow * 0.5 * h * h * (1.0 - alpha);

  vec3 shaded = wax * shade;
  vec3 lit = shaded + (1.0 - shaded) * lift;
  vec3 outside = bg + wax * halo;
  outColor = vec4(clamp(mix(outside, lit, alpha), 0.0, 1.0), 1.0);
}
`;

/** Wraps an angle into [0, TAU) so float32 uniforms stay precise over long runs. */
const wrapPhase = (a: number) => ((a % TAU) + TAU) % TAU;

/** Per-blob constants, drawn once per seed. Angular rates are in radians per lamp second. */
interface Blob {
  /** Resting horizontal position, 0..1 across the usable width. */
  baseX: number;
  /** Size multiplier. */
  size: number;
  /** Vertical heat cycle: rate, phase and amplitude (fraction of height). */
  rise: number;
  risePhase: number;
  riseAmp: number;
  /** Two-component horizontal wander. */
  w1: number;
  p1: number;
  w2: number;
  p2: number;
  /** Radius breathing. */
  wr: number;
  pr: number;
}

const makeBlobs = (seed: number): Blob[] => {
  const rng = createRng(seed * 7717 + 29);
  const start = rng();
  const blobs: Blob[] = [];
  for (let i = 0; i < MAX_BLOBS; i++) {
    // Golden-ratio spacing keeps any prefix of the list spread across the width.
    const g = (start + i * 0.618034) % 1;
    blobs.push({
      baseX: 0.15 + 0.7 * g,
      size: 0.7 + 0.6 * rng(),
      rise: TAU / (36 + 40 * rng()),
      risePhase: rng() * TAU,
      riseAmp: 0.32 + 0.22 * rng(),
      w1: TAU / (40 + 40 * rng()),
      p1: rng() * TAU,
      w2: TAU / (17 + 20 * rng()),
      p2: rng() * TAU,
      wr: TAU / (9 + 12 * rng()),
      pr: rng() * TAU,
    });
  }
  return blobs;
};

/** Vertical position (0 top, 1 bottom) of a blob at lamp time t. */
const blobY = (b: Blob, t: number) => {
  // Odd cubic of a sine: quicker through the middle, lingering at the hot
  // bottom and the cool top like wax waiting to heat or cool.
  const s = Math.sin(t * b.rise + b.risePhase);
  return 0.5 + b.riseAmp * s * (1.25 - 0.25 * s * s);
};

/**
 * A lava lamp, drawn by a WebGL2 fragment shader: a metaball field (sum of r²/d²)
 * of slowly rising and sinking wax blobs over a soft wax pool, thresholded with an
 * anti-aliased edge and shaded with a vertical colour gradient, a brighter core
 * and an outer glow. Blob motion runs on the CPU; the field is evaluated per pixel.
 */
export const lavalamp = defineEffect({
  id: "lavalamp",
  name: "Lava Lamp",
  description: "Soft glowing wax blobs that slowly rise, sink, merge and split.",
  params: {
    count: { kind: "number", label: "Blob count", min: 3, max: 20, step: 1, default: 8 },
    size: { kind: "number", label: "Blob size", min: 0.5, max: 2, step: 0.05, default: 1 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    colorBottom: { kind: "color", label: "Wax colour (bottom)", default: "#ff3d1f" },
    colorTop: { kind: "color", label: "Wax colour (top)", default: "#ffb13b" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    softness: {
      kind: "number",
      label: "Edge softness",
      min: 0.02,
      max: 0.5,
      step: 0.01,
      default: 0.12,
    },
    bgTop: { kind: "color", label: "Background (top)", default: "#0c0420" },
    bgBottom: { kind: "color", label: "Background (bottom)", default: "#3a0b3d" },
    seed: { kind: "number", label: "Blob layout seed", min: 1, max: 9999, step: 1, default: 1 },
  },
  context: "webgl2",
  create(gl) {
    const program = createProgram(gl, FULLSCREEN_VERTEX, FRAGMENT);
    let maskProgram: WebGLProgram;
    try {
      maskProgram = createProgram(gl, FULLSCREEN_VERTEX, MASK_FRAGMENT);
    } catch (err) {
      gl.deleteProgram(program);
      throw err;
    }
    const triangle = createFullscreenTriangle(gl);
    const fieldNames = ["uResolution", "uScale", "uBlobs", "uBlobR2", "uCount", "uPoolR2"] as const;
    const loc = getUniforms(gl, program, [
      ...fieldNames,
      "uMask",
      "uInvLampW",
      "uPoolPhase",
      "uWaxTop",
      "uWaxBottom",
      "uBgTop",
      "uBgBottom",
      "uGlow",
      "uSoftness",
    ]);
    const maskLoc = getUniforms(gl, maskProgram, [...fieldNames, "uBgLimit", "uCoreLimit"]);
    // Uniforms persist with their program even in a shared context, so the ones
    // that only change with resize or params are uploaded only when they change.
    gl.useProgram(program);
    gl.uniform1i(loc.uMask, 0);

    // One R8 texel per tile; storage is (re)allocated when the tile grid changes.
    const maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const maskFbo = gl.createFramebuffer();
    let maskW = 0;
    let maskH = 0;

    let width = 1;
    let height = 1;
    let sizeDirty = true;
    let seedKey = NaN;
    let blobs: Blob[] = [];
    /** Lamp seconds (scaled by speed), kept in float64; only derived values reach the GPU. */
    let time = 0;
    const blobData = new Float32Array(MAX_BLOBS * 4);
    const blobR2 = new Float32Array(MAX_BLOBS);
    let lastSize = NaN;
    let lastGlow = NaN;
    let lastSoftness = NaN;
    let lastWaxTop = "";
    let lastWaxBottom = "";
    let lastBgTop = "";
    let lastBgBottom = "";

    // Per-frame values read by uploadField.
    let sizeChanged = true;
    let sizeParamChanged = true;
    let scaleX = 1;
    let scaleY = 1;
    let poolR2 = 0;
    let count = 1;
    /** Uploads the field uniforms shared by both programs. */
    const uploadField = (l: Record<(typeof fieldNames)[number], WebGLUniformLocation | null>) => {
      if (sizeChanged) {
        gl.uniform2f(l.uResolution, width, height);
        gl.uniform2f(l.uScale, scaleX, scaleY);
      }
      if (sizeParamChanged) gl.uniform1f(l.uPoolR2, poolR2);
      gl.uniform4fv(l.uBlobs, blobData);
      gl.uniform1fv(l.uBlobR2, blobR2);
      gl.uniform1i(l.uCount, count);
    };

    return {
      resize(v) {
        width = v.width;
        height = v.height;
        sizeDirty = true;
      },
      frame(dt, p) {
        beginFrame(gl, width, height);
        time += dt * p.speed;
        if (p.seed !== seedKey) {
          seedKey = p.seed;
          blobs = makeBlobs(p.seed);
        }

        const lampW = Math.max(
          1,
          Math.min(REF_H * MAX_ASPECT, (REF_H * width) / Math.max(1, height)),
        );
        const n = Math.max(1, Math.min(MAX_BLOBS, Math.round(p.count)));
        const baseR = BASE_RADIUS * p.size * REF_H;
        for (let i = 0; i < n; i++) {
          const b = blobs[i];
          const r = baseR * b.size * (1 + 0.12 * Math.sin(time * b.wr + b.pr));
          // Stay inside the frame horizontally; vertical travel may poke past the edges.
          const wander = 0.09 * Math.sin(time * b.w1 + b.p1) + 0.04 * Math.sin(time * b.w2 + b.p2);
          const margin = Math.min(r, lampW / 2);
          const vel = Math.abs(blobY(b, time + 0.25) - blobY(b, time - 0.25)) * 2;
          const cx = margin + (b.baseX + wander) * (lampW - 2 * margin);
          const cy = blobY(b, time) * REF_H;
          // Moving wax stretches along its travel, keeping its area: the term is
          // r² / (dx² s + dy² / s + EPS), i.e. offsets pre-scaled by (√s, 1/√s).
          const qx = Math.sqrt(1 + Math.min(0.35, vel * 4));
          const qy = 1 / qx;
          const o = i * 4;
          blobData[o] = qx;
          blobData[o + 1] = qy;
          blobData[o + 2] = -cx * qx;
          blobData[o + 3] = -cy * qy;
          blobR2[i] = r * r;
        }

        // Tile classification pass, into the mask texture.
        const tw = (width + TILE - 1) >> TILE_SHIFT;
        const th = (height + TILE - 1) >> TILE_SHIFT;
        if (tw !== maskW || th !== maskH) {
          maskW = tw;
          maskH = th;
          gl.bindTexture(gl.TEXTURE_2D, maskTex);
          resetUnpackState(gl);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, tw, th, 0, gl.RED, gl.UNSIGNED_BYTE, null);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.bindFramebuffer(gl.FRAMEBUFFER, maskFbo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, maskTex, 0);
        }
        sizeChanged = sizeDirty;
        sizeDirty = false;
        scaleX = lampW / Math.max(1, width);
        scaleY = REF_H / Math.max(1, height);
        sizeParamChanged = p.size !== lastSize;
        lastSize = p.size;
        const poolR = 0.05 * Math.sqrt(p.size) * REF_H;
        poolR2 = poolR * poolR;
        count = n;
        const softChanged = p.softness !== lastSoftness;

        gl.bindFramebuffer(gl.FRAMEBUFFER, maskFbo);
        gl.viewport(0, 0, tw, th);
        gl.useProgram(maskProgram);
        uploadField(maskLoc);
        if (softChanged) {
          // A pixel is pure background once both the halo (from 0.38) and the edge
          // (from 1 - softness) are zero, and pure core once the edge, rim shade and
          // core lift have all saturated. 1% margins absorb float rounding in the bounds.
          gl.uniform1f(maskLoc.uBgLimit, 0.99 * Math.min(0.38, THRESHOLD - p.softness));
          gl.uniform1f(
            maskLoc.uCoreLimit,
            1.01 * Math.max(THRESHOLD + 2.6, THRESHOLD + p.softness),
          );
        }
        triangle.draw();

        // Main pass, into the default framebuffer.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        uploadField(loc);
        if (sizeChanged) gl.uniform1f(loc.uInvLampW, 1 / lampW);
        gl.uniform2f(loc.uPoolPhase, wrapPhase(time * 0.13), wrapPhase(1.7 - time * 0.21));
        if (softChanged) {
          lastSoftness = p.softness;
          gl.uniform1f(loc.uSoftness, p.softness);
        }
        if (p.glow !== lastGlow) {
          lastGlow = p.glow;
          gl.uniform1f(loc.uGlow, p.glow);
        }
        if (p.colorTop !== lastWaxTop) {
          lastWaxTop = p.colorTop;
          gl.uniform3fv(loc.uWaxTop, hexToUnitRgb(p.colorTop));
        }
        if (p.colorBottom !== lastWaxBottom) {
          lastWaxBottom = p.colorBottom;
          gl.uniform3fv(loc.uWaxBottom, hexToUnitRgb(p.colorBottom));
        }
        if (p.bgTop !== lastBgTop) {
          lastBgTop = p.bgTop;
          gl.uniform3fv(loc.uBgTop, hexToUnitRgb(p.bgTop));
        }
        if (p.bgBottom !== lastBgBottom) {
          lastBgBottom = p.bgBottom;
          gl.uniform3fv(loc.uBgBottom, hexToUnitRgb(p.bgBottom));
        }
        triangle.draw();
        // Unbind the mask so it is never sampled while it is the render target.
        gl.bindTexture(gl.TEXTURE_2D, null);
      },
      dispose() {
        gl.deleteProgram(program);
        gl.deleteProgram(maskProgram);
        gl.deleteFramebuffer(maskFbo);
        gl.deleteTexture(maskTex);
        triangle.dispose();
      },
    };
  },
});
