/**
 * The console lights shared by the Scenes' panels: every block (a button, frame,
 * text label or readout) has a seeded stream of short events. It dims, swaps to
 * its other colour, flashes or (for readouts) shows its other reading, then
 * returns to rest. Columns of buttons now and then run a chase, one after
 * another, as if someone ran a finger down them. Events come from fixed time
 * slots hashed per block, so the state at any time is a pure function of that
 * time and can be tested without stepping.
 */
import { clamp, smoothstep } from "./math";
import { hash32 } from "./noise";

export type BlockKind = "frame" | "button" | "text" | "readout" | "widget";

export interface Block {
  kind: BlockKind;
  /** Resting colour, and the one it swaps to. */
  colour: number;
  alt: number;
  /** Resting brightness, 0..1. */
  level: number;
  /** How busy it is, relative to the `activity` param. */
  busy: number;
  /** Chase group (-1 for none) and position in it, top to bottom. */
  group: number;
  order: number;
}

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
