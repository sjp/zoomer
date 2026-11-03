import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const seaMeta = defineEffectMeta({
  id: "sea",
  name: "Calm Sea at Dusk",
  description:
    "A gentle swell rolling in under a dusk sky, with a soft glitter path beneath a low sun or the moon.",
  category: "Water",
  tags: ["ocean", "waves", "sunset"],
  cost: "medium",
  context: "webgl2",
  params: {
    time: {
      kind: "select",
      label: "Time",
      options: [
        { value: "sunset", label: "Sunset" },
        { value: "dusk", label: "Dusk" },
        { value: "moonlight", label: "Moonlight" },
        { value: "overcast", label: "Overcast" },
      ],
      default: "sunset",
    },
    sunX: { kind: "number", label: "Sun position", min: 0, max: 1, step: 0.01, default: 0.76 },
    horizon: {
      kind: "number",
      label: "Horizon height",
      min: 0.5,
      max: 0.7,
      step: 0.01,
      default: 0.6,
    },
    swell: { kind: "number", label: "Swell", min: 0, max: 2, step: 0.05, default: 1 },
    wind: { kind: "number", label: "Ripples", min: 0, max: 2, step: 0.05, default: 1 },
    glitter: { kind: "number", label: "Glitter", min: 0, max: 1, step: 0.05, default: 0.7 },
    land: { kind: "boolean", label: "Distant headland", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
});
