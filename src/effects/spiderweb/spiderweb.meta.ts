import { defineEffectMeta } from "../types";

export const CORNER_OPTIONS = [
  { value: "topLeft", label: "Top left" },
  { value: "topRight", label: "Top right" },
  { value: "bottomLeft", label: "Bottom left" },
  { value: "bottomRight", label: "Bottom right" },
] as const;

const LIGHT_OPTIONS = [
  { value: "dawn", label: "Dawn gold" },
  { value: "misty", label: "Misty" },
  { value: "cool", label: "Cool morning" },
] as const;

export const spiderwebMeta = defineEffectMeta({
  id: "spiderweb",
  name: "Dewy Spider Web",
  description:
    "An orb web strung across one corner at dawn, beaded with dew that glints as it sways gently in front of soft, out-of-focus foliage.",
  params: {
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "topLeft" },
    size: { kind: "number", label: "Web size", min: 0, max: 1, step: 0.01, default: 0.6 },
    dew: { kind: "number", label: "Dew", min: 0, max: 1, step: 0.01, default: 0.6 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, step: 0.01, default: 0.4 },
    light: { kind: "select", label: "Light", options: LIGHT_OPTIONS, default: "dawn" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Nature",
  tags: ["cobweb", "orb web", "dew drops", "morning", "sunrise", "garden", "macro", "bokeh"],
  cost: "very low",
  context: "webgl2",
});
