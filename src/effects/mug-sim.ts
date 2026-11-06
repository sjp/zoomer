/**
 * Pure JS side of the Steaming Mug effect (mug.ts): the mug's layout in its
 * corner, the steam emitter and draft (configuring the smoke model in
 * smoke-sim.ts), and the drink and room palettes.
 *
 * Screen units are "height units": x runs 0..aspect across the canvas and y
 * 0..1 from the bottom up, so the mug keeps its size and shape at any aspect
 * ratio. The steam runs in its own "sim space": centred on the liquid's
 * surface and scaled up by STEAM_SCALE, so the smoke model's curls, sized for
 * a whole canvas, come out small enough for a mug.
 */
import type { ShelfPalette } from "./bookshelf";
import { clamp } from "./math";
import type { DrinkId, RoomId } from "./mug.meta";
import type { Flow } from "./smoke-sim";
import { lookup } from "./lookup";

/** Mug body radius and height, and the rim's ellipse ratio (minor / major) seen from above. */
export const MUG_R = 0.075;
export const MUG_H = 0.17;
export const MUG_K = 0.3;
/** Rim thickness, and how far the liquid sits below the rim. */
export const MUG_WALL = 0.0065;
export const LIQUID_DROP = 0.024;
/** Handle: gap from the body's side to the ring's centre, centre height, radii and half-thickness. */
export const HANDLE_DX = 0.024;
export const HANDLE_Y = 0.088;
export const HANDLE_RX = 0.04;
export const HANDLE_RY = 0.05;
export const HANDLE_TH = 0.0105;
/** Shadow on the table: centre offset (towards the inner side), radii and edge softness. */
export const SHADOW_DX = -0.024;
export const SHADOW_RX = MUG_R * 1.3;
export const SHADOW_RY = MUG_R * MUG_K * 1.45;
export const SHADOW_SOFT = 0.035;

/** Mug centre's distance from its frame edge, and the base ellipse's centre height. */
export const MUG_EDGE_X = 0.27;
export const MUG_BASE_Y = 0.075;
/** The table's far edge, behind the mug. */
export const TABLE_Y = 0.19;

/** Steam box above the mug: half-width, bottom below the rim, and top (height units). */
export const STEAM_HALF_W = 0.18;
export const STEAM_BELOW_RIM = 0.035;
export const STEAM_TOP = 0.62;
/** Sim units per height unit. */
export const STEAM_SCALE = 3;
/** Steam grid cell size, 1080p reference px; the grid is the same at every resolution. */
export const STEAM_CELL_REF = 3;

export interface MugLayout {
  /** Outer direction: +1 if the mug is in the bottom-right corner, -1 bottom-left. */
  side: 1 | -1;
  /** Mug centre x and base ellipse centre y. */
  cx: number;
  baseY: number;
  /** Liquid surface centre height: the steam source and sim-space origin. */
  liquidY: number;
  /** Mug pass bounds (body, handle and shadow): x0, y0, x1, y1. */
  box: [number, number, number, number];
  /** Steam box, clamped to the frame: x0, y0, x1, y1. */
  steam: [number, number, number, number];
}

export const createLayout = (): MugLayout => ({
  side: 1,
  cx: 0,
  baseY: 0,
  liquidY: 0,
  box: [0, 0, 0, 0],
  steam: [0, 0, 0, 0],
});

/** Half a pixel of slack around the box at 1080p, for the antialiased edges. */
const BOX_PAD = 0.004;

/** Lays the mug out in its corner of an `aspect`-wide frame. */
export function mugLayout(aspect: number, position: string, out: MugLayout): MugLayout {
  const side = position === "left" ? -1 : 1;
  const a = Math.max(aspect, 2 * MUG_EDGE_X);
  out.side = side;
  out.cx = side > 0 ? a - MUG_EDGE_X : MUG_EDGE_X;
  out.baseY = MUG_BASE_Y;
  out.liquidY = MUG_BASE_Y + MUG_H - LIQUID_DROP;
  // Local x runs towards the outer side; the handle is on it, the shadow falls inwards.
  const outer = MUG_R + HANDLE_DX + HANDLE_RX + HANDLE_TH + BOX_PAD;
  const inner = -SHADOW_DX + SHADOW_RX + SHADOW_SOFT + BOX_PAD;
  const lx0 = side > 0 ? -inner : -outer;
  const lx1 = side > 0 ? outer : inner;
  out.box[0] = out.cx + lx0;
  out.box[1] = MUG_BASE_Y - SHADOW_RY - SHADOW_SOFT - BOX_PAD;
  out.box[2] = out.cx + lx1;
  out.box[3] = MUG_BASE_Y + MUG_H + MUG_R * MUG_K + BOX_PAD;
  out.steam[0] = Math.max(0, out.cx - STEAM_HALF_W);
  out.steam[1] = MUG_BASE_Y + MUG_H - STEAM_BELOW_RIM;
  out.steam[2] = Math.min(a, out.cx + STEAM_HALF_W);
  out.steam[3] = STEAM_TOP;
  return out;
}

/** The steam box in sim units (x0, y0, width, height), for the field's `uRegion`. */
export function steamRegion(l: MugLayout, out: Float64Array): void {
  out[0] = (l.steam[0] - l.cx) * STEAM_SCALE;
  out[1] = (l.steam[1] - l.liquidY) * STEAM_SCALE;
  out[2] = (l.steam[2] - l.steam[0]) * STEAM_SCALE;
  out[3] = (l.steam[3] - l.steam[1]) * STEAM_SCALE;
}

/** Steam grid size in cells, written to `out`: fixed, from the box at 1080p. */
export function steamGrid(l: MugLayout, out: Int32Array | number[]): void {
  out[0] = Math.max(1, Math.ceil(((l.steam[2] - l.steam[0]) * 1080) / STEAM_CELL_REF));
  out[1] = Math.max(1, Math.ceil(((l.steam[3] - l.steam[1]) * 1080) / STEAM_CELL_REF));
}

/** Emitter settings for the smoke field, in sim units. */
export interface SteamEmitter {
  /** Splat strength (0: no new steam). */
  strength: number;
  /** Seconds for density to fall by e at the surface. */
  life: number;
  /** Wisp modulation along the surface (see `wispFactor` in smoke-sim.ts). */
  wisp: number;
}

/** Emitter segment half-width and splat radius, sim units. */
export const STEAM_HALF_WIDTH = (MUG_R - MUG_WALL) * 0.6 * STEAM_SCALE;
export const STEAM_RADIUS = 0.018;
/** Life at steam 0 and 1, and the extra fade per sim unit of height. */
export const STEAM_LIFE = [1.1, 2.1] as const;
export const STEAM_HEIGHT_DECAY = 0.5;
/** Wisp amount at steam 0 and 1: more steam fills in between the wisps. */
export const STEAM_WISP = [0.9, 0.6] as const;
/** Wisps per sim unit along the surface, and their drift (rad/s). */
export const WISP_K = 70;
export const WISP_SPEED = 0.5;

/** Maps the `steam` param (0..1) to bounded emitter values. */
export function steamEmitter(steam: number, out: SteamEmitter): SteamEmitter {
  const s = clamp(Number.isFinite(steam) ? steam : 0, 0, 1);
  out.strength = s;
  out.life = STEAM_LIFE[0] + (STEAM_LIFE[1] - STEAM_LIFE[0]) * s;
  out.wisp = STEAM_WISP[0] + (STEAM_WISP[1] - STEAM_WISP[0]) * s;
  return out;
}

/** Steam rise (sim units/s), curl strength, and the band over which the curl sets in. */
export const STEAM_RISE = 0.3;
export const STEAM_CURL = 3.2;
export const STEAM_ONSET = [0, 0.45] as const;

/** Fills the parts of the smoke flow that don't depend on time. */
export function steamFlow(out: Flow): Flow {
  out.rise = STEAM_RISE;
  out.curl = STEAM_CURL;
  out.onset0 = STEAM_ONSET[0];
  out.onset1 = STEAM_ONSET[1];
  return out;
}

/** Peak gust and steady lean at draft 1, sim units/s per sim unit of height. */
export const DRAFT_GUST = 0.3;
export const DRAFT_LEAN = 0.05;
/** Periods (seconds) of the two sines whose product makes the gusts. */
const GUST_A = 41;
const GUST_B = 97;

/**
 * The draft's horizontal speed per unit of height at time `t` (seconds,
 * unwrapped), for the smoke flow's `draft`: a slight steady lean towards the
 * outer `side`, plus gusts from a product of two slow sines, squared (keeping
 * its sign) so the air is still most of the time and now and then leans the
 * steam one way or the other. Smooth in `t`, and 0 at draft 0.
 */
export function mugDraft(draft: number, t: number, side: number): number {
  const d = clamp(Number.isFinite(draft) ? draft : 0, 0, 1);
  const g = Math.sin((2 * Math.PI * t) / GUST_A) * Math.sin((2 * Math.PI * t) / GUST_B + 1);
  return d * (DRAFT_GUST * g * Math.abs(g) + DRAFT_LEAN * Math.sign(side));
}

export interface DrinkLook {
  /** Liquid colour in the shade. */
  color: string;
  /** Strength of the room light's reflection on the surface. */
  shine: number;
}

export const DRINKS: Readonly<Record<DrinkId, DrinkLook>> = {
  tea: { color: "#5a2a0c", shine: 0.55 },
  coffee: { color: "#1e100a", shine: 0.6 },
  chocolate: { color: "#4a2a1c", shine: 0.35 },
};

/** The look for a select value; unknown values fall back to tea. */
export function drinkFor(id: string): DrinkLook {
  return lookup(DRINKS, id, "tea");
}

export interface RoomLook {
  /** 0: warm wall, 1: window, 2: shelves (the room shader's branch). */
  kind: number;
  wall: string;
  table: string;
  /** Key light colour: lamp, window or shelf lamp. */
  light: string;
  /** Ambient light level on the mug and steam. */
  ambient: number;
}

export const ROOMS: Readonly<Record<RoomId, RoomLook>> = {
  wall: { kind: 0, wall: "#8a5a3c", table: "#5c3d28", light: "#ffc88a", ambient: 0.32 },
  window: { kind: 1, wall: "#6a5446", table: "#7a5a42", light: "#fff0da", ambient: 0.42 },
  shelves: { kind: 2, wall: "#5e4836", table: "#4e3424", light: "#ffbf78", ambient: 0.3 },
};

/** The room for a select value; unknown values fall back to the warm wall. */
export function roomFor(id: string): RoomLook {
  return lookup(ROOMS, id, "wall");
}

/** The "Shelves" room's bookcases (the Library Window bookshelf texture), with a fixed layout seed. */
export const SHELF_PALETTE: ShelfPalette = {
  wood: "#6e4c32",
  back: "#2e2018",
  spines: ["#6b3a26", "#4a5a3a", "#7a2c2c", "#d8c9a3", "#5a4030", "#2f4a45", "#9c7a4a", "#3c2a22"],
};
export const SHELF_SEED = 11;
