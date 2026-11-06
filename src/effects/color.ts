export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [0, 0, 0];
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${String(r | 0)},${String(g | 0)},${String(b | 0)},${String(alpha)})`;
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
