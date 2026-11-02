/**
 * Pure CPU-side logic for the caustics effect: tile resolution, per-iteration
 * phase rates of the caustic warp, the god-ray column table and the bubble
 * simulation. No GL here, so it is unit tested directly.
 */

const TAU = Math.PI * 2;

/**
 * Phase rate of each warp iteration of the caustic pattern, relative to the base
 * time (`1 - 3.5 / (n + 1)`). Different rates make the network morph rather than
 * just slide. The shader is generated with one iteration per entry.
 */
export const CAUSTIC_RATES: readonly number[] = [1, 2, 3, 4, 5].map((n) => 1 - 3.5 / n);

/**
 * Advances each iteration's phase by `dt * rates[n]`, wrapped to [0, TAU). The
 * pattern is 2π-periodic in every phase, so wrapping is seamless and the shader
 * never sees large (imprecise) times.
 */
export function advancePhases(
  phases: Float32Array | number[],
  dt: number,
  rates: readonly number[] = CAUSTIC_RATES,
): void {
  for (let n = 0; n < rates.length; n++) {
    let v = (phases[n] + dt * rates[n]) % TAU;
    if (v < 0) v += TAU;
    phases[n] = v;
  }
}

/**
 * Square caustic tile size in texels for a tile that covers `screenPx` device
 * pixels: the power of two nearest to `screenPx / 1.4` (mild magnification is
 * invisible on soft filaments), clamped to 256..1024.
 */
export function tileResolution(screenPx: number): number {
  if (!Number.isFinite(screenPx) || screenPx <= 0) return 256;
  const exp = Math.round(Math.log2(screenPx / 1.4));
  return Math.min(1024, Math.max(256, 2 ** exp));
}

/** Wraps `v` into [0, 1). */
export function wrap01(v: number): number {
  const w = v - Math.floor(v);
  return w >= 1 ? 0 : w;
}

/** One god ray: a soft vertical band that sways and pulses slowly. */
export interface Ray {
  /** Centre in 0..1 across the table. */
  center: number;
  /** Gaussian half-width in table units. */
  width: number;
  amp: number;
  sway: number;
  swayFreq: number;
  swayPhase: number;
  pulseFreq: number;
  pulsePhase: number;
}

/** `count` rays, stratified across the width so they never all bunch up. */
export function createRays(rng: () => number, count: number): Ray[] {
  const rays: Ray[] = [];
  for (let k = 0; k < count; k++) {
    rays.push({
      center: (k + 0.2 + 0.6 * rng()) / count,
      width: 0.012 + 0.028 * rng(),
      amp: 0.35 + 0.45 * rng(),
      sway: 0.01 + 0.02 * rng(),
      swayFreq: 0.05 + 0.1 * rng(),
      swayPhase: rng() * TAU,
      pulseFreq: 0.1 + 0.2 * rng(),
      pulsePhase: rng() * TAU,
    });
  }
  return rays;
}

/**
 * Fills the per-column god-ray table (column j samples x = (j + 0.5) / n) with
 * the sum of the rays' Gaussian profiles at `time`, clamped to 0..1. Allocates
 * nothing.
 */
export function fillRayTable(out: Float32Array, rays: readonly Ray[], time: number): void {
  const n = out.length;
  out.fill(0);
  for (let k = 0; k < rays.length; k++) {
    const ray = rays[k];
    const c = ray.center + ray.sway * Math.sin(time * ray.swayFreq + ray.swayPhase);
    const a = ray.amp * (0.65 + 0.35 * Math.sin(time * ray.pulseFreq + ray.pulsePhase));
    const inv = 1 / ray.width;
    // exp(-9) is about 1e-4: nothing visible beyond three widths.
    const lo = Math.max(0, Math.floor((c - 3 * ray.width) * n));
    const hi = Math.min(n - 1, Math.ceil((c + 3 * ray.width) * n));
    for (let j = lo; j <= hi; j++) {
      const d = ((j + 0.5) / n - c) * inv;
      out[j] += a * Math.exp(-d * d);
    }
  }
  for (let j = 0; j < n; j++) if (out[j] > 1) out[j] = 1;
}

/** Bubble radius range in reference px (1080p). */
export const BUBBLE_MIN_R = 2.5;
export const BUBBLE_MAX_R = 10;
/** Rise speed in reference px/s of the largest bubble at speed 1. */
export const BUBBLE_RISE = 60;
/** Reference frame height. */
const REF_HEIGHT = 1080;

/** Structure-of-arrays bubble state, positions in reference px (y down). */
export interface BubbleState {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly r: Float32Array;
  readonly rise: Float32Array;
  readonly phase: Float32Array;
  readonly freq: Float32Array;
  /** Fade-in, 0..1. */
  readonly life: Float32Array;
}

export function createBubbleState(max: number): BubbleState {
  return {
    x: new Float32Array(max),
    y: new Float32Array(max),
    r: new Float32Array(max),
    rise: new Float32Array(max),
    phase: new Float32Array(max),
    freq: new Float32Array(max),
    life: new Float32Array(max),
  };
}

/** How far past the top a bubble goes before it respawns, and how far below it starts. */
export const bubbleMargin = (r: number) => r * 2 + 4;

/** (Re)spawns bubble `i` at height `y` with a random x, size and rise speed. */
export function spawnBubble(
  s: BubbleState,
  i: number,
  rng: () => number,
  refWidth: number,
  y: number,
): void {
  const t = rng();
  // Mostly small bubbles, a few large ones.
  const r = BUBBLE_MIN_R + (BUBBLE_MAX_R - BUBBLE_MIN_R) * t * t;
  s.r[i] = r;
  s.x[i] = rng() * refWidth;
  s.y[i] = y;
  // Larger bubbles rise faster.
  s.rise[i] = BUBBLE_RISE * (0.45 + 0.55 * (r / BUBBLE_MAX_R)) * (0.85 + 0.3 * rng());
  s.phase[i] = rng() * TAU;
  s.freq[i] = 1.2 + 1.6 * rng();
}

/** Spawns all bubbles spread over the full height, fully faded in. */
export function seedBubbles(s: BubbleState, rng: () => number, refWidth: number): void {
  for (let i = 0; i < s.x.length; i++) {
    spawnBubble(s, i, rng, refWidth, rng() * REF_HEIGHT);
    s.life[i] = 1;
  }
}

/**
 * Moves the first `count` bubbles up by `rise * dt` and fades them in over
 * `fade` seconds. A bubble that leaves the top respawns just below the bottom
 * at a new x, so the jump is never visible.
 */
export function stepBubbles(
  s: BubbleState,
  count: number,
  dt: number,
  refWidth: number,
  rng: () => number,
  fade = 1.5,
): void {
  const n = Math.min(count, s.x.length);
  const fadeStep = fade > 0 ? dt / fade : 1;
  for (let i = 0; i < n; i++) {
    const y = s.y[i] - s.rise[i] * dt;
    if (y < -bubbleMargin(s.r[i])) {
      spawnBubble(s, i, rng, refWidth, REF_HEIGHT);
      s.y[i] = REF_HEIGHT + bubbleMargin(s.r[i]) + rng() * 40;
    } else {
      s.y[i] = y;
    }
    s.life[i] = Math.min(1, s.life[i] + fadeStep);
  }
}

/** Drawn x of bubble `i` at `time`: a gentle side-to-side wobble about its track. */
export function bubbleX(s: BubbleState, i: number, time: number): number {
  return s.x[i] + Math.sin(time * s.freq[i] + s.phase[i]) * s.r[i] * 0.9;
}
