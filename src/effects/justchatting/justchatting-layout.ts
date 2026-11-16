/**
 * Just Chatting Corner's layout and pure logic: where the neon sign, its
 * plaque and the plant go, how the sign's text is fitted to its plaque, the
 * plant's stems and leaves, and the sign's slow hum.
 *
 * Positions are in design units (see `fitScale`): frame heights at 16:9,
 * centred, y up. The room is laid out once with the sign on the right and the
 * plant, window and microphone on the left; the other side reads it mirrored.
 * Lengths for the neon tubes are in frame heights, y down, from the plaque's
 * top-left corner.
 */
import { clamp } from "../math";
import { breath, warmUp } from "../neon-tubes";
import { createRng } from "../noise";
import { fitScale } from "../scene-layout";

/** The plaque behind the sign: its height, widest and narrowest. */
export const PLAQUE_H = 0.11;
export const PLAQUE_MAX_W = 0.42;
const PLAQUE_MIN_W = 0.16;
/** Room kept between the lettering and the plaque's sides. */
const PLAQUE_PAD = 0.035;
/** Largest font size (frame heights), for a short word. */
export const SIGN_MAX_FONT = 0.068;
/** Distance between line centres, in font sizes (one line, so only its box). */
const SIGN_PITCH = 1.2;
/** The plaque's centre from the frame's side edge, and its top below the frame's top. */
const SIGN_INSET = 0.36;
const SIGN_TOP_GAP = 0.03;

/** The sign's one line: the text's first line, trimmed. Empty hides the sign. */
export function signLine(text: string): string {
  return (text.split("\n")[0] ?? "").trim();
}

interface SignFit {
  /** The plaque's width (its height is `PLAQUE_H`). */
  plaqueW: number;
  /** The lettering, from the plaque's top-left corner (frame heights, y down). */
  lettering: {
    x: number;
    y: number;
    w: number;
    h: number;
    font: number;
    pitch: number;
    align: "center";
    anchor: number;
  };
}

/**
 * Fits a line `widthEm` ems wide (its advance at a font size of 1) to the
 * plaque: as large as `SIGN_MAX_FONT` allows, shrunk so it fits between the
 * plaque's padding at its widest, with the plaque sized round it and the
 * lettering centred on it.
 */
export function fitSign(widthEm: number): SignFit {
  const em = Number.isFinite(widthEm) && widthEm > 0 ? widthEm : 1e-3;
  const font = Math.min(SIGN_MAX_FONT, (PLAQUE_MAX_W - 2 * PLAQUE_PAD) / em);
  const w = em * font;
  const plaqueW = clamp(w + 2 * PLAQUE_PAD, PLAQUE_MIN_W, PLAQUE_MAX_W);
  const h = SIGN_PITCH * font;
  return {
    plaqueW,
    lettering: {
      x: 0.5 * (plaqueW - w),
      y: 0.5 * (PLAQUE_H - h),
      w,
      h,
      font,
      pitch: SIGN_PITCH,
      align: "center",
      anchor: 0.5 * plaqueW,
    },
  };
}

/** The frame in design units at `aspect`: half its width and its top edge. */
export function designFrame(aspect: number): { halfW: number; top: number } {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const k = fitScale(a);
  return { halfW: (0.5 * a) / k, top: 0.5 / k };
}

/**
 * The plaque's centre x and top y (design units) at `aspect`, on the right
 * (`side` 1) or the left (-1): high on the wall, near the frame's top, so it
 * stays above a stream overlay's column standing in the same outer third.
 */
export function signPlace(aspect: number, side: number): { x: number; top: number } {
  const { halfW, top } = designFrame(aspect);
  return { x: Math.sign(side || 1) * (halfW - SIGN_INSET), top: top - SIGN_TOP_GAP };
}

/** The neon's slow hum: well under 3 % either way, after the tubes warm up. */
export function signHum(t: number): number {
  return warmUp(t) * breath(t, 1);
}

// The plant, by the window on the left: stems from a pot hidden behind the
// sofa's arm, in three layers (back to front), each swaying on its own.

/** The plant's box, from the frame's left edge (x) and in design units (y). */
export const PLANT_LEFT = -0.12;
export const PLANT_RIGHT = 0.68;
export const PLANT_BOTTOM = -0.48;
export const PLANT_TOP = 0.66;
/** Sway layers. */
export const PLANT_LAYERS = 3;
/** Where the stems meet, behind the sofa (from the left edge, and y). */
const POT: readonly [number, number] = [0.16, -0.42];

/** A stem: a quadratic curve from the pot through `ctrl` to `tip`. */
interface StemSpec {
  layer: number;
  ctrl: readonly [number, number];
  tip: readonly [number, number];
}

const STEMS: readonly StemSpec[] = [
  { layer: 0, ctrl: [0.1, 0.0], tip: [0.05, 0.42] },
  { layer: 0, ctrl: [0.22, 0.05], tip: [0.3, 0.5] },
  { layer: 0, ctrl: [0.16, -0.12], tip: [0.42, 0.12] },
  { layer: 1, ctrl: [0.05, -0.05], tip: [0.02, 0.24] },
  { layer: 1, ctrl: [0.2, 0.1], tip: [0.17, 0.5] },
  { layer: 1, ctrl: [0.3, 0.02], tip: [0.47, 0.36] },
  { layer: 1, ctrl: [0.36, 0.0], tip: [0.5, 0.25] },
  { layer: 2, ctrl: [0.1, -0.16], tip: [0.07, 0.07] },
  { layer: 2, ctrl: [0.26, 0.04], tip: [0.37, 0.27] },
  { layer: 2, ctrl: [0.3, 0.2], tip: [0.53, 0.45] },
];

/** A stem as drawn: start, control and end points (from the left edge, and y), and its layer. */
interface Stem {
  layer: number;
  points: [number, number, number, number, number, number];
}

/** A leaf: where its stalk meets it, the way it points (radians), its size, droop and tint. */
interface Leaf {
  layer: number;
  x: number;
  y: number;
  angle: number;
  length: number;
  width: number;
  /** Sideways bend of the tip, as a share of its length (signed). */
  droop: number;
  /** Brightness of its green, about 1. */
  tint: number;
}

const bezier = (s: StemSpec, t: number): [number, number] => {
  const u = 1 - t;
  return [
    u * u * POT[0] + 2 * u * t * s.ctrl[0] + t * t * s.tip[0],
    u * u * POT[1] + 2 * u * t * s.ctrl[1] + t * t * s.tip[1],
  ];
};

/** Leaves along each stem, alternating sides, ending in one at the tip. */
const LEAVES_PER_STEM = 5;

/** The plant's stems and leaves, back layer first. The same every time. */
export function plantParts(): { stems: Stem[]; leaves: Leaf[] } {
  const stems: Stem[] = [];
  const leaves: Leaf[] = [];
  STEMS.forEach((s, i) => {
    stems.push({
      layer: s.layer,
      points: [POT[0], POT[1], s.ctrl[0], s.ctrl[1], s.tip[0], s.tip[1]],
    });
    const rng = createRng(0xc0fe + i);
    // Front layers have bigger, brighter leaves.
    const size = 0.075 + 0.012 * s.layer;
    for (let j = 0; j <= LEAVES_PER_STEM; j++) {
      const tip = j === LEAVES_PER_STEM;
      const t = tip ? 1 : 0.42 + (0.55 * j) / LEAVES_PER_STEM;
      const [x, y] = bezier(s, t);
      const [x1, y1] = bezier(s, Math.min(1, t + 0.01));
      const [x0, y0] = bezier(s, Math.max(0, t - 0.01));
      const along = Math.atan2(y1 - y0, x1 - x0);
      const side = (i + j) % 2 === 0 ? 1 : -1;
      const angle = tip ? along : along + side * (0.65 + 0.35 * rng());
      const length = size * (tip ? 1.05 : 0.8 + 0.35 * rng());
      leaves.push({
        layer: s.layer,
        x,
        y,
        angle,
        length,
        width: length * (0.4 + 0.06 * rng()),
        // Leaves pointing sideways droop the most.
        droop: -0.18 * Math.cos(angle) * (0.6 + 0.4 * rng()),
        tint: 0.85 + 0.3 * rng(),
      });
    }
  });
  return { stems, leaves };
}

/** A leaf's centre (from the left edge, and y). */
export function leafCentre(l: Leaf): [number, number] {
  return [l.x + 0.5 * l.length * Math.cos(l.angle), l.y + 0.5 * l.length * Math.sin(l.angle)];
}
