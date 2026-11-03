import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const radarMeta = defineEffectMeta({
  id: "radar",
  name: "Weather Radar",
  description:
    "A stylised rain radar: green, yellow and red echoes drift across a muted map under range rings and a slow sweep.",
  params: {
    region: {
      kind: "select",
      label: "Region",
      options: [
        { value: "coast", label: "Coast" },
        { value: "islands", label: "Islands" },
        { value: "inland", label: "Inland" },
        { value: "world", label: "World map" },
      ],
      default: "coast",
    },
    weather: {
      kind: "select",
      label: "Weather",
      options: [
        { value: "showers", label: "Showers" },
        { value: "front", label: "Front" },
        { value: "cells", label: "Storm cells" },
      ],
      default: "front",
    },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.1, default: 1 },
    sweep: { kind: "boolean", label: "Sweep", default: true },
    palette: {
      kind: "select",
      label: "Palette",
      options: [
        { value: "classic", label: "Classic" },
        { value: "muted", label: "Muted" },
        { value: "mono", label: "Mono green" },
      ],
      default: "classic",
    },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Sky & weather",
  tags: ["rain", "storm", "forecast", "meteorology", "map", "control room", "precipitation"],
  cost: "very low",
  context: "webgl2",
});
