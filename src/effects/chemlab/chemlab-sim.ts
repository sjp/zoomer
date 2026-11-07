/**
 * Pure logic for the Chemistry Lab (chemlab.ts): the seeded arrangement of
 * glassware and reagent bottles on the benches and shelves, the liquids'
 * palettes and fill levels, the occasional colour-change "reactions", the
 * distillation's drips and its receiver filling and emptying, and where the
 * vapour comes from. Nothing here touches GL, so it is all unit tested.
 *
 * Layout units are "design units": the origin at the frame's centre, y up, and
 * one unit the frame's height at 16:9. The effect scales the whole room down to
 * fit narrower frames (see `fitScale`).
 *
 * The speaker stands at the bench in the middle, in front of the blackboard, so
 * the glassware keeps to the left and right thirds and the high shelves; only
 * low items stand on the bench's middle, where the speaker's body hides them.
 *
 * Nothing flashes: a reaction's colour change takes 3 to 5 seconds, its glow
 * rises over at least a second and a half, and reactions come minutes apart.
 */
import type { Rgb } from "../color";
import { approach, clamp, smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { lookup } from "../lookup";
import type { LabPalette } from "./chemlab.meta";

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/** The aspect the room is drawn for, and the frame's half width at it. */
export const DESIGN_ASPECT = 16 / 9;
export const HALF_W = DESIGN_ASPECT / 2;
/** The middle third's half width: the speaker's place. */
export const MIDDLE = HALF_W / 3;

/**
 * Design units per frame unit's worth of the frame's height: 1 at 16:9 and
 * wider, less for narrower frames, which show the whole room smaller.
 */
export function fitScale(aspect: number): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DESIGN_ASPECT;
  return Math.min(1, a / DESIGN_ASPECT);
}

/** A box: centre x, y and half width, half height. */
export type Box = readonly [number, number, number, number];

/** Where things stand on the bench, where its top meets the wall, and its front edge. */
export const BENCH_Y = -0.235;
export const BENCH_BACK = -0.205;
export const BENCH_FRONT = -0.27;
/** Anything standing in the middle third keeps its top below this, hidden by the speaker. */
export const LOW_TOP = BENCH_Y + 0.075;
/** The blackboard behind the speaker (inside its frame), and the frame's width. */
export const BOARD: Box = [0, 0.155, 0.255, 0.2];
export const BOARD_FRAME = 0.014;
/** The periodic table poster, beside the blackboard. */
export const POSTER: Box = [-0.47, 0.15, 0.105, 0.088];

/** A shelf: its left and right ends, its plank's top, and how tall things on it may be. */
export interface Shelf {
  readonly x0: number;
  readonly x1: number;
  readonly y: number;
  readonly maxH: number;
}
export const SHELF_THICK = 0.014;
export const SHELVES: readonly Shelf[] = [
  { x0: -0.86, x1: -0.34, y: 0.33, maxH: 0.13 },
  { x0: -0.86, x1: -0.62, y: 0.11, maxH: 0.15 },
  { x0: 0.34, x1: 0.86, y: 0.33, maxH: 0.13 },
  { x0: 0.34, x1: 0.86, y: 0.11, maxH: 0.15 },
];

// ---------------------------------------------------------------------------
// The distillation, on the right of the bench
// ---------------------------------------------------------------------------

/** The tripod's height over a burner: a heated flask stands on its gauze. */
export const TRIPOD_H = 0.085;
/** The burner's barrel: half width and height (its flame sits on top). */
export const BURNER_W = 0.009;
export const BURNER_H = 0.05;
/** The flame's height and half width at rest. */
export const FLAME_H = 0.03;
export const FLAME_W = 0.008;
/** The boiling flask's centre x, its bulb's radius and its height to the neck's top. */
export const STILL_X = 0.47;
export const STILL_R = 0.042;
export const STILL_H = 0.112;
/** The still head's top: the vapour rises to here before turning into the condenser. */
export const STILL_TOP: readonly [number, number] = [STILL_X, 0.03];
/** The condenser's jacket, from its upper to its lower end, and its half width. */
export const CONDENSER_A: readonly [number, number] = [0.53, 0.012];
export const CONDENSER_B: readonly [number, number] = [0.735, -0.068];
export const CONDENSER_R = 0.013;
/** Where the drips fall from, and the receiver flask under it. */
export const OUTLET: readonly [number, number] = [0.765, -0.09];
export const RECEIVER_X = OUTLET[0];
export const RECEIVER_W = 0.032;
export const RECEIVER_H = 0.1;

// ---------------------------------------------------------------------------
// Glassware
// ---------------------------------------------------------------------------

/** The vessels' shapes, as the shader numbers them. */
export const BEAKER = 0;
export const CONICAL = 1;
export const FLASK = 2;
export const TUBE = 3;
export const CYLINDER = 4;
/** Things that aren't vessels, drawn in the same pass. */
export const FLAME = 5;
export const DROP = 6;

/** Things that never change, drawn into the cached room. */
export const BOTTLE = 0;
export const JAR = 1;
export const RACK = 2;
export const BURNER = 3;
export const TRIPOD = 4;

export const MAX_VESSELS = 40;
export const MAX_PROPS = 40;

/** One piece of glassware with a liquid in it. */
export interface Vessel {
  kind: number;
  /** Centre x and base y, half width (the widest part) and height. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The liquid's level above the base. */
  fill: number;
  /** Which of the palette's colours the liquid starts with. */
  entry: number;
  heated: boolean;
  /** A beaker of "dry ice" whose heavy vapour spills over the rim onto the bench. */
  spill: boolean;
  /** Phase for its glow's slow pulse and its bubbles, 0..1. */
  phase: number;
}

/** A static thing: centre x, base y, half width, height and a tone for its label or wood. */
export interface Prop {
  kind: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tone: number;
}

export interface LabLayout {
  vessels: Vessel[];
  props: Prop[];
  /** The vapour's sources: two vessel indices for the left field, then two for the right (-1: none). */
  emitters: Int16Array;
  /** The distillation's boiling flask and receiver, and the cylinder of slow glowing blobs. */
  still: number;
  receiver: number;
  lava: number;
}

/** The highest the liquid may stand in a vessel, above its base: below the neck or the rim. */
export function maxFill(kind: number, w: number, h: number): number {
  switch (kind) {
    case BEAKER:
      return 0.82 * h;
    case CONICAL:
      return 0.5 * h;
    case FLASK:
      return Math.min(1.5 * w, 0.6 * h);
    case TUBE:
      return 0.8 * h;
    default:
      return 0.85 * h;
  }
}

/** The lowest the liquid's surface can sit: the vessel's inside bottom (a cylinder has a thick foot). */
export function minFill(kind: number, h: number): number {
  return kind === CYLINDER ? 0.05 * h : 0.006;
}

/** The neck's top centre (design units) and half width, where vapour comes out. */
export function neckOf(v: Vessel, out: Float64Array): Float64Array {
  out[0] = v.x;
  out[1] = v.y + v.h;
  out[2] =
    v.kind === CONICAL
      ? 0.32 * v.w
      : v.kind === FLASK
        ? 0.3 * v.w
        : v.kind === BEAKER
          ? 0.85 * v.w
          : v.w;
  return out;
}

/** The kinds of thing a stretch of shelf or bench gets, each a group that may hold several items. */
type ItemKind = "beaker" | "conical" | "flask" | "cylinder" | "rack" | "bottle" | "jar" | "heated";

interface Segment {
  x0: number;
  x1: number;
  y: number;
  maxH: number;
  menu: readonly ItemKind[];
  /** Items placed first, at a random position in the row. */
  forced: readonly ItemKind[];
  /** Mark the first beaker as the dry-ice spill. */
  spill: boolean;
  /** Chance of skipping an item, leaving a gap. */
  sparse: number;
}

const SHELF_MENU: readonly ItemKind[] = [
  "bottle",
  "bottle",
  "jar",
  "conical",
  "flask",
  "beaker",
  "bottle",
];
const BENCH_MENU: readonly ItemKind[] = ["beaker", "conical", "flask", "rack", "beaker", "conical"];
const LOW_MENU: readonly ItemKind[] = ["beaker", "beaker", "conical"];

/** Gap between neighbours on a shelf or bench. */
const GAP_MIN = 0.008;
const GAP_MAX = 0.03;
/** Test tubes in a rack: half width, height, spacing, and the rack's height. */
export const TUBE_W = 0.0075;
export const TUBE_H = 0.1;
const TUBE_PITCH = 0.024;
export const RACK_H = 0.048;

/**
 * The glassware for `seed`, deterministic: reagent bottles and flasks on the
 * shelves, burners, beakers, flasks and racks of test tubes on the bench, the
 * distillation on the right, and a cylinder of glowing goo on the left.
 */
export function labLayout(seed: number): LabLayout {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  const rng = createRng(hash32(s * 0x9e3779b1 + 0x1ab));
  const vessels: Vessel[] = [];
  const props: Prop[] = [];
  let lastEntry = -1;
  const entry = () => {
    let e = Math.floor(rng() * PALETTE_SIZE);
    if (e === lastEntry) {
      e = (e + 1 + Math.floor(rng() * (PALETTE_SIZE - 1))) % PALETTE_SIZE;
    }
    lastEntry = e;
    return e;
  };
  const range = (a: number, b: number) => a + (b - a) * rng();
  const vessel = (kind: number, x: number, y: number, w: number, h: number, heated = false) => {
    const lo = minFill(kind, h);
    const hi = maxFill(kind, w, h);
    const v: Vessel = {
      kind,
      x,
      y,
      w,
      h,
      fill: lo + (hi - lo) * range(0.45, 1),
      entry: entry(),
      heated,
      spill: false,
      phase: rng(),
    };
    vessels.push(v);
  };

  /** Each item's half width for a stretch's height limit, and a function placing it there. */
  const plan = (kind: ItemKind, maxH: number): [number, (x: number, y: number) => void] | null => {
    if (kind === "beaker") {
      const w = range(0.022, 0.038);
      const h = Math.min(maxH, w * range(1.3, 1.7));
      return [
        w,
        (x, y) => {
          vessel(BEAKER, x, y, w, h);
        },
      ];
    }
    if (kind === "conical") {
      const w = range(0.024, 0.038);
      const h = Math.min(maxH, w * range(2.6, 3.1));
      return h < 2.2 * w
        ? null
        : [
            w,
            (x, y) => {
              vessel(CONICAL, x, y, w, h);
            },
          ];
    }
    if (kind === "flask") {
      const w = range(0.024, 0.04);
      const h = Math.min(maxH, w * range(3.0, 3.5));
      return h < 2.8 * w
        ? null
        : [
            w,
            (x, y) => {
              vessel(FLASK, x, y, w, h);
            },
          ];
    }
    if (kind === "cylinder") {
      const w = range(0.014, 0.018);
      const h = Math.min(maxH, range(0.15, 0.19));
      // The foot is wider than the tube.
      return [
        w * 1.9,
        (x, y) => {
          vessel(CYLINDER, x, y, w, h);
        },
      ];
    }
    if (kind === "rack") {
      if (maxH < TUBE_H + 0.01) {
        return null;
      }
      const n = 3 + Math.floor(rng() * 3);
      const half = (n * TUBE_PITCH) / 2 + 0.008;
      return [
        half,
        (x, y) => {
          props.push({ kind: RACK, x, y, w: half, h: RACK_H, tone: rng() });
          for (let i = 0; i < n; i++) {
            const tx = x - half + 0.008 + TUBE_PITCH * (i + 0.5);
            vessel(TUBE, tx, y + 0.006, TUBE_W, TUBE_H);
          }
        },
      ];
    }
    if (kind === "bottle") {
      const w = range(0.02, 0.03);
      const h = Math.min(maxH, w * range(2.4, 3.1));
      return [
        w,
        (x, y) => {
          props.push({ kind: BOTTLE, x, y, w, h, tone: rng() });
        },
      ];
    }
    if (kind === "jar") {
      const w = range(0.028, 0.036);
      const h = Math.min(maxH, w * range(1.5, 1.9));
      return [
        w,
        (x, y) => {
          props.push({ kind: JAR, x, y, w, h, tone: rng() });
        },
      ];
    }
    // Otherwise "heated": a flask on a tripod over a burner.
    const round = rng() < 0.5;
    const w = range(0.026, 0.036);
    const h = Math.min(maxH - TRIPOD_H, w * (round ? 3.2 : 2.8));
    const half = Math.max(w, 0.032);
    return [
      half,
      (x, y) => {
        props.push({ kind: BURNER, x, y, w: BURNER_W, h: BURNER_H, tone: rng() });
        props.push({ kind: TRIPOD, x, y, w: half, h: TRIPOD_H, tone: rng() });
        vessel(round ? FLASK : CONICAL, x, y + TRIPOD_H, w, h, true);
      },
    ];
  };

  const fill = (seg: Segment) => {
    const first = vessels.length;
    let x = seg.x0 + range(0, 0.02);
    // Forced items go in at random places among the first few.
    const pending = seg.forced.map((kind) => ({ kind, at: Math.floor(rng() * 3) }));
    for (let slot = 0; slot < 40; slot++) {
      const pi = pending.findIndex((p) => p.at <= slot);
      const forced = pi >= 0;
      const kind = forced
        ? pending.splice(pi, 1)[0].kind
        : seg.menu[Math.floor(rng() * seg.menu.length)];
      const p = plan(kind, seg.maxH);
      if (!p) {
        continue;
      }
      const [half, place] = p;
      if (x + 2 * half > seg.x1) {
        if (pending.length === 0 && !forced) {
          break;
        }
        continue;
      }
      if (forced || rng() >= seg.sparse) {
        place(x + half, seg.y);
      }
      x += 2 * half + range(GAP_MIN, GAP_MAX);
    }
    if (seg.spill) {
      for (let i = first; i < vessels.length; i++) {
        if (vessels[i].kind === BEAKER && !vessels[i].heated) {
          vessels[i].spill = true;
          break;
        }
      }
    }
  };

  // The high shelves are crowded; the lower ones a little less.
  for (const sh of SHELVES) {
    const high = sh.y > 0.2;
    fill({
      x0: sh.x0 + 0.01,
      x1: sh.x1 - 0.01,
      y: sh.y,
      maxH: sh.maxH,
      menu: SHELF_MENU,
      forced: high ? ["conical", "flask"] : ["flask"],
      spill: false,
      sparse: high ? 0.05 : 0.2,
    });
  }

  // The bench's left: a burner under a flask, the glowing cylinder, the dry-ice beaker and more.
  fill({
    x0: -HALF_W + 0.02,
    x1: -MIDDLE - 0.015,
    y: BENCH_Y,
    maxH: 0.2,
    menu: BENCH_MENU,
    forced: ["heated", "cylinder", "beaker"],
    spill: true,
    sparse: 0.1,
  });
  const lava = vessels.findIndex((v) => v.kind === CYLINDER && v.y === BENCH_Y);

  // The middle: a low beaker or two near the ends, at most.
  for (const side of [-1, 1]) {
    if (rng() < 0.6) {
      const w = range(0.02, 0.026);
      const h = Math.min(LOW_TOP - BENCH_Y, w * range(1.3, 1.6));
      vessel(BEAKER, side * range(MIDDLE - 0.07, MIDDLE - 0.035), BENCH_Y, w, h);
    }
  }

  // The bench's right: free space by the middle, the distillation, low things under the condenser.
  fill({
    x0: MIDDLE + 0.015,
    x1: STILL_X - 0.05,
    y: BENCH_Y,
    maxH: 0.2,
    menu: BENCH_MENU,
    forced: [],
    spill: false,
    sparse: 0,
  });
  props.push({ kind: BURNER, x: STILL_X, y: BENCH_Y, w: BURNER_W, h: BURNER_H, tone: rng() });
  props.push({ kind: TRIPOD, x: STILL_X, y: BENCH_Y, w: 0.034, h: TRIPOD_H, tone: rng() });
  const still = vessels.length;
  vessel(FLASK, STILL_X, BENCH_Y + TRIPOD_H, STILL_R, STILL_H, true);
  fill({
    x0: STILL_X + 0.045,
    x1: RECEIVER_X - RECEIVER_W - 0.012,
    y: BENCH_Y,
    maxH: 0.095,
    menu: LOW_MENU,
    forced: ["beaker"],
    spill: true,
    sparse: 0,
  });
  const receiver = vessels.length;
  vessel(CONICAL, RECEIVER_X, BENCH_Y, RECEIVER_W, RECEIVER_H);
  vessels[receiver].fill = minFill(CONICAL, RECEIVER_H);
  // The distillate is the boiling flask's colour.
  vessels[receiver].entry = vessels[still].entry;

  if (vessels.length > MAX_VESSELS) {
    vessels.length = MAX_VESSELS;
  }
  if (props.length > MAX_PROPS) {
    props.length = MAX_PROPS;
  }

  return {
    vessels,
    props,
    emitters: pickEmitters(vessels, still, receiver),
    still,
    receiver,
    lava,
  };
}

/** How good a source of vapour each vessel makes: heated necks first. */
function emitterScore(v: Vessel): number {
  const necked = v.kind === CONICAL || v.kind === FLASK;
  if (v.heated) {
    return 4;
  }
  if (v.spill || v.kind === TUBE) {
    return 0;
  }
  if (necked && v.y <= BENCH_Y + 0.001) {
    return 3;
  }
  if (necked) {
    return 2;
  }
  return v.kind === BEAKER ? 1 : 0;
}

function pickEmitters(vessels: readonly Vessel[], still: number, receiver: number): Int16Array {
  const out = new Int16Array(4).fill(-1);
  for (let side = 0; side < 2; side++) {
    let n = 0;
    for (let score = 4; score >= 1 && n < 2; score--) {
      for (let i = 0; i < vessels.length && n < 2; i++) {
        const v = vessels[i];
        const onSide = side === 0 ? v.x < -MIDDLE : v.x > MIDDLE;
        // The boiling flask is closed by the still head.
        if (onSide && i !== still && i !== receiver && emitterScore(v) === score) {
          out[side * 2 + n++] = i;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export const PALETTE_SIZE = 6;

/** The liquids' colours: bright, so they read as glowing in the dim room. */
export const PALETTES: Readonly<Record<LabPalette, readonly Rgb[]>> = {
  mixed: [
    [0.35, 1.0, 0.3],
    [1.0, 0.25, 0.75],
    [0.2, 0.85, 1.0],
    [1.0, 0.68, 0.15],
    [0.62, 0.35, 1.0],
    [1.0, 0.36, 0.2],
  ],
  toxic: [
    [0.45, 1.0, 0.2],
    [0.75, 1.0, 0.15],
    [0.2, 0.95, 0.45],
    [0.15, 0.85, 0.65],
    [0.9, 0.95, 0.2],
    [0.4, 0.84, 0.15],
  ],
  neon: [
    [1.0, 0.15, 0.65],
    [0.22, 0.5, 1.0],
    [0.55, 1.0, 0.15],
    [0.72, 0.25, 1.0],
    [0.1, 1.0, 0.9],
    [1.0, 0.3, 0.32],
  ],
  warm: [
    [1.0, 0.6, 0.1],
    [1.0, 0.36, 0.12],
    [0.95, 0.22, 0.25],
    [1.0, 0.82, 0.3],
    [1.0, 0.45, 0.5],
    [0.88, 0.5, 0.16],
  ],
};

export function paletteFor(id: string): readonly Rgb[] {
  return lookup(PALETTES, id, "mixed");
}

/** Relative luminance (Rec. 709 weights). */
export const luma = (c: ArrayLike<number>) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * The fastest any liquid's shown colour may move, per channel per second: a
 * palette change crossfades over more than a second rather than snapping.
 */
export const COLOUR_RATE = 0.8;

/**
 * Moves `shown` (rgb triples) towards `target` by at most `rate` a second per
 * channel; NaN entries (the first frame) snap. Returns whether anything moved.
 */
export function slewColours(
  shown: Float32Array,
  target: Float32Array,
  rate: number,
  dt: number,
): boolean {
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) * rate;
  let moved = false;
  for (let i = 0; i < shown.length; i++) {
    const from = shown[i];
    const next = Number.isFinite(from) ? approach(from, target[i], step) : target[i];
    if (next !== from) {
      shown[i] = next;
      moved = true;
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/** One reaction in every slot of this many seconds… */
export const REACTION_SLOT = 120;
/** …starting somewhere in the middle half of it, so they come one to three minutes apart. */
export const REACTION_SPREAD = 0.5;
export const MIN_GAP = REACTION_SLOT * (1 - REACTION_SPREAD);
export const MAX_GAP = REACTION_SLOT * (1 + REACTION_SPREAD);
/** The first comes this soon. */
export const FIRST_REACTION = 25;
/** A colour change takes this long. */
export const CHANGE_MIN = 3;
export const CHANGE_MAX = 5;
/** A puff of vapour lasts this long. */
export const PUFF_TIME = 9;
/** A reacting flask's glow: its rise, its fall after the change, and its peak (a share of its usual light). */
export const GLOW_RISE = 1.5;
export const GLOW_FALL = 3;
export const REACTION_GLOW = 0.6;
export const PUFF_GLOW = 0.25;
/** How often a reaction is a puff of vapour rather than a colour change, where it can be. */
const PUFF_SHARE = 0.3;

export const COLOUR_CHANGE = 0;
export const PUFF = 1;

/** When the reaction in `slot` starts (s). */
export function reactionStart(slot: number, seed: number): number {
  if (slot < 1) {
    return FIRST_REACTION;
  }
  const u = hash32(hash32(slot * 0x2545 + 0xc3e) ^ (seed * 0x9e37 + 0x51)) / 4294967296;
  return slot * REACTION_SLOT + REACTION_SLOT * ((1 - REACTION_SPREAD) / 2 + REACTION_SPREAD * u);
}

/** A uniform draw for a reaction's `slot` and `salt`, in [0, 1). */
function slotRand(slot: number, seed: number, salt: number): number {
  return hash32(hash32(slot * 0x632b + salt) ^ (seed * 0x85eb + 0x7f)) / 4294967296;
}

export interface Reactions {
  /** Each vessel's settled palette entry. */
  entries: Int8Array;
  /** The next slot to start. */
  next: number;
  /** The latest reaction: its vessel (-1 before the first), kind, colours, start and length. */
  vessel: number;
  kind: number;
  from: number;
  to: number;
  start: number;
  duration: number;
}

export function createReactions(layout: LabLayout): Reactions {
  const entries = new Int8Array(layout.vessels.length);
  layout.vessels.forEach((v, i) => {
    entries[i] = v.entry;
  });
  return { entries, next: 0, vessel: -1, kind: 0, from: 0, to: 0, start: 0, duration: 1 };
}

/**
 * Starts every reaction due by `t` (seconds, unwrapped). With `enabled` off,
 * due reactions are skipped, but one under way finishes smoothly.
 */
export function stepReactions(
  r: Reactions,
  layout: LabLayout,
  seed: number,
  t: number,
  enabled: boolean,
): Reactions {
  const n = layout.vessels.length;
  if (!Number.isFinite(t) || n === 0) {
    return r;
  }
  // A long jump in time only ever starts the latest due reaction.
  while (reactionStart(r.next + 1, seed) <= t) {
    r.next++;
  }
  if (reactionStart(r.next, seed) > t) {
    return r;
  }
  const slot = r.next++;
  if (!enabled) {
    return r;
  }
  // The latest one is long over (the gaps are much longer than any reaction).
  if (r.vessel >= 0) {
    r.entries[r.vessel] = r.to;
  }
  let v = Math.floor(slotRand(slot, seed, 1) * n);
  // The distillation keeps one colour from the boiling flask to the receiver; leave both out.
  for (let k = 0; k < 2 && (v === layout.receiver || v === layout.still); k++) {
    v = (v + 1) % n;
  }
  let kind = COLOUR_CHANGE;
  if (slotRand(slot, seed, 2) < PUFF_SHARE) {
    const pick = Math.floor(slotRand(slot, seed, 3) * 4);
    for (let k = 0; k < 4; k++) {
      const e = layout.emitters[(pick + k) % 4];
      if (e >= 0) {
        v = e;
        kind = PUFF;
        break;
      }
    }
  }
  const from = r.entries[v];
  const to = (from + 1 + Math.floor(slotRand(slot, seed, 4) * (PALETTE_SIZE - 1))) % PALETTE_SIZE;
  r.vessel = v;
  r.kind = kind;
  r.from = from;
  r.to = kind === PUFF ? from : to;
  r.start = reactionStart(slot, seed);
  r.duration =
    kind === PUFF ? PUFF_TIME : CHANGE_MIN + (CHANGE_MAX - CHANGE_MIN) * slotRand(slot, seed, 5);
  return r;
}

/**
 * Vessel `v`'s liquid colour at `t` into `out` (from `out[o]`): its palette
 * entry, or partway through a reaction's change, eased in and out.
 */
export function liquidColour(
  r: Reactions,
  v: number,
  t: number,
  palette: readonly Rgb[],
  out: Float32Array,
  o: number,
): void {
  const a = palette[(r.vessel === v ? r.from : r.entries[v]) % palette.length];
  const b = palette[(r.vessel === v ? r.to : r.entries[v]) % palette.length];
  const w = r.vessel === v ? smoothstep(0, 1, (t - r.start) / r.duration) : 0;
  for (let k = 0; k < 3; k++) {
    out[o + k] = a[k] + (b[k] - a[k]) * w;
  }
}

/** Vessel `v`'s extra glow at `t` (a share of its usual light): rising, holding and fading smoothly. */
export function reactionGlow(r: Reactions, v: number, t: number): number {
  if (r.vessel !== v) {
    return 0;
  }
  const s = t - r.start;
  const peak = r.kind === PUFF ? PUFF_GLOW : REACTION_GLOW;
  const up = smoothstep(0, GLOW_RISE, s);
  const down = 1 - smoothstep(r.duration, r.duration + GLOW_FALL, s);
  return peak * Math.min(up, down);
}

/** How much a puffing vessel's vapour is boosted at `t`: 0..1, easing in and out over the puff. */
export function reactionPuff(r: Reactions, v: number, t: number): number {
  if (r.vessel !== v || r.kind !== PUFF) {
    return 0;
  }
  const s = (t - r.start) / r.duration;
  if (!(s > 0 && s < 1)) {
    return 0;
  }
  const e = Math.sin(Math.PI * s);
  return e * e;
}

// ---------------------------------------------------------------------------
// The distillation's drips
// ---------------------------------------------------------------------------

/** One drip in each slot of this many seconds, give or take `DRIP_JITTER`: 2 to 4 s apart. */
export const DRIP_SLOT = 3;
export const DRIP_JITTER = 0.5;
/** Seconds a drop takes to swell at the outlet, and to fall. */
export const DRIP_FORM = 1.2;
export const DRIP_FALL = 0.25;
/** Seconds the receiver's level takes to rise after a drop lands. */
export const DRIP_SETTLE = 0.4;
/** Drops to fill the receiver (four minutes), then slots spent fading it back to empty. */
export const RECEIVER_DROPS = 80;
export const FADE_SLOTS = 4;
export const CYCLE_SLOTS = RECEIVER_DROPS + FADE_SLOTS;
/** The receiver's liquid fades out over this long once it is full. */
export const FADE_TIME = 9;
/** The receiver's level when full. */
export const RECEIVER_FULL = maxFill(CONICAL, RECEIVER_W, RECEIVER_H);

/** When the drop of global slot `s` falls (s), or NaN in a slot spent fading. */
export function dripTime(s: number): number {
  const j = ((s % CYCLE_SLOTS) + CYCLE_SLOTS) % CYCLE_SLOTS;
  if (j >= RECEIVER_DROPS) {
    return Number.NaN;
  }
  const u = hash32(s * 0x27d4 + 0x165) / 4294967296;
  return (s + 0.5) * DRIP_SLOT + DRIP_JITTER * (2 * u - 1);
}

export interface Distillate {
  /** The receiver's level above its base (design units, 0 when empty), and its liquid's opacity. */
  level: number;
  opacity: number;
  /** The drop: its size (0: none) and how far it has fallen (0 at the outlet, 1 landed). */
  drop: number;
  fall: number;
}

export const createDistillate = (): Distillate => ({ level: 0, opacity: 1, drop: 0, fall: 0 });

/**
 * The receiver and the drop at `t` (seconds, unwrapped, ≥ 0). Each slot's drop
 * forms, falls, lands and settles before the next slot begins (its latest
 * landing is DRIP_JITTER + DRIP_FALL + DRIP_SETTLE after the slot's middle),
 * though the next drop may start to form a moment before.
 */
export function distillateAt(t: number, out: Distillate): Distillate {
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  const slot = Math.floor(time / DRIP_SLOT);
  const j = slot % CYCLE_SLOTS;
  out.drop = 0;
  out.fall = 0;
  for (let s = slot; s <= slot + 1; s++) {
    const td = dripTime(s);
    if (time >= td - DRIP_FORM && time < td) {
      out.drop = (time - (td - DRIP_FORM)) / DRIP_FORM;
    } else if (time >= td && time < td + DRIP_FALL) {
      const f = (time - td) / DRIP_FALL;
      out.drop = 1;
      out.fall = f * f;
    }
  }
  // Every earlier slot's drop this cycle, and this one's as it settles.
  let landed = Math.min(j, RECEIVER_DROPS);
  const td = dripTime(slot);
  if (Number.isFinite(td)) {
    landed += clamp((time - td - DRIP_FALL) / DRIP_SETTLE, 0, 1);
  }
  // Empty at a cycle's start, just as the full one finished fading out.
  out.level = RECEIVER_FULL * clamp(landed / RECEIVER_DROPS, 0, 1);
  const fadeStart = (slot - j + RECEIVER_DROPS) * DRIP_SLOT;
  out.opacity = 1 - smoothstep(fadeStart, fadeStart + FADE_TIME, time);
  return out;
}

// ---------------------------------------------------------------------------
// Vapour
// ---------------------------------------------------------------------------

/** The two vapour fields' boxes in design units (x0, y0, x1, y1): the left and right thirds. */
export const VAPOUR_BOXES: readonly (readonly [number, number, number, number])[] = [
  [-HALF_W, BENCH_FRONT, -MIDDLE + 0.04, 0.5],
  [MIDDLE - 0.04, BENCH_FRONT, HALF_W, 0.5],
];
/** Sim units per design unit: the shared smoke flow's curls come out smaller on screen. */
export const VAPOUR_SCALE = 1.6;
/** The field's cell size at 1080p, in pixels. */
export const VAPOUR_CELL_REF = 6;
/** The vapour's rise, curl and onset (sim units above the box's bottom). */
export const VAPOUR_RISE = 0.07;
export const VAPOUR_CURL = 1.3;
export const VAPOUR_ONSET: readonly [number, number] = [0.05, 0.4];
/** Seconds for density to fall by e near the source: at vapour 0 and 1, and the puff's extra. */
export const VAPOUR_LIFE: readonly [number, number] = [1.8, 4];
export const PUFF_LIFE = 2.5;
/** Splat radius (design units), and its growth in a puff. */
export const VAPOUR_RADIUS = 0.008;
export const PUFF_RADIUS = 0.8;

/** The field's grid size in cells, into `out`. */
export function vapourGrid(side: number, out: Int32Array): Int32Array {
  const b = VAPOUR_BOXES[side];
  out[0] = Math.max(1, Math.ceil(((b[2] - b[0]) * 1080) / VAPOUR_CELL_REF));
  out[1] = Math.max(1, Math.ceil(((b[3] - b[1]) * 1080) / VAPOUR_CELL_REF));
  return out;
}

/** The field's region in sim units (x0, y0, width, height): its box, moved to the origin and scaled. */
export function vapourRegion(side: number, out: Float64Array): Float64Array {
  const b = VAPOUR_BOXES[side];
  out[0] = 0;
  out[1] = 0;
  out[2] = (b[2] - b[0]) * VAPOUR_SCALE;
  out[3] = (b[3] - b[1]) * VAPOUR_SCALE;
  return out;
}

/** Design point (x, y) in field `side`'s sim units, into `out`. */
export function toVapour(side: number, x: number, y: number, out: Float64Array): Float64Array {
  const b = VAPOUR_BOXES[side];
  out[0] = (x - b[0]) * VAPOUR_SCALE;
  out[1] = (y - b[1]) * VAPOUR_SCALE;
  return out;
}

/** A slow sideways drift for the vapour (sim units/s per sim unit of height), wandering both ways. */
export function vapourDraft(t: number): number {
  const g = Math.sin((TAU * t) / 61) * Math.sin((TAU * t) / 149 + 1.3);
  return 0.03 + 0.08 * g;
}

const neckScratch = new Float64Array(3);
const simScratch = new Float64Array(2);

/**
 * Emitter `slot` of field `side` as the smoke field's `uEmitN` (x, y, segment
 * half width in sim units, strength) into `out`: the vessel's neck, at
 * `amount` (the vapour param, 0..1), boosted by `puff` (0..1). Off (strength
 * 0) with no vessel.
 */
export function vapourEmitter(
  layout: LabLayout,
  side: number,
  slot: number,
  amount: number,
  puff: number,
  out: Float64Array,
): Float64Array {
  const vi = layout.emitters[side * 2 + slot];
  const a = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  if (vi < 0 || vi >= layout.vessels.length) {
    out.fill(0);
    return out;
  }
  const v = layout.vessels[vi];
  neckOf(v, neckScratch);
  toVapour(side, neckScratch[0], neckScratch[1] + 0.006, simScratch);
  out[0] = simScratch[0];
  out[1] = simScratch[1];
  out[2] = neckScratch[2] * 0.6 * VAPOUR_SCALE;
  const p = clamp(puff, 0, 1);
  // A puff is bigger where there is vapour already; with none, there is none to puff.
  out[3] = Math.min(1, a * (v.heated ? 0.9 : 0.6) + p * 0.6 * Math.min(1, 2 * a));
  return out;
}
