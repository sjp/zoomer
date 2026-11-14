/**
 * Corporate Memphis's people, in the style of mix-and-match flat illustration
 * kits: natural skin tones, a head in side view with a nose and an ear but no
 * features, and a wardrobe of hair, tops, bottoms, shoes and accessories.
 *
 * Every part is an outline in its bone's own space, like a cut-out puppet: a
 * list of knots along the bone (where across it the back and front edges
 * sit), smoothed between knots and rounded off at the ends. The rig places the
 * bones each frame and the parts follow, so every pose and tween reuses the
 * same outlines. Parts overlap at the joints with rounded ends.
 *
 * Bone space: `a` runs along the bone, `c` across it. For a limb hanging down
 * +c is the front; heads, necks and torsos are set up so +c is the front too,
 * and feet so +c is the top.
 */
import { hexToUnitRgb } from "../color";
import {
  BLEND_SIZE,
  COIN_DEPTH,
  COIN_R,
  COIN_TOP,
  COIN_X,
  J_BACK_ANKLE,
  J_BACK_ELBOW,
  J_BACK_HAND,
  J_BACK_KNEE,
  J_BACK_TOE,
  J_BACK_WRIST,
  J_FRONT_ANKLE,
  J_FRONT_ELBOW,
  J_FRONT_HAND,
  J_FRONT_KNEE,
  J_FRONT_TOE,
  J_FRONT_WRIST,
  J_HEAD,
  J_HIP,
  J_NECK,
  J_SHOULDER,
  JOINT_COUNT,
  POSE_HIGH_FIVE,
  POSE_LAPTOP,
  POSE_POINT,
  POSE_CHEER,
  POSE_SIT,
  POSE_WAVE,
  poseWeight,
  solveRig,
} from "./memphis-figures";
import { fillStrip, MAX_SIDE, type Mesh, strip } from "./memphis-mesh";
import {
  ACC_BEANIE,
  ACC_GLASSES,
  ACC_HEADPHONES,
  BOTTOM_JEANS,
  BOTTOM_SKIRT,
  BOTTOM_WIDE,
  C_ACCENT,
  C_BOTTOM,
  C_CARD,
  C_COIN,
  C_COIN_EDGE,
  C_INK,
  C_LAPTOP,
  C_SHOE,
  C_TOP,
  type Figure,
  figurePose,
  HAIR_AFRO,
  HAIR_BOB,
  HAIR_BUN,
  HAIR_BUZZ,
  HAIR_COLORS,
  HAIR_LONG,
  HAIR_PONYTAIL,
  HAIR_RECEDING,
  type Layout,
  ROLE_COUNT,
  type Scene,
  SHOE_BOOTS,
  SHOE_FLATS,
  SKIN_TONES,
  TOP_DRESS,
  TOP_JACKET,
  TOP_JUMPER,
  TOP_SHIRT,
} from "./memphis-sim";

/** What a part is, for tests: a person or prop, or the high five's arm. */
export const TAG_ITEM = 1;
export const TAG_HIGH_FIVE = 2;

// ---------------------------------------------------------------------------
// Colours: the palette's roles, then skin tones, then hair colours.

const C_SKIN = ROLE_COUNT;
const C_HAIR = ROLE_COUNT + SKIN_TONES.length;
const TABLE_SIZE = C_HAIR + HAIR_COLORS.length;
const table = new Float32Array(TABLE_SIZE * 3);
[...SKIN_TONES, ...HAIR_COLORS].forEach((hex, i) => {
  table.set(hexToUnitRgb(hex), 3 * (C_SKIN + i));
});

/** Shades: the far arm and leg, folds and shadows, the ear, and lighter cuffs. */
const FAR = 0.84;
const FOLD = 0.8;
const EAR = 0.9;
const LIGHT = 1.22;

// ---------------------------------------------------------------------------
// Bones and outlines

interface Frame {
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
}

const newFrame = (): Frame => ({ ox: 0, oy: 0, ux: 0, uy: 1, vx: 1, vy: 0 });

/**
 * Sets `fr` to start at (ox, oy) and run along (dx, dy), figure units. `flip`
 * picks which side is +c: +1 puts it a quarter turn anticlockwise from the bone.
 */
function setFrame(fr: Frame, ox: number, oy: number, dx: number, dy: number, flip: number) {
  const len = Math.hypot(dx, dy);
  fr.ox = ox;
  fr.oy = oy;
  fr.ux = len > 0 ? dx / len : 0;
  fr.uy = len > 0 ? dy / len : -1;
  fr.vx = -flip * fr.uy;
  fr.vy = flip * fr.ux;
}

/** The point (a, c) of frame `fr`, figure units. */
const fxAt = (fr: Frame, a: number, c: number) => fr.ox + fr.ux * a + fr.vx * c;
const fyAt = (fr: Frame, a: number, c: number) => fr.oy + fr.uy * a + fr.vy * c;

/** `fr` turned `angle` radians from its bone towards +c, moved to its point (a, c). */
function subFrame(out: Frame, fr: Frame, a: number, c: number, angle: number): Frame {
  const k = Math.cos(angle);
  const s = Math.sin(angle);
  out.ox = fxAt(fr, a, c);
  out.oy = fyAt(fr, a, c);
  out.ux = fr.ux * k + fr.vx * s;
  out.uy = fr.uy * k + fr.vy * s;
  out.vx = fr.vx * k - fr.ux * s;
  out.vy = fr.vy * k - fr.uy * s;
  return out;
}

/** Figure space to reference px for the person being drawn. */
let px0 = 0;
let py0 = 0;
let pScale = 1;
let pFace = 1;
const X = (lx: number) => px0 + pFace * pScale * lx;
const Y = (ly: number) => py0 - pScale * ly;

/** Points per rounded end, and per span between knots. */
const CAP = 5;
const SUB = 4;

function addPoint(fr: Frame, a: number, lo: number, hi: number): void {
  const i = strip.n;
  if (i >= MAX_SIDE) {
    return;
  }
  strip.lx[i] = X(fxAt(fr, a, lo));
  strip.ly[i] = Y(fyAt(fr, a, lo));
  strip.hx[i] = X(fxAt(fr, a, hi));
  strip.hy[i] = Y(fyAt(fr, a, hi));
  strip.n = i + 1;
}

/** The slope of side `side` (1 lo, 2 hi) at knot `i`, from its neighbours. */
function slope(k: readonly number[], i: number, side: number, count: number): number {
  const p = Math.max(0, i - 1);
  const q = Math.min(count - 1, i + 1);
  const da = k[3 * q] - k[3 * p];
  return da > 0 ? (k[3 * q + side] - k[3 * p + side]) / da : 0;
}

/**
 * A part's outline into the strip: knots `k` as (a, lo, hi) triples along the
 * bone (lo the back or underside, negative; hi the front), smooth between, with
 * elliptical ends `r0` before the first knot and `r1` after the last (0 for a
 * straight cut). `sa` scales the knots' a (a limb's length, so knots can be
 * fractions of it); `sc` scales lo and hi (a person's build).
 */
function outline(fr: Frame, k: readonly number[], r0: number, r1: number, sa = 1, sc = 1): void {
  strip.n = 0;
  const count = k.length / 3;
  const last = 3 * (count - 1);
  if (r0 > 0) {
    const m = 0.5 * (k[1] + k[2]) * sc;
    const h = 0.5 * (k[2] - k[1]) * sc;
    for (let j = 0; j < CAP; j++) {
      const phi = (Math.PI / 2) * (1 - j / CAP);
      const f = Math.cos(phi);
      addPoint(fr, k[0] * sa - r0 * Math.sin(phi), m - h * f, m + h * f);
    }
  }
  for (let i = 0; i < count - 1; i++) {
    const a0 = k[3 * i] * sa;
    const a1 = k[3 * i + 3] * sa;
    const da = a1 - a0;
    const mlo0 = slope(k, i, 1, count) / sa;
    const mlo1 = slope(k, i + 1, 1, count) / sa;
    const mhi0 = slope(k, i, 2, count) / sa;
    const mhi1 = slope(k, i + 1, 2, count) / sa;
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB;
      const t2 = t * t;
      const t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      const lo = h00 * k[3 * i + 1] + h10 * da * mlo0 + h01 * k[3 * i + 4] + h11 * da * mlo1;
      const hi = h00 * k[3 * i + 2] + h10 * da * mhi0 + h01 * k[3 * i + 5] + h11 * da * mhi1;
      addPoint(fr, a0 + da * t, lo * sc, hi * sc);
    }
  }
  addPoint(fr, k[last] * sa, k[last + 1] * sc, k[last + 2] * sc);
  if (r1 > 0) {
    const m = 0.5 * (k[last + 1] + k[last + 2]) * sc;
    const h = 0.5 * (k[last + 2] - k[last + 1]) * sc;
    for (let j = 1; j <= CAP; j++) {
      const phi = ((Math.PI / 2) * j) / CAP;
      const f = Math.cos(phi);
      addPoint(fr, k[last] * sa + r1 * Math.sin(phi), m - h * f, m + h * f);
    }
  }
}

const ellipseKnots = [0, 0, 0];

/** An ellipse at (a, c) of `fr`, `ra` along the bone and `rc` across. */
function ellipse(fr: Frame, a: number, c: number, ra: number, rc: number): void {
  ellipseKnots[0] = a;
  ellipseKnots[1] = c - rc;
  ellipseKnots[2] = c + rc;
  outline(fr, ellipseKnots, ra, ra);
}

// ---------------------------------------------------------------------------
// Painting

const rgb = new Float32Array(3);
let mesh: Mesh;
let alpha = 1;
let tag = TAG_ITEM;

/** Fills the strip in table colour `color`, shaded by `shade` (below 1 darker, above lighter). */
function paint(color: number, shade = 1): void {
  for (let i = 0; i < 3; i++) {
    const v = table[3 * color + i];
    rgb[i] = shade <= 1 ? v * shade : v + (1 - v) * (shade - 1);
  }
  fillStrip(mesh, rgb, 0, alpha, tag);
}

// ---------------------------------------------------------------------------
// The wardrobe: knots per part, figure units (about one unit to a person).

/** Head, about the J_HEAD joint: chin, jaw, mouth, nose, brow, forehead. */
const HEAD = [
  -0.058, -0.012, 0.028, -0.046, -0.034, 0.042, -0.03, -0.046, 0.04, -0.014, -0.052, 0.043, -0.004,
  -0.054, 0.056, 0.007, -0.056, 0.045, 0.026, -0.056, 0.045, 0.044, -0.051, 0.038,
];
const NECK = [-0.03, -0.024, 0.016, 0.05, -0.022, 0.016];
/** The shadow under the jaw, widening up the neck. */
const NECK_SHADOW = [0.0, -0.022, -0.012, 0.034, -0.022, 0.016];

const TORSO = [
  -0.035, -0.062, 0.054, 0.03, -0.058, 0.05, 0.09, -0.054, 0.05, 0.16, -0.058, 0.064, 0.215, -0.06,
  0.058, 0.25, -0.052, 0.042,
];
/** A tucked shirt starts at the waistband. */
const TORSO_TUCKED = [
  0.03, -0.058, 0.05, 0.09, -0.055, 0.051, 0.16, -0.058, 0.064, 0.215, -0.06, 0.058, 0.25, -0.052,
  0.042,
];
/** A jacket hangs lower and stays open at the front. */
const JACKET = [
  -0.06, -0.066, 0.03, 0.03, -0.062, 0.03, 0.09, -0.058, 0.032, 0.16, -0.062, 0.045, 0.215, -0.064,
  0.05, 0.25, -0.056, 0.04,
];
const JACKET_LAPEL = [0.1, 0.02, 0.032, 0.16, 0.03, 0.045, 0.235, 0.026, 0.05];
const JUMPER_HEM = [-0.035, -0.062, 0.054, -0.012, -0.061, 0.053];
const BELT = [0.025, -0.059, 0.05, 0.045, -0.058, 0.05];
const COLLAR = [0.225, 0.004, 0.05, 0.262, 0.0, 0.03];
const PELVIS = [-0.075, -0.064, 0.056, 0.06, -0.058, 0.05];

/** Legs, as fractions of the bone: thigh and shin, in trousers or bare. */
const THIGH_TROUSERS = [0, -0.058, 0.05, 0.5, -0.05, 0.046, 1, -0.038, 0.036];
const THIGH_BARE = [0, -0.052, 0.046, 0.5, -0.043, 0.04, 1, -0.03, 0.029];
const SHIN_SLIM = [0, -0.036, 0.035, 0.4, -0.036, 0.031, 1.02, -0.028, 0.028];
const SHIN_WIDE = [0, -0.042, 0.04, 0.5, -0.046, 0.044, 1.02, -0.054, 0.052];
const SHIN_JEANS = [0, -0.036, 0.035, 0.4, -0.036, 0.032, 0.84, -0.032, 0.031];
const JEANS_CUFF = [0.76, -0.035, 0.034, 0.86, -0.035, 0.034];
const SHIN_BARE = [0, -0.03, 0.029, 0.3, -0.035, 0.027, 0.95, -0.017, 0.017];
/** A skirt panel over each thigh; together they make an A-line. */
const SKIRT = [0, -0.07, 0.066, 0.95, -0.074, 0.072];
const SKIRT_PLEAT = [0.35, -0.004, 0.004, 0.95, -0.012, 0.02];

/** Shoes along the foot, ankle to toe (absolute), top +c. */
const TRAINER = [-0.03, -0.019, 0.022, 0.0, -0.02, 0.028, 0.045, -0.02, 0.018, 0.088, -0.02, 0.01];
const TRAINER_SOLE = [-0.033, -0.023, -0.011, 0.094, -0.023, -0.011];
const BOOT = [-0.03, -0.02, 0.03, 0.0, -0.02, 0.035, 0.05, -0.02, 0.02, 0.088, -0.02, 0.011];
const BOOT_SHAFT = [0.68, -0.036, 0.034, 1.0, -0.036, 0.034];
const BOOT_SOLE = [-0.033, -0.023, -0.013, 0.094, -0.023, -0.013];
const FOOT_BARE = [-0.024, -0.017, 0.02, 0.03, -0.017, 0.013, 0.08, -0.017, 0.007];
const FLAT = [-0.027, -0.019, 0.008, 0.0, -0.019, 0.01, 0.05, -0.019, 0.008, 0.086, -0.019, 0.006];

/** Arms, as fractions of the bone. */
const UPPER_ARM_SKIN = [0, -0.023, 0.023, 1, -0.019, 0.019];
const FOREARM_SKIN = [0, -0.019, 0.019, 0.45, -0.02, 0.018, 1, -0.014, 0.014];
const SHORT_SLEEVE = [0, -0.033, 0.033, 0.42, -0.03, 0.03];
const LONG_SLEEVE = [0, -0.031, 0.031, 1, -0.027, 0.027];
const LONG_SLEEVE_FORE = [0, -0.026, 0.026, 0.9, -0.022, 0.022];
const CUFF = [0.84, -0.023, 0.023, 0.94, -0.023, 0.023];
const ROLLED = [0, -0.027, 0.027, 0.24, -0.026, 0.026];
/** The fold inside the elbow of a long sleeve. */
const ELBOW_FOLD = [0.7, 0.012, 0.024, 1, 0.012, 0.022];

/** Hands from the wrist (absolute), thumb side +c. */
const PALM_OPEN = [0, -0.016, 0.015, 0.035, -0.02, 0.018, 0.06, -0.016, 0.013];
const PALM_RELAXED = [0, -0.016, 0.015, 0.03, -0.019, 0.017, 0.05, -0.015, 0.012];
const FIST = [0, -0.017, 0.017, 0.028, -0.021, 0.021];
const THUMB = [0, -0.0075, 0.0075, 0.026, -0.0065, 0.0065];
const FINGER = [0, -0.007, 0.007, 0.04, -0.006, 0.006];

/** Hair, about the head: a back layer behind the head and a front layer over it. */
const CROP = [
  -0.03, -0.062, -0.042, -0.01, -0.064, -0.02, 0.015, -0.064, 0.022, 0.038, -0.06, 0.046,
];
const BUZZ = [-0.024, -0.06, -0.044, 0.01, -0.06, 0.0, 0.036, -0.056, 0.036];
const RECEDING = [-0.03, -0.062, -0.04, 0.0, -0.063, -0.02, 0.022, -0.06, -0.028];
const LONG_BACK = [-0.17, -0.076, -0.024, -0.05, -0.074, -0.012, 0.01, -0.07, 0.0];
const LONG_FRONT = [
  -0.065, -0.066, -0.008, -0.02, -0.067, 0.0, 0.015, -0.066, 0.026, 0.04, -0.06, 0.047,
];
const LONG_STRAND = [-0.15, -0.07, -0.05, -0.02, -0.066, -0.036];
const BOB = [
  -0.072, -0.076, 0.002, -0.03, -0.075, 0.008, 0.0, -0.072, 0.014, 0.014, -0.07, 0.05, 0.04, -0.062,
  0.05,
];
const BOB_STRAND = [-0.066, -0.066, -0.046, 0.0, -0.064, -0.03];
const PONYTAIL = [0, -0.013, 0.013, 0.045, -0.02, 0.018, 0.11, -0.011, 0.007];
/** The afro's curls: a, c, radius. */
const AFRO = [
  0.038, -0.032, 0.056, 0.06, 0.008, 0.044, 0.018, -0.074, 0.044, -0.018, -0.072, 0.04, 0.062,
  -0.06, 0.04, 0.042, 0.032, 0.032, -0.04, -0.06, 0.03,
];

const BEANIE = [0.012, -0.068, 0.05, 0.04, -0.066, 0.048];
const BEANIE_CUFF = [0.006, -0.07, 0.052, 0.03, -0.069, 0.051];
const LENS = [-0.007, 0.04, 0.051, 0.016, 0.04, 0.051];
const GLASSES_ARM = [0, -0.0025, 0.0025, 0.056, -0.0025, 0.0025];
const HEADBAND = [0.0, -0.017, -0.009, 0.07, -0.021, -0.013];

/** Head and hair are drawn this much larger than their knots. */
const HEAD_SCALE = 1.12;

/** The laptop, figure units about the front hand. */
const LAPTOP_BASE = [-0.115, 0.012, 0.03, 0.05, 0.012, 0.03];
const LAPTOP_LID = [0, -0.014, 0.03, 0.14, -0.014, 0.03];
/** The lid leans this far back from upright, radians. */
const LID_TILT = 0.28;

// ---------------------------------------------------------------------------
// One person

const pose = new Float64Array(BLEND_SIZE);
const joints = new Float64Array(2 * JOINT_COUNT);
const fr = newFrame();
const sub = newFrame();
const head = newFrame();
const torso = newFrame();

const jx = (j: number) => joints[2 * j];
const jy = (j: number) => joints[2 * j + 1];

/** `fr` along the bone from joint `a` to joint `b`; returns the bone's length. */
function bone(out: Frame, a: number, b: number, flip = 1): number {
  const dx = jx(b) - jx(a);
  const dy = jy(b) - jy(a);
  setFrame(out, jx(a), jy(a), dx, dy, flip);
  return Math.hypot(dx, dy);
}

const HAND_OPEN = 0;
const HAND_RELAXED = 1;
const HAND_FIST = 2;
const HAND_POINT = 3;

/** The hand shape pose `p` gives the front or back hand. */
function handFor(p: number, front: boolean): number {
  if (p === POSE_CHEER) {
    return HAND_FIST;
  }
  if (!front) {
    return HAND_RELAXED;
  }
  if (p === POSE_POINT) {
    return HAND_POINT;
  }
  return p === POSE_WAVE || p === POSE_HIGH_FIVE || p === POSE_LAPTOP ? HAND_OPEN : HAND_RELAXED;
}

function drawHand(wrist: number, handJoint: number, shape: number, skin: number, shade: number) {
  bone(fr, wrist, handJoint);
  if (shape === HAND_FIST || shape === HAND_POINT) {
    outline(fr, FIST, 0, 0.02);
    paint(skin, shade);
    if (shape === HAND_POINT) {
      outline(subFrame(sub, fr, 0.03, 0.008, 0), FINGER, 0.006, 0.006);
      paint(skin, shade);
    }
    outline(subFrame(sub, fr, 0.012, 0.014, 0.9), THUMB, 0.007, 0.006);
    paint(skin, shade * 0.95);
    return;
  }
  const open = shape === HAND_OPEN;
  outline(fr, open ? PALM_OPEN : PALM_RELAXED, 0, open ? 0.014 : 0.012);
  paint(skin, shade);
  outline(subFrame(sub, fr, 0.012, 0.012, open ? 0.6 : 0.25), THUMB, 0.007, 0.006);
  paint(skin, shade * 0.95);
}

function drawArm(f: Figure, front: boolean, handShape: number): void {
  const elbow = front ? J_FRONT_ELBOW : J_BACK_ELBOW;
  const wrist = front ? J_FRONT_WRIST : J_BACK_WRIST;
  const hand = front ? J_FRONT_HAND : J_BACK_HAND;
  const shade = front ? 1 : FAR;
  const skin = C_SKIN + f.skin;
  const top = C_TOP + f.topColor;
  const upper = bone(fr, J_SHOULDER, elbow);
  outline(fr, UPPER_ARM_SKIN, 0.023, 0.019, upper);
  paint(skin, shade);
  const fore = bone(sub, elbow, wrist);
  outline(sub, FOREARM_SKIN, 0.019, 0.012, fore);
  paint(skin, shade);
  drawHand(wrist, hand, handShape, skin, shade);

  const long = f.top === TOP_JUMPER || f.top === TOP_JACKET || f.top === TOP_SHIRT;
  if (!long) {
    bone(fr, J_SHOULDER, elbow);
    outline(fr, SHORT_SLEEVE, 0.033, 0, upper);
    paint(top, shade);
    return;
  }
  // Long sleeves: the forearm first so the upper sleeve's elbow covers its top.
  bone(sub, elbow, wrist);
  if (f.top === TOP_SHIRT) {
    outline(sub, ROLLED, 0.027, 0, fore);
    paint(top, shade * FOLD);
  } else {
    outline(sub, LONG_SLEEVE_FORE, 0.026, 0, fore);
    paint(top, shade);
    if (f.top === TOP_JUMPER) {
      outline(sub, CUFF, 0, 0, fore);
      paint(top, shade * FOLD);
    }
  }
  bone(fr, J_SHOULDER, elbow);
  outline(fr, LONG_SLEEVE, 0.031, 0.027, upper);
  paint(top, shade);
  outline(fr, ELBOW_FOLD, 0, 0.008, upper);
  paint(top, shade * FOLD);
}

function drawLeg(f: Figure, front: boolean): void {
  const knee = front ? J_FRONT_KNEE : J_BACK_KNEE;
  const ankle = front ? J_FRONT_ANKLE : J_BACK_ANKLE;
  const toe = front ? J_FRONT_TOE : J_BACK_TOE;
  const shade = front ? 1 : FAR;
  const skin = C_SKIN + f.skin;
  const cloth = C_BOTTOM + f.bottomColor;
  const bare = f.top === TOP_DRESS || f.bottom === BOTTOM_SKIRT;
  const shoe = C_SHOE + f.shoeColor;

  const thigh = bone(fr, J_HIP, knee);
  const shin = bone(sub, knee, ankle);
  if (bare || f.bottom === BOTTOM_JEANS || f.shoe === SHOE_FLATS) {
    outline(sub, SHIN_BARE, 0.028, 0.012, shin);
    paint(skin, shade);
  }
  if (f.shoe === SHOE_FLATS) {
    bone(fr, ankle, toe);
    outline(fr, FOOT_BARE, 0.01, 0.012);
    paint(skin, shade);
  }
  if (bare) {
    bone(fr, J_HIP, knee);
    outline(fr, THIGH_BARE, 0.03, 0.03, thigh);
    paint(skin, shade);
  } else {
    bone(sub, knee, ankle);
    const knots =
      f.bottom === BOTTOM_WIDE ? SHIN_WIDE : f.bottom === BOTTOM_JEANS ? SHIN_JEANS : SHIN_SLIM;
    outline(sub, knots, 0.03, 0, shin);
    paint(cloth, shade);
    if (f.bottom === BOTTOM_JEANS) {
      outline(sub, JEANS_CUFF, 0, 0, shin);
      paint(cloth, shade * LIGHT);
    }
    bone(fr, J_HIP, knee);
    outline(fr, THIGH_TROUSERS, 0.04, 0.034, thigh);
    paint(cloth, shade);
  }

  // Shoes.
  if (f.shoe === SHOE_BOOTS) {
    bone(sub, knee, ankle);
    outline(sub, BOOT_SHAFT, 0, 0, shin);
    paint(shoe, shade);
  }
  bone(fr, ankle, toe);
  if (f.shoe === SHOE_BOOTS) {
    outline(fr, BOOT, 0.01, 0.016);
    paint(shoe, shade);
    outline(fr, BOOT_SOLE, 0.005, 0.01);
    paint(C_INK, shade);
  } else if (f.shoe === SHOE_FLATS) {
    outline(fr, FLAT, 0.008, 0.012);
    paint(shoe, shade);
  } else {
    outline(fr, TRAINER, 0.012, 0.018);
    paint(shoe, shade);
    outline(fr, TRAINER_SOLE, 0.006, 0.012);
    paint(C_CARD, shade);
  }
}

/** Skirt panels over both thighs, back first (a dress's in its top colour). */
function drawSkirt(f: Figure): void {
  const color = f.top === TOP_DRESS ? C_TOP + f.topColor : C_BOTTOM + f.bottomColor;
  outline(torso, PELVIS, 0.035, 0, 1, f.build);
  paint(color);
  for (const knee of [J_BACK_KNEE, J_FRONT_KNEE]) {
    const thigh = bone(fr, J_HIP, knee);
    outline(fr, SKIRT, 0.05, 0.012, thigh);
    paint(color);
  }
  const thigh = bone(fr, J_HIP, J_FRONT_KNEE);
  outline(fr, SKIRT_PLEAT, 0, 0, thigh);
  paint(color, FOLD);
}

function drawTorso(f: Figure): void {
  const top = C_TOP + f.topColor;
  const w = f.build;
  if (f.top === TOP_JACKET) {
    // The tee underneath, then the open jacket over it.
    outline(torso, TORSO, 0, 0.03, 1, w);
    paint(C_CARD);
    outline(torso, JACKET, 0, 0.03, 1, w);
    paint(top);
    outline(torso, JACKET_LAPEL, 0, 0.01, 1, w);
    paint(top, FOLD);
    return;
  }
  outline(torso, f.top === TOP_SHIRT ? TORSO_TUCKED : TORSO, 0, 0.03, 1, w);
  paint(top);
  if (f.top === TOP_JUMPER) {
    outline(torso, JUMPER_HEM, 0, 0, 1, w);
    paint(top, FOLD);
  } else if (f.top === TOP_SHIRT) {
    outline(torso, BELT, 0, 0, 1, w);
    paint(C_INK);
    outline(torso, COLLAR, 0.006, 0.006, 1, w);
    paint(top, LIGHT);
  }
}

function drawHairBack(f: Figure): void {
  const hair = C_HAIR + f.hairColor;
  switch (f.hair) {
    case HAIR_LONG:
      outline(head, LONG_BACK, 0, 0.05);
      paint(hair);
      outline(head, LONG_STRAND, 0, 0.01);
      paint(hair, FOLD);
      break;
    case HAIR_AFRO:
      for (let i = 0; i < AFRO.length; i += 3) {
        ellipse(head, AFRO[i], AFRO[i + 1], AFRO[i + 2], AFRO[i + 2]);
        paint(hair);
      }
      break;
    case HAIR_PONYTAIL:
      // Swing the tail down behind the head.
      outline(subFrame(sub, head, 0.024, -0.062, -2.3), PONYTAIL, 0.012, 0.007);
      paint(hair);
      break;
    case HAIR_BUN:
      ellipse(head, 0.06, -0.046, 0.03, 0.03);
      paint(hair);
      break;
    default:
  }
}

function drawHairFront(f: Figure): void {
  const hair = C_HAIR + f.hairColor;
  switch (f.hair) {
    case HAIR_BUZZ:
      outline(head, BUZZ, 0.006, 0.034);
      paint(hair, LIGHT);
      break;
    case HAIR_RECEDING:
      outline(head, RECEDING, 0.008, 0.012);
      paint(hair);
      break;
    case HAIR_LONG:
      outline(head, LONG_FRONT, 0, 0.036);
      paint(hair);
      break;
    case HAIR_BOB:
      outline(head, BOB, 0, 0.036);
      paint(hair);
      outline(head, BOB_STRAND, 0, 0.012);
      paint(hair, FOLD);
      break;
    default:
      // Crop, and the front of the ponytail, bun and afro.
      outline(head, CROP, 0.008, 0.036);
      paint(hair);
  }
}

function drawAccessory(f: Figure): void {
  switch (f.accessory) {
    case ACC_GLASSES:
      outline(head, LENS, 0.004, 0.004);
      paint(C_INK);
      outline(subFrame(sub, head, 0.012, 0.045, -Math.PI / 2), GLASSES_ARM, 0.002, 0.002);
      paint(C_INK);
      break;
    case ACC_BEANIE:
      outline(head, BEANIE, 0, 0.04);
      paint(C_TOP + f.accessoryColor);
      outline(head, BEANIE_CUFF, 0, 0);
      paint(C_TOP + f.accessoryColor, FOLD);
      break;
    case ACC_HEADPHONES:
      outline(head, HEADBAND, 0, 0.006);
      paint(C_INK);
      ellipse(head, -0.006, -0.013, 0.021, 0.014);
      paint(C_ACCENT);
      break;
    default:
  }
}

function drawHead(f: Figure): void {
  const skin = C_SKIN + f.skin;
  bone(fr, J_NECK, J_HEAD, -1);
  outline(fr, NECK, 0, 0.01);
  paint(skin);
  outline(fr, NECK_SHADOW, 0, 0);
  paint(skin, FOLD);
  outline(head, HEAD, 0.01, 0.028);
  paint(skin);
  const covered = f.hair === HAIR_LONG || f.hair === HAIR_BOB || f.accessory === ACC_HEADPHONES;
  if (!covered) {
    ellipse(head, -0.008, -0.014, 0.016, 0.011);
    paint(skin, EAR);
  }
  drawHairFront(f);
  drawAccessory(f);
}

const COIN_SIDE = [0, 0, 0, 0, 0, 0];

function drawCoin(): void {
  setFrame(fr, COIN_X, COIN_DEPTH, 1, 0, 1);
  const yTop = COIN_TOP - COIN_DEPTH * 0.35;
  ellipse(fr, 0, 0, COIN_R, COIN_DEPTH);
  paint(C_COIN_EDGE);
  setFrame(fr, COIN_X, 0, 1, 0, 1);
  COIN_SIDE[0] = -COIN_R;
  COIN_SIDE[1] = COIN_DEPTH;
  COIN_SIDE[2] = yTop;
  COIN_SIDE[3] = COIN_R;
  COIN_SIDE[4] = COIN_DEPTH;
  COIN_SIDE[5] = yTop;
  outline(fr, COIN_SIDE, 0, 0);
  paint(C_COIN_EDGE);
  setFrame(fr, COIN_X, yTop, 1, 0, 1);
  ellipse(fr, 0, 0, COIN_R, COIN_DEPTH);
  paint(C_COIN);
  ellipse(fr, 0, 0, COIN_R * 0.68, COIN_DEPTH * 0.68);
  paint(C_COIN_EDGE);
}

/** An open laptop resting on the front hand, its lid leaning back from the far end. */
function drawLaptop(): void {
  const hx = jx(J_FRONT_HAND);
  const hy = jy(J_FRONT_HAND);
  setFrame(fr, hx, hy, 1, 0, 1);
  outline(fr, LAPTOP_BASE, 0, 0);
  paint(C_LAPTOP, FOLD);
  const hingeX = hx + LAPTOP_BASE[3] - 0.014;
  const hingeY = hy + LAPTOP_BASE[5];
  setFrame(fr, hingeX, hingeY, Math.sin(LID_TILT), Math.cos(LID_TILT), -1);
  outline(fr, LAPTOP_LID, 0, 0);
  paint(C_LAPTOP);
  ellipse(fr, 0.068, 0.009, 0.012, 0.009);
  paint(C_CARD);
}

/** Draws person `index` (and the coin or laptop their pose brings) into `out`. */
export function emitPerson(
  out: Mesh,
  scene: Scene,
  layout: Layout,
  index: number,
  opacity: number,
): void {
  mesh = out;
  const f = scene.figures[index];
  const s = layout.figures[index];
  px0 = s.x;
  py0 = s.ground;
  pScale = s.size;
  pFace = s.facing;
  tag = TAG_ITEM;
  solveRig(figurePose(scene, layout, index, pose), joints);
  const shown = poseWeight(f.to, f.from, f.to, f.t) >= 0.5 ? f.to : f.from;

  const sit = poseWeight(POSE_SIT, f.from, f.to, f.t);
  if (sit > 0) {
    alpha = opacity * sit;
    drawCoin();
  }
  alpha = opacity;
  setFrame(torso, jx(J_HIP), jy(J_HIP), jx(J_NECK) - jx(J_HIP), jy(J_NECK) - jy(J_HIP), -1);
  setFrame(head, jx(J_HEAD), jy(J_HEAD), jx(J_HEAD) - jx(J_NECK), jy(J_HEAD) - jy(J_NECK), -1);
  head.ux *= HEAD_SCALE;
  head.uy *= HEAD_SCALE;
  head.vx *= HEAD_SCALE;
  head.vy *= HEAD_SCALE;

  drawHairBack(f);
  drawArm(f, false, handFor(shown, false));
  drawLeg(f, false);
  drawLeg(f, true);
  if (f.top === TOP_DRESS || f.bottom === BOTTOM_SKIRT) {
    drawSkirt(f);
  } else {
    outline(torso, PELVIS, 0.035, 0, 1, f.build);
    paint(C_BOTTOM + f.bottomColor);
  }
  drawTorso(f);
  drawHead(f);

  if (f.from === POSE_HIGH_FIVE || f.to === POSE_HIGH_FIVE) {
    tag = TAG_HIGH_FIVE;
  }
  drawArm(f, true, handFor(shown, true));
  tag = TAG_ITEM;
  // The laptop rests on the front palm.
  const laptop = poseWeight(POSE_LAPTOP, f.from, f.to, f.t);
  if (laptop > 0) {
    alpha = opacity * laptop;
    drawLaptop();
  }
}

/** Copies this frame's palette (unit RGB per role) into the colour table. */
export function setPeoplePalette(palette: Float32Array): void {
  table.set(palette.subarray(0, ROLE_COUNT * 3));
}
