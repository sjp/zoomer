/**
 * Coral growth's simulation, kept free of GL so it can be tested: the seeded reef
 * layout, one skeleton generator per colony type (branching, fan, mound), the
 * arrival time of every part, the height envelope that keeps the centre clear,
 * and the palettes.
 *
 * Positions are in frame heights: x from 0 to the aspect ratio, y up from the
 * bottom edge (0) to the top (1). Arrival times are growth levels in [0, 1] for
 * the shared clock in `growth.ts`: a branch segment appears at `t0` and has grown
 * to its end by `t1`; a mound disc starts at `t0` and reaches full size at `t1`.
 */
import type { Rgb } from "../color";
import { clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { lookup } from "../lookup";

export type PaletteId = "reef" | "sunset" | "deep" | "bleached";
type ColonyKind = "branching" | "fan" | "mound";

/**
 * Floats per instance: segment (x0, y0, x1, y1), shape (r0, r1, t0, t1), style
 * (colour slot 0..3, kind: 0 capsule or 1 disc, fog 0..1, phase 0..1) and pale.
 */
export const INSTANCE_FLOATS = 13;
/** Attribute sizes for the instance layout above. */
export const INSTANCE_ATTRIBUTES: readonly number[] = [4, 4, 4, 1];
/** Instance budget for the whole reef. */
export const MAX_INSTANCES = 9000;
/** Colonies along the bottom at density 1 on a 16:9 frame. */
const BASE_COLONIES = 14;
const MAX_DENSITY = 2;
/** Reef height limit at the very centre of the frame, in frame heights. */
export const CENTER_HEIGHT = 0.08;
/** The `height` param's range: the reef's limit at the edges, in frame heights. */
const MIN_HEIGHT = 0.25;
const MAX_HEIGHT = 0.6;
/** Every part has arrived by this level, so the hold shows the whole reef. */
export const LAST_ARRIVAL = 0.97;
/** Colour slots in each palette. */
export const SLOTS = 4;

export const KIND_CAPSULE = 0;
export const KIND_DISC = 1;

/**
 * The height limit at `x`: `CENTER_HEIGHT` across the middle, rising smoothly to
 * `height` towards both side edges, so the reef is densest and tallest in the
 * corners and leaves the area above the bottom centre clear.
 */
export function heightAt(x: number, aspect: number, height: number): number {
  const half = aspect / 2;
  const e = half > 0 ? Math.min(1, Math.abs(x - half) / half) : 1;
  const top = Math.max(CENTER_HEIGHT, height);
  return CENTER_HEIGHT + (top - CENTER_HEIGHT) * smoothstep(0.28, 0.8, e);
}

/** A seed per growth cycle, so each regrowth is a new reef. */
export function cycleSeed(seed: number, cycle: number): number {
  return hash32(Math.imul(Math.floor(seed), 0x9e3779b1) ^ hash32(cycle + 0x3c0a1));
}

interface Colony {
  kind: ColonyKind;
  /** Base x, frame heights. */
  x: number;
  /** Colour slot, 0..SLOTS-1. */
  slot: number;
  /** Fog towards the water: 0 near, up to 1 far. Colonies are sorted far to near. */
  fog: number;
  /** This colony's own height cap, a fraction of the envelope (far colonies are smaller). */
  size: number;
  /** Arrival of its first part, and of its last. */
  start: number;
  end: number;
}

/**
 * The colonies for one reef, far to near. Bases are drawn towards the corners;
 * colonies near the middle are always mounds, which stay low.
 */
export function layoutColonies(rng: () => number, aspect: number, density: number): Colony[] {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const d = Number.isFinite(density) ? clamp(density, 0, MAX_DENSITY) : 1;
  const n = Math.max(2, Math.round(d * BASE_COLONIES * (a / (16 / 9))));
  const half = a / 2;
  const out: Colony[] = [];
  for (let k = 0; k < n; k++) {
    // Distance in from the nearest side edge, skewed towards the edge.
    const inset = half * Math.pow(rng(), 1.7);
    const x = k % 2 === 0 ? inset : a - inset;
    const central = 1 - inset / half;
    let kind: ColonyKind;
    if (central < 0.35) {
      kind = "mound";
    } else {
      const r = rng();
      kind = r < 0.5 ? "branching" : r < 0.8 ? "fan" : "mound";
    }
    const fog = 0.65 * rng();
    const start = 0.3 * rng();
    out.push({
      kind,
      x,
      slot: Math.floor(rng() * SLOTS) % SLOTS,
      fog,
      size: (0.7 + 0.3 * rng()) * (1 - 0.3 * fog),
      start,
      end: Math.min(LAST_ARRIVAL, 0.62 + 0.35 * rng()),
    });
  }
  return out.toSorted((p, q) => q.fog - p.fog);
}

/** The reef's instances, ready to upload, and per-instance bookkeeping for tests. */
export interface Reef {
  /** `INSTANCE_FLOATS` per instance, `count` used. */
  readonly data: Float32Array;
  count: number;
  /** Instance this one grows from (-1 for trunks and discs). */
  readonly parent: Int32Array;
  /** Colony index per instance (into `colonies`). */
  readonly colony: Int32Array;
  colonies: Colony[];
}

export function createReef(max = MAX_INSTANCES): Reef {
  return {
    data: new Float32Array(max * INSTANCE_FLOATS),
    count: 0,
    parent: new Int32Array(max),
    colony: new Int32Array(max),
    colonies: [],
  };
}

const capacity = (reef: Reef) => reef.parent.length;

function push(
  reef: Reef,
  colony: number,
  parent: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  r0: number,
  r1: number,
  t0: number,
  t1: number,
  slot: number,
  kind: number,
  fog: number,
  phase: number,
  pale: number,
): number {
  const i = reef.count++;
  const o = i * INSTANCE_FLOATS;
  const d = reef.data;
  d[o] = x0;
  d[o + 1] = y0;
  d[o + 2] = x1;
  d[o + 3] = y1;
  d[o + 4] = r0;
  d[o + 5] = r1;
  d[o + 6] = t0;
  d[o + 7] = t1;
  d[o + 8] = slot;
  d[o + 9] = kind;
  d[o + 10] = fog;
  d[o + 11] = phase;
  d[o + 12] = pale;
  reef.parent[i] = parent;
  reef.colony[i] = colony;
  return i;
}

interface BranchStyle {
  /** Step length, frame heights. */
  step: number;
  /** Trunk radius range at the base. */
  r0: readonly [number, number];
  /** Radius factor per step. */
  taper: number;
  /** A branch stops once thinner than this. */
  rMin: number;
  /** Fork probability per step. */
  fork: number;
  /** Fork angle range, radians. */
  forkAngle: readonly [number, number];
  /** Child radius relative to the parent's at the fork. */
  child: number;
  maxDepth: number;
  /** Random heading change per step, radians (peak to peak). */
  wobble: number;
  /** Pull of the heading towards its target per step, 0..1. */
  pull: number;
  /** Target heading: straight up with a lean, or fanning out from the base. */
  fan: boolean;
  trunks: readonly [number, number];
  /** Instance budget per colony at full size. */
  budget: number;
  /** Paleness of the thinnest tips. */
  pale: number;
}

const STAGHORN: BranchStyle = {
  step: 0.012,
  r0: [0.009, 0.014],
  taper: 0.975,
  rMin: 0.0028,
  fork: 0.1,
  forkAngle: [0.35, 0.7],
  child: 0.82,
  maxDepth: 4,
  wobble: 0.35,
  pull: 0.06,
  fan: false,
  trunks: [2, 4],
  budget: 450,
  pale: 0.7,
};

const FAN: BranchStyle = {
  step: 0.009,
  r0: [0.0045, 0.006],
  taper: 0.988,
  rMin: 0.0016,
  fork: 0.2,
  forkAngle: [0.28, 0.5],
  child: 0.9,
  maxDepth: 6,
  wobble: 0.3,
  pull: 0.12,
  fan: true,
  trunks: [1, 2],
  budget: 650,
  pale: 0.35,
};

interface Tip {
  x: number;
  y: number;
  /** Heading from straight up, radians (positive leans right). */
  ang: number;
  r: number;
  /** Path length from the base. */
  s: number;
  parent: number;
  depth: number;
}

/**
 * Grows one branching or fan colony: every live tip advances one step per round
 * (so a budget cut trims the whole colony evenly), turning towards its target
 * heading with some wobble, tapering, and forking now and then. A branch stops
 * where it would leave the frame or pass the height cap. Arrival is linear in
 * path length, so tips extend at a steady speed and a fork's child starts exactly
 * where its parent segment ends.
 */
function growBranches(
  reef: Reef,
  rng: () => number,
  ci: number,
  c: Colony,
  style: BranchStyle,
  aspect: number,
  height: number,
): void {
  const first = reef.count;
  const limit = Math.min(capacity(reef), first + Math.round(style.budget * (0.5 + 0.5 * c.size)));
  const cap = (x: number) => heightAt(x, aspect, height) * c.size;
  const lean = (rng() - 0.5) * 0.4;
  const r0 = style.r0[0] + (style.r0[1] - style.r0[0]) * rng();
  const bx = clamp(c.x, r0 + 0.004, aspect - r0 - 0.004);
  const phase = rng();
  let tips: Tip[] = [];
  const trunks =
    style.trunks[0] + Math.floor(rng() * (style.trunks[1] - style.trunks[0] + 1 - 1e-9));
  for (let k = 0; k < trunks; k++) {
    const spread = trunks > 1 ? (k / (trunks - 1) - 0.5) * 1.1 : 0;
    tips.push({
      x: bx,
      y: 0,
      ang: lean + spread + (rng() - 0.5) * 0.2,
      r: r0 * (k === 0 ? 1 : 0.85),
      s: 0,
      parent: -1,
      depth: 0,
    });
  }
  const paleSpan = Math.max(1e-6, r0 * 0.6 - style.rMin);
  while (tips.length > 0 && reef.count < limit) {
    const next: Tip[] = [];
    for (const tip of tips) {
      if (reef.count >= limit) {
        break;
      }
      const target = style.fan
        ? clamp(Math.atan2(tip.x - bx, tip.y + 0.08) * 1.1, -0.95, 0.95)
        : lean;
      tip.ang += (target - tip.ang) * style.pull + style.wobble * (rng() - 0.5);
      const nx = tip.x + Math.sin(tip.ang) * style.step;
      const ny = tip.y + Math.cos(tip.ang) * style.step;
      const r1 = tip.r * style.taper;
      if (
        r1 < style.rMin ||
        ny < 0.004 ||
        nx - r1 < 0 ||
        nx + r1 > aspect ||
        ny + r1 > cap(nx) ||
        tip.y + tip.r > cap(tip.x)
      ) {
        continue;
      }
      const pale = style.pale * clamp(1 - (r1 - style.rMin) / paleSpan, 0, 1);
      const i = push(
        reef,
        ci,
        tip.parent,
        tip.x,
        tip.y,
        nx,
        ny,
        tip.r,
        r1,
        tip.s,
        tip.s + style.step,
        c.slot,
        KIND_CAPSULE,
        c.fog,
        phase,
        pale,
      );
      tip.x = nx;
      tip.y = ny;
      tip.r = r1;
      tip.s += style.step;
      tip.parent = i;
      next.push(tip);
      if (tip.depth < style.maxDepth && rng() < style.fork) {
        const side = rng() < 0.5 ? -1 : 1;
        const a = style.forkAngle[0] + (style.forkAngle[1] - style.forkAngle[0]) * rng();
        next.push({
          x: nx,
          y: ny,
          ang: tip.ang + side * a,
          r: r1 * style.child,
          s: tip.s,
          parent: i,
          depth: tip.depth + 1,
        });
        // The main branch bends away a little, as a real fork splits.
        tip.ang -= side * a * 0.35;
        tip.depth++;
      }
    }
    tips = next;
  }
  normaliseArrivals(reef, first, c);
  if (style.fan) {
    crossLink(reef, rng, ci, c, first, aspect);
  }
}

/** Maps path lengths (stored in t0, t1) onto the colony's start..end arrival range. */
function normaliseArrivals(reef: Reef, first: number, c: Colony): void {
  const d = reef.data;
  let sMax = 0;
  for (let i = first; i < reef.count; i++) {
    sMax = Math.max(sMax, d[i * INSTANCE_FLOATS + 7]);
  }
  if (!(sMax > 0)) {
    return;
  }
  const k = (c.end - c.start) / sMax;
  for (let i = first; i < reef.count; i++) {
    const o = i * INSTANCE_FLOATS;
    d[o + 6] = c.start + d[o + 6] * k;
    d[o + 7] = Math.min(c.end, c.start + d[o + 7] * k);
  }
}

/**
 * Cross-links between neighbouring fan branches, for the lattice: a thin link
 * between two segment ends that are close but not on the same twig, mostly
 * sideways. It grows from whichever end arrives later, starting once both exist.
 */
function crossLink(
  reef: Reef,
  rng: () => number,
  ci: number,
  c: Colony,
  first: number,
  aspect: number,
): void {
  const d = reef.data;
  const last = reef.count;
  const n = last - first;
  if (n < 2) {
    return;
  }
  // Arrival per frame height of growth: the colony's own rate, from its first step.
  const o0 = first * INSTANCE_FLOATS;
  const rate = (d[o0 + 7] - d[o0 + 6]) / FAN.step;
  const budget = Math.floor(n * 0.35);
  let links = 0;
  for (let i = first; i < last && links < budget; i++) {
    const oi = i * INSTANCE_FLOATS;
    const xi = d[oi + 2];
    const yi = d[oi + 3];
    for (let j = i + 1; j < last && links < budget; j++) {
      if (reef.parent[j] === i || reef.parent[i] === j) {
        continue;
      }
      const oj = j * INSTANCE_FLOATS;
      const dx = d[oj + 2] - xi;
      const dy = d[oj + 3] - yi;
      if (Math.abs(dy) > Math.abs(dx) * 0.8) {
        continue;
      }
      const len = Math.hypot(dx, dy);
      if (len < 0.006 || len > 0.02) {
        continue;
      }
      if (rng() > 0.25) {
        continue;
      }
      // Start at the later end, so the link never appears before either branch.
      const late = d[oi + 7] >= d[oj + 7] ? i : j;
      const early = late === i ? j : i;
      const ol = late * INSTANCE_FLOATS;
      const oe = early * INSTANCE_FLOATS;
      const r = Math.min(d[ol + 5], d[oe + 5]) * 0.7;
      const t0 = d[ol + 7];
      const t1 = Math.min(LAST_ARRIVAL, t0 + len * rate);
      if (reef.count >= capacity(reef)) {
        return;
      }
      const x0 = d[ol + 2];
      const y0 = d[ol + 3];
      const x1 = d[oe + 2];
      const y1 = d[oe + 3];
      if (Math.min(x0, x1) - r < 0 || Math.max(x0, x1) + r > aspect) {
        continue;
      }
      push(
        reef,
        ci,
        late,
        x0,
        y0,
        x1,
        y1,
        r,
        r,
        t0,
        Math.max(t0, t1),
        c.slot,
        KIND_CAPSULE,
        c.fog,
        d[ol + 11],
        FAN.pale * 0.5,
      );
      links++;
    }
  }
}

/**
 * A mound (brain or boulder coral): overlapping discs on a dome over the base,
 * each growing in radius from nothing. Lower, more central discs start first;
 * larger discs are drawn first, so smaller lumps sit on top.
 */
function growMound(
  reef: Reef,
  rng: () => number,
  ci: number,
  c: Colony,
  aspect: number,
  height: number,
): void {
  const capX = (x: number) => heightAt(x, aspect, height);
  const size = Math.min(0.11, capX(c.x) * 0.95) * (0.55 + 0.45 * c.size);
  const count = 5 + Math.floor(rng() * 6);
  const span = c.end - c.start;
  const discs: { x: number; y: number; r: number; t0: number; t1: number }[] = [];
  for (let k = 0; k < count; k++) {
    const theta = Math.PI * (0.12 + 0.76 * rng());
    const dist = size * (0.1 + 0.5 * rng());
    const x = c.x + Math.cos(theta) * dist * 1.3;
    const y = Math.max(0, Math.sin(theta) * dist * 0.6);
    let r = size * (0.35 + 0.3 * rng()) * (1 - 0.4 * (dist / size));
    r = Math.min(r, capX(x) - y, x, aspect - x);
    if (!(r >= 0.005)) {
      continue;
    }
    const delay = (dist / size) * 0.45 + 0.1 * rng();
    const t0 = c.start + span * delay;
    discs.push({ x, y, r, t0, t1: Math.min(c.end, t0 + span * 0.5) });
  }
  discs.sort((p, q) => q.r - p.r);
  for (const disc of discs) {
    if (reef.count >= capacity(reef)) {
      return;
    }
    const t1 = Math.max(disc.t0 + 1e-3, disc.t1);
    push(
      reef,
      ci,
      -1,
      disc.x,
      disc.y,
      disc.x,
      disc.y,
      disc.r,
      disc.r,
      Math.min(disc.t0, t1 - 1e-3),
      t1,
      c.slot,
      KIND_DISC,
      c.fog,
      rng(),
      0,
    );
  }
}

/**
 * Builds the whole reef for `seed` into `reef` (reusing its buffers): colonies
 * far to near, each grown by its type's generator, every part inside the frame
 * and under the height envelope.
 */
export function buildReef(
  seed: number,
  aspect: number,
  density: number,
  height: number,
  reef: Reef = createReef(),
): Reef {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const h = Number.isFinite(height) ? clamp(height, MIN_HEIGHT, MAX_HEIGHT) : 0.45;
  const rng = createRng(seed);
  reef.count = 0;
  reef.colonies = layoutColonies(rng, a, density);
  reef.colonies.forEach((c, ci) => {
    if (c.kind === "mound") {
      growMound(reef, rng, ci, c, a, h);
    } else {
      growBranches(reef, rng, ci, c, c.kind === "fan" ? FAN : STAGHORN, a, h);
    }
  });
  return reef;
}

interface CoralPalette {
  /** Water near the surface (top of frame), mid-depth and at the bottom. */
  top: Rgb;
  mid: Rgb;
  deep: Rgb;
  sand: Rgb;
  /** Caustic light. */
  light: Rgb;
  /** Colony colours, by slot. */
  coral: readonly [Rgb, Rgb, Rgb, Rgb];
  /** Colour of fresh growth and the thinnest tips. */
  tip: Rgb;
}

export const PALETTES: Readonly<Record<PaletteId, CoralPalette>> = {
  reef: {
    top: [0.3, 0.68, 0.84],
    mid: [0.08, 0.38, 0.58],
    deep: [0.03, 0.18, 0.33],
    sand: [0.62, 0.58, 0.46],
    light: [0.75, 0.95, 1],
    coral: [
      [0.86, 0.36, 0.48],
      [0.92, 0.5, 0.25],
      [0.55, 0.32, 0.72],
      [0.88, 0.7, 0.3],
    ],
    tip: [1, 0.9, 0.85],
  },
  sunset: {
    top: [0.62, 0.62, 0.62],
    mid: [0.16, 0.34, 0.45],
    deep: [0.06, 0.14, 0.24],
    sand: [0.66, 0.52, 0.4],
    light: [1, 0.85, 0.6],
    coral: [
      [0.9, 0.32, 0.3],
      [0.82, 0.3, 0.55],
      [0.95, 0.55, 0.28],
      [0.96, 0.72, 0.55],
    ],
    tip: [1, 0.88, 0.72],
  },
  deep: {
    top: [0.08, 0.26, 0.46],
    mid: [0.03, 0.12, 0.27],
    deep: [0.01, 0.05, 0.13],
    sand: [0.24, 0.26, 0.3],
    light: [0.5, 0.75, 1],
    coral: [
      [0.62, 0.16, 0.24],
      [0.38, 0.2, 0.55],
      [0.7, 0.3, 0.18],
      [0.5, 0.12, 0.38],
    ],
    tip: [0.85, 0.7, 0.8],
  },
  bleached: {
    top: [0.42, 0.72, 0.84],
    mid: [0.14, 0.44, 0.6],
    deep: [0.05, 0.22, 0.36],
    sand: [0.7, 0.68, 0.6],
    light: [0.85, 0.97, 1],
    coral: [
      [0.9, 0.88, 0.84],
      [0.82, 0.8, 0.76],
      [0.94, 0.9, 0.82],
      [0.8, 0.84, 0.86],
    ],
    tip: [1, 1, 0.98],
  },
};

/** The palette for a select value; unknown values fall back to "reef". */
export function paletteFor(id: string): CoralPalette {
  return lookup(PALETTES, id, "reef");
}

/** Caustic phase rates (radians per second at speed 1), for `advancePhases`. */
export const CAUSTIC_RATES: readonly number[] = [0.21, -0.17, 0.13, -0.11];
