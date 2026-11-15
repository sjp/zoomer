/**
 * Corporate Memphis's scene: where the people, plants and floating props go for
 * the canvas's shape, what each looks like for a seed, and the slow life of the
 * picture: idle sway, waves, leaves tilting, and every 20–40 s one person
 * changing pose (or the two nearest the middle stretching into a high five).
 *
 * Reference px: the frame is `REF_HEIGHT` tall and as wide as its aspect makes
 * it; y points down.
 */
import { MAX_FEATURE_PX_PER_FRAME } from "../motion-limits";
import { approach, clamp } from "../math";
import { createRng, hash32 } from "../noise";
import {
  BACK_ELBOW,
  BLEND_SIZE,
  blendPose,
  FOREARM,
  FRONT_ELBOW,
  HAND_OFFSET,
  HAND_R,
  JOINT_COUNT,
  LEAN,
  NOD,
  POSE_HIGH_FIVE,
  POSE_WAVE,
  poseWeight,
  POSES,
  REACH,
  ROOT_Y,
  SHOULDER_DROP,
  SOLO_POSES,
  solveRig,
  TIP_JOINTS,
  TORSO,
  UP_REACH,
  UPPER_ARM,
} from "./memphis-figures";
import { MAX_PEOPLE } from "./memphis.meta";

export const REF_HEIGHT = 1080;
/** The band across the top the high five's arms stay in, as a fraction of the height. */
export const TOP_BAND = 0.2;
/** Where the high five's hands meet, as a fraction of the height. */
const HAND_Y = 0.1;
/** Where the ground is, as a fraction of the height. */
const GROUND = 0.975;
/** The outer zones people and props keep to (landscape), as a fraction of the width. */
const ZONE = 0.25;
const MARGIN = 0.012;
/** Second-row people stand this far (figure units) outside the first. */
const SPREAD = 0.3;
/** The outermost a person's hip goes, as a fraction of the width. */
const OUTER_MIN = 0.03;
/** Portrait: the clear area's sides and bottom, as fractions; people stand below it. */
const PORTRAIT_SIDE = 0.2;
const PORTRAIT_FLOOR = 0.72;

/** Plants in plant units (about their height): pot and leaves. */
export const POT_H = 0.24;
export const POT_BOTTOM = 0.085;
export const POT_TOP = 0.12;
const LEAVES = 7;
/** How far a plant reaches sideways and up from its pot's foot, plant units. */
const PLANT_REACH = 0.75;
const PLANT_UP = 1.0;
const PLANT_X = 0.035;

/** Floating props' half extents at prop scale 1, ref px (the bubble's tail included). */
const PROP_HALF_W = 100;
const PROP_HALF_H = 80;
/** Floating props bob this far, ref px. */
export const PROP_BOB = 6;
/** The giant mug at prop scale 1: half width and height, ref px. */
export const MUG_HALF_W = 62;
export const MUG_H = 150;

export const PROP_CHART = 0;
export const PROP_TICK = 1;
export const PROP_HEART = 2;
export const PROP_BULB = 3;
const PROP_KINDS = 4;

// ---------------------------------------------------------------------------
// Palettes

/** Colour roles: each palette lists one colour per role, all different. */
export const C_BG = 0;
export const C_BLOB = 1;
const BLOB_COLORS = 3;
export const C_TOP = 4;
export const TOPS = 4;
export const C_BOTTOM = 8;
export const BOTTOMS = 3;
export const C_SHOE = 11;
const SHOES = 2;
/** Near-black: coffee, belts, soles, glasses. */
export const C_INK = 13;
export const C_LEAF = 14;
export const C_POT = 16;
export const C_CARD = 17;
export const C_ACCENT = 18;
export const C_HEART = 19;
export const C_COIN = 20;
export const C_COIN_EDGE = 21;
export const C_LAPTOP = 22;
export const C_MUG = 23;
export const ROLE_COUNT = 24;

/**
 * Flat colours by role, per palette: coral, mustard, teal and lavender
 * clothes and props. Order: background, 3 blobs, 4 tops, 3 trousers, 2 shoes,
 * ink, 2 leaves, pot, card, accent, heart, coin, coin edge, laptop, mug.
 */
export const PALETTES: Record<string, readonly string[]> = {
  startup: [
    "#f6f2ea",
    "#f2d9c6",
    "#ddd5f3",
    "#cde9de",
    "#f2894a",
    "#ffc93c",
    "#1fa89a",
    "#7b5cd6",
    "#2b2d6e",
    "#3f68c9",
    "#e0b48a",
    "#1b1b2f",
    "#ff6f61",
    "#2a2140",
    "#2f9e6e",
    "#5cc48f",
    "#e2725b",
    "#ffffff",
    "#6c63ff",
    "#ff4f6d",
    "#f2b632",
    "#d38f1f",
    "#c3c9db",
    "#ff8a5c",
  ],
  fintech: [
    "#eef1fb",
    "#d6ddf8",
    "#d2eee8",
    "#f9e5c8",
    "#2f80ed",
    "#f6c343",
    "#18b49a",
    "#ff7a6b",
    "#1d2b5c",
    "#5b4bdb",
    "#8fa3c7",
    "#101828",
    "#ff9255",
    "#2b2236",
    "#1e8c74",
    "#4fc3a1",
    "#7c6cf0",
    "#fdfdff",
    "#2f6bff",
    "#ff5c84",
    "#ffcc33",
    "#e0a81c",
    "#b8c0d9",
    "#ff9f43",
  ],
  wellness: [
    "#ebf6ef",
    "#cfe9da",
    "#f6ded2",
    "#e2dbf3",
    "#f39a6b",
    "#f4c95d",
    "#3bb0a0",
    "#8c6ad8",
    "#2d4a53",
    "#4f86c6",
    "#d9c2a5",
    "#1f2d2e",
    "#c3a6ee",
    "#3a2e39",
    "#3f9b6f",
    "#7cc69b",
    "#e8a27c",
    "#fffdf8",
    "#6c9ee0",
    "#ef6f7c",
    "#eec25a",
    "#cf9f35",
    "#d3d0e4",
    "#f08e6b",
  ],
};

/** Natural skin tones, lightest to deepest, the same in every palette. */
export const SKIN_TONES: readonly string[] = [
  "#f7d7c1",
  "#eab894",
  "#d39a6a",
  "#b07446",
  "#8a5232",
  "#5e3621",
];

/** Natural hair colours: black, dark brown, auburn, blonde, grey. */
export const HAIR_COLORS: readonly string[] = [
  "#1f1a1c",
  "#4a2f23",
  "#9a4426",
  "#dcae5c",
  "#bdb8b2",
];
const HAIR_GREY = 4;

// ---------------------------------------------------------------------------
// The wardrobe

/** Hairstyles; 0 is a short crop. */
export const HAIR_AFRO = 1;
export const HAIR_LONG = 2;
export const HAIR_PONYTAIL = 3;
export const HAIR_BUN = 4;
export const HAIR_BOB = 5;
export const HAIR_BUZZ = 6;
export const HAIR_RECEDING = 7;
export const HAIR_STYLES = 8;

/** Tops; 0 is a t-shirt. */
export const TOP_SHIRT = 1;
export const TOP_JUMPER = 2;
export const TOP_JACKET = 3;
/** A dress replaces the top and the bottoms. */
export const TOP_DRESS = 4;
export const TOP_KINDS = 5;

/** Bottoms; 0 is slim trousers. */
export const BOTTOM_WIDE = 1;
export const BOTTOM_JEANS = 2;
export const BOTTOM_SKIRT = 3;
export const BOTTOM_KINDS = 4;

/** Shoes; 0 is trainers. */
export const SHOE_BOOTS = 1;
export const SHOE_FLATS = 2;
export const SHOE_KINDS = 3;

const ACC_NONE = 0;
export const ACC_GLASSES = 1;
export const ACC_BEANIE = 2;
export const ACC_HEADPHONES = 3;
/** Chance a person wears an accessory. */
const ACCESSORY_CHANCE = 0.45;

// ---------------------------------------------------------------------------
// Layout

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where something stands: its foot's x, the ground's y, its size and which way it faces (±1). */
export interface Spot {
  x: number;
  ground: number;
  size: number;
  facing: number;
}

interface Point {
  x: number;
  y: number;
}

export interface Layout {
  width: number;
  height: number;
  portrait: boolean;
  /** The speaker's area: no person or prop enters it, apart from the high five's arms. */
  clear: Rect;
  /** People: left near the middle, right near the middle, left outside, right outside. */
  figures: Spot[];
  /** The plants, left then right. */
  plants: Spot[];
  /** The mug, at whichever side the seed picks (`facing` says which: +1 left). */
  mugs: Spot[];
  /** Floating prop slots; portrait uses the first two. */
  props: Point[];
  propCount: number;
  /** The props' scale (1 at a 16:9 frame). */
  propScale: number;
  /** Background blobs: centre and radius. */
  blobs: (Point & { r: number })[];
  /** Whether a high five fits (landscape). */
  highFive: boolean;
  /** Where the high five's hands meet. */
  handX: number;
  handY: number;
}

const spot = (): Spot => ({ x: 0, ground: 0, size: 1, facing: 1 });

export function createLayout(): Layout {
  return {
    width: 1,
    height: 1,
    portrait: false,
    clear: { x0: 0, y0: 0, x1: 0, y1: 0 },
    figures: Array.from({ length: MAX_PEOPLE }, spot),
    plants: [spot(), spot()],
    mugs: [spot(), spot()],
    props: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
    propCount: 4,
    propScale: 1,
    blobs: Array.from({ length: 4 }, () => ({ x: 0, y: 0, r: 0 })),
    highFive: false,
    handX: 0,
    handY: 0,
  };
}

function setSpot(s: Spot, x: number, ground: number, size: number, facing: number): void {
  s.x = x;
  s.ground = ground;
  s.size = size;
  s.facing = facing;
}

/** Lays the scene out for a `width` x `height` reference px frame, in place. */
export function updateLayout(layout: Layout, width: number, height: number): Layout {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  layout.width = w;
  layout.height = h;
  layout.portrait = w < h;
  const ground = GROUND * h;
  layout.handX = w / 2;
  layout.handY = HAND_Y * h;
  const c = layout.clear;
  if (!layout.portrait) {
    const zone = ZONE * w;
    const margin = MARGIN * w;
    c.x0 = zone;
    c.x1 = w - zone;
    c.y0 = TOP_BAND * h;
    c.y1 = h;
    // People: as big as fits two deep, the inner one's reach stopping at the zone's edge.
    const size = Math.min(0.5 * h, (zone - margin - OUTER_MIN * w) / (REACH + SPREAD));
    const inner = zone - margin - REACH * size;
    const outer = inner - SPREAD * size;
    setSpot(layout.figures[0], inner, ground, size, 1);
    setSpot(layout.figures[1], w - inner, ground, size, -1);
    setSpot(layout.figures[2], outer, ground, size, 1);
    setSpot(layout.figures[3], w - outer, ground, size, -1);
    const px = PLANT_X * w;
    const plant = Math.min(0.55 * h, (zone - margin - px) / PLANT_REACH);
    setSpot(layout.plants[0], px, ground, plant, 1);
    setSpot(layout.plants[1], w - px, ground, plant, -1);
    const k = Math.min(1, zone / 480);
    layout.propScale = k;
    const mx = px + MUG_HALF_W * k * 1.4;
    setSpot(layout.mugs[0], mx, ground, k, 1);
    setSpot(layout.mugs[1], w - mx, ground, k, -1);
    // Two floating slots a side: high and outside, lower and inside.
    const slots = layout.props;
    slots[0].x = 0.3 * zone;
    slots[0].y = 0.13 * h;
    slots[1].x = w - 0.3 * zone;
    slots[1].y = 0.13 * h;
    slots[2].x = 0.68 * zone;
    slots[2].y = 0.33 * h;
    slots[3].x = w - 0.68 * zone;
    slots[3].y = 0.33 * h;
    layout.propCount = 4;
    const blobs = layout.blobs;
    const r = Math.min(0.3 * h, 0.7 * zone);
    blobs[0].x = 0.4 * zone;
    blobs[0].y = 0.66 * h;
    blobs[0].r = r;
    blobs[1].x = 0.55 * zone;
    blobs[1].y = 0.2 * h;
    blobs[1].r = 0.7 * r;
    blobs[2].x = w - 0.45 * zone;
    blobs[2].y = 0.62 * h;
    blobs[2].r = 0.95 * r;
    blobs[3].x = w - 0.5 * zone;
    blobs[3].y = 0.18 * h;
    blobs[3].r = 0.75 * r;
    layout.highFive = true;
  } else {
    c.x0 = PORTRAIT_SIDE * w;
    c.x1 = (1 - PORTRAIT_SIDE) * w;
    c.y0 = TOP_BAND * h;
    c.y1 = PORTRAIT_FLOOR * h;
    // People stand below the clear area, raised hands and all.
    const band = ground - c.y1 - 0.01 * h;
    const size = Math.min(band / UP_REACH, w / 3);
    setSpot(layout.figures[0], 0.3 * w, ground, size, 1);
    setSpot(layout.figures[1], 0.7 * w, ground, size, -1);
    setSpot(layout.figures[2], 0.1 * w, ground, size, 1);
    setSpot(layout.figures[3], 0.9 * w, ground, size, -1);
    const plant = Math.min(band / PLANT_UP, 0.4 * w);
    setSpot(layout.plants[0], 0.02 * w, ground, plant, 1);
    setSpot(layout.plants[1], 0.98 * w, ground, plant, -1);
    const k = Math.min(0.8, (0.5 * c.y0 - PROP_BOB) / PROP_HALF_H, (0.5 * w) / (2 * PROP_HALF_W));
    layout.propScale = k;
    const mx = 0.02 * w + MUG_HALF_W * k * 1.4;
    setSpot(layout.mugs[0], mx, ground, k, 1);
    setSpot(layout.mugs[1], w - mx, ground, k, -1);
    const slots = layout.props;
    slots[0].x = 0.25 * w;
    slots[0].y = 0.5 * c.y0;
    slots[1].x = 0.75 * w;
    slots[1].y = 0.5 * c.y0;
    layout.propCount = 2;
    const blobs = layout.blobs;
    const r = 0.45 * w;
    blobs[0].x = 0.1 * w;
    blobs[0].y = 0.86 * h;
    blobs[0].r = r;
    blobs[1].x = 0.15 * w;
    blobs[1].y = 0.08 * h;
    blobs[1].r = 0.6 * r;
    blobs[2].x = 0.9 * w;
    blobs[2].y = 0.84 * h;
    blobs[2].r = 0.9 * r;
    blobs[3].x = 0.85 * w;
    blobs[3].y = 0.1 * h;
    blobs[3].r = 0.65 * r;
    layout.highFive = false;
  }
  return layout;
}

/**
 * The high five's front-arm stretch for person `index` (0 or 1, the pair nearest
 * the middle) into `out`: [upper arm, forearm] length factors that put the elbow
 * level with the meeting point and the hand at the middle, touching its partner's.
 */
export function highFiveStretch(layout: Layout, index: number, out: Float64Array): Float64Array {
  const s = layout.figures[index];
  const shoulder = POSES[POSE_HIGH_FIVE][ROOT_Y] + TORSO - SHOULDER_DROP;
  const up = (s.ground - layout.handY) / s.size;
  out[0] = Math.max(1, (up - shoulder) / UPPER_ARM);
  const across = Math.abs(layout.handX - s.x) / s.size - 0.75 * HAND_R;
  out[1] = Math.max(1, (across - HAND_OFFSET) / FOREARM);
  return out;
}

// ---------------------------------------------------------------------------
// Tween timing

/** Shortest pose change, s. */
export const MIN_TWEEN = 1.5;
/** The share of the codec's per-frame limit a pose change may use; idle motion has the rest. */
const TWEEN_BUDGET = 0.6;
/** The limit as ref px per second (1080p px at 30 fps). */
const TWEEN_PX_PER_SECOND = TWEEN_BUDGET * MAX_FEATURE_PX_PER_FRAME * 30;
const TWEEN_SAMPLES = 96;

const tweenPose = new Float64Array(BLEND_SIZE);
const tweenJoints = new Float64Array(2 * JOINT_COUNT);
const tweenLast = new Float64Array(2 * JOINT_COUNT);

/**
 * Seconds a change from pose `from` to `to` takes for a person `size` ref px
 * tall: at least `MIN_TWEEN`, and long enough that no hand, foot or head moves
 * faster than its share of the codec limit. `upper` and `fore` are the high
 * five's stretch.
 */
export function tweenSeconds(
  from: number,
  to: number,
  upper: number,
  fore: number,
  size: number,
): number {
  let peak = 0;
  for (let i = 0; i <= TWEEN_SAMPLES; i++) {
    solveRig(blendPose(from, to, i / TWEEN_SAMPLES, upper, fore, tweenPose), tweenJoints);
    if (i > 0) {
      for (const j of TIP_JOINTS) {
        const d = Math.hypot(
          tweenJoints[2 * j] - tweenLast[2 * j],
          tweenJoints[2 * j + 1] - tweenLast[2 * j + 1],
        );
        peak = Math.max(peak, d);
      }
    }
    tweenLast.set(tweenJoints);
  }
  // `peak` is figure units per sample of a one-second tween.
  return Math.max(MIN_TWEEN, (peak * TWEEN_SAMPLES * size) / TWEEN_PX_PER_SECOND);
}

// ---------------------------------------------------------------------------
// The scene

export interface Figure {
  from: number;
  to: number;
  /** Tween progress, 0..1 (1 when settled). */
  t: number;
  duration: number;
  /** Presence, 0..1: fades in and out with the People slider. */
  alpha: number;
  /** Skin tone and hair colour (indices into `SKIN_TONES` and `HAIR_COLORS`). */
  skin: number;
  hairColor: number;
  /** Wardrobe kinds (`HAIR_*`, `TOP_*`, `BOTTOM_*`, `SHOE_*`, `ACC_*`) and colour roles. */
  hair: number;
  top: number;
  topColor: number;
  bottom: number;
  bottomColor: number;
  shoe: number;
  shoeColor: number;
  accessory: number;
  /** The beanie's colour, a top role other than the person's own. */
  accessoryColor: number;
  /** Width factor for the torso, about 1. */
  build: number;
  /** Idle phases: sway, nod, arms, wave. */
  phases: Float64Array;
  /**
   * The high five's arm stretch last used ([upper arm, forearm]), kept so a
   * high five ended by the frame turning portrait shrinks back smoothly.
   */
  stretch: Float64Array;
}

interface Leaf {
  angle: number;
  length: number;
  width: number;
  phase: number;
}

export interface Scene {
  seed: number;
  figures: Figure[];
  /** Leaves per plant, left then right, ordered by angle. */
  leaves: Leaf[][];
  /** Which side's mug shows: 0 left, 1 right. */
  mugSide: number;
  /** Prop kind per slot. */
  props: number[];
  propPhases: Float64Array;
  /** Background blob colours (role offsets) and phases. */
  blobColors: number[];
  blobPhases: Float64Array;
  /** Idle-animation clock, s. */
  clock: number;
  /** The blobs' slow change of shape, radians, advancing with motion and wrapped to 2π. */
  morph: number;
  /** Eased motion amount. */
  motion: number;
  /** Seconds (of motion-scaled time) to the next pose change. */
  nextChange: number;
  rng: () => number;
  propsAlpha: number;
  /** The whole picture's opacity, dipping while a new variation swaps in. */
  swap: number;
  /** The variation to swap to, or the current one. */
  targetSeed: number;
  started: boolean;
}

/** How fast the blobs change shape, radians per s. */
const MORPH_RATE = 0.04;
/** Seconds people and props take to fade in or out. */
const FADE = 0.8;
/** Seconds a variation change takes to fade out (and again to fade in). */
const SWAP = 0.6;
/** Motion eases to a new value at this rate, per s. */
const MOTION_RATE = 1;
/** Pose changes come every 20–40 s. */
const CHANGE_MIN = 20;
const CHANGE_SPAN = 20;
/** Chance a pose change is a high five, when it fits. */
const HIGH_FIVE_CHANCE = 0.3;
/** Seconds to wait when a pose change finds its people busy. */
const RETRY = 2;

/** A uniform 0..1 from a seed and up to two indices; the same inputs give the same value. */
function hash01(seed: number, a: number, b = 0): number {
  return hash32(hash32(hash32(seed + 0x51ed) ^ (a * 0x9e3779b1)) ^ (b * 0x85ebca6b)) / 4294967296;
}

const TAU = 2 * Math.PI;

function createFigure(): Figure {
  return {
    from: 0,
    to: 0,
    t: 1,
    duration: MIN_TWEEN,
    alpha: 0,
    skin: 0,
    hairColor: 0,
    hair: 0,
    top: 0,
    topColor: 0,
    bottom: 0,
    bottomColor: 0,
    shoe: 0,
    shoeColor: 0,
    accessory: ACC_NONE,
    accessoryColor: 0,
    build: 1,
    phases: new Float64Array(4),
    stretch: new Float64Array([1, 1]),
  };
}

/** `0..n-1` shuffled by `seed` and `salt`, into `out`. */
function shuffle(out: number[], n: number, seed: number, salt: number): number[] {
  out.length = n;
  for (let k = 0; k < n; k++) {
    out[k] = k;
  }
  for (let k = n - 1; k > 0; k--) {
    const j = Math.floor(hash01(seed, salt, k) * (k + 1));
    const tmp = out[k];
    out[k] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** People who stand together: each side's pair, and the pair nearest the middle. */
const NEIGHBOURS = [
  [0, 2],
  [1, 3],
  [0, 1],
] as const;

/**
 * Dresses everyone so they look clearly different: no two share a hairstyle,
 * a top or a top colour; neighbours' skin tones are at least two shades
 * apart; and neighbours differ in hair colour, trousers and shoes.
 */
function dressFigures(figures: Figure[], seed: number): void {
  const n = figures.length;
  const hairs = shuffle([], HAIR_STYLES, seed, 1);
  const tops = shuffle([], TOP_KINDS, seed, 2);
  const topColors = shuffle([], TOPS, seed, 3);
  const bottoms = shuffle([], BOTTOM_KINDS, seed, 4);
  const hairColors = shuffle([], HAIR_COLORS.length, seed, 5);
  // Skin: the first shuffle that keeps neighbours two or more shades apart.
  const skins: number[] = [];
  for (let attempt = 0; attempt < 64; attempt++) {
    shuffle(skins, SKIN_TONES.length, seed, 100 + attempt);
    if (NEIGHBOURS.every(([a, b]) => Math.abs(skins[a] - skins[b]) >= 2)) {
      break;
    }
  }
  for (let i = 0; i < n; i++) {
    const f = figures[i];
    f.hair = hairs[i % HAIR_STYLES];
    f.top = tops[i % TOP_KINDS];
    f.topColor = topColors[i % TOPS];
    f.bottom = bottoms[i % BOTTOM_KINDS];
    f.skin = skins[i % SKIN_TONES.length];
    f.hairColor = hairColors[i % HAIR_COLORS.length];
  }
  // Receding hair goes grey: swap colours with whoever had grey.
  const bald = figures.find((f) => f.hair === HAIR_RECEDING);
  const grey = figures.find((f) => f.hairColor === HAIR_GREY);
  if (bald && bald.hairColor !== HAIR_GREY) {
    if (grey) {
      grey.hairColor = bald.hairColor;
    }
    bald.hairColor = HAIR_GREY;
  }
  const bottomBase = Math.floor(hash01(seed, 6) * BOTTOMS);
  const shoeBase = Math.floor(hash01(seed, 7) * SHOE_KINDS);
  const shoeColorBase = Math.floor(hash01(seed, 8) * SHOES);
  for (let i = 0; i < n; i++) {
    const f = figures[i];
    // Neighbours differ: 0 and 2, 1 and 3, 0 and 1.
    f.bottomColor = (bottomBase + (i % BOTTOMS)) % BOTTOMS;
    f.shoe = (shoeBase + (i >> 1) + 2 * (i & 1)) % SHOE_KINDS;
    f.shoeColor = (shoeColorBase + (i >> 1)) % SHOES;
    f.build = 0.92 + 0.18 * hash01(seed, 9, i);
    // Beanies only sit over short or flat hair.
    const hat = hash01(seed, 10, i);
    if (hat < ACCESSORY_CHANCE) {
      const kind = 1 + Math.floor((hat / ACCESSORY_CHANCE) * 3);
      const bulky = f.hair === HAIR_AFRO || f.hair === HAIR_BUN || f.hair === HAIR_PONYTAIL;
      f.accessory = kind === ACC_BEANIE && bulky ? ACC_GLASSES : kind;
    } else {
      f.accessory = ACC_NONE;
    }
    f.accessoryColor = (f.topColor + 1 + (i & 1)) % TOPS;
  }
}

/** Looks, starting poses and props for `seed`; each item from its own hash, so items are independent. */
function applySeed(scene: Scene, seed: number): void {
  scene.seed = seed;
  scene.targetSeed = seed;
  dressFigures(scene.figures, seed);
  scene.figures.forEach((f, i) => {
    const pose = Math.floor(hash01(seed, 11, i) * SOLO_POSES);
    f.from = pose;
    f.to = pose;
    f.t = 1;
    for (let k = 0; k < 4; k++) {
      f.phases[k] = hash01(seed, 12 + k, i) * TAU;
    }
  });
  scene.leaves.forEach((leaves, p) => {
    leaves.forEach((leaf, k) => {
      const spread = (k / (LEAVES - 1)) * 2 - 1;
      leaf.angle = spread * 0.95 + (hash01(seed, 20, p * 16 + k) - 0.5) * 0.12;
      // Middle leaves longest.
      leaf.length = 0.48 + 0.24 * (1 - Math.abs(spread)) + hash01(seed, 21, p * 16 + k) * 0.08;
      leaf.width = 0.075 + hash01(seed, 22, p * 16 + k) * 0.025;
      leaf.phase = hash01(seed, 23, p * 16 + k) * TAU;
    });
  });
  scene.mugSide = hash01(seed, 30) < 0.5 ? 0 : 1;
  // Every prop once, shuffled across the slots.
  const kinds = scene.props;
  for (let k = 0; k < PROP_KINDS; k++) {
    kinds[k] = k;
  }
  for (let k = PROP_KINDS - 1; k > 0; k--) {
    const j = Math.floor(hash01(seed, 31, k) * (k + 1));
    const tmp = kinds[k];
    kinds[k] = kinds[j];
    kinds[j] = tmp;
  }
  for (let k = 0; k < PROP_KINDS; k++) {
    scene.propPhases[k] = hash01(seed, 32, k) * TAU;
  }
  const blobBase = Math.floor(hash01(seed, 40) * BLOB_COLORS);
  for (let k = 0; k < 4; k++) {
    // Neighbouring blobs (same side) differ.
    scene.blobColors[k] = (blobBase + k) % BLOB_COLORS;
    scene.blobPhases[k] = hash01(seed, 41, k) * TAU;
  }
  scene.rng = createRng(hash32(seed + 0x7a3));
  scene.nextChange = CHANGE_MIN + scene.rng() * CHANGE_SPAN;
}

export function createScene(seed: number): Scene {
  const scene: Scene = {
    seed,
    figures: Array.from({ length: MAX_PEOPLE }, createFigure),
    leaves: [0, 1].map(() =>
      Array.from({ length: LEAVES }, () => ({ angle: 0, length: 0, width: 0, phase: 0 })),
    ),
    mugSide: 0,
    props: [0, 1, 2, 3],
    propPhases: new Float64Array(PROP_KINDS),
    blobColors: [0, 1, 2, 0],
    blobPhases: new Float64Array(4),
    clock: 0,
    morph: 0,
    motion: 0,
    nextChange: CHANGE_MIN,
    // A placeholder: applySeed below seeds it.
    rng: createRng(0),
    propsAlpha: 0,
    swap: 1,
    targetSeed: seed,
    started: false,
  };
  applySeed(scene, seed);
  return scene;
}

/** Starts person `f` (slot `index`) changing to pose `to`. */
function startTween(f: Figure, index: number, to: number, layout: Layout): void {
  if (index < 2 && layout.highFive) {
    highFiveStretch(layout, index, f.stretch);
  }
  f.from = f.to;
  f.to = to;
  f.t = 0;
  f.duration = tweenSeconds(f.from, to, f.stretch[0], f.stretch[1], layout.figures[index].size);
}

/** A solo pose for `f` other than the one it holds. */
function otherPose(scene: Scene, f: Figure): number {
  const current = f.to === POSE_HIGH_FIVE ? -1 : f.to;
  const n = current < 0 ? SOLO_POSES : SOLO_POSES - 1;
  const k = Math.floor(scene.rng() * n);
  return current >= 0 && k >= current ? k + 1 : k;
}

const settled = (f: Figure) => f.t >= 1;

/** Ends a high five under way: back the way it came if still reaching, else to new poses. */
function endHighFive(scene: Scene, layout: Layout): void {
  for (let i = 0; i < 2; i++) {
    const f = scene.figures[i];
    if (f.to !== POSE_HIGH_FIVE) {
      continue;
    }
    if (f.from !== POSE_HIGH_FIVE && !settled(f)) {
      // Reversing keeps the pose continuous: the blend is symmetric in t.
      f.to = f.from;
      f.from = POSE_HIGH_FIVE;
      f.t = 1 - f.t;
    } else {
      startTween(f, i, otherPose(scene, f), layout);
    }
  }
}

/** One scheduled pose change. Returns false when the people it picked are busy. */
function changePose(scene: Scene, layout: Layout, people: number): boolean {
  const [a, b] = scene.figures;
  if (a.to === POSE_HIGH_FIVE || b.to === POSE_HIGH_FIVE) {
    if (!settled(a) || !settled(b)) {
      return false;
    }
    endHighFive(scene, layout);
    return true;
  }
  if (layout.highFive && people >= 2 && scene.rng() < HIGH_FIVE_CHANCE) {
    if (!settled(a) || !settled(b)) {
      return false;
    }
    startTween(a, 0, POSE_HIGH_FIVE, layout);
    startTween(b, 1, POSE_HIGH_FIVE, layout);
    // Both reach together, at the slower one's pace.
    const d = Math.max(a.duration, b.duration);
    a.duration = d;
    b.duration = d;
    return true;
  }
  if (people < 1) {
    return true;
  }
  const i = Math.min(people - 1, Math.floor(scene.rng() * people));
  const f = scene.figures[i];
  if (!settled(f)) {
    return false;
  }
  startTween(f, i, otherPose(scene, f), layout);
  return true;
}

interface SceneParams {
  people: number;
  props: boolean;
  motion: number;
  seed: number;
}

/**
 * Advances the scene `dt` seconds. The pose schedule runs on motion-scaled time,
 * so Motion 0 holds still (a change under way finishes); fades and the swap to
 * a new variation run on real time.
 */
export function stepScene(scene: Scene, layout: Layout, dt: number, p: SceneParams): void {
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const people = clamp(Math.round(p.people), 0, MAX_PEOPLE);
  const motion = clamp(p.motion, 0, 1);
  if (!scene.started) {
    // The first frame shows the settled picture, no fade-in.
    scene.started = true;
    scene.motion = motion;
    scene.propsAlpha = p.props ? 1 : 0;
    scene.figures.forEach((f, i) => {
      f.alpha = i < people ? 1 : 0;
    });
    if (p.seed !== scene.seed) {
      applySeed(scene, p.seed);
    }
  }
  scene.motion = approach(scene.motion, motion, MOTION_RATE * step);

  // A new variation fades the picture out, swaps, and fades back in.
  scene.targetSeed = p.seed;
  if (scene.targetSeed !== scene.seed) {
    scene.swap = Math.max(0, scene.swap - step / SWAP);
    if (scene.swap <= 0) {
      applySeed(scene, scene.targetSeed);
    }
  } else {
    scene.swap = Math.min(1, scene.swap + step / SWAP);
  }

  scene.propsAlpha = approach(scene.propsAlpha, p.props ? 1 : 0, step / FADE);
  scene.figures.forEach((f, i) => {
    f.alpha = approach(f.alpha, i < people ? 1 : 0, step / FADE);
    if (f.t < 1) {
      f.t = Math.min(1, f.t + step / f.duration);
    }
  });

  // A high five needs its pair and a landscape frame.
  const hf = scene.figures[0].to === POSE_HIGH_FIVE || scene.figures[1].to === POSE_HIGH_FIVE;
  if (hf && (!layout.highFive || people < 2)) {
    endHighFive(scene, layout);
  }

  scene.clock += step;
  scene.morph = (scene.morph + MORPH_RATE * step * scene.motion) % TAU;
  scene.nextChange -= step * scene.motion;
  if (scene.nextChange <= 0) {
    scene.nextChange = changePose(scene, layout, people)
      ? CHANGE_MIN + scene.rng() * CHANGE_SPAN
      : RETRY;
  }
}

/** Forces the next scheduled pose change now (tests). */
export function changePoseNow(scene: Scene, layout: Layout, people: number): boolean {
  return changePose(scene, layout, people);
}

// ---------------------------------------------------------------------------
// Idle motion

/** Idle amplitudes, radians, and periods, s. */
const SWAY = 0.03;
const SWAY_PERIOD = 7.3;
const NOD_AMP = 0.05;
const NOD_PERIOD = 4.1;
const ARM_AMP = 0.06;
const ARM_PERIOD = 5.3;
/** The wave: the front elbow swings this far, a few seconds a wave. */
const WAVE_AMP = 0.4;
const WAVE_PERIOD = 2.6;
/** Leaves tilt this far, radians, over these periods. */
export const LEAF_TILT = 0.05;
export const LEAF_PERIOD = 6.5;
/** Blobs and floating props bob over these periods. */
export const BOB_PERIOD = 6.2;
export const BLOB_BOB = 5;

/**
 * Person `index`'s pose this frame (`BLEND_SIZE`, into `out`): the tween's blend
 * plus idle sway, nods and the wave, all scaled by the eased motion. The high
 * five holds still where its hands meet.
 */
export function figurePose(
  scene: Scene,
  layout: Layout,
  index: number,
  out: Float64Array,
): Float64Array {
  const f = scene.figures[index];
  // The stretch follows the frame while a high five can show; one ended by a
  // portrait frame keeps its last stretch as it shrinks back.
  if (index < 2 && layout.highFive) {
    highFiveStretch(layout, index, f.stretch);
  }
  blendPose(f.from, f.to, f.t, f.stretch[0], f.stretch[1], out);
  const m = scene.motion;
  if (m <= 0) {
    return out;
  }
  const c = scene.clock;
  const ph = f.phases;
  // The high five's arm and shoulders hold still so the hands stay together.
  const loose = (1 - poseWeight(POSE_HIGH_FIVE, f.from, f.to, f.t)) * m;
  const wave = poseWeight(POSE_WAVE, f.from, f.to, f.t);
  out[LEAN] += loose * SWAY * Math.sin((TAU * c) / SWAY_PERIOD + ph[0]);
  out[NOD] += m * NOD_AMP * Math.sin((TAU * c) / NOD_PERIOD + ph[1]);
  out[BACK_ELBOW] += m * ARM_AMP * Math.sin((TAU * c) / ARM_PERIOD + ph[2]);
  out[FRONT_ELBOW] +=
    loose * ARM_AMP * Math.sin((TAU * c) / ARM_PERIOD + ph[2] + 1.9) +
    m * wave * WAVE_AMP * Math.sin((TAU * c) / WAVE_PERIOD + ph[3]);
  return out;
}
