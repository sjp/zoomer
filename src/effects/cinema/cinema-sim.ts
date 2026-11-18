/**
 * Cinema Auditorium's layout and timing, apart from GL: the films' palettes
 * for the shared shot schedule, the show's transition between "before the
 * show" and "film playing", the auditorium's geometry, the projector beam's
 * shape and the dust motes drifting through it.
 *
 * Screen positions are in design units: frame heights at 16:9, origin at the
 * frame's centre, y up. The auditorium facing the projector is a perspective
 * view: room positions are in metres, x right, y up from the floor of the
 * speaker's row, z away from the camera towards the back wall.
 */
import { clamp, fract, smoothstep } from "../math";
import { hash32 } from "../noise";
import { fitScale } from "../scene-layout";
import { buildPalette, look, type ShotPalette } from "../shot-schedule";

type Film = "drama" | "scifi" | "western" | "animation";
export type View = "projector" | "screen";

/** Each film's palette: the looks its shots light the room with, and their pacing. */
export const FILM_PALETTES: Readonly<Record<Film, ShotPalette>> = {
  drama: buildPalette({
    looks: [
      look("#d8a878", 0.5, 0.8, 3),
      look("#8a9ab8", 0.45, 0.75, 2),
      look("#405890", 0.28, 0.62, 1.5),
      look("#e8d0b0", 0.55, 0.85, 1),
      look("#a07060", 0.36, 0.7, 1.5),
    ],
    shot: [5, 18],
    events: 0.06,
    boost: 0.12,
    bursts: ["#ffd8a0"],
  }),
  scifi: buildPalette({
    looks: [
      look("#5a8cff", 0.5, 0.78, 3),
      look("#40d0e0", 0.42, 0.7, 2),
      look("#2a3a80", 0.24, 0.55, 2),
      look("#c0d8ff", 0.58, 0.85, 1),
      look("#7a5cff", 0.36, 0.68, 1),
    ],
    shot: [4, 14],
    events: 0.3,
    boost: 0.2,
    bursts: ["#a0e0ff", "#ffffff", "#ff9a5a"],
  }),
  western: buildPalette({
    looks: [
      look("#ffb060", 0.55, 0.85, 3),
      look("#e09050", 0.45, 0.78, 2),
      look("#c87040", 0.36, 0.7, 1.5),
      look("#f0d8a8", 0.58, 0.88, 1.5),
      look("#a05830", 0.24, 0.6, 1),
    ],
    shot: [6, 20],
    events: 0.12,
    boost: 0.18,
    bursts: ["#ffa040", "#fff0c0"],
  }),
  animation: buildPalette({
    looks: [
      look("#ff7ab0", 0.5, 0.8, 1.5),
      look("#ffd040", 0.55, 0.82, 1.5),
      look("#50d070", 0.5, 0.78, 1.5),
      look("#40a0ff", 0.5, 0.8, 1.5),
      look("#b070ff", 0.45, 0.75, 1),
      look("#ff9050", 0.5, 0.8, 1),
    ],
    shot: [4, 12],
    events: 0.2,
    boost: 0.15,
    bursts: ["#ffffff", "#fff080"],
  }),
};

/** The film param's value as a `Film` (an unknown value plays Drama). */
export function toFilm(value: string): Film {
  switch (value) {
    case "scifi":
    case "western":
    case "animation":
      return value;
    default:
      return "drama";
  }
}

/** The view param's value as a `View` (an unknown value faces the projector). */
export function toView(value: string): View {
  return value === "screen" ? "screen" : "projector";
}

/** Seconds a view change or a seat colour change cross-fades over. */
export const CROSSFADE_SECONDS = 1.2;

/** The smallest the room is drawn at narrow aspects, so it stays legible behind a portrait speaker. */
const MIN_FIT = 0.6;

/** Frame heights per design unit's worth of the frame (1 at 16:9 and wider). */
export function cinemaFit(aspect: number): number {
  return Math.max(MIN_FIT, fitScale(aspect));
}

// --- The show: house lights, beam and curtains ----------------------------------

/** Seconds the house lights take to dim. */
export const DIM_SECONDS = 3;
/** Seconds the beam takes to fade up, once the house is dark. */
const BEAM_SECONDS = 2.5;
/** Seconds the curtains take to part, once the house is dark. */
export const CURTAIN_SECONDS = 7;
/** The whole transition from "before the show" to the film playing. */
export const SHOW_SECONDS = DIM_SECONDS + Math.max(BEAM_SECONDS, CURTAIN_SECONDS);

/**
 * The show's transition: a clock running from 0 (before the show) to
 * `SHOW_SECONDS` (film playing), forwards while the film plays and backwards
 * before the show, so a change part-way through reverses from where it is.
 * Its levels follow from the clock: the house lights dim first, then the beam
 * fades up and the curtains part.
 */
interface Show {
  /** Seconds along the transition, 0..`SHOW_SECONDS`. */
  t: number;
  /** Whether the clock has been set from the params yet. */
  started: boolean;
  /** Output: house lights (1 up, 0 down), the beam (0 off, 1 on) and how far the curtains have parted (0 closed). */
  house: number;
  beam: number;
  curtains: number;
}

export function createShow(): Show {
  return { t: 0, started: false, house: 1, beam: 0, curtains: 0 };
}

/** Writes the levels at `s.t`. */
function showLevels(s: Show): void {
  s.house = 1 - smoothstep(0, DIM_SECONDS, s.t);
  s.beam = smoothstep(DIM_SECONDS, DIM_SECONDS + BEAM_SECONDS, s.t);
  s.curtains = smoothstep(DIM_SECONDS, DIM_SECONDS + CURTAIN_SECONDS, s.t);
}

/**
 * Moves the show on by `dt` seconds towards the film playing (`playing`) or
 * the house lights up. The first step starts it settled in that state.
 */
export function stepShow(s: Show, dt: number, playing: boolean): void {
  if (!s.started) {
    s.started = true;
    s.t = playing ? SHOW_SECONDS : 0;
  } else {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    s.t = clamp(s.t + (playing ? step : -step), 0, SHOW_SECONDS);
  }
  showLevels(s);
}

// --- The curtains, facing the screen ---------------------------------------------

/** The inner edge of the fixed drapes either side of the screen (design units). */
export const LEG_IN = 0.63;
/** How far out the travelling curtains reach: just behind the fixed drapes. */
export const CURTAIN_OUTER = LEG_IN + 0.01;
/** How far their leading edges travel as they part, and how much they overlap when closed. */
export const CURTAIN_TRAVEL = LEG_IN + 0.05;
export const CURTAIN_OVERLAP = 0.012;
/** Folds across each half, and the least a half bunches to before sliding behind the drapes. */
export const CURTAIN_FOLDS = 8;
export const CURTAIN_BUNCH = 0.4;
/** A half's width when closed. */
const CURTAIN_WIDTH = CURTAIN_OUTER + CURTAIN_OVERLAP;

/** The leading edge's |x| when the curtains have parted by `open` (0..1). */
export function curtainLead(open: number): number {
  return open * CURTAIN_TRAVEL - CURTAIN_OVERLAP;
}

/**
 * How many folds lie between a curtain's leading edge and |x| = `ax` when
 * they've parted by `open`: the folds bunch up as a half gathers, down to
 * `CURTAIN_BUNCH` of its width, then slide behind the drapes as they are. The
 * curtain shader computes the same.
 */
export function curtainFolds(ax: number, open: number): number {
  const lead = curtainLead(open);
  const bunch = Math.max((CURTAIN_OUTER - lead) / CURTAIN_WIDTH, CURTAIN_BUNCH);
  return ((ax - lead) / (CURTAIN_WIDTH * bunch)) * CURTAIN_FOLDS;
}

// --- The auditorium, facing the projector ---------------------------------------

/** The camera: its focal length (design units per unit of x/z), the horizon's y and its height (m). */
export const FOCAL = 0.95;
export const HORIZON_Y = -0.2;
export const CAMERA_H = 1.15;
/** Seat rows behind the speaker: how many, the first's depth, their spacing and rise (m). */
export const ROWS = 7;
export const ROW_Z0 = 1.25;
export const ROW_DEPTH = 1;
export const ROW_RISE = 0.5;
/** A seat back's top above its row's floor, and the seats' spacing (m). */
export const SEAT_TOP = 0.98;
export const SEAT_PITCH = 0.56;
/**
 * The seats' blocks either side of the middle: seven seats in the middle
 * block, an aisle from `AISLE_IN` to `AISLE_OUT`, then two more seats out to
 * `SEAT_EDGE` (m).
 */
export const AISLE_IN = 3.5 * SEAT_PITCH;
export const AISLE_OUT = 3;
export const SEAT_EDGE = AISLE_OUT + 2 * SEAT_PITCH;
/** The side walls' x either side, the back wall's depth, the back cross-aisle's floor and the ceiling (m). */
export const WALL_X = 4.5;
export const BACK_Z = ROW_Z0 + (ROWS - 1) * ROW_DEPTH + 1.6;
export const BACK_FLOOR = ROWS * ROW_RISE;
export const CEILING = BACK_FLOOR + 3.3;
/** The projection booth's port on the back wall: its centre x and height and half size (m). */
export const BOOTH_X = 3.5;
export const BOOTH_H = BACK_FLOOR + 2.15;
export const BOOTH_HALF = [0.42, 0.26] as const;

/** Where a room point (m) shows on screen, in design units: [x, y]. */
function project(x: number, h: number, z: number): [number, number] {
  return [(FOCAL * x) / z, HORIZON_Y + (FOCAL * (h - CAMERA_H)) / z];
}

// --- The beam ---------------------------------------------------------------------

/** The beam's apex: the projector's lens in the booth port. */
export const BEAM_APEX = project(BOOTH_X - 0.1, BOOTH_H - 0.04, BACK_Z);
/** A point the beam's axis heads for, above the frame and over the speaker's head. */
const BEAM_AIM = [-0.35, 0.66] as const;
const AIM_DX = BEAM_AIM[0] - BEAM_APEX[0];
const AIM_DY = BEAM_AIM[1] - BEAM_APEX[1];
const AIM_LENGTH = Math.hypot(AIM_DX, AIM_DY);
/** The beam's axis (unit vector) and its normal. */
export const BEAM_DIR = [AIM_DX / AIM_LENGTH, AIM_DY / AIM_LENGTH] as const;
export const BEAM_NORMAL = [-BEAM_DIR[1], BEAM_DIR[0]] as const;
/** The beam's half width at the lens, and how much it widens per unit along its axis. */
export const BEAM_R0 = 0.014;
export const BEAM_SPREAD = 0.42;
/**
 * Across the beam its brightness falls as a Gaussian, exp(-BEAM_SOFT * a^2)
 * of a, the fraction of its half width, and to 0 from BEAM_EDGE to its edge.
 */
export const BEAM_SOFT = 0.7;
export const BEAM_EDGE = 0.6;
/** How fast the beam fades along its length, per design unit. */
export const BEAM_FALLOFF = 1.6;
/** How far along the beam it fades in from the lens, design units. */
export const BEAM_START = 0.05;
/** The beam's length in design units: past the top of the frame at every aspect. */
export const BEAM_LENGTH = 1.2;

/** The beam's half width `t` along its axis. */
function beamHalfWidth(t: number): number {
  return BEAM_R0 + BEAM_SPREAD * t;
}

/**
 * The beam's brightness at (x, y) in design units, before haze and film
 * light: 1 at its core near the lens, fading along its length and to 0 at its
 * soft edges. The beam shader computes the same profile.
 */
export function beamAt(x: number, y: number): number {
  const dx = x - BEAM_APEX[0];
  const dy = y - BEAM_APEX[1];
  const t = dx * BEAM_DIR[0] + dy * BEAM_DIR[1];
  if (t <= 0) {
    return 0;
  }
  const s = Math.abs(dx * BEAM_NORMAL[0] + dy * BEAM_NORMAL[1]) / beamHalfWidth(t);
  const across = Math.exp(-BEAM_SOFT * s * s) * (1 - smoothstep(BEAM_EDGE, 1, s));
  return (across * smoothstep(0, BEAM_START, t)) / (1 + BEAM_FALLOFF * t);
}

// --- Dust motes -------------------------------------------------------------------

export const MAX_MOTES = 160;
/** Floats per mote written by `writeMote`: x, y (design units), radius (design units), brightness. */
export const MOTE_FLOATS = 4;
/** Fastest a mote drifts along the beam, as a fraction of its length per second. */
const MOTE_DRIFT = 0.012;

const unitHash = (i: number, salt: number) =>
  hash32(Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) / 4294967296;

/** How many motes `dust` (0..1) asks for. */
export function moteCount(dust: number): number {
  return Math.round(clamp(Number.isFinite(dust) ? dust : 0, 0, 1) * MAX_MOTES);
}

/**
 * Writes mote `i` at `time` seconds into `out` at `o`: it drifts slowly up
 * the beam and weaves across it, wrapping back to the lens (where the beam is
 * dark) at the far end, past the top of the frame. Its brightness is the
 * beam's there, times a slow glint as it turns. Each mote's path is hashed
 * from its index, so a count change adds or removes motes at the end.
 */
export function writeMote(i: number, time: number, out: Float32Array, o: number): void {
  const speed = MOTE_DRIFT * (0.3 + 0.7 * unitHash(i, 1));
  const along = fract(unitHash(i, 2) + time * speed);
  const phase = unitHash(i, 3) * 2 * Math.PI;
  const weave = 0.25 + 0.4 * unitHash(i, 4);
  const across =
    (unitHash(i, 5) * 2 - 1) * 0.85 + 0.12 * Math.sin(time * weave + phase) * (1 - 0.5 * along);
  const t = along * BEAM_LENGTH;
  const s = across * beamHalfWidth(t);
  const x = BEAM_APEX[0] + BEAM_DIR[0] * t + BEAM_NORMAL[0] * s;
  const y = BEAM_APEX[1] + BEAM_DIR[1] * t + BEAM_NORMAL[1] * s;
  // A few motes float close to the camera: bigger, softer and dimmer.
  const near = unitHash(i, 6) < 0.12;
  const radius = near ? 0.005 + 0.004 * unitHash(i, 7) : 0.0014 + 0.0022 * unitHash(i, 7);
  const glint = 0.6 + 0.4 * Math.sin(time * (0.4 + 0.8 * unitHash(i, 8)) + phase * 1.7);
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = radius;
  out[o + 3] = beamAt(x, y) * glint * (near ? 0.45 : 1) * (1 - smoothstep(0.85, 1, along));
}
