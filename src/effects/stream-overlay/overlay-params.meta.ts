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
import { OVERLAY_SIDE_OPTIONS, type OverlayMeta } from "./overlay-types.meta";
import { chatMeta } from "./chat.meta";
import { splitsMeta } from "./splits.meta";

/**
 * Every overlay, in registration order: the order of the toggles, of each
 * overlay's group in the panel, and of precedence when two column overlays
 * want the same side (the earlier one keeps it).
 */
export const OVERLAY_METAS: readonly OverlayMeta[] = [splitsMeta, chatMeta];

/** The group holding the toggles and the shared look. */
export const OVERLAYS_GROUP = "Overlays";

/** Shared keys every scene using the layer gets, whatever overlays exist. */
export const OVERLAY_ACCENT_KEY = "ovAccent";
export const OVERLAY_OPACITY_KEY = "ovOpacity";

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
