import { defineEffectMeta } from "./types";

export type HourglassPosition = "left" | "right";
export type HourglassFrame = "walnut" | "brass" | "none";

export const POSITION_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: HourglassPosition; label: string }[];

export const FRAME_OPTIONS = [
  { value: "walnut", label: "Walnut" },
  { value: "brass", label: "Brass" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: HourglassFrame; label: string }[];

/** Bounds of the `duration` param (seconds per run). */
export const DURATION_RANGE = [30, 600] as const;
/** Bounds of the `size` param. */
export const SIZE_RANGE = [0.7, 1.2] as const;

export const hourglassMeta = defineEffectMeta({
  id: "hourglass",
  name: "Hourglass",
  description:
    "A glass hourglass in a turned wooden frame stands in a bottom corner, a thin stream of sand trickling into a growing pile. When the top runs empty it turns itself over and starts again.",
  params: {
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "right" },
    duration: {
      kind: "number",
      label: "Seconds per run",
      min: DURATION_RANGE[0],
      max: DURATION_RANGE[1],
      step: 10,
      default: 120,
    },
    sand: { kind: "color", label: "Sand colour", default: "#d9b77c" },
    frame: { kind: "select", label: "Frame", options: FRAME_OPTIONS, default: "walnut" },
    size: {
      kind: "number",
      label: "Size",
      min: SIZE_RANGE[0],
      max: SIZE_RANGE[1],
      step: 0.05,
      default: 1,
    },
  },
  category: "Cosy",
  tags: ["sand timer", "egg timer", "time", "countdown", "pomodoro", "desk", "antique", "focus"],
  cost: "very low",
  context: "webgl2",
});
