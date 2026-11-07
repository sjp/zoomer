import { hexToUnitRgb } from "../color";
import {
  advancePhases,
  bubbleX,
  rescaleBubbles,
  tileMatrices,
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
  createUniforms,
  createRenderTarget,
  DITHER_GLSL,
  FULLSCREEN_VERTEX,
  glslFloat,
  type RenderTarget,
  TO_CLIP_GLSL,
  withScope,
} from "../gl";
import { createRng } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { causticsMeta, MAX_BUBBLES } from "./caustics.meta";
import { defineEffect, type ParamValues } from "../types";
import { wrap } from "../math";
import { growLive, trimLive } from "../fade";

/** On-screen size of one caustic tile period in reference px at scale 1. */
const TILE_REF_PX = 900;
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
  t = uT[${String(n)}];
  i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
  s = sin(i.x + t);
  k = cos(i.y + t);
  c += abs(s * k) * inversesqrt(s * s + k * k + 1e-6);`;
  }
  return /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uT[${String(iterations)}];
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
 * `rays` (deep water only) adds the ray table fetch; without it the variant skips it.
 */
export function mainFragment(deep: boolean, chromatic: boolean, rays = deep): string {
  const sampleA = chromatic
    ? `vec3 a = vec3(texture(uTile, ua + uChroma).r, texture(uTile, ua).r, texture(uTile, ua - uChroma).r);`
    : `vec3 a = vec3(texture(uTile, ua).r);`;
  const scene = deep
    ? /* glsl */ `
  float y = vUv.y;
  float y2 = y * y;
  vec3 col = mix(uBase, uTop, y2) + uLight * c * (0.1 + 0.9 * y2);
  ${
    rays
      ? `// Rays fan out downwards from above the top centre: one fetch of the column table.
  float rx = (vUv.x - 0.5) / (1.0 + (1.0 - y) * 0.8) + 0.5;
  col += uRayColor * (texture(uRays, vec2(rx, 0.5)).r * y2);`
      : ""
  }`
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

/**
 * Rippling caustic light, like sunlight through waves: either a top-down pool
 * floor or a deep-water view with a depth gradient, god rays and bubbles. One
 * small tileable caustic texture is rendered (at most 60 Hz) and sampled twice
 * per pixel with REPEAT.
 */
export const caustics = defineEffect(causticsMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));

      // Caustic tile: R8 is colour-renderable and filterable in core WebGL2.
      const tileProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, tileFragment(CAUSTIC_RATES.length)),
        (p) => {
          gl.deleteProgram(p);
        },
      );
      const uT = gl.getUniformLocation(tileProgram, "uT");
      let tile: RenderTarget | null = null;
      // `ensureTile` replaces the tile, so dispose whichever one is current.
      scope.defer(() => tile?.dispose());

      // Six variants: [pool, deep, deep + rays] x [mono, chromatic];
      // index = scene * 2 + chromatic, so deep water without rays skips the ray fetch.
      const mains = [0, 1, 2].flatMap((scene) =>
        [false, true].map((chroma) => {
          const program = scope.add(
            createProgram(gl, FULLSCREEN_VERTEX, mainFragment(scene > 0, chroma, scene > 1)),
            (p) => {
              gl.deleteProgram(p);
            },
          );
          const u = createUniforms(gl, program, MAIN_UNIFORMS);
          gl.useProgram(program);
          u.i1("uTile", 0);
          u.i1("uRays", 1);
          // Arrays and matrices aren't tracked by `u`: `version` marks them current.
          return { u, version: -1 };
        }),
      );

      const rayTable = scope.own(createColumnTable(gl, RAY_COLUMNS, 1));
      const rng = createRng(0xc0a5);
      const rays = createRays(rng, RAY_COUNT);

      const bubbleProgram = scope.add(createProgram(gl, BUBBLE_VERTEX, BUBBLE_FRAGMENT), (p) => {
        gl.deleteProgram(p);
      });
      const bubbleU = createUniforms(gl, bubbleProgram, ["uResolution", "uColor"]);
      // Per bubble: centre x, centre y, radius (device px, y down), then alpha.
      const batch = scope.own(createSpriteBatch(gl, MAX_BUBBLES, [3, 1], [polygonStrip(8)]));
      const bubbles = createBubbleState(MAX_BUBBLES);
      /** Bubbles simulated: the count plus any still fading out after it dropped. */
      let liveBubbles = 0;

      let width = 1;
      let height = 1;
      let vpScale = 1;
      let refWidth = 1920;
      seedBubbles(bubbles, rng, refWidth);

      const phases = new Float32Array(CAUSTIC_RATES.length);
      let tileAge = Infinity;
      let tileDirty = true;
      let clock = 0;
      /** The clock the ray table was last filled for (NaN: never). */
      let rayClock = Number.NaN;
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
        if (res === tile?.width) {
          return;
        }
        tile?.dispose();
        tile = null;
        tile = createRenderTarget(gl, res, res, gl.R8, { wrap: gl.REPEAT });
        if (!tile) {
          throw new Error("Caustics: R8 tile is not renderable");
        }
        tileDirty = true;
      };

      /** Recomputes the static uniforms if any input changed; returns true if so. */
      const updateStatics = (p: ParamValues<typeof causticsMeta.params>) => {
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
        tileMatrices(tilePx, deep, matA, matB);
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
          rescaleBubbles(bubbles, s);
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
            tile?.bind();
            gl.useProgram(tileProgram);
            gl.uniform1fv(uT, phases);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, width, height);
          }

          // 2. Ray table (deep water only).
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, rayTable.texture);
          // The rays are fixed, so the table only changes with the clock: skip it while paused.
          if (deep && p.rays && clock !== rayClock) {
            rayClock = clock;
            fillRayTable(rayTable.data, rays, clock);
            rayTable.upload();
          }
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tile?.texture ?? null);

          // 3. Full-screen composite.
          const main = mains[(deep ? (p.rays ? 4 : 2) : 0) + (p.chromatic > 0 ? 1 : 0)];
          gl.useProgram(main.u.program);
          if (main.version !== version) {
            main.version = version;
            const loc = main.u.loc;
            gl.uniformMatrix2fv(loc.uMatA, false, matA);
            gl.uniformMatrix2fv(loc.uMatB, false, matB);
            gl.uniform2fv(loc.uChroma, chroma);
            gl.uniform3fv(loc.uBase, base);
            gl.uniform3fv(loc.uTop, top);
            gl.uniform3fv(loc.uLight, light);
            gl.uniform3fv(loc.uGrid, grid);
            gl.uniform3fv(loc.uRayColor, rayColor);
          }
          main.u.f2("uOffA", offAx, offAy);
          main.u.f2("uOffB", offBx, offBy);
          triangle.draw();

          // 4. Bubbles (deep water only).
          const target = deep ? Math.min(MAX_BUBBLES, Math.max(0, Math.floor(p.bubbles))) : 0;
          // Bubbles belong to deep water only; a scene change is a hard cut.
          if (!deep) {
            liveBubbles = 0;
          }
          const n = (liveBubbles = growLive(bubbles.life, liveBubbles, target));
          if (n > 0) {
            stepBubbles(bubbles, n, target, sdt, dt, refWidth, rng);
            liveBubbles = trimLive(bubbles.life, liveBubbles, target);
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
            bubbleU.f2("uResolution", width, height);
            bubbleU.rgb("uColor", p.lightColor);
            batch.draw(0, n);
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
