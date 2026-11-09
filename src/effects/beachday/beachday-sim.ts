/**
 * Pure model for "Beach Day": the camera on the sand looking out to sea and its
 * projection from the beach to the screen, the `time` presets, the wave
 * schedule and its per-column table (the wash timeline from `wash.ts`, peeling
 * along the shore), the static sand details, the drifting cloud strip and the
 * distant gulls. Nothing here touches GL.
 *
 * Screen units are frame heights, y up from the bottom edge, x from the left
 * edge. The beach is a flat plane CAMERA_H below the eye; the shore normal `n`
 * is in metres, positive landward (towards the camera), with the still-water
 * line at n = 0. `X` is metres along the shore, positive to the right.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { sampleSky, type SkyState } from "../horizon/horizon-sim";
import { lookup } from "../lookup";
import { clamp, smoothstep } from "../math";
import { createNoise, createRng, hash32 } from "../noise";
import { schlick } from "../sea/sea-sim";
import { foamStrength, residualFoam, swashMark } from "../beach/beach-sim";
import { T_ACTIVE, T_APPROACH, T_STOP, washFront } from "../wash";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Camera and projection
// ---------------------------------------------------------------------------

/** Horizon height: the sea shows above the speaker's shoulders. */
export const HORIZON = 0.575;
/** Focal length in frame heights (about 40° vertical field of view). */
export const FOCAL = 1.4;
/** Eye height above the beach plane (and the still water), metres: seated on a low rise. */
export const CAMERA_H = 1.2;
/** A beach point `z` metres away sits K / z frame heights below the horizon. */
export const K = CAMERA_H * FOCAL;
/** Row of the still-water line, a little under a third of the way up. */
export const SHORE_Y = 0.3;
/** Distance (m) from the camera to the still-water line. */
export const Z_SHORE = K / (HORIZON - SHORE_Y);

/** Distance (m) to the beach at row `y` (below the horizon). */
export function depthAt(y: number): number {
  return K / Math.max(HORIZON - y, 1e-6);
}

/** Shore normal n (m, landward) at row `y` (below the horizon). The shader mirrors this. */
export function shoreN(y: number): number {
  return Z_SHORE - depthAt(y);
}

/** Row at which the beach is `n` metres landward of the still-water line (n < Z_SHORE). */
export function rowForN(n: number): number {
  return HORIZON - K / Math.max(Z_SHORE - n, 1e-6);
}

/** Along-shore position (m) of a point `dx` frame heights right of centre on row `y`. */
export function worldX(dx: number, y: number): number {
  return (dx * CAMERA_H) / Math.max(HORIZON - y, 1e-6);
}

/** Frame heights right of centre at which along-shore `X` at shore normal `n` appears. */
export function screenDx(X: number, n: number): number {
  return (X * FOCAL) / Math.max(Z_SHORE - n, 1e-6);
}

/** Shore normal at the bottom edge of the frame. */
export const N_BOTTOM = shoreN(0);

/** Reflectance of flat water seen at row `y`: Schlick at the view ray's grazing angle. */
export function rowFresnel(y: number): number {
  const d = Math.max(HORIZON - y, 0);
  return schlick(d / Math.hypot(d, FOCAL));
}

// ---------------------------------------------------------------------------
// Time presets
// ---------------------------------------------------------------------------

export interface BeachPreset {
  /** Hour to sample the shared sky keys at. */
  hour: number;
  /** Sun centre above the horizon, frame heights. */
  sunY: number;
  /** Sun disc radius, frame heights, and colour. */
  disc: number;
  discColor: Rgb;
  /** Colour of the glitter path's light, and its strength. */
  lightColor: Rgb;
  glitter: number;
  /** Base Beckmann m² of the glitter lobe: larger is broader and softer. */
  roughness: number;
  /** Water body colour far out, mid-distance and in the shallows. */
  deep: Rgb;
  teal: Rgb;
  turquoise: Rgb;
  /** Tint of the sand seen through shallow water. */
  shallowTint: Rgb;
  /** Dry sand in the sun. */
  sand: Rgb;
  /** Foam, and the sunlit face of a wave about to break. */
  foam: Rgb;
  crest: Rgb;
  /** Clouds' sunlit tops and shaded bases. */
  cloudLit: Rgb;
  cloudShade: Rgb;
  /** Gull silhouette. */
  bird: Rgb;
  /** How far the distant headland fades into the horizon haze (0 = solid, 1 = gone). */
  haze: number;
}

const rgb = hexToUnitRgb;

export const BEACH_PRESETS: Readonly<Record<string, BeachPreset>> = {
  midday: {
    hour: 12.5,
    sunY: 0.34,
    disc: 0.028,
    discColor: rgb("#fffdf4"),
    lightColor: rgb("#fff6e2"),
    glitter: 0.7,
    roughness: 0.03,
    deep: rgb("#0a3a72"),
    teal: rgb("#14839a"),
    turquoise: rgb("#3fcfc6"),
    shallowTint: rgb("#bdeee0"),
    sand: rgb("#ecd6ad"),
    foam: rgb("#fbfdfd"),
    crest: rgb("#62dccf"),
    cloudLit: rgb("#ffffff"),
    cloudShade: rgb("#b4c4d8"),
    bird: rgb("#4a5260"),
    haze: 0.55,
  },
  afternoon: {
    hour: 16.5,
    sunY: 0.2,
    disc: 0.03,
    discColor: rgb("#fff3d2"),
    lightColor: rgb("#ffe6b0"),
    glitter: 0.75,
    roughness: 0.025,
    deep: rgb("#0c3466"),
    teal: rgb("#177a8c"),
    turquoise: rgb("#46c0b4"),
    shallowTint: rgb("#c4e8d4"),
    sand: rgb("#ebcf9e"),
    foam: rgb("#fdfaf2"),
    crest: rgb("#6ad0be"),
    cloudLit: rgb("#fff4de"),
    cloudShade: rgb("#a8b2c6"),
    bird: rgb("#474b56"),
    haze: 0.5,
  },
  sunset: {
    hour: 17.9,
    sunY: 0.075,
    disc: 0.032,
    discColor: rgb("#ffdc9a"),
    lightColor: rgb("#ffb066"),
    glitter: 0.9,
    roughness: 0.018,
    deep: rgb("#1c2a52"),
    teal: rgb("#2d5c70"),
    turquoise: rgb("#5f8e8c"),
    shallowTint: rgb("#e8cdb4"),
    sand: rgb("#d8a678"),
    foam: rgb("#ffe8d2"),
    crest: rgb("#8fae9c"),
    cloudLit: rgb("#ffc690"),
    cloudShade: rgb("#7e6c88"),
    bird: rgb("#3a2f3c"),
    haze: 0.35,
  },
};

/** The preset for a `time` select value, falling back to the afternoon. */
export const beachPreset = (time: string): BeachPreset => lookup(BEACH_PRESETS, time, "afternoon");

/** Fills `out` with the sky for `preset`. */
export function beachSky(preset: BeachPreset, out: SkyState): SkyState {
  sampleSky(preset.hour / 24, out);
  return out;
}

/** The distant headland: the horizon sky darkened, then hazed by `preset.haze`. */
export function headlandColor(sky: SkyState, preset: BeachPreset, out: Rgb): Rgb {
  for (let c = 0; c < 3; c++) {
    const solid = sky.horizon[c] * 0.45 + sky.zenith[c] * 0.15;
    out[c] = solid + (sky.horizon[c] - solid) * preset.haze;
  }
  return out;
}

/** Sun centre, frame heights right of the frame's centre, for a `sun` side at `aspect`. */
export function sunDx(side: string, aspect: number): number {
  return (side === "right" ? 0.31 : -0.31) * aspect;
}

/** +1 when the sun is on the right, -1 on the left. */
export const sunSign = (side: string): number => (side === "right" ? 1 : -1);

// ---------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------

/** Distance (m) seaward of the still-water line where waves break. */
export const BREAK = 4.5;
/** Distance seaward where a swell line starts its approach. */
export const APPROACH_DIST = 25;
/** Run-up (m) at `waves` = 0 and 1, before each wave's own factor. */
export const REACH_LOW = 0.85;
export const REACH_HIGH = 1.6;
/** Each wave's run-up is the base times a factor in [REACH_MIN, REACH_MAX). */
export const REACH_MIN = 0.75;
export const REACH_MAX = 1.25;
/** Average seconds between waves at `waves` = 0 and 1. */
export const INTERVAL_LOW = 12;
export const INTERVAL_HIGH = 7;
/** Each spacing is the interval times a factor in [SPACING_MIN, SPACING_MAX). */
export const SPACING_MIN = 0.85;
export const SPACING_MAX = 1.15;
/** Seconds the break takes to peel from one side of the frame to the other. */
export const PEEL_MIN = 0.8;
export const PEEL_MAX = 1.8;
/** Seconds a wave stays in flight after draining, while its wet sand dries. */
export const WET_TAIL = 8;
/** Seconds over which a wave's wet sand fades at the end of its life (local clock). */
export const WET_FADE = 3;
/** A wave's whole life on the scheduler clock, the latest-peeling side included. */
export const LIFETIME = T_ACTIVE + PEEL_MAX + WET_TAIL;
/** Wave slots: LIFETIME fits in MAX_WAVES of the shortest spacings. */
export const MAX_WAVES = 4;

/** Average seconds between waves for a `waves` setting. */
export const waveInterval = (waves: number): number =>
  INTERVAL_LOW + (INTERVAL_HIGH - INTERVAL_LOW) * clamp(waves, 0, 1);

/** Base run-up (m) for a `waves` setting. */
export const waveReach = (waves: number): number =>
  REACH_LOW + (REACH_HIGH - REACH_LOW) * clamp(waves, 0, 1);

/** Foam brightness for a `waves` setting: smaller waves make thinner foam. */
export const foamLevel = (waves: number): number => 0.7 + 0.3 * clamp(waves, 0, 1);

/** Wave height (m) at the break at `waves` = 0 and 1, before each wave's own factor: knee high. */
export const HEIGHT_LOW = 0.22;
export const HEIGHT_HIGH = 0.55;
/** Each wave's height is the base times a factor in [HEIGHT_MIN, HEIGHT_MAX). */
export const HEIGHT_MIN = 0.85;
export const HEIGHT_MAX = 1.15;
/** Share of its height a wave keeps as a foaming bore just after breaking. */
export const BORE = 0.3;

/** Base wave height (m) for a `waves` setting. */
export const waveHeight = (waves: number): number =>
  HEIGHT_LOW + (HEIGHT_HIGH - HEIGHT_LOW) * clamp(waves, 0, 1);

/**
 * Height (m) of a wave's face `tau` seconds into its local timeline, for a wave
 * `height` tall at the break: a low swell far out, steepening as it shoals,
 * collapsing into a low bore as it breaks and gone before the run-up stops.
 * Continuous, and 0 before the start and from T_STOP on.
 */
export function faceHeight(tau: number, height: number): number {
  if (tau <= 0 || tau >= T_STOP) {
    return 0;
  }
  const grow = smoothstep(0, 1, tau) * (0.3 + 0.7 * smoothstep(0.3 * T_APPROACH, T_APPROACH, tau));
  const fall = BORE + (1 - BORE) * (1 - smoothstep(T_APPROACH, T_APPROACH + 0.9, tau));
  return height * grow * fall * (1 - smoothstep(T_APPROACH + 0.4, T_STOP - 0.3, tau));
}

/** Swell multiplier for the open water behind the break. */
export const swellLevel = (waves: number): number => 0.35 + 0.6 * clamp(waves, 0, 1);

/** Position of a wave's front (n, m) on its local clock, for a run-up of `reach`. */
export function beachFront(tau: number, reach: number): number {
  return washFront(tau, reach, BREAK, APPROACH_DIST);
}

/** Width (m) of the foam band trailing a front: a crest line that spreads as it ages. */
export function foamWidth(tau: number): number {
  return 0.35 + 1.4 * smoothstep(T_APPROACH, T_ACTIVE, tau);
}

/** Seconds after its run-up stops at which a wave's wet sand is gone (local clock). */
export const WET_END = T_ACTIVE - T_STOP + WET_TAIL;

/** Fade of a wave's wet sand over the end of its life, from seconds since its run-up stopped. */
export function wetFade(sinceStop: number): number {
  return 1 - smoothstep(WET_END - WET_FADE, WET_END, sinceStop);
}

export interface BeachWave {
  /** Start time on the scheduler clock (s), at the side the break starts from. */
  start: number;
  /** Run-up (m). */
  reach: number;
  /** +1: the break peels from the left edge to the right; -1: from the right. */
  peelDir: number;
  /** Seconds the break takes to cross the frame. */
  peelSpan: number;
  /** Phases (radians) of the front's along-shore wiggle, and offsets for its foam. */
  phaseA: number;
  phaseB: number;
  /** Height (m) at the break. */
  height: number;
}

export interface BeachScheduler {
  /** Live waves, oldest first; only the first `count` are in flight. */
  readonly waves: readonly BeachWave[];
  readonly count: number;
  /** Scheduler clock (s), unwrapped float64. */
  readonly time: number;
  /** Total waves spawned since the last reset. */
  readonly spawned: number;
  /** Advances the clock, retires finished waves and starts a new one when due. */
  step: (dt: number, waves: number) => void;
  /** Clears every wave and restarts the clock with a new seed. */
  reset: (seed: number) => void;
}

export function createBeachScheduler(seed: number): BeachScheduler {
  let rng = createRng(seed);
  const waves: BeachWave[] = [];
  for (let i = 0; i < MAX_WAVES; i++) {
    waves.push({
      start: 0,
      reach: 0,
      peelDir: 1,
      peelSpan: PEEL_MIN,
      phaseA: 0,
      phaseB: 0,
      height: 0,
    });
  }
  let count = 0;
  let time = 0;
  let spawned = 0;
  /** When the next wave is due; the first one starts straight away. */
  let nextAt = 0;

  const spawn = (setting: number) => {
    const w = waves[count++];
    w.start = time;
    w.reach = waveReach(setting) * (REACH_MIN + (REACH_MAX - REACH_MIN) * rng());
    w.height = waveHeight(setting) * (HEIGHT_MIN + (HEIGHT_MAX - HEIGHT_MIN) * rng());
    w.peelDir = rng() < 0.5 ? 1 : -1;
    w.peelSpan = PEEL_MIN + (PEEL_MAX - PEEL_MIN) * rng();
    w.phaseA = rng() * TAU;
    w.phaseB = rng() * TAU;
    spawned++;
    nextAt = time + waveInterval(setting) * (SPACING_MIN + (SPACING_MAX - SPACING_MIN) * rng());
  };

  return {
    waves,
    get count() {
      return count;
    },
    get time() {
      return time;
    },
    get spawned() {
      return spawned;
    },
    step(dt, setting) {
      time += Number.isFinite(dt) ? Math.max(0, dt) : 0;
      // Waves share one lifetime, so they retire in start order from the front.
      while (count > 0 && time - waves[0].start >= LIFETIME) {
        const done = waves[0];
        for (let i = 1; i < count; i++) {
          waves[i - 1] = waves[i];
        }
        waves[count - 1] = done;
        count--;
      }
      // Never blocked with valid settings (see MAX_WAVES), but stay safe if it is.
      if (time >= nextAt && count < MAX_WAVES) {
        spawn(setting);
      }
    },
    reset(s) {
      rng = createRng(s);
      count = 0;
      time = 0;
      spawned = 0;
      nextAt = 0;
    },
  };
}

/** Columns of the per-frame wave table across the frame. */
export const WAVE_COLUMNS = 64;
/** Rows of the wave table: two RGBA texels per wave slot. */
export const WAVE_ROWS = MAX_WAVES * 2;

/** Seconds before the first break over which the later-breaking stretches of a crest slow down. */
export const PEEL_LEAD = 1;
/** Share of its break delay a stretch still lags by once its wash has drained. */
export const PEEL_KEEP = 0.25;

/**
 * Seconds into its timeline a wave is at screen fraction `u` (0 = left edge),
 * `time` on the scheduler clock. The crest rolls in level, then breaks first
 * at its start side and peels across the frame in `peelSpan` seconds: over the
 * last PEEL_LEAD seconds of the approach each stretch slows so that it breaks
 * `delay` later, then runs up and drains a little faster, so that the sheet
 * reaches the sand nearly level and lags by only PEEL_KEEP of its delay from
 * T_ACTIVE on. Piecewise linear, continuous and increasing in `time`.
 */
export function localTime(w: BeachWave, time: number, u: number): number {
  const delay = (w.peelDir > 0 ? u : 1 - u) * w.peelSpan;
  const t = time - w.start;
  const t0 = T_APPROACH - PEEL_LEAD;
  const tBreak = T_APPROACH + delay;
  const tEnd = T_ACTIVE + PEEL_KEEP * delay;
  if (t <= t0) {
    return t;
  }
  if (t <= tBreak) {
    return t0 + ((t - t0) * PEEL_LEAD) / (PEEL_LEAD + delay);
  }
  if (t <= tEnd) {
    return T_APPROACH + ((t - tBreak) * (T_ACTIVE - T_APPROACH)) / (tEnd - tBreak);
  }
  return t - PEEL_KEEP * delay;
}

/**
 * Fills `out` (WAVE_COLUMNS x WAVE_ROWS RGBA texels, row-major) with each live
 * wave's state at each column's centre; rows of empty slots are zeroed. Per
 * wave, row 2i holds (front n, highest reach so far, seconds since the run-up
 * stopped, face height) and row 2i + 1 holds (foam band strength, 1 / band
 * width, residual surf foam, swash mark). `foam` scales the three foam terms.
 * Allocates nothing.
 */
export function fillWaveTable(sched: BeachScheduler, foam: number, out: Float32Array): void {
  const stride = WAVE_COLUMNS * 4;
  for (let i = 0; i < MAX_WAVES; i++) {
    const a = 2 * i * stride;
    const b = a + stride;
    if (i >= sched.count) {
      out.fill(0, a, b + stride);
      continue;
    }
    const w = sched.waves[i];
    for (let c = 0; c < WAVE_COLUMNS; c++) {
      const tau = localTime(w, sched.time, (c + 0.5) / WAVE_COLUMNS);
      const front = beachFront(tau, w.reach);
      const o = c * 4;
      out[a + o] = front;
      out[a + o + 1] = tau < T_STOP ? front : w.reach;
      out[a + o + 2] = tau - T_STOP;
      out[a + o + 3] = faceHeight(tau, w.height);
      out[b + o] = foamStrength(tau) * foam;
      out[b + o + 1] = 1 / foamWidth(tau);
      out[b + o + 2] = residualFoam(tau) * foam;
      out[b + o + 3] = swashMark(tau) * foam;
    }
  }
}

/** Packs each live wave's wiggle phases as a vec2 into `out` (MAX_WAVES * 2 floats). */
export function packWavePhases(sched: BeachScheduler, out: Float32Array): void {
  for (let i = 0; i < MAX_WAVES; i++) {
    const w = sched.waves[i];
    out[i * 2] = i < sched.count ? w.phaseA : 0;
    out[i * 2 + 1] = i < sched.count ? w.phaseB : 0;
  }
}

/**
 * Sand that stays damp (0..1) whatever the waves do: dark and glossy just above
 * the waterline, lightly damp up to where the bigger waves reach.
 */
export function staticDamp(n: number): number {
  return 0.8 * (1 - smoothstep(0, 0.45, n)) + 0.25 * (1 - smoothstep(0.45, 2.2, n));
}

// ---------------------------------------------------------------------------
// Sand details
// ---------------------------------------------------------------------------

/** Shells and pebbles on the sand. */
export const MAX_STONES = 12;
/** Footprints in the trail. */
export const MAX_PRINTS = 12;
/** Floats per stone (two vec4s): X, n, radius, angle; kind (0 pebble, 1 shell), tone, squash, -. */
export const STONE_FLOATS = 8;
/** Floats per print (one vec4): X, n, heading (radians from seaward), depth (0..1). */
export const PRINT_FLOATS = 4;
/** Shells and pebbles lie between these shore normals (m): above the usual run-up. */
export const STONE_N_MIN = 1.7;
export const STONE_N_MAX = N_BOTTOM - 0.05;
/** The trail runs from below the frame down to here, fading where the waves wash over it. */
export const PRINT_N_END = 1.1;
/** Length of one stride (m) and the feet's spacing either side of the path. */
export const STRIDE = 0.36;
export const FOOT_SPACING = 0.09;
/** The towel's far edge (m from the waterline): clear of the biggest waves' reach. */
export const TOWEL_N = 2.75;
export const TOWEL_HALF_WIDTH = 0.45;
export const TOWEL_HALF_LENGTH = 0.9;

/** Stripe colours for the towel, chosen by the seed. */
export const TOWEL_PALETTES: readonly (readonly [string, string, string])[] = [
  ["#f4f1e8", "#1f8fb3", "#f2a33a"],
  ["#f6efe2", "#e2574c", "#2b5f8f"],
  ["#fff4dc", "#3aa88f", "#f0c23b"],
  ["#f3ece6", "#d9658a", "#5ab7c9"],
];

export interface SandLayout {
  /** MAX_STONES * STONE_FLOATS; unused stones have radius 0. */
  stones: Float32Array;
  /** MAX_PRINTS * PRINT_FLOATS; unused prints have depth 0. */
  prints: Float32Array;
  /** Towel centre X, n, half width, half length; angle (radians), on (0 or 1), -, -. */
  towel: Float32Array;
  /** Towel stripe colours, three RGB triples. */
  towelColors: Float32Array;
}

/** Half the frame's width (m) at shore normal `n` for `aspect` (width / height). */
export function halfWidthAt(n: number, aspect: number): number {
  return (0.5 * aspect * (Z_SHORE - n)) / FOCAL;
}

/**
 * Lays out the static sand details for a seed and frame `aspect`: a trail of
 * footprints walking down to the sea on the sun's side, shells and pebbles to
 * either side of the speaker (the middle of the frame is hidden behind them),
 * and a towel at the bottom corner away from the sun. Deterministic for a seed.
 */
export function layoutSand(
  seed: number,
  aspect: number,
  sunSide: string,
  towel: boolean,
): SandLayout {
  const rand = createRng(hash32(Math.floor(seed) * 7 + 3));
  const a = Math.max(aspect, 0.5);
  const side = sunSign(sunSide);
  const out: SandLayout = {
    stones: new Float32Array(MAX_STONES * STONE_FLOATS),
    prints: new Float32Array(MAX_PRINTS * PRINT_FLOATS),
    towel: new Float32Array(8),
    towelColors: new Float32Array(9),
  };

  // Towel: its far edge at TOWEL_N, its inner edge 60% of the way from the centre.
  const tAngle = (rand() - 0.5) * 0.24;
  const tN = TOWEL_N + TOWEL_HALF_LENGTH;
  const inner = 0.6 * halfWidthAt(N_BOTTOM, a);
  const tX = -side * (inner + TOWEL_HALF_WIDTH);
  out.towel.set([tX, tN, TOWEL_HALF_WIDTH, TOWEL_HALF_LENGTH, tAngle, towel ? 1 : 0, 0, 0]);
  const palette = TOWEL_PALETTES[Math.floor(rand() * TOWEL_PALETTES.length)];
  palette.forEach((hex, i) => {
    out.towelColors.set(hexToUnitRgb(hex), i * 3);
  });
  /** Whether (X, n) is on or near the towel, when it shows. */
  const onTowel = (X: number, n: number, margin: number) => {
    if (!towel) {
      return false;
    }
    const dx = X - tX;
    const dn = n - tN;
    const c = Math.cos(tAngle);
    const s = Math.sin(tAngle);
    const u = c * dx + s * dn;
    const v = -s * dx + c * dn;
    return Math.abs(u) < TOWEL_HALF_WIDTH + margin && Math.abs(v) < TOWEL_HALF_LENGTH + margin;
  };

  // Footprints: from below the frame down to the sea on the sun's side, drifting slightly.
  const startU = 0.5 + side * (0.3 + 0.1 * rand());
  let n = N_BOTTOM + 0.25;
  let X = (startU - 0.5) * a * ((Z_SHORE - n) / FOCAL);
  const heading = side * (0.1 + 0.25 * rand());
  let foot = rand() < 0.5 ? 1 : -1;
  let count = 0;
  while (count < MAX_PRINTS && n > PRINT_N_END) {
    const curve = heading + 0.08 * Math.sin(count * 0.7 + seed);
    const px = X + foot * FOOT_SPACING * Math.cos(curve);
    const pn = n - foot * FOOT_SPACING * Math.sin(curve);
    const o = count * PRINT_FLOATS;
    out.prints[o] = px;
    out.prints[o + 1] = pn;
    out.prints[o + 2] = curve + (rand() - 0.5) * 0.25;
    // Shallower where the bigger waves have washed over them.
    out.prints[o + 3] = 0.25 + 0.75 * smoothstep(PRINT_N_END, 2.3, pn);
    count++;
    foot = -foot;
    n -= STRIDE * Math.cos(curve);
    X += STRIDE * Math.sin(curve);
  }

  // Shells and pebbles, by screen fraction, kept to the sides and off the towel.
  let placed = 0;
  for (let tries = 0; tries < 200 && placed < MAX_STONES; tries++) {
    const left = rand() < 0.5;
    const u = left ? 0.03 + 0.3 * rand() : 0.67 + 0.3 * rand();
    const sn = STONE_N_MIN + (STONE_N_MAX - STONE_N_MIN) * Math.sqrt(rand());
    const sx = (u - 0.5) * a * ((Z_SHORE - sn) / FOCAL);
    if (onTowel(sx, sn, 0.1)) {
      continue;
    }
    const shell = rand() < 0.45;
    const o = placed * STONE_FLOATS;
    out.stones[o] = sx;
    out.stones[o + 1] = sn;
    out.stones[o + 2] = shell ? 0.016 + 0.014 * rand() : 0.012 + 0.02 * rand();
    out.stones[o + 3] = rand() * TAU;
    out.stones[o + 4] = shell ? 1 : 0;
    out.stones[o + 5] = rand();
    out.stones[o + 6] = shell ? 0.75 + 0.15 * rand() : 0.55 + 0.35 * rand();
    placed++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clouds
// ---------------------------------------------------------------------------

/** Cloud strip texture size: RG8, density and lighting. */
export const CLOUD_W = 1024;
export const CLOUD_H = 128;
/** Frame heights of sky across one repeat of the strip. */
export const CLOUD_SPAN = 4;
/** Heights above the horizon (frame heights) the strip covers. */
export const CLOUD_BOTTOM = 0.012;
export const CLOUD_TOP = 0.44;
/** Drift speed, frame heights per second: about four minutes to cross a 16:9 frame. */
export const CLOUD_SPEED = 0.0075;

export interface CloudPuff {
  /** Centre along the strip and height above the horizon, frame heights. */
  u: number;
  h: number;
  r: number;
  /** Vertical squash: 1 for a round puff, more for the flat body under them. */
  sy: number;
  /** Base height of the cloud the puff belongs to. */
  base: number;
  /** Height of that cloud's top above its base. */
  top: number;
}

/**
 * A few soft cumulus clouds along the strip: each a row of overlapping puffs,
 * biggest in the middle, sitting on a flat base. Clouds lower in the sky are
 * further away, so smaller and flatter. Deterministic for a seed.
 */
export function layoutClouds(seed: number): CloudPuff[] {
  const rand = createRng(hash32(Math.floor(seed) * 13 + 5));
  const puffs: CloudPuff[] = [];
  const count = 4 + Math.floor(rand() * 3);
  for (let i = 0; i < count; i++) {
    const u = ((i + 0.2 + 0.6 * rand()) / count) * CLOUD_SPAN;
    const base = 0.04 + 0.26 * rand();
    const scale = 0.45 + 0.55 * (base / 0.3);
    const width = scale * (0.16 + 0.16 * rand());
    const n = 4 + Math.floor(rand() * 4);
    let top = 0;
    const first = puffs.length;
    for (let k = 0; k < n; k++) {
      const t = n > 1 ? k / (n - 1) : 0.5;
      const bulge = Math.sin(Math.PI * (0.15 + 0.7 * t));
      const r = width * (0.16 + 0.16 * bulge) * (0.85 + 0.3 * rand());
      const h = base + r * (0.35 + 0.5 * bulge * rand());
      top = Math.max(top, h + r - base);
      puffs.push({ u: u + (t - 0.5) * width * 1.3, h, r, sy: 1.15, base, top: 0 });
    }
    // A broad, flat body binds the puffs into one cloud.
    puffs.push({ u, h: base + width * 0.1, r: width * 0.75, sy: 3.2, base, top: 0 });
    for (let k = first; k < puffs.length; k++) {
      puffs[k].top = top;
    }
  }
  return puffs;
}

/**
 * Builds the cloud strip (CLOUD_W x CLOUD_H, RG8, row 0 at the bottom): R is
 * density, G how sunlit it is (bright tops, shaded bases). It tiles seamlessly
 * along u, for sampling with REPEAT. Writes every byte of `out`.
 */
export function buildClouds(
  seed: number,
  out: Uint8Array = new Uint8Array(CLOUD_W * CLOUD_H * 2),
): Uint8Array {
  const puffs = layoutClouds(seed);
  const noise = createNoise(hash32(Math.floor(seed) + 911));
  const dens = new Float32Array(CLOUD_W * CLOUD_H);
  const light = new Float32Array(CLOUD_W * CLOUD_H);
  const du = CLOUD_SPAN / CLOUD_W;
  const dh = (CLOUD_TOP - CLOUD_BOTTOM) / CLOUD_H;
  for (const p of puffs) {
    const reach = p.r * 1.3;
    const j0 = Math.max(0, Math.floor((p.h - reach - CLOUD_BOTTOM) / dh));
    const j1 = Math.min(CLOUD_H - 1, Math.ceil((p.h + reach - CLOUD_BOTTOM) / dh));
    const i0 = Math.floor((p.u - reach) / du);
    const i1 = Math.ceil((p.u + reach) / du);
    for (let j = j0; j <= j1; j++) {
      const h = CLOUD_BOTTOM + (j + 0.5) * dh;
      // A soft, flat base.
      const floor = smoothstep(p.base - 0.006, p.base + 0.012, h);
      const lit = clamp(0.25 + (0.85 * (h - p.base)) / Math.max(p.top, 1e-3), 0, 1);
      for (let ii = i0; ii <= i1; ii++) {
        const u = (ii + 0.5) * du;
        const q = Math.hypot(u - p.u, (h - p.h) * p.sy) / p.r;
        if (q >= 1.3) {
          continue;
        }
        const d = floor * (1 - smoothstep(0.6, 1.2, q));
        const i = j * CLOUD_W + (((ii % CLOUD_W) + CLOUD_W) % CLOUD_W);
        if (d > dens[i]) {
          dens[i] = d;
          light[i] = lit;
        }
      }
    }
  }
  // Periodic noise along u (whole cells per repeat) breaks up the puffs' edges.
  const cells = 48;
  for (let j = 0; j < CLOUD_H; j++) {
    for (let i = 0; i < CLOUD_W; i++) {
      const k = j * CLOUD_W + i;
      let d = dens[k];
      let l = light[k];
      if (d > 0) {
        const x = (i / CLOUD_W) * cells;
        const y = (j / CLOUD_W) * cells;
        const nz =
          0.65 * noise.periodic2(x, y, cells, 256) +
          0.35 * noise.periodic2(x * 2, y * 2, cells * 2, 256);
        d = smoothstep(0.08, 0.7, d + 0.28 * nz);
        l = clamp(l + 0.15 * nz, 0, 1);
      }
      out[k * 2] = Math.round(d * 255);
      out[k * 2 + 1] = Math.round(l * 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Gulls
// ---------------------------------------------------------------------------

export const MAX_BIRDS = 2;
/** Each gull gets one chance to fly by per period (s); the two are offset. */
export const BIRD_PERIOD = 53;
/** Share of periods with a gull in them. */
export const BIRD_CHANCE = 0.55;
/** Seconds a flight lasts, and the fade in and out at each end. */
export const BIRD_FLIGHT = 36;
export const BIRD_FADE = 3;
/** Glide speed range, frame heights per second (a 1080p frame is crossed in a minute or more). */
export const BIRD_SPEED_MIN = 0.012;
export const BIRD_SPEED_MAX = 0.022;
/** Wingspan range, frame heights: a few pixels at 1080p. */
export const BIRD_SPAN_MIN = 0.007;
export const BIRD_SPAN_MAX = 0.011;
/** Wingbeats per second while flapping: slow and lazy. */
export const FLAP_HZ = 1.2;
/** Floats per gull: x, y (frame heights), half span, alpha; wing lift, -, -, -. */
export const BIRD_FLOATS = 8;

/** A uniform draw in [0, 1) from a hashed key and an index. */
const hashUnit = (key: number, k: number): number =>
  hash32(key + Math.imul(k, 0x9e3779b9)) / 4294967296;

/**
 * Fills `out` (BIRD_FLOATS) with gull `index`'s state at `time` (float64
 * seconds) for a frame `aspect` wide: gliding sideways a little above the
 * horizon, fading in and out at the ends of its flight, with an occasional
 * burst of slow wingbeats. Alpha is 0 when it is not flying. Pure: the same
 * time always gives the same state.
 */
export function birdState(
  time: number,
  seed: number,
  index: number,
  aspect: number,
  out: Float32Array,
  offset = 0,
): void {
  const shifted = time + index * BIRD_PERIOD * 0.5;
  const slot = Math.floor(shifted / BIRD_PERIOD);
  const key = hash32(Math.floor(seed) * 131 + index * 7919 + slot * 104729);
  // Hashed draws rather than a seeded generator: this runs every frame and must not allocate.
  const present = hashUnit(key, 1) < BIRD_CHANCE;
  const startIn = hashUnit(key, 2) * (BIRD_PERIOD - BIRD_FLIGHT);
  const t = shifted - slot * BIRD_PERIOD - startIn;
  const dir = hashUnit(key, 3) < 0.5 ? 1 : -1;
  const speed = BIRD_SPEED_MIN + (BIRD_SPEED_MAX - BIRD_SPEED_MIN) * hashUnit(key, 4);
  const travel = speed * BIRD_FLIGHT;
  const a = Math.max(aspect, 0.5);
  const x0 = 0.08 * a + hashUnit(key, 5) * Math.max(0, 0.84 * a - travel);
  const y0 = HORIZON + 0.035 + 0.1 * hashUnit(key, 6);
  const span = BIRD_SPAN_MIN + (BIRD_SPAN_MAX - BIRD_SPAN_MIN) * hashUnit(key, 7);
  const flapPhase = hashUnit(key, 8) * TAU;
  const alive = present && t >= 0 && t <= BIRD_FLIGHT;
  const tc = clamp(t, 0, BIRD_FLIGHT);
  const fade =
    smoothstep(0, BIRD_FADE, tc) * (1 - smoothstep(BIRD_FLIGHT - BIRD_FADE, BIRD_FLIGHT, tc));
  // Bursts of flapping: about a third of the time, eased in and out.
  const burst = smoothstep(0.35, 0.75, Math.sin((TAU * tc) / 11 + flapPhase));
  out[offset] = dir > 0 ? x0 + speed * tc : x0 + travel - speed * tc;
  out[offset + 1] = y0 + 0.006 * Math.sin(TAU * 0.07 * tc + flapPhase) - 0.0004 * tc;
  out[offset + 2] = span * 0.5;
  out[offset + 3] = alive ? fade : 0;
  out[offset + 4] = 0.45 + 0.4 * burst * Math.sin(TAU * FLAP_HZ * tc + flapPhase);
  out[offset + 5] = 0;
  out[offset + 6] = 0;
  out[offset + 7] = 0;
}
