/**
 * Builds public/land-mask.png, the land mask for the Daylight World Map effect
 * (src/effects/daymap.ts), from Natural Earth's 1:50m land polygons.
 *
 * Source: Natural Earth, ne_50m_land (https://www.naturalearthdata.com/), public
 * domain. The GeoJSON copy used is
 * https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson
 *
 * Output: a 1024x512 8-bit greyscale PNG in equirectangular projection (longitude
 * -180..180 left to right, latitude 90..-90 top to bottom) holding a signed
 * distance field: 128 + 8 * d, where d is the distance to the coast in output
 * texels, positive on land, clamped to +-4 texels. Bilinear filtering of a distance
 * field keeps coastlines smooth when the map is magnified to 4K.
 *
 * Usage: node scripts/build-land-mask.mjs <ne_50m_land.geojson> [out.png]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const [input, output = "public/land-mask.png"] = process.argv.slice(2);
if (!input) {
  console.error("usage: node scripts/build-land-mask.mjs <ne_50m_land.geojson> [out.png]");
  process.exit(1);
}

const W = 1024;
const H = 512;
/** Supersampling factor of the binary raster the distances are measured on. */
const SS = 4;
const HW = W * SS;
const HH = H * SS;
/** Distance clamp, in output texels, and the encoding's steps per texel. */
const RANGE = 4;
const STEPS = 8;
/** Columns of wrapped padding on each side, so distances wrap across the antimeridian. */
const PAD = (RANGE + 2) * SS;

// ---------------------------------------------------------------------------
// Rasterise (even-odd scanline fill at pixel centres)
// ---------------------------------------------------------------------------

const geo = JSON.parse(readFileSync(input, "utf8"));
const rings = [];
for (const f of geo.features) {
  const g = f.geometry;
  const polys =
    g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  for (const poly of polys) for (const ring of poly) rings.push(ring);
}

const land = new Uint8Array(HW * HH);
const xs = [];
for (let y = 0; y < HH; y++) {
  const lat = 90 - ((y + 0.5) * 180) / HH;
  xs.length = 0;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x0, y0] = ring[j];
      const [x1, y1] = ring[i];
      if (y0 > lat !== y1 > lat) {
        const lon = x0 + ((lat - y0) / (y1 - y0)) * (x1 - x0);
        xs.push(((lon + 180) / 360) * HW - 0.5);
      }
    }
  }
  xs.sort((a, b) => a - b);
  for (let k = 0; k + 1 < xs.length; k += 2) {
    const a = Math.max(0, Math.ceil(xs[k]));
    const b = Math.min(HW - 1, Math.floor(xs[k + 1]));
    for (let x = a; x <= b; x++) land[y * HW + x] ^= 1;
  }
}

// ---------------------------------------------------------------------------
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher)
// ---------------------------------------------------------------------------

const INF = 1e20;
function dt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** Squared distance from each pixel to the nearest pixel where `inside(x, y)`, with wrapped columns. */
function edt(inside) {
  const PW = HW + 2 * PAD;
  const grid = new Float64Array(PW * HH);
  for (let y = 0; y < HH; y++)
    for (let x = 0; x < PW; x++) {
      const sx = (((x - PAD) % HW) + HW) % HW;
      grid[y * PW + x] = inside(land[y * HW + sx]) ? 0 : INF;
    }
  const n = Math.max(PW, HH);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < PW; x++) {
    for (let y = 0; y < HH; y++) f[y] = grid[y * PW + x];
    dt1(f, HH, d, v, z);
    for (let y = 0; y < HH; y++) grid[y * PW + x] = d[y];
  }
  for (let y = 0; y < HH; y++) {
    for (let x = 0; x < PW; x++) f[x] = grid[y * PW + x];
    dt1(f, PW, d, v, z);
    for (let x = 0; x < PW; x++) grid[y * PW + x] = d[x];
  }
  return { grid, PW };
}

const toLand = edt((v) => v === 1);
const toSea = edt((v) => v === 0);

// ---------------------------------------------------------------------------
// Downsample to the output signed distance field
// ---------------------------------------------------------------------------

const out = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let j = 0; j < SS; j++)
      for (let i = 0; i < SS; i++) {
        const hy = y * SS + j;
        const hx = x * SS + i + PAD;
        // Half a pixel either side puts the zero crossing on the boundary between pixels.
        const sea = Math.sqrt(toSea.grid[hy * toSea.PW + hx]);
        const lnd = Math.sqrt(toLand.grid[hy * toLand.PW + hx]);
        sum += sea > 0 ? sea - 0.5 : -(lnd - 0.5);
      }
    const dTexels = sum / (SS * SS) / SS;
    const clamped = Math.max(-RANGE, Math.min(RANGE, dTexels));
    out[y * W + x] = Math.max(0, Math.min(255, Math.round(128 + clamped * STEPS)));
  }

// ---------------------------------------------------------------------------
// PNG (greyscale, 8-bit, per-row adaptive filter)
// ---------------------------------------------------------------------------

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

const raw = Buffer.alloc(H * (W + 1));
const row = new Uint8Array(W);
for (let y = 0; y < H; y++) {
  let best = 0;
  let bestScore = Infinity;
  let bestRow = row;
  for (let ft = 0; ft < 5; ft++) {
    const r = new Uint8Array(W);
    let score = 0;
    for (let x = 0; x < W; x++) {
      const cur = out[y * W + x];
      const a = x > 0 ? out[y * W + x - 1] : 0;
      const b = y > 0 ? out[(y - 1) * W + x] : 0;
      const c = x > 0 && y > 0 ? out[(y - 1) * W + x - 1] : 0;
      const pred =
        ft === 0 ? 0 : ft === 1 ? a : ft === 2 ? b : ft === 3 ? (a + b) >> 1 : paeth(a, b, c);
      r[x] = (cur - pred) & 0xff;
      score += r[x] < 128 ? r[x] : 256 - r[x];
    }
    if (score < bestScore) {
      bestScore = score;
      best = ft;
      bestRow = r;
    }
  }
  raw[y * (W + 1)] = best;
  raw.set(bestRow, y * (W + 1) + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 0; // greyscale
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(output, png);
let landCount = 0;
for (const v of out) if (v >= 128) landCount++;
console.log(
  `wrote ${output}: ${png.length} bytes, land ${((100 * landCount) / out.length).toFixed(1)}% of texels`,
);
