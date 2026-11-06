/**
 * Fairy lights' layout and animation, kept free of GL so they can be tested:
 * strings hung in parabolic (near-catenary) swags across the top of the frame, or
 * as curtain strands down the side edges; bulbs at equal arc length along each;
 * a slow sway that swings each string about its anchors; and the per-bulb
 * twinkle and chase curves. Positions are in reference units (1 = one pixel of a
 * 1080-tall frame), y down.
 */
import type { Rgb } from "./color";
import { clamp, smoothstep } from "./math";
import { createRng } from "./noise";

/** Reference frame height. */
export const REF_HEIGHT = 1080;
/** Most a bulb dims while twinkling, at a twinkle of 1. */
export const TWINKLE_DEPTH = 0.3;
/** Fastest twinkle component, in Hz: well under the 0.5 Hz cap. */
export const TWINKLE_MAX_HZ = 0.3;
const TWINKLE_MIN_HZ = 0.03;
/** Chase: bulbs per wave, the wave's rate in Hz, and how much it dims a bulb. */
export const CHASE_PERIOD = 7;
export const CHASE_HZ = 0.07;
export const CHASE_DEPTH = 0.6;
/** Swag sway: most swing about the anchor line in radians, and the period range in seconds. */
export const SWAG_SWAY = 0.035;
/** Curtain strands swing about their top, so a much smaller angle moves them as far. */
export const CURTAIN_SWAY = 0.006;
const SWAY_PERIOD_MIN = 7;
const SWAY_PERIOD_MAX = 12;
/** Bulb spacing along the wire, in px at 1080 for the nearest string. */
export const BULB_SPACING = 48;
/** Halo radius of an in-focus bulb, and the radius of a fully blurred bokeh disc (px at 1080). */
export const HALO_RADIUS = 15;
export const BOKEH_RADIUS = 30;
/** Swags: anchor heights and sag (px at 1080). Lowest point + biggest sprite stays in the top third. */
const ANCHOR_MIN = 16;
const ANCHOR_SPAN = 84;
const SAG_MIN = 75;
const SAG_SPAN = 98;
/** Most sag per unit of swag width: the wire leaves an anchor at under 39 degrees. */
const MAX_SAG_RATIO = 0.2;
/** Points per swag in the wire polyline. */
const SWAG_POINTS = 40;
/** Curtain wire point spacing (px at 1080), and where strands hang from (above the frame). */
const CURTAIN_STEP = 24;
const CURTAIN_TOP = -20;
/** Smaller and closer together the further back a string is, at depth 1. */
const DEPTH_SHRINK = 0.3;
/** Wires fade into the wall as a string blurs, and are gone by this blur. */
export const WIRE_FADE_BLUR = 0.45;
/** Wire half width in px at 1080 for the nearest string. */
export const WIRE_HALF_WIDTH = 0.8;
/** Most strings, swags and curtain strands together. */
export const MAX_FAIRY_STRINGS = 16;
/** Glow blobs on the wall: one per swag string and one per curtain side. */
export const MAX_GLOWS = 6;
/** Floats per bulb instance: x, y, radius (device px), level; r, g, b, blur. */
export const BULB_FLOATS = 8;
/** Floats per wire segment: tail x, y, head x, y; r, g, b; half width (device px). */
export const WIRE_FLOATS = 8;
const TAU = Math.PI * 2;

export type FairyLayout = "swags" | "curtain" | "both";
export type FairyPattern = "twinkle" | "chase" | "steady";

/** Bulb colours by palette: one colour, or a sequence along each string. */
export const PALETTES: Readonly<Record<string, readonly Rgb[]>> = {
  warm: [[1, 0.72, 0.4]],
  vintage: [
    [1, 0.26, 0.16],
    [0.3, 0.88, 0.36],
    [1, 0.66, 0.18],
    [0.28, 0.46, 1],
    [0.98, 0.38, 0.72],
  ],
  cool: [[0.76, 0.86, 1]],
  gold: [[1, 0.6, 0.18]],
};

/** Mean colour of a palette, for the wall glow. */
export function paletteMean(palette: readonly Rgb[], out: Rgb): Rgb {
  out[0] = out[1] = out[2] = 0;
  for (const c of palette) {
    for (let i = 0; i < 3; i++) {
      out[i] += c[i] / palette.length;
    }
  }
  return out;
}

// --- Curves -------------------------------------------------------------------

/**
 * How far a swag hangs below its chord at parameter `t` in [0, 1], for a sag of
 * `sag` at the middle: the parabola that closely matches a shallow catenary. Kept
 * apart from the chord, since sway swings only this part about the anchors.
 */
export function swagSag(sag: number, t: number): number {
  return 4 * sag * t * (1 - t);
}

/**
 * Brightness of a twinkling bulb at time `t` (seconds): two slow sines, each at
 * most `TWINKLE_MAX_HZ`, mapped into [1 - TWINKLE_DEPTH * amount, 1].
 */
export function twinkleLevel(
  t: number,
  f1: number,
  p1: number,
  f2: number,
  p2: number,
  amount: number,
): number {
  const n = 0.5 * (Math.sin(TAU * f1 * t + p1) + Math.sin(TAU * f2 * t + p2));
  return 1 - TWINKLE_DEPTH * amount * (0.5 - 0.5 * n);
}

/** Chase level of bulb `k` along its string at time `t`: a slow dimming wave travelling along it. */
export function chaseLevel(k: number, t: number): number {
  const c = 0.5 - 0.5 * Math.cos(TAU * (k / CHASE_PERIOD - CHASE_HZ * t));
  return 1 - CHASE_DEPTH * c;
}

// --- Layout -------------------------------------------------------------------

export interface FairyBuild {
  strings: number;
  layout: FairyLayout;
  seed: number;
  /** Frame width in reference units. */
  refWidth: number;
}

export interface FairyFrame {
  /** Seconds since start, unwrapped (float64). */
  time: number;
  twinkle: number;
  pattern: FairyPattern;
  focus: number;
  /** Device px per reference px. */
  scale: number;
  palette: readonly Rgb[];
  /** Wall colour, for the wires to fade into. */
  wall: Rgb;
  /** Wire colour when in focus. */
  wire: Rgb;
}

/** A glow blob on the wall: centre and radii in reference px, and strength. */
export interface FairyGlow {
  x: number;
  y: number;
  rx: number;
  ry: number;
  strength: number;
}

export interface FairyLights {
  /** Lays the strings out again; allocates nothing past the capacities. */
  build: (b: FairyBuild) => void;
  readonly stringCount: number;
  readonly bulbCount: number;
  readonly pointCount: number;
  /** Wall glows for the current layout (only the first `glowCount` are valid). */
  readonly glows: readonly FairyGlow[];
  readonly glowCount: number;
  /** Rest geometry, for tests: the wire points and bulbs in reference px. */
  readonly pointX: Float64Array;
  readonly pointY: Float64Array;
  readonly bulbX: Float64Array;
  readonly bulbY: Float64Array;
  readonly bulbString: Int32Array;
  /** Per string: first point, point count, kind (0 swag, 1 curtain), depth. */
  readonly stringFirst: Int32Array;
  readonly stringPoints: Int32Array;
  readonly stringKind: Int32Array;
  readonly stringDepth: Float64Array;
  /** The level of bulb `i` at a frame's time and pattern. */
  level: (i: number, f: FairyFrame) => number;
  /**
   * Sways the strings to `f.time` and writes the bulb instances (`BULB_FLOATS`
   * each, device px) and the visible wire segments (`WIRE_FLOATS` each). Returns
   * the bulb count; the wire segment count is in `wireCount`.
   */
  step: (f: FairyFrame, bulbs: Float32Array, wires: Float32Array) => number;
  readonly wireCount: number;
}

export function createFairyLights(maxBulbs: number, maxPoints: number): FairyLights {
  const pointX = new Float64Array(maxPoints);
  const pointY = new Float64Array(maxPoints);
  /** Sway lever: how far below its pivot line the point hangs. */
  const pointLever = new Float64Array(maxPoints);
  /** Cumulative arc length along the string at each point. */
  const pointArc = new Float64Array(maxPoints);

  const bulbX = new Float64Array(maxBulbs);
  const bulbY = new Float64Array(maxBulbs);
  const bulbLever = new Float64Array(maxBulbs);
  const bulbString = new Int32Array(maxBulbs);
  const bulbIndex = new Int32Array(maxBulbs);
  const bulbF1 = new Float64Array(maxBulbs);
  const bulbF2 = new Float64Array(maxBulbs);
  const bulbP1 = new Float64Array(maxBulbs);
  const bulbP2 = new Float64Array(maxBulbs);
  /** Palette slot offset and a small brightness jitter per bulb. */
  const bulbSlot = new Int32Array(maxBulbs);
  const bulbJitter = new Float64Array(maxBulbs);

  const S = MAX_FAIRY_STRINGS;
  const stringFirst = new Int32Array(S);
  const stringPoints = new Int32Array(S);
  const stringKind = new Int32Array(S);
  const stringDepth = new Float64Array(S);
  const swayAmp = new Float64Array(S);
  const swayRate = new Float64Array(S);
  const swayPhase = new Float64Array(S);
  const swayPhase2 = new Float64Array(S);
  /** Per-frame sway: sin θ and cos θ − 1. */
  const swaySin = new Float64Array(S);
  const swayCos = new Float64Array(S);
  /** Per-frame blur. */
  const stringBlur = new Float64Array(S);

  const glows: FairyGlow[] = [];
  for (let i = 0; i < MAX_GLOWS; i++) {
    glows.push({ x: 0, y: 0, rx: 1, ry: 1, strength: 0 });
  }

  let stringCount = 0;
  let bulbCount = 0;
  let pointCount = 0;
  let glowCount = 0;
  let wireCount = 0;

  /** Starts a string; returns its index or -1 when full. */
  const beginString = (kind: number, depth: number, rand: () => number) => {
    if (stringCount >= S) {
      return -1;
    }
    const s = stringCount++;
    stringFirst[s] = pointCount;
    stringPoints[s] = 0;
    stringKind[s] = kind;
    stringDepth[s] = depth;
    swayAmp[s] = (kind === 0 ? SWAG_SWAY : CURTAIN_SWAY) * (0.7 + 0.3 * rand());
    swayRate[s] = TAU / (SWAY_PERIOD_MIN + (SWAY_PERIOD_MAX - SWAY_PERIOD_MIN) * rand());
    swayPhase[s] = rand() * TAU;
    swayPhase2[s] = rand() * TAU;
    return s;
  };

  const addPoint = (s: number, x: number, y: number, lever: number) => {
    if (pointCount >= maxPoints) {
      return;
    }
    const i = pointCount++;
    const n = stringPoints[s]++;
    pointX[i] = x;
    pointY[i] = y;
    pointLever[i] = lever;
    pointArc[i] = n === 0 ? 0 : pointArc[i - 1] + Math.hypot(x - pointX[i - 1], y - pointY[i - 1]);
  };

  /** Places bulbs along string `s` every `spacing` of arc length, starting at `offset`. */
  const placeBulbs = (s: number, spacing: number, offset: number, rand: () => number) => {
    const first = stringFirst[s];
    const end = first + stringPoints[s];
    let k = 0;
    let j = first;
    for (let arc = offset; bulbCount < maxBulbs; arc += spacing, k++) {
      while (j + 1 < end && pointArc[j + 1] < arc) {
        j++;
      }
      if (j + 1 >= end) {
        break;
      }
      const span = pointArc[j + 1] - pointArc[j];
      const u = span > 0 ? (arc - pointArc[j]) / span : 0;
      const b = bulbCount++;
      bulbX[b] = pointX[j] + (pointX[j + 1] - pointX[j]) * u;
      bulbY[b] = pointY[j] + (pointY[j + 1] - pointY[j]) * u;
      bulbLever[b] = pointLever[j] + (pointLever[j + 1] - pointLever[j]) * u;
      bulbString[b] = s;
      bulbIndex[b] = k;
      bulbF1[b] = TWINKLE_MIN_HZ + (TWINKLE_MAX_HZ * 0.6 - TWINKLE_MIN_HZ) * rand();
      bulbF2[b] = TWINKLE_MAX_HZ * (0.4 + 0.6 * rand());
      bulbP1[b] = rand() * TAU;
      bulbP2[b] = rand() * TAU;
      bulbSlot[b] = s;
      bulbJitter[b] = rand() * 2 - 1;
    }
  };

  const addGlow = (x: number, y: number, rx: number, ry: number, strength: number) => {
    if (glowCount >= MAX_GLOWS) {
      return;
    }
    const g = glows[glowCount++];
    g.x = x;
    g.y = y;
    g.rx = rx;
    g.ry = ry;
    g.strength = strength;
  };

  const buildSwags = (n: number, width: number, rand: () => number) => {
    for (let i = 0; i < n; i++) {
      const depth = n === 1 ? 0 : i / (n - 1);
      const shrink = 1 - DEPTH_SHRINK * depth;
      const s = beginString(0, depth, rand);
      if (s < 0) {
        return;
      }
      const swags = clamp(Math.round((width / 1920) * (2 + rand() * 1.6)), 2, 8);
      const left = -0.03 * width;
      const step = (1.06 * width) / swags;
      let x0 = left;
      let y0 = ANCHOR_MIN + ANCHOR_SPAN * rand();
      let sagSum = 0;
      let anchorSum = y0;
      for (let w = 0; w < swags; w++) {
        const last = w === swags - 1;
        const x1 = last
          ? left + 1.06 * width
          : left + step * (w + 1) + step * 0.16 * (rand() - 0.5);
        const y1 = ANCHOR_MIN + ANCHOR_SPAN * rand();
        // Short swags sag less, so the wire never kinks into a sharp V at an anchor.
        const sag = Math.min((SAG_MIN + SAG_SPAN * rand()) * shrink, MAX_SAG_RATIO * (x1 - x0));
        sagSum += sag;
        anchorSum += y1;
        // The first swag adds its start point; later ones share their left anchor.
        for (let p = w === 0 ? 0 : 1; p <= SWAG_POINTS; p++) {
          const t = p / SWAG_POINTS;
          const lever = swagSag(sag, t);
          addPoint(s, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + lever, lever);
        }
        x0 = x1;
        y0 = y1;
      }
      const spacing = BULB_SPACING * shrink;
      placeBulbs(s, spacing, spacing * rand(), rand);
      const meanY = anchorSum / (swags + 1) + (sagSum / swags) * 0.6;
      addGlow(width / 2, meanY, width * 0.75, 260, 0.05 * (1 - 0.4 * depth));
    }
  };

  const buildCurtain = (perSide: number, width: number, rand: () => number) => {
    for (let side = 0; side < 2; side++) {
      let xSum = 0;
      for (let i = 0; i < perSide; i++) {
        const depth = rand();
        const shrink = 1 - DEPTH_SHRINK * depth;
        const s = beginString(1, depth, rand);
        if (s < 0) {
          return;
        }
        // Evenly across the outer 17% of the width, with jitter.
        const u = (i + 0.5 + (rand() - 0.5) * 0.6) / perSide;
        const fromEdge = (0.015 + 0.155 * u) * width;
        const x = side === 0 ? fromEdge : width - fromEdge;
        xSum += x;
        const length = REF_HEIGHT * (0.5 + 0.42 * rand());
        const points = Math.max(2, Math.ceil(length / CURTAIN_STEP) + 1);
        for (let p = 0; p < points; p++) {
          const lever = (length * p) / (points - 1);
          addPoint(s, x, CURTAIN_TOP + lever, lever);
        }
        const spacing = BULB_SPACING * 0.92 * shrink;
        placeBulbs(s, spacing, -CURTAIN_TOP + spacing * rand(), rand);
      }
      addGlow(xSum / perSide, REF_HEIGHT * 0.35, width * 0.16, REF_HEIGHT * 0.6, 0.04);
    }
  };

  const self: FairyLights = {
    build(b) {
      stringCount = bulbCount = pointCount = glowCount = wireCount = 0;
      const rand = createRng(b.seed * 7919 + 13);
      const n = clamp(Math.round(b.strings), 1, 4);
      const width = Math.max(1, b.refWidth);
      if (b.layout !== "curtain") {
        buildSwags(n, width, rand);
      }
      if (b.layout !== "swags") {
        buildCurtain(n + 1, width, rand);
      }
    },
    get stringCount() {
      return stringCount;
    },
    get bulbCount() {
      return bulbCount;
    },
    get pointCount() {
      return pointCount;
    },
    get glowCount() {
      return glowCount;
    },
    get wireCount() {
      return wireCount;
    },
    glows,
    pointX,
    pointY,
    bulbX,
    bulbY,
    bulbString,
    stringFirst,
    stringPoints,
    stringKind,
    stringDepth,
    level(i, f) {
      if (f.pattern === "steady") {
        return 1;
      }
      const tw = twinkleLevel(f.time, bulbF1[i], bulbP1[i], bulbF2[i], bulbP2[i], f.twinkle);
      return f.pattern === "chase" ? tw * chaseLevel(bulbIndex[i], f.time) : tw;
    },
    step(f, bulbs, wires) {
      const sc = f.scale;
      for (let s = 0; s < stringCount; s++) {
        const a = swayRate[s] * f.time;
        const theta =
          swayAmp[s] *
          ((Math.sin(a + swayPhase[s]) + 0.3 * Math.sin(2.3 * a + swayPhase2[s])) / 1.3);
        swaySin[s] = Math.sin(theta);
        swayCos[s] = Math.cos(theta) - 1;
        stringBlur[s] = clamp(f.focus, 0, 1) * stringDepth[s];
      }

      // Wires: source-over segments, fading into the wall as the string blurs.
      wireCount = 0;
      const maxWires = Math.floor(wires.length / WIRE_FLOATS);
      for (let s = 0; s < stringCount; s++) {
        const fade = smoothstep(0, WIRE_FADE_BLUR, stringBlur[s]);
        if (fade >= 1 || stringPoints[s] < 2) {
          continue;
        }
        const shrink = 1 - DEPTH_SHRINK * stringDepth[s];
        const r = f.wire[0] + (f.wall[0] - f.wire[0]) * fade;
        const g = f.wire[1] + (f.wall[1] - f.wire[1]) * fade;
        const bl = f.wire[2] + (f.wall[2] - f.wire[2]) * fade;
        const hw = WIRE_HALF_WIDTH * shrink * sc;
        const sn = swaySin[s];
        const cs = swayCos[s];
        const first = stringFirst[s];
        const end = first + stringPoints[s];
        let px = (pointX[first] - sn * pointLever[first]) * sc;
        let py = (pointY[first] + cs * pointLever[first]) * sc;
        for (let i = first + 1; i < end && wireCount < maxWires; i++) {
          const x = (pointX[i] - sn * pointLever[i]) * sc;
          const y = (pointY[i] + cs * pointLever[i]) * sc;
          const o = wireCount++ * WIRE_FLOATS;
          wires[o] = px;
          wires[o + 1] = py;
          wires[o + 2] = x;
          wires[o + 3] = y;
          wires[o + 4] = r;
          wires[o + 5] = g;
          wires[o + 6] = bl;
          wires[o + 7] = hw;
          px = x;
          py = y;
        }
      }

      // Bulbs.
      const n = Math.min(bulbCount, Math.floor(bulbs.length / BULB_FLOATS));
      const pal = f.palette;
      for (let i = 0; i < n; i++) {
        const s = bulbString[i];
        const blur = stringBlur[s];
        const shrink = 1 - DEPTH_SHRINK * stringDepth[s];
        const lever = bulbLever[i];
        const c = pal[(bulbIndex[i] + bulbSlot[i]) % pal.length];
        const j = 1 + 0.07 * bulbJitter[i];
        const o = i * BULB_FLOATS;
        bulbs[o] = (bulbX[i] - swaySin[s] * lever) * sc;
        bulbs[o + 1] = (bulbY[i] + swayCos[s] * lever) * sc;
        bulbs[o + 2] = (HALO_RADIUS + (BOKEH_RADIUS - HALO_RADIUS) * blur) * shrink * sc;
        bulbs[o + 3] = self.level(i, f);
        bulbs[o + 4] = Math.min(1, c[0] * j);
        bulbs[o + 5] = Math.min(1, c[1] * j);
        bulbs[o + 6] = Math.min(1, c[2] * j);
        bulbs[o + 7] = blur;
      }
      return n;
    },
  };
  return self;
}
