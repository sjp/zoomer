/**
 * The alert overlay's metadata: a banner that drops in at the top centre when
 * someone follows, subscribes, gifts subs or hosts, with a little confetti.
 *
 * `alertEvery` and `alertKinds` pace and pick the stream's made-up events
 * themselves (the overlay layer reads them), so the chat's event lines and the
 * goal bar keep in step with the alerts, whether or not the banner is shown.
 */
import type { OverlayMeta } from "./overlay-types.meta";

/** Which events the stream holds (values are `StreamEventKinds` in `stream-events.ts`). */
export const ALERT_KINDS_OPTIONS = [
  { value: "all", label: "All" },
  { value: "follows", label: "Follows only" },
  { value: "gifts", label: "Gifts only" },
] as const;

/** The banner's looks. */
export const ALERT_STYLE_OPTIONS = [
  { value: "banner", label: "Banner" },
  { value: "pixel", label: "Pixel" },
  { value: "minimal", label: "Minimal (no confetti)" },
] as const;

export type AlertStyle = (typeof ALERT_STYLE_OPTIONS)[number]["value"];

export const alertsMeta: OverlayMeta = {
  id: "alerts",
  toggle: "ovAlerts",
  label: "Alerts",
  slots: ["topCentre"],
  params: {
    alertEvery: {
      kind: "number",
      label: "Every (seconds, on average)",
      group: "Alerts",
      min: 20,
      max: 300,
      step: 5,
      default: 60,
    },
    alertKinds: {
      kind: "select",
      label: "Events",
      group: "Alerts",
      options: ALERT_KINDS_OPTIONS,
      default: "all",
    },
    alertStyle: {
      kind: "select",
      label: "Style",
      group: "Alerts",
      options: ALERT_STYLE_OPTIONS,
      default: "banner",
    },
    alertText: {
      kind: "text",
      label: "Your own alert lines, one per line ({name} becomes a made-up name)",
      group: "Alerts",
      default: "",
      maxLength: 40,
      maxLines: 10,
    },
  },
};
