/**
 * Light through a row of venetian blind slats, as a 1D profile across the slats:
 * shared by Light Through Blinds' wall stripes and by the Scenes that draw
 * blinds or the striped light that comes through them.
 */
import { fract, smoothstep } from "./math";

/**
 * Light through a row of slats at stripe phase `n` (in periods; gaps centred on
 * half-integers) with penumbra `pen` (in periods), when each gap reaches
 * `halfGap` periods either side of its centre. 1 in the gap, 0 behind a slat.
 */
export function slatGap(n: number, pen: number, halfGap: number): number {
  const g = Math.abs(fract(n) - 0.5);
  return 1 - smoothstep(halfGap - 0.5 * pen, halfGap + 0.5 * pen, g);
}

/** GLSL twin of `slatGap`: `float slatGap(float n, float pen, float halfGap)`. */
export const SLAT_GAP_GLSL = /* glsl */ `
float slatGap(float n, float pen, float halfGap) {
  float g = abs(fract(n) - 0.5);
  return 1.0 - smoothstep(halfGap - 0.5 * pen, halfGap + 0.5 * pen, g);
}
`;
