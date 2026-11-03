import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export type Season = "early" | "peak" | "late" | "summer";

export const SEASON_OPTIONS = [
  { value: "early", label: "Early autumn" },
  { value: "peak", label: "Peak" },
  { value: "late", label: "Late" },
  { value: "summer", label: "Summer" },
] as const satisfies readonly { value: Season; label: string }[];

/** Most ripple rings per minute the slider allows. */
export const MAX_RIPPLE_RATE = 20;

export const lakeMeta = defineEffectMeta({
  id: "lake",
  name: "Autumn Lake",
  description:
    "A still lake mirrors a treeline in reds, oranges and golds. Now and then a breath of wind ruffles the reflection, or a ripple spreads across it and the water calms again.",
  category: "Water",
  tags: ["fall", "foliage", "reflection", "mirror", "forest", "calm", "pond", "trees"],
  cost: "low",
  context: "webgl2",
  params: {
    season: { kind: "select", label: "Season", options: SEASON_OPTIONS, default: "peak" },
    shoreline: {
      kind: "number",
      label: "Shoreline",
      min: 0.3,
      max: 0.6,
      step: 0.01,
      default: 0.45,
    },
    wind: { kind: "number", label: "Wind", min: 0, max: 1, step: 0.05, default: 0.4 },
    ripples: {
      kind: "number",
      label: "Ripples per minute",
      min: 0,
      max: MAX_RIPPLE_RATE,
      step: 0.5,
      default: 4,
    },
    mist: { kind: "boolean", label: "Morning mist", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
});
