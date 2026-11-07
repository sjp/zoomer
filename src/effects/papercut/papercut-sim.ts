/**
 * Pure JS logic for the paper-cut layers (papercut.ts): the scene builders that
 * fill the edge table, the palettes, the parallax path, and the per-frame shape
 * placement (drifting clouds, a bobbing boat). Nothing here touches GL, so it is
 * all unit tested.
 *
 * Coordinates are height units, y up: (0, 0) is the bottom-left of the canvas,
 * y = 1 its top, x = aspect its right edge.
 *
 * Edge table: `TABLE_ROWS` rows of `TABLE_COLUMNS` RGBA texels, two rows per stack
 * slot (back first). Row `2 * slot` is indexed by x and holds the bottom edge
 * (height above the canvas bottom) and its slope, then the top edge (distance
 * below the canvas top) and its slope. Row `2 * slot + 1` is indexed by y and
 * holds the left edge (distance from the left side) and its slope, then the right
 * edge (distance from the right side) and its slope. `NONE` marks an absent edge.
 * Distances are measured from the nearest side so values stay small and keep
 * their precision as half floats. Both rows span `TABLE_PERIOD` height units and
 * are sampled with REPEAT wrapping: x rows are periodic, y rows cover
 * [-PERIOD / 2, PERIOD / 2) (columns past the middle hold negative y).
 */
import { hexToUnitRgb, type Rgb } from "../color";
import { clamp, wrap } from "../math";
import { createRng } from "../noise";
import type { PALETTE_IDS } from "./papercut.meta";
import { SCENE_IDS, MIN_LAYERS, MAX_LAYERS } from "./papercut.meta";

const TAU = Math.PI * 2;

export type SceneId = (typeof SCENE_IDS)[number];

/** Most stack slots any scene uses: scenery plus up to two decor layers (sun, clouds, boat). */
export const MAX_STACK = 10;
export const MAX_SHAPES = 4;

export const TABLE_COLUMNS = 2048;
export const TABLE_CHANNELS = 4;
export const TABLE_ROWS = MAX_STACK * 2;
/** Height units spanned by each table row. */
export const TABLE_PERIOD = 4;
const DX = TABLE_PERIOD / TABLE_COLUMNS;
/** Value of an absent edge: well outside the canvas, so it covers nothing. */
export const NONE = -1;

/** Shape kinds, as the shader's `shapeSdf` numbers them. */
export const SHAPE_DISC = 1;
export const SHAPE_CLOUD = 2;
export const SHAPE_CRESCENT = 3;
export const SHAPE_BOAT = 4;

/** Largest parallax offset of the front layer at motion 1, height units. */
export const MOTION_AMP = 0.012;
/** Periods (seconds) of the parallax Lissajous path, and the vertical share of its amplitude. */
export const PARALLAX_PERIOD_X = 47;
export const PARALLAX_PERIOD_Y = 31;
const PARALLAX_Y_SHARE = 0.6;
const PARALLAX_Y_PHASE = 1.1;
/** Boat bob: period (s), lift (height units) and roll (radians). */
const BOB_PERIOD = 7;
const BOB_LIFT = 0.004;
const BOB_ROLL = 0.04;

export type ColorRole = "land" | "sun" | "cloud" | "boat";

export interface ShapeSpec {
  kind: number;
  /** Centre: x as a fraction of the width, y in height units. */
  x: number;
  y: number;
  /** Size (radius for discs), height units. */
  size: number;
  /** Horizontal drift, height units per second (0 for none). */
  drift: number;
}

export interface LayerSpec {
  role: ColorRole;
  /** Shade of a land layer, 0 at the back to 1 at the front. */
  t: number;
  /** Whether the layer's x row (bottom and top edges) and y row (sides) hold edges. */
  hasX: boolean;
  hasY: boolean;
  shapes: ShapeSpec[];
  /** Bottom-edge band the builder promised, [lo, hi], or undefined without a bottom edge. */
  band?: readonly [number, number];
}

export interface Scene {
  id: SceneId;
  /** Back first. */
  layers: LayerSpec[];
  stars: boolean;
  /** Stack slots of the boat layer and the wave it rides, or -1 without a boat. */
  boatSlot: number;
  waveSlot: number;
}

const isSceneId = (v: string): v is SceneId => (SCENE_IDS as readonly string[]).includes(v);

export const sceneId = (v: string): SceneId => (isSceneId(v) ? v : "hills");

// ---------------------------------------------------------------------------
// Table writing
// ---------------------------------------------------------------------------

const index = (row: number, col: number, ch: number) =>
  (row * TABLE_COLUMNS + col) * TABLE_CHANNELS + ch;

/** The coordinate column `c` of a y row stands for: [-PERIOD / 2, PERIOD / 2). */
export const yAt = (c: number) => (c < TABLE_COLUMNS / 2 ? c * DX : c * DX - TABLE_PERIOD);

/** Writes channel `ch` of `row` from `f` (or `NONE`), with the slope in channel `ch + 1`. */
function writeEdge(
  out: Float32Array,
  row: number,
  ch: number,
  f: ((v: number) => number) | null,
  coord: (c: number) => number,
): void {
  for (let c = 0; c < TABLE_COLUMNS; c++) {
    out[index(row, c, ch)] = f ? f(coord(c)) : NONE;
  }
  for (let c = 0; c < TABLE_COLUMNS; c++) {
    if (!f) {
      out[index(row, c, ch + 1)] = 0;
      continue;
    }
    const prev = out[index(row, (c + TABLE_COLUMNS - 1) % TABLE_COLUMNS, ch)];
    const next = out[index(row, (c + 1) % TABLE_COLUMNS, ch)];
    out[index(row, c, ch + 1)] = (next - prev) / (2 * DX);
  }
}

const xCoord = (c: number) => c * DX;

function writeX(
  out: Float32Array,
  slot: number,
  bottom: ((x: number) => number) | null,
  top: ((x: number) => number) | null,
): void {
  writeEdge(out, slot * 2, 0, bottom, xCoord);
  writeEdge(out, slot * 2, 2, top, xCoord);
}

function writeY(
  out: Float32Array,
  slot: number,
  left: ((y: number) => number) | null,
  right: ((y: number) => number) | null,
): void {
  writeEdge(out, slot * 2 + 1, 0, left, yAt);
  writeEdge(out, slot * 2 + 1, 2, right, yAt);
}

/**
 * Channel `ch` of table `row` at coordinate `v` (x for even rows, y for odd),
 * linearly interpolated and wrapped like the shader's REPEAT lookup.
 */
export function sampleRow(table: Float32Array, row: number, ch: number, v: number): number {
  const t = wrap(v, 0, TABLE_PERIOD) / DX;
  const i = Math.floor(t);
  const f = t - i;
  const a = table[index(row, i % TABLE_COLUMNS, ch)];
  const b = table[index(row, (i + 1) % TABLE_COLUMNS, ch)];
  return a + (b - a) * f;
}

// ---------------------------------------------------------------------------
// Edge shapes
// ---------------------------------------------------------------------------

/** Whole cycles per table period, so profiles tile. */
const cycles = (k: number) => (TAU * Math.max(1, Math.round(k))) / TABLE_PERIOD;

/** Rolling hills: three periodic octaves of sines, normalised to [-1, 1]. */
function rollingProfile(rand: () => number, k0: number, roughness: number): (x: number) => number {
  const w0 = cycles(k0);
  const w1 = cycles(k0 * 2.1);
  const w2 = cycles(k0 * 4.3);
  const p0 = rand() * TAU;
  const p1 = rand() * TAU;
  const p2 = rand() * TAU;
  const a1 = 0.35 * roughness;
  const a2 = 0.12 * roughness;
  const norm = 1 + a1 + a2;
  return (x) =>
    (Math.sin(w0 * x + p0) + a1 * Math.sin(w1 * x + p1) + a2 * Math.sin(w2 * x + p2)) / norm;
}

/** Stylised waves: cusped crests (1 - 2|sin|) over a long swell, in [-1, 1]. */
function waveProfile(rand: () => number, k: number): (x: number) => number {
  const crests = Math.max(1, Math.round(k));
  const w = (Math.PI * crests) / TABLE_PERIOD;
  const ws = cycles(Math.max(1, crests / 4));
  const p = rand() * Math.PI;
  const ps = rand() * TAU;
  return (x) => 0.7 * (1 - 2 * Math.abs(Math.sin(w * x + p))) + 0.3 * Math.sin(ws * x + ps);
}

/**
 * A hanging cloud frame along the top: overlapping circles below a thin strip,
 * as distance below the canvas top. Periodic over the table period.
 */
function scallopFrame(rand: () => number, count: number, base: number): (x: number) => number {
  const cx = new Float64Array(count);
  const r = new Float64Array(count);
  const step = TABLE_PERIOD / count;
  for (let i = 0; i < count; i++) {
    cx[i] = (i + 0.3 * (rand() - 0.5)) * step;
    r[i] = step * (0.6 + 0.25 * rand());
  }
  return (x) => {
    let z = base;
    for (let i = 0; i < count; i++) {
      const dx = wrap(x - cx[i], -TABLE_PERIOD / 2, TABLE_PERIOD);
      if (Math.abs(dx) < r[i]) {
        z = Math.max(z, base + Math.sqrt(r[i] * r[i] - dx * dx) - 0.4 * r[i]);
      }
    }
    return z;
  };
}

interface Pine {
  /** Trunk distance from the side, base height, height, half-width at the base. */
  cx: number;
  base: number;
  h: number;
  w: number;
  tiers: number;
}

/** Half-width of a tiered pine at fraction `u` (0 base, 1 tip) of its height. */
export function pineHalfWidth(u: number, w: number, tiers: number): number {
  if (u < 0 || u > 1) {
    return -Infinity;
  }
  const f = u * tiers - Math.floor(u * tiers);
  return w * (1 - u) * (1 - 0.45 * f);
}

/**
 * A wall of pines along one side, as distance from that side: the outer envelope
 * of the trees, with everything between them and the side filled in.
 */
function pineWall(pines: readonly Pine[]): (y: number) => number {
  return (y) => {
    let d = NONE;
    for (const p of pines) {
      if (y < p.base) {
        d = Math.max(d, p.cx);
      } else {
        d = Math.max(d, p.cx + pineHalfWidth((y - p.base) / p.h, p.w, p.tiers));
      }
    }
    return d;
  };
}

function placePines(rand: () => number, t: number, ground: number): Pine[] {
  const count = 3 + Math.floor(rand() * 2);
  const reach = 0.42 - 0.24 * t;
  const tallest = 0.38 + 0.42 * t;
  const pines: Pine[] = [];
  for (let i = 0; i < count; i++) {
    const s = count > 1 ? i / (count - 1) : 0;
    const h = tallest * (1 - 0.45 * s) * (0.85 + 0.3 * rand());
    pines.push({
      cx: reach * s * (0.9 + 0.2 * rand()),
      base: ground - 0.015,
      h,
      w: h * (0.22 + 0.06 * rand()),
      tiers: 4 + Math.floor(rand() * 2),
    });
  }
  return pines;
}

// ---------------------------------------------------------------------------
// Scenes
// ---------------------------------------------------------------------------

const land = (t: number): LayerSpec => ({ role: "land", t, hasX: true, hasY: false, shapes: [] });

const decor = (role: ColorRole, shapes: ShapeSpec[]): LayerSpec => ({
  role,
  t: 0,
  hasX: false,
  hasY: false,
  shapes,
});

const shape = (kind: number, x: number, y: number, size: number, drift = 0): ShapeSpec => ({
  kind,
  x,
  y,
  size,
  drift,
});

/** Writes `count` rolling hill layers into slots from `first`, returning their specs. */
function hillLayers(
  out: Float32Array,
  rand: () => number,
  first: number,
  count: number,
  top: number,
  bottom: number,
  roughness: number,
): LayerSpec[] {
  const layers: LayerSpec[] = [];
  for (let j = 0; j < count; j++) {
    const t = count > 1 ? j / (count - 1) : 1;
    const base = top + (bottom - top) * t;
    const amp = 0.045 + 0.04 * t;
    const profile = rollingProfile(rand, 6 - 3 * t + rand(), roughness);
    writeX(out, first + j, (x) => base + amp * profile(x), null);
    layers.push({ ...land(t), band: [base - amp, base + amp] });
  }
  return layers;
}

/**
 * Builds scene `id` with `count` scenery layers (clamped to MIN_LAYERS..MAX_LAYERS):
 * fills `out` (`TABLE_ROWS * TABLE_COLUMNS * TABLE_CHANNELS` floats) and returns the
 * stack. Deterministic; slots past the stack are left absent.
 */
export function buildScene(id: SceneId, count: number, out: Float32Array): Scene {
  const n = clamp(Math.round(count), MIN_LAYERS, MAX_LAYERS);
  for (let slot = 0; slot < MAX_STACK; slot++) {
    writeX(out, slot, null, null);
    writeY(out, slot, null, null);
  }
  const rand = createRng(0x53c0 + SCENE_IDS.indexOf(id) * 977 + n * 31);
  const layers: LayerSpec[] = [];
  let stars = false;
  let boatSlot = -1;
  let waveSlot = -1;

  if (id === "hills" || id === "night") {
    if (id === "hills") {
      layers.push(decor("sun", [shape(SHAPE_DISC, 0.8, 0.75, 0.065)]));
      layers.push(
        decor("cloud", [
          shape(SHAPE_CLOUD, 0.12, 0.8, 0.045, 0.004),
          shape(SHAPE_CLOUD, 0.55, 0.88, 0.034, 0.003),
          shape(SHAPE_CLOUD, 0.92, 0.6, 0.04, 0.005),
        ]),
      );
    } else {
      stars = true;
      layers.push(decor("sun", [shape(SHAPE_CRESCENT, 0.2, 0.78, 0.06)]));
    }
    layers.push(...hillLayers(out, rand, layers.length, n, 0.52, 0.11, id === "night" ? 0.6 : 1));
  } else if (id === "ocean") {
    layers.push(decor("sun", [shape(SHAPE_DISC, 0.74, 0.5, 0.075)]));
    // The cloud frame hangs from the top, behind every wave.
    const frame = scallopFrame(rand, 11, 0.025);
    writeX(out, layers.length, null, frame);
    layers.push({ role: "cloud", t: 0, hasX: true, hasY: false, shapes: [] });
    const waves = n - 1;
    // The boat rides the second wave from the front, tucked just behind it.
    const ride = waves - 2;
    for (let j = 0; j < waves; j++) {
      const t = j / (waves - 1);
      const base = 0.42 - 0.31 * t;
      const amp = 0.018 + 0.03 * t;
      const profile = waveProfile(rand, 14 - 8 * t);
      if (j === ride) {
        boatSlot = layers.length;
        layers.push(decor("boat", [shape(SHAPE_BOAT, 0.2, 0, 0.05)]));
        waveSlot = layers.length;
      }
      writeX(out, layers.length, (x) => base + amp * profile(x), null);
      layers.push({ ...land(t), band: [base - amp, base + amp] });
    }
  } else {
    layers.push(decor("sun", [shape(SHAPE_DISC, 0.66, 0.62, 0.065)]));
    layers.push(...hillLayers(out, rand, layers.length, 2, 0.46, 0.38, 0.5));
    // Re-shade the two distant hills as the back of the forest's range.
    layers[1].t = 0;
    layers[2].t = 0.12;
    const walls = n - 2;
    for (let j = 0; j < walls; j++) {
      const t = walls > 1 ? j / (walls - 1) : 1;
      const ground = 0.3 - 0.25 * t;
      const amp = 0.012;
      const profile = rollingProfile(rand, 3, 0.4);
      const slot = layers.length;
      writeX(out, slot, (x) => ground + amp * profile(x), null);
      writeY(
        out,
        slot,
        pineWall(placePines(rand, t, ground)),
        pineWall(placePines(rand, t, ground)),
      );
      layers.push({
        role: "land",
        t: 0.25 + 0.75 * t,
        hasX: true,
        hasY: true,
        shapes: [],
        band: [ground - amp, ground + amp],
      });
    }
  }
  return { id, layers, stars, boatSlot, waveSlot };
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

export interface Palette {
  sky: string;
  back: string;
  front: string;
  sun: string;
  cloud: string;
  boat: string;
}

export const SCENE_PALETTES: Record<SceneId, Palette> = {
  hills: {
    sky: "#f3e6c8",
    back: "#bcd5a3",
    front: "#2f5d3a",
    sun: "#f2b84b",
    cloud: "#fbf7ee",
    boat: "#c8553d",
  },
  ocean: {
    sky: "#f6dcc0",
    back: "#a3d3cf",
    front: "#13426b",
    sun: "#f28c5a",
    cloud: "#fdf6ec",
    boat: "#c8553d",
  },
  forest: {
    sky: "#e9eedc",
    back: "#bfd1b5",
    front: "#1e3b2c",
    sun: "#f4d58a",
    cloud: "#fbfaf2",
    boat: "#c8553d",
  },
  night: {
    sky: "#1b2340",
    back: "#3b4772",
    front: "#0b0f20",
    sun: "#f3e7c4",
    cloud: "#c9cfe6",
    boat: "#c8553d",
  },
};

export const SHARED_PALETTES: Record<Exclude<(typeof PALETTE_IDS)[number], "scene">, Palette> = {
  sunset: {
    sky: "#fbd3a2",
    back: "#eb9b7d",
    front: "#4a2340",
    sun: "#fff1c9",
    cloud: "#fde7d0",
    boat: "#2e2a4f",
  },
  pastel: {
    sky: "#fdf3ea",
    back: "#cfe3f0",
    front: "#7d8fcf",
    sun: "#ffd6a5",
    cloud: "#ffffff",
    boat: "#f4978e",
  },
  autumn: {
    sky: "#f6e7cf",
    back: "#e7b77a",
    front: "#6b2d1a",
    sun: "#f6d36b",
    cloud: "#fff7ea",
    boat: "#2f4858",
  },
  mono: {
    sky: "#f2efe8",
    back: "#d9d4ca",
    front: "#4a463f",
    sun: "#ffffff",
    cloud: "#ffffff",
    boat: "#2b2925",
  },
};

const isSharedPalette = (v: string): v is keyof typeof SHARED_PALETTES => v in SHARED_PALETTES;

export function resolvePalette(scene: SceneId, id: string): Palette {
  return isSharedPalette(id) ? SHARED_PALETTES[id] : SCENE_PALETTES[scene];
}

/**
 * Writes each stack layer's paper colour (0..1 RGB, back first) into `out` and
 * returns the sky colour. Land layers mix from the back to the front colour.
 */
export function fillLayerColors(scene: Scene, palette: Palette, out: Float32Array): Rgb {
  const back = hexToUnitRgb(palette.back);
  const front = hexToUnitRgb(palette.front);
  scene.layers.forEach((layer, i) => {
    let c: Rgb;
    if (layer.role === "land") {
      const t = layer.t;
      c = [
        back[0] + (front[0] - back[0]) * t,
        back[1] + (front[1] - back[1]) * t,
        back[2] + (front[2] - back[2]) * t,
      ];
    } else {
      c = hexToUnitRgb(palette[layer.role]);
    }
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  });
  return hexToUnitRgb(palette.sky);
}

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

/** Parallax weight of stack slot `slot` of `count`: 0 at the back to 1 at the front. */
export const slotDepth = (slot: number, count: number) => (count > 1 ? slot / (count - 1) : 1);

/**
 * Parallax offset (height units) of a layer at `depth` (0..1) at time `t` seconds:
 * a slow Lissajous path, scaled by depth and `motion` (0..1). Writes into `out`.
 */
export function parallaxOffset(t: number, depth: number, motion: number, out: Float64Array): void {
  const a = MOTION_AMP * clamp(motion, 0, 1) * depth;
  out[0] = a * Math.sin((TAU * t) / PARALLAX_PERIOD_X);
  out[1] = a * PARALLAX_Y_SHARE * Math.sin((TAU * t) / PARALLAX_PERIOD_Y + PARALLAX_Y_PHASE);
}

/**
 * Places a shape for time `t`, in its layer's own coordinates: centre x (height
 * units, drifting shapes wrap round just past the canvas sides), centre y, and
 * rotation as cos and sin. Writes `[x, y, cos, sin]` into `out`.
 */
export function placeShape(s: ShapeSpec, t: number, aspect: number, out: Float64Array): void {
  let x = s.x * aspect;
  if (s.drift !== 0) {
    const reach = s.size * 2.5;
    x = wrap(x + s.drift * t, -reach, aspect + 2 * reach);
  }
  out[0] = x;
  out[1] = s.y;
  out[2] = 1;
  out[3] = 0;
}

/**
 * Seats the boat on its wave: `boatOff` and `waveOff` are the two layers'
 * parallax offsets. Overwrites the boat's y and rotation in `out` (from
 * `placeShape`) so it rides the wave's edge, hull tucked behind it, with a slow
 * bob and roll.
 */
export function seatBoat(
  table: Float32Array,
  waveSlot: number,
  size: number,
  t: number,
  boatOff: Float64Array,
  waveOff: Float64Array,
  out: Float64Array,
): void {
  const screenX = out[0] + boatOff[0];
  const wx = screenX - waveOff[0];
  const row = waveSlot * 2;
  const surface = sampleRow(table, row, 0, wx) + waveOff[1];
  const slope = sampleRow(table, row, 1, wx);
  const phase = (TAU * t) / BOB_PERIOD;
  out[1] = surface - boatOff[1] + 0.1 * size + BOB_LIFT * Math.sin(phase);
  const roll = 0.5 * Math.atan(slope) + BOB_ROLL * Math.sin(phase + 1.3);
  out[2] = Math.cos(roll);
  out[3] = Math.sin(roll);
}
