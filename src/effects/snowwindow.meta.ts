import { defineEffectMeta } from "./types";

/** Most flakes the `snowfall` param allows. */
export const MAX_SNOWFALL = 1200;

export const LAYOUT_OPTIONS = [
  { value: "four", label: "Four panes" },
  { value: "six", label: "Six panes (crosses centre)" },
  { value: "frame", label: "Frame only" },
] as const;

export const SCENE_OPTIONS = [
  { value: "pines", label: "Pines" },
  { value: "village", label: "Village" },
  { value: "plain", label: "Plain" },
] as const;

export const snowWindowMeta = defineEffectMeta({
  id: "snowwindow",
  name: "Snowy Window",
  description:
    "Snow falling over a twilight landscape, seen from a cosy room through a lamplit window with misted corners.",
  params: {
    layout: { kind: "select", label: "Window", options: LAYOUT_OPTIONS, default: "four" },
    scene: { kind: "select", label: "Outside", options: SCENE_OPTIONS, default: "pines" },
    frameColor: { kind: "color", label: "Frame colour", default: "#f1ede4" },
    snowfall: {
      kind: "number",
      label: "Snowfall (flakes)",
      min: 0,
      max: MAX_SNOWFALL,
      step: 10,
      default: 380,
    },
    wind: {
      kind: "number",
      label: "Wind (negative = left)",
      min: -1,
      max: 1,
      step: 0.05,
      default: 0.15,
    },
    fog: { kind: "number", label: "Condensation", min: 0, max: 1, step: 0.01, default: 0.5 },
    warmth: { kind: "number", label: "Room light", min: 0, max: 1, step: 0.01, default: 0.6 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 4 },
  },
  category: "Cosy",
  tags: ["winter", "christmas", "evening", "cabin", "pines", "hygge", "cold", "condensation"],
  cost: "low",
  context: "webgl2",
});
