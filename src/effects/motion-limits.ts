/**
 * Motion a video-call codec can follow. Calls often run at 30 fps or less, so a
 * repeating pattern that crosses a point too often aliases (it crawls, freezes
 * or runs backwards), and a thin bright feature that jumps too far between
 * frames smears into a blur the encoder spends its bits on. Effects keep every
 * slider value within these limits.
 */

/** No repeating pattern (stripes, grid lines, teeth) crosses a screen point faster than this, Hz. */
export const MAX_PATTERN_HZ = 5;

/** No thin bright feature moves further than this per frame, in px at 1080p and 30 fps. */
export const MAX_FEATURE_PX_PER_FRAME = 10;

/** The reference frame the per-frame limit is measured in: 1080 px tall, 30 fps. */
export const REFERENCE_HEIGHT = 1080;
export const REFERENCE_FPS = 30;

/**
 * Caps the speed of a pattern repeating every `period` (any length unit; `speed`
 * in the same units per second) so it passes a point at most MAX_PATTERN_HZ times
 * a second. Non-finite or negative inputs give 0.
 */
export function capPatternSpeed(speed: number, period: number): number {
  if (!(speed > 0) || !(period > 0) || !Number.isFinite(speed)) {
    return 0;
  }
  return Math.min(speed, MAX_PATTERN_HZ * period);
}

/** Px per frame at 1080p30 of something moving `heightsPerSecond` frame heights a second. */
export const pxPerReferenceFrame = (heightsPerSecond: number) =>
  (Math.abs(heightsPerSecond) * REFERENCE_HEIGHT) / REFERENCE_FPS;
