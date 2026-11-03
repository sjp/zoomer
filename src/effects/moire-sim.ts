/**
 * Pure logic for the Moiré waves effect, shared by `moire.ts` and its tests:
 * palettes, the pattern kind of each layer, the minimum line spacing per
 * resolution, the wrapped motion phase and each layer's pose over time.
 *
 * Every layer is a periodic pattern (rings, lines or a dot grid) with period 1 in
 * its own pattern space. A layer's pose places that space on screen: a centre
 * offset from the frame centre (px at 1080p), an angle and a scale factor on the
 * line spacing. Poses are smooth functions of a phase in [0, 1) built only from
 * whole-cycle sines, so wrapping the phase never makes the pattern jump.
 */
import { hexToUnitRgb, type Rgb } from "./color";
import { wrap } from "./math";

export interface MoirePalette {
  /** Paper colour. */
  bg: string;
  /** Ink of each layer; each one differs slightly in hue. */
  inks: readonly [string, string, string];
}

export const PALETTES = {
  paper: { bg: "#e9e5dc", inks: ["#2a2c34", "#3a3243", "#2c3a38"] },
  slate: { bg: "#5c6a78", inks: ["#1d2a45", "#26304f", "#1b3142"] },
  cream: { bg: "#efe5d0", inks: ["#8a7c6c", "#917769", "#7c7e72"] },
  opart: { bg: "#f3f3f0", inks: ["#101010", "#121212", "#0e0e0e"] },
} as const satisfies Record<string, MoirePalette>;
export type PaletteName = keyof typeof PALETTES;

/** The named palette, or Paper for an unknown name. */
export function palette(name: string): MoirePalette {
  return name in PALETTES ? PALETTES[name as PaletteName] : PALETTES.paper;
}

/** Most layers drawn at once. */
export const MAX_LAYERS = 3;

/** Opacity of each layer before the contrast param, so the layers read as separate sheets. */
export const LAYER_OPACITY = [1, 0.85, 0.72] as const;

export interface PaletteData {
  bg: Rgb;
  /**
   * Filter colour of each layer (ink / paper, per channel, at most 1), packed
   * as `MAX_LAYERS` vec3s: a full mark multiplies the paper by it.
   */
  tints: Float32Array;
}

const PALETTE_DATA = new Map<MoirePalette, PaletteData>();

/** The named palette's shader colours, built once. */
export function paletteData(name: string): PaletteData {
  const p = palette(name);
  let d = PALETTE_DATA.get(p);
  if (!d) {
    const bg = hexToUnitRgb(p.bg);
    const tints = new Float32Array(MAX_LAYERS * 3);
    for (let i = 0; i < MAX_LAYERS; i++) {
      const ink = hexToUnitRgb(p.inks[i]);
      for (let c = 0; c < 3; c++) tints[i * 3 + c] = Math.min(1, ink[c] / Math.max(bg[c], 1e-3));
    }
    d = { bg, tints };
    PALETTE_DATA.set(p, d);
  }
  return d;
}

/** Shader pattern kinds. */
export const RINGS = 0;
export const LINES = 1;
export const DOTS = 2;

export const PATTERNS = ["rings", "lines", "dots", "ringslines"] as const;
export type PatternName = (typeof PATTERNS)[number];

const KINDS: Record<PatternName, readonly [number, number, number]> = {
  rings: [RINGS, RINGS, RINGS],
  lines: [LINES, LINES, LINES],
  dots: [DOTS, DOTS, DOTS],
  ringslines: [RINGS, LINES, RINGS],
};

/** Pattern kind of each layer for a pattern name; Rings for an unknown name. */
export function patternKinds(name: string): readonly [number, number, number] {
  return name in KINDS ? KINDS[name as PatternName] : KINDS.rings;
}

export const MOTIONS = ["rotate", "drift", "breathe"] as const;
export type MotionName = (typeof MOTIONS)[number];

/** Motion index of a motion name; Rotate for an unknown name. */
export function motionIndex(name: string): number {
  return Math.max(0, MOTIONS.indexOf(name as MotionName));
}

/** Layer count for a `layers` select value: 3 for "three", else 2. */
export function layerCount(name: string): number {
  return name === "three" ? 3 : 2;
}

/**
 * Mark width as a fraction of the spacing: lines and rings are this wide, and
 * dots this wide across.
 */
export const LINE_FRACTION = 0.45;
export const DOT_FRACTION = 0.6;
/** Soft edge half width, in pattern units (fractions of the spacing). */
export const EDGE_SOFTNESS = 0.08;

/**
 * Smallest spacing param (px at 1080p). With LINE_FRACTION it keeps marks at
 * least MIN_LINE_1080 px wide at 1080p, and the same in proportion at any size.
 */
export const MIN_SPACING = 16;
export const MIN_LINE_1080 = MIN_SPACING * LINE_FRACTION;
/**
 * Floor on mark width in device px, whatever the resolution: thinner lines
 * alias against a camera-sized frame and smear in video codecs. It decides the
 * spacing below 1080p (at 720p, 16 px at 1080p would give 4.8 px marks).
 */
export const MIN_LINE_DEVICE_PX = 6;

/**
 * Base line spacing in device px for a spacing param (px at 1080p) at `scale`
 * (height / 1080): the param, clamped to MIN_SPACING and scaled, but never so
 * small that a mark is thinner than MIN_LINE_DEVICE_PX. Layer scale factors are
 * all at least 1, so no layer's spacing is ever smaller than this.
 */
export function spacingPx(spacing: number, scale: number): number {
  const s = Number.isFinite(spacing) ? Math.max(spacing, MIN_SPACING) : MIN_SPACING;
  const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return Math.max(s * k, MIN_LINE_DEVICE_PX / LINE_FRACTION);
}

/** Seconds per motion cycle at speed 1. Layer motions repeat 1 or 2 times a cycle. */
export const PERIOD = 120;

/** Advances the motion phase (cycles, in [0, 1)) by `dt` seconds at `speed`. */
export function advancePhase(phase: number, dt: number, speed: number): number {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  const v = Number.isFinite(speed) && speed > 0 ? speed : 0;
  const p = Number.isFinite(phase) ? phase : 0;
  return wrap(p + (d * v) / PERIOD, 0, 1);
}

export interface LayerPose {
  /** Pattern centre, px at 1080p from the frame centre (y up). */
  cx: number;
  cy: number;
  /** Rotation of the pattern, radians anticlockwise. */
  angle: number;
  /** Factor on the base spacing, at least 1. */
  scale: number;
}

/** Rest centre (px at 1080p from the frame centre) of each layer. */
const CENTRES = [
  [-110, 40],
  [120, -35],
  [15, 130],
] as const;
/** Rest angle of each layer: small differences make the broad line and dot bands. */
const ANGLES = [0, 0.055, -0.045] as const;
/** Rest spacing factor of each layer (at least 1). */
const SCALES = [1, 1.03, 1.065] as const;
/** Whole cycles per motion period, phase offset (cycles) and signed amplitude of each layer. */
const CYCLES = [1, 1, 2] as const;
const OFFSETS = [0, 0.25, 0.6] as const;
const GAINS = [0.35, 1, -0.8] as const;

/** Rotate: angle swing (radians), and how far the centres orbit the frame centre (radians). */
export const ROTATE_ANGLE = 0.05;
export const ROTATE_ORBIT = 0.5;
/** Drift: Lissajous amplitude of the centres, px at 1080p. */
export const DRIFT_PX = 60;
/** Breathe: largest extra spacing factor. */
export const BREATHE = 0.06;

const TAU = 2 * Math.PI;

/**
 * Writes layer `layer`'s pose for motion `motion` (a MOTIONS index) at `phase`
 * (cycles) to `out` and returns it. Smooth in the phase, with period 1.
 */
export function layerPose(layer: number, motion: number, phase: number, out: LayerPose): LayerPose {
  const i = Math.min(Math.max(Math.floor(layer), 0), MAX_LAYERS - 1);
  const a = TAU * (CYCLES[i] * phase + OFFSETS[i]);
  const g = GAINS[i];
  let cx: number = CENTRES[i][0];
  let cy: number = CENTRES[i][1];
  let angle: number = ANGLES[i];
  let scale: number = SCALES[i];
  if (motion === 1) {
    // Drift: a Lissajous figure, the second axis at twice the frequency.
    cx += DRIFT_PX * g * Math.sin(a);
    cy += DRIFT_PX * 0.6 * g * Math.sin(2 * a + 1);
  } else if (motion === 2) {
    // Breathe: grows and shrinks back, never below the rest spacing.
    scale *= 1 + BREATHE * Math.abs(g) * 0.5 * (1 - Math.cos(a));
  } else {
    // Rotate: the angle swings, and the centre orbits the frame centre.
    angle += ROTATE_ANGLE * g * Math.sin(a);
    const orbit = ROTATE_ORBIT * g * Math.sin(a);
    const c = Math.cos(orbit);
    const s = Math.sin(orbit);
    const x = cx;
    cx = c * x - s * cy;
    cy = s * x + c * cy;
  }
  out.cx = cx;
  out.cy = cy;
  out.angle = angle;
  out.scale = scale;
  return out;
}

/**
 * Writes the affine map from device px (`gl_FragCoord`) to pattern space for a
 * pose: `p = M x + o`, with M at `m[4 * index]` in column-major order (as
 * `uniformMatrix2fv` takes it) and o at `o[2 * index]`. `spacing` is the base
 * spacing in device px, `scale` is height / 1080.
 */
export function writeLayerMap(
  pose: LayerPose,
  spacing: number,
  width: number,
  height: number,
  scale: number,
  index: number,
  m: Float32Array,
  o: Float32Array,
): void {
  const k = 1 / (spacing * pose.scale);
  const c = Math.cos(pose.angle) * k;
  const s = Math.sin(pose.angle) * k;
  const px = width / 2 + pose.cx * scale;
  const py = height / 2 + pose.cy * scale;
  // Rotate by -angle: p = (c x + s y, -s x + c y) about the centre.
  m[4 * index] = c;
  m[4 * index + 1] = -s;
  m[4 * index + 2] = s;
  m[4 * index + 3] = c;
  o[2 * index] = -(c * px + s * py);
  o[2 * index + 1] = -(-s * px + c * py);
}
