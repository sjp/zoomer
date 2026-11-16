/**
 * The frame overlay's metadata: the stream furniture round the speaker, as
 * one layout. A decorative border round the speaker area, a follower goal bar
 * at the top left, and at the top right an uptime clock and a ticker naming
 * the latest follower and supporter, each of the last two with its own switch.
 */
import { CLOCK_TIME_HINT, type OverlayMeta } from "./overlay-types.meta";

/** The border's looks; `none` leaves just the goal bar, clock and ticker. */
export const FRAME_STYLE_OPTIONS = [
  { value: "clean", label: "Clean" },
  { value: "neon", label: "Neon" },
  { value: "pixel", label: "Pixel" },
  { value: "none", label: "None" },
] as const;

export type FrameStyle = (typeof FRAME_STYLE_OPTIONS)[number]["value"];

export const frameMeta: OverlayMeta = {
  id: "frame",
  toggle: "ovFrame",
  label: "Frame and goal",
  slots: ["topLeft", "topRight", "border"],
  params: {
    frameStyle: {
      kind: "select",
      label: "Border",
      group: "Frame",
      options: FRAME_STYLE_OPTIONS,
      default: "clean",
    },
    goalLabel: {
      kind: "text",
      label: "Goal",
      group: "Frame",
      default: "Follower goal",
      maxLength: 24,
      maxLines: 1,
    },
    goalTarget: {
      kind: "number",
      label: "Goal target",
      group: "Frame",
      min: 10,
      max: 1000,
      step: 10,
      default: 100,
    },
    goalStart: {
      kind: "number",
      label: "Goal starts at",
      group: "Frame",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.8,
    },
    ticker: {
      kind: "boolean",
      label: "Latest follower and supporter",
      group: "Frame",
      default: true,
    },
    uptime: {
      kind: "boolean",
      label: "Uptime clock",
      group: "Frame",
      default: true,
    },
    uptimeFrom: {
      kind: "text",
      label: `Live since (${CLOCK_TIME_HINT}; empty counts from page load)`,
      group: "Frame",
      default: "",
      maxLength: 8,
      maxLines: 1,
    },
  },
};
