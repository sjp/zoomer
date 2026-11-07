import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const TIME_OPTIONS = [
  { value: "day", label: "Day" },
  { value: "golden", label: "Golden hour" },
  { value: "dusk", label: "Dusk" },
  { value: "night", label: "Night (moonlit)" },
] as const;

export const cloudsMeta = defineEffectMeta({
  id: "clouds",
  name: "Time-lapse Clouds",
  description: "Fluffy clouds drifting and evolving across a day, golden hour, dusk or night sky.",
  params: {
    time: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "day" },
    coverage: { kind: "number", label: "Cloud cover", min: 0, max: 1, step: 0.01, default: 0.5 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    scale: { kind: "number", label: "Cloud size", min: 0.5, max: 2, step: 0.05, default: 1 },
    layers: { kind: "number", label: "Layers", min: 1, max: 2, step: 1, default: 2 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Sky & weather",
  tags: ["timelapse", "sunset", "weather", "cloudscape"],
  cost: "medium",
  context: "webgl2",
});
