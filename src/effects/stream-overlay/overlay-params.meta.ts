/**
 * The stream overlays' params and registry: the metadata half, which the
 * streamer scenes' `.meta.ts` files import, so it ships in the entry chunk and
 * may import only types and other metadata at runtime. The renderer half,
 * `overlay-layer.ts`, pairs each entry here with its implementation.
 *
 * A streamer scene spreads `streamOverlayParams(...)` into its `params`. That
 * gives it an "Overlays" group (a toggle per overlay, the shared accent colour
 * and panel opacity) followed by each overlay's own group of options. Adding an
 * overlay to `OVERLAY_METAS` (and its implementation to `overlay-layer.ts`)
 * gives it to every scene that uses the layer, without editing the scenes.
 */
import type { ParamDef, ParamSchema } from "../types";

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

/**
 * Every overlay, in registration order: the order of the toggles, of each
 * overlay's group in the panel, and of precedence when two column overlays
 * want the same side (the earlier one keeps it).
 */
export const OVERLAY_METAS: readonly OverlayMeta[] = [];

/** The group holding the toggles and the shared look. */
export const OVERLAYS_GROUP = "Overlays";

/** Shared keys every scene using the layer gets, whatever overlays exist. */
export const OVERLAY_ACCENT_KEY = "ovAccent";
export const OVERLAY_OPACITY_KEY = "ovOpacity";

/**
 * Words for a clock-time text param's label, so the viewer knows the format and
 * that it is their own local time (a link opened in another time zone counts to
 * that zone's clock). Every example here parses with `parseClockTime`.
 */
export const CLOCK_TIME_HINT = "local time, e.g. 19:30 or 7:30pm";

/** A scene's default for each overlay toggle, by toggle key. Missing ones default to off. */
export type OverlayToggleDefaults = Readonly<Record<string, boolean>>;

/**
 * The params a streamer scene spreads into its own (after its own keys): the
 * "Overlays" group (a toggle per overlay in `metas`, defaulting to `defaults`
 * or off, then the accent colour and panel opacity), then each overlay's own
 * params in registration order.
 *
 * Throws on a default for an unknown toggle, a key used twice, or a column
 * overlay without a valid side select, so a mistake fails every test that
 * loads the registry rather than silently dropping a param.
 */
export function streamOverlayParams(
  defaults: OverlayToggleDefaults = {},
  metas: readonly OverlayMeta[] = OVERLAY_METAS,
): ParamSchema {
  const out: Record<string, ParamDef> = {};
  const put = (key: string, def: ParamDef) => {
    if (Object.hasOwn(out, key)) {
      throw new Error(`Stream overlay param key "${key}" is used twice`);
    }
    out[key] = def;
  };
  const toggles = new Set(metas.map((m) => m.toggle));
  for (const key of Object.keys(defaults)) {
    if (!toggles.has(key)) {
      throw new Error(`No stream overlay has the toggle "${key}"`);
    }
  }
  for (const meta of metas) {
    put(meta.toggle, {
      kind: "boolean",
      label: meta.label,
      group: OVERLAYS_GROUP,
      default: defaults[meta.toggle] ?? false,
    });
  }
  put(OVERLAY_ACCENT_KEY, {
    kind: "color",
    label: "Accent",
    group: OVERLAYS_GROUP,
    default: "#a48cf0",
  });
  put(OVERLAY_OPACITY_KEY, {
    kind: "number",
    label: "Panel opacity",
    group: OVERLAYS_GROUP,
    min: 0.4,
    max: 1,
    step: 0.05,
    default: 0.85,
  });
  for (const meta of metas) {
    const columns = meta.slots.includes("column");
    const side = meta.sideKey === undefined ? undefined : meta.params[meta.sideKey];
    const sideOk =
      side?.kind === "select" &&
      side.options.length === OVERLAY_SIDE_OPTIONS.length &&
      OVERLAY_SIDE_OPTIONS.every((o) => side.options.some((s) => s.value === o.value));
    if (columns !== (meta.sideKey !== undefined) || (columns && !sideOk)) {
      throw new Error(
        `Stream overlay "${meta.id}" needs a Left / Right side select exactly when it uses a column`,
      );
    }
    for (const [key, def] of Object.entries(meta.params)) {
      put(key, def);
    }
  }
  return out;
}

/** Keys of `own` (a scene's own params) that the overlay params also use. */
export function overlayKeyClashes(
  own: ParamSchema,
  metas: readonly OverlayMeta[] = OVERLAY_METAS,
): string[] {
  const shared = streamOverlayParams({}, metas);
  return Object.keys(own).filter((key) => Object.hasOwn(shared, key));
}
