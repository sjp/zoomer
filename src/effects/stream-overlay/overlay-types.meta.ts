/**
 * What an overlay's metadata is made of: the slots it can occupy, the sides a
 * column overlay can take, the words for a clock-time param's label, and the
 * `OverlayMeta` shape itself. Kept apart from the registry in
 * `overlay-params.meta.ts`, so each overlay's own `.meta.ts` file can use
 * these while the registry imports that file, without a cycle.
 */
import type { ParamSchema } from "../types";

/**
 * Words for a clock-time text param's label, so the viewer knows the format and
 * that it is their own local time (a link opened in another time zone counts to
 * that zone's clock). Every example here parses with `parseClockTime`.
 */
export const CLOCK_TIME_HINT = "local time, e.g. 19:30 or 7:30pm";

/** Which side column a column overlay asks for. */
export type OverlaySide = "left" | "right";

/** Options for a column overlay's side select (values are `OverlaySide`). */
export const OVERLAY_SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

/**
 * The places round the speaker an overlay can occupy (see `overlay-layout.ts`):
 *
 * - `column`: a tall panel in the left or right third, below the top band; on
 *   portrait frames a shorter one in the bottom quarter. Its side comes from the
 *   overlay's side select, and two column overlays never share a side.
 * - `topLeft`, `topCentre`, `topRight`: thirds of the band along the top.
 * - `border`: just inside the speaker area, for a frame drawn behind them.
 * - `edges`: the outer thirds at full height, behind the columns; drawn with
 *   sprites rather than the panel canvas.
 */
export type OverlaySlot = "column" | "topLeft" | "topCentre" | "topRight" | "border" | "edges";

/** What the app knows about an overlay before its code loads. */
export interface OverlayMeta {
  /** Short lowercase id, unique among overlays. */
  readonly id: string;
  /** The key of its on/off toggle in the "Overlays" group: `ov` plus a capitalised name. */
  readonly toggle: string;
  /** The toggle's label, such as "Chat". */
  readonly label: string;
  /**
   * The slots it draws in. Only `column` is shared (two column overlays take a
   * side each); every other slot belongs to one overlay.
   */
  readonly slots: readonly OverlaySlot[];
  /**
   * For a column overlay: the key, among its own `params`, of its side select
   * (options `OVERLAY_SIDE_OPTIONS`).
   */
  readonly sideKey?: string;
  /**
   * Its own options, each with a `group` named after the overlay ("Chat",
   * "Splits") and a key that starts with its prefix where it can. The keys are
   * part of the URL hash: choose them once and never rename them.
   */
  readonly params: ParamSchema;
}
