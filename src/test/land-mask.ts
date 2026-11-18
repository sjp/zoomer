/**
 * The shared land mask (`public/land-mask.png`) decoded for unit tests, which
 * have no image decoder: the PNG's 8-bit greyscale rows, inflated and
 * unfiltered, sampled as the shaders sample them.
 */
import maskUrl from "../../public/land-mask.png?inline";
import { LAND_MASK_BIAS, LAND_MASK_GAIN, LAND_MASK_WIDTH } from "../effects/land-mask";

interface LandMask {
  width: number;
  height: number;
  data: Uint8Array;
}

const be32 = (b: Uint8Array, o: number) =>
  ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

async function inflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

let cached: Promise<LandMask> | undefined;

/** The decoded mask, one byte per texel, row 0 at the north edge. */
export function loadTestLandMask(): Promise<LandMask> {
  cached ??= (async () => {
    const bytes = Uint8Array.from(
      atob(maskUrl.slice(maskUrl.indexOf(",") + 1)),
      (c) => c.codePointAt(0) ?? 0,
    );
    let width = 0;
    let height = 0;
    const idat: Uint8Array<ArrayBuffer>[] = [];
    for (let o = 8; o < bytes.length;) {
      const length = be32(bytes, o);
      const type = String.fromCodePoint(...bytes.subarray(o + 4, o + 8));
      const body = bytes.subarray(o + 8, o + 8 + length);
      if (type === "IHDR") {
        width = be32(body, 0);
        height = be32(body, 4);
      } else if (type === "IDAT") {
        idat.push(body);
      }
      o += 12 + length;
    }
    const joined = new Uint8Array(idat.reduce((n, b) => n + b.length, 0));
    let at = 0;
    for (const b of idat) {
      joined.set(b, at);
      at += b.length;
    }
    const raw = await inflate(joined);
    const data = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (width + 1)];
      for (let x = 0; x < width; x++) {
        const a = x > 0 ? data[y * width + x - 1] : 0;
        const b = y > 0 ? data[(y - 1) * width + x] : 0;
        const c = x > 0 && y > 0 ? data[(y - 1) * width + x - 1] : 0;
        const predict = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter];
        data[y * width + x] = (raw[y * (width + 1) + 1 + x] + predict) & 0xff;
      }
    }
    return { width, height, data };
  })();
  return cached;
}

/**
 * Distance from the coast at `lat`, `lon` (degrees), in mask texels, positive
 * on land: the mask sampled bilinearly, as the shaders' texture fetch does.
 */
export function coastDistance(mask: LandMask, lat: number, lon: number): number {
  const { width, height, data } = mask;
  const u = (lon / 360 + 0.5) * LAND_MASK_WIDTH - 0.5;
  const v = (0.5 - lat / 180) * height - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  const at = (x: number, y: number) => {
    const row = Math.min(height - 1, Math.max(0, y));
    return (
      (data[row * width + (((x % width) + width) % width)] / 255) * LAND_MASK_GAIN - LAND_MASK_BIAS
    );
  };
  const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
  const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}
