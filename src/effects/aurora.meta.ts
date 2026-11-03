import { defineEffectMeta } from "./types";

export const HORIZON_OPTIONS = [
  { value: "none", label: "None" },
  { value: "hills", label: "Hills" },
  { value: "pines", label: "Pines" },
] as const;

export const auroraMeta = defineEffectMeta({
  id: "aurora",
  name: "Aurora",
  description:
    "Northern lights: slow green and purple curtains ripple over a starry night sky above a dark treeline.",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    intensity: { kind: "number", label: "Intensity", min: 0, max: 2, step: 0.05, default: 1 },
    bands: { kind: "number", label: "Bands", min: 1, max: 3, step: 1, default: 2 },
    lowColor: { kind: "color", label: "Base colour", default: "#3dff9a" },
    highColor: { kind: "color", label: "Top colour", default: "#9b5cff" },
    sky: { kind: "color", label: "Sky colour", default: "#0a1a3c" },
    stars: { kind: "number", label: "Stars", min: 0, max: 1, step: 0.05, default: 0.5 },
    horizon: { kind: "select", label: "Horizon", options: HORIZON_OPTIONS, default: "pines" },
  },
  context: "webgl2",
});
