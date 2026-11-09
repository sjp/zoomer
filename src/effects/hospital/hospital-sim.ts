/**
 * Pure logic for the Hospital Room (hospital.ts): the room's layout, the
 * patient's heartbeat and breathing, the monitor's sweeping traces and its
 * numbers, and the IV drip. Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are "frame units": the origin at the frame's centre, y up, and
 * one unit the frame's height, so y runs -0.5..0.5 and x -aspect/2..aspect/2.
 * The layout is drawn for 16:9 with the monitor on the left; the effect mirrors
 * it for a monitor on the right. Narrower frames squeeze it sideways.
 */
import { clamp, fract } from "../math";
import { hash32 } from "../noise";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The aspect the layout is drawn for. */
export const DESIGN_ASPECT = 16 / 9;

/** A box: centre x, y and half width, half height. */
export type Box = [number, number, number, number];
/** A disc: centre x, y and radius. */
export type Disc = [number, number, number];

export interface RoomLayout {
  aspect: number;
  /** The monitor's screen; its bezel is `BEZEL` bigger all round. */
  screen: Box;
  /** The wall clock's face. */
  clock: Disc;
  /** The care board's writing surface, inside its frame. */
  board: Box;
  /** The obs chart's paper on its clipboard. */
  chart: Box;
  /** The IV bag, the drip chamber under it and the infusion pump on the pole. */
  bag: Box;
  drip: Box;
  pump: Box;
  /** The IV pole's x. */
  pole: number;
  /** The oxygen flowmeter's humidifier bottle. */
  oxygen: Box;
  /** The glove dispensers under the monitor. */
  gloves: Box;
  /** The bed's side rail on the monitor's side; the other mirrors it. */
  rails: Box;
  /** The pillow behind the speaker, and the headboard behind that. */
  pillow: Box;
  headboard: Box;
  /** The headwall's service trunking, across behind the bed. */
  headwall: Box;
  /** The wall's bumper rail. */
  rail: number;
  /** Where the privacy curtain starts, bunched up against the frame's far edge. */
  curtain: number;
}

/** How far the monitor's bezel reaches past its screen. */
export const BEZEL = 0.016;
/** The care board's aluminium frame. */
export const BOARD_FRAME = 0.009;

/**
 * The room for a frame of `aspect`, with the monitor on the left. The speaker's
 * head and shoulders sit on the pillow in the middle; the monitor, the oxygen
 * and the gloves are on one side, the drip, the board, the clock, the chart and
 * the curtain on the other.
 */
export function roomLayout(aspect: number): RoomLayout {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  const k = Math.min(1, a / DESIGN_ASPECT);
  const x = (v: number) => v * k;
  const box = (cx: number, cy: number, hw: number, hh: number): Box => [x(cx), cy, hw * k, hh];
  // Round things and screens keep their shape, shrinking with the squeeze.
  const disc = (cx: number, cy: number, r: number): Disc => [x(cx), cy, r * k];
  const flat = (cx: number, cy: number, hw: number, hh: number): Box => [x(cx), cy, hw * k, hh * k];
  const clock = disc(0.635, 0.405, 0.058);
  return {
    aspect: a,
    screen: flat(-0.6, 0.12, 0.205, 0.135),
    clock,
    board: flat(0.635, 0.19, 0.145, 0.1),
    chart: box(0.635, -0.15, 0.072, 0.095),
    bag: box(0.425, 0.315, 0.042, 0.072),
    drip: box(0.425, 0.195, 0.011, 0.03),
    pump: box(0.425, 0.005, 0.052, 0.068),
    pole: x(0.425),
    oxygen: box(-0.3, 0.13, 0.024, 0.045),
    gloves: box(-0.6, -0.215, 0.135, 0.042),
    rails: box(-0.57, -0.44, 0.23, 0.1),
    pillow: box(0, -0.18, 0.31, 0.33),
    headboard: box(0, -0.15, 0.36, 0.2),
    headwall: box(-0.04, 0.3, 0.38, 0.035),
    rail: -0.09,
    curtain: a / 2 - 0.1 * k,
  };
}

// ---------------------------------------------------------------------------
// Heartbeat and breathing
// ---------------------------------------------------------------------------

/** A roughly normal number with unit spread, from three hashed uniforms. */
function gauss(seed: number, index: number, salt: number): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    sum += hash32(hash32(seed * 977 + salt) ^ Math.imul(index + 1, 0x9e3779b1) ^ i) / 4294967296;
  }
  return (sum - 1.5) * 2;
}

/** A uniform 0..1 from a hash. */
function uniform(seed: number, index: number, salt: number): number {
  return hash32(hash32(seed * 7919 + salt) ^ Math.imul(index + 7, 0x85ebca6b)) / 4294967296;
}

/** The slowest and fastest rates the heart model takes. */
export const MIN_RATE = 30;
export const MAX_RATE = 200;

/** The R wave's time after its beat starts, s. */
export const R_TIME = 0.2;

/**
 * The next beat's length (s) for a heart rate of `rate` bpm: a little random
 * variation, and the gentle speeding up and slowing down with each breath
 * (`breath` is the breathing cycle's phase, 0..1).
 */
export function beatInterval(rate: number, seed: number, index: number, breath: number): number {
  const r = clamp(Number.isFinite(rate) ? rate : 72, MIN_RATE, MAX_RATE);
  const b = Number.isFinite(breath) ? breath : 0;
  const vary = 1 - 0.035 * Math.sin(TAU * b) + 0.012 * gauss(seed, index, 3);
  return (60 / r) * clamp(vary, 0.9, 1.1);
}

const bump = (t: number, at: number, width: number) => {
  const u = (t - at) / width;
  return Math.exp(-u * u);
};

/**
 * One beat of a lead II ECG, `t` seconds after the beat starts, `len` s long:
 * a small P wave, a sharp QRS (the R wave at `R_TIME` reaching 1) and a
 * rounded T wave that comes sooner in a shorter beat. 0 is the baseline.
 */
export function ecgBeat(t: number, len: number): number {
  if (!(t >= -0.05) || t > 1.5) {
    return 0;
  }
  const qt = 0.22 * Math.sqrt(clamp(len, 0.3, 2));
  return (
    0.12 * bump(t, 0.09, 0.028) -
    0.09 * bump(t, R_TIME - 0.022, 0.009) +
    bump(t, R_TIME, 0.0105) -
    0.24 * bump(t, R_TIME + 0.024, 0.011) +
    0.27 * bump(t, R_TIME + qt, 0.05 * Math.sqrt(clamp(len, 0.3, 2)))
  );
}

/** The pulse wave's arrival after the R wave, s. */
export const PULSE_DELAY = 0.24;

/**
 * One beat of the pulse oximeter's pleth wave, `t` seconds after its R wave:
 * a quick rise to a peak, then a slow fall broken by the dicrotic notch. About
 * 0..1.
 */
export function plethBeat(t: number): number {
  const u = t - PULSE_DELAY;
  if (!(u > 0) || u > 2.5) {
    return 0;
  }
  const rise = u < 0.13 ? Math.sin((u / 0.13) * (Math.PI / 2)) ** 2 : 1;
  const fall = Math.exp(-Math.max(0, u - 0.13) / 0.32);
  const notch = 0.16 * bump(u, 0.36, 0.055) - 0.05 * bump(u, 0.3, 0.03);
  return rise * fall + notch * fall * 2;
}

/**
 * The breathing trace (0 out, 1 in) at breathing phase `p` (0..1): a shorter,
 * steady breath in, then a longer breath out and a pause.
 */
export function respWave(p: number): number {
  const f = fract(Number.isFinite(p) ? p : 0);
  if (f < 0.38) {
    return 0.5 - 0.5 * Math.cos((f / 0.38) * Math.PI);
  }
  if (f < 0.85) {
    return 0.5 + 0.5 * Math.cos(((f - 0.38) / 0.47) * Math.PI);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

/** Samples across each trace, and the seconds one sweep across the screen takes (about 25 mm/s). */
export const TRACE_COLUMNS = 360;
export const SWEEP_SECONDS = 6;
export const COLUMN_SECONDS = SWEEP_SECONDS / TRACE_COLUMNS;
/** Columns blanked ahead of the sweep's cursor. */
export const ERASE_COLUMNS = 9;
/** Channels per column in `Monitor.traces`: ECG, pleth, breathing, unused. */
export const TRACE_CHANNELS = 4;
/** Beats averaged into the heart rate the monitor shows. */
export const RATE_BEATS = 4;

export interface Vitals {
  hr: number;
  spo2: number;
  rr: number;
  sys: number;
  dia: number;
  map: number;
}

export interface Monitor {
  seed: number;
  /** Seconds the model has run, in whole columns. */
  time: number;
  /** Seconds not yet run as a column. */
  carry: number;
  /** When the current beat started, its length, the one before's, and its number. */
  beatStart: number;
  beatLen: number;
  prevLen: number;
  beat: number;
  /** The last few beats' lengths, for the rate shown. */
  lengths: Float64Array;
  /** The breathing cycle's phase (0..1) and breaths per minute. */
  breath: number;
  breathRate: number;
  /** `TRACE_COLUMNS` columns of `TRACE_CHANNELS` values, left to right. */
  traces: Float32Array;
  /** The column the sweep writes next. */
  cursor: number;
  /** What the monitor shows; the heart rate updates once a beat. */
  vitals: Vitals;
}

/** A monitor already a full sweep in, with its rate settled at `rate`. */
export function createMonitor(seed: number, rate: number): Monitor {
  const s = Math.floor(Number.isFinite(seed) ? seed : 0);
  const len = beatInterval(rate, s, 0, 0);
  const m: Monitor = {
    seed: s,
    time: 0,
    carry: 0,
    beatStart: -len * uniform(s, 0, 11),
    beatLen: len,
    prevLen: len,
    beat: 0,
    lengths: new Float64Array(RATE_BEATS).fill(len),
    breath: uniform(s, 0, 12),
    breathRate: 13 + Math.floor(4 * uniform(s, 0, 13)),
    traces: new Float32Array(TRACE_COLUMNS * TRACE_CHANNELS),
    cursor: 0,
    vitals: { hr: 0, spo2: 0, rr: 0, sys: 0, dia: 0, map: 0 },
  };
  m.vitals.hr = shownRate(m);
  slowVitals(m);
  stepMonitor(m, SWEEP_SECONDS, rate);
  return m;
}

function shownRate(m: Monitor): number {
  let sum = 0;
  for (const l of m.lengths) {
    sum += l;
  }
  return Math.round((60 * m.lengths.length) / sum);
}

/** Seconds each SpO2 and breathing-rate reading holds, and between blood pressure readings. */
export const SPO2_HOLD = 9;
export const RR_HOLD = 12;
export const NIBP_HOLD = 300;

/** The readings that change only now and then: SpO2, breathing rate and blood pressure. */
function slowVitals(m: Monitor): void {
  const v = m.vitals;
  const t = Math.max(0, m.time);
  const u = uniform(m.seed, Math.floor(t / SPO2_HOLD), 21);
  v.spo2 = u < 0.2 ? 97 : u < 0.75 ? 98 : 99;
  const r = uniform(m.seed, Math.floor(t / RR_HOLD), 22);
  v.rr = m.breathRate + (r < 0.25 ? -1 : r < 0.8 ? 0 : 1);
  const n = Math.floor(t / NIBP_HOLD);
  v.sys = 114 + Math.round(10 * uniform(m.seed, n, 23));
  v.dia = 70 + Math.round(8 * uniform(m.seed, n, 24));
  v.map = Math.round((v.sys + 2 * v.dia) / 3);
}

/** The traces' values `t` seconds into the model, given the beat in progress. */
function sample(m: Monitor, out: Float32Array, at: number): void {
  const tb = m.time - m.beatStart;
  out[at] = ecgBeat(tb, m.beatLen) + ecgBeat(tb + m.prevLen, m.prevLen);
  const pleth = plethBeat(tb - R_TIME) + plethBeat(tb - R_TIME + m.prevLen);
  out[at + 1] = clamp(0.06 + 0.86 * pleth + 0.04 * Math.sin(TAU * m.breath), 0, 1);
  out[at + 2] = respWave(m.breath);
  out[at + 3] = 0;
}

/**
 * Runs the monitor for `dt` seconds with the heart at `rate` bpm (taking hold
 * from the next beat): one column at a time, writing each into the traces at
 * the cursor. After a long pause only the last sweep's worth is run. Returns
 * whether any column was written. Allocates nothing.
 */
export function stepMonitor(m: Monitor, dt: number, rate: number): boolean {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0);
  m.carry += step;
  let columns = Math.floor(m.carry / COLUMN_SECONDS);
  m.carry -= columns * COLUMN_SECONDS;
  if (columns > TRACE_COLUMNS) {
    // Skip ahead without drawing, keeping the beats in step.
    m.time += (columns - TRACE_COLUMNS) * COLUMN_SECONDS;
    while (m.time - m.beatStart >= m.beatLen) {
      m.beatStart += m.beatLen;
      m.prevLen = m.beatLen;
      m.beat++;
      m.beatLen = beatInterval(rate, m.seed, m.beat, m.breath);
    }
    m.breath = fract(m.breath + ((columns - TRACE_COLUMNS) * COLUMN_SECONDS * m.breathRate) / 60);
    m.cursor = (m.cursor + columns - TRACE_COLUMNS) % TRACE_COLUMNS;
    columns = TRACE_COLUMNS;
  }
  for (let i = 0; i < columns; i++) {
    m.time += COLUMN_SECONDS;
    m.breath = fract(m.breath + (COLUMN_SECONDS * m.breathRate) / 60);
    if (m.time - m.beatStart >= m.beatLen) {
      m.beatStart += m.beatLen;
      m.prevLen = m.beatLen;
      m.beat++;
      m.beatLen = beatInterval(rate, m.seed, m.beat, m.breath);
      m.lengths.copyWithin(0, 1);
      m.lengths[m.lengths.length - 1] = m.prevLen;
      m.vitals.hr = shownRate(m);
    }
    sample(m, m.traces, m.cursor * TRACE_CHANNELS);
    m.cursor = (m.cursor + 1) % TRACE_COLUMNS;
  }
  slowVitals(m);
  return columns > 0;
}

/** How long the heart symbol stays lit after each R wave, s. */
export const FLASH_SECONDS = 0.16;

/** The heart symbol's brightness (0..1): lit for a moment at each R wave, fading out. */
export function heartFlash(m: Monitor): number {
  const now = m.time + m.carry;
  let since = now - m.beatStart - R_TIME;
  if (since < 0) {
    since += m.prevLen;
  }
  if (!(since >= 0) || since > FLASH_SECONDS) {
    return 0;
  }
  return 1 - since / FLASH_SECONDS;
}

/** The sweep's position across the screen (0..1), between columns. */
export function sweepPosition(m: Monitor): number {
  return (m.cursor + clamp(m.carry / COLUMN_SECONDS, 0, 1)) / TRACE_COLUMNS;
}

// ---------------------------------------------------------------------------
// The IV drip
// ---------------------------------------------------------------------------

/** Seconds between drops. */
export const DRIP_PERIOD = 1.8;
/** Share of each period the drop spends swelling at the spout, before it falls. */
export const DRIP_SWELL = 0.86;

/**
 * The drop at `t` seconds: how big it has swollen (0..1) and how far it has
 * fallen (0 at the spout, 1 reaching the pool), from a steady drip.
 */
export function dripDrop(t: number, out: Float64Array): Float64Array {
  const p = fract(Math.max(0, Number.isFinite(t) ? t : 0) / DRIP_PERIOD);
  if (p < DRIP_SWELL) {
    const s = p / DRIP_SWELL;
    out[0] = Math.sqrt(s);
    out[1] = 0;
  } else {
    const f = (p - DRIP_SWELL) / (1 - DRIP_SWELL);
    out[0] = 1;
    out[1] = f * f;
  }
  return out;
}
