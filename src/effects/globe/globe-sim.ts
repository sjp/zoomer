/**
 * Pure JS side of the Snow Globe effect (globe.ts): the globe's layout in its
 * corner, the flake simulation inside it, the shake's nudge, and the scenes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, as in mug-sim.ts. The flakes live in "globe units":
 * centred on the sphere's centre and scaled by its radius, so the inside of the
 * glass is the unit disc whatever the globe's size or the canvas.
 */
import type { GlobeSceneId } from "./globe.meta";
import { lookup } from "../lookup";
import { clamp } from "../math";
import { createRng } from "../noise";

/** Sphere radius at size 1 (height units), and the size param's bounds. */
export const GLOBE_R = 0.13;
export const SIZE_RANGE = [0.7, 1.2] as const;
/** The shelf's front edge and the wall line behind it (height units). */
export const SHELF_FRONT_Y = 0.07;
export const SHELF_BACK_Y = 0.17;
/** Where the base's bottom ellipse sits on the shelf (height units). */
export const BASE_SEAT_Y = 0.11;

/*
 * Globe-unit geometry, shared with the shaders. The base is a slightly tapered
 * wooden drum seen a little from above: its top and bottom are ellipses of
 * ratio BASE_K, and the sphere sits in the top one.
 */
export const BASE_TOP = -0.78;
export const BASE_BOT = -1.22;
export const BASE_TW = 0.7;
export const BASE_BW = 0.84;
export const BASE_K = 0.22;
/** Shadow on the shelf: centre offset (towards the inner side), radii and edge softness. */
export const SHADOW_DX = -0.24;
export const SHADOW_RX = 1.05;
export const SHADOW_RY = 0.2;
export const SHADOW_SOFT = 0.12;

/** The snow mound inside: its height at the glass and its rise in the middle. */
export const MOUND_BASE = -0.45;
export const MOUND_RISE = 0.15;
/** Flake centres stay inside this radius (globe units): the glass's inner wall. */
export const FLAKE_DISC = 0.93;

/** Mound surface height (globe units) at `x`. */
export function moundY(x: number): number {
  return MOUND_BASE + MOUND_RISE * (1 - x * x);
}

/** Distance of the globe's centre from its frame edge: a margin plus this many radii. */
const EDGE_MARGIN = 0.04;
const EDGE_RADII = 1.05;
/** Largest shake nudge (height units): a few pixels at 1080p. */
export const NUDGE = 5 / 1080;
/** Slack around the box for the antialiased edges (height units). */
const BOX_PAD = 0.004;

interface GlobeLayout {
  /** Outer direction: +1 if the globe is in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Sphere radius, centre x and y (height units), at rest. */
  r: number;
  cx: number;
  cy: number;
  /** Globe pass bounds, nudge included: x0, y0, x1, y1 (height units). */
  box: [number, number, number, number];
}

export const createLayout = (): GlobeLayout => ({
  side: 1,
  r: GLOBE_R,
  cx: 0,
  cy: 0,
  box: [0, 0, 0, 0],
});

/** The sphere radius (height units) for a `size` param value. */
export function globeRadius(size: number): number {
  const s = Number.isFinite(size) ? size : 1;
  return GLOBE_R * clamp(s, SIZE_RANGE[0], SIZE_RANGE[1]);
}

/** Lays the globe out in its corner of an `aspect`-wide frame. */
export function globeLayout(
  aspect: number,
  position: string,
  size: number,
  out: GlobeLayout,
): GlobeLayout {
  const side = position === "left" ? -1 : 1;
  const r = globeRadius(size);
  const edge = EDGE_MARGIN + EDGE_RADII * r;
  const a = Math.max(Number.isFinite(aspect) ? aspect : 1, 2 * edge);
  out.side = side;
  out.r = r;
  out.cx = side > 0 ? a - edge : edge;
  out.cy = BASE_SEAT_Y - BASE_BOT * r;
  // Local x runs towards the outer side; the shadow falls inwards.
  const pad = BOX_PAD + NUDGE;
  const outer = r * Math.max(1, BASE_BW) + pad;
  const inner = r * (-SHADOW_DX + SHADOW_RX + SHADOW_SOFT) + pad;
  out.box[0] = out.cx - (side > 0 ? inner : outer);
  out.box[1] = out.cy + r * (BASE_BOT - SHADOW_RY - SHADOW_SOFT) - pad;
  out.box[2] = out.cx + (side > 0 ? outer : inner);
  out.box[3] = out.cy + r + pad;
  return out;
}

/** Shake impulse: upward speed range and sideways spread (globe units/s). */
const SHAKE_UP = [0.5, 1.5] as const;
const SHAKE_SIDE = 0.7;
/** Swirl speed per unit of distance from the vortex centre just after a shake (1/s), and its decay time (s). */
const SWIRL_START = 1;
const SWIRL_DECAY = 3;
/** Vortex centre (globe units), and the noise flow's share of the swirl. */
const VORTEX_Y = 0.15;
const SWIRL_NOISE = 0.5;
/** Share of the settling speed the swirl cancels just after a shake (below 1). */
const SWIRL_HOLD = 0.85;
/** Height above the mound (globe units) over which the swirl's vertical flow fades out. */
const MOUND_FLOW = 0.3;
/**
 * Flakes that reach the mound settle only once the swirl rate is below this
 * (1/s), scaled per flake to 0.25..1 times it.
 */
const SETTLE_SWIRL = 0.3;
/** Drag rate (1/s): how fast a flake takes up the water's speed. */
const DRAG = 2.2;
/** Settling speed range in still water (globe units/s). */
const FALL = [0.09, 0.16] as const;
/** How much speed into the glass a flake keeps, reflected. */
const RESTITUTION = 0.3;
/** Largest integration step (s). */
const MAX_STEP = 1 / 30;
/** Shortest time between automatic shakes (s). */
export const MIN_INTERVAL = 5;
/** Flake radius (globe units) and opacity ranges. */
export const FLAKE_R = [0.01, 0.022] as const;
const FLAKE_ALPHA = [0.65, 1] as const;

/** Nudge: frequency (Hz), decay time and cut-off (s). */
const NUDGE_HZ = 4;
const NUDGE_DECAY = 0.18;
export const NUDGE_TIME = 1;

interface Snow {
  readonly count: number;
  /** Position and velocity, globe units (x to the right, y up). */
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  /** 1 while a flake rests on the mound. */
  readonly settled: Uint8Array;
  /** Per-flake settling speed, noise phase, radius (globe units) and opacity. */
  readonly fall: Float64Array;
  readonly phase: Float64Array;
  readonly radius: Float32Array;
  readonly alpha: Float32Array;
  /** Seconds since the last shake, and since the last nudge (Infinity: none). */
  sinceShake: number;
  nudgeAge: number;
  /** Swirl direction after the last shake (+1 anticlockwise). */
  spin: number;
  readonly rng: () => number;
}

/** `count` flakes resting on the mound, deterministic per `seed`. */
export function createSnow(seed: number, count: number): Snow {
  const n = Math.max(0, Math.floor(count));
  const rng = createRng(seed);
  const s: Snow = {
    count: n,
    x: new Float64Array(n),
    y: new Float64Array(n),
    vx: new Float64Array(n),
    vy: new Float64Array(n),
    settled: new Uint8Array(n),
    fall: new Float64Array(n),
    phase: new Float64Array(n),
    radius: new Float32Array(n),
    alpha: new Float32Array(n),
    sinceShake: Infinity,
    nudgeAge: Infinity,
    spin: 1,
    rng,
  };
  // Where the mound meets the flakes' disc.
  const edge = moundEdge();
  for (let i = 0; i < n; i++) {
    const x = (rng() * 2 - 1) * edge;
    s.x[i] = x;
    s.y[i] = moundY(x);
    s.settled[i] = 1;
    s.fall[i] = FALL[0] + (FALL[1] - FALL[0]) * rng();
    s.phase[i] = rng() * Math.PI * 2;
    s.radius[i] = FLAKE_R[0] + (FLAKE_R[1] - FLAKE_R[0]) * rng() ** 2;
    s.alpha[i] = FLAKE_ALPHA[0] + (FLAKE_ALPHA[1] - FLAKE_ALPHA[0]) * rng();
  }
  return s;
}

/** |x| where the mound surface meets the circle of radius FLAKE_DISC. */
export function moundEdge(): number {
  // Bisection on x^2 + moundY(x)^2 = FLAKE_DISC^2, which grows with x on [0, 1].
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 40; k++) {
    const mid = 0.5 * (lo + hi);
    const m = moundY(mid);
    if (mid * mid + m * m < FLAKE_DISC * FLAKE_DISC) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * Shakes the globe: every flake lifts off with a random upward and sideways
 * kick, and the swirl restarts in a random direction. With `nudge` the globe
 * also jiggles for a moment (see `globeNudge`).
 */
export function shakeSnow(s: Snow, nudge = true): void {
  const rng = s.rng;
  s.sinceShake = 0;
  if (nudge) {
    s.nudgeAge = 0;
  }
  s.spin = rng() < 0.5 ? -1 : 1;
  for (let i = 0; i < s.count; i++) {
    s.settled[i] = 0;
    s.vx[i] += (rng() * 2 - 1) * SHAKE_SIDE;
    s.vy[i] += SHAKE_UP[0] + (SHAKE_UP[1] - SHAKE_UP[0]) * rng();
  }
}

/** Swirl rate (1/s, signed) at `t` seconds after a shake. */
export function swirlAt(t: number, spin: number): number {
  return Number.isFinite(t) ? spin * SWIRL_START * Math.exp(-t / SWIRL_DECAY) : 0;
}

/**
 * Advances the snow by `dt` seconds. Shakes first when `interval` seconds (at
 * least MIN_INTERVAL; 0 or less: never) have passed since the last shake.
 * Returns true if it shook.
 */
export function stepSnow(s: Snow, dt: number, interval: number): boolean {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  s.sinceShake += step;
  s.nudgeAge += step;
  let shook = false;
  if (
    Number.isFinite(interval) &&
    interval > 0 &&
    s.sinceShake >= Math.max(interval, MIN_INTERVAL)
  ) {
    shakeSnow(s);
    shook = true;
  }
  if (step === 0) {
    return shook;
  }
  const n = Math.ceil(step / MAX_STEP);
  const h = step / n;
  const keep = Math.exp(-DRAG * h);
  const d2 = FLAKE_DISC * FLAKE_DISC;
  // Sub-step times, counted back from now; swirl and noise phase per sub-step.
  for (let k = 0; k < n; k++) {
    const t = Math.max(0, s.sinceShake - step + (k + 1) * h);
    const w = swirlAt(t, s.spin);
    const aw = Math.abs(w) * SWIRL_NOISE;
    // The churned water holds the flakes up at first.
    const fall = 1 - (SWIRL_HOLD * Math.abs(w)) / SWIRL_START;
    for (let i = 0; i < s.count; i++) {
      if (s.settled[i]) {
        continue;
      }
      let x = s.x[i];
      let y = s.y[i];
      const ph = s.phase[i];
      // The water's speed here: a vortex, a little noise, and the flake's own settling.
      const fx = -w * (y - VORTEX_Y) + aw * Math.sin(2.3 * y + 1.7 * t + ph);
      // The flow turns along the mound rather than into it.
      let fy = w * x + aw * Math.sin(2.9 * x - 1.3 * t + 1.7 * ph);
      if (fy < 0) {
        fy *= Math.min(1, (y - moundY(x)) * (1 / MOUND_FLOW));
      }
      fy -= s.fall[i] * fall;
      let vx = fx + (s.vx[i] - fx) * keep;
      let vy = fy + (s.vy[i] - fy) * keep;
      x += vx * h;
      y += vy * h;
      const r2 = x * x + y * y;
      if (r2 > d2) {
        const r = Math.sqrt(r2);
        const nx = x / r;
        const ny = y / r;
        x = nx * FLAKE_DISC;
        y = ny * FLAKE_DISC;
        const vn = vx * nx + vy * ny;
        if (vn > 0) {
          vx -= (1 + RESTITUTION) * vn * nx;
          vy -= (1 + RESTITUTION) * vn * ny;
        }
      }
      const m = moundY(x);
      if (y <= m) {
        // Moving up to the surface only brings it closer to the centre.
        y = m;
        // Each flake's own threshold, so they don't all settle at the same moment.
        if (Math.abs(w) < SETTLE_SWIRL * (0.25 + (0.75 / (Math.PI * 2)) * ph)) {
          vx = 0;
          vy = 0;
          s.settled[i] = 1;
        } else if (vy < 0) {
          // Still churning: swept along the surface, to lift off again.
          vy = 0;
        }
      }
      s.x[i] = x;
      s.y[i] = y;
      s.vx[i] = vx;
      s.vy[i] = vy;
    }
  }
  return shook;
}

/**
 * The globe's offset (height units) during a shake's nudge, written to `out`
 * (x, y): a few quick, fading wobbles, then exactly 0.
 */
export function globeNudge(s: Snow, out: Float64Array | number[]): void {
  const t = s.nudgeAge;
  if (!(t >= 0 && t < NUDGE_TIME)) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const fade = Math.exp(-t / NUDGE_DECAY) * (1 - t / NUDGE_TIME);
  out[0] = NUDGE * fade * Math.sin(2 * Math.PI * NUDGE_HZ * t);
  out[1] = 0.4 * NUDGE * fade * Math.sin(2 * Math.PI * NUDGE_HZ * 1.3 * t);
}

/** Floats per flake in `writeFlakes`' output: centre x, y, radius (height units), opacity. */
export const FLAKE_STRIDE = 4;

/**
 * Writes the first `count` flakes' sprites in height units, for a globe at
 * `layout` moved by `nudge`. Returns how many it wrote.
 */
export function writeFlakes(
  s: Snow,
  layout: GlobeLayout,
  nudge: ArrayLike<number>,
  count: number,
  out: Float32Array,
): number {
  const n = Math.max(
    0,
    Math.min(s.count, Math.floor(out.length / FLAKE_STRIDE), Math.floor(count) || 0),
  );
  const r = layout.r;
  const cx = layout.cx + nudge[0];
  const cy = layout.cy + nudge[1];
  for (let i = 0; i < n; i++) {
    const o = i * FLAKE_STRIDE;
    out[o] = cx + s.x[i] * r;
    out[o + 1] = cy + s.y[i] * r;
    out[o + 2] = s.radius[i] * r;
    out[o + 3] = s.alpha[i];
  }
  return n;
}

/** The scene shader's branch for a select value; unknown values fall back to the cabin. */
export const SCENES: Readonly<Record<GlobeSceneId, number>> = {
  cabin: 0,
  village: 1,
  lighthouse: 2,
};

export function sceneKind(id: string): number {
  return lookup(SCENES, id, "cabin");
}
