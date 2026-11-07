/**
 * Mission Control room: the fixed camera in the back row, the tiers of consoles
 * stepping down towards the front wall, the screens on that wall, and each
 * console's seeded layout of CRTs, push-buttons and clutter.
 *
 * World space is in metres: x to the right, y up from the camera's floor, z
 * forward from the camera towards the front wall. Everything here is pure, and
 * the shaders use the same constants (interpolated with `glslFloat`), so the
 * tests can check the framing.
 */
import type { Block } from "../bridge/bridge-panels";
import { smoothstep } from "../math";
import { createRng, hash32 } from "../noise";
import { TELEMETRY_LINES } from "./missioncontrol-text";

/** Camera eye height above the back row's floor. */
export const EYE_Y = 1.2;
/** Camera pitch (radians): level, so the wall fills the top and the consoles the bottom. */
export const PITCH = 0;
/** Vertical field of view (radians). */
export const FOV_Y = (50 * Math.PI) / 180;
export const TAN_HALF_FOV = Math.tan(FOV_Y / 2);

/** The front wall: a plane at z = `WALL_Z`, from the pit floor up to the ceiling. */
export const WALL_Z = 11;
export const CEILING_Y = 6.2;
/** Floor in front of the last row. */
export const PIT_Y = -1.2;
/** Side walls, at x = ±`ROOM_HALF`. */
export const ROOM_HALF = 10.5;

/** Rows of consoles, front edge of the nearest, and the spacing between rows. */
export const ROWS = 4;
export const ROW_Z0 = 1.4;
export const ROW_DZ = 2;
/**
 * Floor of the nearest row, and the step down to each further row. The back
 * row stands well above the rest, so the camera looks down over every tier.
 */
export const FLOOR0 = -0.9;
export const STEP = 0.1;

/**
 * A console's profile, from its front edge (z) and floor (y): a desk, a short
 * lip, a face sloping back with the screens and buttons, then a flat top.
 */
export const DESK_H = 0.74;
export const DESK_D = 0.42;
export const FACE_Y0 = 0.8;
export const FACE_Z1 = 0.58;
export const FACE_Y1 = 1.2;
export const TOP_Z1 = 0.82;
/** Length of the sloping face, bottom to top. */
export const FACE_LEN = Math.hypot(FACE_Z1 - DESK_D, FACE_Y1 - FACE_Y0);

/** Console units per row, and their width. */
export const UNITS = 18;
export const UNIT_W = 1.1;
export const UNIT_COUNT = ROWS * UNITS;

/** Floor height of row `k`. */
export const rowFloor = (k: number) => FLOOR0 - STEP * k;
/** Front edge (z) of row `k`'s desks. */
export const rowZ = (k: number) => ROW_Z0 + ROW_DZ * k;
/** Left end (x) of row `k`: alternate rows shift by a quarter unit each way. */
export const rowX0 = (k: number) => -0.5 * UNITS * UNIT_W + ((k % 2) - 0.5) * 0.5 * UNIT_W;

/** A rectangle on the front wall (x, y) or a console face (along the unit, up the face), metres. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type WallScreenId = "map" | "telemetry" | "tv" | "clock" | "countdown" | "graphs";

/**
 * The wall's screens. The map spans the middle, behind the speaker; the busy
 * screens, clock and countdown sit in the left and right thirds.
 */
export const WALL_SCREENS: Readonly<Record<WallScreenId, Rect>> = {
  map: { x0: -4.45, y0: 0.3, x1: 4.45, y1: 4.75 },
  telemetry: { x0: -8.6, y0: 2.6, x1: -4.8, y1: 4.75 },
  tv: { x0: -7.47, y0: 0.3, x1: -4.8, y1: 2.3 },
  clock: { x0: 4.8, y0: 3.75, x1: 8.6, y1: 4.75 },
  countdown: { x0: 4.8, y0: 2.4, x1: 8.6, y1: 3.5 },
  graphs: { x0: 4.8, y0: 0.3, x1: 8.6, y1: 2.15 },
};

/** Camera basis: forward and up (right is +x), for this pitch. */
export const FORWARD = [0, Math.sin(PITCH), Math.cos(PITCH)] as const;
export const UP = [0, Math.cos(PITCH), -Math.sin(PITCH)] as const;

/**
 * Projects a world point to normalised device coordinates (-1..1 across the
 * frame, y up) for this aspect ratio, and returns its depth along the view axis.
 */
export function project(
  p: readonly [number, number, number],
  aspect: number,
): { x: number; y: number; depth: number } {
  const ry = p[1] - EYE_Y;
  const depth = ry * FORWARD[1] + p[2] * FORWARD[2];
  const up = ry * UP[1] + p[2] * UP[2];
  return { x: p[0] / depth / (TAN_HALF_FOV * aspect), y: up / depth / TAN_HALF_FOV, depth };
}

/** World-space ray direction (not normalised) through NDC (x, y). */
export function rayDir(x: number, y: number, aspect: number): [number, number, number] {
  const ax = x * TAN_HALF_FOV * aspect;
  const ay = y * TAN_HALF_FOV;
  return [ax, FORWARD[1] + ay * UP[1], FORWARD[2] + ay * UP[2]];
}

/** Where a ray from the eye meets the front wall, as (x, y). */
export function wallHit(d: readonly [number, number, number]): { x: number; y: number } {
  const t = WALL_Z / d[2];
  return { x: d[0] * t, y: EYE_Y + d[1] * t };
}

/** World position of a point on row `k`'s face: `x` across, `f` metres up the face. */
export function facePoint(k: number, x: number, f: number): [number, number, number] {
  const a = f / FACE_LEN;
  return [
    x,
    rowFloor(k) + FACE_Y0 + a * (FACE_Y1 - FACE_Y0),
    rowZ(k) + DESK_D + a * (FACE_Z1 - DESK_D),
  ];
}

/* ----- Console layouts ----- */

export type ScreenMode = "numbers" | "graph" | "off";
export const SCREEN_MODES: readonly ScreenMode[] = ["numbers", "graph", "off"];

/** One console unit's face and top, in unit-local metres: x along the unit, y up the face. */
export interface ConsoleUnit {
  row: number;
  /** Unit index along its row. */
  index: number;
  /** One or two CRTs. */
  screens: { rect: Rect; mode: ScreenMode; graphRow: number }[];
  /** A grid of push-buttons. */
  bank: Rect;
  cols: number;
  rows: number;
  /** Something on the top: none, a coffee cup or an ashtray, and where along the unit. */
  clutter: "none" | "cup" | "ashtray";
  clutterX: number;
  /** How busy its blocks are, relative to `activity`: the middle, behind the speaker, is quieter. */
  busy: number;
}

/** Blocks per unit: two screens, then up to 16 buttons. */
export const BLOCKS_PER_UNIT = 18;
export const MAX_BUTTONS = BLOCKS_PER_UNIT - 2;
/** Rows of the graph texture: the wall's three graphs, then the CRTs' (shared round-robin). */
export const GRAPH_ROWS = 32;
export const WALL_GRAPH_ROWS = 3;
/** Texels per unit in the layout table, four floats each. */
export const TABLE_TEXELS = 5;

/** Block index of unit `u`'s slot `slot` (0, 1 the screens; 2 on the buttons). */
export const unitBlock = (u: number, slot: number) => 1 + u * BLOCKS_PER_UNIT + slot;
/** Block index of wall telemetry line `i`. */
export const telemetryBlock = (i: number) => 1 + UNIT_COUNT * BLOCKS_PER_UNIT + i;
export const BLOCK_COUNT = telemetryBlock(TELEMETRY_LINES);

/** Size of a CRT on a face, and where screens sit. */
export const SCREEN_W = 0.32;
export const SCREEN_H = 0.24;
const SCREEN_Y0 = 0.16;
const LEFT_X0 = 0.12;
const RIGHT_X0 = 0.66;

export interface ConsoleLayout {
  units: ConsoleUnit[];
  /** Index 0 is "no block". */
  blocks: Block[];
  /** Chase groups (one per row of buttons). */
  groups: number;
  /** `UNIT_COUNT` rows of `TABLE_TEXELS` RGBA texels; see `consoleLayout`. */
  table: Float32Array;
}

const modeIndex = (m: ScreenMode) => SCREEN_MODES.indexOf(m);

/** A CRT at `x0` along the unit: mostly numbers, some graphs, a few switched off. */
function makeScreen(rng: () => number, x0: number): ConsoleUnit["screens"][number] {
  const r = rng();
  return {
    rect: { x0, y0: SCREEN_Y0, x1: x0 + SCREEN_W, y1: SCREEN_Y0 + SCREEN_H },
    mode: r < 0.1 ? "off" : r < 0.4 ? "graph" : "numbers",
    graphRow: 0,
  };
}

/**
 * Every console unit's layout, deterministic per seed, with its blocks and the
 * shaders' table. Each table row (one unit, row-major by console row) holds:
 * screen A's rect, screen B's rect (empty if none), the button bank's rect,
 * (bank columns, bank rows, mode A, mode B; mode 3 for no screen), and
 * (clutter 0-2, clutter x, graph row A, graph row B).
 */
export function consoleLayout(seed: number): ConsoleLayout {
  const units: ConsoleUnit[] = [];
  const blocks: Block[] = [
    { kind: "widget", colour: 0, alt: 0, level: 0, busy: 0, group: -1, order: 0 },
  ];
  const table = new Float32Array(UNIT_COUNT * TABLE_TEXELS * 4);
  let groups = 0;
  let graphs = 0;
  for (let k = 0; k < ROWS; k++) {
    for (let i = 0; i < UNITS; i++) {
      const u = k * UNITS + i;
      const rng = createRng(hash32((Math.floor(seed) * 977 + u * 131 + 17) >>> 0));
      const centre = rowX0(k) + (i + 0.5) * UNIT_W;
      const busy = 0.35 + 0.65 * smoothstep(1, 3.2, Math.abs(centre));
      let bank: Rect;
      let cols: number;
      let rows: number;
      const screens: ConsoleUnit["screens"] = [];
      if (rng() < 0.55) {
        screens.push(makeScreen(rng, LEFT_X0), makeScreen(rng, RIGHT_X0));
        bank = { x0: LEFT_X0, y0: 0.035, x1: RIGHT_X0 + SCREEN_W, y1: 0.115 };
        cols = 8;
        rows = 2;
      } else {
        const left = rng() < 0.5;
        screens.push(makeScreen(rng, left ? LEFT_X0 : RIGHT_X0));
        const bx = left ? RIGHT_X0 : LEFT_X0;
        bank = {
          x0: bx + 0.02,
          y0: SCREEN_Y0 + 0.01,
          x1: bx + SCREEN_W - 0.02,
          y1: SCREEN_Y0 + SCREEN_H - 0.01,
        };
        cols = 3 + Math.floor(rng() * 2);
        rows = 3 + Math.floor(rng() * 2);
      }
      for (const sc of screens) {
        if (sc.mode === "graph") {
          sc.graphRow = WALL_GRAPH_ROWS + (graphs++ % (GRAPH_ROWS - WALL_GRAPH_ROWS));
        }
      }
      const r = rng();
      const clutter = r < 0.22 ? "cup" : r < 0.34 ? "ashtray" : "none";
      const clutterX = 0.15 + 0.8 * rng();
      units.push({ row: k, index: i, screens, bank, cols, rows, clutter, clutterX, busy });

      // Blocks: the two screen slots, then the buttons, row by row from the top.
      for (let s = 0; s < 2; s++) {
        const sc = s < screens.length ? screens[s] : null;
        blocks.push({
          kind: sc ? "readout" : "widget",
          colour: 0,
          alt: 0,
          level: sc && sc.mode !== "off" ? 0.8 + 0.2 * rng() : 0,
          busy,
          group: -1,
          order: 0,
        });
      }
      const groupBase = groups;
      groups += rows;
      for (let b = 0; b < MAX_BUTTONS; b++) {
        const used = b < cols * rows;
        const colour = Math.floor(rng() * 5);
        blocks.push({
          kind: used ? "button" : "widget",
          colour,
          alt: (colour + 2) % 5,
          level: used && rng() < 0.55 ? 0.45 + 0.55 * rng() : 0,
          busy: busy * 0.6,
          group: used ? groupBase + Math.floor(b / cols) : -1,
          order: b % cols,
        });
      }

      const o = u * TABLE_TEXELS * 4;
      const a = screens[0];
      const b2 = screens.length > 1 ? screens[1] : null;
      table.set([a.rect.x0, a.rect.y0, a.rect.x1, a.rect.y1], o);
      if (b2) {
        table.set([b2.rect.x0, b2.rect.y0, b2.rect.x1, b2.rect.y1], o + 4);
      }
      table.set([bank.x0, bank.y0, bank.x1, bank.y1], o + 8);
      table.set([cols, rows, modeIndex(a.mode), b2 ? modeIndex(b2.mode) : 3], o + 12);
      table.set(
        [
          clutter === "cup" ? 1 : clutter === "ashtray" ? 2 : 0,
          clutterX,
          a.graphRow,
          b2 ? b2.graphRow : 0,
        ],
        o + 16,
      );
    }
  }
  for (let i = 0; i < TELEMETRY_LINES; i++) {
    blocks.push({ kind: "readout", colour: 0, alt: 0, level: 1, busy: 1, group: -1, order: 0 });
  }
  return { units, blocks, groups, table };
}
