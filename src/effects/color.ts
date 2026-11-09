import { smoothstep } from "./math";

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) {
    return [0, 0, 0];
  }
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** ToInt32, as `v | 0`: truncates, and NaN and infinities become 0. */
const int32 = (v: number) => Math.imul(v, 1);

export function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${String(int32(r))},${String(int32(g))},${String(int32(b))},${String(alpha)})`;
}

/** Colour channels in 0..1, e.g. for a WebGL `vec3` uniform. */
export function hexToUnitRgb(hex: string): Rgb {
  const [r, g, b] = hexToRgb(hex);
  return [r / 255, g / 255, b / 255];
}

/**
 * `hexToUnitRgb` for one colour param, remembering the last colour so a steady
 * value costs no parsing or allocation per frame: re-parses only when the string
 * changes. The returned array must not be modified.
 */
export function unitRgbMemo(): (hex: string) => Rgb {
  let lastHex: string | undefined;
  let lastRgb: Rgb = [0, 0, 0];
  return (hex) => {
    if (hex !== lastHex) {
      lastHex = hex;
      lastRgb = hexToUnitRgb(hex);
    }
    return lastRgb;
  };
}

/** A gradient stop: position in 0..1 and a `#rrggbb` colour. Stops ascend in position. */
export type GradientStop = readonly [number, string];

/**
 * Fills `out` with an RGBA8 lookup table of `out.length / 4` texels across the
 * gradient `stops` (at least two), eased with a smoothstep between each pair of
 * stops, alpha 255. Returns `out`.
 */
export function buildGradientLut(stops: readonly GradientStop[], out: Uint8Array): Uint8Array {
  const size = out.length >> 2;
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) {
      s++;
    }
    const [t0, c0] = stops[s];
    const [t1, c1] = stops[s + 1];
    const f = smoothstep(t0, t1, t);
    const a = hexToRgb(c0);
    const b = hexToRgb(c1);
    for (let c = 0; c < 3; c++) {
      out[i * 4 + c] = Math.round(a[c] + (b[c] - a[c]) * f);
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}
