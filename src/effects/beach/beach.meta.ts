import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const LAYOUT_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "bottom", label: "Bottom" },
  { value: "diagonal", label: "Diagonal" },
] as const;

export const MIN_WAVE_TIME = 6;

export const MAX_WAVE_TIME = 15;

const WATER_OPTIONS = [
  { value: "tropical", label: "Tropical" },
  { value: "atlantic", label: "Atlantic" },
  { value: "dusk", label: "Dusk" },
] as const;

export const beachMeta = defineEffectMeta({
  id: "beach",
  name: "Beach from Above",
  description: "A drone's-eye view of gentle waves washing up a sandy beach and draining back.",
  params: {
    layout: { kind: "select", label: "Layout", options: LAYOUT_OPTIONS, default: "diagonal" },
    waveTime: {
      kind: "number",
      label: "Seconds between waves",
      min: MIN_WAVE_TIME,
      max: MAX_WAVE_TIME,
      step: 0.5,
      default: 9,
    },
    reach: { kind: "number", label: "Wave reach", min: 0.04, max: 0.25, step: 0.01, default: 0.12 },
    foam: { kind: "number", label: "Foam", min: 0, max: 1, step: 0.01, default: 0.75 },
    water: { kind: "select", label: "Water", options: WATER_OPTIONS, default: "tropical" },
    sand: { kind: "color", label: "Sand colour", default: "#e4cc9e" },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Water",
  tags: ["ocean", "sea", "surf", "aerial", "coast"],
  cost: "medium",
  context: "webgl2",
});
