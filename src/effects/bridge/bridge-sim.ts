/**
 * Starship Bridge animation: what each panel block shows at a given time, from
 * the shared console event stream (`console-blocks.ts`). The alert level
 * recolours the panels and pulses the alert lights.
 */
import type { AlertId } from "./bridge.meta";
import { COLOUR_COUNT } from "./bridge-panels";
import {
  type Block,
  blockEvent,
  type BlockEvent,
  CHASE_SLOT,
  chaseStart,
  chaseWeight,
  eventWeight,
  FADE,
  slotLength,
} from "../console-blocks";
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp } from "../math";

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

/** Seconds the alert colours take to fade in or out. */
export const ALERT_FADE = 1;
/** Alert light pulse period (s): slow and smooth, never a hard flash. */
export const PULSE_PERIOD = 1.8;

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
