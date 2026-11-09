import type { PaletteId } from "./kelp-sim";
import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

const PALETTE_OPTIONS = [
  { value: "temperate", label: "Temperate green" },
  { value: "tropical", label: "Tropical blue" },
  { value: "dusk", label: "Dusk" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const kelpMeta = defineEffectMeta({
  id: "kelp",
  name: "Kelp Forest",
  description:
    "Looking sideways into a kelp forest: tall fronds sway slowly in the swell under shafts of light from the surface.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "temperate" },
    density: { kind: "number", label: "Density", min: 0.3, max: 2.5, step: 0.05, default: 1 },
    swell: { kind: "number", label: "Swell", min: 0, max: 1, step: 0.01, default: 0.5 },
    speed: { kind: "number", label: "Speed", min: 0.25, max: 2, step: 0.05, default: 1 },
    shafts: { kind: "number", label: "Light shafts", min: 0, max: 1, step: 0.01, default: 0.6 },
    fish: { kind: "boolean", label: "Fish shadows", default: true },
    snow: { kind: "boolean", label: "Marine snow", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 11 },
  },
  category: "Water",
  tags: ["ocean", "underwater", "seaweed", "sea", "diving", "calm"],
  cost: "low",
  context: "webgl2",
});
