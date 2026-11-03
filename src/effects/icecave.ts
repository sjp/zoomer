import { tileFragment } from "./caustics";
import { advancePhases, CAUSTIC_RATES } from "./caustics-sim";
import { hexToUnitRgb, type Rgb } from "./color";
import {
  beginFrame,
  createDataTexture,
  createFullscreenTriangle,
  createProgram,
  createRenderTarget,
  createUniforms,
  FULLSCREEN_VERTEX,
  glslFloat,
  withScope,
} from "./gl";
import {
  CELLS_ALONG,
  CELLS_AROUND,
  createDrips,
  createIcicles,
  DROP_R,
  dropFall,
  dropSpeed,
  dropSwell,
  ELLIPSE,
  FOCAL,
  GRID_ORIGIN,
  ICICLES,
  type Icicle,
  JITTER,
  mouth,
  palette,
  stepDrips,
  THICK_BAND,
  THICK_BASE,
  THICK_DISH,
  THICK_NOISE,
  Z_END,
  Z_MAX,
} from "./icecave-sim";
import { icecaveMeta } from "./icecave.meta";
import { createLowResTarget, qualityDivisor } from "./lowres";
import { wrap } from "./math";
import { buildPeriodicNoiseTexture, createRng, HASH32_GLSL } from "./noise";
import { createStreakRenderer, STREAK_FLOATS } from "./streaks";
import { defineEffect } from "./types";
import { VORONOI_GLSL } from "./voronoi";

/** Noise texture texels per side. */
const TEX_SIZE = 128;
/**
 * Channels (lattice cells per tile): R the ice thickness, G the warp of the dark
 * bands, B the floor grit, A the trapped bubbles.
 */
const NOISE_CHANNELS = [
  { period: 4, seed: 970 },
  { period: 4, seed: 971 },
  { period: 16, seed: 972 },
  { period: 32, seed: 973 },
];
/** Noise tiles once around the tunnel (an integer, so the wrap is seamless), and wall units per tile along it. */
const NOISE_AROUND = 2;
const NOISE_ALONG = 3.6;
/** Bubble noise: tiles per noise tile, and the A-channel threshold where specks appear. */
const BUBBLE_SCALE = 3;
const BUBBLE_EDGE = [0.76, 0.88] as const;
/** Dark bands: phase (radians) per tunnel radius of height, and how far the G noise bends them (radians). */
const BAND_FREQ = 5;
const BAND_WARP = 7;

/** Scallop ridges: core half width and halo length (cells), and their brightness. */
const RIDGE_W = 0.025;
const RIDGE_HALO = 0.07;
const RIDGE_GAIN = 0.15;
/** Mean ridge light over the scallops, which the far ground fades to: 2 * density * (core + halo) areas. */
const RIDGE_MEAN = 2 * 2 * (0.6 * 2 * RIDGE_W + 0.4 * 2 * RIDGE_HALO);
/** Dish depth from the squared distance to the seed, and its mean over a cell. */
const DISH_K = 2.2;
const DISH_MEAN = 0.62;
/** Directional shading of a dish: the near side faces the mouth's light. */
const SHADE = 0.8;
/** Footprint (cells per pixel) over which the scallops fade to their average. */
const FAR_FADE = [0.3, 0.7] as const;
/** Floor: the part of the cross-section below this "down-ness" (-cos of the angle) blends to floor. */
const FLOOR_EDGE = [0.55, 0.8] as const;
/** Daylight: spill on the walls near the mouth (per radius of depth), its gain, and the bloom around the opening. */
const SPILL_FALL = 0.45;
const SPILL = 0.4;
const BLOOM = 0.3;
const BLOOM_R = 0.12;

/** Caustic tile: iterations, texels, tiles around the tunnel and per wall unit along it. */
const CAUSTIC_ITERATIONS = 3;
const CAUSTIC_RATES_3 = CAUSTIC_RATES.slice(0, CAUSTIC_ITERATIONS);
const CAUSTIC_TILE = 256;
const CAUSTIC_AROUND = 2;
const CAUSTIC_ALONG = 0.35;
/** Caustic strength, its average (the far walls fade to it), morph rate and drift (tiles per second). */
const CAUSTIC = 0.3;
const CAUSTIC_MEAN = 0.1;
const CAUSTIC_RATE = 0.1;
const CAUSTIC_DRIFT: readonly [number, number] = [0.003, -0.006];
/** The tile is re-rendered at most this often; the slow morph hides 30 Hz updates. */
const CAUSTIC_INTERVAL = 1 / 30;

/** Icicle streaks: nested segments (from, to as fractions of the length; half width factor; brightness). */
const ICICLE_SEGMENTS: readonly (readonly [number, number, number, number])[] = [
  [0, 0.5, 1, 0.55],
  [0.4, 0.82, 0.6, 0.62],
  [0.75, 1, 0.3, 0.7],
  [0, 0.9, 0.3, 1],
];
/** Icicle brightness, and the shutter time that blurs a falling drop (s). */
const ICICLE_GAIN = 0.5;
const DROP_BLUR = 1 / 90;
/** A drop ends once it has fallen this far (reference px): always past the bottom edge. */
const DROP_FALL = 1100;

const TAU = Math.PI * 2;
const f = glslFloat;

/**
 * The cave, at reduced resolution: map the pixel onto the tunnel wall, then one
 * jittered-Voronoi lookup for the scallops (skipped on the floor and where cells
 * shrink toward a pixel), two noise fetches (thickness, bands and grit; bubbles)
 * and one caustic tile fetch. Translucency is exp(-thickness).
 */
const CAVE_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision mediump sampler2D;
uniform sampler2D uNoise;
uniform sampler2D uTile;
/** 1 / height px, -0.5 * width / height. */
uniform vec2 uScreen;
/** Vanishing point (frame heights from the centre, from the top), seed offsets (cells along, noise tiles). */
uniform vec4 uMouth;
/** Caustic drift (tiles), glow (0..1). */
uniform vec3 uLight;
uniform vec3 uDeep;
uniform vec3 uMid;
uniform vec3 uThin;
uniform vec3 uDay;
out vec4 outColor;
${HASH32_GLSL}
/** Scallop seeds: a jitter in a disc (seedOffset in icecave-sim.ts). */
vec2 voronoiOffset(uint h) {
  vec2 b = vec2(uvec2(h, h >> 8) & 255u) * ${f(2 / 255)} - 1.0;
  return ${f(JITTER)} * b * sqrt(1.0 - 0.5 * b.yx * b.yx);
}
${VORONOI_GLSL}
void main() {
  vec2 frag = gl_FragCoord.xy;
  float px = uScreen.x;
  vec2 q = vec2((frag.x * px + uScreen.y - uMouth.x) * ${f(1 / ELLIPSE)}, uMouth.y - (1.0 - frag.y * px));
  float r = max(length(q), ${f(FOCAL / Z_MAX)});
  float z = ${f(FOCAL)} / r;
  // Turns around the axis: 0 at the ceiling, +-0.5 on the floor centre line.
  float a = atan(-q.x, q.y + 1e-7) * ${f(1 / TAU)};
  float down = -cos(a * ${f(TAU)});
  float glow = uLight.z;

  // Pixel footprint on the wall: along z (dz = z^2 dr / F) and around.
  float alongU = z * z * ${f(1 / FOCAL)} * px;
  float aroundT = px / (r * ${f(TAU)});
  vec2 fpCells = vec2(aroundT * ${f(CELLS_AROUND)}, alongU * ${f(CELLS_ALONG)});
  float lod = log2(max(max(aroundT * ${f(NOISE_AROUND * TEX_SIZE)}, alongU * ${f(TEX_SIZE / NOISE_ALONG)}), 1e-4));
  vec2 nUv = vec2(a * ${f(NOISE_AROUND)}, z * ${f(1 / NOISE_ALONG)} + uMouth.w);
  vec4 n = textureLod(uNoise, nUv, lod);

  // Scallops: soft dishes with sharp rims, shaded from the mouth.
  float floorW = smoothstep(${f(FLOOR_EDGE[0])}, ${f(FLOOR_EDGE[1])}, down);
  float far = smoothstep(${f(FAR_FADE[0])}, ${f(FAR_FADE[1])}, max(fpCells.x, fpCells.y));
  float dish = ${f(DISH_MEAN)};
  float ridge = ${f(RIDGE_MEAN)};
  float shade = 1.0;
  float cell = 0.5;
  if (far < 1.0 && floorW < 1.0) {
    vec2 g = vec2(a * ${f(CELLS_AROUND)} + ${f(GRID_ORIGIN)}, z * ${f(CELLS_ALONG)} + uMouth.z);
    VoronoiCell v = voronoiCell(g);
    float fp = max(length(v.normal * fpCells), 1e-4);
    float e = v.edge;
    float cov = clamp((min(e + 0.5 * fp, ${f(RIDGE_W)}) - max(e - 0.5 * fp, ${f(-RIDGE_W)})) / fp, 0.0, 1.0);
    float se = sqrt(${f(RIDGE_HALO * RIDGE_HALO)} + 0.25 * fp * fp);
    float halo = (${f(RIDGE_HALO)} / se) * exp(-e / se);
    dish = mix(1.0 - min(v.f1 * ${f(DISH_K)}, 1.0), dish, far);
    ridge = mix(0.6 * cov + 0.4 * halo, ridge, far);
    shade = mix(1.0 - ${f(SHADE)} * (g.y - v.seed.y), 1.0, far);
    cell = mix(float(v.hash >> 24) * ${f(1 / 255)}, 0.5, far);
  }

  // Translucency: thin ice glows, thick ice and the dark bands are deep blue.
  float band = smoothstep(0.2, 0.9, sin(down * ${f(BAND_FREQ)} + (n.g - 0.5) * ${f(BAND_WARP)} + z * 0.2));
  float thick = max(${f(THICK_BASE)} + ${f(THICK_NOISE)} * smoothstep(0.25, 0.75, n.r)
    + ${f(THICK_BAND)} * band - ${f(THICK_DISH)} * dish + 0.5 * (cell - 0.5), 0.0);
  float tr = exp(-thick);
  float lit = tr * (0.35 + 0.65 * glow);
  vec3 col = lit < 0.5 ? mix(uDeep, uMid, lit * 2.0) : mix(uMid, uThin, lit * 2.0 - 1.0);
  col *= (0.45 + 0.55 * glow) * shade;
  col += uThin * (${f(RIDGE_GAIN)} * ridge * (0.3 + 0.7 * tr) * (0.3 + 0.7 * glow));

  // Bubbles trapped in the ice: small pale specks, averaging away with distance.
  float bub = textureLod(uNoise, nUv * ${f(BUBBLE_SCALE)} + vec2(0.37, 0.71), lod + ${f(Math.log2(BUBBLE_SCALE))}).a;
  col += uThin * (0.35 * smoothstep(${f(BUBBLE_EDGE[0])}, ${f(BUBBLE_EDGE[1])}, bub) * (0.3 + 0.7 * tr));

  // Caustic ripples of light through the ice, at low strength.
  vec2 cUv = vec2(a * ${f(CAUSTIC_AROUND)}, z * ${f(CAUSTIC_ALONG)}) + uLight.xy;
  float texels = max(aroundT * ${f(CAUSTIC_AROUND * CAUSTIC_TILE)}, alongU * ${f(CAUSTIC_ALONG * CAUSTIC_TILE)});
  float c = mix(textureLod(uTile, cUv, 0.0).r, ${f(CAUSTIC_MEAN)}, smoothstep(0.6, 1.6, texels));
  col += uThin * (${f(CAUSTIC)} * c * glow * (0.25 + tr));

  // Floor: dark wet grit, faintly lit.
  vec3 ground = mix(uDeep, uMid, 0.15 + 0.3 * n.b) * (0.55 + 0.35 * glow);
  col = mix(col, ground, floorW);

  // Daylight: spill on the walls near the mouth, the opening itself and its bloom.
  float rEnd = ${f(FOCAL / Z_END)};
  col += uDay * (${f(SPILL)} * exp(-max(${f(Z_END)} - z, 0.0) * ${f(SPILL_FALL)}));
  col = mix(col, uDay, smoothstep(${f(Z_END * 0.9)}, ${f(Z_END * 1.08)}, z));
  col += uDay * (${f(BLOOM)} * exp(-max(r - rEnd, 0.0) * ${f(1 / BLOOM_R)}));
  outColor = vec4(col, 1.0);
}
`;

/** Writes a streak from (x0, y0) to (x1, y1) in device px into `d` at index `i`. */
function putStreak(
  d: Float32Array,
  i: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  c: Rgb,
  k: number,
  halfW: number,
): void {
  const o = i * STREAK_FLOATS;
  d[o] = x0;
  d[o + 1] = y0;
  d[o + 2] = x1;
  d[o + 3] = y1;
  d[o + 4] = c[0] * k;
  d[o + 5] = c[1] * k;
  d[o + 6] = c[2] * k;
  d[o + 7] = halfW;
}

/**
 * Ice cave: the view along a glacier tunnel of translucent blue ice, its walls
 * scalloped into shallow dishes, glowing where the ice is thin, with slow caustic
 * ripples and a bright mouth. One reduced-resolution pass, then the icicles and
 * their drips as full-resolution streaks.
 */
export const icecave = defineEffect(icecaveMeta, {
  create(gl) {
    return withScope((scope) => {
      const program = scope.add(createProgram(gl, FULLSCREEN_VERTEX, CAVE_FRAGMENT), (p) =>
        gl.deleteProgram(p),
      );
      const u = createUniforms(gl, program, [
        "uNoise",
        "uTile",
        "uScreen",
        "uMouth",
        "uLight",
        "uDeep",
        "uMid",
        "uThin",
        "uDay",
      ]);
      gl.useProgram(program);
      u.i1("uNoise", 0);
      u.i1("uTile", 1);

      const tileProgram = scope.add(
        createProgram(gl, FULLSCREEN_VERTEX, tileFragment(CAUSTIC_ITERATIONS)),
        (p) => gl.deleteProgram(p),
      );
      const uT = gl.getUniformLocation(tileProgram, "uT");
      const tile = createRenderTarget(gl, CAUSTIC_TILE, CAUSTIC_TILE, gl.R8, { wrap: gl.REPEAT });
      if (!tile) throw new Error("Ice cave: R8 caustic tile is not renderable");
      scope.own(tile);
      const phases = new Float32Array(CAUSTIC_ITERATIONS);
      let tileAge = Infinity;

      const triangle = scope.own(createFullscreenTriangle(gl));
      const target = scope.own(createLowResTarget(gl));
      const noiseTex = scope.add(
        createDataTexture(gl, {
          width: TEX_SIZE,
          height: TEX_SIZE,
          internalFormat: gl.RGBA8,
          format: gl.RGBA,
          type: gl.UNSIGNED_BYTE,
          data: buildPeriodicNoiseTexture(TEX_SIZE, NOISE_CHANNELS),
          wrap: gl.REPEAT,
        }),
        (t) => gl.deleteTexture(t),
      );
      // Mipmaps keep the far walls' noise from aliasing; the shader picks the level.
      gl.bindTexture(gl.TEXTURE_2D, noiseTex);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.bindTexture(gl.TEXTURE_2D, null);

      const streaks = scope.own(
        createStreakRenderer(gl, (ICICLE_SEGMENTS.length + 1) * ICICLES, { blend: "max" }),
      );

      let seed = Number.NaN;
      let icicles: Icicle[] = [];
      let drips = createDrips(0, Math.random);
      let rng = createRng(0);
      let paletteName = "";
      let pal = palette("");
      let thin: Rgb = [0, 0, 0];
      const dropColor: Rgb = [0, 0, 0];
      let width = 1;
      let height = 1;
      let scale = 1;
      let causticX = 0;
      let causticY = 0;

      return {
        resize(v) {
          width = Math.max(1, v.width);
          height = Math.max(1, v.height);
          scale = v.scale > 0 ? v.scale : height / 1080;
        },
        frame(dt, p) {
          beginFrame(gl, width, height);
          const s = Number.isFinite(p.seed) ? Math.round(p.seed) : 0;
          if (s !== seed) {
            seed = s;
            rng = createRng(seed * 7919 + 97);
            icicles = createIcicles(rng);
            drips = createDrips(icicles.length, rng);
          }
          if (p.colour !== paletteName) {
            paletteName = p.colour;
            pal = palette(p.colour);
            thin = hexToUnitRgb(pal.thin);
            for (let k = 0; k < 3; k++) dropColor[k] = 0.4 * thin[k] + 0.6;
          }
          const glow = Number.isFinite(p.glow) ? Math.min(Math.max(p.glow, 0), 1) : 0;
          const m = mouth(p.mouth);
          stepDrips(drips, dt, p.drips, DROP_FALL, rng);

          // 1. Caustic tile, at most every CAUSTIC_INTERVAL.
          advancePhases(phases, dt * CAUSTIC_RATE, CAUSTIC_RATES_3);
          causticX = wrap(causticX + CAUSTIC_DRIFT[0] * dt, 0, 1);
          causticY = wrap(causticY + CAUSTIC_DRIFT[1] * dt, 0, 1);
          tileAge += dt;
          if (glow > 0 && tileAge >= CAUSTIC_INTERVAL * 0.9) {
            tileAge = 0;
            tile.bind();
            gl.useProgram(tileProgram);
            gl.uniform1fv(uT, phases);
            triangle.draw();
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          }

          // 2. The cave, at reduced resolution.
          target.resize(width, height, qualityDivisor(p.quality));
          target.bind();
          gl.useProgram(program);
          const lh = target.height;
          u.f2("uScreen", 1 / lh, (-0.5 * target.width) / lh);
          // Seed: shift the scallops along the tunnel by whole cells, and the noise by part of a tile.
          u.f4("uMouth", m.x, m.y, (s % 1000) * 7, (s * 0.618034) % 1);
          u.f3("uLight", causticX, causticY, glow);
          u.rgb("uDeep", pal.deep);
          u.rgb("uMid", pal.mid);
          u.rgb("uThin", pal.thin);
          u.rgb("uDay", pal.day);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, tile.texture);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, noiseTex);
          triangle.draw();
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          target.blit();
          gl.viewport(0, 0, width, height);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, null);

          // 3. Icicles and drips, full resolution.
          const d = streaks.data;
          const ik = ICICLE_GAIN * (0.4 + 0.6 * glow);
          const top = -4 * scale;
          let n = 0;
          for (let i = 0; i < icicles.length; i++) {
            const ic = icicles[i];
            const x = ic.x * width;
            const len = ic.tip * scale - top;
            for (let j = 0; j < ICICLE_SEGMENTS.length; j++) {
              const sg = ICICLE_SEGMENTS[j];
              const hw = ic.width * sg[2] * scale;
              const y1 = top + len * sg[1] - hw;
              putStreak(d, n++, x, top + len * sg[0], x, y1, thin, ik * sg[3] * ic.glow, hw);
            }
            const age = drips.age[i];
            if (age < 0) continue;
            const tip = ic.tip * scale;
            const sw = dropSwell(age);
            const fall = dropFall(age) * scale;
            const r = DROP_R * scale * (0.5 + 0.5 * sw);
            // A small glint as the drop swells and lets go, then a short motion-blurred streak.
            const head = tip + r + fall;
            const tail = head - dropSpeed(age) * DROP_BLUR * scale;
            putStreak(d, n++, x, tail, x, head, dropColor, 0.35 + 0.6 * sw * sw, r);
          }
          streaks.upload(n);
          streaks.draw(n, width, height);
        },
        dispose: () => scope.dispose(),
      };
    });
  },
});
