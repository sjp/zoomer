import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const SHORELINE_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "diagonal-left", label: "Diagonal left" },
  { value: "diagonal-right", label: "Diagonal right" },
] as const;

/** Range of the `interval` param: average seconds between waves. */
export const MIN_INTERVAL = 6;
export const MAX_INTERVAL = 14;

export const biolumMeta = defineEffectMeta({
  id: "biolum",
  name: "Bioluminescent Shore",
  description:
    "A beach at night where each breaking wave lights up electric blue with glowing plankton.",
  params: {
    glowColor: { kind: "color", label: "Glow colour", default: "#2bc4ff" },
    intensity: { kind: "number", label: "Intensity", min: 0, max: 1, step: 0.01, default: 0.75 },
    interval: {
      kind: "number",
      label: "Seconds between waves",
      min: MIN_INTERVAL,
      max: MAX_INTERVAL,
      step: 0.5,
      default: 8,
    },
    shoreline: {
      kind: "select",
      label: "Shoreline",
      options: SHORELINE_OPTIONS,
      default: "low",
    },
    stars: { kind: "boolean", label: "Stars", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Water",
  tags: ["ocean", "sea", "surf", "coast", "dinoflagellates", "neon", "calm", "summer"],
  cost: "low",
  context: "webgl2",
});
