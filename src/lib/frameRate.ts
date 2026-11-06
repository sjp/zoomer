export const FRAME_RATES = {
  display: { label: "Match display", fps: undefined },
  "60": { label: "60 fps", fps: 60 },
  "30": { label: "30 fps", fps: 30 },
} as const;

export type FrameRate = keyof typeof FRAME_RATES;

/**
 * Decides which display refreshes to render on so output averages `fps`.
 * Returns true when a frame should be drawn at time `now` (ms).
 */
export function createFrameLimiter() {
  let next = 0;
  return (now: number, fps: number | undefined): boolean => {
    if (fps === undefined) {
      return true;
    }
    const interval = 1000 / fps;
    // Small tolerance so a 60 fps cap on a 60 Hz display never skips frames due to jitter.
    if (now < next - 2) {
      return false;
    }
    // Advance on a fixed schedule for even pacing; resync if we've fallen far behind.
    next = now - next > interval ? now + interval : next + interval;
    return true;
  };
}

/** Longest step an effect is ever asked to simulate, in seconds. */
export const MAX_FRAME_DT = 0.1;

/**
 * Seconds between two frame timestamps (ms), clamped to `[0, MAX_FRAME_DT]`.
 * The first rAF timestamp can precede the `performance.now()` taken during setup,
 * and a backgrounded tab can return after a long pause; neither should reach effects.
 */
export function frameDelta(now: number, last: number): number {
  const dt = (now - last) / 1000;
  return dt > 0 ? Math.min(dt, MAX_FRAME_DT) : 0;
}
