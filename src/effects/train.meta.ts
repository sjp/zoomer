import { defineEffectMeta } from "./types";

export type TimeOfDay = "morning" | "afternoon" | "golden" | "dusk";
export type Direction = "left" | "right";
export type FrameStyle = "carriage" | "thin" | "none";

/** In the order the time-of-day transition passes through them. */
export const TIME_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "golden", label: "Golden hour" },
  { value: "dusk", label: "Dusk" },
] as const satisfies readonly { value: TimeOfDay; label: string }[];

export const DIRECTION_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: Direction; label: string }[];

export const FRAME_OPTIONS = [
  { value: "carriage", label: "Carriage" },
  { value: "thin", label: "Thin" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: FrameStyle; label: string }[];

export const trainMeta = defineEffectMeta({
  id: "train",
  name: "Train Window",
  description:
    "The view from a slow train: distant hills, fields and hedgerows glide past at their own pace while telegraph poles and wires sweep by close to the window.",
  params: {
    speed: { kind: "number", label: "Train speed", min: 0, max: 1, step: 0.05, default: 0.25 },
    timeOfDay: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "golden" },
    direction: {
      kind: "select",
      label: "Scenery moves",
      options: DIRECTION_OPTIONS,
      default: "left",
    },
    poles: { kind: "boolean", label: "Telegraph poles", default: true },
    frame: { kind: "select", label: "Window frame", options: FRAME_OPTIONS, default: "carriage" },
    sway: { kind: "number", label: "Carriage sway", min: 0, max: 1, step: 0.05, default: 0.25 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Nature",
  tags: ["railway", "journey", "travel", "commute", "countryside", "farm", "parallax", "landscape"],
  cost: "low",
  context: "webgl2",
});
