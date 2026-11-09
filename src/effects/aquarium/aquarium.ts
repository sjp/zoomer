import {
  type AquariumLight,
  AIRSTONE_BUBBLES,
  AIRSTONE_MODE,
  AIRSTONE_RX,
  AIRSTONE_RY,
  AIRSTONE_SIZE,
  AIRSTONE_X,
  airstoneY,
  AQUARIUM_SWELL,
  buildHardscape,
  buildPlants,
  createFishSim,
  type FishEnv,
  fishInstances,
  GRAVEL_GLSL,
  type Hardscape,
  LIGHTS,
  MAX_PLANTS,
  MAX_ROCKS,
  MAX_WOOD,
  PLANT_SEGMENTS,
  PLANT_STRIP,
  PLANT_SWAY,
  type PlantLayout,
  stepFishSim,
} from "./aquarium-sim";
import { FISH_FRAGMENT, FISH_VERTEX, WATER_GLSL } from "./aquarium-fish";
import { aquariumMeta, MAX_FISH, SPECIES_OPTIONS, type SpeciesId } from "./aquarium.meta";
import { BUBBLE_FRAGMENT, bubbleVertex } from "../bubble-sprites";
import { type BubbleFrame, createBubbles } from "../bubbles/bubbles-sim";
import { tileMatrices, tileResolution } from "../caustics/caustics-sim";
import {
  beginFrame,
  createFullscreenTriangle,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  TO_CLIP_GLSL,
  withScope,
  scopedProgram,
} from "../gl";
import { createLowResTarget, qualityDivisor } from "../lowres";
import { HASH32_GLSL } from "../noise";
import { createSpriteBatch, polygonStrip } from "../sprites";
import { advanceSwell, swayGlsl } from "../sway";
import { defineEffect } from "../types";
import { lookup } from "../lookup";
import { createCausticTile } from "../caustic-tile";

const isSpeciesId = (v: string): v is SpeciesId => SPECIES_OPTIONS.some((o) => o.value === v);
const f = glslFloat;

/** The background is soft apart from the gravel, whose pebbles are 7 px at 1080p at the back. */
const BACK_DIVISORS = { high: 1, balanced: 2, low: 3 } as const;
/** On-screen caustic period on the back wall, px at 1080p; the floor's is smaller. */
const TILE_REF_PX = 640;
const FLOOR_TILE_SCALE = 0.7;
/** Caustic morph rate (phase units per second) and drift (tile periods per second) at speed 1. */
const CAUSTIC_RATE = 0.22;
const DRIFT_A: readonly [number, number] = [0.009, 0.004];
const DRIFT_B: readonly [number, number] = [-0.004, 0.007];
/** The tile is re-rendered at most this often; the slow morph hides 30 Hz updates. */
const TILE_INTERVAL = 1 / 30;
/** Light rays from the surface: x at the top (fraction of the width), half width (px at 1080p), strength. */
const RAYS = [
  [0.1, 46, 1],
  [0.24, 30, 0.7],
  [0.72, 38, 0.8],
  [0.88, 52, 1],
] as const;
const RAY_SLOPE = 0.12;
const RAY_SWAY = 0.03;
/** Seconds the air-stone column takes to fade in or out when toggled. */
const BUBBLE_FADE = 1.2;
/** Far to near: the back and front plant layers. Sway scale, edge blur (px at 1080p), fog, brightness. */
const BACK_LAYER = [0.85, 1.2, 0.3, 0.95] as const;
const FRONT_LAYER = [1, 2.5, 0.02, 0.62] as const;

/**
 * The tank behind the fish, at reduced resolution: the water gradient over a
 * faintly mottled back wall, light rays, the gravel bed (two layers of hashed
 * pebbles in a perspective grid), driftwood, rocks and the air stone, with
 * caustics (two fetches of one tile) on the wall, the gravel and the rocks'
 * tops. The blit adds the dither.
 */
const BACK_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform vec2 uResolution;
uniform float uScale;
uniform vec3 uWall;
uniform vec3 uGravelA;
uniform vec3 uGravelB;
uniform vec3 uRock;
uniform vec3 uWood;
uniform vec3 uLightCol;
uniform vec3 uRayCol;
/** Rays: top x (px), slope (dx/dy), half width (px), strength. */
uniform vec4 uRays[${String(RAYS.length)}];
/** Rocks: centre (px), radii (px). */
uniform vec4 uRocks[${String(MAX_ROCKS)}];
/** Driftwood: base and tip (px); radii at base and tip, two per branch. */
uniform vec4 uWoods[${String(MAX_WOOD)}];
uniform vec4 uWoodR;
/** Air stone: centre (px), radii (px). */
uniform vec4 uStone;
uniform sampler2D uTile;
uniform mat2 uMatA;
uniform mat2 uMatB;
uniform mat2 uMatFA;
uniform mat2 uMatFB;
uniform vec2 uOffA;
uniform vec2 uOffB;
out vec4 outColor;
${WATER_GLSL}
${HASH32_GLSL}
${GRAVEL_GLSL}

float caustic(vec2 p, mat2 a, mat2 b) {
  float ca = texture(uTile, a * p + uOffA).r;
  float cb = texture(uTile, b * p + uOffB).r;
  return (ca + cb) * 0.5 + ca * cb;
}

/** One layer of pebbles, one per cell: (coverage, shading, colour pick). */
vec3 pebbles(vec2 q, uint salt) {
  vec2 c = floor(q);
  vec2 fq = q - c;
  uint h = hash32((uint(int(c.x) + 4096) * 0x9e3779b1u) ^ (uint(int(c.y) + 4096) * 0x85ebca77u) ^ salt);
  vec2 o = 0.35 + 0.3 * vec2(float(h & 255u), float((h >> 8u) & 255u)) / 255.0;
  float r = 0.3 + 0.12 * float((h >> 16u) & 255u) / 255.0;
  vec2 d = (fq - o) / r;
  float l = length(d);
  float cover = 1.0 - smoothstep(0.7, 1.0, l);
  float shade = 0.85 - 0.3 * d.y - 0.2 * l * l;
  return vec3(cover, shade, float(h >> 24u) / 255.0);
}

void main() {
  vec2 px = vec2(vUv.x, 1.0 - vUv.y) * uResolution;
  float H = uResolution.y;
  float s = uScale;
  float u = vUv.x;
  float v = px.y / H;

  // Water over the back wall.
  vec3 col = waterAt(v);
  float xh = px.x / H;
  float mottle = sin(xh * 7.0 + sin(v * 5.0) * 1.3) * sin(v * 9.0 + sin(xh * 4.0) * 1.7);
  col = mix(col, uWall * (1.0 - 0.45 * v), 0.3) * (0.94 + 0.06 * mottle);
  col += uTop * 0.3 * exp(-v * 14.0);

  float g = gravelTop(u);
  bool onFloor = v > g;
  float cw = caustic(px, onFloor ? uMatFA : uMatA, onFloor ? uMatFB : uMatB);
  col += uLightCol * cw * 0.3 * (1.0 - 0.6 * v);

  // Gravel: pebbles shrink towards the back line on a perspective grid.
  float t = (v - g) * H / s;
  float gEdge = clamp(t / 2.0 + 0.5, 0.0, 1.0);
  if (gEdge > 0.0) {
    const float C0 = 7.0;
    const float K = 0.045;
    float tt = max(t, 0.0);
    float cell = C0 + K * tt;
    vec2 q = vec2((px.x - 0.5 * uResolution.x) / (s * cell), log(1.0 + K * tt / C0) / (K * 0.62));
    vec3 a = pebbles(q, 0x51u);
    vec3 b = pebbles(q + vec2(0.5, 0.5), 0xa3u);
    vec3 p = a.x >= b.x ? a : b;
    float cover = max(a.x, b.x);
    vec3 stone = mix(uGravelB, uGravelA, p.z) * p.y;
    vec3 gcol = mix(uGravelB * 0.3, stone, cover);
    float depth = clamp(tt / 200.0, 0.0, 1.0);
    gcol *= 0.6 + 0.4 * smoothstep(0.0, 0.3, depth);
    gcol += uLightCol * cw * 0.45 * (0.4 + 0.6 * cover);
    col = mix(col, gcol, gEdge);
  }

  // Driftwood: tapered capsules, lit from above, with a faint grain.
  for (int i = 0; i < ${String(MAX_WOOD)}; i++) {
    vec4 w = uWoods[i];
    vec2 pa = px - w.xy;
    vec2 ba = w.zw - w.xy;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    float rad = mix(i == 0 ? uWoodR.x : uWoodR.z, i == 0 ? uWoodR.y : uWoodR.w, h) * s;
    vec2 q = pa - ba * h;
    float dist = length(q);
    float m = clamp((rad - dist) / (1.5 * s) + 0.5, 0.0, 1.0);
    if (m > 0.0) {
      vec2 n = normalize(vec2(-ba.y, ba.x));
      float side = dot(q, n) / rad * (n.y < 0.0 ? 1.0 : -1.0);
      float grain = sin(h * length(ba) / (5.0 * s) + 3.0 * sin(side * 2.0 + float(i)));
      vec3 wc = uWood * (0.75 + 0.45 * side) * (0.92 + 0.08 * grain);
      wc += uLightCol * cw * 0.25 * max(side, 0.0);
      col = mix(col, wc, m);
    }
  }

  // Rocks, half buried in the gravel.
  for (int i = 0; i < ${String(MAX_ROCKS)}; i++) {
    vec4 r = uRocks[i];
    vec2 d = (px - r.xy) / r.zw;
    if (abs(d.x) > 1.3 || abs(d.y) > 1.3) continue;
    float fi = float(i);
    float ang = atan(d.y, d.x);
    float rr = 1.0 + 0.07 * sin(3.0 * ang + fi * 1.7) + 0.04 * sin(5.0 * ang + fi * 2.9);
    float l = length(d) / rr;
    float m = clamp((1.0 - l) * min(r.z, r.w) / (1.5 * s), 0.0, 1.0);
    m *= 1.0 - smoothstep(0.1, 0.45, d.y);
    if (m > 0.0) {
      float nz = sqrt(max(0.0, 1.0 - l * l));
      vec3 nrm = normalize(vec3(d / rr, nz + 0.25));
      float lit = clamp(0.4 + 0.75 * dot(nrm, vec3(-0.32, -0.8, 0.5)), 0.15, 1.2);
      vec3 rc = uRock * (0.8 + 0.4 * fract(fi * 0.618)) * lit;
      rc += uLightCol * cw * 0.35 * max(0.0, -nrm.y);
      col = mix(col, rc, m);
    }
  }

  // The air stone: a small porous block on the gravel.
  vec2 sd = (px - uStone.xy) / uStone.zw;
  float sl = max(abs(sd.x), abs(sd.y) * 0.8) + 0.25 * length(sd);
  float sm = clamp((1.05 - sl) * uStone.w / (1.2 * s), 0.0, 1.0);
  if (sm > 0.0) {
    uint sh = hash32(uint(int(px.x / (2.0 * s))) * 0x27d4eb2du ^ uint(int(px.y / (2.0 * s))));
    float speck = float(sh & 255u) / 255.0;
    vec3 stoneCol = uRock * (0.55 + 0.25 * speck) * (1.0 - 0.3 * sd.y);
    col = mix(col, stoneCol, sm);
  }

  // Light rays from the surface, over everything in the background.
  float shaft = 0.0;
  for (int i = 0; i < ${String(RAYS.length)}; i++) {
    vec4 ry = uRays[i];
    float dr = (px.x - ry.x - ry.y * px.y) / (ry.z * (1.0 + 2.0 * v));
    shaft += ry.w * exp(-dr * dr);
  }
  col += uRayCol * shaft * 0.2 * (1.0 - 0.75 * v);
  outColor = vec4(col, 1.0);
}
`;

/**
 * One plant: a strip of PLANT_SEGMENTS + 1 vertex pairs bent by the lagged swell
 * and a static lean. The fragment shader cuts a ribbon or a leafy stem out of it.
 */
const PLANT_VERTEX = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
/** Base x (fraction of the width), base y and height (fractions of the height), half width (px at 1080p). */
layout(location = 1) in vec4 aPlant;
/** Swell phase offset, lag (s), lean (fraction of the height), kind + 0.9 tone. */
layout(location = 2) in vec4 aTraits;
uniform vec2 uResolution;
uniform float uScale;
uniform float uPhase;
/** Sway amplitude (fraction of the plant's height), edge blur (px), fog, brightness. */
uniform vec4 uLayer;
uniform vec3 uDark;
uniform vec3 uLight;
out vec2 vProf;
out float vOff;
out float vHalf;
out float vBlur;
out float vTone;
out vec3 vDark;
out vec3 vLight;
${WATER_GLSL}
${swayGlsl(AQUARIUM_SWELL, "plant")}
${TO_CLIP_GLSL}
vec2 centre(float t, float hpx) {
  float off = aTraits.z * t * t + uLayer.x * plantOffset(uPhase + aTraits.x, t, aTraits.y);
  return vec2(aPlant.x * uResolution.x + hpx * off, aPlant.y * uResolution.y - hpx * t);
}
void main() {
  float t = aCorner.x / ${f(PLANT_SEGMENTS)};
  float hpx = aPlant.z * uResolution.y;
  vec2 p = centre(t, hpx);
  vec2 q = centre(t + ${f(1 / PLANT_SEGMENTS)}, hpx);
  vec2 dir = normalize(q - p);
  vec2 across = vec2(-dir.y, dir.x);
  float env = aPlant.w * uScale * (1.0 - 0.3 * t);
  float blur = uLayer.y;
  float off = aCorner.y * (env + blur);
  gl_Position = pxToClip(p + across * off, uResolution);
  float kind = floor(aTraits.w);
  vProf = vec2(t, kind);
  vOff = off;
  vHalf = env;
  vBlur = blur;
  vTone = fract(aTraits.w) / 0.9;

  float v = clamp(p.y / uResolution.y, 0.0, 1.0);
  vec3 water = waterAt(v);
  // Lit from above, and a little variety per plant.
  float light = mix(0.5, 1.15, 1.0 - v) * mix(0.8, 1.15, vTone) * uLayer.w;
  vDark = mix(uDark * light, water, uLayer.z);
  vLight = mix(uLight * light, water, uLayer.z);
}
`;

const PLANT_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
in vec2 vProf;
in float vOff;
in float vHalf;
in float vBlur;
in float vTone;
in vec3 vDark;
in vec3 vLight;
out vec4 outColor;
const float PI = 3.14159265;
void main() {
  float t = vProf.x;
  float d = abs(vOff);
  // Derivatives up front, outside the per-kind branch.
  float dT = fwidth(t);
  float dX = fwidth(d) / max(vHalf, 0.001);
  float cover;
  vec3 col;
  if (vProf.y < 0.5) {
    // Ribbon: a long blade that twists, narrowing where it turns edge-on.
    float tw = 0.4 + 0.6 * abs(cos(t * 6.5 + vTone * 6.0));
    float hw = vHalf * tw * (1.0 - 0.85 * smoothstep(0.82, 1.0, t));
    cover = clamp((hw - d) / vBlur + 0.5, 0.0, 1.0);
    float x = d / max(hw, 0.001);
    col = mix(vDark, vLight, (0.35 + 0.55 * tw) * (1.0 - 0.5 * x * x));
  } else {
    // Stem plant: pairs of leaves rising outward from a thin stem.
    float x = d / max(vHalf, 0.001);
    float len = 0.45 + 0.55 * sin(PI * clamp(t * 1.15, 0.0, 1.0));
    float xx = x / len;
    float sl = t * 11.0 - x * 0.9 + (vOff < 0.0 ? 0.5 : 0.0);
    float k = abs(fract(sl) - 0.5);
    float lw = 0.42 * pow(max(sin(PI * clamp(xx, 0.0, 1.0)), 0.0), 0.7);
    float aa = max(11.0 * dT + 0.9 * dX, 1e-3);
    float leaf = clamp((lw - k) / aa + 0.5, 0.0, 1.0) * step(xx, 1.0) * step(0.02, t);
    float stem = clamp((1.3 * vBlur - d) / vBlur + 0.5, 0.0, 1.0);
    cover = max(leaf, stem) * (1.0 - smoothstep(0.96, 1.0, t));
    col = mix(vDark, vLight, 0.3 + 0.55 * xx + 0.3 * (0.5 - k));
    // A few red-leaved stems.
    if (vTone > 0.82) col *= vec3(1.25, 0.72, 0.62);
  }
  // Bases melt into the gravel.
  cover *= smoothstep(0.0, 0.05, t);
  outColor = vec4(col, cover);
}
`;

/**
 * A planted freshwater tank seen through the front glass: a low-res background
 * (water, back wall, gravel, hardscape, caustics, rays), two layers of swaying
 * plants, a school of procedurally drawn fish split at mid depth around the
 * air-stone bubble column.
 */
export const aquarium = defineEffect(aquariumMeta, {
  create(gl) {
    return withScope((scope) => {
      const triangle = scope.own(createFullscreenTriangle(gl));

      // Caustic tile (R8, REPEAT), re-rendered at most every TILE_INTERVAL.
      const tile = scope.own(
        createCausticTile(gl, triangle, {
          interval: TILE_INTERVAL,
          rate: CAUSTIC_RATE,
          driftA: DRIFT_A,
          driftB: DRIFT_B,
        }),
      );

      const back = scope.own(createLowResTarget(gl));
      const backProgram = scopedProgram(gl, scope, FULLSCREEN_VERTEX, BACK_FRAGMENT);
      const ub = createUniforms(gl, backProgram, [
        "uResolution",
        "uScale",
        "uTop",
        "uDeep",
        "uWall",
        "uGravelA",
        "uGravelB",
        "uRock",
        "uWood",
        "uLightCol",
        "uRayCol",
        "uRays",
        "uRocks",
        "uWoods",
        "uWoodR",
        "uStone",
        "uTile",
        "uMatA",
        "uMatB",
        "uMatFA",
        "uMatFB",
        "uOffA",
        "uOffB",
      ]);
      gl.useProgram(backProgram);
      ub.i1("uTile", 0);

      const plantProgram = scopedProgram(gl, scope, PLANT_VERTEX, PLANT_FRAGMENT);
      const up = createUniforms(gl, plantProgram, [
        "uResolution",
        "uScale",
        "uPhase",
        "uLayer",
        "uDark",
        "uLight",
        "uTop",
        "uDeep",
      ]);
      const fishProgram = scopedProgram(gl, scope, FISH_VERTEX, FISH_FRAGMENT);
      const uf = createUniforms(gl, fishProgram, ["uResolution", "uTop", "uDeep", "uFishLight"]);

      const plants = scope.own(createSpriteBatch(gl, MAX_PLANTS, [4, 4], [PLANT_STRIP]));
      const fishBatch = scope.own(createSpriteBatch(gl, MAX_FISH, [4, 4]));
      // Per bubble: x, y, semi-major, opacity; softness, extent; then the spin pair.
      const bubbleBatch = scope.own(
        createSpriteBatch(gl, AIRSTONE_BUBBLES, [4, 2], [polygonStrip(8, Math.PI / 8)], {
          rotation: true,
        }),
      );
      const bubbleProgram = scopedProgram(
        gl,
        scope,
        bubbleVertex(bubbleBatch.spinLocation),
        BUBBLE_FRAGMENT,
      );
      const uBub = createUniforms(gl, bubbleProgram, ["uResolution", "uLight", "uShade"]);
      gl.useProgram(null);

      const matA = new Float32Array(4);
      const matB = new Float32Array(4);
      const matFA = new Float32Array(4);
      const matFB = new Float32Array(4);
      const rays = new Float32Array(RAYS.length * 4);
      const rocks = new Float32Array(MAX_ROCKS * 4);
      const woods = new Float32Array(MAX_WOOD * 4);
      const shade: [number, number, number] = [0, 0, 0];

      let width = 1;
      let height = 1;
      let scale = 1;
      let refWidth = 1920;
      /** Bumped when the static uniforms (matrices, hardscape) change. */
      let statics = 0;
      let backStatics = -1;
      /** CPU-only clock for the rays' sway, unwrapped in float64. */
      let clock = 0;
      /** Plant swell phase (0..1 over AQUARIUM_SWELL.period). */
      let phase = 0;

      let hardscape: Hardscape | null = null;
      let layout: PlantLayout = { backCount: 0, frontCount: 0 };
      let builtSeed = Number.NaN;
      let builtPlants = Number.NaN;
      let fish = createFishSim(0, MAX_FISH);
      let fishSeed = Number.NaN;
      const env: FishEnv = { aspect: 16 / 9, count: 0, species: "mixed", speed: 1 };

      const bubbles = createBubbles(AIRSTONE_BUBBLES, refWidth, 0xa1a);
      const bf: BubbleFrame = {
        refWidth,
        scale: 1,
        mode: AIRSTONE_MODE,
        count: AIRSTONE_BUBBLES,
        size: AIRSTONE_SIZE,
        speed: 1,
        streams: true,
      };
      /** Air-stone column fade, 0..1. */
      let bubbleFade = 1;

      const ensureTile = (res: number) => {
        if (!tile.resize(res)) {
          throw new Error("Aquarium: R8 tile is not renderable");
        }
      };

      const updateStatics = () => {
        const tilePx = TILE_REF_PX * scale;
        ensureTile(tileResolution(tilePx));
        tileMatrices(tilePx, false, matA, matB);
        tileMatrices(tilePx * FLOOR_TILE_SCALE, true, matFA, matFB);
        if (hardscape) {
          const h = hardscape;
          for (let i = 0; i < MAX_ROCKS; i++) {
            rocks[i * 4] = h.rocks[i * 4] * width;
            rocks[i * 4 + 1] = h.rocks[i * 4 + 1] * height;
            rocks[i * 4 + 2] = h.rocks[i * 4 + 2] * scale;
            rocks[i * 4 + 3] = h.rocks[i * 4 + 3] * scale;
          }
          for (let i = 0; i < MAX_WOOD; i++) {
            woods[i * 4] = h.wood[i * 4] * width;
            woods[i * 4 + 1] = h.wood[i * 4 + 1] * height;
            woods[i * 4 + 2] = h.wood[i * 4 + 2] * width;
            woods[i * 4 + 3] = h.wood[i * 4 + 3] * height;
          }
        }
        statics++;
      };

      const drawPlants = (
        first: number,
        count: number,
        L: readonly number[],
        light: AquariumLight,
      ) => {
        if (count <= 0) {
          return;
        }
        gl.useProgram(plantProgram);
        up.f2("uResolution", width, height);
        up.f1("uScale", scale);
        up.f1("uPhase", phase);
        up.f4("uLayer", PLANT_SWAY * L[0], L[1] * scale, L[2], L[3]);
        up.v3("uDark", light.plantDark);
        up.v3("uLight", light.plantLight);
        up.v3("uTop", light.top);
        up.v3("uDeep", light.deep);
        plants.draw(first, count);
      };
      const drawFish = (first: number, count: number, light: AquariumLight) => {
        if (count <= 0) {
          return;
        }
        gl.useProgram(fishProgram);
        uf.f2("uResolution", width, height);
        uf.v3("uTop", light.top);
        uf.v3("uDeep", light.deep);
        uf.f2("uFishLight", light.fishLight, light.stripeGlow);
        fishBatch.draw(first, count);
      };

      return {
        resize(v) {
          const newRefWidth = v.width / v.scale;
          bubbles.rescaleX(newRefWidth / refWidth);
          ({ width, height, scale } = v);
          refWidth = bf.refWidth = newRefWidth;
          bf.scale = scale;
          updateStatics();
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
          const speed = Math.max(0, p.speed);
          const sdt = step * speed;
          clock += sdt;
          phase = advanceSwell(AQUARIUM_SWELL, phase, step, speed);
          const light = lookup(LIGHTS, p.light, "daylight");
          const aspect = width / Math.max(1, height);

          if (p.seed !== builtSeed) {
            hardscape = buildHardscape(p.seed);
            updateStatics();
          }
          if (p.seed !== builtSeed || p.plants !== builtPlants) {
            layout = buildPlants(p.seed, p.plants, plants.data);
            plants.upload(layout.backCount + layout.frontCount);
            builtSeed = p.seed;
            builtPlants = p.plants;
          }
          if (p.seed !== fishSeed) {
            fish = createFishSim(p.seed, MAX_FISH, aspect);
            fishSeed = p.seed;
          }

          // 1. Caustic tile.
          tile.advance(sdt);
          tile.update(step, sdt > 0);

          // 2. Background, at reduced resolution.
          back.resize(width, height, qualityDivisor(p.quality, BACK_DIVISORS));
          back.bind();
          gl.useProgram(backProgram);
          if (backStatics !== statics) {
            backStatics = statics;
            const loc = ub.loc;
            gl.uniformMatrix2fv(loc.uMatA, false, matA);
            gl.uniformMatrix2fv(loc.uMatB, false, matB);
            gl.uniformMatrix2fv(loc.uMatFA, false, matFA);
            gl.uniformMatrix2fv(loc.uMatFB, false, matFB);
            gl.uniform4fv(loc.uRocks, rocks);
            gl.uniform4fv(loc.uWoods, woods);
          }
          if (hardscape) {
            const r = hardscape.woodRadius;
            ub.f4("uWoodR", r[0], r[1], r[2], r[3]);
          }
          ub.f4(
            "uStone",
            AIRSTONE_X * width,
            airstoneY() * height,
            AIRSTONE_RX * scale,
            AIRSTONE_RY * scale,
          );
          for (let i = 0; i < RAYS.length; i++) {
            const R = RAYS[i];
            const sway = RAY_SWAY * Math.sin(clock * 0.11 + i * 1.9);
            const o = i * 4;
            rays[o] = (R[0] + sway) * width;
            rays[o + 1] = RAY_SLOPE + sway;
            rays[o + 2] = R[1] * scale;
            rays[o + 3] = R[2] * (0.8 + 0.2 * Math.sin(clock * 0.27 + i * 2.3));
          }
          gl.uniform4fv(ub.loc.uRays, rays);
          ub.f2("uResolution", width, height);
          ub.f1("uScale", scale);
          ub.v3("uTop", light.top);
          ub.v3("uDeep", light.deep);
          ub.v3("uWall", light.wall);
          ub.v3("uGravelA", light.gravelA);
          ub.v3("uGravelB", light.gravelB);
          ub.v3("uRock", light.rock);
          ub.v3("uWood", light.wood);
          const lc = light.light;
          ub.f3(
            "uLightCol",
            lc[0] * light.caustics,
            lc[1] * light.caustics,
            lc[2] * light.caustics,
          );
          ub.f3("uRayCol", lc[0] * light.rays, lc[1] * light.rays, lc[2] * light.rays);
          const off = tile.offsets;
          ub.f2("uOffA", off[0], off[1]);
          ub.f2("uOffB", off[2], off[3]);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tile.texture);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          back.blit();
          gl.viewport(0, 0, width, height);

          // 3. Simulation.
          env.aspect = aspect;
          env.count = p.fish;
          // Any species the sim doesn't know mixes them, as "mixed" does.
          env.species = isSpeciesId(p.species) ? p.species : "mixed";
          env.speed = speed;
          stepFishSim(fish, step, env);
          const fishCount = fishInstances(fish, env, fishBatch.data, fishBatch.stride);
          fishBatch.upload(fishCount);
          const farFish = fish.farCount;

          bubbleFade = Math.max(
            0,
            Math.min(1, bubbleFade + (p.bubbles ? 1 : -1) * (step / BUBBLE_FADE)),
          );
          let bubbleCount = 0;
          if (bubbleFade > 0) {
            bf.speed = speed;
            bubbleCount = bubbles.step(step, bf, bubbleBatch.data, bubbleBatch.stride);
            if (bubbleFade < 1) {
              const d = bubbleBatch.data;
              for (let k = 0; k < bubbleCount; k++) {
                d[k * bubbleBatch.stride + 3] *= bubbleFade;
              }
            }
            bubbleBatch.upload(bubbleCount);
          }

          // 4. Back plants, far fish, bubbles, near fish, front plants.
          gl.enable(gl.BLEND);
          gl.blendEquation(gl.FUNC_ADD);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          drawPlants(0, layout.backCount, BACK_LAYER, light);
          drawFish(0, farFish, light);
          if (bubbleCount > 0) {
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
            gl.useProgram(bubbleProgram);
            uBub.f2("uResolution", width, height);
            uBub.v3("uLight", light.bubble);
            shade[0] = light.deep[0] * 0.3;
            shade[1] = light.deep[1] * 0.3;
            shade[2] = light.deep[2] * 0.3;
            uBub.v3("uShade", shade);
            bubbleBatch.draw(0, bubbleCount);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          }
          drawFish(farFish, fishCount - farFish, light);
          drawPlants(layout.backCount, layout.frontCount, FRONT_LAYER, light);
          gl.disable(gl.BLEND);
        },
        dispose: () => {
          scope.dispose();
        },
      };
    });
  },
});
