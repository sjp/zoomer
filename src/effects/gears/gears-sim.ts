/**
 * Clockwork Gears: the gear train grown from a seed, the tooth profile the
 * shader draws, and the escapement clock that drives it.
 *
 * Units are frame heights, with the origin at the bottom-left and y up (as in
 * `gl_FragCoord / height`), so the frame is `aspect` wide and 1 tall. Angles are
 * in radians, anticlockwise.
 */
import { approach, clamp, fract } from "../math";
import { capPatternSpeed } from "../motion-limits";
import { createRng } from "../noise";
import { type GearLayoutId, MAX_GEARS } from "./gears.meta";

const TAU = Math.PI * 2;

/** Gear body styles, as the shader's `vStyle`. */
const STYLE_SOLID = 0;
const STYLE_SPOKES = 1;
const STYLE_HOLES = 2;
export const STYLE_BALANCE = 3;

/** Metals, as indices into the effect's colour table. */
export const METAL_BRASS = 0;
export const METAL_STEEL = 1;
export const METAL_COPPER = 2;

/** Depth layers, back (0) to front. Meshing gears share a layer; compound gears span two. */
export const LAYERS = 3;

/** Tooth profile, in modules: tip above and root below the pitch circle. */
export const ADDENDUM = 1;
export const DEDENDUM = 1.25;
/** Tooth half-widths at the tip and at the root, in tooth pitches (a smoothed trapezoid). */
export const TOOTH_TIP_HALF = 0.1;
export const TOOTH_ROOT_HALF = 0.33;

/** Free space kept between gears in the same layer that don't mesh (frame heights). */
export const CLEARANCE = 0.01;
/** Largest drive ratio any gear may turn at, so small gears never spin fast. */
export const MAX_RATIO = 6;
/** Tooth counts the train picks from. */
const TEETH = [12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64] as const;

/** Escapement: seconds per tick, and the tick's kick-and-settle shape. */
export const TICK_PERIOD = 1;
const EASE_DAMP = 14;
const EASE_FREQ = 18;
const EASE_NORM = 1 - Math.exp(-EASE_DAMP) * Math.cos(EASE_FREQ);
/** How fast the tick blends in or out when toggled (per second). */
const TICK_BLEND_RATE = 2.5;
/** Balance wheel swing amplitude (radians). */
const BALANCE_AMPLITUDE = 1.5;

export interface Gear {
  /** Centre (frame heights, y up). */
  x: number;
  y: number;
  /** Tooth count; 0 for the balance wheel. */
  teeth: number;
  /** Pitch radius (the balance wheel's outer radius). */
  pitchR: number;
  /** Tooth size: pitch diameter / teeth. */
  module: number;
  /** 0 (back) to LAYERS - 1 (front). */
  layer: number;
  /** Signed angular speed as a multiple of the drive's (0 for the balance wheel). */
  ratio: number;
  /** Angle at drive angle 0 (radians). */
  phase: number;
  style: number;
  /** Spokes or holes (0 when solid). */
  spokes: number;
  /** Screws on the hub (0, 3 or 4). */
  screws: number;
  /** METAL_* for the "Mixed" metal. */
  metal: number;
  /** Per-gear shade variation in [-1, 1]. */
  tint: number;
  /** The gear this one meshes with or shares an axle with; -1 for a root. */
  parent: number;
  /** True when it shares its parent's axle (a compound gear) instead of meshing. */
  axle: boolean;
}

interface LayoutSpec {
  /** Module for every gear (frame heights). */
  module: number;
  /** Gears to grow, before the balance wheel. */
  count: number;
  /** Largest tooth count, for the drive gear. */
  maxTeeth: number;
  /** Balance wheel radius. */
  balanceR: number;
}

export const LAYOUT_SPECS: Readonly<Record<GearLayoutId, LayoutSpec>> = {
  corner: { module: 0.0068, count: 16, maxTeeth: 64, balanceR: 0.085 },
  side: { module: 0.0062, count: 20, maxTeeth: 56, balanceR: 0.08 },
  frame: { module: 0.005, count: 40, maxTeeth: 48, balanceR: 0.07 },
};

/** Corner layout: the gears stay within this radius of the top-right corner. */
function cornerRadius(aspect: number): number {
  return Math.min(0.7, 0.42 * aspect);
}

/** Side layout: the strip's width at the right edge. */
function sideWidth(aspect: number): number {
  return Math.min(0.5, 0.3 * aspect);
}

/** Frame layout: the band's width round the edges. */
const FRAME_BAND = 0.24;

/** Outer radius: the tooth tips, or the balance wheel's rim. */
export function tipRadius(g: Gear): number {
  return g.teeth > 0 ? g.pitchR + ADDENDUM * g.module : g.pitchR;
}

/**
 * Whether a disc of radius `r` at (x, y) lies in the layout's region: its centre
 * inside the frame (the disc may run off the edge), and the disc clear of the
 * middle of the frame, where the speaker is.
 */
export function regionFits(
  layout: GearLayoutId,
  aspect: number,
  x: number,
  y: number,
  r: number,
): boolean {
  if (!(x >= 0 && x <= aspect && y >= 0 && y <= 1)) {
    return false;
  }
  if (layout === "corner") {
    return Math.hypot(x - aspect, y - 1) + r <= cornerRadius(aspect);
  }
  if (layout === "side") {
    return x - r >= aspect - sideWidth(aspect);
  }
  // Frame: the disc must not reach the inner rectangle.
  const b = FRAME_BAND;
  const dx = Math.max(b - x, 0, x - (aspect - b));
  const dy = Math.max(b - y, 0, y - (1 - b));
  const inside = x > b && x < aspect - b && y > b && y < 1 - b;
  return !inside && Math.hypot(dx, dy) >= r;
}

/**
 * The gear's outer edge (radius) at a local angle (measured from a tooth's
 * centre line): a smoothed trapezoid wave between the root and tip circles.
 * The shader's `toothEdge` is the same function.
 */
export function toothEdge(pitchR: number, module: number, teeth: number, angle: number): number {
  const s = (angle * teeth) / TAU;
  const w = Math.abs(fract(s + 0.5) - 0.5);
  let t = clamp((TOOTH_ROOT_HALF - w) / (TOOTH_ROOT_HALF - TOOTH_TIP_HALF), 0, 1);
  t = t * t * (3 - 2 * t);
  return pitchR - DEDENDUM * module + (ADDENDUM + DEDENDUM) * module * t;
}

/** A gear's angle (radians, unwrapped) at drive angle `drive`. */
export function gearAngle(g: Gear, drive: number): number {
  return g.phase + g.ratio * drive;
}

/**
 * Phase for gear `b` meshing with `a` (b's centre at angle `alpha` from a's),
 * so a tooth of one sits in a gap of the other at the contact point. With
 * u = (contact angle - gear angle) * teeth / 2π, measured in tooth pitches from
 * a tooth's centre, the two gears' u values always sum to 1/2 (mod 1): their
 * rates cancel exactly because the speeds satisfy the tooth ratio.
 */
export function meshPhase(a: Gear, b: Gear, alpha: number): number {
  const ua = ((alpha - a.phase) * a.teeth) / TAU;
  return alpha + Math.PI - (TAU * (0.5 - ua)) / b.teeth;
}

function makeGear(
  x: number,
  y: number,
  teeth: number,
  module: number,
  layer: number,
  parent: number,
): Gear {
  return {
    x,
    y,
    teeth,
    pitchR: (module * teeth) / 2,
    module,
    layer,
    ratio: 1,
    phase: 0,
    style: STYLE_SOLID,
    spokes: 0,
    screws: 0,
    metal: METAL_BRASS,
    tint: 0,
    parent,
    axle: false,
  };
}

/** Whether `g` is clear of every gear in its layer, except `skip` (the one it meshes with). */
function clearOf(gears: readonly Gear[], g: Gear, skip: number): boolean {
  const r = tipRadius(g);
  for (let i = 0; i < gears.length; i++) {
    const o = gears[i];
    if (i === skip || o.layer !== g.layer) {
      continue;
    }
    if (Math.hypot(o.x - g.x, o.y - g.y) < r + tipRadius(o) + CLEARANCE) {
      return false;
    }
  }
  return true;
}

/** Body style, spokes, screws, metal and tint, from the gear's size. */
function decorate(g: Gear, rand: () => number): void {
  const pick = rand();
  if (g.teeth >= 20 && pick < 0.45) {
    g.style = STYLE_SPOKES;
    g.spokes = g.teeth >= 40 ? 5 + Math.floor(rand() * 2) : 3 + Math.floor(rand() * 2);
  } else if (g.teeth >= 20 && pick < 0.72) {
    g.style = STYLE_HOLES;
    g.spokes = g.teeth >= 40 ? 6 + 2 * Math.floor(rand() * 2) : 5;
  }
  if (g.teeth >= 32 && rand() < 0.45) {
    g.screws = rand() < 0.5 ? 3 : 4;
  }
  const m = rand();
  g.metal = m < 0.6 ? METAL_BRASS : m < 0.88 ? METAL_STEEL : METAL_COPPER;
  g.tint = rand() * 2 - 1;
}

/** A tooth count up to `max` (biased towards the middle sizes). */
function pickTeeth(rand: () => number, max: number): number {
  let n = 0;
  while (n < TEETH.length && TEETH[n] <= max) {
    n++;
  }
  if (n === 0) {
    return TEETH[0];
  }
  // The mean of two draws favours the middle of the list.
  return TEETH[Math.min(n - 1, Math.floor(((rand() + rand()) / 2) * n))];
}

/** How far from its anchor a root gear may land (frame heights). */
const ANCHOR_SPREAD = 0.18;

/**
 * Where each layout starts its trains (frame heights): the drive at the first,
 * then one more train at each of the others, so a frame fills all round.
 */
export function rootAnchors(layout: GearLayoutId, aspect: number): [number, number][] {
  const a = aspect;
  if (layout === "corner") {
    return [[a - 0.22, 0.78]];
  }
  if (layout === "side") {
    return [
      [a - 0.15, 0.72],
      [a - 0.15, 0.22],
    ];
  }
  return [
    [a - 0.1, 0.85],
    [0.1, 0.15],
    [0.1, 0.85],
    [a - 0.1, 0.15],
    [a / 2, 0.92],
    [a / 2, 0.08],
    [0.08, 0.5],
    [a - 0.08, 0.5],
  ];
}

/**
 * Places a root gear (the drive, or another train) near an anchor, or anywhere
 * in the region without one, shrinking it until it fits.
 */
function placeRoot(
  gears: Gear[],
  layout: GearLayoutId,
  aspect: number,
  spec: LayoutSpec,
  rand: () => number,
  maxTeeth: number,
  anchor: readonly [number, number] | null,
): boolean {
  for (let teeth = maxTeeth, k = 0; k < TEETH.length; k++) {
    for (let attempt = 0; attempt < 80; attempt++) {
      const x = anchor ? anchor[0] + (rand() * 2 - 1) * ANCHOR_SPREAD : rand() * aspect;
      const y = anchor ? anchor[1] + (rand() * 2 - 1) * ANCHOR_SPREAD : rand();
      const g = makeGear(x, y, teeth, spec.module, 1, -1);
      if (!regionFits(layout, aspect, g.x, g.y, tipRadius(g)) || !clearOf(gears, g, -1)) {
        continue;
      }
      g.phase = rand() * TAU;
      // A new train is driven through hidden gearing, at its own size's ratio.
      g.ratio = gears.length === 0 ? 1 : ((rand() < 0.5 ? 1 : -1) * gears[0].teeth) / teeth;
      if (Math.abs(g.ratio) > MAX_RATIO) {
        continue;
      }
      gears.push(g);
      return true;
    }
    const i = (TEETH as readonly number[]).indexOf(teeth);
    if (i <= 0) {
      break;
    }
    teeth = TEETH[i - 1];
  }
  return false;
}

/**
 * Grows the gear train for a layout, aspect and seed: a drive gear, then gears
 * attached one at a time to a random existing gear, either meshing with it (same
 * layer, centre distance the sum of the pitch radii, speed by the tooth ratio
 * with the opposite sign, phase so the teeth interleave) or as a compound gear on
 * its axle in the next layer. Nothing overlaps within a layer and every gear
 * stays in the region. A balance wheel goes on top, second, if there is room.
 * Gears are returned in creation order (parents before children).
 */
export function growTrain(layout: GearLayoutId, aspect: number, seed: number): Gear[] {
  const spec = LAYOUT_SPECS[layout];
  const rand = createRng(seed * 7919 + 101);
  const gears: Gear[] = [];
  const hasPartner: boolean[] = [];
  const anchors = rootAnchors(layout, aspect);
  if (!placeRoot(gears, layout, aspect, spec, rand, spec.maxTeeth, anchors[0])) {
    if (!placeRoot(gears, layout, aspect, spec, rand, spec.maxTeeth, null)) {
      return gears;
    }
  }
  hasPartner.push(false);
  decorate(gears[0], rand);

  // The balance wheel, in the front layer, wherever it fits; placed early so the
  // train grows round it.
  for (let attempt = 0; attempt < 400; attempt++) {
    const g = makeGear(rand() * aspect, rand(), 0, spec.module, LAYERS - 1, -1);
    g.pitchR = spec.balanceR;
    g.ratio = 0;
    if (!regionFits(layout, aspect, g.x, g.y, g.pitchR) || !clearOf(gears, g, -1)) {
      continue;
    }
    g.style = STYLE_BALANCE;
    g.spokes = 3;
    g.phase = rand() * TAU;
    g.metal = METAL_BRASS;
    gears.push(g);
    hasPartner.push(true);
    break;
  }
  const target = Math.min(MAX_GEARS, spec.count + gears.length - 1);
  for (let i = 1; i < anchors.length; i++) {
    if (placeRoot(gears, layout, aspect, spec, rand, pickTeeth(rand, spec.maxTeeth), anchors[i])) {
      hasPartner.push(false);
      decorate(gears[gears.length - 1], rand);
    }
  }

  let stalled = 0;
  for (let attempt = 0; attempt < 4000 && gears.length < target; attempt++) {
    if (stalled > 300) {
      stalled = 0;
      if (placeRoot(gears, layout, aspect, spec, rand, pickTeeth(rand, spec.maxTeeth), null)) {
        hasPartner.push(false);
        decorate(gears[gears.length - 1], rand);
      }
      continue;
    }
    stalled++;
    const pi = Math.floor(rand() * gears.length);
    const parent = gears[pi];
    if (parent.teeth === 0) {
      continue;
    }
    let g: Gear;
    if (rand() < 0.22 && !hasPartner[pi] && !parent.axle) {
      // A compound gear: a different size on the same axle, one layer up or down.
      const up = parent.layer === 0 || (parent.layer < LAYERS - 1 && rand() < 0.5);
      const teeth = pickTeeth(rand, spec.maxTeeth);
      if (Math.abs(teeth - parent.teeth) < 8) {
        continue;
      }
      g = makeGear(parent.x, parent.y, teeth, spec.module, parent.layer + (up ? 1 : -1), pi);
      g.axle = true;
      g.ratio = parent.ratio;
      g.phase = rand() * TAU;
      if (!regionFits(layout, aspect, g.x, g.y, tipRadius(g)) || !clearOf(gears, g, -1)) {
        continue;
      }
      hasPartner[pi] = true;
      gears.push(g);
      hasPartner.push(true);
    } else {
      const teeth = pickTeeth(rand, spec.maxTeeth);
      const alpha = rand() * TAU;
      const d = parent.pitchR + (spec.module * teeth) / 2;
      g = makeGear(
        parent.x + Math.cos(alpha) * d,
        parent.y + Math.sin(alpha) * d,
        teeth,
        spec.module,
        parent.layer,
        pi,
      );
      g.ratio = (-parent.ratio * parent.teeth) / teeth;
      if (Math.abs(g.ratio) > MAX_RATIO) {
        continue;
      }
      if (!regionFits(layout, aspect, g.x, g.y, tipRadius(g)) || !clearOf(gears, g, pi)) {
        continue;
      }
      g.phase = meshPhase(parent, g, alpha);
      gears.push(g);
      hasPartner.push(false);
    }
    decorate(g, rand);
    stalled = 0;
  }

  return gears;
}

/** Teeth passing a fixed point per turn of the drive, for the fastest-toothed gear in `gears`. */
export function teethPerDriveTurn(gears: readonly Gear[]): number {
  let max = 0;
  for (const g of gears) {
    max = Math.max(max, g.teeth * Math.abs(g.ratio));
  }
  return max;
}

/**
 * Drive speed in radians per second for `rpm`, capped so no gear's teeth pass a
 * point faster than MAX_PATTERN_HZ (`teethPerTurn` from `teethPerDriveTurn`).
 * Compound gears multiply the drive's speed, so a train with fast small gears
 * caps lower; at the default 1 rpm the cap rarely applies.
 */
export function driveOmega(rpm: number, teethPerTurn: number): number {
  const revs = Number.isFinite(rpm) ? Math.max(0, rpm / 60) : 0;
  return TAU * (teethPerTurn > 0 ? capPatternSpeed(revs, 1 / teethPerTurn) : revs);
}

/** The escapement's ease within one tick: a quick kick, a small overshoot and a settle; 0 to 1. */
export function tickEase(u: number): number {
  return (1 - Math.exp(-EASE_DAMP * u) * Math.cos(EASE_FREQ * u)) / EASE_NORM;
}

/**
 * The drive. `smooth` turns steadily at the set speed; the escapement steps
 * from `base` by `step` once per tick, easing over the tick, with each step
 * sized so the stepped angle lands where the smooth one will be at the end of
 * the tick (so a speed change never makes it jump). `blend` mixes between the two
 * when the tick is switched on or off. Float64 and unwrapped: gear angles are
 * wrapped only when uploaded.
 */
interface Drive {
  smooth: number;
  base: number;
  step: number;
  /** Position within the current tick, [0, 1). */
  u: number;
  /** Flips every tick: the balance wheel swings one way, then back. */
  flip: boolean;
  /** 0 = smooth, 1 = ticking. */
  blend: number;
}

export function createDrive(tick: boolean): Drive {
  return { smooth: 0, base: 0, step: 0, u: 0, flip: false, blend: tick ? 1 : 0 };
}

/** Advances the drive by `dt` seconds at `omega` radians per second. */
export function advanceDrive(d: Drive, dt: number, omega: number, tick: boolean): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  d.smooth += omega * step;
  d.u += step / TICK_PERIOD;
  if (d.u >= 1) {
    const ticks = Math.floor(d.u);
    d.u -= ticks;
    if (ticks % 2 === 1) {
      d.flip = !d.flip;
    }
    d.base += d.step;
    // Aim the next step at where the smooth drive will be when this tick ends.
    d.step = Math.max(0, d.smooth + omega * (1 - d.u) * TICK_PERIOD - d.base);
  }
  d.blend = approach(d.blend, tick ? 1 : 0, step * TICK_BLEND_RATE);
}

/** The drive angle now (radians, unwrapped). */
export function driveAngle(d: Drive): number {
  const ticked = d.base + d.step * tickEase(d.u);
  return d.smooth + (ticked - d.smooth) * d.blend;
}

/** The balance wheel's angle: a swing each way per tick, fastest as the tick lands. */
export function balanceAngle(d: Drive): number {
  return BALANCE_AMPLITUDE * Math.sin(Math.PI * d.u) * (d.flip ? -1 : 1);
}
