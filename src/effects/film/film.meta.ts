import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

export const MODE_OPTIONS = [
  { value: "soap", label: "Soap film" },
  { value: "oil", label: "Oil slick" },
  { value: "pearl", label: "Pearl" },
] as const;

export const filmMeta = defineEffectMeta({
  id: "film",
  name: "Iridescent Film",
  description: "Slow interference colours of a soap film, oil slick or pearl. Very low power.",
  params: {
    mode: { kind: "select", label: "Mode", options: MODE_OPTIONS, default: "soap" },
    thickness: {
      kind: "number",
      label: "Thickness (nm)",
      min: 200,
      max: 900,
      step: 10,
      default: 420,
    },
    range: { kind: "number", label: "Range (nm)", min: 40, max: 450, step: 10, default: 200 },
    swirl: { kind: "number", label: "Swirl", min: 0, max: 3, step: 0.05, default: 1 },
    saturation: { kind: "number", label: "Saturation", min: 0, max: 1, step: 0.01, default: 0.85 },
    background: { kind: "color", label: "Background", default: "#07080c" },
    pearlBackground: { kind: "color", label: "Background (pearl)", default: "#e6e1e8" },
    highlight: { kind: "boolean", label: "Window highlight", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Abstract",
  tags: ["soap bubble", "rainbow", "holographic"],
  cost: "very low",
  context: "webgl2",
});
