import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const MIN_TURBINES = 3;

export const MAX_TURBINES = 15;

export const TIME_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "midday", label: "Midday" },
  { value: "evening", label: "Evening" },
] as const;

export const SIDE_OPTIONS = [
  { value: "spread", label: "Spread" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

export const windfarmMeta = defineEffectMeta({
  id: "windfarm",
  name: "Wind Farm",
  description:
    "White wind turbines turning slowly on rolling green hills, with clouds drifting overhead and their shadows sliding across the slopes.",
  params: {
    turbines: {
      kind: "number",
      label: "Turbines",
      min: MIN_TURBINES,
      max: MAX_TURBINES,
      step: 1,
      default: 9,
    },
    wind: { kind: "number", label: "Wind", min: 0, max: 3, step: 0.05, default: 1 },
    timeOfDay: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "midday" },
    clouds: { kind: "number", label: "Cloud cover", min: 0, max: 1, step: 0.01, default: 0.45 },
    side: { kind: "select", label: "Turbines on", options: SIDE_OPTIONS, default: "spread" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Nature",
  tags: ["renewable", "energy", "countryside", "windmills", "green", "landscape", "breeze"],
  cost: "low",
  context: "webgl2",
});
