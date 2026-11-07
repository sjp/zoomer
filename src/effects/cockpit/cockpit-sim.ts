/**
 * Freighter Cockpit model, all pure functions of time so it can be tested
 * without stepping:
 *
 * - The jump schedule: sublight flight, then entering (the stars stretch into
 *   streaks), the tunnel, and leaving (the streaks collapse back to stars).
 *   Each jump's slot is a fixed length, so the phase at any time is found
 *   directly rather than by walking every earlier jump.
 * - Asteroids: at most one at a time, drifting out from ahead and tumbling.
 * - The console lamps: steady, blinking, and the Starship Bridge's event
 *   stream of dims, colour swaps, flashes and finger-run chases.
 */
import type { Block } from "../bridge/bridge-panels";
import {
  blockEvent,
  type BlockEvent,
  CHASE_SLOT,
  chaseStart,
  chaseWeight,
  eventWeight,
  slotLength,
} from "../bridge/bridge-sim";
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp, smoothstep } from "../math";
import { hash32 } from "../noise";
import type { Lamp } from "./cockpit-layout";

/** Uniform 0..1 from three integers. */
function rand(a: number, b: number, c: number): number {
  return hash32(a ^ hash32(Math.imul(b, 0x9e3779b1) ^ hash32(c + 0x5bd1e995))) / 4294967296;
}

/* ----- Jumps ----- */

/** Seconds the stars take to stretch into streaks, and to collapse back. */
export const ENTER_SECONDS = 1.2;
export const LEAVE_SECONDS = 1.2;
/** Shortest and longest time in the tunnel. */
export const TUNNEL_MIN = 20;
export const TUNNEL_MAX = 40;
/** Seconds the tunnel's glow takes to fade in at its start, and out at its end. */
export const TUNNEL_FADE = 1.5;
/** The longest jump, from the first stretch to stars again. */
const JUMP_MAX = ENTER_SECONDS + TUNNEL_MAX + LEAVE_SECONDS;
/** A jump starts this far into its slot, as a fraction of the gap, plus up to `JITTER`. */
const LEAD = 0.5;
const JITTER = 0.3;

export type JumpPhase = "sublight" | "entering" | "tunnel" | "leaving";

export interface JumpState {
  phase: JumpPhase;
  /** 0..1 through the current phase. */
  progress: number;
  /** The jump under way, or the last one made (-1 before the first). */
  jump: number;
  /**
   * Which stretch of sublight the ship is on, for the scenery: it moves on
   * halfway through each tunnel, when the view outside is all tunnel.
   */
  leg: number;
  /** 0..1: how far the stars are stretched into streaks. */
  stretch: number;
  /** 0..1: how strongly the tunnel shows. */
  tunnel: number;
}

export function createJumpState(): JumpState {
  return { phase: "sublight", progress: 0, jump: -1, leg: 0, stretch: 0, tunnel: 0 };
}

/** Seconds per jump slot: one gap plus room for the longest jump. */
export function jumpSlot(gap: number): number {
  return gap + JUMP_MAX;
}

/** Seconds in the tunnel on jump `k`. */
export function tunnelSeconds(k: number, seed: number): number {
  return TUNNEL_MIN + (TUNNEL_MAX - TUNNEL_MIN) * rand(k, seed, 11);
}

/** When jump `k` starts (s): `LEAD` to `LEAD + JITTER` gaps into its slot. */
export function jumpStart(k: number, gap: number, seed: number): number {
  return k * jumpSlot(gap) + gap * (LEAD + JITTER * rand(k, seed, 12));
}

/** Seconds from the start of jump `k` until it is back to stars. */
export function jumpLength(k: number, seed: number): number {
  return ENTER_SECONDS + tunnelSeconds(k, seed) + LEAVE_SECONDS;
}

/**
 * The view at `t` seconds into the schedule, written into `out`, for a `ViewId`. "sublight"
 * and "hyperspace" hold their phase. In "cycle", the sublight stretch between
 * one jump and the next is between 0.7 and 1.3 `gap`s plus up to the spread
 * in tunnel lengths, and the first jump comes at least half a gap in. The
 * stretch and tunnel levels never change faster than over `ENTER_SECONDS`
 * (stretch) or `TUNNEL_FADE` (tunnel). Allocates nothing.
 */
export function jumpAt(
  t: number,
  view: string,
  gap: number,
  seed: number,
  out: JumpState,
): JumpState {
  out.jump = -1;
  out.leg = 0;
  if (view === "hyperspace") {
    out.phase = "tunnel";
    out.progress = 0;
    out.stretch = 1;
    out.tunnel = 1;
    return out;
  }
  out.phase = "sublight";
  out.progress = 0;
  out.stretch = 0;
  out.tunnel = 0;
  if (view === "sublight" || !(t > 0)) {
    return out;
  }
  const g = Math.max(1, gap);
  const k = Math.floor(t / jumpSlot(g));
  const start = jumpStart(k, g, seed);
  if (t < start) {
    // Sublight since the end of the last jump (or the start).
    const from = k > 0 ? jumpStart(k - 1, g, seed) + jumpLength(k - 1, seed) : 0;
    out.jump = k - 1;
    out.leg = k;
    out.progress = clamp((t - from) / (start - from), 0, 1);
    return out;
  }
  const tunnel = tunnelSeconds(k, seed);
  const s = t - start;
  out.jump = k;
  out.leg = s < ENTER_SECONDS + tunnel / 2 ? k : k + 1;
  if (s < ENTER_SECONDS) {
    out.phase = "entering";
    out.progress = s / ENTER_SECONDS;
    out.stretch = smoothstep(0, 1, out.progress);
  } else if (s < ENTER_SECONDS + tunnel) {
    const u = s - ENTER_SECONDS;
    out.phase = "tunnel";
    out.progress = u / tunnel;
    out.stretch = 1;
    out.tunnel = smoothstep(0, TUNNEL_FADE, u) * (1 - smoothstep(tunnel - TUNNEL_FADE, tunnel, u));
  } else if (s < ENTER_SECONDS + tunnel + LEAVE_SECONDS) {
    out.phase = "leaving";
    out.progress = (s - ENTER_SECONDS - tunnel) / LEAVE_SECONDS;
    out.stretch = 1 - smoothstep(0, 1, out.progress);
  } else {
    // Back to stars, until the next slot's jump.
    const next = jumpStart(k + 1, g, seed);
    const from = start + ENTER_SECONDS + tunnel + LEAVE_SECONDS;
    out.leg = k + 1;
    out.progress = clamp((t - from) / (next - from), 0, 1);
  }
  return out;
}

/* ----- Asteroids ----- */

/** Seconds per asteroid slot: at most one asteroid passes in each. */
export const ASTEROID_SLOT = 30;
/** Shortest and longest pass (s). */
const ASTEROID_MIN = 16;
const ASTEROID_MAX = 26;
/** Seconds an asteroid takes to fade in and out at the ends of its pass. */
const ASTEROID_FADE = 1.5;

export interface Asteroid {
  /** Whether one is in view. */
  visible: boolean;
  /** Centre (frame heights from the frame centre, y up) and radius (frame heights). */
  x: number;
  y: number;
  radius: number;
  /** Tumble angle (radians). */
  angle: number;
  /** 0..1: its opacity, for fading in and out. */
  alpha: number;
  /** Seeds its outline and surface. */
  shape: number;
}

export function createAsteroid(): Asteroid {
  return { visible: false, x: 0, y: 0, radius: 0, angle: 0, alpha: 0, shape: 0 };
}

/**
 * The asteroid in view at `t`, if any, written into `out`. Each slot has one
 * with chance `rate`. It comes from far ahead (behind the speaker) and drifts
 * out to a side window, growing as it nears, never faster than about a tenth
 * of the frame height per second. Allocates nothing.
 */
export function asteroidAt(t: number, seed: number, rate: number, out: Asteroid): Asteroid {
  out.visible = false;
  out.alpha = 0;
  const slot = Math.floor(t / ASTEROID_SLOT);
  if (!(rate > 0) || rand(slot, seed, 21) >= rate) {
    return out;
  }
  const length = ASTEROID_MIN + (ASTEROID_MAX - ASTEROID_MIN) * rand(slot, seed, 22);
  const start = slot * ASTEROID_SLOT + (ASTEROID_SLOT - length) * rand(slot, seed, 23);
  const u = (t - start) / length;
  if (u < 0 || u >= 1) {
    return out;
  }
  // Out to the upper left or right, never down into the console.
  const side = rand(slot, seed, 24) < 0.5 ? -1 : 1;
  const heading = -0.35 + 1.25 * rand(slot, seed, 25);
  const dx = side * Math.cos(heading);
  const dy = Math.sin(heading);
  // Parallax: it moves out faster as it nears.
  const reach = 0.08 + 1.05 * u ** 1.5;
  const size = 0.7 + 0.6 * rand(slot, seed, 26);
  const spin = (0.08 + 0.15 * rand(slot, seed, 27)) * (rand(slot, seed, 28) < 0.5 ? -1 : 1);
  const s = t - start;
  out.visible = true;
  out.x = dx * reach * 1.4;
  out.y = dy * reach;
  out.radius = (0.008 + 0.075 * u ** 1.5) * size;
  out.angle = spin * s + 6.283 * rand(slot, seed, 29);
  out.alpha = smoothstep(0, ASTEROID_FADE, s) * (1 - smoothstep(length - ASTEROID_FADE, length, s));
  out.shape = hash32(slot ^ Math.imul(seed, 0x27d4eb2d)) % 1024;
  return out;
}

/* ----- Console lamps ----- */

/** Lamp colours, in `cockpit-layout.ts` colour order: red, amber, white and green. */
export const LAMP_COLOURS: readonly Rgb[] = ["#ff3b26", "#ffa020", "#fff1dc", "#5dff7a"].map((h) =>
  hexToUnitRgb(h),
);

/** Brightness of a steady lamp; events and blinks swing around it. */
const LAMP_LEVEL = 0.85;
/** Seconds a blinking lamp takes to fade on or off. */
const BLINK_FADE = 0.15;

/** Per-lamp scratch, so `lampStates` allocates nothing. */
export interface LampScratch {
  event: BlockEvent;
  block: Block;
  chase: Float64Array;
  chaseSlot: Float64Array;
}

export function createLampScratch(groups: number): LampScratch {
  return {
    event: { kind: "none", start: 0, length: 0 },
    block: { kind: "button", colour: 0, alt: 0, level: 1, busy: 1, group: -1, order: 0 },
    chase: new Float64Array(Math.max(1, groups)),
    chaseSlot: new Float64Array(Math.max(1, groups)).fill(Number.NaN),
  };
}

/** 0..1: a lamp's blink at `t`, on for `duty` of each period with soft edges. */
export function blinkWeight(lamp: Lamp, t: number): number {
  const u = (((t / lamp.period + lamp.phase) % 1) + 1) % 1;
  const on = lamp.duty;
  const edge = Math.min(0.25 * on, BLINK_FADE / lamp.period);
  return smoothstep(0, edge, u) * (1 - smoothstep(on - edge, on, u));
}

/**
 * Every lamp's colour at `t`, as RGBA8 texels in `out`: lamp i at texel i + 1
 * (texel 0 is "no lamp"). `lights` is the console activity: at 0 a few lamps
 * burn steadily; towards 1 more of them are lit, more blink, and the Starship
 * Bridge's events (dims, swaps to another colour, short flashes, chases along
 * a row) come more often. Dead lamps stay dark. Allocates nothing.
 */
export function lampStates(
  lamps: readonly Lamp[],
  seed: number,
  lights: number,
  t: number,
  scratch: LampScratch,
  out: Uint8Array,
): void {
  const activity = clamp(lights, 0, 1);
  const lit = 0.3 + 0.4 * activity;
  const blinking = 0.45 * activity;
  const ev = scratch.event;
  const b = scratch.block;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let i = 0; i < lamps.length; i++) {
    const lamp = lamps[i];
    const o = (i + 1) * 4;
    if (lamp.dead) {
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      continue;
    }
    let level = lamp.rank < lit ? LAMP_LEVEL : 0;
    if (level > 0 && lamp.blinkRank < blinking) {
      level *= blinkWeight(lamp, t);
    }
    const colour = LAMP_COLOURS[lamp.colour % LAMP_COLOURS.length];
    let alt = colour;
    let swap = 0;
    let flash = 0;
    if (activity > 0) {
      b.colour = lamp.colour;
      b.alt = (lamp.colour + 1) % 2;
      b.level = level;
      b.busy = 0.6;
      const slot = Math.floor(t / slotLength(i + 1, seed));
      blockEvent(b, i + 1, seed, activity, slot, ev);
      const w = eventWeight(ev, t);
      if (ev.kind === "dim") {
        // An unlit lamp lights instead.
        level = level > 0 ? level * (1 - 0.85 * w) : LAMP_LEVEL * w;
      } else if (ev.kind === "swap") {
        // The lamp shows red or amber for a while.
        alt = LAMP_COLOURS[b.alt];
        swap = w;
      } else if (ev.kind === "flash") {
        flash = w;
      }
      if (lamp.group >= 0) {
        const g = lamp.group;
        const cs = Math.floor(t / CHASE_SLOT);
        if (scratch.chaseSlot[g] !== cs) {
          scratch.chaseSlot[g] = cs;
          scratch.chase[g] = chaseStart(g, seed, activity * 0.4, cs);
        }
        flash = Math.max(flash, chaseWeight(scratch.chase[g], lamp.order, t));
      }
    }
    const bright = Math.max(level, flash);
    for (let k = 0; k < 3; k++) {
      const c = colour[k] + (alt[k] - colour[k]) * swap;
      out[o + k] = Math.round(clamp((c + (1 - c) * 0.35 * flash) * bright, 0, 1) * 255);
    }
    out[o + 3] = 255;
  }
}

/* ----- Scenery ----- */

/** Planet colour pairs (dark, light) and nebula colour pairs. */
const PLANET_COLOURS: readonly (readonly [Rgb, Rgb])[] = [
  ["#5a2e1c", "#d39a66"],
  ["#3a5670", "#d6e4ee"],
  ["#6b5236", "#f0dcae"],
  ["#1f4a44", "#8fc0a0"],
  ["#4a3a5e", "#c8b0d8"],
].map(([a, b]) => [hexToUnitRgb(a), hexToUnitRgb(b)] as const);
const NEBULA_COLOURS: readonly (readonly [Rgb, Rgb])[] = [
  ["#6a1f6e", "#2b4fa8"],
  ["#1d6a72", "#2a3c9a"],
  ["#8a3a1e", "#6a1a3a"],
].map(([a, b]) => [hexToUnitRgb(a), hexToUnitRgb(b)] as const);

export interface Scenery {
  /** Planet centre and radius (frame heights; radius 0 for none), band count and tilt. */
  planetX: number;
  planetY: number;
  planetR: number;
  bands: number;
  tilt: number;
  planetA: Rgb;
  planetB: Rgb;
  /** Nebula centre, strength (0 for none) and noise scale. */
  nebulaX: number;
  nebulaY: number;
  nebula: number;
  nebulaScale: number;
  nebulaA: Rgb;
  nebulaB: Rgb;
  /** Direction the starlight comes from, in the frame (unit). */
  sunX: number;
  sunY: number;
}

export function createScenery(): Scenery {
  return {
    planetX: 0,
    planetY: 0,
    planetR: 0,
    bands: 0,
    tilt: 0,
    planetA: [0, 0, 0],
    planetB: [0, 0, 0],
    nebulaX: 0,
    nebulaY: 0,
    nebula: 0,
    nebulaScale: 1,
    nebulaA: [0, 0, 0],
    nebulaB: [0, 0, 0],
    sunX: 1,
    sunY: 0,
  };
}

/**
 * What lies outside on sublight leg `leg`: now and then a distant planet in an
 * upper side window, sometimes a faint nebula, often just stars. It changes
 * only while the tunnel hides the view. Writes into `out`; allocates nothing.
 */
export function sceneryAt(leg: number, seed: number, out: Scenery): Scenery {
  const r = (k: number) => rand(leg, seed, 40 + k);
  const pick = r(0);
  const side = r(1) < 0.5 ? -1 : 1;
  const sun = (r(2) - 0.5) * 2.4 + (side < 0 ? 0 : Math.PI);
  out.sunX = Math.cos(sun);
  out.sunY = Math.sin(sun) * 0.6;
  const n = Math.hypot(out.sunX, out.sunY);
  out.sunX /= n;
  out.sunY /= n;
  out.planetR = 0;
  out.nebula = 0;
  if (pick < 0.4) {
    out.planetX = side * (0.42 + 0.25 * r(3));
    out.planetY = 0.14 + 0.24 * r(4);
    out.planetR = 0.05 + 0.11 * r(5);
    out.bands = 4 + Math.floor(10 * r(6));
    out.tilt = (r(7) - 0.5) * 0.8;
    const c = PLANET_COLOURS[Math.floor(r(8) * PLANET_COLOURS.length)];
    out.planetA = c[0];
    out.planetB = c[1];
  }
  if (pick >= 0.3 && pick < 0.8) {
    out.nebulaX = -side * (0.3 + 0.35 * r(9));
    out.nebulaY = 0.05 + 0.3 * r(10);
    out.nebula = pick < 0.4 ? 0.05 : 0.08 + 0.06 * r(11);
    out.nebulaScale = 2 + 2 * r(12);
    const c = NEBULA_COLOURS[Math.floor(r(13) * NEBULA_COLOURS.length)];
    out.nebulaA = c[0];
    out.nebulaB = c[1];
  }
  return out;
}

/* ----- Screens ----- */

/** Screen pictures: a scrolling trace, scrolling lines of figures, a sweep and a bar chart. */
export const SCREEN_KINDS = 4;

/**
 * The picture, phosphor (0 green, 1 amber), speed and phase of screen `n`,
 * as one vec4's worth of floats written into `out` at `o`.
 */
export function screenSetup(n: number, seed: number, out: Float32Array, o: number): void {
  out[o] = Math.floor(rand(n, seed, 60) * SCREEN_KINDS);
  out[o + 1] = rand(n, seed, 61) < 0.6 ? 0 : 1;
  out[o + 2] = 0.7 + 0.6 * rand(n, seed, 62);
  out[o + 3] = rand(n, seed, 63);
}
