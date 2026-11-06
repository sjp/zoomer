/**
 * Dewy spider web: the pure JS side. An orb web generated once per seed in one
 * corner of the frame (anchor threads to the frame edges, a polygon of frame
 * threads, 20–30 spokes, a hub and an Archimedean capture spiral clipped by the
 * spokes), every thread bowed slightly downward, dew drops beaded along the
 * threads, a smooth sway, and the soft bokeh backdrop's blob layout.
 *
 * Coordinates are reference px: the frame is `REF_HEIGHT` tall and `refWidth`
 * wide, y down. The renderer multiplies by the viewport scale.
 */
import type { Rgb } from "./color";
import { clamp } from "./math";
import { createRng } from "./noise";

export const REF_HEIGHT = 1080;

export type WebCorner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
export type WebLight = "dawn" | "misty" | "cool";

/** The web stays inside this fraction of the frame width from its side edge (the speaker fills the middle third). */
export const BOX_WIDTH_FRACTION = 1 / 3;
/** ...and within this many reference px of its top or bottom edge. */
export const BOX_HEIGHT = 0.64 * REF_HEIGHT;
/** Frame vertices keep this far from the frame edges, so their anchor threads show. */
export const EDGE_MARGIN = 18;
/** Frame vertices keep this far inside the box's inner sides, leaving room for sag and sway. */
export const INNER_MARGIN_X = 14;
export const INNER_MARGIN_Y = 34;
/** Anchor threads end this far past the frame edge, so their caps never show. */
export const ANCHOR_OVERSHOOT = 6;

/** Web radius (reference px) at size 0 and 1, before fitting the box. */
export const RADIUS_MIN = 190;
export const RADIUS_MAX = 330;

/** Thread kinds, for width and drop spacing. */
export const KIND_SPIRAL = 0;
export const KIND_SPOKE = 1;
export const KIND_FRAME = 2;
export const KIND_ANCHOR = 3;
export const KIND_HUB = 4;

/** Sag at the middle of a thread, as a fraction of its length (the horizontal-thread maximum). */
export const SAG = [0.1, 0.015, 0.03, 0.02, 0.04] as const;
/** Straight pieces each thread is drawn with. */
const SUBDIVISIONS = [3, 6, 8, 4, 1] as const;
/** Drop spacing along each kind at full dew, reference px; 0 for none. */
const DROP_SPACING = [5, 12, 14, 16, 0] as const;
/** Weight (sway displacement fraction) at the frame threads; the hub is 1, the anchor ends 0. */
export const FRAME_WEIGHT = 0.3;
/** Capture spiral: free zone inside this fraction of R, and how far along each spoke it reaches. */
const SPIRAL_START = 0.2;
const SPIRAL_REACH = 0.93;

/** Sway: displacement at the hub (reference px) at sway 1. */
export const SWAY_AMP = 14;
/** Glints: how strongly the web's tilt shifts each drop's glint phase. */
export const GLINT_PHASE_GAIN = 4;
/** Light angle drift with no sway (radians of tilt), so the glints still change slowly. */
const LIGHT_DRIFT = 0.15;

/** Floats per drop instance: centre x, y, radius (device px), glint. */
export const DROP_FLOATS = 4;
/** Floats per thread streak (matches `STREAK_FLOATS` in `streaks.ts`). */
export const THREAD_FLOATS = 8;

/** Thread half widths (reference px) per kind; sub-pixel, so they draw faint. */
const HALF_WIDTH = [0.2, 0.25, 0.32, 0.32, 0.2] as const;

export interface LightPreset {
  /** Backdrop gradient, top and bottom. */
  top: Rgb;
  bottom: Rgb;
  /** Low sun glow on the web's side. */
  glow: Rgb;
  /** Foliage blob colours. */
  leaves: readonly Rgb[];
  /** Foliage blob opacity range. */
  leafStrength: number;
  /** Out-of-focus highlight colour and intensity. */
  bokeh: Rgb;
  bokehStrength: number;
  /** Sunlight on glints and lit threads. */
  sun: Rgb;
  /** Unlit thread colour. */
  silver: Rgb;
  /** Drop interior (the tiny inverted scene) and rim. */
  lens: Rgb;
  rim: Rgb;
}

export const LIGHTS: Readonly<Record<WebLight, LightPreset>> = {
  dawn: {
    top: [0.42, 0.33, 0.16],
    bottom: [0.12, 0.15, 0.06],
    glow: [0.5, 0.33, 0.1],
    leaves: [
      [0.1, 0.16, 0.05],
      [0.2, 0.27, 0.08],
      [0.34, 0.36, 0.12],
      [0.06, 0.1, 0.04],
    ],
    leafStrength: 0.75,
    bokeh: [1.0, 0.78, 0.42],
    bokehStrength: 0.32,
    sun: [1.0, 0.88, 0.62],
    silver: [0.8, 0.76, 0.66],
    lens: [0.4, 0.38, 0.22],
    rim: [0.04, 0.05, 0.02],
  },
  misty: {
    top: [0.62, 0.65, 0.6],
    bottom: [0.32, 0.38, 0.32],
    glow: [0.22, 0.2, 0.15],
    leaves: [
      [0.36, 0.44, 0.36],
      [0.46, 0.52, 0.44],
      [0.28, 0.35, 0.29],
      [0.55, 0.58, 0.52],
    ],
    leafStrength: 0.55,
    bokeh: [0.95, 0.95, 0.9],
    bokehStrength: 0.16,
    sun: [0.98, 0.97, 0.92],
    silver: [0.9, 0.91, 0.88],
    lens: [0.55, 0.6, 0.55],
    rim: [0.14, 0.17, 0.15],
  },
  cool: {
    top: [0.3, 0.42, 0.46],
    bottom: [0.07, 0.14, 0.13],
    glow: [0.22, 0.28, 0.3],
    leaves: [
      [0.06, 0.16, 0.13],
      [0.14, 0.27, 0.2],
      [0.22, 0.36, 0.3],
      [0.04, 0.1, 0.1],
    ],
    leafStrength: 0.7,
    bokeh: [0.78, 0.9, 1.0],
    bokehStrength: 0.26,
    sun: [0.92, 0.96, 1.0],
    silver: [0.76, 0.82, 0.86],
    lens: [0.28, 0.38, 0.38],
    rim: [0.02, 0.05, 0.05],
  },
};

export interface WebOptions {
  corner: WebCorner;
  /** 0–1. */
  size: number;
  seed: number;
  refWidth: number;
}

export interface WebGeometry {
  /** Segment count; each thread is split into a few straight segments. */
  segments: number;
  /** Per segment: tail and head (reference px, sag applied) and their sway weights. */
  ax: Float32Array;
  ay: Float32Array;
  aw: Float32Array;
  bx: Float32Array;
  by: Float32Array;
  bw: Float32Array;
  /** Per segment: unit normal (for the sun-facing glint) and thread kind. */
  nx: Float32Array;
  ny: Float32Array;
  kind: Uint8Array;
  /** Drop count, and per drop: segment, position along it (0–1), radius (reference px), glint phase, rank (shown when below `dew`). */
  drops: number;
  dropSeg: Uint32Array;
  dropT: Float32Array;
  dropR: Float32Array;
  dropPhase: Float32Array;
  dropRank: Float32Array;
  /** Hub (reference px), web radius, spoke count. */
  hubX: number;
  hubY: number;
  radius: number;
  spokes: number;
  /** The bowed frame threads as a closed ring of x, y pairs, in order. */
  frameRing: Float32Array;
  /** Unit direction the sunlight travels in the image plane (from the sun's side). */
  sunX: number;
  sunY: number;
  /** The corner box the web stays inside (reference px). */
  boxX0: number;
  boxX1: number;
  boxY0: number;
  boxY1: number;
}

/** Whether a corner is on the right side, and whether it's at the bottom. */
export const cornerFlips = (corner: WebCorner): [boolean, boolean] => [
  corner === "topRight" || corner === "bottomRight",
  corner === "bottomLeft" || corner === "bottomRight",
];

/** Web radius for a size and frame width, shrunk to fit the corner box. */
export function webRadius(size: number, refWidth: number): number {
  const wanted = RADIUS_MIN + (RADIUS_MAX - RADIUS_MIN) * clamp(size, 0, 1);
  const boxW = refWidth * BOX_WIDTH_FRACTION;
  return Math.min(wanted, (boxW - INNER_MARGIN_X - 8) / 2.15, (BOX_HEIGHT - INNER_MARGIN_Y) / 2.1);
}

/**
 * Where along a bowed thread its lowest point lies (0–1): the thread runs from y0
 * by `dy`, bowed down by `sagY` at its middle (y = y0 + t dy + 4 t (1 - t) sagY).
 */
export function bowLowestT(dy: number, sagY: number): number {
  if (sagY < 1e-6) {
    return dy > 0 ? 1 : 0;
  }
  return clamp(0.5 + dy / (8 * sagY), 0, 1);
}

/**
 * How much bigger a drop at `t` grows from collecting at the bottom of its bow:
 * 1 at the lowest point of a well-bowed thread, falling off away from it, and
 * near 0 on threads that barely bow (steep ones).
 */
export function dropLowness(t: number, lowestT: number, sagY: number): number {
  const d = (t - lowestT) / 0.22;
  return Math.exp(-d * d) * Math.min(1, sagY / 1.2);
}

/** Builds the web for a corner, size and seed. Allocates; call only on a change. */
export function buildWeb(o: WebOptions): WebGeometry {
  const rng = createRng(Math.floor(o.seed) * 7919 + 101);
  const [flipX, flipY] = cornerFlips(o.corner);
  const refWidth = o.refWidth;
  const boxW = refWidth * BOX_WIDTH_FRACTION;
  const R = webRadius(o.size, refWidth);
  // Local frame: u from the side edge inward, v from the top or bottom edge inward.
  const hu = 0.95 * R + rng() * 0.05 * R;
  const hv = 0.9 * R + rng() * 0.05 * R;
  const toX = (u: number) => (flipX ? refWidth - u : u);
  const toY = (v: number) => (flipY ? REF_HEIGHT - v : v);

  const segs: number[] = [];
  const drops: number[] = [];

  /**
   * Adds a thread from (x0, y0) to (x1, y1) in screen space, bowed down, as
   * straight segments, with drops beaded along it. Returns nothing; use `bowAt`
   * for points on it.
   */
  const addThread = (
    x0: number,
    y0: number,
    w0: number,
    x1: number,
    y1: number,
    w1: number,
    kind: number,
  ) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) {
      return;
    }
    const sub = SUBDIVISIONS[kind];
    const [sx, sy] = bowVector(dx, dy, len, SAG[kind]);
    const firstSeg = segs.length / 9;
    let px = x0;
    let py = y0;
    let pw = w0;
    for (let i = 1; i <= sub; i++) {
      const t = i / sub;
      const b = 4 * t * (1 - t);
      const qx = x0 + dx * t + sx * b;
      const qy = y0 + dy * t + sy * b;
      const qw = w0 + (w1 - w0) * t;
      // The segment's normal, from the chord of this piece.
      const ex = qx - px;
      const ey = qy - py;
      const el = Math.hypot(ex, ey) || 1;
      segs.push(px, py, pw, qx, qy, qw, -ey / el, ex / el, kind);
      px = qx;
      py = qy;
      pw = qw;
    }
    const spacing = DROP_SPACING[kind];
    if (spacing <= 0) {
      return;
    }
    const lowT = bowLowestT(dy, sy);
    let s = rng() * spacing;
    while (s < len) {
      const u = s / len;
      const k = Math.min(sub - 1, Math.floor(u * sub));
      const base = 0.9 + 1.5 * rng() * rng();
      const r = base * (1 + 1.3 * dropLowness(u, lowT, sy));
      drops.push(firstSeg + k, u * sub - k, r, rng() * Math.PI * 2, rng());
      s += spacing * (0.6 + 0.8 * rng());
    }
  };

  // Frame polygon: vertices around the hub, pulled in radially to stay inside the corner box.
  const hubX = toX(hu);
  const hubY = toY(hv);
  const frameCount = 5 + Math.floor(rng() * 3);
  const frameAngle0 = rng() * Math.PI * 2;
  const fu: number[] = [];
  const fv: number[] = [];
  const fAngle: number[] = [];
  for (let j = 0; j < frameCount; j++) {
    const a = frameAngle0 + ((j + (rng() - 0.5) * 0.4) * 2 * Math.PI) / frameCount;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let rho = R * (1 + 0.18 * rng());
    rho = Math.min(
      rho,
      rayLimit(hu, ca, EDGE_MARGIN, boxW - INNER_MARGIN_X),
      rayLimit(hv, sa, EDGE_MARGIN, BOX_HEIGHT - INNER_MARGIN_Y),
    );
    fu.push(hu + ca * rho);
    fv.push(hv + sa * rho);
    fAngle.push(a);
  }
  // Frame threads in screen space; keep their bows for the spoke ends and the ring.
  const fx = fu.map((v) => toX(v));
  const fy = fv.map((v) => toY(v));
  const ring: number[] = [];
  const frameSub = SUBDIVISIONS[KIND_FRAME];
  for (let j = 0; j < frameCount; j++) {
    const k = (j + 1) % frameCount;
    addThread(fx[j], fy[j], FRAME_WEIGHT, fx[k], fy[k], FRAME_WEIGHT, KIND_FRAME);
    for (let i = 0; i < frameSub; i++) {
      const p = bowPoint(fx[j], fy[j], fx[k], fy[k], SAG[KIND_FRAME], i / frameSub);
      ring.push(p[0], p[1]);
    }
  }

  // Anchors: each frame vertex to its nearer corner edge, leaning a little; skip a
  // few at random, keeping at least three.
  let skippable = frameCount - 3;
  for (let j = 0; j < frameCount; j++) {
    if (skippable > 0 && rng() < 0.25) {
      skippable--;
      continue;
    }
    let eu: number;
    let ev: number;
    const lean = (rng() - 0.5) * 0.6;
    if (fu[j] < fv[j]) {
      eu = -ANCHOR_OVERSHOOT;
      ev = clamp(fv[j] + lean * fu[j], 0, BOX_HEIGHT - INNER_MARGIN_Y);
    } else {
      ev = -ANCHOR_OVERSHOOT;
      eu = clamp(fu[j] + lean * fv[j], 0, boxW - INNER_MARGIN_X);
    }
    addThread(toX(eu), toY(ev), 0, fx[j], fy[j], FRAME_WEIGHT, KIND_ANCHOR);
  }

  // Spokes: evenly spaced with jitter, from the hub to the (bowed) frame thread.
  const spokes = 20 + Math.floor(rng() * 11);
  const spokeAngle0 = rng() * Math.PI * 2;
  const spokeEndX = new Float64Array(spokes);
  const spokeEndY = new Float64Array(spokes);
  const spokeLen = new Float64Array(spokes);
  const spokeTheta = new Float64Array(spokes);
  for (let k = 0; k < spokes; k++) {
    // Angle in local (u, v) space, measured from the first spoke.
    const rel = ((k + (rng() - 0.5) * 0.5) * 2 * Math.PI) / spokes;
    spokeTheta[k] = rel;
    const a = spokeAngle0 + rel;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    // Find the frame edge whose angular span contains a, and where the ray meets it.
    let hit = 0;
    let edge = 0;
    for (let j = 0; j < frameCount; j++) {
      const k2 = (j + 1) % frameCount;
      const t = rayHitsSegment(hu, hv, ca, sa, fu[j], fv[j], fu[k2], fv[k2]);
      if (t >= 0) {
        hit = t;
        edge = j;
        break;
      }
    }
    // Where along that edge (0–1), then onto the bowed thread in screen space.
    const k2 = (edge + 1) % frameCount;
    const eu = hu + ca * hit;
    const ev = hv + sa * hit;
    const elen = Math.hypot(fu[k2] - fu[edge], fv[k2] - fv[edge]) || 1;
    const s = clamp(Math.hypot(eu - fu[edge], ev - fv[edge]) / elen, 0, 1);
    const p = bowPoint(fx[edge], fy[edge], fx[k2], fy[k2], SAG[KIND_FRAME], s);
    spokeEndX[k] = p[0];
    spokeEndY[k] = p[1];
    spokeLen[k] = Math.hypot(p[0] - hubX, p[1] - hubY);
    addThread(hubX, hubY, 1, p[0], p[1], FRAME_WEIGHT, KIND_SPOKE);
  }

  /** A point on spoke k at radius r from the hub (on its bow), with its sway weight. */
  const spokePoint = (k: number, r: number, out: number[]) => {
    const t = r / spokeLen[k];
    const p = bowPoint(hubX, hubY, spokeEndX[k], spokeEndY[k], SAG[KIND_SPOKE], t);
    out[0] = p[0];
    out[1] = p[1];
    out[2] = 1 + (FRAME_WEIGHT - 1) * t;
  };

  // Hub: a tight spiral; then the capture spiral, each joined spoke to spoke and
  // clipped where it would pass the spoke's reach.
  const spiral = (r0: number, pitch: number, rMax: number, reach: number, kind: number) => {
    const a: number[] = [0, 0, 0];
    const b: number[] = [0, 0, 0];
    let have = false;
    for (let turn = 0; ; turn++) {
      let any = false;
      for (let k = 0; k < spokes; k++) {
        const r = r0 + pitch * (turn + spokeTheta[k] / (2 * Math.PI));
        if (r > rMax) {
          have = false;
          continue;
        }
        any = true;
        if (r > reach * spokeLen[k]) {
          have = false;
          continue;
        }
        spokePoint(k, r, b);
        if (have) {
          addThread(a[0], a[1], a[2], b[0], b[1], b[2], kind);
        }
        a[0] = b[0];
        a[1] = b[1];
        a[2] = b[2];
        have = true;
      }
      if (!any) {
        break;
      }
    }
  };
  spiral(0.02 * R, 0.018 * R, 0.1 * R, 0.5, KIND_HUB);
  const turns = 15 + Math.floor(rng() * 7);
  let maxLen = 0;
  for (let k = 0; k < spokes; k++) {
    maxLen = Math.max(maxLen, spokeLen[k]);
  }
  spiral(
    SPIRAL_START * R,
    ((SPIRAL_REACH - SPIRAL_START) * R) / turns,
    maxLen,
    SPIRAL_REACH,
    KIND_SPIRAL,
  );

  // Sun: low, from the web's side, slightly above.
  const sunX = (flipX ? -1 : 1) * 0.96;
  const sunY = 0.28;

  const n = segs.length / 9;
  const g: WebGeometry = {
    segments: n,
    ax: new Float32Array(n),
    ay: new Float32Array(n),
    aw: new Float32Array(n),
    bx: new Float32Array(n),
    by: new Float32Array(n),
    bw: new Float32Array(n),
    nx: new Float32Array(n),
    ny: new Float32Array(n),
    kind: new Uint8Array(n),
    drops: drops.length / 5,
    dropSeg: new Uint32Array(drops.length / 5),
    dropT: new Float32Array(drops.length / 5),
    dropR: new Float32Array(drops.length / 5),
    dropPhase: new Float32Array(drops.length / 5),
    dropRank: new Float32Array(drops.length / 5),
    hubX,
    hubY,
    radius: R,
    spokes,
    frameRing: new Float32Array(ring),
    sunX,
    sunY,
    boxX0: flipX ? refWidth - boxW : 0,
    boxX1: flipX ? refWidth : boxW,
    boxY0: flipY ? REF_HEIGHT - BOX_HEIGHT : 0,
    boxY1: flipY ? REF_HEIGHT : BOX_HEIGHT,
  };
  for (let i = 0; i < n; i++) {
    const s = i * 9;
    g.ax[i] = segs[s];
    g.ay[i] = segs[s + 1];
    g.aw[i] = segs[s + 2];
    g.bx[i] = segs[s + 3];
    g.by[i] = segs[s + 4];
    g.bw[i] = segs[s + 5];
    g.nx[i] = segs[s + 6];
    g.ny[i] = segs[s + 7];
    g.kind[i] = segs[s + 8];
  }
  for (let i = 0; i < g.drops; i++) {
    const d = i * 5;
    g.dropSeg[i] = drops[d];
    g.dropT[i] = drops[d + 1];
    g.dropR[i] = drops[d + 2];
    g.dropPhase[i] = drops[d + 3];
    g.dropRank[i] = drops[d + 4];
  }
  return g;
}

/** The bow at a thread's middle: down, projected onto its normal, so steep threads barely bow. */
function bowVector(dx: number, dy: number, len: number, sag: number): [number, number] {
  const nx = -dy / len;
  const ny = dx / len;
  // down = (0, 1); its component along the normal.
  const k = sag * len * ny;
  return [nx * k, ny * k];
}

/** A point at t (0–1) along a bowed thread. */
function bowPoint(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  sag: number,
  t: number,
): [number, number] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const [sx, sy] = bowVector(dx, dy, len, sag);
  const b = 4 * t * (1 - t);
  return [x0 + dx * t + sx * b, y0 + dy * t + sy * b];
}

/** How far a ray from p along d (one axis) can go and stay within [lo, hi]. */
function rayLimit(p: number, d: number, lo: number, hi: number): number {
  if (d > 1e-9) {
    return (hi - p) / d;
  }
  if (d < -1e-9) {
    return (lo - p) / d;
  }
  return Infinity;
}

/** Distance along the ray (ox, oy) + t (dx, dy) to the segment, or -1 if it misses. */
function rayHitsSegment(
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const den = dx * ey - dy * ex;
  if (Math.abs(den) < 1e-12) {
    return -1;
  }
  const wx = ax - ox;
  const wy = ay - oy;
  const t = (wx * ey - wy * ex) / den;
  const s = (wx * dy - wy * dx) / den;
  return t >= 0 && s >= -1e-9 && s <= 1 + 1e-9 ? t : -1;
}

/** Per-frame inputs. `time` is unwrapped seconds (CPU only). */
export interface WebFrame {
  time: number;
  /** 0–1. */
  sway: number;
  dew: number;
  /** Device px per reference px. */
  scale: number;
  light: LightPreset;
}

/** Sway displacement at the hub (reference px), into `out`. Smooth in time; zero at sway 0. */
export function swayOffset(time: number, sway: number, out: [number, number]): [number, number] {
  const a = sway * SWAY_AMP;
  out[0] = a * (0.75 * Math.sin(0.29 * time) + 0.25 * Math.sin(0.67 * time + 1.3));
  out[1] = a * (0.35 * Math.sin(0.41 * time + 2.1) + 0.1 * Math.sin(0.83 * time + 0.4));
  return out;
}

/** The web's out-of-plane tilt (radians, roughly): drives the glints and the lit threads. */
export function webTilt(time: number, sway: number): number {
  return (
    sway * (0.6 * Math.sin(0.33 * time + 0.7) + 0.4 * Math.sin(0.59 * time + 2.4)) +
    LIGHT_DRIFT * Math.sin(0.047 * time)
  );
}

/** A drop's glint (0–1) for its phase and the web's tilt: a soft peak, never quite off. */
export function dropGlint(phase: number, tilt: number): number {
  const c = 0.5 + 0.5 * Math.cos(phase + GLINT_PHASE_GAIN * tilt);
  const c2 = c * c;
  const c4 = c2 * c2;
  return 0.2 + 0.8 * c4 * c4;
}

/** How much a thread with unit normal (nx, ny) faces the sun (0–1): lit where it runs across the light. */
export function threadFacing(nx: number, ny: number, sunX: number, sunY: number): number {
  const d = Math.abs(nx * sunX + ny * sunY);
  const d2 = d * d;
  return d2 * d2 * d2;
}

const swayScratch: [number, number] = [0, 0];

/**
 * Writes the threads as streaks (device px, `THREAD_FLOATS` each: tail, head,
 * straight colour, half width) into `out`; returns the count.
 */
export function writeThreads(g: WebGeometry, f: WebFrame, out: Float32Array): number {
  swayOffset(f.time, f.sway, swayScratch);
  const dx = swayScratch[0];
  const dy = swayScratch[1];
  const tilt = webTilt(f.time, f.sway);
  // The lit arcs slide a little as the web tilts.
  const rot = tilt * 0.35;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const sunX = g.sunX * c - g.sunY * s;
  const sunY = g.sunX * s + g.sunY * c;
  const silver = f.light.silver;
  const sun = f.light.sun;
  const sc = f.scale;
  const n = Math.min(g.segments, Math.floor(out.length / THREAD_FLOATS));
  for (let i = 0; i < n; i++) {
    const o = i * THREAD_FLOATS;
    const aw = g.aw[i];
    const bw = g.bw[i];
    out[o] = (g.ax[i] + aw * dx) * sc;
    out[o + 1] = (g.ay[i] + aw * dy) * sc;
    out[o + 2] = (g.bx[i] + bw * dx) * sc;
    out[o + 3] = (g.by[i] + bw * dy) * sc;
    const lit = threadFacing(g.nx[i], g.ny[i], sunX, sunY);
    const k = 0.7 + 0.5 * lit;
    out[o + 4] = Math.min(1, (silver[0] + (sun[0] - silver[0]) * lit) * k);
    out[o + 5] = Math.min(1, (silver[1] + (sun[1] - silver[1]) * lit) * k);
    out[o + 6] = Math.min(1, (silver[2] + (sun[2] - silver[2]) * lit) * k);
    out[o + 7] = HALF_WIDTH[g.kind[i]] * (1 + 0.8 * lit) * sc;
  }
  return n;
}

/**
 * Writes the drops shown at `f.dew` (device px, `DROP_FLOATS` each: centre,
 * radius, glint) into `out`; returns the count. Each lies on its thread segment
 * as swayed this frame.
 */
export function writeDrops(g: WebGeometry, f: WebFrame, out: Float32Array): number {
  swayOffset(f.time, f.sway, swayScratch);
  const dx = swayScratch[0];
  const dy = swayScratch[1];
  const tilt = webTilt(f.time, f.sway);
  const sc = f.scale;
  const max = Math.floor(out.length / DROP_FLOATS);
  let n = 0;
  for (let i = 0; i < g.drops && n < max; i++) {
    if (g.dropRank[i] >= f.dew) {
      continue;
    }
    const seg = g.dropSeg[i];
    const t = g.dropT[i];
    const aw = g.aw[seg];
    const bw = g.bw[seg];
    const ax = g.ax[seg] + aw * dx;
    const ay = g.ay[seg] + aw * dy;
    const bx = g.bx[seg] + bw * dx;
    const by = g.by[seg] + bw * dy;
    const r = g.dropR[i];
    const o = n * DROP_FLOATS;
    out[o] = (ax + (bx - ax) * t) * sc;
    out[o + 1] = (ay + (by - ay) * t) * sc;
    out[o + 2] = r * sc;
    // Bigger drops catch more of the light.
    out[o + 3] = dropGlint(g.dropPhase[i], tilt) * (0.55 + 0.45 * Math.min(1, r / 2.5));
    n++;
  }
  return n;
}

/** Backdrop blobs: at most this many. */
export const MAX_BLOBS = 28;

export interface Backdrop {
  count: number;
  /** Per blob: x, y (reference px), 1 / radius, kind (0 soft foliage, 1 bokeh disc). */
  base: Float32Array;
  /** Per blob: colour and strength. */
  color: Float32Array;
  /** Per blob: drift amplitude x, y (reference px), angular speed, phase. */
  drift: Float32Array;
  /** Sun glow centre (reference px) and 1 / radius. */
  glowX: number;
  glowY: number;
  glowInvR: number;
}

/**
 * The out-of-focus garden behind the web: large soft foliage blobs over a
 * gradient, a few bright bokeh discs weighted toward the sun's side and the top.
 */
export function buildBackdrop(
  light: LightPreset,
  corner: WebCorner,
  seed: number,
  refWidth: number,
): Backdrop {
  const rng = createRng(Math.floor(seed) * 104729 + 17);
  const [flipX, flipY] = cornerFlips(corner);
  const b: Backdrop = {
    count: 0,
    base: new Float32Array(MAX_BLOBS * 4),
    color: new Float32Array(MAX_BLOBS * 4),
    drift: new Float32Array(MAX_BLOBS * 4),
    glowX: flipX ? refWidth * 0.97 : refWidth * 0.03,
    glowY: flipY ? REF_HEIGHT * 0.45 : REF_HEIGHT * 0.3,
    glowInvR: 1 / (REF_HEIGHT * 0.75),
  };
  const add = (x: number, y: number, r: number, kind: number, col: Rgb, strength: number) => {
    const i = b.count++;
    b.base.set([x, y, 1 / r, kind], i * 4);
    b.color.set([col[0], col[1], col[2], strength], i * 4);
    const amp = 6 + 10 * rng();
    const a = rng() * Math.PI * 2;
    b.drift.set(
      [amp * Math.cos(a), amp * Math.sin(a), 0.02 + 0.03 * rng(), rng() * Math.PI * 2],
      i * 4,
    );
  };
  const leaves = 18;
  for (let i = 0; i < leaves; i++) {
    const col = light.leaves[Math.floor(rng() * light.leaves.length)];
    add(
      rng() * refWidth,
      rng() * REF_HEIGHT,
      140 + 220 * rng(),
      0,
      col,
      light.leafStrength * (0.5 + 0.5 * rng()),
    );
  }
  const bokeh = MAX_BLOBS - leaves;
  for (let i = 0; i < bokeh; i++) {
    // Toward the sun's side and the upper half.
    const side = rng() * rng();
    const x = (flipX ? 1 - side : side) * refWidth;
    const y = rng() * rng() * REF_HEIGHT * 0.85;
    add(x, y, 35 + 80 * rng(), 1, light.bokeh, light.bokehStrength * (0.35 + 0.65 * rng()));
  }
  return b;
}

/** Drifted blob positions at `time` into `out` (x, y, 1 / r, kind per blob). */
export function backdropPositions(b: Backdrop, time: number, out: Float32Array): void {
  for (let i = 0; i < b.count; i++) {
    const o = i * 4;
    const s = Math.sin(b.drift[o + 2] * time + b.drift[o + 3]);
    out[o] = b.base[o] + b.drift[o] * s;
    out[o + 1] = b.base[o + 1] + b.drift[o + 1] * s;
    out[o + 2] = b.base[o + 2];
    out[o + 3] = b.base[o + 3];
  }
}
