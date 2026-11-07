import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const KITE_OPTIONS = [
  { value: "diamond", label: "Diamond" },
  { value: "delta", label: "Delta" },
  { value: "box", label: "Box" },
] as const;

export const COLOUR_OPTIONS = [
  { value: "rainbow", label: "Rainbow" },
  { value: "red", label: "Red" },
  { value: "blueyellow", label: "Blue and yellow" },
] as const;

export const CORNER_OPTIONS = [
  { value: "left", label: "Top left" },
  { value: "right", label: "Top right" },
] as const;

export const kiteMeta = defineEffectMeta({
  id: "kite",
  name: "Kite on a Breezy Day",
  description:
    "A bright kite swooping on the wind in a top corner of a blue sky, its long tail rippling as soft clouds drift past.",
  params: {
    kite: { kind: "select", label: "Kite", options: KITE_OPTIONS, default: "diamond" },
    wind: { kind: "number", label: "Wind", min: 0, max: 1, step: 0.01, default: 0.5 },
    colour: { kind: "select", label: "Colours", options: COLOUR_OPTIONS, default: "rainbow" },
    clouds: { kind: "number", label: "Cloud cover", min: 0, max: 1, step: 0.01, default: 0.4 },
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "right" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Sky & weather",
  tags: ["kite flying", "summer", "windy", "cheerful", "outdoors", "park"],
  cost: "very low",
  context: "webgl2",
});
