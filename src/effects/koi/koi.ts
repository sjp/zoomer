import { CAUSTIC_RATES } from "../caustics/caustics-sim";
import { unitRgbMemo } from "../color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import {
  buildPebbleTexture,
  createFish,
  createPads,
  createRipples,
  createStripScratch,
  fishLength,
  HALF_WIDTH,
  MAX_RIPPLES,
  padOutline,
  rescaleFish,
  rescalePads,
  sortByDepth,
  SPINE_FRACTION,
  spawnRipple,
  stepFish,
  stepPads,
  SWIM_PX,
  varietyOf,
  VERTEX_FLOATS,
  VERTS_PER_FISH,
  writeFishStrip,
  writeRipples,
  type FishFrame,
} from "./koi-sim";
import { fanStrip } from "../leaves/leaves-sim";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { createNoise, createRng, HASH32_GLSL } from "../noise";
import { createSpriteBatch, polygonStrip, SPRITE_SPIN_GLSL } from "../sprites";
import { koiMeta, MAX_FISH, MAX_PADS } from "./koi.meta";
import { defineEffect } from "../types";
import { createCausticTile } from "../caustic-tile";

/** Pebble texture: texels per side, pebbles per side, and its on-screen period in reference px. */
const PEBBLE_SIZE = 256;
const PEBBLE_CELLS = 12;
const PEBBLE_REF_PX = 520;
/** Caustic tile: warp iterations (the caustics effect uses 5), texels and on-screen period. */
const CAUSTIC_ITERATIONS = 3;
const CAUSTIC_RATES_3 = CAUSTIC_RATES.slice(0, CAUSTIC_ITERATIONS);
const CAUSTIC_TILE = 256;
const CAUSTIC_REF_PX = 640;
const CAUSTIC_ANGLE = 0.35;
/** Slow morph and drift of the caustics (wall clock, phase units and tile periods per second). */
const CAUSTIC_RATE = 0.12;
const CAUSTIC_DRIFT: readonly [number, number] = [0.004, 0.0025];
/** The tile is re-rendered at most this often; the slow morph hides 30 Hz updates. */
const CAUSTIC_INTERVAL = 1 / 30;
/** Ripple ring half-width and how far it shifts the floor, in reference px. */
const RIPPLE_WIDTH = 5;
const RIPPLE_WARP = 5;
/** Light comes from the top left: shadows fall down and to the right. */
const SHADOW_DIR: readonly [number, number] = [0.6, 0.8];
/** Fish shadow offset in reference px: near the floor, plus this much more just under the surface. */
const FISH_SHADOW_NEAR = 8;
const FISH_SHADOW_FAR = 34;
const PAD_SHADOW = 44;
/** Body length over half-width along the spine, so the eyes come out round. */
const ASPECT = SPINE_FRACTION / HALF_WIDTH;

/** Pebble floor, caustic light, depth gradient and ripple rings, at reduced resolution. */
const FLOOR_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uPebbles;
uniform sampler2D uCaustic;
/** Full canvas size in device px. */
uniform vec2 uSize;
uniform float uPebbleScale;
uniform mat2 uCausticMat;
uniform vec2 uCausticOff;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uLight;
/** Depth plane over vUv: depth = dot(vUv, xy) + z. */
uniform vec3 uDepthPlane;
/** Centre x, y, radius (device px, y down), signed amplitude; amplitude 0 = empty. */
uniform vec4 uRipples[${String(MAX_RIPPLES)}];
/** 1 / ring half-width, then the floor shift, both in device px. */
uniform vec2 uRipple;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float ring = 0.0;
  vec2 shift = vec2(0.0);
  for (int k = 0; k < ${String(MAX_RIPPLES)}; k++) {
    vec4 r = uRipples[k];
    if (r.w == 0.0) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-3;
    float x = (dist - r.z) * uRipple.x;
    // A soft bright-and-dark ring: x exp(-x^2) is odd about the crest.
    float w = r.w * x * exp(-x * x);
    ring += w;
    shift += d * (w / dist);
  }
  vec2 q = p + shift * uRipple.y;
  float pebble = texture(uPebbles, q * uPebbleScale).r;
  float c = texture(uCaustic, uCausticMat * q + uCausticOff).r;
  float depth = clamp(dot(vUv, uDepthPlane.xy) + uDepthPlane.z, 0.0, 1.0);
  vec3 col = mix(uShallow, uDeep, depth) * (0.5 + 0.9 * pebble);
  col += uLight * c * (1.0 - 0.7 * depth);
  col += vec3(0.85, 0.95, 0.9) * (ring * 0.16);
  outColor = vec4(max(col, 0.0), 1.0);
}
`;

const FISH_VERTEX = /* glsl */ `#version 300 es
/** Spine centre, then the offset to this edge, in device px. */
layout(location = 0) in vec4 aPos;
/** u along the body (0 nose, 1 tail root, up to 1.5 at the fin tip), v across (-1..1). */
layout(location = 1) in vec2 aUv;
uniform vec2 uResolution;
/** Shadow offset x, y (device px) and width scale. */
uniform vec3 uOffset;
out vec2 vUv;
${TO_CLIP_GLSL}
void main() {
  vUv = aUv;
  gl_Position = pxToClip(aPos.xy + aPos.zw * uOffset.z + uOffset.xy, uResolution);
}
`;

/** Koi body and tail fin: variety pattern from body-space uv and a per-fish seed. Premultiplied. */
const FISH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
/** Variety index, pattern seed, depth (0..1), opacity. */
uniform vec4 uFish;
uniform vec3 uWater;
out vec4 outColor;
${HASH32_GLSL}
float hash2(vec2 c) {
  uvec2 q = uvec2(ivec2(c) + 4096);
  return float(hash32(q.x * 1973u + hash32(q.y))) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  float u = vUv.x;
  float v = vUv.y;
  float av = abs(v);
  // Derivatives only in uniform control flow, so before any branch.
  float aa = max(fwidth(v), 1e-3);
  int variety = int(uFish.x + 0.5);
  float bu = min(u, 1.0);
  vec2 q = vec2(bu * 4.5, v * 1.4) + uFish.y * vec2(1.31, 0.77);
  float n1 = vnoise(q) * 0.7 + vnoise(q * 2.3 + 5.2) * 0.3;
  vec3 white = vec3(0.96, 0.94, 0.9);
  vec3 red = vec3(0.86, 0.22, 0.1);
  vec3 black = vec3(0.07, 0.07, 0.08);
  // Patches sit on the back and thin out down the flanks.
  float redMask = smoothstep(0.5, 0.56, n1 * (1.0 - 0.35 * av) + 0.06);
  vec3 col;
  if (variety == 0) {
    col = mix(white, red, redMask);
  } else if (variety == 1) {
    float n2 = vnoise(q * 2.2 + 19.0);
    col = mix(white, red, redMask);
    col = mix(col, black, smoothstep(0.72, 0.76, n2) * step(0.15, u));
  } else if (variety == 2) {
    float n2 = vnoise(q * 1.7 + 31.0);
    col = mix(black, red, redMask);
    col = mix(col, white, smoothstep(0.6, 0.66, n2 * (0.7 + 0.5 * av)));
  } else if (variety == 3) {
    // Metallic gold: a bright sheen down the spine and a faint scale glint.
    float sheen = 0.35 * exp(-v * v * 5.0) + 0.06 * sin(bu * 70.0 + v * 9.0);
    col = vec3(0.92, 0.68, 0.24) * (0.8 + sheen);
  } else {
    // Asagi: a blue-grey net of scales on the back, orange flanks and cheeks.
    vec2 sc = vec2(bu * ${glslFloat(ASPECT * 1.4)}, v * 3.0);
    sc.y += 0.5 * mod(floor(sc.x), 2.0);
    vec2 g = abs(fract(sc) - 0.5);
    float net = smoothstep(0.36, 0.5, max(g.x, g.y));
    col = mix(vec3(0.52, 0.62, 0.7), vec3(0.3, 0.38, 0.47), net * 0.7);
    float flank = max(smoothstep(0.55, 0.9, av), 0.7 * (1.0 - smoothstep(0.05, 0.14, u)));
    col = mix(col, vec3(0.88, 0.45, 0.2), flank);
  }
  float a;
  if (u > 1.0) {
    // Tail fin: translucent, faint rays, a forked end.
    vec3 fin = variety == 3 ? vec3(0.95, 0.75, 0.32) : (variety == 4 ? vec3(0.85, 0.55, 0.35) : white);
    col = mix(fin, col, 0.25) * (0.9 + 0.1 * sin(v * 26.0));
    float fork = smoothstep(0.0, 0.2, av + (1.5 - u) * 4.0 - 0.45);
    a = 0.6 * fork * (1.0 - smoothstep(1.43, 1.5, u)) * (1.0 - smoothstep(0.75, 1.0, av));
  } else {
    // Rounded body: darker towards the edges, an eye either side of the head.
    col *= 0.7 + 0.3 * sqrt(max(0.0, 1.0 - v * v));
    float eye = length(vec2((u - 0.075) * ${glslFloat(ASPECT)}, av - 0.55));
    col = mix(col, black, (1.0 - smoothstep(0.1, 0.17, eye)) * step(u, 0.2));
    a = clamp((1.0 - av) / aa, 0.0, 1.0);
  }
  // Deeper fish are more muted, seen through more water.
  col = mix(col, uWater, uFish.z * 0.55);
  a *= uFish.w * (1.0 - 0.25 * uFish.z);
  outColor = vec4(col * a, a);
}
`;

/** A soft dark silhouette for the shadow pass. Premultiplied. */
const FISH_SHADOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float av = abs(vUv.y);
  float fin = vUv.x > 1.0 ? 0.5 * (1.0 - smoothstep(1.3, 1.5, vUv.x)) : 1.0;
  float a = uAlpha * (1.0 - smoothstep(0.1, 1.0, av)) * fin;
  outColor = vec4(0.0, 0.0, 0.0, a);
}
`;

const padVertex = (spinLocation: number) => /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
/** Centre x, centre y, radius (device px, y down), opacity. */
layout(location = 1) in vec4 aPad;
/** Colour, then an unused float. */
layout(location = 2) in vec4 aTint;
layout(location = ${String(spinLocation)}) in vec2 aSpin;
uniform vec2 uResolution;
/** Shadow offset x, y (device px) and size scale. */
uniform vec3 uOffset;
out vec2 vLocal;
out float vEdge;
flat out vec4 vColor;
${TO_CLIP_GLSL}
${SPRITE_SPIN_GLSL}
void main() {
  vLocal = aCorner;
  // Fan strips put only the centre at the origin: 0 there, 1 on the rim.
  vEdge = dot(aCorner, aCorner) > 0.0 ? 1.0 : 0.0;
  vColor = vec4(aTint.rgb, aPad.w);
  gl_Position = pxToClip(aPad.xy + spinCorner(aCorner, aSpin) * aPad.z * uOffset.z + uOffset.xy, uResolution);
}
`;

/** A lily pad: flat green with faint radial veins and a lighter rim. Premultiplied. */
const PAD_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vEdge;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  float edge = clamp((1.0 - vEdge) / max(fwidth(vEdge), 1e-3), 0.0, 1.0);
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  float vein = smoothstep(0.9, 1.0, abs(cos(ang * 7.0))) * smoothstep(0.1, 0.5, r);
  vec3 col = vColor.rgb * (0.82 + 0.25 * r - 0.1 * vein);
  col += vec3(0.05, 0.07, 0.03) * smoothstep(0.85, 1.0, vEdge);
  float a = edge * vColor.a;
  outColor = vec4(col * a, a);
}
`;

/** A soft pad-shaped shadow. Premultiplied. */
const PAD_SHADOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vEdge;
flat in vec4 vColor;
uniform float uAlpha;
out vec4 outColor;
void main() {
  float a = uAlpha * vColor.a * (1.0 - smoothstep(0.55, 1.0, vEdge));
  outColor = vec4(0.0, 0.0, 0.0, a);
}
`;

/** A water-lily flower: two rings of eight petals round a yellow centre. Premultiplied. */
const FLOWER_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in float vEdge;
flat in vec4 vColor;
out vec4 outColor;
void main() {
  float r = length(vLocal);
  float ang = atan(vLocal.y, vLocal.x);
  float outer = 0.5 + 0.5 * pow(abs(cos(ang * 4.0)), 0.6);
  float inner = 0.35 + 0.35 * pow(abs(cos(ang * 4.0 + 0.785398)), 0.6);
  float d = r / max(outer, inner);
  float aa = fwidth(d) + 1e-3;
  float a = (1.0 - smoothstep(1.0 - aa, 1.0, d)) * vColor.a;
  vec3 col = vColor.rgb * (0.8 + 0.2 * clamp(d, 0.0, 1.0));
  // Petals of the inner ring catch more light.
  col *= inner > outer ? 1.05 : 0.95;
  col = mix(vec3(0.97, 0.8, 0.28), col, smoothstep(0.1, 0.18, r));
  outColor = vec4(col * a, a);
}
`;

/** Pad and flower shapes, in batch shape order. */
const PAD_SHAPES = [fanStrip(padOutline()), polygonStrip(10)];
const FLOWER_COLORS = [
  [0.99, 0.92, 0.94],
  [0.98, 0.8, 0.86],
  [0.99, 0.97, 0.94],
] as const;

/**
 * A top-down koi pond: koi glide and turn slowly over a pebbled floor with faint
 * caustics, their shadows following them, beneath drifting lily pads. Fish
 * near the surface now and then send out a ring ripple.
 */
export const koi = defineEffect(koiMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));

      // Floor.
      const floorProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, FLOOR_FRAGMENT);
      const floorU = createUniforms(gl, floorProgram, [
        "uPebbles",
        "uCaustic",
        "uSize",
        "uPebbleScale",
        "uCausticMat",
        "uCausticOff",
        "uShallow",
        "uDeep",
        "uLight",
        "uDepthPlane",
        "uRipples",
        "uRipple",
      ]);
      gl.useProgram(floorProgram);
      floorU.i1("uPebbles", 0);
      floorU.i1("uCaustic", 1);
      floorU.f3("uDepthPlane", 0.75, -0.3, 0.2);
      const pebbles = scope.add(
        createDataTexture(gl, {
          width: PEBBLE_SIZE,
          height: PEBBLE_SIZE,
          internalFormat: gl.R8,
          format: gl.RED,
          type: gl.UNSIGNED_BYTE,
          data: buildPebbleTexture(PEBBLE_SIZE, PEBBLE_CELLS),
          wrap: gl.REPEAT,
        }),
        (t) => {
          gl.deleteTexture(t);
        },
      );

      // Caustic tile, as in the caustics effect but with fewer iterations.
      const tile = scope.own(
        createCausticTile(gl, triangle, {
          interval: CAUSTIC_INTERVAL,
          rate: CAUSTIC_RATE,
          driftA: CAUSTIC_DRIFT,
          rates: CAUSTIC_RATES_3,
        }),
      );
      if (!tile.resize(CAUSTIC_TILE)) {
        throw new Error("Koi: R8 caustic tile is not renderable");
      }
      const causticMat = new Float32Array(4);

      // Fish: one strip per fish in a shared dynamic buffer.
      const fishData = new Float32Array(MAX_FISH * VERTS_PER_FISH * VERTEX_FLOATS);
      const fishVao = scope.add(gl.createVertexArray(), (v) => {
        gl.deleteVertexArray(v);
      });
      const fishBuffer = scope.add(gl.createBuffer(), (b) => {
        gl.deleteBuffer(b);
      });
      gl.bindVertexArray(fishVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, fishBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, fishData.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, VERTEX_FLOATS * 4, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, VERTEX_FLOATS * 4, 16);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      const fishProgram = scopedProgram(gl, scope, FISH_VERTEX, FISH_FRAGMENT);
      const fishU = createUniforms(gl, fishProgram, ["uResolution", "uOffset", "uFish", "uWater"]);
      gl.useProgram(fishProgram);
      fishU.f3("uOffset", 0, 0, 1);
      const shadowProgram = scopedProgram(gl, scope, FISH_VERTEX, FISH_SHADOW_FRAGMENT);
      const shadowU = createUniforms(gl, shadowProgram, ["uResolution", "uOffset", "uAlpha"]);

      // Lily pads and flowers: x, y, radius, opacity; r, g, b, unused; then the spin pair.
      const pads = scope.own(
        createSpriteBatch(gl, MAX_PADS * 2, [4, 4], PAD_SHAPES, { rotation: true }),
      );
      const padVs = padVertex(pads.spinLocation);
      const padProgram = scopedProgram(gl, scope, padVs, PAD_FRAGMENT);
      const padU = createUniforms(gl, padProgram, ["uResolution", "uOffset"]);
      gl.useProgram(padProgram);
      padU.f3("uOffset", 0, 0, 1);
      const padShadowProgram = scopedProgram(gl, scope, padVs, PAD_SHADOW_FRAGMENT);
      const padShadowU = createUniforms(gl, padShadowProgram, ["uResolution", "uOffset", "uAlpha"]);
      const flowerProgram = scopedProgram(gl, scope, padVs, FLOWER_FRAGMENT);
      const flowerU = createUniforms(gl, flowerProgram, ["uResolution", "uOffset"]);
      gl.useProgram(flowerProgram);
      flowerU.f3("uOffset", 0, 0, 1);

      // Simulation state.
      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      const fish = createFish(MAX_FISH, refWidth);
      const lily = createPads(MAX_PADS, refWidth);
      const ripples = createRipples(MAX_RIPPLES);
      const rippleData = new Float32Array(MAX_RIPPLES * 4);
      const noise = createNoise(0x4b01);
      const rng = createRng(0x4b02);
      const scratch = createStripScratch();
      const order = new Int32Array(MAX_FISH);
      const frame: FishFrame = { refWidth, count: 0, size: 0, speed: 0 };
      let ripplesOn = true;
      const onSurface = (x: number, y: number) => {
        if (ripplesOn) {
          spawnRipple(ripples, x, y);
        }
      };
      const waterRgb = unitRgbMemo();
      let lastWater = "";
      let lastCaustics = Number.NaN;
      let lastScale = Number.NaN;
      /** Whether the last ripple upload was all zeros, so it can be skipped while idle. */
      let ripplesIdle = false;

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          rescaleFish(fish, newRefWidth / refWidth);
          rescalePads(lily, newRefWidth / refWidth);
          refWidth = frame.refWidth = newRefWidth;
          ({ width, height, scale } = v);
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          ripplesOn = p.ripples;
          ripples.time += dt;

          // 1. Simulation.
          frame.count = p.fish;
          frame.size = p.size;
          frame.speed = p.speed;
          stepFish(fish, dt, frame, noise, rng, onSurface);
          stepPads(lily, dt, p.lilyPads, refWidth);

          // 2. Caustic tile, at most every CAUSTIC_INTERVAL.
          const caustics = Math.max(0, p.caustics);
          tile.advance(dt);
          tile.update(dt, true, caustics > 0);

          // 3. Floor, at reduced resolution.
          target.resize(width, height, qualityDivisor(p.quality));
          target.bind();
          gl.useProgram(floorProgram);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tile.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, pebbles);
          floorU.f2("uSize", width, height);
          if (scale !== lastScale) {
            lastScale = scale;
            floorU.f1("uPebbleScale", 1 / (PEBBLE_REF_PX * scale));
            const k = 1 / (CAUSTIC_REF_PX * scale);
            const c = Math.cos(CAUSTIC_ANGLE) * k;
            const s = Math.sin(CAUSTIC_ANGLE) * k;
            causticMat[0] = c;
            causticMat[1] = s;
            causticMat[2] = -s;
            causticMat[3] = c;
            gl.uniformMatrix2fv(floorU.loc.uCausticMat, false, causticMat);
            floorU.f2("uRipple", 1 / (RIPPLE_WIDTH * scale), RIPPLE_WARP * scale);
          }
          floorU.f2("uCausticOff", tile.offsets[0], tile.offsets[1]);
          if (p.water !== lastWater || caustics !== lastCaustics) {
            lastWater = p.water;
            lastCaustics = caustics;
            const w = waterRgb(p.water);
            floorU.f3("uShallow", w[0] * 1.3, w[1] * 1.25, w[2] * 1.15);
            floorU.f3("uDeep", w[0] * 0.3, w[1] * 0.34, w[2] * 0.38);
            const l = caustics * 0.32;
            floorU.f3("uLight", 0.85 * l, 0.95 * l, 0.8 * l);
          }
          writeRipples(ripples, scale, p.ripples ? 1 : 0, rippleData);
          let idle = true;
          for (let k = 3; k < rippleData.length; k += 4) {
            if (rippleData[k] !== 0) {
              idle = false;
            }
          }
          if (!(idle && ripplesIdle)) {
            gl.uniform4fv(floorU.loc.uRipples, rippleData);
          }
          ripplesIdle = idle;
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();
          gl.viewport(0, 0, width, height);

          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

          // 4. Lily pads and flowers into the batch: pads first, then flowers.
          const nPads = lily.live;
          let nFlowers = 0;
          const pd = pads.data;
          const stride = pads.stride;
          for (let i = 0; i < nPads; i++) {
            const o = i * stride;
            const life = lily.life[i];
            const g = lily.shade[i];
            pd[o] = lily.x[i] * scale;
            pd[o + 1] = lily.y[i] * scale;
            pd[o + 2] = lily.r[i] * scale;
            pd[o + 3] = life;
            pd[o + 4] = 0.22 * g;
            pd[o + 5] = 0.4 * g;
            pd[o + 6] = 0.17 * g;
            pd[o + 7] = 0;
            pd[o + 8] = lily.angle[i];
            pd[o + 9] = 1;
          }
          for (let i = 0; i < nPads; i++) {
            if (!(lily.flower[i] > 0)) {
              continue;
            }
            const o = (nPads + nFlowers) * stride;
            const a = lily.angle[i] + Math.PI;
            const r = lily.r[i];
            const fc = FLOWER_COLORS[i % FLOWER_COLORS.length];
            pd[o] = (lily.x[i] + Math.cos(a) * r * 0.3) * scale;
            pd[o + 1] = (lily.y[i] + Math.sin(a) * r * 0.3) * scale;
            pd[o + 2] = r * lily.flower[i] * scale;
            pd[o + 3] = lily.life[i];
            pd[o + 4] = fc[0];
            pd[o + 5] = fc[1];
            pd[o + 6] = fc[2];
            pd[o + 7] = 0;
            pd[o + 8] = lily.angle[i] * 1.7;
            pd[o + 9] = 1;
            nFlowers++;
          }
          if (nPads > 0) {
            pads.upload(nPads + nFlowers);
          }

          // 5. Fish strips.
          const nFish = fish.live;
          const size = Math.max(1, p.size);
          const cruise = SWIM_PX * (size / 120);
          for (let i = 0; i < nFish; i++) {
            const sweep = 0.35 + 0.65 * Math.min(1.4, fish.speed[i] / cruise);
            const length = fishLength(fish, i, size);
            writeFishStrip(
              fish,
              i,
              length,
              sweep,
              scale,
              fishData,
              i * VERTS_PER_FISH * VERTEX_FLOATS,
              scratch,
            );
          }
          if (nFish > 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, fishBuffer);
            gl.bufferSubData(
              gl.ARRAY_BUFFER,
              0,
              fishData,
              0,
              nFish * VERTS_PER_FISH * VERTEX_FLOATS,
            );
            gl.bindBuffer(gl.ARRAY_BUFFER, null);
          }
          sortByDepth(fish, nFish, order);

          // 6. Shadows on the floor: pads, then fish.
          if (nPads > 0) {
            gl.useProgram(padShadowProgram);
            padShadowU.f2("uResolution", width, height);
            padShadowU.f3(
              "uOffset",
              SHADOW_DIR[0] * PAD_SHADOW * scale,
              SHADOW_DIR[1] * PAD_SHADOW * scale,
              1.08,
            );
            padShadowU.f1("uAlpha", 0.32);
            pads.draw(0, nPads, 0);
          }
          if (nFish > 0) {
            gl.useProgram(shadowProgram);
            shadowU.f2("uResolution", width, height);
            gl.bindVertexArray(fishVao);
            for (let k = 0; k < nFish; k++) {
              const i = order[k];
              if (!(fish.life[i] > 0)) {
                continue;
              }
              const d = (FISH_SHADOW_NEAR + FISH_SHADOW_FAR * (1 - fish.depth[i])) * scale;
              shadowU.f3("uOffset", SHADOW_DIR[0] * d, SHADOW_DIR[1] * d, 1.35);
              shadowU.f1("uAlpha", 0.38 * fish.life[i] * (1 - 0.3 * fish.depth[i]));
              gl.drawArrays(gl.TRIANGLE_STRIP, i * VERTS_PER_FISH, VERTS_PER_FISH);
            }

            // 7. Fish, deepest first.
            gl.useProgram(fishProgram);
            fishU.f2("uResolution", width, height);
            const w = waterRgb(p.water);
            fishU.f3("uWater", w[0] * 0.8, w[1] * 0.8, w[2] * 0.8);
            for (let k = 0; k < nFish; k++) {
              const i = order[k];
              if (!(fish.life[i] > 0)) {
                continue;
              }
              fishU.f4(
                "uFish",
                varietyOf(fish, i, p.varieties),
                fish.seed[i],
                fish.depth[i],
                fish.life[i],
              );
              gl.drawArrays(gl.TRIANGLE_STRIP, i * VERTS_PER_FISH, VERTS_PER_FISH);
            }
            gl.bindVertexArray(null);
          }

          // 8. Lily pads and their flowers float on top.
          if (nPads > 0) {
            gl.useProgram(padProgram);
            padU.f2("uResolution", width, height);
            pads.draw(0, nPads, 0);
            if (nFlowers > 0) {
              gl.useProgram(flowerProgram);
              flowerU.f2("uResolution", width, height);
              pads.draw(nPads, nFlowers, 1);
            }
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
