/**
 * Pure JS parts of the hot-air balloons effect (balloons.ts): the balloon colour
 * palettes and light settings, the depth curves (size, speed, haze, altitude),
 * the balloons themselves drifting on wrapped tracks with a slow altitude random
 * walk and burner timers, and the balloon outline. Nothing here touches GL, so it
 * is all unit tested.
 *
 * Units: "height units", where the canvas is 1 tall and `aspect` wide, with y up
 * from the bottom edge (matching `gl_FragCoord / height`). Depth 0 is the
 * nearest balloon, 1 the farthest. Balloon shapes are in "radius units", where
 * the envelope's round top is the unit circle centred on the origin, y up.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { approach, clamp, smoothstep, wrap } from "./math";
import { createRng } from "./noise";
import { MAX_BALLOONS, MIN_BALLOONS } from "./balloons.meta";

const TAU = Math.PI * 2;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

// ---------------------------------------------------------------------------
// Shape (radius units)
// ---------------------------------------------------------------------------

/** Apex of the cone the envelope's lower half tapers along (below the mouth). */
export const APEX_Y = -2;
/** sin and cos of the cone's half-angle: its sides are tangent to the unit circle. */
export const CONE_SIN = 1 / -APEX_Y;
export const CONE_COS = Math.sqrt(1 - CONE_SIN * CONE_SIN);
/** Height where the cone's sides touch the circle. */
export const TANGENT_Y = -CONE_SIN;
/** The envelope's open mouth, where the burner sits. */
export const MOUTH_Y = -1.55;
/** Half-width of the mouth. */
export const MOUTH_HALF = ((MOUTH_Y - APEX_Y) * CONE_SIN) / CONE_COS;
/** The basket: top, bottom and half-width. */
export const BASKET_TOP = -1.92;
export const BASKET_BOTTOM = -2.2;
export const BASKET_HALF = 0.16;

/**
 * The convex outline every balloon is drawn in (radius units, clockwise with y up):
 * the envelope's bounding box with its top corners cut and its sides tapering in
 * to the basket, so few fragments outside the balloon are shaded.
 */
export const OUTLINE: readonly (readonly [number, number])[] = [
  [-0.45, 1.05],
  [0.45, 1.05],
  [1.05, 0.45],
  [1.05, -0.3],
  [0.3, -2.3],
  [-0.3, -2.3],
  [-1.05, -0.3],
  [-1.05, 0.45],
];

/** `OUTLINE` as a triangle strip (zigzag 0, 1, n-1, 2, n-2, ...), for the sprite batch. */
export const BALLOON_STRIP: readonly number[] = (() => {
  const n = OUTLINE.length;
  const out = [...OUTLINE[0]];
  for (let lo = 1, hi = n - 1; lo <= hi; lo++, hi--) {
    out.push(...OUTLINE[lo]);
    if (hi !== lo) out.push(...OUTLINE[hi]);
  }
  return out;
})();

/**
 * Half-width of a balloon's drawn footprint in radii, with room for the
 * anti-aliasing margin the vertex shader adds: once a balloon's centre is this
 * many radii past an edge, nothing of it shows.
 */
export const EXTENT = 1.15;

// ---------------------------------------------------------------------------
// Palettes and light
// ---------------------------------------------------------------------------

/** Colours per balloon palette; each balloon picks 2 or 3 of them. */
export const PALETTE_SIZE = 6;

const colors = (...hex: string[]): readonly Rgb[] => hex.map(hexToUnitRgb);

export const PALETTES = {
  classic: colors("#d8352c", "#f2c230", "#2a58a8", "#f4efe4", "#2e8a4e", "#e8722a"),
  pastel: colors("#f2abbb", "#a9d2e8", "#f6e09a", "#bfe0b8", "#d4bdea", "#f9c8a3"),
  rainbow: colors("#e5383b", "#f48c2c", "#f7d038", "#4cae4f", "#2f7fd0", "#7b4bb5"),
  mono: colors("#f3f0ea", "#d4d0c8", "#a8a49d", "#7e7b76", "#5a5854", "#bdb9b2"),
} as const satisfies Record<string, readonly Rgb[]>;

/** The palette for a select value; unknown values fall back to classic. */
export function paletteFor(id: string): readonly Rgb[] {
  return Object.hasOwn(PALETTES, id) ? PALETTES[id as keyof typeof PALETTES] : PALETTES.classic;
}

export interface LightSetting {
  /** Sky at the top of the canvas and at the horizon; distant things haze towards the horizon. */
  zenith: Rgb;
  horizon: Rgb;
  /** Colour and strength of the glow around the sun. */
  glow: Rgb;
  glowStrength: number;
  sun: Rgb;
  /** Sun centre: x as a fraction of the width, y in height units (above 1 is off the top). */
  sunX: number;
  sunY: number;
  /** Colour multipliers on the sunlit and shaded sides of balloons and hills. */
  lit: Rgb;
  shade: Rgb;
  /** Unit vector towards the sun: x right, y up, z towards the viewer. */
  dir: readonly [number, number, number];
  /** Daylight colours of the back and front hill layers. */
  hillBack: Rgb;
  hillFront: Rgb;
  mist: Rgb;
}

const normalize = (x: number, y: number, z: number): [number, number, number] => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
};

const light = (
  zenith: string,
  horizon: string,
  glow: string,
  glowStrength: number,
  sun: string,
  sunX: number,
  sunY: number,
  lit: string,
  shade: string,
  dir: [number, number, number],
  hillBack: string,
  hillFront: string,
  mist: string,
): LightSetting => ({
  zenith: hexToUnitRgb(zenith),
  horizon: hexToUnitRgb(horizon),
  glow: hexToUnitRgb(glow),
  glowStrength,
  sun: hexToUnitRgb(sun),
  sunX,
  sunY,
  lit: hexToUnitRgb(lit),
  shade: hexToUnitRgb(shade),
  dir: normalize(...dir),
  hillBack: hexToUnitRgb(hillBack),
  hillFront: hexToUnitRgb(hillFront),
  mist: hexToUnitRgb(mist),
});

export const LIGHTS = {
  morning: light(
    "#86aad6",
    "#f5dcc0",
    "#ffd8a0",
    0.55,
    "#fff4dc",
    0.18,
    0.47,
    "#fff2de",
    "#76809c",
    [-0.8, 0.3, 0.55],
    "#a3b6a8",
    "#4f7a4a",
    "#f3e8de",
  ),
  midday: light(
    "#5592d8",
    "#d3e5f2",
    "#fffbea",
    0.3,
    "#ffffff",
    0.62,
    1.2,
    "#ffffff",
    "#7d8ca8",
    [0.25, 0.85, 0.45],
    "#98baa2",
    "#3f7a3c",
    "#eef3f6",
  ),
  evening: light(
    "#5d6aa6",
    "#f6b98e",
    "#ffad6a",
    0.6,
    "#ffe2b6",
    0.82,
    0.46,
    "#ffd7aa",
    "#5e5878",
    [0.8, 0.25, 0.55],
    "#a0939b",
    "#4b5b45",
    "#eccbb9",
  ),
} as const satisfies Record<string, LightSetting>;

/** The light setting for a select value; unknown values fall back to morning. */
export function lightFor(id: string): LightSetting {
  return Object.hasOwn(LIGHTS, id) ? LIGHTS[id as keyof typeof LIGHTS] : LIGHTS.morning;
}

/** Shape of the rolling valley hills, for `buildHills` in `horizon-sim.ts`. */
export const HILL_SHAPE = { amp: 0.9, ridge: 0, freq: 0.75 } as const;
/** Hill layers behind the balloons. */
export const HILL_LAYERS = 3;

/**
 * Writes the colour of hill layer `l` of `n` (0 = back) under `light` into `out`:
 * the daylight colour for its depth, tinted by the light, then hazed towards the
 * horizon sky more the farther back it is (atmospheric perspective).
 */
export function hillColor(out: Rgb, light: LightSetting, l: number, n: number): Rgb {
  const depth = n > 1 ? l / (n - 1) : 1;
  const haze = 0.62 * (1 - depth) ** 1.2;
  for (let c = 0; c < 3; c++) {
    const base = mix(light.hillBack[c], light.hillFront[c], depth);
    const lit = base * mix(light.shade[c], light.lit[c], 0.8);
    out[c] = mix(lit, light.horizon[c], haze);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Depth curves
// ---------------------------------------------------------------------------

/** Envelope radius of the nearest and farthest balloons, height units. */
const NEAR_RADIUS = 0.085;
const FAR_RADIUS = 0.022;
/** Drift speed of the nearest and farthest balloons at a drift of 1, height units per second. */
const NEAR_SPEED = 0.011;
const FAR_SPEED = 0.004;
/** How far the nearest and farthest balloons fade towards the horizon sky. */
const NEAR_HAZE = 0.03;
const FAR_HAZE = 0.55;

/** Envelope radius at `depth`, height units: smaller farther away. */
export const balloonRadius = (depth: number) => mix(NEAR_RADIUS, FAR_RADIUS, clamp(depth, 0, 1));
/** Drift speed at `depth` per unit of drift, height units per second: slower farther away. */
export const balloonSpeed = (depth: number) => mix(NEAR_SPEED, FAR_SPEED, clamp(depth, 0, 1));
/** Haze at `depth`, 0..1: more farther away. */
export const balloonHaze = (depth: number) => mix(NEAR_HAZE, FAR_HAZE, clamp(depth, 0, 1) ** 0.9);

/**
 * Lowest and highest envelope-centre heights at `depth`. Far balloons stay above
 * the back hills; near ones may sink lower, in front of them.
 */
export const altitudeLow = (depth: number) => mix(0.4, 0.58, clamp(depth, 0, 1));
export const altitudeHigh = (depth: number) => mix(0.73, 0.84, clamp(depth, 0, 1));

/** Extra speed in the centre third of the frame (where the speaker sits), as a fraction. */
export const CENTRE_BOOST = 0.8;

/**
 * Speed multiplier at `x` on a canvas `aspect` wide: 1 + CENTRE_BOOST across the
 * centre third, easing back to 1 at the edges, so no balloon lingers behind the
 * speaker's head.
 */
export function centreBoost(x: number, aspect: number): number {
  const off = Math.abs(x - aspect / 2);
  return 1 + CENTRE_BOOST * (1 - smoothstep(aspect / 6, aspect / 2, off));
}

/** Left end of a balloon's wrapped track, height units: off-screen by its extent plus its gap. */
export const trackLow = (radius: number, gap: number) => -EXTENT * radius - gap;
/** Length of a balloon's wrapped track: the screen, its extent on both sides, and its gap. */
export const trackSpan = (radius: number, gap: number, aspect: number) =>
  aspect + 2 * EXTENT * radius + gap;

// ---------------------------------------------------------------------------
// Balloons
// ---------------------------------------------------------------------------

/** Gap a balloon spends fully off-screen between leaving and coming back, height units. */
const GAP_MIN = 0.15;
const GAP_MAX = 0.9;
/** Steepest climb or descent, in envelope radii per second. */
const CLIMB_RADII = 0.05;
/** Seconds the vertical speed takes to swing from zero to its fastest. */
const CLIMB_EASE = 5;
/** Seconds between new climb targets. */
export const RETARGET_MIN = 8;
export const RETARGET_MAX = 20;
/** Seconds between burns, and the length of a burn. */
export const BURN_GAP_MIN = 10;
export const BURN_GAP_MAX = 30;
export const BURN_MIN = 1.2;
export const BURN_MAX = 2.4;
/** Seconds a balloon takes to fade in or out when the count changes. */
export const FADE_TIME = 2;
/** Slowest and fastest envelope spin, radians per second. */
const SPIN_MIN = 0.015;
const SPIN_MAX = 0.04;

/** Clamps a `count` param to a whole number of balloons. */
export const balloonCount = (count: number) =>
  clamp(Math.round(Number.isFinite(count) ? count : MIN_BALLOONS), MIN_BALLOONS, MAX_BALLOONS);

/** Fastest climb or descent at `depth`, height units per second. */
export const climbSpeed = (depth: number) => CLIMB_RADII * balloonRadius(depth);

/** Burner glow 0..1, `age` seconds into a burn `len` seconds long (age < 0: not burning). */
export function burnGlow(age: number, len: number): number {
  if (!(age >= 0)) return 0;
  return smoothstep(0, 0.3, age) * smoothstep(0, 0.6, len - age);
}

export interface Balloons {
  /** Canvas aspect the positions were last laid out for. */
  aspect: number;
  /** Shared wind direction: +1 drifting right, -1 left. */
  readonly dir: number;
  /** Per balloon (`MAX_BALLOONS` each). */
  readonly depth: Float64Array;
  readonly gap: Float64Array;
  /** Envelope centre, height units. */
  readonly x: Float64Array;
  readonly y: Float64Array;
  /** Vertical speed and the speed it is easing towards, height units per second. */
  readonly vy: Float64Array;
  readonly vyTarget: Float64Array;
  /** Seconds until the next climb target. */
  readonly retarget: Float64Array;
  /** Seconds until the next burn, while not burning. */
  readonly burnTimer: Float64Array;
  /** Seconds into the current burn, or -1. */
  readonly burnAge: Float64Array;
  readonly burnLen: Float64Array;
  /** Fade 0..1 as the count changes. */
  readonly presence: Float64Array;
  /** Envelope rotation (radians, wrapped to [0, 2π)) and its rate. */
  readonly spin: Float64Array;
  readonly spinRate: Float64Array;
  /** Palette indices of each balloon's gore colours, 3 per balloon (the third repeats the first for 2-colour balloons). */
  readonly colors: Uint8Array;
  readonly colorCount: Uint8Array;
  /** Gores around the full envelope: a multiple of `colorCount`, so the pattern closes. */
  readonly gores: Uint8Array;
  /** Balloon indices sorted farthest first: the fixed draw order. */
  readonly order: Int32Array;
  /** The balloons' own random stream, seeded once. */
  readonly rand: () => number;
}

const randIn = (rand: () => number, lo: number, hi: number) => lo + (hi - lo) * rand();

/**
 * `MAX_BALLOONS` balloons for `seed` on a canvas `aspect` wide. Balloon `i`'s
 * depth comes from a golden-ratio sequence, so any first `count` of them spread
 * over near and far. Each starts at a random place on its track, never in the
 * centre third, at a random height in its band. Deterministic per seed.
 */
export function createBalloons(seed: number, aspect: number): Balloons {
  const rand = createRng(Math.floor(seed) * 6151 + 389);
  const n = MAX_BALLOONS;
  const f64 = () => new Float64Array(n);
  const b: Balloons = {
    aspect,
    dir: rand() < 0.5 ? -1 : 1,
    depth: f64(),
    gap: f64(),
    x: f64(),
    y: f64(),
    vy: f64(),
    vyTarget: f64(),
    retarget: f64(),
    burnTimer: f64(),
    burnAge: f64(),
    burnLen: f64(),
    presence: f64(),
    spin: f64(),
    spinRate: f64(),
    colors: new Uint8Array(n * 3),
    colorCount: new Uint8Array(n),
    gores: new Uint8Array(n),
    order: new Int32Array(n),
    rand,
  };
  const phase = rand();
  for (let i = 0; i < n; i++) {
    const d = clamp(((phase + i * 0.6180339887) % 1) + (rand() - 0.5) * 0.08, 0, 1);
    b.depth[i] = d;
    b.gap[i] = randIn(rand, GAP_MIN, GAP_MAX);
    const r = balloonRadius(d);
    const lo = trackLow(r, b.gap[i]);
    const span = trackSpan(r, b.gap[i], aspect);
    let x = lo + rand() * span;
    if (x > aspect / 3 && x < (2 * aspect) / 3) x = wrap(x + (b.dir * aspect) / 3, lo, span);
    b.x[i] = x;
    b.y[i] = randIn(rand, altitudeLow(d), altitudeHigh(d));
    b.vyTarget[i] = (rand() * 2 - 1) * climbSpeed(d);
    b.vy[i] = b.vyTarget[i];
    b.retarget[i] = randIn(rand, RETARGET_MIN, RETARGET_MAX);
    b.burnTimer[i] = randIn(rand, 2, BURN_GAP_MAX);
    b.burnAge[i] = -1;
    b.burnLen[i] = BURN_MIN;
    b.spin[i] = rand() * TAU;
    b.spinRate[i] = (rand() < 0.5 ? -1 : 1) * randIn(rand, SPIN_MIN, SPIN_MAX);
    // 2 or 3 distinct palette colours.
    const k = rand() < 0.55 ? 2 : 3;
    const first = Math.floor(rand() * PALETTE_SIZE);
    const second = (first + 1 + Math.floor(rand() * (PALETTE_SIZE - 1))) % PALETTE_SIZE;
    let third = first;
    if (k === 3) {
      third = Math.floor(rand() * PALETTE_SIZE);
      while (third === first || third === second) third = (third + 1) % PALETTE_SIZE;
    }
    b.colors[i * 3] = first;
    b.colors[i * 3 + 1] = second;
    b.colors[i * 3 + 2] = third;
    b.colorCount[i] = k;
    b.gores[i] = k * (k === 2 ? 6 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 2));
  }
  for (let i = 0; i < n; i++) b.order[i] = i;
  b.order.sort((p, q) => b.depth[q] - b.depth[p]);
  return b;
}

/** A new climb target: random, pulled back towards the middle of the band. */
function newTarget(b: Balloons, i: number): number {
  const d = b.depth[i];
  const lo = altitudeLow(d);
  const hi = altitudeHigh(d);
  const pos = ((b.y[i] - lo) / (hi - lo)) * 2 - 1;
  const v = climbSpeed(d);
  return clamp(v * (b.rand() * 2 - 1 - 0.8 * pos), -v, v);
}

/**
 * Advances every balloon (active or not, so one fading back in carries on where
 * it would be) by `dt` seconds on a canvas `aspect` wide: drift along its track at
 * `drift` times its depth's speed, wrapping only while fully off-screen; fade
 * in or out with `count`; ease towards its climb target and stay in its band;
 * and run its burner, which starts a climb whenever it fires.
 */
export function stepBalloons(
  b: Balloons,
  dt: number,
  aspect: number,
  drift: number,
  count: number,
): void {
  const active = balloonCount(count);
  const resized = aspect !== b.aspect;
  for (let i = 0; i < MAX_BALLOONS; i++) {
    const d = b.depth[i];
    const r = balloonRadius(d);
    const lo = trackLow(r, b.gap[i]);
    const span = trackSpan(r, b.gap[i], aspect);
    if (resized) {
      // Keep each balloon at the same fraction of its track.
      const oldSpan = trackSpan(r, b.gap[i], b.aspect);
      b.x[i] = lo + ((b.x[i] - lo) * span) / oldSpan;
    }
    b.presence[i] = approach(b.presence[i], i < active ? 1 : 0, dt / FADE_TIME);

    const speed = balloonSpeed(d) * Math.max(0, drift) * centreBoost(b.x[i], aspect);
    b.x[i] = wrap(b.x[i] + b.dir * speed * dt, lo, span);

    // Burner: fires every so often, and the balloon climbs after it.
    if (b.burnAge[i] >= 0) {
      b.burnAge[i] += dt;
      if (b.burnAge[i] >= b.burnLen[i]) b.burnAge[i] = -1;
    } else {
      b.burnTimer[i] -= dt;
      if (b.burnTimer[i] <= 0) {
        b.burnAge[i] = 0;
        b.burnLen[i] = randIn(b.rand, BURN_MIN, BURN_MAX);
        b.burnTimer[i] = randIn(b.rand, BURN_GAP_MIN, BURN_GAP_MAX);
        b.vyTarget[i] = climbSpeed(d);
        b.retarget[i] = RETARGET_MIN;
      }
    }

    // Altitude: a slow random walk on the climb rate, kept inside the band.
    b.retarget[i] -= dt;
    if (b.retarget[i] <= 0) {
      b.vyTarget[i] = newTarget(b, i);
      b.retarget[i] = randIn(b.rand, RETARGET_MIN, RETARGET_MAX);
    }
    const climb = climbSpeed(d);
    b.vy[i] = approach(b.vy[i], b.vyTarget[i], (climb / CLIMB_EASE) * dt);
    const y = b.y[i] + b.vy[i] * dt;
    const yLo = altitudeLow(d);
    const yHi = altitudeHigh(d);
    if (y > yHi) {
      b.y[i] = yHi;
      b.vy[i] = Math.min(b.vy[i], 0);
      b.vyTarget[i] = -0.5 * climb;
    } else if (y < yLo) {
      b.y[i] = yLo;
      b.vy[i] = Math.max(b.vy[i], 0);
      b.vyTarget[i] = 0.5 * climb;
    } else {
      b.y[i] = y;
    }

    b.spin[i] = wrap(b.spin[i] + b.spinRate[i] * dt, 0, TAU);
  }
  b.aspect = aspect;
}

/**
 * Floats per balloon instance: centre x, y (px, y up), radius (px), opacity;
 * colour A, haze; colour B, burner glow; colour C, gores; spin, colour count.
 */
export const BALLOON_FLOATS = 18;

/**
 * Writes the visible balloons as instances into `out` (`BALLOON_FLOATS` each),
 * farthest first, for a canvas `height` px tall, with gore colours from
 * `palette`. Burner glow is zero when `burners` is off. Returns the count.
 */
export function writeBalloons(
  b: Balloons,
  out: Float32Array,
  palette: readonly Rgb[],
  height: number,
  burners: boolean,
): number {
  let n = 0;
  for (let k = 0; k < MAX_BALLOONS; k++) {
    const i = b.order[k];
    if (!(b.presence[i] > 0)) continue;
    const d = b.depth[i];
    const o = n * BALLOON_FLOATS;
    out[o] = b.x[i] * height;
    out[o + 1] = b.y[i] * height;
    out[o + 2] = balloonRadius(d) * height;
    out[o + 3] = b.presence[i];
    for (let s = 0; s < 3; s++) {
      const c = palette[b.colors[i * 3 + s] % palette.length];
      out[o + 4 + s * 4] = c[0];
      out[o + 5 + s * 4] = c[1];
      out[o + 6 + s * 4] = c[2];
    }
    out[o + 7] = balloonHaze(d);
    out[o + 11] = burners ? burnGlow(b.burnAge[i], b.burnLen[i]) : 0;
    out[o + 15] = b.gores[i];
    out[o + 16] = b.spin[i];
    out[o + 17] = b.colorCount[i];
    n++;
  }
  return n;
}
