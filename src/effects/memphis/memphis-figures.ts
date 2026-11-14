/**
 * Corporate Memphis people as 2D rigs: a hip, a torso, a tiny head, two arms and
 * two legs of two segments each, oversized hands and feet. A pose is a set of
 * joint angles (plus where the hip sits), so every pose shares one skeleton and
 * a tween between two poses is a plain blend of numbers.
 *
 * Figure space: the figure is about one unit tall, x points the way it faces,
 * y points up, and the ground is y = 0.
 */
import { smoothstep } from "../math";

// ---------------------------------------------------------------------------
// The skeleton

export const THIGH = 0.25;
export const SHIN = 0.24;
export const FOOT = 0.085;
export const TORSO = 0.27;
/** How far the shoulders sit below the neck, along the torso. */
export const SHOULDER_DROP = 0.025;
/** Neck to the head's centre. */
export const NECK_TO_HEAD = 0.075;
export const UPPER_ARM = 0.2;
export const FOREARM = 0.19;
/** The hand's centre sits this far past the wrist, along the forearm. */
export const HAND_OFFSET = 0.025;

/** Shape radii: tiny head, big hands and feet, arms and legs tapering. */
export const HEAD_R = 0.05;
export const HAND_R = 0.042;
export const FOOT_R = 0.028;
export const ARM_R = [0.026, 0.021, 0.017] as const;
export const LEG_R = [0.054, 0.04, 0.028] as const;
/** The torso as a soft trapezoid: half widths at the hip and at the shoulders. */
export const TORSO_HIP_R = 0.062;
export const TORSO_SHOULDER_R = 0.08;
export const TORSO_CORNER = 0.03;

/** Hip height when standing. */
const STAND_HIP = 0.51;

/** The giant coin a figure sits on: centre x, radius, side height and top's half depth. */
export const COIN_X = 0.03;
export const COIN_R = 0.26;
export const COIN_TOP = 0.13;
export const COIN_DEPTH = 0.06;

/** The laptop a figure holds up: its centre above the front hand, and half sizes. */
export const LAPTOP_RISE = 0.085;
export const LAPTOP_HALF_W = 0.11;
export const LAPTOP_HALF_H = 0.075;

/**
 * Bounds on everything a figure draws, in figure units from its root (props it
 * holds or sits on included): how far forward or back of the hip it can reach,
 * and how high. Layouts keep these clear of the speaker; tests check every pose
 * and tween stays inside them.
 */
export const REACH = 0.5;
export const UP_REACH = 1.25;

// ---------------------------------------------------------------------------
// Poses

/** Pose fields: where the hip sits, then joint angles in radians. */
const ROOT_X = 0;
export const ROOT_Y = 1;
/** The torso's lean from upright, forward positive. */
export const LEAN = 2;
/** The head's tilt from the torso's line, forward positive. */
export const NOD = 3;
/**
 * Limb angles: 0 points straight down, +π/2 forward, π up. Shoulders are
 * relative to the torso, elbows and knees to the segment above, hips absolute.
 */
const BACK_SHOULDER = 4;
export const BACK_ELBOW = 5;
const FRONT_SHOULDER = 6;
export const FRONT_ELBOW = 7;
const BACK_HIP = 8;
const BACK_KNEE = 9;
const FRONT_HIP = 10;
const FRONT_KNEE = 11;
/** Feet, relative to the shin: π/2 points the foot forward off a straight shin. */
const BACK_ANKLE = 12;
const FRONT_ANKLE = 13;
/** A blended pose adds the front arm's stretch: upper arm and forearm length factors. */
export const STRETCH_UPPER = 14;
export const STRETCH_FORE = 15;
export const POSE_SIZE = 14;
export const BLEND_SIZE = 16;

/** Poses by index: 0 stand, 1 wave, 2 laptop, 3 point, 4 cheer, 5 sit, 6 high five. */
export const POSE_WAVE = 1;
export const POSE_LAPTOP = 2;
export const POSE_SIT = 5;
/** Arm up and stretched across the top of the frame to meet a partner's hand. */
export const POSE_HIGH_FIVE = 6;
export const POSE_COUNT = 7;
/** Poses a figure takes on its own (all but the high five). */
export const SOLO_POSES = 6;

const HALF_PI = Math.PI / 2;

/** The pose library, `POSE_SIZE` numbers each. */
export const POSES: readonly (readonly number[])[] = [
  // Stand: arms loose, feet apart.
  [0, STAND_HIP, 0, 0, -0.22, 0.18, 0.18, 0.22, -0.13, 0.04, 0.13, -0.03, HALF_PI, HALF_PI],
  // Wave: front forearm up beside the head (the wave swings the elbow).
  [0, STAND_HIP, -0.03, -0.06, -0.18, 0.15, 2.45, 0.6, -0.12, 0.03, 0.14, -0.02, HALF_PI, HALF_PI],
  // Holding a laptop up at chest height, looking down at it.
  [0, STAND_HIP, 0.02, 0.1, 0.75, 1.25, 0.95, 1.05, -0.1, 0.03, 0.12, -0.02, HALF_PI, HALF_PI],
  // Pointing up at something floating overhead.
  [0, STAND_HIP, -0.04, -0.14, -0.25, 0.25, 2.7, 0.08, -0.13, 0.04, 0.13, -0.03, HALF_PI, HALF_PI],
  // Cheering: both arms up in a V.
  [0, STAND_HIP, 0, -0.1, -2.55, -0.25, 2.55, 0.25, -0.14, 0.04, 0.14, -0.03, HALF_PI, HALF_PI],
  // Sitting cross-legged on the coin, hands on the knees.
  [0, COIN_TOP + 0.045, 0.03, 0.06, 0.35, 0.7, 0.55, 0.55, 1.2, -2.5, 1.4, -2.75, 2.6, 2.75],
  // High five: front upper arm straight up, forearm straight forward.
  [
    0,
    STAND_HIP,
    0,
    -0.08,
    -0.2,
    0.2,
    Math.PI,
    -HALF_PI,
    -0.13,
    0.04,
    0.13,
    -0.03,
    HALF_PI,
    HALF_PI,
  ],
];

/**
 * The high five's stages, as fractions of its tween: the arm swings up at its
 * normal length first, then the upper arm grows up into the top band, then the
 * forearm grows across it. Undone in reverse. Growing only once the arm is up
 * keeps the long arm out of the speaker's area.
 */
const HF_SWING = 0.25;
const HF_UPPER_FROM = 0.25;
const HF_UPPER_TO = 0.55;
const HF_FORE_FROM = 0.5;

/**
 * The pose `t` (0..1) of the way from pose `from` to `to`, eased, into `out`
 * (`BLEND_SIZE`). `upper` and `fore` are the front arm's length factors in the
 * high five; any tween to or from it grows or shrinks the arm in stages.
 */
export function blendPose(
  from: number,
  to: number,
  t: number,
  upper: number,
  fore: number,
  out: Float64Array,
): Float64Array {
  const a = POSES[from];
  const b = POSES[to];
  const e = blendFactor(from, to, t);
  // How far into the high five, 0..1, linear in the tween.
  const hf =
    from === POSE_HIGH_FIVE ? (to === POSE_HIGH_FIVE ? 1 : 1 - t) : to === POSE_HIGH_FIVE ? t : 0;
  for (let i = 0; i < POSE_SIZE; i++) {
    // Exact at the ends, so a settled person holds the library's pose.
    out[i] = e >= 1 ? b[i] : a[i] + (b[i] - a[i]) * e;
  }
  out[STRETCH_UPPER] = 1 + (upper - 1) * smoothstep(HF_UPPER_FROM, HF_UPPER_TO, hf);
  out[STRETCH_FORE] = 1 + (fore - 1) * smoothstep(HF_FORE_FROM, 1, hf);
  return out;
}

/**
 * How far a tween `t` of the way from pose `from` to `to` has blended the
 * angles, 0..1: eased, and quicker in and out of the high five, whose arm
 * swings up before it stretches (and shrinks before it swings down).
 */
function blendFactor(from: number, to: number, t: number): number {
  if (to === POSE_HIGH_FIVE && from !== POSE_HIGH_FIVE) {
    return smoothstep(0, HF_SWING, t);
  }
  if (from === POSE_HIGH_FIVE && to !== POSE_HIGH_FIVE) {
    return 1 - smoothstep(0, HF_SWING, 1 - t);
  }
  return smoothstep(0, 1, t);
}

/**
 * How much of pose `pose` a tween `t` of the way from `from` to `to` shows, 0..1,
 * for what the pose brings with it (the coin, the laptop, the wave).
 */
export function poseWeight(pose: number, from: number, to: number, t: number): number {
  const e = blendFactor(from, to, t);
  return (from === pose ? 1 - e : 0) + (to === pose ? e : 0);
}

// ---------------------------------------------------------------------------
// Forward kinematics

/** Joints, as (x, y) pairs in `solveRig`'s output. */
export const J_HIP = 0;
export const J_NECK = 1;
export const J_SHOULDER = 2;
export const J_HEAD = 3;
export const J_BACK_ELBOW = 4;
export const J_BACK_WRIST = 5;
export const J_BACK_HAND = 6;
export const J_FRONT_ELBOW = 7;
export const J_FRONT_WRIST = 8;
export const J_FRONT_HAND = 9;
export const J_BACK_KNEE = 10;
export const J_BACK_ANKLE = 11;
export const J_BACK_TOE = 12;
export const J_FRONT_KNEE = 13;
export const J_FRONT_ANKLE = 14;
export const J_FRONT_TOE = 15;
export const JOINT_COUNT = 16;

/** The fast-moving ends: hands, toes and head. */
export const TIP_JOINTS: readonly number[] = [
  J_HEAD,
  J_BACK_HAND,
  J_FRONT_HAND,
  J_BACK_TOE,
  J_FRONT_TOE,
];

function put(out: Float64Array, j: number, x: number, y: number): void {
  out[2 * j] = x;
  out[2 * j + 1] = y;
}

/** Joint `from` plus `length` along limb angle `angle` (0 down, π/2 forward). */
function limb(out: Float64Array, j: number, from: number, length: number, angle: number): void {
  put(
    out,
    j,
    out[2 * from] + length * Math.sin(angle),
    out[2 * from + 1] - length * Math.cos(angle),
  );
}

/**
 * Every joint of a blended pose (`BLEND_SIZE`) in figure space, into `out`
 * (`2 * JOINT_COUNT`). Segment lengths are fixed, apart from the front arm's
 * stretch, so a blend between any two poses keeps the limbs attached.
 */
export function solveRig(pose: ArrayLike<number>, out: Float64Array): Float64Array {
  const lean = pose[LEAN];
  const ux = Math.sin(lean);
  const uy = Math.cos(lean);
  put(out, J_HIP, pose[ROOT_X], pose[ROOT_Y]);
  put(out, J_NECK, pose[ROOT_X] + TORSO * ux, pose[ROOT_Y] + TORSO * uy);
  put(
    out,
    J_SHOULDER,
    out[2 * J_NECK] - SHOULDER_DROP * ux,
    out[2 * J_NECK + 1] - SHOULDER_DROP * uy,
  );
  const head = lean + pose[NOD];
  put(
    out,
    J_HEAD,
    out[2 * J_NECK] + NECK_TO_HEAD * Math.sin(head),
    out[2 * J_NECK + 1] + NECK_TO_HEAD * Math.cos(head),
  );

  let upper = lean + pose[BACK_SHOULDER];
  let fore = upper + pose[BACK_ELBOW];
  limb(out, J_BACK_ELBOW, J_SHOULDER, UPPER_ARM, upper);
  limb(out, J_BACK_WRIST, J_BACK_ELBOW, FOREARM, fore);
  limb(out, J_BACK_HAND, J_BACK_WRIST, HAND_OFFSET, fore);

  upper = lean + pose[FRONT_SHOULDER];
  fore = upper + pose[FRONT_ELBOW];
  limb(out, J_FRONT_ELBOW, J_SHOULDER, UPPER_ARM * pose[STRETCH_UPPER], upper);
  limb(out, J_FRONT_WRIST, J_FRONT_ELBOW, FOREARM * pose[STRETCH_FORE], fore);
  limb(out, J_FRONT_HAND, J_FRONT_WRIST, HAND_OFFSET, fore);

  let thigh = pose[BACK_HIP];
  let shin = thigh + pose[BACK_KNEE];
  limb(out, J_BACK_KNEE, J_HIP, THIGH, thigh);
  limb(out, J_BACK_ANKLE, J_BACK_KNEE, SHIN, shin);
  limb(out, J_BACK_TOE, J_BACK_ANKLE, FOOT, shin + pose[BACK_ANKLE]);

  thigh = pose[FRONT_HIP];
  shin = thigh + pose[FRONT_KNEE];
  limb(out, J_FRONT_KNEE, J_HIP, THIGH, thigh);
  limb(out, J_FRONT_ANKLE, J_FRONT_KNEE, SHIN, shin);
  limb(out, J_FRONT_TOE, J_FRONT_ANKLE, FOOT, shin + pose[FRONT_ANKLE]);
  return out;
}
