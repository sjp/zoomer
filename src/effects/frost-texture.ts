/**
 * The static frosting of a pane of frosted glass: fine white grain plus soft
 * mottling, in one tiling RG8 texture, as Frosted Glass draws it over its
 * blurred shapes.
 */
import { buildPeriodicNoiseTexture, hash32 } from "./noise";

/** Grain texture side in texels; one texel per 1080p pixel, so it tiles every 256 px. */
export const GRAIN_SIZE = 256;
/** Lattice cells across the coarse (mottling) channel. */
const GRAIN_COARSE_PERIOD = 8;

/**
 * The static frosting texture: RG8, `size` x `size`, REPEAT-wrapped. R is white
 * noise (one hashed byte per texel: the fine grain, which bilinear filtering
 * softens a little above 1080p); G is one octave of tiling gradient noise with
 * `coarsePeriod` cells (soft mottling). Both centre on 128.
 */
export function buildGrainTexture(
  size = GRAIN_SIZE,
  coarsePeriod = GRAIN_COARSE_PERIOD,
  seed = 0xf205,
): Uint8Array {
  const coarse = buildPeriodicNoiseTexture(size, [{ period: coarsePeriod, seed }]);
  const data = new Uint8Array(size * size * 2);
  for (let i = 0; i < size * size; i++) {
    data[i * 2] = hash32(i ^ Math.imul(seed, 0x9e3779b1)) >>> 24;
    data[i * 2 + 1] = coarse[i];
  }
  return data;
}
