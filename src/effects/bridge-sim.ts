/**
 * Starship Bridge animation: what each panel block shows at a given time.
 *
 * Every block has a seeded stream of short events: it dims, swaps to its other
 * colour, flashes white or (for readouts) shows its other reading, then returns
 * to rest. Columns of buttons now and then run a chase, one after another, as if
 * someone ran a finger down them. Events come from fixed time slots hashed per
 * block, so the state at any time is a pure function of that time and can be
 * tested without stepping. The alert level recolours the panels and pulses the
 * alert lights.
 */
import type { AlertId } from "./bridge.meta";
import { type Block, COLOUR_COUNT } from "./bridge-panels";
import { hexToUnitRgb, type Rgb } from "./color";
import { clamp, smoothstep } from "./math";
import { hash32 } from "./noise";

/** Panel colours in each alert condition, in `bridge-panels.ts` colour order. */
export const PALETTES: Readonly<Record<AlertId, readonly Rgb[]>> = {
  normal: [
    "#ff9966",
    "#ffcc99",
    "#cc9966",
    "#cc99cc",
    "#9999cc",
    "#9999ff",
    "#99ccff",
    "#cc6666",
  ].map((h) => hexToUnitRgb(h)),
  yellow: [
    "#ffaa44",
    "#ffdd88",
    "#cc9944",
    "#ffcc66",
    "#ddaa55",
    "#ffbb55",
    "#ffee99",
    "#ee8833",
  ].map((h) => hexToUnitRgb(h)),
  red: ["#ff5544", "#ff9977", "#cc4433", "#ff6666", "#dd5555", "#ff7755", "#ffaa88", "#ee3333"].map(
    (h) => hexToUnitRgb(h),
  ),
};

/** The colour a block flashes to: a warm white. */
export const FLASH: Rgb = hexToUnitRgb("#fff4e8");

/** Seconds per event slot, at most; each block's slot is between this and 60% of it. */
export const SLOT = 30;
/** Seconds per chase slot for a group of buttons. */
export const CHASE_SLOT = 16;
/** Seconds between one button lighting in a chase and the next. */
export const CHASE_STEP = 0.11;
/** Seconds each button stays lit in a chase. */
export const CHASE_HOLD = 0.22;
/** Fade time (s) into and out of a dim or a colour swap. */
export const FADE = 0.15;
/** Chance of an event per slot at `activity` 1 for a block of full busyness. */
const RATE = 0.75;
/** Chance of a chase per slot at `activity` 1. */
const CHASE_RATE = 0.6;
/** Seconds the alert colours take to fade in or out. */
export const ALERT_FADE = 1;
/** Alert light pulse period (s): slow and smooth, never a hard flash. */
export const PULSE_PERIOD = 1.8;

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x632be5ab))) / 4294967296;
}

export type EventKind = "none" | "dim" | "swap" | "flash" | "tick";

/** One event: its kind, start and length (s). */
export interface BlockEvent {
  kind: EventKind;
  start: number;
  length: number;
}

/** This block's slot length (s), from its index and the seed. */
export function slotLength(index: number, seed: number): number {
  return SLOT * (0.6 + 0.4 * rand(index, seed, 1));
}

/**
 * The event in slot `slot` of block `index`, written into `out`. Events start in
 * the first 55% of their slot and last at most 40% of it, so they never overlap
 * the next slot's.
 */
export function blockEvent(
  block: Block,
  index: number,
  seed: number,
  activity: number,
  slot: number,
  out: BlockEvent,
): BlockEvent {
  const len = slotLength(index, seed);
  const chance = clamp(activity, 0, 1) * block.busy * RATE;
  out.kind = "none";
  out.start = slot * len;
  out.length = 0;
  if (block.kind === "widget" || rand(index, seed, slot * 4 + 2) >= chance) {
    return out;
  }
  const r = rand(index, seed, slot * 4 + 3);
  const u = rand(index, seed, slot * 4 + 4);
  out.start = slot * len + rand(index, seed, slot * 4 + 5) * len * 0.55;
  if (block.kind === "readout") {
    out.kind = r < 0.85 ? "tick" : "dim";
    out.length = (0.15 + 0.25 * u) * len;
  } else if (block.kind === "frame" || block.kind === "text") {
    out.kind = r < 0.6 ? "dim" : "swap";
    out.length = (0.1 + 0.3 * u) * len;
  } else if (r < 0.4) {
    out.kind = "dim";
    out.length = (0.05 + 0.15 * u) * len;
  } else if (r < 0.75) {
    out.kind = "swap";
    out.length = (0.1 + 0.3 * u) * len;
  } else {
    out.kind = "flash";
    out.length = 0.25 + 0.25 * u;
  }
  return out;
}

/** 0..1: how far into an event its effect is at time `t`, with fades at both ends. */
export function eventWeight(e: BlockEvent, t: number): number {
  if (e.kind === "none") {
    return 0;
  }
  const end = e.start + e.length;
  if (e.kind === "flash") {
    // Quick up, slower down.
    return smoothstep(e.start, e.start + 0.08, t) * (1 - smoothstep(end - 0.2, end + 0.1, t));
  }
  return smoothstep(e.start, e.start + FADE, t) * (1 - smoothstep(end - FADE, end, t));
}

/** Start time (s) of group `group`'s chase in slot `slot`, or NaN if it has none. */
export function chaseStart(group: number, seed: number, activity: number, slot: number): number {
  const chance = clamp(activity, 0, 1) * CHASE_RATE;
  if (rand(group + 7919, seed, slot * 2) >= chance) {
    return Number.NaN;
  }
  return slot * CHASE_SLOT + rand(group + 7919, seed, slot * 2 + 1) * CHASE_SLOT * 0.6;
}

/** 0..1: how lit button `order` of a chase is at time `t`, when the chase starts at `start`. */
export function chaseWeight(start: number, order: number, t: number): number {
  if (Number.isNaN(start)) {
    return 0;
  }
  const on = start + order * CHASE_STEP;
  const off = on + CHASE_HOLD;
  return smoothstep(on, on + 0.05, t) * (1 - smoothstep(off, off + 0.12, t));
}

/** Alert colour mix: weights of the normal, yellow and red palettes, summing to 1. */
export interface AlertMix {
  normal: number;
  yellow: number;
  red: number;
}

export function createAlertMix(): AlertMix {
  return { normal: 1, yellow: 0, red: 0 };
}

/** Moves the mix towards `target` over `ALERT_FADE` seconds, keeping it summing to 1. */
export function stepAlert(mix: AlertMix, target: AlertId, dt: number): void {
  const step = dt / ALERT_FADE;
  for (const k of ["normal", "yellow", "red"] as const) {
    const goal = k === target ? 1 : 0;
    mix[k] = goal > mix[k] ? Math.min(goal, mix[k] + step) : Math.max(goal, mix[k] - step);
  }
  const sum = mix.normal + mix.yellow + mix.red;
  if (sum > 0) {
    mix.normal /= sum;
    mix.yellow /= sum;
    mix.red /= sum;
  }
}

/** 0..1, a smooth pulse with period `PULSE_PERIOD`. */
export function alertPulse(t: number): number {
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / PULSE_PERIOD);
}

/**
 * Writes palette colour `colour` under `mix` into `out` at `o`. Allocates nothing.
 */
export function mixedColour(colour: number, mix: AlertMix, out: Float32Array, o: number): void {
  const c = ((colour % COLOUR_COUNT) + COLOUR_COUNT) % COLOUR_COUNT;
  const n = PALETTES.normal[c];
  const y = PALETTES.yellow[c];
  const r = PALETTES.red[c];
  for (let i = 0; i < 3; i++) {
    out[o + i] = n[i] * mix.normal + y[i] * mix.yellow + r[i] * mix.red;
  }
}

/** Per-block scratch, so `blockStates` allocates nothing. */
export interface StateScratch {
  event: BlockEvent;
  colours: Float32Array;
  /** Chase start per group for the current slot, and the slot it was found for. */
  chase: Float64Array;
  chaseSlot: Float64Array;
}

export function createStateScratch(groups: number): StateScratch {
  return {
    event: { kind: "none", start: 0, length: 0 },
    colours: new Float32Array(6),
    chase: new Float64Array(Math.max(1, groups)),
    chaseSlot: new Float64Array(Math.max(1, groups)).fill(Number.NaN),
  };
}

/**
 * Every block's look at time `t`, as RGBA8 texels in `out` (4 bytes per block,
 * block 0 first): RGB is its lit colour, A how far it shows its other reading.
 */
export function blockStates(
  blocks: readonly Block[],
  seed: number,
  activity: number,
  mix: AlertMix,
  t: number,
  scratch: StateScratch,
  out: Uint8Array,
): void {
  const ev = scratch.event;
  const col = scratch.colours;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const o = i * 4;
    if (i === 0) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    const slot = Math.floor(t / slotLength(i, seed));
    blockEvent(b, i, seed, activity, slot, ev);
    const w = eventWeight(ev, t);
    let level = b.level;
    let swap = 0;
    let flash = 0;
    let variant = 0;
    if (ev.kind === "dim") {
      level *= 1 - 0.6 * w;
    } else if (ev.kind === "swap") {
      swap = w;
    } else if (ev.kind === "flash") {
      flash = w;
    } else if (ev.kind === "tick") {
      variant = w;
      // A short brightening as the reading changes.
      flash = 0.35 * Math.max(0, 1 - Math.abs(t - ev.start - FADE / 2) / 0.12);
    }
    if (b.group >= 0) {
      const g = b.group;
      const cs = Math.floor(t / CHASE_SLOT);
      if (scratch.chaseSlot[g] !== cs) {
        scratch.chaseSlot[g] = cs;
        scratch.chase[g] = chaseStart(g, seed, activity, cs);
      }
      flash = Math.max(flash, 0.85 * chaseWeight(scratch.chase[g], b.order, t));
    }
    mixedColour(b.colour, mix, col, 0);
    mixedColour(b.alt, mix, col, 3);
    for (let k = 0; k < 3; k++) {
      const base = col[k] + (col[k + 3] - col[k]) * swap;
      const lit = (base + (FLASH[k] - base) * flash) * Math.max(level, flash);
      out[o + k] = Math.round(clamp(lit, 0, 1) * 255);
    }
    out[o + 3] = Math.round(clamp(variant, 0, 1) * 255);
  }
}

/**
 * How many blocks start an event in [t0, t1): for checking that only a few
 * things change at once.
 */
export function eventsStarting(
  blocks: readonly Block[],
  seed: number,
  activity: number,
  t0: number,
  t1: number,
): number {
  const ev: BlockEvent = { kind: "none", start: 0, length: 0 };
  let n = 0;
  for (let i = 1; i < blocks.length; i++) {
    const len = slotLength(i, seed);
    for (let s = Math.floor(t0 / len) - 1; s <= Math.floor(t1 / len); s++) {
      blockEvent(blocks[i], i, seed, activity, s, ev);
      if (ev.kind !== "none" && ev.start >= t0 && ev.start < t1) {
        n++;
      }
    }
  }
  return n;
}
