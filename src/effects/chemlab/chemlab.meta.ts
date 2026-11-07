import { defineEffectMeta } from "../types";

export type LabPalette = "mixed" | "toxic" | "neon" | "warm";
export type LabLighting = "dim" | "lab";

export const PALETTE_OPTIONS = [
  { value: "mixed", label: "Mixed" },
  { value: "toxic", label: "Toxic green" },
  { value: "neon", label: "Neon" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: LabPalette; label: string }[];

export const LIGHTING_OPTIONS = [
  { value: "dim", label: "Dim (glow-lit)" },
  { value: "lab", label: "Lab lights" },
] as const satisfies readonly { value: LabLighting; label: string }[];

export const chemlabMeta = defineEffectMeta({
  id: "chemlab",
  name: "Chemistry Lab",
  description:
    "A slightly mad scientist's chemistry lab: flasks and beakers of glowing coloured liquids bubbling over blue burner flames, a dripping distillation coil, coloured vapour curling from the necks and pooling over the bench, shelves of reagent bottles, a periodic table and a blackboard of scribbled formulas.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "mixed" },
    vapour: { kind: "number", label: "Vapour", min: 0, max: 1, step: 0.05, default: 0.5 },
    bubbling: { kind: "number", label: "Bubbling", min: 0, max: 1, step: 0.05, default: 0.5 },
    reactions: { kind: "boolean", label: "Reactions", default: true },
    lighting: { kind: "select", label: "Lighting", options: LIGHTING_OPTIONS, default: "dim" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Scenes",
  tags: [
    "science",
    "laboratory",
    "mad scientist",
    "potions",
    "beakers",
    "experiment",
    "alchemy",
    "glow",
  ],
  cost: "medium",
  context: "webgl2",
});
