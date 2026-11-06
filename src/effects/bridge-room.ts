/**
 * Starship Bridge room: the fixed camera, the aft wall (a shallow vertical
 * cylinder), the wooden rail in front of it and where everything sits on the wall.
 *
 * World space is in metres: x to the right, y up from the deck, z forward from the
 * camera towards the aft wall. Positions on the wall are (s, y): s is arc length
 * along the wall from its centre line (positive to the right) and y is height.
 * Everything here is pure, and the shaders use the same constants (interpolated
 * with `glslFloat`), so the tests can check the framing.
 */
import type { DisplaySide } from "./bridge.meta";

/** Camera eye height: seated, about where the command chairs are. */
export const EYE_Y = 1.22;
/** Upward camera pitch (radians), so the rail and the top of the wall both fit. */
export const PITCH = (5 * Math.PI) / 180;
/** Vertical field of view (radians). */
export const FOV_Y = (52 * Math.PI) / 180;
export const TAN_HALF_FOV = Math.tan(FOV_Y / 2);

/** The aft wall: a cylinder of radius `WALL_R` about a vertical axis at z = `WALL_CZ`. */
export const WALL_CZ = -2.5;
export const WALL_R = 6.7;
/** Ceiling height; the wall runs from the deck up to it. */
export const CEILING_Y = 2.85;

/** The rail: a ring about a vertical axis at z = `RAIL_CZ`. */
export const RAIL_CZ = -0.6;
/** Inner and outer radius of the wooden cap. */
export const RAIL_IN = 2.1;
export const RAIL_OUT = 2.4;
/** Height of the cap's top, and its thickness. */
export const RAIL_TOP = 1.0;
export const RAIL_CAP = 0.075;
/** Radius of the rail's front (camera-side) face below the cap. */
export const RAIL_FACE = 2.16;

/** The console ledge along the middle stations: a curved shelf on the wall. */
export const LEDGE_TOP = 0.92;
export const LEDGE_BOTTOM = 0.84;
export const LEDGE_DEPTH = 0.3;
export const LEDGE_S = 1.82;

/** Wall panels' glass, bottom and top. */
export const PANEL_Y0 = 0.95;
export const PANEL_Y1 = 2.0;
/** Width of the beige frame (bezel) around each panel's glass. */
export const BEZEL = 0.04;
/** The long strip of panel graphics above the stations. */
export const BAND_Y0 = 2.1;
export const BAND_Y1 = 2.34;
export const BAND_S = 2.7;
/** Cove light at the top of the wall, below the ceiling. */
export const COVE_Y0 = 2.56;
export const COVE_Y1 = 2.66;

/** The turbolift doors, one at each side: inner edge, outer edge and height. */
export const DOOR_S0 = 2.9;
export const DOOR_S1 = 3.9;
export const DOOR_TOP = 2.36;
/** Alert lights: a narrow vertical lens just inside each door. */
export const LENS_S0 = 2.79;
export const LENS_S1 = 2.84;
export const LENS_Y0 = 0.95;
export const LENS_Y1 = 2.3;

/**
 * The area of the wall the panel atlas covers: every panel, the band and the
 * outside-view display, plus a margin for their glow.
 */
export const ATLAS_S0 = -2.76;
export const ATLAS_S1 = 2.76;
export const ATLAS_Y0 = 0.9;
export const ATLAS_Y1 = 2.4;
/** Widest atlas allowed, in texels (WebGL2 guarantees at least 2048; most allow 4096+). */
export const ATLAS_MAX_WIDTH = 4096;

export type PanelKind = "bank" | "readout" | "sweep" | "graph" | "schematic" | "display" | "band";

/** A rectangle on the wall, in (s, y) metres. */
export interface WallRect {
  s0: number;
  s1: number;
  y0: number;
  y1: number;
}

export interface PanelSpec extends WallRect {
  kind: PanelKind;
  /** How busy its blocks are, relative to the `activity` param (the centre is quieter). */
  busy: number;
}

export interface BridgeLayout {
  /** Every panel with glass, the band included (which has none: its rect is its strip). */
  panels: PanelSpec[];
  /** The outside-view display's glass, or null when it shows a panel instead. */
  display: WallRect | null;
  /** The display's picture area inside its glass (below its header bar). */
  viewport: WallRect | null;
}

const panel = (kind: PanelKind, s0: number, s1: number, busy: number): PanelSpec => ({
  kind,
  s0,
  s1,
  y0: PANEL_Y0,
  y1: PANEL_Y1,
  busy,
});

/**
 * Where the panels sit on the wall. From left to right: the outer panel, a
 * station, two quieter panels in the middle (behind the speaker), another
 * station and the other outer panel. One outer panel is the outside-view
 * display, unless the view is off, when both are panels.
 */
export function bridgeLayout(display: DisplaySide, showView: boolean): BridgeLayout {
  const outerL: [number, number] = [-2.7, -1.86];
  const outerR: [number, number] = [1.86, 2.7];
  const viewSide = showView ? display : null;
  const panels: PanelSpec[] = [
    viewSide === "left" ? panel("display", ...outerL, 0.5) : panel("bank", ...outerL, 1),
    panel("readout", -1.78, -1.1, 1),
    panel("sweep", -1.0, -0.06, 0.5),
    panel("schematic", 0.06, 1.0, 0.4),
    panel("graph", 1.1, 1.78, 1),
    viewSide === "right" ? panel("display", ...outerR, 0.5) : panel("bank", ...outerR, 1),
    { kind: "band", s0: -BAND_S, s1: BAND_S, y0: BAND_Y0, y1: BAND_Y1, busy: 0.7 },
  ];
  const shown = panels.find((p) => p.kind === "display");
  if (!shown) {
    return { panels, display: null, viewport: null };
  }
  const glass = { s0: shown.s0, s1: shown.s1, y0: shown.y0, y1: shown.y1 };
  const m = 0.03;
  return {
    panels,
    display: glass,
    viewport: { s0: glass.s0 + m, s1: glass.s1 - m, y0: glass.y0 + m, y1: glass.y1 - 0.16 },
  };
}

/** Camera basis: forward and up (right is +x), for this pitch. */
export const FORWARD = [0, Math.sin(PITCH), Math.cos(PITCH)] as const;
export const UP = [0, Math.cos(PITCH), -Math.sin(PITCH)] as const;

/** A wall position (s, y) in world space. */
export function wallPoint(s: number, y: number): [number, number, number] {
  const a = s / WALL_R;
  return [WALL_R * Math.sin(a), y, WALL_CZ + WALL_R * Math.cos(a)];
}

/**
 * Projects a world point to normalised device coordinates (-1..1 across the
 * frame, y up) for this aspect ratio, and returns its depth along the view axis.
 */
export function project(
  p: readonly [number, number, number],
  aspect: number,
): { x: number; y: number; depth: number } {
  const rx = p[0];
  const ry = p[1] - EYE_Y;
  const rz = p[2];
  const depth = ry * FORWARD[1] + rz * FORWARD[2];
  const up = ry * UP[1] + rz * UP[2];
  return { x: rx / depth / (TAN_HALF_FOV * aspect), y: up / depth / TAN_HALF_FOV, depth };
}

/** World-space ray direction (not normalised) through NDC (x, y). */
export function rayDir(x: number, y: number, aspect: number): [number, number, number] {
  const ax = x * TAN_HALF_FOV * aspect;
  const ay = y * TAN_HALF_FOV;
  return [ax, FORWARD[1] + ay * UP[1], FORWARD[2] + ay * UP[2]];
}

/**
 * Where a ray from the eye meets the wall, as (s, y), or null if it misses (it
 * always hits for rays in frame). `d` need not be normalised.
 */
export function wallHit(d: readonly [number, number, number]): { s: number; y: number } | null {
  // |(0, -WALL_CZ) + t (dx, dz)|^2 = R^2, far root (the eye is inside the cylinder).
  const a = d[0] * d[0] + d[2] * d[2];
  const b = -WALL_CZ * d[2];
  const c = WALL_CZ * WALL_CZ - WALL_R * WALL_R;
  const disc = b * b - a * c;
  if (a <= 0 || disc < 0) {
    return null;
  }
  const t = (-b + Math.sqrt(disc)) / a;
  const x = t * d[0];
  const z = t * d[2];
  return { s: WALL_R * Math.atan2(x, z - WALL_CZ), y: EYE_Y + t * d[1] };
}

/**
 * Texels per metre for the panel atlas at this canvas height: the wall's largest
 * on-screen scale over the atlas area, so panel text and edges stay sharp, capped
 * so the atlas is at most `ATLAS_MAX_WIDTH` (or `maxSize`) texels wide.
 */
export function atlasTexelsPerMetre(height: number, maxSize = ATLAS_MAX_WIDTH): number {
  const focal = height / 2 / TAN_HALF_FOV;
  let minDepth = Number.POSITIVE_INFINITY;
  for (const s of [ATLAS_S0, 0, ATLAS_S1]) {
    for (const y of [ATLAS_Y0, ATLAS_Y1]) {
      minDepth = Math.min(minDepth, project(wallPoint(s, y), 1).depth);
    }
  }
  const tpm = focal / minDepth;
  const widest = Math.min(maxSize, ATLAS_MAX_WIDTH) / (ATLAS_S1 - ATLAS_S0);
  return Math.max(16, Math.min(tpm, widest));
}
