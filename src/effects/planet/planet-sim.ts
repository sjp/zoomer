/**
 * Pure JS side of the Planet effect: world presets, the equirectangular surface
 * and cloud texture builders, framing, the sun and axis tilt, rotation phases and
 * a JS twin of the shader's ray-sphere hit.
 *
 * Texture space: u in [0, 1) is longitude (east positive, wrapping), v in [0, 1]
 * is latitude from the south pole (row 0) to the north pole. A texel's sphere
 * point is `spherePoint(u, v)`: x = cos(lat) sin(lon), y = sin(lat),
 * z = cos(lat) cos(lon), so the shader recovers u = atan(x, z) / 2pi and
 * v = asin(y) / pi + 0.5. Every field is 3D noise sampled at that point, so the
 * textures wrap seamlessly in longitude and nothing pinches at the poles.
 *
 * Building is the expensive part (simplex noise costs ~20 ns a call in V8), so
 * the low octaves are evaluated on a grid a quarter of the size in each
 * direction and bilinearly upsampled; only the last two octaves run per texel.
 */
import { finishBuild, type BuildSteps } from "../rebuild";
import { clamp, fract, smoothstep } from "../math";
import { createNoise, fbm3, hash32, type Noise } from "../noise";
import { WORLD_OPTIONS } from "./planet.meta";

// ---------------------------------------------------------------------------
// Presets and options
// ---------------------------------------------------------------------------

type WorldId = (typeof WORLD_OPTIONS)[number]["value"];

/**
 * The framing's anchor: which side of the frame the planet sits beyond, as
 * (x, y) in {-1, 0, 1} (y up). (0, 0) is the full disc; unknown framings fall
 * back to bottom left.
 */
export function framingAnchor(framing: string): readonly [number, number] {
  switch (framing) {
    case "full":
      return [0, 0];
    case "bottom":
      return [0, -1];
    case "bottomRight":
      return [1, -1];
    case "left":
      return [-1, 0];
    case "right":
      return [1, 0];
    case "topLeft":
      return [-1, 1];
    case "top":
      return [0, 1];
    case "topRight":
      return [1, 1];
    default:
      return [-1, -1];
  }
}

/** Per-world shading constants: everything the shader needs besides the textures. */
interface WorldStyle {
  /** Scales the `clouds` param; 0 skips the cloud layer (and its build). */
  clouds: number;
  /** Scales the `cities` param; 0 for worlds without city lights. */
  cities: number;
  /** Strength of the specular glint on texels marked glossy (oceans, ice). */
  specular: number;
  /** Atmosphere rim colour on the day side and at the terminator (linear 0..1, gain included). */
  atmoDay: readonly [number, number, number];
  atmoSet: readonly [number, number, number];
}

export const WORLDS: Readonly<Record<WorldId, WorldStyle>> = {
  earth: {
    clouds: 1,
    cities: 1,
    specular: 0.55,
    atmoDay: [0.3, 0.55, 1.0],
    atmoSet: [1.0, 0.42, 0.18],
  },
  ice: {
    clouds: 0,
    cities: 0,
    specular: 0.25,
    atmoDay: [0.16, 0.24, 0.34],
    atmoSet: [0.3, 0.22, 0.2],
  },
  desert: {
    clouds: 0.4,
    cities: 0.5,
    specular: 0,
    atmoDay: [0.75, 0.55, 0.38],
    atmoSet: [0.9, 0.38, 0.16],
  },
  gas: {
    clouds: 0,
    cities: 0,
    specular: 0,
    atmoDay: [0.55, 0.62, 0.78],
    atmoSet: [0.8, 0.45, 0.25],
  },
};

const isWorldId = (v: string): v is WorldId => Object.hasOwn(WORLDS, v);

export function worldStyle(world: string): WorldStyle {
  return isWorldId(world) ? WORLDS[world] : WORLDS.earth;
}

// ---------------------------------------------------------------------------
// Texture builders
// ---------------------------------------------------------------------------

/** Surface texture: RGB albedo, A = material (see `materialByte`). */
export const SURFACE_W = 1024;
export const SURFACE_H = 512;
/** Cloud texture: R = cover, G = cover one shift east, B = one shift west, A unused. */
export const CLOUD_W = 512;
export const CLOUD_H = 256;
/** Low octaves are evaluated on a grid this many times coarser in each direction. */
const COARSE = 4;
/**
 * The detail octaves are evaluated on a grid this many times coarser. Thresholds
 * (coastlines, cracks) are still applied per texel to the upsampled field, so
 * they stay crisp; only the finest noise wavelengths are lost.
 */
const MID = 2;
/** Texels between a cloud and its shadow sample (G and B channels): about 1.4 degrees. */
export const SHADOW_SHIFT = 2;

/**
 * The surface alpha encodes material: below 0.5 is glossy (oceans, ice), with
 * no city lights; from 0.5 up is matte land, and `(a - 0.5) * 2` is its city-light
 * density. Bilinear filtering across a coast blends the two sensibly.
 */
const GLOSSY = 0;
export function materialByte(city: number): number {
  return Math.round(127.5 + 127.5 * clamp(city, 0, 1));
}

const TAU = Math.PI * 2;

/** Sphere point of texture coordinates `(u, v)`, written to `out`. */
export function spherePoint(u: number, v: number, out: Float64Array): Float64Array {
  const lon = u * TAU;
  const lat = (v - 0.5) * Math.PI;
  const c = Math.cos(lat);
  out[0] = c * Math.sin(lon);
  out[1] = Math.sin(lat);
  out[2] = c * Math.cos(lon);
  return out;
}

/**
 * Texture coordinates of a unit sphere point, written to `out`: the planet
 * shader's `u` and `v` (from `atan(B.x, B.z)` and `asin(B.y)` in `planet.ts`).
 * Change the two together.
 */
export function sphereUv(x: number, y: number, z: number, out: Float64Array): Float64Array {
  out[0] = fract(Math.atan2(x, z) / TAU);
  out[1] = Math.asin(clamp(y, -1, 1)) / Math.PI + 0.5;
  return out;
}

/**
 * A coarse grid of `channels` values per cell over the whole sphere, filled by
 * `fill(x, y, z, out, offset)` at each cell centre, for bilinear upsampling with
 * `sampleCoarse`.
 */
interface CoarseGrid {
  width: number;
  height: number;
  channels: number;
  data: Float32Array;
}

function* buildCoarse(
  width: number,
  height: number,
  channels: number,
  fill: (x: number, y: number, z: number, out: Float32Array, o: number) => void,
): BuildSteps<CoarseGrid> {
  const data = new Float32Array(width * height * channels);
  const p = new Float64Array(3);
  for (let j = 0; j < height; j++) {
    yield;
    for (let i = 0; i < width; i++) {
      spherePoint((i + 0.5) / width, (j + 0.5) / height, p);
      fill(p[0], p[1], p[2], data, (j * width + i) * channels);
    }
  }
  return { width, height, channels, data };
}

/**
 * Per-texel bilinear weights into a coarse grid for a fine grid `factor` times
 * larger: wrapping in x, clamped in y. Indices are pre-multiplied by `channels`.
 */
interface Lerp {
  i0: Int32Array;
  i1: Int32Array;
  t: Float32Array;
}

function lerpTable(fine: number, coarse: number, wrapAround: boolean, stride: number): Lerp {
  const i0 = new Int32Array(fine);
  const i1 = new Int32Array(fine);
  const t = new Float32Array(fine);
  for (let x = 0; x < fine; x++) {
    const f = ((x + 0.5) / fine) * coarse - 0.5;
    let a = Math.floor(f);
    let w = f - a;
    let b = a + 1;
    if (wrapAround) {
      a = (a + coarse) % coarse;
      b = b % coarse;
    } else {
      if (a < 0) {
        a = 0;
        w = 0;
      }
      if (b > coarse - 1) {
        b = coarse - 1;
      }
    }
    i0[x] = a * stride;
    i1[x] = b * stride;
    t[x] = w;
  }
  return { i0, i1, t };
}

/**
 * Bilinearly upsamples fine row `y` of every channel of `g` into
 * `rows[first + c]` (one array of fine-row width per channel).
 */
function upsampleRow(
  g: CoarseGrid,
  lx: Lerp,
  ly: Lerp,
  y: number,
  rows: Float32Array[],
  first: number,
): void {
  const d = g.data;
  const r0 = ly.i0[y];
  const r1 = ly.i1[y];
  const ty = ly.t[y];
  const n = lx.t.length;
  for (let c = 0; c < g.channels; c++) {
    const row = rows[first + c];
    for (let x = 0; x < n; x++) {
      const a = lx.i0[x] + c;
      const b = lx.i1[x] + c;
      const tx = lx.t[x];
      const top = d[r0 + a] + (d[r0 + b] - d[r0 + a]) * tx;
      const bot = d[r1 + a] + (d[r1 + b] - d[r1 + a]) * tx;
      row[x] = top + (bot - top) * ty;
    }
  }
}

/** A coarse and a mid-resolution grid with their upsampling tables. */
interface Fields {
  c: CoarseGrid;
  cx: Lerp;
  cy: Lerp;
  m: CoarseGrid;
  mx: Lerp;
  my: Lerp;
}

type Fill = (x: number, y: number, z: number, out: Float32Array, o: number) => void;

function* buildFields(
  width: number,
  height: number,
  coarseChannels: number,
  coarseFill: Fill,
  midChannels: number,
  midFill: Fill,
): BuildSteps<Fields> {
  const cw = width / COARSE;
  const mw = width / MID;
  const c = yield* buildCoarse(cw, height / COARSE, coarseChannels, coarseFill);
  const m = yield* buildCoarse(mw, height / MID, midChannels, midFill);
  return {
    c,
    cx: lerpTable(width, cw, true, coarseChannels),
    cy: lerpTable(height, height / COARSE, false, cw * coarseChannels),
    m,
    mx: lerpTable(width, mw, true, midChannels),
    my: lerpTable(height, height / MID, false, mw * midChannels),
  };
}

/** Fine rows finished between yields of `forEachRow`. */
const ROW_CHUNK = 4;

/**
 * Calls `row(y, rows)` for every fine row, with `rows` holding that row of each
 * coarse channel followed by each mid channel.
 */
function* forEachRow(
  F: Fields,
  width: number,
  height: number,
  row: (y: number, rows: Float32Array[]) => void,
): BuildSteps<void> {
  const rows: Float32Array[] = [];
  for (let c = 0; c < F.c.channels + F.m.channels; c++) {
    rows.push(new Float32Array(width));
  }
  for (let y = 0; y < height; y++) {
    if (y % ROW_CHUNK === 0) {
      yield;
    }
    upsampleRow(F.c, F.cx, F.cy, y, rows, 0);
    upsampleRow(F.m, F.mx, F.my, y, rows, F.c.channels);
    row(y, rows);
  }
}

/** A uniform [0, 1) value per texel and seed (no noise call). */
function texelRandom(x: number, y: number, salt: number): number {
  return hash32(hash32(x + y * 4099) ^ salt) / 4294967296;
}

/** Base frequency of the continents (cycles per unit of sphere coordinates). */
const CONTINENT_FREQ = 1.3;
const WARP_FREQ = 0.9;
const WARP_AMOUNT = 0.45;
/** Sea level on the continent field: about a third of the surface is land. */
export const SEA_LEVEL = 0.1;

/** Continents (warped 4-octave fBm), moisture and city clusters, shared by Earth and Desert. */
function terrainCoarse(noise: Noise): Fill {
  return (x, y, z, out, o) => {
    const wx = noise.noise3(x * WARP_FREQ + 11.3, y * WARP_FREQ, z * WARP_FREQ) * WARP_AMOUNT;
    const wy = noise.noise3(x * WARP_FREQ, y * WARP_FREQ + 23.1, z * WARP_FREQ) * WARP_AMOUNT;
    const wz = noise.noise3(x * WARP_FREQ, y * WARP_FREQ, z * WARP_FREQ + 37.7) * WARP_AMOUNT;
    const f = CONTINENT_FREQ;
    out[o] = fbm3(noise, (x + wx) * f, (y + wy) * f, (z + wz) * f, 4);
    out[o + 1] = fbm3(noise, x * 1.7 + 51.2, y * 1.7, z * 1.7 - 9.4, 3);
    out[o + 2] = fbm3(noise, x * 5 - 71.9, y * 5, z * 5 + 13.3, 2);
  };
}

/** Detail: the 5th and 6th continent octaves (amplitudes relative to the fBm). */
function terrainDetail(noise: Noise): Fill {
  const f = CONTINENT_FREQ * 16;
  return (x, y, z, out, o) => {
    out[o] =
      0.1 * noise.noise3(x * f + 3.1, y * f, z * f) +
      0.05 * noise.noise3(x * f * 2, y * f * 2 + 5.3, z * f * 2);
  };
}

/**
 * Writes surface row `y` to `out` from the upsampled field rows. `sinLat` is the
 * row's sin(latitude); `salt` seeds the per-texel random values.
 */
type ShadeRow = (
  out: Uint8Array,
  y: number,
  sinLat: number,
  rows: Float32Array[],
  salt: number,
) => void;

/** A 0..1 value as a rounded, clamped byte (NaN gives NaN, which a byte array stores as 0). */
const byte = (v: number) => (v <= 0 ? 0 : v >= 1 ? 255 : Math.trunc(v * 255 + 0.5));

function put(out: Uint8Array, o: number, r: number, g: number, b: number, a: number): void {
  out[o] = byte(r);
  out[o + 1] = byte(g);
  out[o + 2] = byte(b);
  out[o + 3] = a;
}

/** Earth's dry subtropical belt (near 24 degrees) per surface row. */
const DRY_BELT = Float64Array.from({ length: SURFACE_H }, (_, y) => {
  const latDeg = Math.abs(((y + 0.5) / SURFACE_H - 0.5) * 180);
  return Math.exp(-(((latDeg - 24) / 11) ** 2));
});

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

const earthShade: ShadeRow = (out, y, sinLat, rows, salt) => {
  for (let x = 0; x < SURFACE_W; x++) {
    const o = (y * SURFACE_W + x) * 4;
    const rand = texelRandom(x, y, salt);
    const h = rows[0][x] + rows[3][x];
    const moist = rows[1][x];
    const cluster = rows[2][x];
    const lat = Math.abs(sinLat);
    // Polar caps: a ragged edge around 68-78 degrees of latitude.
    const ice = smoothstep(0.92, 0.96, lat + moist * 0.05 + (h - SEA_LEVEL) * 0.08);
    if (h < SEA_LEVEL) {
      const depth = smoothstep(0, 0.22, SEA_LEVEL - h);
      const r = mix(0.06, 0.012, depth);
      const gg = mix(0.2, 0.05, depth);
      const b = mix(0.32, 0.17, depth);
      put(
        out,
        o,
        mix(r, 0.86, ice),
        mix(gg, 0.9, ice),
        mix(b, 0.95, ice),
        ice > 0.5 ? 128 : GLOSSY,
      );
      continue;
    }
    const e = h - SEA_LEVEL;
    // Dry belts near 25 degrees and inland; wet near the equator and the coasts.
    const belt = DRY_BELT[y];
    const wet = moist - 0.45 * belt + 0.25 * (1 - smoothstep(0, 0.12, e)) - 0.1;
    const greenT = smoothstep(-0.05, 0.25, wet);
    let r = mix(0.2, 0.08, greenT);
    let gg = mix(0.28, 0.2, greenT);
    let b = mix(0.12, 0.07, greenT);
    const desert = smoothstep(-0.05, -0.3, wet);
    r = mix(r, 0.68, desert);
    gg = mix(gg, 0.55, desert);
    b = mix(b, 0.36, desert);
    const rock = smoothstep(0.2, 0.38, e);
    r = mix(r, 0.36, rock);
    gg = mix(gg, 0.32, rock);
    b = mix(b, 0.28, rock);
    const snow = Math.max(ice, smoothstep(0.38, 0.48, e + lat * 0.25));
    r = mix(r, 0.9, snow);
    gg = mix(gg, 0.92, snow);
    b = mix(b, 0.95, snow);
    // City lights: clusters, denser near the coast, thinned in deserts and snow.
    const coast = 1 - smoothstep(0.02, 0.14, e);
    const density =
      smoothstep(0.05, 0.45, cluster) * (0.3 + 0.7 * coast) * (1 - desert * 0.7) * (1 - snow);
    const city = rand < density * 0.55 ? 0.55 + 0.45 * fract(rand * 97.31) : density * 0.25;
    put(out, o, r, gg, b, materialByte(city));
  }
};

const desertShade: ShadeRow = (out, y, sinLat, rows, salt) => {
  for (let x = 0; x < SURFACE_W; x++) {
    const o = (y * SURFACE_W + x) * 4;
    const rand = texelRandom(x, y, salt);
    const detail = rows[3][x];
    const h = rows[0][x] + detail;
    const tone = rows[1][x];
    const cluster = rows[2][x];
    // Pale dry basins, ochre plains, rust highlands, dark ridges.
    const basin = smoothstep(-0.05, -0.2, h);
    const high = smoothstep(0.05, 0.35, h);
    let r = mix(0.74, 0.56, high);
    let gg = mix(0.49, 0.3, high);
    let b = mix(0.27, 0.18, high);
    r = mix(r, 0.86, basin);
    gg = mix(gg, 0.74, basin);
    b = mix(b, 0.54, basin);
    const t = 0.9 + 0.2 * tone + detail * 0.8;
    r *= t;
    gg *= t;
    b *= t;
    const cap = smoothstep(0.965, 0.985, Math.abs(sinLat) + tone * 0.02);
    r = mix(r, 0.92, cap);
    gg = mix(gg, 0.89, cap);
    b = mix(b, 0.85, cap);
    // Sparse settlements along basin edges.
    const edge = smoothstep(0.0, 0.5, basin) * (1 - smoothstep(0.6, 1, basin));
    const density = smoothstep(0.15, 0.5, cluster) * edge * (1 - cap);
    const city = rand < density * 0.5 ? 0.5 + 0.5 * fract(rand * 97.31) : density * 0.2;
    put(out, o, r, gg, b, materialByte(city));
  }
};

function iceCoarse(noise: Noise): Fill {
  return (x, y, z, out, o) => {
    out[o] = fbm3(noise, x * 1.6, y * 1.6, z * 1.6, 4);
  };
}

/** Two crack fields: noise whose zero crossings become lines. */
function iceDetail(noise: Noise): Fill {
  return (x, y, z, out, o) => {
    out[o] = noise.noise3(x * 3.2 + 7.7, y * 3.2, z * 3.2);
    out[o + 1] = noise.noise3(x * 8 - 2.2, y * 8 + 4.4, z * 8);
  };
}

/** White-blue ice, mottled, with darker reddish-brown crack lines (ridged noise near zero). */
const iceShade: ShadeRow = (out, y, _sinLat, rows) => {
  for (let x = 0; x < SURFACE_W; x++) {
    const o = (y * SURFACE_W + x) * 4;
    const m = rows[0][x];
    const n1 = rows[1][x];
    const n2 = rows[2][x];
    const crack = Math.max(
      1 - smoothstep(0.0, 0.05, Math.abs(n1)),
      0.6 * (1 - smoothstep(0.0, 0.07, Math.abs(n2))),
    );
    const blue = smoothstep(-0.35, 0.35, m);
    let r = mix(0.62, 0.9, blue);
    let gg = mix(0.74, 0.93, blue);
    let b = mix(0.86, 0.97, blue);
    // Chaos terrain: low patches stained tan.
    const stain = smoothstep(-0.2, -0.45, m);
    r = mix(r, 0.66, stain * 0.6);
    gg = mix(gg, 0.56, stain * 0.6);
    b = mix(b, 0.48, stain * 0.6);
    const k = crack * 0.75;
    put(out, o, mix(r, 0.5, k), mix(gg, 0.32, k), mix(b, 0.24, k), GLOSSY);
  }
};

function gasCoarse(noise: Noise): Fill {
  return (x, y, z, out, o) => {
    // Stretched along latitude so the turbulence streaks along the bands.
    out[o] = fbm3(noise, x * 1.5, y * 6, z * 1.5, 3);
  };
}

/**
 * Storm ovals: [lon (turns), lat, half-width (radians along the surface, divided
 * by cos(lat) to give radians of longitude), half-height, kind].
 */
const MAX_STORMS = 6;

function gasStorms(seed: number): Float64Array {
  const s = new Float64Array(MAX_STORMS * 5);
  for (let i = 0; i < MAX_STORMS; i++) {
    const r = (k: number) => hash32(hash32(seed * 31 + i * 7 + k) ^ 0x51ed27) / 4294967296;
    const big = i === 0;
    s[i * 5] = r(0);
    s[i * 5 + 1] = (r(1) - 0.5) * (big ? 0.6 : 1.6);
    s[i * 5 + 2] = (big ? 0.32 : 0.06 + 0.08 * r(2)) / Math.cos(s[i * 5 + 1]);
    s[i * 5 + 3] = big ? 0.13 : 0.03 + 0.03 * r(3);
    s[i * 5 + 4] = big ? 0 : 1;
  }
  return s;
}

function gasDetail(noise: Noise): Fill {
  return (x, y, z, out, o) => {
    out[o] = noise.noise3(x * 14, y * 60, z * 14);
  };
}

function gasShade(storms: Float64Array): ShadeRow {
  return (out, y, sinLat, rows) => {
    const lat = ((y + 0.5) / SURFACE_H - 0.5) * Math.PI;
    const pole = smoothstep(0.78, 0.98, Math.abs(sinLat));
    for (let x = 0; x < SURFACE_W; x++) {
      const o = (y * SURFACE_W + x) * 4;
      const turb = rows[0][x];
      const fine = rows[1][x];
      const lon = (x + 0.5) / SURFACE_W;
      let band = lat * 4.2 + turb * 0.55 + fine * 0.04;
      let stormMix = 0;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      for (let i = 0; i < MAX_STORMS; i++) {
        const k = i * 5;
        const ey = (lat - storms[k + 1]) / storms[k + 3];
        if (ey * ey >= 1.6) {
          continue;
        }
        let dl = lon - storms[k];
        dl -= Math.round(dl);
        const ex = (dl * TAU) / storms[k + 2];
        const e2 = ex * ex + ey * ey;
        if (e2 >= 1.6) {
          continue;
        }
        const d = Math.sqrt(e2);
        // Swirl the bands around the storm, then fill its core.
        band += 0.5 * Math.sin(Math.atan2(ey, ex) + d * 6) * (1 - smoothstep(0.6, 1.25, d));
        const w = 1 - smoothstep(0.55, 1, d);
        if (w > stormMix) {
          stormMix = w;
          const ring = 0.88 + 0.12 * Math.cos(d * 9);
          if (storms[k + 4] === 0) {
            sr = 0.74 * ring;
            sg = 0.4 * ring;
            sb = 0.26 * ring;
          } else {
            sr = 0.94 * ring;
            sg = 0.92 * ring;
            sb = 0.86 * ring;
          }
        }
      }
      const t1 = 0.5 + 0.5 * Math.sin(band * Math.PI);
      const t2 = 0.5 + 0.5 * Math.sin(band * 2.3 + 1);
      let r = mix(0.56, 0.8, t1);
      let gg = mix(0.38, 0.62, t1);
      let b = mix(0.26, 0.44, t1);
      const cream = t2 * t2;
      r = mix(r, 0.92, cream);
      gg = mix(gg, 0.85, cream);
      b = mix(b, 0.7, cream);
      r = mix(r, 0.48, pole);
      gg = mix(gg, 0.45, pole);
      b = mix(b, 0.46, pole);
      put(
        out,
        o,
        mix(r, sr, stormMix),
        mix(gg, sg, stormMix),
        mix(b, sb, stormMix),
        materialByte(0),
      );
    }
  };
}

/** Seed of the noise for a world and seed, so every world differs per seed. */
function worldSeed(world: string, seed: number, salt: number): number {
  const w = WORLD_OPTIONS.findIndex((o) => o.value === world);
  return hash32(hash32(Math.floor(seed) * 4 + Math.max(0, w)) ^ salt);
}

/**
 * Fills `out` (SURFACE_W x SURFACE_H RGBA8, row 0 = south pole) with the surface
 * of `world` for `seed`: RGB albedo and the material byte (see `materialByte`).
 * Deterministic; wraps seamlessly in longitude.
 */
export function buildSurface(
  world: string,
  seed: number,
  out: Uint8Array = new Uint8Array(SURFACE_W * SURFACE_H * 4),
): Uint8Array {
  return finishBuild(buildSurfaceSteps(world, seed, out));
}

/** `buildSurface` as build steps, yielding every few rows. */
export function* buildSurfaceSteps(
  world: string,
  seed: number,
  out: Uint8Array = new Uint8Array(SURFACE_W * SURFACE_H * 4),
): BuildSteps<Uint8Array> {
  const id: WorldId = isWorldId(world) ? world : "earth";
  const noise = createNoise(worldSeed(id, seed, 0x1234567));
  const W = SURFACE_W;
  const H = SURFACE_H;
  let F: Fields;
  let shade: ShadeRow;
  if (id === "earth" || id === "desert") {
    F = yield* buildFields(W, H, 3, terrainCoarse(noise), 1, terrainDetail(noise));
    shade = id === "earth" ? earthShade : desertShade;
  } else if (id === "ice") {
    F = yield* buildFields(W, H, 1, iceCoarse(noise), 2, iceDetail(noise));
    shade = iceShade;
  } else {
    F = yield* buildFields(W, H, 1, gasCoarse(noise), 1, gasDetail(noise));
    shade = gasShade(gasStorms(seed));
  }
  const salt = worldSeed(id, seed, 0x7f4a7c15);
  yield* forEachRow(F, W, H, (y, rows) => {
    shade(out, y, Math.sin(((y + 0.5) / H - 0.5) * Math.PI), rows, salt);
  });
  return out;
}

const CLOUD_FREQ = 2.1;

/**
 * Fills `out` (CLOUD_W x CLOUD_H RGBA8) with raw cloud cover in R (0..255; the
 * shader thresholds it), the cover SHADOW_SHIFT texels east in G and west in B
 * (for cloud shadows without another fetch). Worlds without clouds get zeros.
 */
export function buildClouds(
  world: string,
  seed: number,
  out: Uint8Array = new Uint8Array(CLOUD_W * CLOUD_H * 4),
): Uint8Array {
  return finishBuild(buildCloudsSteps(world, seed, out));
}

/** `buildClouds` as build steps, yielding every few rows. */
export function* buildCloudsSteps(
  world: string,
  seed: number,
  out: Uint8Array = new Uint8Array(CLOUD_W * CLOUD_H * 4),
): BuildSteps<Uint8Array> {
  if (worldStyle(world).clouds === 0) {
    out.fill(0);
    return out;
  }
  const noise = createNoise(worldSeed(world, seed, 0x2c1b3c6d));
  const f = CLOUD_FREQ;
  const F = yield* buildFields(
    CLOUD_W,
    CLOUD_H,
    1,
    (x, y, z, o, i) => {
      const w = 0.5 * noise.noise3(x * 1.2 + 4.1, y * 3, z * 1.2);
      // Squashed in latitude: cloud bands and fronts stretch east-west.
      o[i] = fbm3(noise, (x + w) * f, y * f * 1.8, (z - w) * f, 3);
    },
    1,
    (x, y, z, o, i) => {
      o[i] =
        0.12 * noise.noise3(x * f * 8, y * f * 14.4, z * f * 8) +
        0.06 * noise.noise3(x * f * 16 + 9.1, y * f * 28.8, z * f * 16);
    },
  );
  yield* forEachRow(F, CLOUD_W, CLOUD_H, (y, rows) => {
    const row = y * CLOUD_W * 4;
    // More cloud at the equator and 60 degrees, less in the subtropics.
    const belts = 0.08 * Math.cos(((y + 0.5) / CLOUD_H - 0.5) * Math.PI * 6);
    const base = rows[0];
    const detail = rows[1];
    for (let x = 0; x < CLOUD_W; x++) {
      const v = 0.5 + 0.75 * (base[x] + detail[x]) + belts;
      out[row + x * 4] = byte(v);
    }
    for (let x = 0; x < CLOUD_W; x++) {
      const o = row + x * 4;
      out[o + 1] = out[row + ((x + SHADOW_SHIFT) % CLOUD_W) * 4];
      out[o + 2] = out[row + ((x - SHADOW_SHIFT + CLOUD_W) % CLOUD_W) * 4];
      out[o + 3] = 255;
    }
  });
  return out;
}

/** Cloud threshold and opacity for the shader: cover = smoothstep(lo, lo + CLOUD_SOFT, raw) * alpha. */
export const CLOUD_SOFT = 0.22;
export function cloudShaping(clouds: number, world: WorldStyle, out: Float64Array): Float64Array {
  const amount = clamp(clouds, 0, 1) * world.clouds;
  out[0] = mix(0.82, 0.36, amount);
  out[1] = amount > 0 ? Math.min(1, amount * 4) * 0.95 : 0;
  return out;
}

// ---------------------------------------------------------------------------
// Geometry: framing, sun, tilt, ray-sphere
// ---------------------------------------------------------------------------

/**
 * Disc centre and radius in canvas heights (origin at the canvas centre, y up),
 * written to `out` as [cx, cy, radius]. `size` is the radius relative to the
 * frame height for the corner and edge framings; the full disc scales it down
 * so the default fits the frame. Edge framings show a cap 0.2 heights deep at
 * size 1; corner framings sit slightly in from the side edge.
 */
export function planetLayout(
  framing: string,
  size: number,
  aspect: number,
  out: Float64Array,
): Float64Array {
  const s = clamp(size, 0.1, 4);
  const half = aspect / 2;
  const [ax, ay] = framingAnchor(framing);
  if (ax === 0 && ay === 0) {
    out[0] = 0;
    out[1] = 0.02;
    out[2] = 0.4 * s;
  } else if (ay === 0) {
    out[0] = ax * (half + 0.8 * s);
    out[1] = 0;
    out[2] = s;
  } else if (ax === 0) {
    out[0] = 0;
    out[1] = ay * (0.5 + 0.8 * s);
    out[2] = s;
  } else {
    out[0] = ax * (half - 0.2 * s);
    out[1] = ay * (0.5 + 0.75 * s);
    out[2] = s;
  }
  return out;
}

/**
 * The sun's side of the frame as (x, y) signs, written to `out`: horizontally
 * from the planet's outer side (left when centred), vertically from the frame's
 * side of the planet (above unless the planet hangs from the top).
 */
export function sunSide(framing: string, out: Float64Array): Float64Array {
  const [ax, ay] = framingAnchor(framing);
  out[0] = ax === 0 ? -1 : ax;
  out[1] = ay > 0 ? -1 : 1;
  return out;
}

/** Sun elevation above the screen's horizontal plane, so the terminator runs diagonally. */
const SUN_ELEVATION = 0.42;

/**
 * Unit vector towards the sun in view space (x right, y up, z towards the
 * viewer), written to `out`. `angleDeg` is the angle between the sun and the
 * viewer around the vertical: 0 lights the visible face fully, 90 from the side
 * (`side` -1 left, +1 right), 180 from behind (a thin crescent). `above` +1
 * raises the sun above the horizontal plane, -1 lowers it below.
 */
export function sunDirection(
  angleDeg: number,
  side: number,
  out: Float64Array,
  above = 1,
): Float64Array {
  const a = (clamp(angleDeg, 0, 180) * Math.PI) / 180;
  const ce = Math.cos(SUN_ELEVATION);
  out[0] = side * Math.sin(a) * ce;
  out[1] = above * Math.sin(SUN_ELEVATION);
  out[2] = Math.cos(a) * ce;
  return out;
}

/** Axis tilt: rolled sideways by AXIS_ROLL and pitched towards the viewer by AXIS_PITCH. */
const AXIS_ROLL = 0.38;
const AXIS_PITCH = 0.32;

/**
 * Body-from-view rotation, row-major (9 values): rows are the body's x, y and z
 * axes in view space. The north pole (body +y) appears tilted to the left and
 * towards the viewer.
 */
export function bodyFromView(): Float64Array {
  const cr = Math.cos(AXIS_ROLL);
  const sr = Math.sin(AXIS_ROLL);
  const cp = Math.cos(AXIS_PITCH);
  const sp = Math.sin(AXIS_PITCH);
  // View-from-body V = Rz(roll) * Rx(pitch); body-from-view is its transpose,
  // whose rows are V's columns.
  return new Float64Array([
    cr,
    sr,
    0, // V * (1, 0, 0)
    -sr * cp,
    cr * cp,
    sp, // V * (0, 1, 0): the north axis
    sr * sp,
    -cr * sp,
    cp, // V * (0, 0, 1)
  ]);
}

/** `m` (row-major 3x3) times (x, y, z), written to `out`. */
export function mulMat3(
  m: Float64Array,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): Float64Array {
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

/**
 * The shader's hit, for an orthographic view ray (towards -z) through the point
 * (dx, dy) from the disc centre, radius `r`: writes the view-space unit normal to
 * `out` and returns whether the ray hit. A miss returns the limb normal at the
 * closest approach (z = 0), which is what the shader lights the halo with. This
 * is the planet shader's `e` and `N` in `planet.ts`; change the two together.
 */
export function discNormal(dx: number, dy: number, r: number, out: Float64Array): boolean {
  const len = Math.hypot(dx, dy) / r;
  const k = 1 / (r * Math.max(len, 1));
  const ex = dx * k;
  const ey = dy * k;
  out[0] = ex;
  out[1] = ey;
  out[2] = Math.sqrt(Math.max(1 - ex * ex - ey * ey, 0));
  return len <= 1;
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

/** Seconds per turn at rotation speed 1 (7 minutes). */
export const TURN_SECONDS = 420;
/** The cloud layer turns this much faster than the surface. */
export const CLOUD_RATE = 1.15;

/** `phase` advanced by `turns` (any sign), wrapped to [0, 1). */
export function advancePhase(phase: number, turns: number): number {
  return fract(phase + turns);
}
