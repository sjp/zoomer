/**
 * Rising bubbles' simulation, kept free of GL so it can be tested: bubbles rise
 * at a speed set by their size, mid-sized ones zigzag and large ones flatten
 * into wobbling ellipses. With streams on, a share of them is emitted at a
 * steady rate from a few fixed points along the bottom edge; the rest respawn
 * at random positions below it. Positions are in reference units (1 = 1080
 * device-independent pixels, y down).
 */
import { FADE_OUT, growLive, stepLife, trimLive } from "./fade";
import { clamp, fract } from "./math";
import { createRng } from "./noise";

const TAU = Math.PI * 2;

/** Slowest and fastest rise in px/s at 1080p for a speed of 1. */
export const RISE_MIN = 30;
export const RISE_MAX = 150;
/** Radius (px at 1080p) at which the rise is halfway between the two. */
export const RISE_HALF_R = 10;

/** Below this radius (px at 1080p) a bubble rises straight; zigzag is full at ZIG_FULL_R. */
export const ZIG_MIN_R = 5;
export const ZIG_FULL_R = 12;
/** Largest zigzag half-amplitude in px at 1080p. */
export const ZIG_PX = 14;
/** Below this radius a bubble stays round; the flattening is full at WOBBLE_FULL_R. */
export const WOBBLE_MIN_R = 14;
export const WOBBLE_FULL_R = 30;
/** Largest flattening (semi-major axis = r(1 + k), semi-minor = r / (1 + k)). */
export const WOBBLE_MAX = 0.28;
/** Largest tilt of a wobbling bubble's flattened axis away from horizontal, in radians. */
export const WOBBLE_TILT = 0.35;

/** Seconds a bubble takes to fade in when the count is raised. */
export const FADE_IN = 1.2;
/** Stream emitters per mode at most. */
export const MAX_EMITTERS = 6;
/**
 * Emitters fire this much faster than their bubbles come back round, so a stream
 * almost never has to wait for a bubble. The few spare emissions are skipped.
 */
const EMIT_SLACK = 1.1;

/** Rise speed in px/s at 1080p for radius `r` (px at 1080p): monotonic, capped at RISE_MAX. */
export function riseSpeed(r: number): number {
  const r2 = Math.max(0, r) ** 2;
  return RISE_MIN + ((RISE_MAX - RISE_MIN) * r2) / (r2 + RISE_HALF_R * RISE_HALF_R);
}

/** Zigzag half-amplitude in px at 1080p: 0 below ZIG_MIN_R, at most ZIG_PX. */
export function zigAmplitude(r: number): number {
  return ZIG_PX * clamp((r - ZIG_MIN_R) / (ZIG_FULL_R - ZIG_MIN_R), 0, 1);
}

/** Shape-wobble strength: 0 below WOBBLE_MIN_R, at most WOBBLE_MAX. */
export function wobbleAmount(r: number): number {
  return WOBBLE_MAX * clamp((r - WOBBLE_MIN_R) / (WOBBLE_FULL_R - WOBBLE_MIN_R), 0, 1);
}

/**
 * Advances emitter `e`'s accumulator by `rate * dt` and returns how many bubbles
 * it emits this step (whole units taken from the accumulator), so the long-run
 * average is exactly `rate` per second.
 */
export function emitCount(acc: Float64Array, e: number, rate: number, dt: number): number {
  const a = acc[e] + Math.max(0, rate) * dt;
  const n = Math.floor(a);
  acc[e] = a - n;
  return n;
}

export interface BubbleMode {
  /** Liquid gradient, top and bottom; highlight colour. */
  top: string;
  bottom: string;
  light: string;
  /** Fraction of the count param this mode draws. */
  density: number;
  /** Radius multiplier on the size param, and the log-uniform spread around it. */
  sizeMul: number;
  sizeLo: number;
  sizeHi: number;
  /** Rise speed multiplier. */
  pace: number;
  /** Light-shaft strength multiplier. */
  shafts: number;
  /** Share of bubbles emitted from the streams when streams are on. */
  streamShare: number;
  /** Emitter x positions as fractions of the width, clear of the centre third. */
  emitters: readonly number[];
}

export const MODES: Record<string, BubbleMode> = {
  aquarium: {
    top: "#2a8a9a",
    bottom: "#04222f",
    light: "#e4fbff",
    density: 0.45,
    sizeMul: 1.6,
    sizeLo: 0.45,
    sizeHi: 1.7,
    pace: 0.9,
    shafts: 1,
    streamShare: 0.45,
    emitters: [0.08, 0.9],
  },
  champagne: {
    top: "#e2bd63",
    bottom: "#5e3f0c",
    light: "#fff7de",
    density: 1,
    sizeMul: 0.35,
    sizeLo: 0.75,
    sizeHi: 1.3,
    pace: 1.8,
    shafts: 0.45,
    streamShare: 0.85,
    emitters: [0.05, 0.13, 0.22, 0.79, 0.87, 0.95],
  },
  soda: {
    top: "#5c2a12",
    bottom: "#140603",
    light: "#ffe6cc",
    density: 0.8,
    sizeMul: 0.7,
    sizeLo: 0.3,
    sizeHi: 2,
    pace: 1.3,
    shafts: 0.3,
    streamShare: 0.4,
    emitters: [0.09, 0.2, 0.81, 0.92],
  },
};

/** Floats each bubble writes: x, y, semi-major (device px), opacity; softness, extent ratio; angle, flip. */
export const BUBBLE_FLOATS = 8;

/** Per-frame inputs to `step`; reuse one object rather than allocating per frame. */
export interface BubbleFrame {
  /** Screen width in reference px, and device px per reference px. */
  refWidth: number;
  scale: number;
  mode: BubbleMode;
  count: number;
  size: number;
  speed: number;
  streams: boolean;
}

export interface Bubbles {
  readonly xs: Float32Array;
  readonly ys: Float32Array;
  /** 1 while a stream bubble waits off-screen for its emitter. */
  readonly parked: Uint8Array;
  readonly life: Float32Array;
  /** Bubbles simulated: the count plus any still fading out after it dropped. */
  readonly live: number;
  /** Bubbles emitted by each stream so far. */
  readonly emitted: Float64Array;
  /** Each emitter's rate in the last step, in bubbles per second. */
  readonly rates: Float64Array;
  /** Bubbles the count asks for in the last step (count times the mode's density). */
  readonly target: number;
  /** Scales x positions by `k`, keeping bubbles in place relative to a resized width. */
  rescaleX(k: number): void;
  /**
   * Advances `dt` seconds and writes the visible bubbles to `data`, far to near,
   * BUBBLE_FLOATS at `stride` floats apart (the last two are the sprite's spin
   * pair). Returns how many.
   */
  step(dt: number, f: BubbleFrame, data: Float32Array, stride: number): number;
}

/** Apparent radius factor and opacity for depth `d` (0 far, 1 near). */
const depthScale = (d: number) => 0.5 + 0.5 * d;
const depthAlpha = (d: number) => 0.4 + 0.6 * d;
/** Edge softness (fraction of the radius) for depth `d`: far bubbles are blurred. */
const depthSoft = (d: number) => 0.3 * (1 - d) * (1 - d);

export function createBubbles(max: number, initialWidth: number, seed = 0xb0b1): Bubbles {
  const rng = createRng(seed);

  const xs = new Float32Array(max);
  const ys = new Float32Array(max);
  /** Uniform draw behind the size, so the size and mode params apply at once. */
  const sizeU = new Float32Array(max);
  /** `sizeU` mapped through the current mode's spread; rebuilt when the mode changes. */
  const sizeK = new Float32Array(max);
  let sizeMode: BubbleMode | undefined;
  /** Fixed per index; far to near draw order is sorted once below. */
  const depth = new Float32Array(max);
  /** Fixed per index: below the mode's stream share means a stream bubble. */
  const streamKey = new Float32Array(max);
  const zigPhase = new Float32Array(max);
  const zigRate = new Float32Array(max);
  const wobPhase = new Float32Array(max);
  const wobRate = new Float32Array(max);
  const paceJitter = new Float32Array(max);
  const parked = new Uint8Array(max);
  const life = new Float32Array(max);
  const emitAcc = new Float64Array(MAX_EMITTERS);
  const emitted = new Float64Array(MAX_EMITTERS);
  const rates = new Float64Array(MAX_EMITTERS);
  const perEmitter = new Float64Array(MAX_EMITTERS);
  const sizeSum = new Float64Array(MAX_EMITTERS);
  /** Rotating start of the search for a parked bubble, per emitter. */
  const cursor = new Int32Array(MAX_EMITTERS);

  let live = 0;
  let target = 0;
  /** Stream bubbles are laid along their streams on the first step, once the mode is known. */
  let primed = false;

  const spread = (i: number, m: BubbleMode) => {
    sizeK[i] = m.sizeMul * m.sizeLo * (m.sizeHi / m.sizeLo) ** sizeU[i];
  };
  const reroll = (i: number) => {
    sizeU[i] = rng();
    if (sizeMode) spread(i, sizeMode);
    zigPhase[i] = rng() * TAU;
    zigRate[i] = TAU * (0.35 + rng() * 0.3);
    wobPhase[i] = rng() * TAU;
    wobRate[i] = TAU * (0.6 + rng() * 0.5);
    paceJitter[i] = 0.85 + rng() * 0.3;
  };

  for (let i = 0; i < max; i++) {
    xs[i] = rng() * initialWidth;
    ys[i] = rng() * 1080;
    depth[i] = rng();
    // Golden-ratio steps spread any prefix of indices evenly over [0, 1).
    streamKey[i] = fract(i * 0.6180339887 + 0.31);
    reroll(i);
  }
  const order = Uint16Array.from({ length: max }, (_, i) => i).sort((a, b) => depth[a] - depth[b]);

  /** Radius at 1080p (before depth) for bubble `i`. */
  const baseRadius = (i: number, f: BubbleFrame) => f.size * sizeK[i];
  /** Emitter of bubble `i`, or -1 when it isn't a stream bubble. */
  const emitterOf = (i: number, f: BubbleFrame, n: number) => {
    const share = f.mode.streamShare;
    if (!f.streams || n === 0 || streamKey[i] >= share) return -1;
    return Math.min(n - 1, Math.floor((streamKey[i] / share) * n));
  };
  /** Stream bubbles share their emitter's depth, so a stream reads as one line. */
  const emitterDepth = (e: number) => 0.25 + 0.7 * fract(e * 0.382 + 0.2);

  return {
    xs,
    ys,
    parked,
    life,
    emitted,
    rates,
    get live() {
      return live;
    },
    get target() {
      return target;
    },
    rescaleX(k) {
      for (let i = 0; i < max; i++) xs[i] *= k;
    },
    step(dt, f, data, stride) {
      const { refWidth, scale, mode } = f;
      target = clamp(Math.round(f.count * mode.density), 1, max);
      const n = (live = growLive(life, live, target));
      const fadeStep = dt / FADE_IN;
      const outStep = dt / FADE_OUT;
      const nEmit = Math.min(MAX_EMITTERS, mode.emitters.length);
      const speed = Math.max(0, f.speed) * mode.pace;
      if (sizeMode !== mode) {
        sizeMode = mode;
        for (let i = 0; i < max; i++) spread(i, mode);
      }

      if (!primed) {
        primed = true;
        for (let i = 0; i < max; i++) {
          const e = emitterOf(i, f, nEmit);
          if (e >= 0) xs[i] = mode.emitters[e] * refWidth;
        }
      }

      // Each stream's rate: its bubbles divided by their mean time to cross the frame.
      perEmitter.fill(0);
      sizeSum.fill(0);
      for (let i = 0; i < target; i++) {
        const e = emitterOf(i, f, nEmit);
        if (e < 0) continue;
        perEmitter[e]++;
        sizeSum[e] += baseRadius(i, f) * depthScale(emitterDepth(e));
      }
      for (let e = 0; e < MAX_EMITTERS; e++) {
        rates[e] = 0;
        if (e >= nEmit || perEmitter[e] === 0 || speed <= 0) continue;
        const r = sizeSum[e] / perEmitter[e];
        const transit = (1080 + 4 * r) / (riseSpeed(r) * speed);
        rates[e] = (perEmitter[e] / transit) * EMIT_SLACK;
        for (let k = emitCount(emitAcc, e, rates[e], dt); k > 0; k--) {
          // The next parked bubble of this stream, if any is waiting.
          for (let s = 0; s < target; s++) {
            const i = (cursor[e] + s) % target;
            if (parked[i] === 0 || emitterOf(i, f, nEmit) !== e) continue;
            cursor[e] = i + 1;
            parked[i] = 0;
            reroll(i);
            const r0 = baseRadius(i, f) * depthScale(emitterDepth(e));
            xs[i] = mode.emitters[e] * refWidth + (rng() - 0.5) * 3;
            ys[i] = 1080 + r0 * 2;
            emitted[e]++;
            break;
          }
        }
      }

      let visible = 0;
      for (let k = 0; k < max; k++) {
        const i = order[k];
        if (i >= n) continue;
        const e = emitterOf(i, f, nEmit);
        const l = stepLife(life, i, target, fadeStep, outStep);
        if (parked[i] === 1) {
          if (e >= 0) continue;
          // No longer a stream bubble (streams off, or the mode changed): rejoin at random.
          parked[i] = 0;
          ys[i] = 1080 + 1080 * rng() * 0.3;
          xs[i] = rng() * refWidth;
        }
        const d = e >= 0 ? emitterDepth(e) : depth[i];
        const r = baseRadius(i, f) * depthScale(d);
        const zig = zigAmplitude(r);
        const wob = wobbleAmount(r);
        const extent = r * (1 + wob) + ZIG_PX;

        let y = ys[i] - riseSpeed(r) * speed * paceJitter[i] * dt;
        // Zigzag and wobble keep time with the rise, so speed 0 freezes the scene.
        const zp = zigPhase[i] + zigRate[i] * speed * dt;
        const wp = wobPhase[i] + wobRate[i] * speed * dt;
        zigPhase[i] = zp % TAU;
        wobPhase[i] = wp % TAU;
        if (y < -extent) {
          // Off the top: a stream bubble waits for its emitter, the others respawn below.
          reroll(i);
          if (e >= 0) {
            parked[i] = 1;
            ys[i] = 1080 + extent;
            continue;
          }
          xs[i] = rng() * refWidth;
          y = 1080 + extent + rng() * 60;
        }
        ys[i] = y;

        const alpha = depthAlpha(d) * l * l;
        if (alpha <= 0.003 || y > 1080 + extent) continue;
        const flat = wob * (0.7 + 0.3 * Math.sin(wp));
        const a = r * (1 + flat);
        const flip = 1 / ((1 + flat) * (1 + flat));
        const soft = depthSoft(d);
        const o = visible * stride;
        data[o] = (xs[i] + zig * Math.sin(zp)) * scale;
        data[o + 1] = y * scale;
        data[o + 2] = a * scale;
        data[o + 3] = alpha;
        data[o + 4] = soft;
        // Room for the soft edge and about 1.5 device px of anti-aliasing on the minor axis.
        data[o + 5] = 1 + soft + 1.5 / Math.max(0.5, a * flip * scale);
        // The squash is applied to x, so turn a quarter for a flattened (wide) bubble,
        // and tilt it with the zigzag.
        data[o + 6] = wob > 0 ? Math.PI / 2 + (WOBBLE_TILT * wob * Math.cos(zp)) / WOBBLE_MAX : 0;
        data[o + 7] = flip;
        visible++;
      }

      live = trimLive(life, live, target);
      return visible;
    },
  };
}
