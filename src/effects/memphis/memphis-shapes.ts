/**
 * Corporate Memphis as a list of flat shapes, back to front: blobs, plants,
 * floating props, people (with the coin and laptop their poses use) and the
 * mug. Each shape is one instance of a signed-distance sprite (capsule, ellipse,
 * soft trapezoid, ring or wobbly blob), so every pose reuses the same few
 * primitives and the picture is one draw.
 *
 * Instance layout (`STRIDE` floats, reference px, y down): end points a and b,
 * then two radii, a corner radius and the kind, then colour (straight RGB) and
 * opacity.
 */
import {
  ARM_R,
  BLEND_SIZE,
  COIN_DEPTH,
  COIN_R,
  COIN_TOP,
  COIN_X,
  FOOT_R,
  HAND_R,
  HEAD_R,
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
  LAPTOP_HALF_H,
  LAPTOP_HALF_W,
  LAPTOP_RISE,
  LEAN,
  LEG_R,
  POSE_HIGH_FIVE,
  POSE_LAPTOP,
  POSE_SIT,
  poseWeight,
  solveRig,
  TORSO_CORNER,
  TORSO_HIP_R,
  TORSO_SHOULDER_R,
} from "./memphis-figures";
import {
  BLOB_BOB,
  BOB_PERIOD,
  C_ACCENT,
  C_BLOB,
  C_BOTTOM,
  C_CARD,
  C_COIN,
  C_COIN_EDGE,
  C_HAIR,
  C_HEART,
  C_LAPTOP,
  C_LEAF,
  C_MUG,
  C_POT,
  C_SHOE,
  C_SKIN,
  C_TOP,
  figurePose,
  LEAF_PERIOD,
  LEAF_TILT,
  type Layout,
  MUG_H,
  MUG_HALF_W,
  POT_BOTTOM,
  POT_H,
  POT_TOP,
  PROP_BOB,
  PROP_BULB,
  PROP_CHART,
  PROP_HEART,
  PROP_TICK,
  type Scene,
  type Spot,
} from "./memphis-sim";

const KIND_CAPSULE = 0;
const KIND_ELLIPSE = 1;
const KIND_TRAPEZOID = 2;
const KIND_RING = 3;
const KIND_BLOB = 4;

/** Floats per shape. */
export const STRIDE = 12;
/** The most shapes a frame draws. */
export const MAX_SHAPES = 200;

/** What a shape is, for tests: background, a person or prop, or a high five's arm. */
export const TAG_BACKGROUND = 0;
const TAG_ITEM = 1;
export const TAG_HIGH_FIVE = 2;

interface ShapeList {
  data: Float32Array;
  tags: Uint8Array;
  count: number;
}

export function createShapeList(
  data: Float32Array = new Float32Array(MAX_SHAPES * STRIDE),
): ShapeList {
  return { data, tags: new Uint8Array(data.length / STRIDE), count: 0 };
}

/** Writer state for one frame: the list, the eased palette (unit RGB) and the current tag and opacity. */
interface Pen {
  list: ShapeList;
  palette: Float32Array;
  tag: number;
  alpha: number;
}

function push(
  pen: Pen,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  ra: number,
  rb: number,
  corner: number,
  kind: number,
  color: number,
): void {
  const list = pen.list;
  if (pen.alpha <= 0 || list.count * STRIDE >= list.data.length) {
    return;
  }
  const d = list.data;
  const o = list.count * STRIDE;
  d[o] = ax;
  d[o + 1] = ay;
  d[o + 2] = bx;
  d[o + 3] = by;
  d[o + 4] = ra;
  d[o + 5] = rb;
  d[o + 6] = corner;
  d[o + 7] = kind;
  d[o + 8] = pen.palette[3 * color];
  d[o + 9] = pen.palette[3 * color + 1];
  d[o + 10] = pen.palette[3 * color + 2];
  d[o + 11] = pen.alpha;
  list.tags[list.count] = pen.tag;
  list.count++;
}

const circle = (pen: Pen, x: number, y: number, r: number, color: number) => {
  push(pen, x, y, x, y, r, r, 0, KIND_CAPSULE, color);
};

/** A box from (x, y0) to (x, y1), `hw` half wide, with rounded corners. */
const box = (
  pen: Pen,
  x: number,
  y0: number,
  y1: number,
  hw: number,
  corner: number,
  color: number,
) => {
  push(pen, x, y0, x, y1, hw, hw, corner, KIND_TRAPEZOID, color);
};

// ---------------------------------------------------------------------------
// People

const pose = new Float64Array(BLEND_SIZE);
const joints = new Float64Array(2 * JOINT_COUNT);

/** Figure space to reference px for the person at `s`. */
let fx = 0;
let fy = 0;
let fs = 1;
let ff = 1;
const X = (lx: number) => fx + ff * fs * lx;
const Y = (ly: number) => fy - fs * ly;
const jx = (j: number) => X(joints[2 * j]);
const jy = (j: number) => Y(joints[2 * j + 1]);

function limbShape(pen: Pen, a: number, b: number, ra: number, rb: number, color: number): void {
  push(pen, jx(a), jy(a), jx(b), jy(b), ra * fs, rb * fs, 0, KIND_CAPSULE, color);
}

function emitFigure(pen: Pen, scene: Scene, layout: Layout, index: number, alpha: number): void {
  const f = scene.figures[index];
  const s: Spot = layout.figures[index];
  fx = s.x;
  fy = s.ground;
  fs = s.size;
  ff = s.facing;
  solveRig(figurePose(scene, layout, index, pose), joints);
  const skin = C_SKIN + f.skin;
  const top = C_TOP + f.top;
  const bottom = C_BOTTOM + f.bottom;
  const shoe = C_SHOE + f.shoe;

  // The giant coin, under a sitting person.
  const sit = poseWeight(POSE_SIT, f.from, f.to, f.t);
  if (sit > 0) {
    pen.alpha = alpha * sit;
    const yTop = COIN_TOP - COIN_DEPTH * 0.35;
    const x0 = X(COIN_X - COIN_R);
    const x1 = X(COIN_X + COIN_R);
    const r = COIN_R * fs;
    const depth = COIN_DEPTH * fs;
    push(pen, x0, Y(COIN_DEPTH), x1, Y(COIN_DEPTH), depth, depth, 0, KIND_ELLIPSE, C_COIN_EDGE);
    box(pen, X(COIN_X), Y(COIN_DEPTH), Y(yTop), r, 0, C_COIN_EDGE);
    push(pen, x0, Y(yTop), x1, Y(yTop), depth, depth, 0, KIND_ELLIPSE, C_COIN);
    const inner = 0.68;
    push(
      pen,
      X(COIN_X - COIN_R * inner),
      Y(yTop),
      X(COIN_X + COIN_R * inner),
      Y(yTop),
      depth * inner,
      depth * inner,
      0,
      KIND_ELLIPSE,
      C_COIN_EDGE,
    );
  }
  pen.alpha = alpha;

  // Far arm and legs behind the torso.
  limbShape(pen, J_SHOULDER, J_BACK_ELBOW, ARM_R[0], ARM_R[1], skin);
  limbShape(pen, J_BACK_ELBOW, J_BACK_WRIST, ARM_R[1], ARM_R[2], skin);
  circle(pen, jx(J_BACK_HAND), jy(J_BACK_HAND), HAND_R * fs, skin);
  for (let leg = 0; leg < 2; leg++) {
    const knee = leg === 0 ? J_BACK_KNEE : J_FRONT_KNEE;
    const ankle = leg === 0 ? J_BACK_ANKLE : J_FRONT_ANKLE;
    const toe = leg === 0 ? J_BACK_TOE : J_FRONT_TOE;
    limbShape(pen, J_HIP, knee, LEG_R[0], LEG_R[1], bottom);
    limbShape(pen, knee, ankle, LEG_R[1], LEG_R[2], bottom);
    limbShape(pen, ankle, toe, FOOT_R * 0.85, FOOT_R, shoe);
  }

  // A blocky torso, a touch below the hip so it covers the tops of the legs.
  const lean = pose[LEAN];
  const ux = Math.sin(lean) * 0.03;
  const uy = Math.cos(lean) * 0.03;
  push(
    pen,
    X(joints[2 * J_HIP] - ux),
    Y(joints[2 * J_HIP + 1] - uy),
    jx(J_NECK),
    jy(J_NECK),
    TORSO_HIP_R * fs,
    TORSO_SHOULDER_R * fs,
    TORSO_CORNER * fs,
    KIND_TRAPEZOID,
    top,
  );

  // Tiny head, a cap of hair, sometimes a bun.
  const hx = joints[2 * J_HEAD];
  const hy = joints[2 * J_HEAD + 1];
  circle(pen, X(hx), Y(hy), HEAD_R * fs, skin);
  circle(pen, X(hx - 0.016), Y(hy + 0.02), HEAD_R * 0.86 * fs, C_HAIR);
  if (f.bun) {
    circle(pen, X(hx - 0.04), Y(hy + 0.05), HEAD_R * 0.45 * fs, C_HAIR);
  }

  // The laptop, held up in front.
  const laptop = poseWeight(POSE_LAPTOP, f.from, f.to, f.t);
  if (laptop > 0) {
    pen.alpha = alpha * laptop;
    const cx = joints[2 * J_FRONT_HAND] - 0.02;
    const cy = joints[2 * J_FRONT_HAND + 1] + LAPTOP_RISE;
    const x = X(cx);
    box(
      pen,
      x,
      Y(cy - LAPTOP_HALF_H),
      Y(cy + LAPTOP_HALF_H),
      LAPTOP_HALF_W * fs,
      0.014 * fs,
      C_LAPTOP,
    );
    box(
      pen,
      x,
      Y(cy - LAPTOP_HALF_H + 0.02),
      Y(cy + LAPTOP_HALF_H - 0.02),
      (LAPTOP_HALF_W - 0.02) * fs,
      0.006 * fs,
      C_CARD,
    );
    pen.alpha = alpha;
  }

  // The near arm, in front of everything.
  if (f.from === POSE_HIGH_FIVE || f.to === POSE_HIGH_FIVE) {
    pen.tag = TAG_HIGH_FIVE;
  }
  limbShape(pen, J_SHOULDER, J_FRONT_ELBOW, ARM_R[0], ARM_R[1], skin);
  limbShape(pen, J_FRONT_ELBOW, J_FRONT_WRIST, ARM_R[1], ARM_R[2], skin);
  circle(pen, jx(J_FRONT_HAND), jy(J_FRONT_HAND), HAND_R * fs, skin);
  pen.tag = TAG_ITEM;
}

/** Back to front: the second row first, then the pair nearest the middle. */
const FIGURE_ORDER = [2, 3, 0, 1] as const;

// ---------------------------------------------------------------------------
// Plants, mug and floating props

const TAU = 2 * Math.PI;

function emitPlant(pen: Pen, scene: Scene, s: Spot, side: number): void {
  const k = s.size;
  const baseY = s.ground - (POT_H - 0.03) * k;
  const m = scene.motion;
  const c = scene.clock;
  const leaves = scene.leaves[side];
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];
    const angle =
      leaf.angle * s.facing + m * LEAF_TILT * Math.sin((TAU * c) / LEAF_PERIOD + leaf.phase);
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);
    push(
      pen,
      s.x + dx * 0.02 * k,
      baseY + dy * 0.02 * k,
      s.x + dx * leaf.length * k,
      baseY + dy * leaf.length * k,
      leaf.width * k,
      0,
      0,
      KIND_ELLIPSE,
      C_LEAF + (i & 1),
    );
  }
  push(
    pen,
    s.x,
    s.ground,
    s.x,
    s.ground - POT_H * k,
    POT_BOTTOM * k,
    POT_TOP * k,
    0.02 * k,
    KIND_TRAPEZOID,
    C_POT,
  );
}

function emitMug(pen: Pen, s: Spot): void {
  const k = s.size;
  const hw = MUG_HALF_W * k;
  const h = MUG_H * k;
  // The handle faces the frame's edge; its inner half hides behind the body.
  push(
    pen,
    s.x - s.facing * hw,
    s.ground - 0.52 * h,
    s.x - s.facing * hw,
    s.ground - 0.52 * h,
    0.27 * h,
    0.055 * h,
    0,
    KIND_RING,
    C_MUG,
  );
  push(pen, s.x, s.ground, s.x, s.ground - h, 0.9 * hw, hw, 0.12 * hw, KIND_TRAPEZOID, C_MUG);
  push(
    pen,
    s.x - 0.86 * hw,
    s.ground - h,
    s.x + 0.86 * hw,
    s.ground - h,
    0.13 * hw,
    0,
    0,
    KIND_ELLIPSE,
    C_HAIR,
  );
}

/** Chart bar heights, px at prop scale 1. */
const BARS = [34, 58, 46, 84] as const;

function emitProp(pen: Pen, kind: number, cx: number, cy: number, k: number, side: number): void {
  switch (kind) {
    case PROP_CHART: {
      box(pen, cx, cy + 75 * k, cy - 75 * k, 100 * k, 14 * k, C_CARD);
      const base = cy + 50 * k;
      let lx = 0;
      let ly = 0;
      for (let i = 0; i < BARS.length; i++) {
        const x = cx + (i - 1.5) * 38 * k;
        const top = base - BARS[i] * k;
        box(pen, x, base, top, 12 * k, 3 * k, i & 1 ? C_COIN : C_ACCENT);
        const y = top - 14 * k;
        if (i > 0) {
          push(pen, lx, ly, x, y, 3.5 * k, 3.5 * k, 0, KIND_CAPSULE, C_HEART);
        }
        lx = x;
        ly = y;
      }
      break;
    }
    case PROP_TICK:
      circle(pen, cx, cy, 58 * k, C_ACCENT);
      push(
        pen,
        cx - 26 * k,
        cy + 2 * k,
        cx - 8 * k,
        cy + 20 * k,
        8 * k,
        8 * k,
        0,
        KIND_CAPSULE,
        C_CARD,
      );
      push(
        pen,
        cx - 8 * k,
        cy + 20 * k,
        cx + 28 * k,
        cy - 18 * k,
        8 * k,
        8 * k,
        0,
        KIND_CAPSULE,
        C_CARD,
      );
      break;
    default: {
      // A speech bubble, its tail pointing down towards the people at its side.
      const t = -side;
      box(pen, cx, cy + 48 * k, cy - 48 * k, 66 * k, 28 * k, C_CARD);
      push(
        pen,
        cx + t * 22 * k,
        cy + 36 * k,
        cx + t * 44 * k,
        cy + 76 * k,
        16 * k,
        3 * k,
        0,
        KIND_CAPSULE,
        C_CARD,
      );
      if (kind === PROP_HEART) {
        circle(pen, cx - 13 * k, cy - 6 * k, 15 * k, C_HEART);
        circle(pen, cx + 13 * k, cy - 6 * k, 15 * k, C_HEART);
        push(pen, cx, cy - 4 * k, cx, cy + 26 * k, 27 * k, k, 2 * k, KIND_TRAPEZOID, C_HEART);
      } else if (kind === PROP_BULB) {
        circle(pen, cx, cy - 8 * k, 19 * k, C_COIN);
        box(pen, cx, cy + 8 * k, cy + 26 * k, 9 * k, 3 * k, C_LAPTOP);
        for (let i = -1; i <= 1; i++) {
          const a = i * 0.9;
          const sx = Math.sin(a);
          const sy = -Math.cos(a);
          push(
            pen,
            cx + sx * 27 * k,
            cy - 8 * k + sy * 27 * k,
            cx + sx * 35 * k,
            cy - 8 * k + sy * 35 * k,
            3 * k,
            3 * k,
            0,
            KIND_CAPSULE,
            C_COIN,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The frame

const pen: Pen = {
  list: createShapeList(new Float32Array(0)),
  palette: new Float32Array(0),
  tag: 0,
  alpha: 1,
};

/**
 * Fills `list` with this frame's shapes, back to front, in `palette`'s colours
 * (unit RGB per colour role). Returns the count.
 */
export function emitScene(
  list: ShapeList,
  scene: Scene,
  layout: Layout,
  palette: Float32Array,
): number {
  list.count = 0;
  pen.list = list;
  pen.palette = palette;
  const m = scene.motion;
  const c = scene.clock;
  const swap = scene.swap;

  pen.tag = TAG_BACKGROUND;
  pen.alpha = swap;
  for (let i = 0; i < layout.blobs.length; i++) {
    const b = layout.blobs[i];
    const phase = scene.blobPhases[i];
    const y = b.y + m * BLOB_BOB * Math.sin((TAU * c) / (BOB_PERIOD * 1.3) + phase);
    push(
      pen,
      b.x,
      y,
      b.x,
      y,
      b.r,
      (phase + scene.morph) % TAU,
      0.1,
      KIND_BLOB,
      C_BLOB + scene.blobColors[i],
    );
  }

  pen.tag = TAG_ITEM;
  emitPlant(pen, scene, layout.plants[0], 0);
  emitPlant(pen, scene, layout.plants[1], 1);

  pen.alpha = swap * scene.propsAlpha;
  const k = layout.propScale;
  for (let i = 0; i < layout.propCount; i++) {
    const slot = layout.props[i];
    const phase = scene.propPhases[i];
    const y = slot.y + m * PROP_BOB * Math.sin((TAU * c) / BOB_PERIOD + phase);
    emitProp(pen, scene.props[i], slot.x, y, k, slot.x < layout.width / 2 ? 1 : -1);
  }

  for (const i of FIGURE_ORDER) {
    const alpha = swap * scene.figures[i].alpha;
    if (alpha > 0) {
      emitFigure(pen, scene, layout, i, alpha);
    }
  }

  pen.alpha = swap;
  emitMug(pen, layout.mugs[scene.mugSide]);
  return list.count;
}

/**
 * A conservative bounding box of shape `i` (reference px) into `out`
 * [x0, y0, x1, y1]. For tests.
 */
export function shapeBounds(list: ShapeList, i: number, out: Float64Array): Float64Array {
  const d = list.data;
  const o = i * STRIDE;
  const ax = d[o];
  const ay = d[o + 1];
  const bx = d[o + 2];
  const by = d[o + 3];
  const ra = d[o + 4];
  const rb = d[o + 5];
  const kind = d[o + 7];
  if (kind === KIND_ELLIPSE || kind === KIND_TRAPEZOID) {
    // The box round a -> b widened by the larger radius across.
    const len = Math.hypot(bx - ax, by - ay);
    const r = Math.max(ra, rb);
    const vx = len > 0 ? (-(by - ay) / len) * r : r;
    const vy = len > 0 ? ((bx - ax) / len) * r : r;
    out[0] = Math.min(ax, bx) - Math.abs(vx);
    out[1] = Math.min(ay, by) - Math.abs(vy);
    out[2] = Math.max(ax, bx) + Math.abs(vx);
    out[3] = Math.max(ay, by) + Math.abs(vy);
    return out;
  }
  if (kind === KIND_CAPSULE) {
    // Round each end by its own radius.
    out[0] = Math.min(ax - ra, bx - rb);
    out[1] = Math.min(ay - ra, by - rb);
    out[2] = Math.max(ax + ra, bx + rb);
    out[3] = Math.max(ay + ra, by + rb);
    return out;
  }
  const r = kind === KIND_RING ? ra + rb : ra * (1 + d[o + 6]);
  out[0] = ax - r;
  out[1] = ay - r;
  out[2] = ax + r;
  out[3] = ay + r;
  return out;
}
