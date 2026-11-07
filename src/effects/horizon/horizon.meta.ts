import { defineEffectMeta } from "../types";

export const MIN_LAYERS = 3;

export const MAX_LAYERS = 5;

export const horizonMeta = defineEffectMeta({
  id: "horizon",
  name: "Day–Night Horizon",
  description:
    "Layered hills under a sky that follows the time of day: dawn, day, sunset, dusk and a starry, moonlit night.",
  params: {
    time: {
      kind: "select",
      label: "Time",
      options: [
        { value: "local", label: "Local clock" },
        { value: "cycle", label: "Cycle" },
        { value: "fixed", label: "Fixed" },
      ],
      default: "local",
    },
    cycleMins: {
      kind: "number",
      label: "Minutes per day (cycle)",
      min: 2,
      max: 60,
      step: 1,
      default: 10,
    },
    hour: { kind: "number", label: "Hour (fixed)", min: 0, max: 24, step: 0.25, default: 18 },
    palette: {
      kind: "select",
      label: "Landscape",
      options: [
        { value: "meadow", label: "Meadow" },
        { value: "desert", label: "Desert" },
        { value: "mountains", label: "Mountains" },
        { value: "coast", label: "Coast" },
      ],
      default: "meadow",
    },
    layers: {
      kind: "number",
      label: "Hill layers",
      min: MIN_LAYERS,
      max: MAX_LAYERS,
      step: 1,
      default: 4,
    },
    clouds: { kind: "number", label: "Clouds", min: 0, max: 1, step: 0.05, default: 0.3 },
    stars: { kind: "boolean", label: "Stars", default: true },
    moon: {
      kind: "select",
      label: "Moon",
      options: [
        { value: "real", label: "Today's phase" },
        { value: "full", label: "Full" },
        { value: "off", label: "Off" },
      ],
      default: "real",
    },
    trees: { kind: "boolean", label: "Trees", default: true },
    seed: { kind: "number", label: "Hill shapes", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Sky & weather",
  tags: ["sunrise", "landscape", "clock"],
  cost: "very low",
  context: "webgl2",
});
