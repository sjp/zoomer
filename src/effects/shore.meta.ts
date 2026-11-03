import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const SKY_OPTIONS = [
  { value: "overcast", label: "Overcast" },
  { value: "golden", label: "Golden" },
  { value: "morning", label: "Morning" },
] as const;

export const ROCKS_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "across", label: "Across" },
] as const;

/** Range of the `period` param: average seconds between waves. */
export const MIN_PERIOD = 8;
export const MAX_PERIOD = 20;

export const shoreMeta = defineEffectMeta({
  id: "shore",
  name: "Rocky Shore",
  description:
    "Slow waves roll in and break into white foam over dark, wet rocks, then drain back between them in lacy streams.",
  params: {
    swell: { kind: "number", label: "Wave size", min: 0, max: 1, step: 0.01, default: 0.35 },
    period: {
      kind: "number",
      label: "Seconds between waves",
      min: MIN_PERIOD,
      max: MAX_PERIOD,
      step: 0.5,
      default: 12,
    },
    sky: { kind: "select", label: "Sky", options: SKY_OPTIONS, default: "morning" },
    rocks: { kind: "select", label: "Rocks", options: ROCKS_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Water",
  tags: ["ocean", "sea", "surf", "coast", "waves", "cliffs", "spray", "calm"],
  cost: "low",
  context: "webgl2",
});
