import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

/** Most distant peaks rising through the clouds. */
export const MAX_PEAKS = 4;

export const cloudseaMeta = defineEffectMeta({
  id: "cloudsea",
  name: "Sea of Clouds at Dawn",
  description:
    "A mountaintop view over a calm sea of cloud, with distant peaks catching the first light as the sky turns from pink to gold.",
  params: {
    timeOfDay: {
      kind: "select",
      label: "Time of day",
      options: [
        { value: "predawn", label: "Pre-dawn" },
        { value: "sunrise", label: "Sunrise" },
        { value: "golden", label: "Golden" },
        { value: "cycle", label: "Cycle" },
      ],
      default: "sunrise",
    },
    cycle: { kind: "number", label: "Minutes per cycle", min: 1, max: 30, step: 1, default: 8 },
    drift: { kind: "number", label: "Cloud drift", min: 0, max: 3, step: 0.05, default: 1 },
    cloudLine: {
      kind: "number",
      label: "Cloud line",
      min: 0.35,
      max: 0.6,
      step: 0.01,
      default: 0.45,
    },
    peaks: { kind: "number", label: "Peaks", min: 0, max: MAX_PEAKS, step: 1, default: 3 },
    ledge: { kind: "boolean", label: "Rocky ledge", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Sky & weather",
  tags: ["alpine", "sunrise", "summit", "inversion", "peaceful", "morning"],
  cost: "medium",
  context: "webgl2",
});
