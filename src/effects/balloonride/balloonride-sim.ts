/**
 * Hot-Air Balloon Ride model, nothing here touches GL:
 *
 * - The view: a pinhole camera a few hundred metres up, looking out level
 *   over the basket's rim, turning slowly as the balloon does.
 * - The burner: every so often it fires for a few seconds, its glow ramping
 *   smoothly up and down, never flashing.
 * - The landscape map: fields, hedges, woods, a river and villages, built once
 *   per variation into a tiling RGBA texture (colour, and the height of
 *   hedges, trees and roofs for their long shadows).
 * - The other balloons in the distance, using the Hot-Air Balloons effect's
 *   balloons for their colours, gores and burners.
 * - The light for each time of day, from the Hot-Air Balloons effect's.
 */
import {
  BALLOON_FLOATS,
  type Balloons,
  burnGlow,
  createBalloons,
  LIGHTS,
  type LightSetting,
  stepBalloons,
} from "../balloons/balloons-sim";
import { MAX_BALLOONS } from "../balloons/balloons.meta";
import { createColorEase, hexToUnitRgb, type Rgb } from "../color";
import { lookup } from "../lookup";
import { approach, clamp, smoothstep, wrap } from "../math";
import { createNoise, createRng } from "../noise";
import { createSwell, swellAt } from "../sway";
import { type EnvelopeScheme, MAX_OTHERS, type RideTime } from "./balloonride.meta";

const TAU = Math.PI * 2;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/* ----- The view ----- */

/** Focal length, frame heights: about 42° of view top to bottom. */
export const FOCAL = 1.3;
/** Height of the horizon above the frame's centre, frame heights: the camera looks a touch down. */
export const HORIZON = 0.1;
/** The basket's height above the fields, metres. */
export const CAMERA_HEIGHT = 350;
/** Distance over which the haze thickens by a factor of e, metres. */
export const HAZE_METRES = 3500;

/**
 * The balloon's slow turn: a swell over five minutes, at most `YAW_MAX`
 * radians either way, so the low sun stays in view.
 */
export const YAW_SWELL = createSwell(300, [
  { cycles: 1, amplitude: 1, offset: 0 },
  { cycles: 2, amplitude: 0.35, offset: 0.3 },
  { cycles: 3, amplitude: 0.12, offset: 0.65 },
]);
export const YAW_MAX = 0.16;

/** The turn (radians, positive turns the view to the right) at swell `phase`. */
export function yawAt(phase: number): number {
  return YAW_MAX * swellAt(YAW_SWELL, phase);
}

/** How fast the balloon drifts over the ground, metres per second. */
export const WIND_SPEED = 3.5;

/**
 * The wind's direction for `seed` (radians from straight ahead, clockwise
 * from above): mostly across the view, so the fields slide sideways.
 */
export function windAngle(seed: number): number {
  const rand = createRng(Math.floor(seed) * 7919 + 17);
  const side = rand() < 0.5 ? -1 : 1;
  return side * mix(0.35 * Math.PI, 0.6 * Math.PI, rand());
}

/* ----- The burner ----- */

/** The burner param's range: seconds between burns. */
export const MIN_GAP = 10;
export const MAX_GAP = 120;
/** Each quiet spell is the gap param times 1 ± `GAP_SPREAD`. */
export const GAP_SPREAD = 0.25;
/** Seconds a burn lasts, shortest and longest. */
export const BURN_MIN = 2;
export const BURN_MAX = 4;
/** Seconds the glow takes to rise at a burn's start and to fall at its end. */
export const BURN_RAMP = 1;

export interface Burner {
  /** Seconds into the current burn, or -1 between burns. */
  age: number;
  /** The current burn's length (s). */
  length: number;
  /** Seconds since the last burn ended. */
  quiet: number;
  /** 0..1: where this quiet spell's length falls in its range. */
  draw: number;
  readonly rand: () => number;
}

/** Clamps the burner param to whole seconds in range. */
export const burnerGap = (gap: number) =>
  clamp(Number.isFinite(gap) ? gap : MIN_GAP, MIN_GAP, MAX_GAP);

/** How long the quiet spell lasts for a gap param of `gap` (s). */
export const quietLength = (b: Burner, gap: number) =>
  burnerGap(gap) * (1 - GAP_SPREAD + 2 * GAP_SPREAD * b.draw);

/** A burner for `seed`, part-way through its first quiet spell. */
export function createBurner(seed: number): Burner {
  const rand = createRng(Math.floor(seed) * 3301 + 911);
  const draw = rand();
  return { age: -1, length: BURN_MIN, quiet: 0, draw, rand };
}

/**
 * Starts the first burn after `first` seconds rather than a full quiet spell
 * (a fraction of the gap), so a burn shows soon after the effect opens.
 */
export function primeBurner(b: Burner, gap: number, first: number): void {
  b.quiet = Math.max(0, quietLength(b, gap) - first);
}

/**
 * Advances the burner `dt` seconds with the gap param `gap`: a burn of
 * `BURN_MIN`..`BURN_MAX` seconds after each quiet spell. A change of `gap`
 * takes effect in the current quiet spell. Allocates nothing.
 */
export function stepBurner(b: Burner, dt: number, gap: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (b.age >= 0) {
    b.age += step;
    if (b.age >= b.length) {
      b.age = -1;
      b.quiet = 0;
      b.draw = b.rand();
    }
    return;
  }
  b.quiet += step;
  if (b.quiet >= quietLength(b, gap)) {
    b.age = 0;
    b.length = mix(BURN_MIN, BURN_MAX, b.rand());
  }
}

/** The burner's glow, 0..1: rising over `BURN_RAMP` seconds, falling over as many. */
export function burnerGlow(b: Burner): number {
  if (!(b.age >= 0)) {
    return 0;
  }
  return smoothstep(0, BURN_RAMP, b.age) * smoothstep(0, BURN_RAMP, b.length - b.age);
}

/** How much the flame's light wavers, as a fraction. */
export const FLICKER = 0.06;

/** A soft, slow waver of the flame's light at `t` seconds, within 1 ± `FLICKER`. */
export function flickerAt(t: number): number {
  const s =
    0.55 * Math.sin(TAU * 2.1 * t) +
    0.3 * Math.sin(TAU * 3.3 * t + 1.1) +
    0.15 * Math.sin(TAU * 5.2 * t + 2.3);
  return 1 + FLICKER * s;
}

/* ----- The envelope ----- */

/** Gores round the whole envelope (a multiple of every scheme's colour count). */
export const GORES = 28;
/** The most colours a scheme has. */
export const MAX_SCHEME_COLOURS = 7;

export interface Scheme {
  /** Gore colours, in order round the envelope (or picked from at random). */
  colours: readonly Rgb[];
  /** True to pick each panel's colour at random (patchwork) rather than cycle by gore. */
  patch: boolean;
}

const colours = (...hex: string[]): readonly Rgb[] => hex.map((h) => hexToUnitRgb(h));

export const SCHEMES: Readonly<Record<EnvelopeScheme, Scheme>> = {
  rainbow: {
    colours: colours("#e03a3c", "#f08a2a", "#f6cf34", "#4caf50", "#2f86d6", "#4a4fb8", "#8a4bb0"),
    patch: false,
  },
  redyellow: { colours: colours("#d8302c", "#f4c12e"), patch: false },
  bluewhite: { colours: colours("#2459b0", "#f2f0ea"), patch: false },
  patchwork: {
    colours: colours("#d8352c", "#f2c230", "#2a58a8", "#f4efe4", "#2e8a4e", "#e8722a", "#7b4bb5"),
    patch: true,
  },
};

export const schemeFor = (id: string): Scheme => lookup(SCHEMES, id, "rainbow");

/* ----- Light ----- */

export interface RideLight {
  /** The Hot-Air Balloons effect's light: sky, glow, sun, lit and shaded sides, mist. */
  base: LightSetting;
  /** The sun's bearing (radians, clockwise from straight ahead) and height above the horizon. */
  sunAz: number;
  sunElev: number;
  /** Sunlight on the ground (colour times strength), and the light in shadow. */
  sun: Rgb;
  ambient: Rgb;
  /** The light on the basket, uprights and burner. */
  solid: Rgb;
  /** The light through the envelope's fabric, lit from behind. */
  envelope: Rgb;
  /** How thick the valley mist lies, 0..1. */
  mist: number;
}

const hex = (h: string) => hexToUnitRgb(h);

export const TIMES: Readonly<Record<RideTime, RideLight>> = {
  sunrise: {
    base: LIGHTS.morning,
    sunAz: -0.38,
    sunElev: 0.07,
    sun: hex("#f4c89a"),
    ambient: hex("#6c7590"),
    solid: hex("#b8a8a0"),
    envelope: hex("#fff0d8"),
    mist: 0.85,
  },
  midday: {
    base: LIGHTS.midday,
    sunAz: 0.35,
    sunElev: 1.05,
    sun: hex("#fff8ec"),
    ambient: hex("#8a9ab4"),
    solid: hex("#e8e6e2"),
    envelope: hex("#fffcf4"),
    mist: 0.12,
  },
  sunset: {
    base: LIGHTS.evening,
    sunAz: 0.4,
    sunElev: 0.08,
    sun: hex("#f2b080"),
    ambient: hex("#6a6484"),
    solid: hex("#b49a94"),
    envelope: hex("#ffe2c0"),
    mist: 0.4,
  },
};

export const timeFor = (id: string): RideLight => lookup(TIMES, id, "sunrise");

/** Seconds for a change of time of day to ease across. */
export const LIGHT_FADE = 2.5;

/** The colours and numbers of a `RideLight` that ease, in packing order. */
const LIGHT_RGBS = 11;
const LIGHT_FLOATS = LIGHT_RGBS * 3 + 4;

const rideRgbs = (l: RideLight): readonly Rgb[] => [
  l.base.zenith,
  l.base.horizon,
  l.base.glow,
  l.base.sun,
  l.base.lit,
  l.base.shade,
  l.base.mist,
  l.sun,
  l.ambient,
  l.solid,
  l.envelope,
];

/**
 * Eases the ride's light towards a time of day, allocating nothing per step:
 * sky, sun, ground light, mist and the light on the basket and envelopes all
 * crossfade together over `LIGHT_FADE` seconds rather than switching in one
 * frame. `step` returns the target itself once settled.
 */
export function createLightEase(): { step: (target: RideLight, dt: number) => RideLight } {
  const ease = createColorEase(LIGHT_FLOATS);
  const packed = new Float64Array(LIGHT_FLOATS);
  const rgb = (): Rgb => [0, 0, 0];
  const scratch: RideLight = {
    // The fields that don't ease (unused by the ride) keep the sunrise values.
    base: {
      ...TIMES.sunrise.base,
      zenith: rgb(),
      horizon: rgb(),
      glow: rgb(),
      sun: rgb(),
      lit: rgb(),
      shade: rgb(),
      mist: rgb(),
    },
    sunAz: 0,
    sunElev: 0,
    sun: rgb(),
    ambient: rgb(),
    solid: rgb(),
    envelope: rgb(),
    mist: 0,
  };
  const out = rideRgbs(scratch);
  // The targets are fixed, so their colour lists are built once.
  const targets = new Map<RideLight, readonly Rgb[]>();
  for (const l of Object.values(TIMES)) {
    targets.set(l, rideRgbs(l));
  }
  return {
    step(target, dt) {
      let rgbs = targets.get(target);
      if (!rgbs) {
        rgbs = rideRgbs(target);
        targets.set(target, rgbs);
      }
      for (let i = 0; i < LIGHT_RGBS; i++) {
        packed[i * 3] = rgbs[i][0];
        packed[i * 3 + 1] = rgbs[i][1];
        packed[i * 3 + 2] = rgbs[i][2];
      }
      const k = LIGHT_RGBS * 3;
      packed[k] = target.base.glowStrength;
      packed[k + 1] = target.sunAz;
      packed[k + 2] = target.sunElev;
      packed[k + 3] = target.mist;
      const v = ease.step(packed, dt, LIGHT_FADE);
      if (!ease.moving) {
        return target;
      }
      for (let i = 0; i < LIGHT_RGBS; i++) {
        out[i][0] = v[i * 3];
        out[i][1] = v[i * 3 + 1];
        out[i][2] = v[i * 3 + 2];
      }
      scratch.base.glowStrength = v[k];
      scratch.sunAz = v[k + 1];
      scratch.sunElev = v[k + 2];
      scratch.mist = v[k + 3];
      return scratch;
    },
  };
}

/**
 * The sun's place on screen (frame heights from the centre) with the balloon
 * turned `yaw`, written into `out`.
 */
export function sunOnScreen(light: RideLight, yaw: number, out: [number, number]): void {
  out[0] = FOCAL * Math.tan(clamp(light.sunAz - yaw, -1.4, 1.4));
  out[1] = HORIZON + FOCAL * Math.tan(Math.min(light.sunElev, 1.4));
}

/**
 * The direction towards the sun for the balloons' shading (x right, y up, z
 * towards the viewer), written into `out`.
 */
export function sunDirection(light: RideLight, yaw: number, out: [number, number, number]): void {
  const az = light.sunAz - yaw;
  const c = Math.cos(light.sunElev);
  out[0] = Math.sin(az) * c;
  out[1] = Math.sin(light.sunElev);
  // A low sun ahead lights the balloons from behind; a little from the front
  // keeps their faces from going flat.
  out[2] = -Math.cos(az) * c * 0.6 + 0.3;
  const n = Math.hypot(out[0], out[1], out[2]);
  out[0] /= n;
  out[1] /= n;
  out[2] /= n;
}

/* ----- The landscape map ----- */

/** The map's side in texels, and the ground it covers before it repeats (metres). */
export const MAP_SIZE = 1024;
export const TILE_METRES = 3072;
/** A height of 1 in the map's alpha, metres: for the shadows' length. */
export const HEIGHT_METRES = 14;
/** The river's width, as a fraction of the map. */
export const RIVER_WIDTH = 8 / MAP_SIZE;
/** Its meander: a sum of whole-cycle sines across the map, so it tiles. */
export const RIVER_TERMS = 3;
const RIVER_AMPS = [0.09, 0.035, 0.015] as const;

/** The river's meander phases for `seed`. */
export function riverPhases(seed: number): Float32Array {
  const rand = createRng(Math.floor(seed) * 2741 + 5);
  const out = new Float32Array(RIVER_TERMS + 1);
  out[0] = rand();
  for (let k = 0; k < RIVER_TERMS; k++) {
    out[k + 1] = rand() * TAU;
  }
  return out;
}

/** The river's centre across the map (0..1) at `v` (0..1 along it). */
export function riverCentre(v: number, phases: Float32Array): number {
  let u = phases[0];
  for (let k = 0; k < RIVER_TERMS; k++) {
    u += RIVER_AMPS[k] * Math.sin(TAU * (k + 1) * v + phases[k + 1]);
  }
  return u;
}

/** The meander's amplitudes, for the shader's twin of `riverCentre`. */
export const RIVER_AMPLITUDES: readonly number[] = RIVER_AMPS;

/** Field colours: pasture, crops, stubble, ploughed earth. */
const FIELDS = colours(
  "#5c7c38",
  "#6a8a40",
  "#4e6f32",
  "#7a9450",
  "#86a058",
  "#b8a25a",
  "#c6b06a",
  "#a8a06a",
  "#6e5a40",
  "#7e6648",
  "#c4bc4c",
);
/** Which fields are ploughed (strong furrows) or cropped (tramlines). */
const PLOUGHED = new Set([8, 9]);
const CROPPED = new Set([5, 6, 10]);
/** How common each field colour is: mostly green, now and then gold or brown. */
const FIELD_WEIGHTS = [5, 5, 4, 3, 2, 1.5, 1.2, 1.2, 1, 1, 0.4] as const;
const FIELD_TOTAL = FIELD_WEIGHTS.reduce((a, b) => a + b, 0);

function pickField(r: number): number {
  let x = r * FIELD_TOTAL;
  for (let k = 0; k < FIELD_WEIGHTS.length; k++) {
    x -= FIELD_WEIGHTS[k];
    if (x < 0) {
      return k;
    }
  }
  return 0;
}
const HEDGE = hex("#2e4324");
const TREE = hex("#2a3e20");
const TREE_LIT = hex("#3c5530");
const WOOD = hex("#2b4022");
const WATER = hex("#3f5562");
const BANK = hex("#4d6a3a");
const GARDEN = hex("#5a7a3c");
const LANE = hex("#8c867a");
const ROOFS = colours("#8c4a36", "#9c5c40", "#6c6660", "#7a4232", "#a8846a");

/** Field cells across the map: about 110 m each. */
const CELLS = 28;
const VILLAGES = 3;
const VILLAGE_R = 64;

/** `x` clamped to 0..1 (never NaN here): `clamp(x, 0, 1)`, but cheaper in the map's inner loop. */
const unit = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Signed wrapped difference on a ring of `n`. */
const wrapDiff = (d: number, n: number) => d - n * Math.round(d / n);

/**
 * The landscape map for `seed`: `MAP_SIZE` square, RGBA8, colour in RGB and
 * the height of hedges, trees and roofs in A. It tiles in both directions.
 */
export function buildLandscape(seed: number, size = MAP_SIZE): Uint8Array {
  const s = Math.floor(seed);
  const rand = createRng(s * 6007 + 31);
  const noise = createNoise(s * 13 + 3);
  const out = new Uint8Array(size * size * 4);
  const cell = size / CELLS;

  // Field cells: a jittered point in each, with a colour, crop direction and kind.
  const n = CELLS * CELLS;
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const kind = new Uint8Array(n);
  const wood = new Uint8Array(n);
  const dirX = new Float64Array(n);
  const dirY = new Float64Array(n);
  const tone = new Float64Array(n);
  for (let j = 0; j < CELLS; j++) {
    for (let i = 0; i < CELLS; i++) {
      const c = j * CELLS + i;
      px[c] = (i + 0.15 + 0.7 * rand()) * cell;
      py[c] = (j + 0.15 + 0.7 * rand()) * cell;
      kind[c] = pickField(rand());
      wood[c] = rand() < 0.07 ? 1 : 0;
      const a =
        rand() < 0.6 ? (rand() < 0.5 ? 0 : Math.PI / 2) + (rand() - 0.5) * 0.3 : rand() * Math.PI;
      dirX[c] = Math.cos(a);
      dirY[c] = Math.sin(a);
      tone[c] = 0.9 + 0.2 * rand();
    }
  }
  const phases = riverPhases(s);
  const vx = new Float64Array(VILLAGES);
  const vy = new Float64Array(VILLAGES);
  for (let k = 0; k < VILLAGES; k++) {
    // Near the river, as villages tend to be, but not in it.
    const v = rand();
    const side = rand() < 0.5 ? -1 : 1;
    vx[k] = (wrap(riverCentre(v, phases), 0, 1) + side * (0.04 + 0.12 * rand())) * size;
    vy[k] = v * size;
  }

  const rgb: Rgb = [0, 0, 0];
  const set = (c: Rgb, k: number) => {
    rgb[0] = c[0] * k;
    rgb[1] = c[1] * k;
    rgb[2] = c[2] * k;
  };
  const nc = new Int32Array(9);
  const nx = new Float64Array(9);
  const ny = new Float64Array(9);
  const nd = new Float64Array(9);
  // Each field point's offset down to the current row, and across to each
  // column from the points in the cell columns either side of it and its own.
  const rowDy = new Float64Array(n);
  const villageDy = new Float64Array(VILLAGES);
  const colDx = new Float64Array(size * 3 * CELLS);
  for (let x = 0; x < size; x++) {
    const ci = Math.floor(x / cell);
    for (let di = -1; di <= 1; di++) {
      const ii = (ci + di + CELLS) % CELLS;
      for (let jj = 0; jj < CELLS; jj++) {
        colDx[(x * 3 + di + 1) * CELLS + jj] = wrapDiff(px[jj * CELLS + ii] - x, size);
      }
    }
  }
  for (let y = 0; y < size; y++) {
    const v = y / size;
    const river = riverCentre(v, phases) * size;
    for (let c = 0; c < n; c++) {
      rowDy[c] = wrapDiff(py[c] - y, size);
    }
    let villagesNear = false;
    for (let vk = 0; vk < VILLAGES; vk++) {
      villageDy[vk] = wrapDiff(y - vy[vk], size);
      villagesNear ||= Math.abs(villageDy[vk]) < VILLAGE_R;
    }
    for (let x = 0; x < size; x++) {
      // The nearest field point, and the distance to the nearest boundary. Each
      // of the 3x3 neighbouring points' offsets is worked out once, for both.
      const ci = Math.floor(x / cell);
      const cj = Math.floor(y / cell);
      let best = -1;
      let bn = 0;
      let bd = Infinity;
      for (let dj = -1, m = 0; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++, m++) {
          const ii = (ci + di + CELLS) % CELLS;
          const jj = (cj + dj + CELLS) % CELLS;
          const c = jj * CELLS + ii;
          const dx = colDx[(x * 3 + di + 1) * CELLS + jj];
          const dy = rowDy[c];
          const d = dx * dx + dy * dy;
          nc[m] = c;
          nx[m] = dx;
          ny[m] = dy;
          nd[m] = d;
          if (d < bd) {
            bd = d;
            best = c;
            bn = m;
          }
        }
      }
      const bx = nx[bn];
      const by = ny[bn];
      // Only an edge nearer than 4 texels is used (for hedges and trees), so a
      // boundary that is surely farther, as `len` is at most `reach`, is skipped.
      let edge = Infinity;
      for (let m = 0; m < 9; m++) {
        if (nc[m] === best) {
          continue;
        }
        // Distance to the perpendicular bisector between the two points.
        const ex = nx[m] - bx;
        const ey = ny[m] - by;
        const reach = Math.abs(ex) + Math.abs(ey) + 1e-6;
        if (nd[m] - bd >= 8.001 * reach) {
          continue;
        }
        const len = Math.hypot(ex, ey);
        const e = (nd[m] - bd) / (2 * Math.max(len, 1e-6));
        edge = Math.min(edge, e);
      }

      const k = kind[best];
      const blot = noise.periodic2((x / size) * 64, (y / size) * 64, 64, 64);
      let height = 0;
      if (wood[best]) {
        const canopy = noise.periodic2((x / size) * 256, (y / size) * 256, 256, 256);
        set(canopy > 0.1 ? TREE_LIT : WOOD, 0.9 + 0.2 * blot);
        height = 0.6 + 0.25 * canopy;
      } else {
        // Furrows or tramlines along the field's direction.
        const along = (x * dirX[best] + y * dirY[best]) % 1e6;
        let stripe = 1;
        if (PLOUGHED.has(k)) {
          stripe = 0.86 + 0.14 * Math.cos(along * Math.PI);
        } else if (CROPPED.has(k)) {
          stripe = 1 - 0.18 * smoothstep(0.75, 1, Math.cos((along / 8) * TAU));
        }
        set(FIELDS[k], tone[best] * stripe * (0.93 + 0.1 * blot));
        // Hedges along the boundaries, with gaps, and trees standing in them.
        if (edge < 4) {
          const gappy = noise.periodic2((x / size) * 128, (y / size) * 128, 128, 128);
          if (edge < 1.1 && gappy > -0.45) {
            set(HEDGE, 1);
            height = 0.28;
          }
          const tree = noise.periodic2((x / size) * 200 + 3.7, (y / size) * 200, 200, 200);
          if (tree > 0.1 + 0.05 * edge) {
            set(tree > 0.3 ? TREE_LIT : TREE, 1);
            height = 0.55 + 0.6 * (tree - 0.1);
          }
        }
      }

      // The river, with a fringe of grass and trees along its banks.
      const rd = Math.abs(wrapDiff(x - river, size)) / size;
      if (rd < RIVER_WIDTH * 0.5) {
        set(WATER, 1);
        height = 0;
      } else if (rd < RIVER_WIDTH * 0.5 + 2 / size) {
        set(BANK, 1);
        height = 0;
        if (blot > 0.15) {
          set(TREE, 1);
          height = 0.6;
        }
      }

      // Villages: lanes, gardens and roofs.
      if (villagesNear && rd >= RIVER_WIDTH) {
        for (let vk = 0; vk < VILLAGES; vk++) {
          const dy = villageDy[vk];
          const dx = wrapDiff(x - vx[vk], size);
          // Outside the village's square is outside the village.
          if (Math.abs(dx) >= VILLAGE_R || Math.abs(dy) >= VILLAGE_R) {
            continue;
          }
          const r = Math.hypot(dx, dy) / VILLAGE_R;
          if (r >= 1) {
            continue;
          }
          const lx = Math.floor((dx + 1204) / 7);
          const ly = Math.floor((dy + 1204) / 7);
          const lot = (((lx * 73856093) ^ (ly * 19349663) ^ (s * 83492791) ^ vk) >>> 0) % 1000;
          if (Math.abs(dx) < 0.8 || Math.abs(dy) < 0.8) {
            set(LANE, 1);
            height = 0;
          } else if (lot / 1000 < 0.85 * (1 - r) ** 0.3) {
            const fx = (dx + 1204) % 7;
            const fy = (dy + 1204) % 7;
            if (fx >= 1 && fx < 6 && fy >= 1.5 && fy < 5.5) {
              // A pitched roof, one slope a little lighter than the other.
              set(ROOFS[lot % ROOFS.length], fx < 3.5 ? 1.1 : 0.82);
              height = 0.45;
            } else if (r < 0.8) {
              set(GARDEN, 1);
              height = Math.min(height, 0.05);
            }
          } else if (r < 0.75) {
            set(GARDEN, 0.95 + 0.1 * blot);
            height = 0;
          }
        }
      }

      const o = (y * size + x) * 4;
      out[o] = Math.round(unit(rgb[0]) * 255);
      out[o + 1] = Math.round(unit(rgb[1]) * 255);
      out[o + 2] = Math.round(unit(rgb[2]) * 255);
      out[o + 3] = Math.round(unit(height) * 255);
    }
  }
  return out;
}

/* ----- Other balloons ----- */

/** The nearest and farthest the other balloons fly, metres. */
export const OTHER_NEAR = 550;
export const OTHER_FAR = 2600;
/** Their envelopes' radius, metres. */
export const OTHER_RADIUS = 9;
/** Their heights, as angles above (or below) the horizon, radians. */
export const OTHER_LOW = -0.07;
export const OTHER_HIGH = 0.12;
/** How far round they spread, radians either side: off-screen at the ends. */
export const OTHER_SPAN = 1.15;
/** How far they bob up and down, metres, and their slowest and fastest bob (s). */
export const BOB_METRES = 6;
export const BOB_MIN = 18;
export const BOB_MAX = 34;
/** Their fastest drift round relative to us, radians per second. */
export const OTHER_DRIFT = 0.0025;
/** Seconds to fade in or out when the count changes. */
export const OTHER_FADE = 2;

export interface Others {
  /** The balloons' looks and burners. */
  readonly field: Balloons;
  readonly az: Float64Array;
  readonly elev: Float64Array;
  readonly dist: Float64Array;
  readonly drift: Float64Array;
  readonly bob: Float64Array;
  readonly bobRate: Float64Array;
  readonly presence: Float64Array;
  /** Indices farthest first. */
  readonly order: Int32Array;
}

/** `MAX_OTHERS` balloons for `seed`, spread round the view at different distances and heights. */
export function createOthers(seed: number): Others {
  const s = Math.floor(seed);
  const rand = createRng(s * 4421 + 77);
  const n = MAX_OTHERS;
  const f64 = () => new Float64Array(n);
  const o: Others = {
    field: createBalloons(s, 16 / 9),
    az: f64(),
    elev: f64(),
    dist: f64(),
    drift: f64(),
    bob: f64(),
    bobRate: f64(),
    presence: f64(),
    order: new Int32Array(n),
  };
  const phase = rand();
  for (let i = 0; i < n; i++) {
    // Golden-ratio spreads, so any first few are spread round and in depth.
    const side = i % 2 === 0 ? -1 : 1;
    o.az[i] = side * mix(0.12, 0.95, (phase + i * 0.381966) % 1);
    o.dist[i] = mix(OTHER_NEAR, OTHER_FAR, (phase * 1.7 + i * 0.618034) % 1);
    o.elev[i] = mix(OTHER_LOW, OTHER_HIGH, rand());
    o.drift[i] = (rand() * 2 - 1) * OTHER_DRIFT;
    o.bob[i] = rand();
    o.bobRate[i] = 1 / mix(BOB_MIN, BOB_MAX, rand());
    o.order[i] = i;
  }
  o.order.sort((a, b) => o.dist[b] - o.dist[a]);
  return o;
}

/** Clamps the `others` param to a whole number of balloons. */
export const otherCount = (count: number) =>
  clamp(Math.round(Number.isFinite(count) ? count : 0), 0, MAX_OTHERS);

/**
 * Advances the other balloons `dt` seconds: drifting slowly round (wrapping
 * only out of view), bobbing, fading in or out with `count`, and their
 * burners firing now and then. Allocates nothing.
 */
export function stepOthers(o: Others, dt: number, count: number): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const active = otherCount(count);
  stepBalloons(o.field, step, o.field.aspect, 0, MAX_BALLOONS);
  for (let i = 0; i < MAX_OTHERS; i++) {
    o.az[i] = wrap(o.az[i] + o.drift[i] * step, -OTHER_SPAN, 2 * OTHER_SPAN);
    o.bob[i] = (o.bob[i] + o.bobRate[i] * step) % 1;
    o.presence[i] = approach(o.presence[i], i < active ? 1 : 0, step / OTHER_FADE);
  }
}

/**
 * Writes the visible balloons as Hot-Air Balloons sprite instances
 * (`BALLOON_FLOATS` each) into `out`, farthest first, for a frame `width` x
 * `height` px with the balloon turned `yaw`, gore colours from `palette`.
 * Returns how many. Allocates nothing.
 */
export function writeOthers(
  o: Others,
  out: Float32Array,
  palette: readonly Rgb[],
  width: number,
  height: number,
  yaw: number,
): number {
  const b = o.field;
  let n = 0;
  for (let k = 0; k < MAX_OTHERS; k++) {
    const i = o.order[k];
    const rel = o.az[i] - yaw;
    if (!(o.presence[i] > 0) || Math.abs(rel) > 1.3) {
      continue;
    }
    const d = o.dist[i];
    const r = ((FOCAL * OTHER_RADIUS) / d) * height;
    const x = width / 2 + FOCAL * Math.tan(rel) * height;
    if (x < -2 * r || x > width + 2 * r) {
      continue;
    }
    const lift = Math.tan(o.elev[i]) + (BOB_METRES / d) * Math.sin(TAU * o.bob[i]);
    const y = height * (0.5 + HORIZON + FOCAL * lift);
    const at = n * BALLOON_FLOATS;
    out[at] = x;
    out[at + 1] = y;
    out[at + 2] = r;
    out[at + 3] = o.presence[i];
    for (let c = 0; c < 3; c++) {
      const col = palette[b.colors[i * 3 + c] % palette.length];
      out[at + 4 + c * 4] = col[0];
      out[at + 5 + c * 4] = col[1];
      out[at + 6 + c * 4] = col[2];
    }
    // A little haze even near, as over the fields.
    out[at + 7] = 0.1 + 0.9 * (1 - Math.exp(-d / HAZE_METRES));
    out[at + 11] = burnGlow(b.burnAge[i], b.burnLen[i]);
    out[at + 15] = b.gores[i];
    out[at + 16] = b.spin[i];
    out[at + 17] = b.colorCount[i];
    n++;
  }
  return n;
}
