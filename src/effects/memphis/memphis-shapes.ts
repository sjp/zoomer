/**
 * Corporate Memphis as a list of flat shapes, back to front: blobs, plants and
 * floating props, then (after `split`) the mug. Each shape is one instance of a
 * signed-distance sprite (capsule, ellipse, soft trapezoid, ring or wobbly
 * blob). The people, with the coin and laptop their poses use, go between the
 * two as a mesh of outlines (`memphis-people.ts`).
 *
 * Instance layout (`STRIDE` floats, reference px, y down): end points a and b,
 * then two radii, a corner radius and the kind, then colour (straight RGB) and
 * opacity.
 */
import { type Mesh, resetMesh } from "./memphis-mesh";
import { emitPerson, setPeoplePalette, TAG_ITEM } from "./memphis-people";
import {
  BLOB_BOB,
  BOB_PERIOD,
  C_ACCENT,
  C_BLOB,
  C_CARD,
  C_COIN,
  C_HEART,
  C_INK,
  C_LAPTOP,
  C_LEAF,
  C_MUG,
  C_POT,
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

/** A background shape, for tests (people and props are `TAG_ITEM`). */
export const TAG_BACKGROUND = 0;

interface ShapeList {
  data: Float32Array;
  tags: Uint8Array;
  count: number;
  /** Shapes before this go behind the people, the rest in front. */
  split: number;
}

export function createShapeList(
  data: Float32Array = new Float32Array(MAX_SHAPES * STRIDE),
): ShapeList {
  return { data, tags: new Uint8Array(data.length / STRIDE), count: 0, split: 0 };
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
    C_INK,
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
 * Fills `list` with this frame's shapes and `mesh` with its people, back to
 * front, in `palette`'s colours (unit RGB per colour role). `feather` is one
 * device px in reference px, for the people's antialiased edges. With
 * `people` false the mesh is left as it is (the people haven't changed).
 * Returns the shape count.
 */
export function emitScene(
  list: ShapeList,
  mesh: Mesh,
  scene: Scene,
  layout: Layout,
  palette: Float32Array,
  feather = 1,
  people = true,
): number {
  list.count = 0;
  if (people) {
    resetMesh(mesh, feather);
    setPeoplePalette(palette);
  }
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

  list.split = list.count;
  for (const i of FIGURE_ORDER) {
    const alpha = swap * scene.figures[i].alpha;
    if (people && alpha > 0) {
      emitPerson(mesh, scene, layout, i, alpha);
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
