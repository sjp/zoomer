/**
 * Rainy Greenhouse's simulation, kept free of GL so it can be tested: palettes,
 * the roof geometry (glazing bars and the eave curve), rain rivulets running down
 * the panes, drips falling from the eave, the seeded leaf layout per depth layer,
 * and the damped bob spring each leaf gets when a drip hits it.
 *
 * Positions are in height units: 1 = the frame height, y down from the top, x from
 * 0 to the aspect ratio. Leaves anchor to an edge (a fraction of the width plus an
 * offset in heights), so they hug the edges at every aspect ratio.
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { DENSITY_MAX, type PaletteId, type RoofId } from "./greenhouse.meta";
import { clamp, fract, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { STREAK_FLOATS } from "../streaks";
import { lookup } from "../lookup";
import { createSwell, type Swell } from "../sway";
import { ribbonStrip } from "../sprites";

const TAU = Math.PI * 2;

// --- Palettes ---------------------------------------------------------------

interface GreenhousePalette {
  /** Glass overhead: near the top of the frame and down at the eave. */
  readonly glassTop: Rgb;
  readonly glassLow: Rgb;
  /** Humid haze in the middle distance, and the dim floor. */
  readonly haze: Rgb;
  readonly floor: Rgb;
  /** Iron glazing bars. */
  readonly bar: Rgb;
  /** Leaf colours per depth layer, far to near. */
  readonly leaves: readonly [Rgb, Rgb, Rgb];
  /** Midrib and vein colour, and the translucent edge glow. */
  readonly rib: Rgb;
  readonly glow: Rgb;
  /** Rivulet and drip highlight (additive). */
  readonly glint: Rgb;
  /** Shares of leaf kinds: broad (banana), monstera, palm frond, fern frond. */
  readonly kinds: readonly [number, number, number, number];
}

const hex = hexToUnitRgb;

export const PALETTES: Readonly<Record<PaletteId, GreenhousePalette>> = {
  jungle: {
    glassTop: hex("#e3ebdf"),
    glassLow: hex("#bccbb8"),
    haze: hex("#a3b6a2"),
    floor: hex("#3d4f3f"),
    bar: hex("#28312a"),
    leaves: [hex("#7f9b84"), hex("#3f6647"), hex("#18341e")],
    rib: hex("#7fa36b"),
    glow: hex("#a9d47c"),
    glint: [0.22, 0.24, 0.23],
    kinds: [0.28, 0.3, 0.27, 0.15],
  },
  fern: {
    glassTop: hex("#e6edea"),
    glassLow: hex("#c3d1cc"),
    haze: hex("#aabdb7"),
    floor: hex("#40544a"),
    bar: hex("#2e3936"),
    leaves: [hex("#89a596"), hex("#456c56"), hex("#1c3a2c")],
    rib: hex("#86ad7f"),
    glow: hex("#b4dc98"),
    glint: [0.22, 0.24, 0.24],
    kinds: [0.08, 0.1, 0.12, 0.7],
  },
  evening: {
    glassTop: hex("#8f93a6"),
    glassLow: hex("#6c7584"),
    haze: hex("#5b6a66"),
    floor: hex("#1d2824"),
    bar: hex("#171c1f"),
    leaves: [hex("#4b5f56"), hex("#263a30"), hex("#0f1f18")],
    rib: hex("#4f6b4a"),
    glow: hex("#c9ad74"),
    glint: [0.15, 0.15, 0.19],
    kinds: [0.28, 0.3, 0.27, 0.15],
  },
};

export const paletteOf = (v: string): PaletteId => (v === "fern" || v === "evening" ? v : "jungle");
export const roofOf = (v: string): RoofId => (v === "pitched" || v === "hidden" ? v : "arched");

// --- Clouds -----------------------------------------------------------------

/** Seconds per cloud cycle; the cloud phase wraps at 1 and the shader uses whole multiples of it. */
export const CLOUD_PERIOD = 240;

/**
 * How much the clouds have thinned at cloud phase `phase` (periodic, period 1):
 * 0 most of the time, rising smoothly to at most 1 a few times per cycle.
 */
export function cloudThin(phase: number): number {
  const t = TAU * fract(phase);
  const s = 0.5 + 0.5 * (0.6 * Math.sin(3 * t) + 0.4 * Math.sin(7 * t + 1.3));
  return smoothstep(0.62, 0.95, s);
}

// --- Roof -------------------------------------------------------------------

/** Eave y (heights from the top) at the frame's sides, and at the middle for each roof. */
export const EAVE_EDGE = 0.4;
export const EAVE_CENTRE: Readonly<Record<Exclude<RoofId, "hidden">, number>> = {
  arched: 0.17,
  pitched: 0.13,
};
/** The rafters converge on a point this far above the frame (heights), at mid-width. */
const VANISH_Y = -0.75;
/** Panes across the frame per unit of aspect ratio. */
const PANES_PER_ASPECT = 6;
/** Purlins (cross bars) per pane, evenly spaced between the eave and the top of the frame. */
const PURLINS = 2;
/** Shader codes for the roof kinds. */
export const ROOF_CODE: Readonly<Record<RoofId, number>> = { hidden: 0, arched: 1, pitched: 2 };

/**
 * Eave y (heights from the top) at `u` (0..1 across the width) for a roof kind:
 * a half-ellipse for "arched", a gable for "pitched", and above the frame (-1) for
 * "hidden". Mirrored by `EAVE_GLSL`.
 */
export function eaveY(roof: RoofId, u: number): number {
  if (roof === "hidden") {
    return -1;
  }
  const c = clamp(2 * u - 1, -1, 1);
  const shape = roof === "arched" ? Math.sqrt(Math.max(0, 1 - c * c)) : 1 - Math.abs(c);
  return EAVE_EDGE + (EAVE_CENTRE[roof] - EAVE_EDGE) * shape;
}

/** GLSL twin of `eaveY`: `float eaveY(float u, vec3 eave)`, eave = (code, edge, centre). */
export const EAVE_GLSL = /* glsl */ `
float eaveY(float u, vec3 eave) {
  if (eave.x < 0.5) return -1.0;
  float c = clamp(2.0 * u - 1.0, -1.0, 1.0);
  float shape = eave.x < 1.5 ? sqrt(max(0.0, 1.0 - c * c)) : 1.0 - abs(c);
  return mix(eave.y, eave.z, shape);
}
`;

export interface Roof {
  readonly kind: Exclude<RoofId, "hidden">;
  readonly aspect: number;
  readonly panes: number;
  /** Rafter feet on the eave, `panes + 1` of them (heights). */
  readonly footX: Float64Array;
  readonly footY: Float64Array;
  readonly vanishX: number;
  readonly vanishY: number;
}

/** The roof for a kind and aspect ratio; null for "hidden". */
export function buildRoof(roof: RoofId, aspect: number): Roof | null {
  if (roof === "hidden") {
    return null;
  }
  const a = Number.isFinite(aspect) && aspect > 0.1 ? aspect : 16 / 9;
  const panes = Math.max(2, Math.round(a * PANES_PER_ASPECT));
  const footX = new Float64Array(panes + 1);
  const footY = new Float64Array(panes + 1);
  for (let i = 0; i <= panes; i++) {
    const u = i / panes;
    footX[i] = u * a;
    footY[i] = eaveY(roof, u);
  }
  return { kind: roof, aspect: a, panes, footX, footY, vanishX: a / 2, vanishY: VANISH_Y };
}

/**
 * The point on the roof at rafter coordinate `r` (0..panes; pane i spans
 * [i, i + 1]) and height fraction `f` (0 on the eave, 1 at the vanishing point).
 * Within a pane, a fixed `f` is a straight line between the two rafters.
 */
export function roofPoint(roof: Roof, r: number, f: number, out: [number, number]): void {
  const rr = clamp(r, 0, roof.panes);
  const i = Math.min(roof.panes - 1, Math.floor(rr));
  const s = rr - i;
  const bx = roof.footX[i] + (roof.footX[i + 1] - roof.footX[i]) * s;
  const by = roof.footY[i] + (roof.footY[i + 1] - roof.footY[i]) * s;
  out[0] = bx + (roof.vanishX - bx) * f;
  out[1] = by + (roof.vanishY - by) * f;
}

/** Eave y (heights) at rafter coordinate `r`: straight between rafter feet. */
export function eaveAt(roof: Roof, r: number): number {
  const rr = clamp(r, 0, roof.panes);
  const i = Math.min(roof.panes - 1, Math.floor(rr));
  return roof.footY[i] + (roof.footY[i + 1] - roof.footY[i]) * (rr - i);
}

/** Height fraction `f` at which rafter coordinate `r` meets y = `y` (the frame top for 0). */
function roofTopF(roof: Roof, r: number, y = 0): number {
  const by = eaveAt(roof, r);
  return (by - y) / (by - roof.vanishY);
}

/** Floats per bar instance: (ax, ay, bx, by) in heights, (half width ref px, shade, 0, 0). */
export const BAR_FLOATS = 8;
/** Half widths (reference px) of the eave plate, rafters and purlins. */
const BAR_WIDTH = { eave: 4, rafter: 2, purlin: 1.2 } as const;
/** Bars for the widest supported aspect (4:1). */
export const MAX_BARS = (Math.round(4 * PANES_PER_ASPECT) + 1) * (2 + PURLINS);

/** Writes the roof's glazing bars into `out` (`BAR_FLOATS` each); returns the count. */
export function writeBars(roof: Roof | null, out: Float32Array): number {
  if (!roof) {
    return 0;
  }
  let n = 0;
  const p: [number, number] = [0, 0];
  const q: [number, number] = [0, 0];
  const put = (ax: number, ay: number, bx: number, by: number, w: number, shade: number) => {
    if (n >= MAX_BARS || (n + 1) * BAR_FLOATS > out.length) {
      return;
    }
    const o = n * BAR_FLOATS;
    out[o] = ax;
    out[o + 1] = ay;
    out[o + 2] = bx;
    out[o + 3] = by;
    out[o + 4] = w;
    out[o + 5] = shade;
    out[o + 6] = 0;
    out[o + 7] = 0;
    n++;
  };
  // Purlins first, then rafters over them, then the eave plate over both.
  for (let k = 1; k <= PURLINS; k++) {
    const g = k / (PURLINS + 1);
    for (let i = 0; i < roof.panes; i++) {
      roofPoint(roof, i, g * roofTopF(roof, i), p);
      roofPoint(roof, i + 1, g * roofTopF(roof, i + 1), q);
      put(p[0], p[1], q[0], q[1], BAR_WIDTH.purlin, 0.9);
    }
  }
  for (let i = 0; i <= roof.panes; i++) {
    roofPoint(roof, i, roofTopF(roof, i, -0.02), p);
    put(roof.footX[i], roof.footY[i], p[0], p[1], BAR_WIDTH.rafter, 1);
  }
  for (let i = 0; i < roof.panes; i++) {
    put(roof.footX[i], roof.footY[i], roof.footX[i + 1], roof.footY[i + 1], BAR_WIDTH.eave, 1.1);
  }
  return n;
}

// --- Rivulets ---------------------------------------------------------------

export const MAX_RIVULETS = 48;
/** Streak segments per rivulet trail. */
export const TRAIL_SEGS = 6;
/** Rivulets stay this far (fraction of a pane) inside their pane's rafters. */
export const PANE_MARGIN = 0.12;
/** Head speed range down the glass, heights per second. */
const RIVULET_SPEED = [0.018, 0.045] as const;
/** Trail length, as a fraction of the pane's height from eave to frame top. */
const TRAIL_LENGTH = [0.18, 0.4] as const;
/** Trail half width (reference px) and brightness at the head. */
const RIVULET_WIDTH = 1.1;
/** Seconds a new rivulet takes to fade in. */
const RIVULET_FADE = 1.5;

interface Rivulets {
  readonly rng: () => number;
  /** Per rivulet: alive flag, pane, path amplitude and wiggle (two wave numbers and phases). */
  readonly alive: Uint8Array;
  readonly pane: Float64Array;
  readonly amp: Float64Array;
  readonly k1: Float64Array;
  readonly k2: Float64Array;
  readonly p1: Float64Array;
  readonly p2: Float64Array;
  /** Head height fraction, where it started, trail length (in f), speed (heights/s), age (s), stall clock. */
  readonly f: Float64Array;
  readonly start: Float64Array;
  readonly trail: Float64Array;
  readonly speed: Float64Array;
  readonly age: Float64Array;
  readonly clock: Float64Array;
}

export function createRivulets(seed: number): Rivulets {
  const n = MAX_RIVULETS;
  return {
    rng: createRng(seed ^ 0x51a7),
    alive: new Uint8Array(n),
    pane: new Float64Array(n),
    amp: new Float64Array(n),
    k1: new Float64Array(n),
    k2: new Float64Array(n),
    p1: new Float64Array(n),
    p2: new Float64Array(n),
    f: new Float64Array(n),
    start: new Float64Array(n),
    trail: new Float64Array(n),
    speed: new Float64Array(n),
    age: new Float64Array(n),
    clock: new Float64Array(n),
  };
}

/** Kills every rivulet, e.g. after the roof changes. */
export function resetRivulets(riv: Rivulets): void {
  riv.alive.fill(0);
}

/**
 * Rafter coordinate of rivulet `i` at height fraction `f`: its pane's middle plus
 * a meander of at most `amp`, which stays within `PANE_MARGIN` of the rafters.
 */
export function rivuletR(riv: Rivulets, i: number, f: number): number {
  const w = 0.62 * Math.sin(riv.k1[i] * f + riv.p1[i]) + 0.38 * Math.sin(riv.k2[i] * f + riv.p2[i]);
  return riv.pane[i] + 0.5 + riv.amp[i] * w;
}

function spawnRivulet(riv: Rivulets, roof: Roof, i: number, randomHead: boolean): void {
  const rng = riv.rng;
  riv.alive[i] = 1;
  riv.pane[i] = Math.min(roof.panes - 1, Math.floor(rng() * roof.panes));
  riv.amp[i] = (0.5 - PANE_MARGIN) * (0.3 + 0.7 * rng());
  riv.k1[i] = 18 + 14 * rng();
  riv.k2[i] = 40 + 25 * rng();
  riv.p1[i] = TAU * rng();
  riv.p2[i] = TAU * rng();
  // The lower of the pane's two rafter tops, so a meander never leaves the frame.
  const top = Math.min(roofTopF(roof, riv.pane[i]), roofTopF(roof, riv.pane[i] + 1));
  riv.start[i] = top * (0.7 + 0.3 * rng());
  riv.f[i] = randomHead ? riv.start[i] * rng() : riv.start[i];
  riv.trail[i] = top * (TRAIL_LENGTH[0] + (TRAIL_LENGTH[1] - TRAIL_LENGTH[0]) * rng());
  riv.speed[i] = RIVULET_SPEED[0] + (RIVULET_SPEED[1] - RIVULET_SPEED[0]) * rng();
  riv.age[i] = randomHead ? RIVULET_FADE : 0;
  riv.clock[i] = TAU * rng();
}

/**
 * Advances the rivulets by `dt` seconds. `rain` (0..1) sets how many run at once;
 * extra ones finish their run and are not replaced. Heads move down the pane with
 * a slow stop-go; a rivulet respawns once its whole trail has drained off the eave.
 */
export function stepRivulets(riv: Rivulets, roof: Roof | null, dt: number, rain: number): void {
  if (!roof) {
    return;
  }
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const active = Math.round(clamp(rain, 0, 1) * MAX_RIVULETS);
  for (let i = 0; i < MAX_RIVULETS; i++) {
    if (!riv.alive[i]) {
      // Stagger new arrivals instead of spawning them all in one frame.
      if (i < active && riv.rng() < step * 0.8) {
        spawnRivulet(riv, roof, i, false);
      }
      continue;
    }
    riv.age[i] += step;
    riv.clock[i] += step * 0.9;
    const s = 0.5 + 0.5 * Math.sin(riv.clock[i]);
    const v = riv.speed[i] * (0.3 + 0.7 * s * s);
    // dF/dt = v / (eave y - vanish y) at the pane's middle.
    const span = eaveAt(roof, riv.pane[i] + 0.5) - roof.vanishY;
    riv.f[i] -= (v * step) / Math.max(0.05, span);
    if (riv.f[i] + riv.trail[i] <= 0) {
      riv.alive[i] = 0;
      if (i < active) {
        spawnRivulet(riv, roof, i, false);
      }
    }
  }
}

/**
 * Writes the rivulet trails as streaks (`STREAK_FLOATS` each, device px) into
 * `out` starting at streak `first`; returns the number written. Each trail is
 * `TRAIL_SEGS` segments from its head up to its tail (never above where it
 * started), brightest at the head, clipped at the eave.
 */
export function writeRivulets(
  riv: Rivulets,
  roof: Roof | null,
  height: number,
  scale: number,
  glint: Rgb,
  out: Float32Array,
  first = 0,
): number {
  if (!roof) {
    return 0;
  }
  let n = first;
  const max = Math.floor(out.length / STREAK_FLOATS);
  const p: [number, number] = [0, 0];
  const hw = RIVULET_WIDTH * scale;
  for (let i = 0; i < MAX_RIVULETS; i++) {
    if (!riv.alive[i]) {
      continue;
    }
    const fade = Math.min(1, riv.age[i] / RIVULET_FADE);
    const head = Math.max(0, riv.f[i]);
    const tail = Math.min(riv.start[i], riv.f[i] + riv.trail[i]);
    if (!(tail > head)) {
      continue;
    }
    let fa = head;
    roofPoint(roof, rivuletR(riv, i, fa), fa, p);
    let ax = p[0] * height;
    let ay = p[1] * height;
    for (let k = 1; k <= TRAIL_SEGS && n < max; k++) {
      const fb = head + ((tail - head) * k) / TRAIL_SEGS;
      roofPoint(roof, rivuletR(riv, i, fb), fb, p);
      const bx = p[0] * height;
      const by = p[1] * height;
      const w = fade * (1 - (k - 1) / TRAIL_SEGS) ** 1.5;
      const o = n * STREAK_FLOATS;
      out[o] = bx;
      out[o + 1] = by;
      out[o + 2] = ax;
      out[o + 3] = ay;
      out[o + 4] = glint[0] * w;
      out[o + 5] = glint[1] * w;
      out[o + 6] = glint[2] * w;
      out[o + 7] = hw;
      n++;
      fa = fb;
      ax = bx;
      ay = by;
    }
  }
  return n - first;
}

// --- Drips ------------------------------------------------------------------

export const MAX_DRIPS = 24;
/** Drips per second at full rain (a trickle remains at rain 0). */
const DRIP_RATE = 1.4;
/** Gravity (heights / s²) and how far a drip falls before it has faded (heights). */
const DRIP_GRAVITY = 1.2;
const DRIP_FALL = 0.45;
/** Drip half width (reference px) and the seconds of motion its streak shows. */
const DRIP_WIDTH = 1.2;
const DRIP_BLUR = 0.035;

interface Drips {
  readonly rng: () => number;
  readonly alive: Uint8Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly y0: Float64Array;
  readonly v: Float64Array;
  /** Fractional drips owed to the spawn schedule. */
  debt: number;
}

export function createDrips(seed: number): Drips {
  return {
    rng: createRng(seed ^ 0xd219),
    alive: new Uint8Array(MAX_DRIPS),
    x: new Float64Array(MAX_DRIPS),
    y: new Float64Array(MAX_DRIPS),
    y0: new Float64Array(MAX_DRIPS),
    v: new Float64Array(MAX_DRIPS),
    debt: 0,
  };
}

/** Advances the drips; new ones fall from rafter feet on the eave while `on`. */
export function stepDrips(
  d: Drips,
  roof: Roof | null,
  dt: number,
  rain: number,
  on: boolean,
): void {
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  for (let i = 0; i < MAX_DRIPS; i++) {
    if (!d.alive[i]) {
      continue;
    }
    d.v[i] += DRIP_GRAVITY * step;
    d.y[i] += d.v[i] * step;
    if (d.y[i] - d.y0[i] > DRIP_FALL) {
      d.alive[i] = 0;
    }
  }
  if (!roof || !on) {
    d.debt = 0;
    return;
  }
  d.debt += step * DRIP_RATE * (0.15 + 0.85 * clamp(rain, 0, 1));
  while (d.debt >= 1) {
    d.debt -= 1;
    const i = d.alive.indexOf(0);
    if (i < 0) {
      break;
    }
    // Skip the two outermost feet, which sit on the frame's edge.
    const foot = 1 + Math.floor(d.rng() * Math.max(1, roof.panes - 1));
    d.alive[i] = 1;
    d.x[i] = roof.footX[foot];
    d.y[i] = d.y0[i] = roof.footY[foot] + 0.006;
    d.v[i] = 0.02;
  }
}

/** Writes falling drips as short streaks after `first`; returns the number written. */
export function writeDrips(
  d: Drips,
  height: number,
  scale: number,
  glint: Rgb,
  out: Float32Array,
  first = 0,
): number {
  let n = first;
  const max = Math.floor(out.length / STREAK_FLOATS);
  for (let i = 0; i < MAX_DRIPS && n < max; i++) {
    if (!d.alive[i]) {
      continue;
    }
    const fall = (d.y[i] - d.y0[i]) / DRIP_FALL;
    const w = 1.6 * smoothstep(0, 0.05, fall) * (1 - smoothstep(0.4, 1, fall));
    const o = n * STREAK_FLOATS;
    out[o] = d.x[i] * height;
    out[o + 1] = (d.y[i] - d.v[i] * DRIP_BLUR) * height;
    out[o + 2] = d.x[i] * height;
    out[o + 3] = d.y[i] * height;
    out[o + 4] = glint[0] * w;
    out[o + 5] = glint[1] * w;
    out[o + 6] = glint[2] * w;
    out[o + 7] = DRIP_WIDTH * scale;
    n++;
  }
  return n - first;
}

// --- Leaves -----------------------------------------------------------------

/** Leaf shapes, as the fragment shader knows them. Palms and ferns are both fronds. */
const KIND_BROAD = 0;
export const KIND_MONSTERA = 1;
export const KIND_FROND = 2;

/** The swell the leaves sway with: very slow, still air (period 80 s at speed 1). */
export const GREENHOUSE_SWELL: Swell = createSwell(80, [
  { cycles: 8, amplitude: 1, offset: 0 },
  { cycles: 5, amplitude: 0.6, offset: 0.27 },
  { cycles: 13, amplitude: 0.25, offset: 0.61 },
]);
/** Seconds a leaf's tip trails its base, per height of leaf length. */
const LAG_PER_LENGTH = 2.2;
/** Seconds the swell takes to cross the frame, so neighbours don't sway in lockstep. */
const SWELL_TRAVEL = 4;

interface LeafLayer {
  /** Plants at density 1, and leaves per plant (inclusive range). */
  readonly plants: number;
  readonly leaves: readonly [number, number];
  /** Plant leaf length range (heights). */
  readonly length: readonly [number, number];
  /** Base y range for the side plants (heights from the top). */
  readonly y: readonly [number, number];
  /** Haze mix at haze 0.5, edge softness (reference px), tip sway (fraction of length). */
  readonly haze: number;
  readonly blur: number;
  readonly sway: number;
  /** Strength of the veins and the translucent edge glow. */
  readonly detail: number;
  readonly glow: number;
}

/** Far to near. */
export const LEAF_LAYERS: readonly LeafLayer[] = [
  {
    plants: 11,
    leaves: [3, 5],
    length: [0.16, 0.3],
    y: [0.3, 0.95],
    haze: 0.55,
    blur: 2.5,
    sway: 0.035,
    detail: 0.15,
    glow: 0.1,
  },
  {
    plants: 7,
    leaves: [3, 5],
    length: [0.3, 0.5],
    y: [0.4, 1.05],
    haze: 0.25,
    blur: 1.5,
    sway: 0.03,
    detail: 0.45,
    glow: 0.22,
  },
  {
    plants: 4,
    leaves: [3, 4],
    length: [0.5, 0.82],
    y: [0.55, 1.15],
    haze: 0.04,
    blur: 1,
    sway: 0.025,
    detail: 0.8,
    glow: 0.35,
  },
];

/** Floats per leaf instance (see `writeLeaves`). */
export const LEAF_FLOATS = 16;
/** Offset of the bob value within a leaf instance. */
export const BOB_OFFSET = 11;
export const MAX_LEAVES = LEAF_LAYERS.reduce(
  (n, l) => n + Math.round(l.plants * DENSITY_MAX) * l.leaves[1],
  0,
);

/** Segments along a leaf's midrib, and the strip: (segment index, side) per vertex. */
export const LEAF_SEGMENTS = 16;
export const LEAF_STRIP: readonly number[] = ribbonStrip(LEAF_SEGMENTS);

interface Leaf {
  readonly layer: number;
  /**
   * Identifies the leaf across rebuilds: its layer, plant and place in the
   * plant. The same key means the same leaf in the same place.
   */
  readonly key: number;
  /** Anchor: fraction of the width, plus an x offset and the y (heights). */
  readonly anchor: number;
  readonly offX: number;
  readonly y: number;
  /** Length from the stalk's foot to the tip (heights). */
  readonly length: number;
  /** Start angle (radians; 0 = up, +π/2 = right) and the total bend along the leaf (radians). */
  readonly angle: number;
  readonly curve: number;
  /** Blade half width as a fraction of the length. */
  readonly width: number;
  readonly kind: number;
  /** Stalk share of the length, colour tone, slit seed (0..1), leaflets per frond. */
  readonly stalk: number;
  readonly tone: number;
  readonly cut: number;
  readonly leaflets: number;
  /** Sway phase offset (periods) and lag (seconds). */
  readonly phase: number;
  readonly lag: number;
}

export interface LeafLayout {
  readonly leaves: readonly Leaf[];
  /** Leaves per layer and the index each layer starts at (far first). */
  readonly counts: readonly number[];
  readonly starts: readonly number[];
}

/** The aspect ratio the layout is checked against. */
export const LAYOUT_ASPECT = 16 / 9;

/** The region kept clear for the speaker: the centre third of the width, below the roof. */
export function inCentre(x: number, y: number, aspect = LAYOUT_ASPECT): boolean {
  const u = x / aspect;
  return u > 0.34 && u < 0.66 && y > 0.2 && y < 0.82;
}

/**
 * A point on a leaf's midrib at `t` (0 = the stalk's foot, 1 = the tip), at rest:
 * an arc of constant curvature. Mirrored by the leaf vertex shader.
 */
export function leafPoint(leaf: Leaf, t: number, aspect: number, out: [number, number]): void {
  const a0 = leaf.angle;
  const k = leaf.curve;
  const L = leaf.length;
  let dx: number;
  let dy: number;
  if (Math.abs(k) > 1e-3) {
    dx = (Math.cos(a0) - Math.cos(a0 + k * t)) / k;
    dy = -(Math.sin(a0 + k * t) - Math.sin(a0)) / k;
  } else {
    dx = t * Math.sin(a0);
    dy = -t * Math.cos(a0);
  }
  out[0] = leaf.anchor * aspect + leaf.offX + L * dx;
  out[1] = leaf.y + L * dy;
}

/** Key spacing (see `Leaf.key`): plants per layer and leaves per plant, both above any layout's. */
const PLANT_KEYS = 4096;
const LEAF_KEYS = 64;

const range = (rng: () => number, r: readonly [number, number]) => r[0] + (r[1] - r[0]) * rng();

/** Picks a leaf kind index (0 broad, 1 monstera, 2 palm, 3 fern) from a palette's shares and `u` (0..1). */
function pickKind(u: number, shares: readonly number[]): number {
  let total = 0;
  for (const s of shares) {
    total += s;
  }
  let x = u * total;
  for (let k = 0; k < shares.length; k++) {
    x -= shares[k];
    if (x < 0) {
      return k;
    }
  }
  return shares.length - 1;
}

/** Whether a leaf's midrib stays out of the centre region at the layout aspect. */
function staysClear(leaf: Leaf): boolean {
  const p: [number, number] = [0, 0];
  for (let s = 1; s <= 20; s++) {
    leafPoint(leaf, s / 20, LAYOUT_ASPECT, p);
    if (inCentre(p[0], p[1])) {
      return false;
    }
  }
  return true;
}

/**
 * The seeded leaf layout: per layer (far to near), plants rooted at the left,
 * right and bottom edges, each a clump of one leaf kind fanning inwards and
 * drooping. Leaves that would reach into the centre third are shortened or
 * dropped. Deterministic per (seed, density, palette).
 *
 * Each plant draws from its own random stream, and its kind from its own hash,
 * so the layout is prefix-stable: more density adds plants at the end of each
 * layer and leaves every other plant where it was, and a palette change only
 * changes kinds (and the shapes that follow from them), not where plants grow.
 */
export function buildLeaves(seed: number, density: number, palette: PaletteId): LeafLayout {
  const base = hash32((Math.floor(seed) * 7919) ^ 0x6e3e);
  const d = clamp(Number.isFinite(density) ? density : 1, 0.1, DENSITY_MAX);
  const shares = lookup(PALETTES, palette, "jungle").kinds;
  const leaves: Leaf[] = [];
  const counts: number[] = [];
  const starts: number[] = [];
  for (let l = 0; l < LEAF_LAYERS.length; l++) {
    const layer = LEAF_LAYERS[l];
    starts.push(leaves.length);
    const plants = Math.max(1, Math.round(layer.plants * d));
    for (let pl = 0; pl < plants; pl++) {
      const plantHash = hash32(base ^ hash32(l * PLANT_KEYS + pl));
      const rng = createRng(plantHash);
      const kindIdx = pickKind(hash32(plantHash ^ 0x4b1d) / 4294967296, shares);
      const kind = kindIdx >= 2 ? KIND_FROND : kindIdx;
      const fern = kindIdx === 3;
      // Alternate sides so both edges stay full; one plant in five grows from the bottom.
      const where = rng() < 0.2 ? 2 : pl % 2;
      let anchor: number;
      let offX: number;
      let y: number;
      let main: number;
      if (where === 2) {
        anchor = rng() < 0.5 ? 0.04 + 0.3 * rng() : 0.66 + 0.3 * rng();
        offX = 0;
        y = 1.02 + 0.1 * rng();
        main = (anchor < 0.5 ? -1 : 1) * (0.1 + 0.45 * rng());
      } else {
        const side = where === 0 ? 1 : -1;
        anchor = where === 0 ? 0 : 1;
        offX = side * (-0.08 + 0.12 * rng());
        y = range(rng, layer.y);
        main = side * (0.15 + 1.1 * rng());
      }
      const plantLength = range(rng, layer.length) * (kind === KIND_MONSTERA ? 0.8 : 1);
      const n = layer.leaves[0] + Math.floor(rng() * (layer.leaves[1] - layer.leaves[0] + 1));
      const spread = kind === KIND_FROND ? 1.6 : 1.3;
      for (let k = 0; k < n; k++) {
        const along = n > 1 ? k / (n - 1) - 0.5 : 0;
        let angle = main + spread * along + 0.2 * (rng() - 0.5);
        const droop =
          kind === KIND_MONSTERA
            ? 0.25 + 0.4 * rng()
            : kind === KIND_FROND
              ? 0.6 + 0.9 * rng()
              : 0.4 + 0.7 * rng();
        let length = plantLength * (0.75 + 0.35 * rng());
        const width =
          kind === KIND_BROAD
            ? 0.09 + 0.03 * rng()
            : kind === KIND_MONSTERA
              ? 0.27 + 0.06 * rng()
              : fern
                ? 0.11 + 0.04 * rng()
                : 0.19 + 0.06 * rng();
        const stalk =
          kind === KIND_MONSTERA
            ? 0.3 + 0.1 * rng()
            : kind === KIND_BROAD
              ? 0.12 + 0.08 * rng()
              : 0.08 + 0.07 * rng();
        const tone = 0.85 + 0.3 * rng();
        const cut = rng();
        const leaflets = fern ? 20 + Math.floor(9 * rng()) : 12 + Math.floor(5 * rng());
        const lagJitter = 0.15 * rng();
        // Retry shorter (and nudged outwards) until the midrib stays clear.
        let placed: Leaf | null = null;
        for (let attempt = 0; attempt < 8 && !placed; attempt++) {
          const x0 = anchor * LAYOUT_ASPECT + offX;
          const leaf: Leaf = {
            layer: l,
            key: (l * PLANT_KEYS + pl) * LEAF_KEYS + k,
            anchor,
            offX,
            y,
            length,
            angle,
            curve: (angle >= 0 ? 1 : -1) * droop,
            width,
            kind,
            stalk,
            tone,
            cut,
            leaflets,
            phase: (x0 / LAYOUT_ASPECT) * (SWELL_TRAVEL / GREENHOUSE_SWELL.period) + 0.02 * cut,
            lag: LAG_PER_LENGTH * length + lagJitter,
          };
          if (staysClear(leaf)) {
            placed = leaf;
          }
          length *= 0.85;
          angle *= 1.06;
        }
        if (placed) {
          leaves.push(placed);
        }
      }
    }
    counts.push(leaves.length - starts[l]);
  }
  return { leaves, counts, starts };
}

/**
 * Writes the layout into `out`, `LEAF_FLOATS` per leaf in layout order:
 * (anchor, offX, y, length), (angle, curve, width, kind),
 * (phase, lag, sway, bob = 0), (tone, stalk, cut, leaflets). Returns the count.
 */
export function writeLeaves(layout: LeafLayout, out: Float32Array): number {
  const n = Math.min(layout.leaves.length, Math.floor(out.length / LEAF_FLOATS));
  for (let i = 0; i < n; i++) {
    const leaf = layout.leaves[i];
    const o = i * LEAF_FLOATS;
    out[o] = leaf.anchor;
    out[o + 1] = leaf.offX;
    out[o + 2] = leaf.y;
    out[o + 3] = leaf.length;
    out[o + 4] = leaf.angle;
    out[o + 5] = leaf.curve;
    out[o + 6] = leaf.width;
    out[o + 7] = leaf.kind;
    out[o + 8] = leaf.phase;
    out[o + 9] = leaf.lag;
    out[o + 10] = LEAF_LAYERS[leaf.layer].sway;
    out[o + 11] = 0;
    out[o + 12] = leaf.tone;
    out[o + 13] = leaf.stalk;
    out[o + 14] = leaf.cut;
    out[o + 15] = leaf.leaflets;
  }
  return n;
}

// --- Bob springs --------------------------------------------------------------

/** Damping ratio of a leaf's bob: a few visible wobbles, settled within seconds. */
const BOB_DAMPING = 0.16;
/** Tip velocity a drip adds, as a peak dip (fraction of the leaf's length). */
const BOB_KICK = 0.022;
/** Hard bound on the dip (fraction of the length). */
export const BOB_MAX = 0.08;
/** Kicks per leaf per second at full rain; a quarter of that when dry. */
export const BOB_RATE = 1 / 18;
/** Integration substep, seconds. */
const BOB_STEP = 1 / 60;

interface Bobs {
  readonly rng: () => number;
  /** Dip (fraction of the length, + = down), its velocity, and the angular frequency. */
  readonly x: Float64Array;
  readonly v: Float64Array;
  readonly omega: Float64Array;
}

/** One spring per leaf; bigger leaves bob more slowly. */
export function createBobs(lengths: readonly number[], seed: number): Bobs {
  const rng = createRng(seed ^ 0xb0b);
  const n = lengths.length;
  const omega = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const hz = (0.7 + 0.5 * rng()) / Math.sqrt(Math.max(0.05, lengths[i]) / 0.4);
    omega[i] = TAU * hz;
  }
  return { rng, x: new Float64Array(n), v: new Float64Array(n), omega };
}

/**
 * Carries each leaf's dip and its velocity from `from` to `to` across a
 * rebuild, matching leaves by key, so a density or palette change doesn't
 * reset the leaves that stay.
 */
export function carryBobs(
  from: Bobs,
  fromKeys: readonly number[],
  to: Bobs,
  toKeys: readonly number[],
): void {
  const at = new Map<number, number>();
  for (let i = 0; i < fromKeys.length && i < from.x.length; i++) {
    at.set(fromKeys[i], i);
  }
  for (let i = 0; i < toKeys.length && i < to.x.length; i++) {
    const j = at.get(toKeys[i]);
    if (j !== undefined) {
      to.x[i] = from.x[j];
      to.v[i] = from.v[j];
    }
  }
}

/**
 * Advances every spring by `dt` (capped at 0.1 s) with semi-implicit Euler
 * substeps, kicking leaves downwards at random at `rate` kicks per second each,
 * and clamps the dip to `BOB_MAX`. With `out`, writes each dip at
 * `i * LEAF_FLOATS + BOB_OFFSET`.
 */
export function stepBobs(b: Bobs, dt: number, rate: number, out?: Float32Array): void {
  const total = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
  const steps = Math.max(1, Math.ceil(total / BOB_STEP));
  const h = total / steps;
  const n = b.x.length;
  const p = Math.max(0, rate) * total;
  for (let i = 0; i < n; i++) {
    const w = b.omega[i];
    let x = b.x[i];
    let v = b.v[i];
    if (p > 0 && b.rng() < p) {
      v += BOB_KICK * w * (0.6 + 0.4 * b.rng());
    }
    for (let s = 0; s < steps; s++) {
      v += (-w * w * x - 2 * BOB_DAMPING * w * v) * h;
      x += v * h;
    }
    if (x > BOB_MAX || x < -BOB_MAX) {
      x = clamp(x, -BOB_MAX, BOB_MAX);
      v = 0;
    }
    b.x[i] = x;
    b.v[i] = v;
    if (out) {
      out[i * LEAF_FLOATS + BOB_OFFSET] = x;
    }
  }
}
