import { defineEffectMeta } from "./types";

export const MAX_LANTERNS = 150;

export const lanternsMeta = defineEffectMeta({
  id: "lanterns",
  name: "Paper Lanterns",
  description:
    "Glowing paper sky lanterns rising slowly into the dusk, optionally over a still lake.",
  params: {
    count: { kind: "number", label: "Lanterns", min: 5, max: MAX_LANTERNS, step: 1, default: 60 },
    size: { kind: "number", label: "Size", min: 20, max: 140, step: 1, default: 64 },
    rise: { kind: "number", label: "Rise speed", min: 0, max: 3, step: 0.05, default: 1 },
    wind: {
      kind: "number",
      label: "Wind (negative = left)",
      min: -1,
      max: 1,
      step: 0.05,
      default: 0.2,
    },
    flicker: { kind: "number", label: "Flicker", min: 0, max: 1, step: 0.01, default: 0.5 },
    lanternColor: { kind: "color", label: "Lantern colour", default: "#ffa040" },
    skyTop: { kind: "color", label: "Sky top colour", default: "#0b0d26" },
    skyBottom: { kind: "color", label: "Sky bottom colour", default: "#4a2440" },
    stars: { kind: "boolean", label: "Stars", default: true },
    lake: { kind: "boolean", label: "Lake", default: false },
  },
  context: "webgl2",
});
