import { hexToUnitRgb, unitRgbMemo } from "./color";
import {
  advancePhases,
  bubbleX,
  CAUSTIC_RATES,
  createBubbleState,
  createRays,
  fillRayTable,
  seedBubbles,
  stepBubbles,
  tileResolution,
} from "./caustics-sim";
import {
  beginFrame,
  createColumnTable,
  createFullscreenTriangle,
  createProgram,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  getUniforms,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
} from "./gl";
import { createRng } from "./noise";
import { createSpriteBatch, polygonStrip } from "./sprites";
import { defineEffect, type ParamSchema, type ParamValues } from "./types";
import { wrap } from "./math";

/** On-screen size of one caustic tile period in reference px at scale 1. */
const TILE_REF_PX = 900;
/** Second layer: larger cells, rotated, so the two tilings never line up. */
const LAYER_B_SCALE = 1.6;
const LAYER_B_ANGLE = 0.7;
/** Deep water: cells squashed vertically, as if seen at a glancing angle. */
const DEEP_SQUASH = 0.55;
/** Pool tile grid pitch and grout half-width in reference px. */
const GRID_REF_PX = 150;
const GROUT_REF_PX = 1.2;
/** Base morph rate (phase units per second) at speed 1. */
const TIME_RATE = 0.25;
/** Drift of each layer in tile periods per second at speed 1. */
const DRIFT_A: readonly [number, number] = [0.011, 0.006];
const DRIFT_B: readonly [number, number] = [-0.005, 0.008];
/** Chromatic offset in tile units at chromatic = 1. */
const CHROMA_TILE = 0.006;
/** The tile is re-rendered at most this often; the slow morph hides 60 Hz updates. */
const TILE_INTERVAL = 1 / 60;
const RAY_COLUMNS = 256;
const RAY_COUNT = 7;
const RAY_STRENGTH = 0.22;
const MAX_BUBBLES = 40;

/**
 * One period of the iterated sine-warp caustic (after Dave Hoskins' tileable water
 * caustic), into an R8 tile. Every term is 2π-periodic in `p`, so the tile repeats
 * seamlessly. The original `1 / length(p * k / sin, p * k / cos)` uses the
 * near-constant `p * k` (about 1.23) and is rewritten as
 * `|s c| / (k * sqrt(s² + c²))`, which has no division by zero.
 */
export function tileFragment(iterations: number): string {
  let body = "";
  for (let n = 0; n < iterations; n++) {
    body += `
  t = uT[${n}];
  i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
  s = sin(i.x + t);
  k = cos(i.y + t);
  c += abs(s * k) * inversesqrt(s * s + k * k + 1e-6);`;
  }
  return /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uT[${iterations}];
out vec4 outColor;
void main() {
  vec2 p = vUv * 6.28318530718;
  vec2 i = p;
  float c = 0.0;
  float t;
  float s;
  float k;${body}
  c = (1.0 + c * ${glslFloat(1 / 1.23)}) * ${glslFloat(1 / iterations)};
  float v = pow(max(1.17 - pow(c, 1.4), 0.0), 8.0);
  outColor = vec4(clamp(v * 0.75 - 0.08, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;
}

/**
 * Full-screen composite: two REPEAT samples of the tile at different scales,
 * angles and drifts (layer A three times with `chromatic`), over either a tinted
 * pool floor with faint tile grout or a deep-water depth gradient with god rays.
 */
export function mainFragment(deep: boolean, chromatic: boolean): string {
  const sampleA = chromatic
    ? `vec3 a = vec3(texture(uTile, ua + uChroma).r, texture(uTile, ua).r, texture(uTile, ua - uChroma).r);`
    : `vec3 a = vec3(texture(uTile, ua).r);`;
  const scene = deep
    ? /* glsl */ `
  float y = vUv.y;
  float y2 = y * y;
  vec3 col = mix(uBase, uTop, y2) + uLight * c * (0.1 + 0.9 * y2);
  // Rays fan out downwards from above the top centre: one fetch of the column table.
  float rx = (vUv.x - 0.5) / (1.0 + (1.0 - y) * 0.8) + 0.5;
  col += uRayColor * (texture(uRays, vec2(rx, 0.5)).r * y2);`
    : /* glsl */ `
  vec2 g = fract(p * uGrid.x);
  vec2 e = min(g, 1.0 - g);
  float edge = min(e.x, e.y) / uGrid.x;
  float grout = 1.0 - smoothstep(uGrid.y * 0.5, uGrid.y * 1.5, edge);
  vec3 col = uBase * (1.0 - uGrid.z * grout) + uLight * c;`;
  return /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D uTile;
uniform sampler2D uRays;
uniform mat2 uMatA;
uniform mat2 uMatB;
uniform vec2 uOffA;
uniform vec2 uOffB;
uniform vec2 uChroma;
uniform vec3 uBase;
uniform vec3 uTop;
uniform vec3 uLight;
uniform vec3 uGrid;
uniform vec3 uRayColor;
in vec2 vUv;
out vec4 outColor;
${DITHER_GLSL}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 ua = uMatA * p + uOffA;
  float b = texture(uTile, uMatB * p + uOffB).r;
  ${sampleA}
  // Both networks, brighter where they cross.
  vec3 c = (a + b) * 0.5 + a * b;
${scene}
  // Sub-LSB dither: the floor and depth gradients are wide and shallow.
  outColor = vec4(col + dither8(p), 1.0);
}
`;
}

const BUBBLE_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec3 aCircle;
layout(location = 2) in float aAlpha;
uniform vec2 uResolution;
out vec2 vLocal;
flat out float vAlpha;
${TO_CLIP_GLSL}
void main() {
  // One extra pixel so the anti-aliased rim is never clipped.
  float ext = aCircle.z + 1.0;
  vec2 px = aCircle.xy + aCorner * ext;
  vLocal = aCorner * ext / aCircle.z;
  vAlpha = aAlpha;
  gl_Position = pxToClip(px, uResolution);
}
`;

/** A bubble: faint body, brighter rim, highlight at the top left (vLocal y is down). Premultiplied output. */
const BUBBLE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
flat in float vAlpha;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  float d = length(vLocal);
  float aa = max(fwidth(d), 0.02);
  float disc = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  float rim = smoothstep(0.6, 1.0, d) * disc;
  float hi = 1.0 - smoothstep(0.0, 0.32, length(vLocal - vec2(-0.35, -0.4)));
  float a = clamp(0.06 * disc + 0.55 * rim * rim + 0.6 * hi, 0.0, 1.0) * vAlpha;
  outColor = vec4(uColor * a, a);
}
`;

const MAIN_UNIFORMS = [
  "uTile",
  "uRays",
  "uMatA",
  "uMatB",
  "uOffA",
  "uOffB",
  "uChroma",
  "uBase",
  "uTop",
  "uLight",
  "uGrid",
  "uRayColor",
] as const;

const PARAMS = {
  scene: {
    kind: "select",
    label: "Scene",
    options: [
      { value: "pool", label: "Pool floor" },
      { value: "deep", label: "Deep water" },
    ],
    default: "pool",
  },
  waterColor: { kind: "color", label: "Water colour", default: "#1a7896" },
  lightColor: { kind: "color", label: "Light colour", default: "#e6fbff" },
  intensity: { kind: "number", label: "Intensity", min: 0, max: 2, step: 0.05, default: 1 },
  scale: { kind: "number", label: "Cell size", min: 0.5, max: 2, step: 0.05, default: 1 },
  speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
  chromatic: {
    kind: "number",
    label: "Chromatic split (0 = off)",
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.3,
  },
  tiles: { kind: "boolean", label: "Pool tiles (pool floor only)", default: true },
  rays: { kind: "boolean", label: "God rays (deep water only)", default: true },
  bubbles: {
    kind: "number",
    label: "Bubbles (deep water only)",
    min: 0,
    max: MAX_BUBBLES,
    step: 1,
    default: 12,
  },
} as const satisfies ParamSchema;

/**
 * Rippling caustic light, like sunlight through waves: either a top-down pool
 * floor or a deep-water view with a depth gradient, god rays and bubbles. One
 * small tileable caustic texture is rendered (at most 60 Hz) and sampled twice
 * per pixel with REPEAT.
 */
export const caustics = defineEffect({
  id: "caustics",
  name: "Underwater Caustics",
  description:
    "Rippling networks of light on a pool floor, or deep water with god rays and rising bubbles.",
  context: "webgl2",
  params: PARAMS,
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));

      // Caustic tile: R8 is colour-renderable and filterable in core WebGL2.
      const tileProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, tileFragment(CAUSTIC_RATES.length)),
        (p) => gl.deleteProgram(p),
      );
      const uT = gl.getUniformLocation(tileProgram, "uT");
      const tileFbo = scope.add(gl.createFramebuffer(), (f) => gl.deleteFramebuffer(f));
      let tileTex: WebGLTexture | null = null;
      scope.defer(() => gl.deleteTexture(tileTex));
      let tileRes = 0;

      // Four variants: [pool, deep] x [mono, chromatic]; index = deep * 2 + chromatic.
      const mains = [false, true].flatMap((deep) =>
        [false, true].map((chroma) => {
          const program = scope.add(
            createProgram(gl, FULLSCREEN_VERTEX, mainFragment(deep, chroma)),
            (p) => gl.deleteProgram(p),
          );
          const loc = getUniforms(gl, program, MAIN_UNIFORMS);
          gl.useProgram(program);
          gl.uniform1i(loc.uTile, 0);
          gl.uniform1i(loc.uRays, 1);
          return { program, loc, version: -1 };
        }),
      );

      const rayTable = scope.own(createColumnTable(gl, RAY_COLUMNS, 1));
      const rng = createRng(0xc0a5);
      const rays = createRays(rng, RAY_COUNT);

      const bubbleProgram = scope.add(createProgram(gl, BUBBLE_VERTEX, BUBBLE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const bubbleLoc = getUniforms(gl, bubbleProgram, ["uResolution", "uColor"]);
      // Per bubble: centre x, centre y, radius (device px, y down), then alpha.
      const batch = scope.own(createSpriteBatch(gl, MAX_BUBBLES, [3, 1], [polygonStrip(8)]));
      const bubbles = createBubbleState(MAX_BUBBLES);
      const bubbleColor = unitRgbMemo();
      const bubbleSet = { width: 0, height: 0, color: null as unknown };
      let prevBubbles = 0;

      let width = 1;
      let height = 1;
      let vpScale = 1;
      let refWidth = 1920;
      seedBubbles(bubbles, rng, refWidth);

      const phases = new Float32Array(CAUSTIC_RATES.length);
      let tileAge = Infinity;
      let tileDirty = true;
      let clock = 0;
      let offAx = 0;
      let offAy = 0;
      let offBx = 0;
      let offBy = 0;

      // Derived static uniforms, recomputed only when an input changes.
      const matA = new Float32Array(4);
      const matB = new Float32Array(4);
      const chroma = new Float32Array(2);
      const base = new Float32Array(3);
      const top = new Float32Array(3);
      const light = new Float32Array(3);
      const grid = new Float32Array(3);
      const rayColor = new Float32Array(3);
      let version = 0;
      const last = {
        scene: "",
        water: "",
        light: "",
        intensity: Number.NaN,
        scale: Number.NaN,
        chromatic: Number.NaN,
        tiles: false,
        rays: false,
        width: 0,
        height: 0,
        vpScale: 0,
      };

      const ensureTile = (res: number) => {
        if (res === tileRes && tileTex) return;
        tileRes = res;
        gl.deleteTexture(tileTex);
        tileTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tileTex);
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, res, res);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, tileFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tileTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        tileDirty = true;
      };

      /** Recomputes the static uniforms if any input changed; returns true if so. */
      const updateStatics = (p: ParamValues<typeof PARAMS>) => {
        if (
          last.scene === p.scene &&
          last.water === p.waterColor &&
          last.light === p.lightColor &&
          last.intensity === p.intensity &&
          last.scale === p.scale &&
          last.chromatic === p.chromatic &&
          last.tiles === p.tiles &&
          last.rays === p.rays &&
          last.width === width &&
          last.height === height &&
          last.vpScale === vpScale
        ) {
          return;
        }
        last.scene = p.scene;
        last.water = p.waterColor;
        last.light = p.lightColor;
        last.intensity = p.intensity;
        last.scale = p.scale;
        last.chromatic = p.chromatic;
        last.tiles = p.tiles;
        last.rays = p.rays;
        last.width = width;
        last.height = height;
        last.vpScale = vpScale;
        version++;

        const deep = p.scene === "deep";
        const tilePx = TILE_REF_PX * Math.max(0.1, p.scale) * vpScale;
        ensureTile(tileResolution(tilePx));
        // mat2 uniforms are column-major: [m00, m10, m01, m11].
        const ia = 1 / tilePx;
        matA[0] = ia;
        matA[1] = 0;
        matA[2] = 0;
        matA[3] = deep ? ia / DEEP_SQUASH : ia;
        const ib = 1 / (tilePx * LAYER_B_SCALE);
        const cs = Math.cos(LAYER_B_ANGLE) * ib;
        const sn = Math.sin(LAYER_B_ANGLE) * ib;
        const sy = deep ? 1 / DEEP_SQUASH : 1;
        matB[0] = cs;
        matB[1] = sn;
        matB[2] = -sn * sy;
        matB[3] = cs * sy;
        const ch = Math.max(0, p.chromatic) * CHROMA_TILE;
        chroma[0] = ch;
        chroma[1] = ch * 0.6;

        const w = hexToUnitRgb(p.waterColor);
        const l = hexToUnitRgb(p.lightColor);
        const k = Math.max(0, p.intensity);
        for (let c = 0; c < 3; c++) {
          if (deep) {
            base[c] = w[c] * 0.12;
            top[c] = w[c] + (l[c] - w[c]) * 0.2;
            light[c] = l[c] * k * 0.3;
            rayColor[c] = p.rays ? l[c] * k * RAY_STRENGTH : 0;
          } else {
            base[c] = w[c] * 0.85;
            top[c] = base[c];
            light[c] = l[c] * k * 0.55;
            rayColor[c] = 0;
          }
        }
        grid[0] = 1 / (GRID_REF_PX * vpScale);
        grid[1] = Math.max(0.75, GROUT_REF_PX * vpScale);
        grid[2] = p.tiles && !deep ? 0.12 : 0;
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          const s = newRefWidth / refWidth;
          for (let i = 0; i < MAX_BUBBLES; i++) bubbles.x[i] *= s;
          refWidth = newRefWidth;
          width = v.width;
          height = v.height;
          vpScale = v.scale;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const speed = Math.max(0, p.speed);
          const sdt = dt * speed;
          clock += sdt;
          advancePhases(phases, sdt * TIME_RATE);
          offAx = wrap(offAx + DRIFT_A[0] * sdt, 0, 1);
          offAy = wrap(offAy + DRIFT_A[1] * sdt, 0, 1);
          offBx = wrap(offBx + DRIFT_B[0] * sdt, 0, 1);
          offBy = wrap(offBy + DRIFT_B[1] * sdt, 0, 1);
          updateStatics(p);
          const deep = p.scene === "deep";

          // 1. Caustic tile, at most every TILE_INTERVAL while moving.
          tileAge += dt;
          if (tileDirty || (sdt > 0 && tileAge >= TILE_INTERVAL * 0.9)) {
            tileAge = 0;
            tileDirty = false;
            gl.bindFramebuffer(gl.FRAMEBUFFER, tileFbo);
            gl.viewport(0, 0, tileRes, tileRes);
            gl.useProgram(tileProgram);
            gl.uniform1fv(uT, phases);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. Ray table (deep water only).
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rayTable.texture);
          if (deep && p.rays) {
            fillRayTable(rayTable.data, rays, clock);
            rayTable.upload();
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tileTex);

          // 3. Full-screen composite.
          const main = mains[(deep ? 2 : 0) + (p.chromatic > 0 ? 1 : 0)];
          gl.useProgram(main.program);
          if (main.version !== version) {
            main.version = version;
            const loc = main.loc;
            gl.uniformMatrix2fv(loc.uMatA, false, matA);
            gl.uniformMatrix2fv(loc.uMatB, false, matB);
            gl.uniform2fv(loc.uChroma, chroma);
            gl.uniform3fv(loc.uBase, base);
            gl.uniform3fv(loc.uTop, top);
            gl.uniform3fv(loc.uLight, light);
            gl.uniform3fv(loc.uGrid, grid);
            gl.uniform3fv(loc.uRayColor, rayColor);
          }
          gl.uniform2f(main.loc.uOffA, offAx, offAy);
          gl.uniform2f(main.loc.uOffB, offBx, offBy);
          triangle.draw();

          // 4. Bubbles (deep water only).
          const n = deep ? Math.min(MAX_BUBBLES, Math.max(0, Math.floor(p.bubbles))) : 0;
          for (let i = prevBubbles; i < n; i++) bubbles.life[i] = 0;
          prevBubbles = n;
          if (n > 0) {
            stepBubbles(bubbles, n, sdt, refWidth, rng);
            const data = batch.data;
            const stride = batch.stride;
            const alphaScale = Math.min(1, 0.4 + 0.4 * p.intensity);
            for (let i = 0; i < n; i++) {
              const o = i * stride;
              const y = bubbles.y[i];
              // Brighter near the lit surface.
              const depth = Math.min(1, Math.max(0, y / 1080));
              const life = bubbles.life[i];
              data[o] = bubbleX(bubbles, i, clock) * vpScale;
              data[o + 1] = y * vpScale;
              data[o + 2] = bubbles.r[i] * vpScale;
              data[o + 3] = alphaScale * (1 - 0.6 * depth) * life * life;
            }
            batch.upload(n);
            gl.enable(gl.BLEND);
            gl.blendEquation(gl.FUNC_ADD);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(bubbleProgram);
            if (bubbleSet.width !== width || bubbleSet.height !== height) {
              gl.uniform2f(bubbleLoc.uResolution, width, height);
              bubbleSet.width = width;
              bubbleSet.height = height;
            }
            const color = bubbleColor(p.lightColor);
            if (bubbleSet.color !== color) {
              gl.uniform3fv(bubbleLoc.uColor, color);
              bubbleSet.color = color;
            }
            batch.draw(0, n);
            gl.disable(gl.BLEND);
          }
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
