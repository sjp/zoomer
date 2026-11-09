import { QUALITY_OPTIONS } from "../param-options";
import { defineEffectMeta } from "../types";

/** Most fish the count param allows. */
export const MAX_FISH = 40;

export const SPECIES_OPTIONS = [
  { value: "neon", label: "Neon" },
  { value: "silver", label: "Silver" },
  { value: "mixed", label: "Mixed" },
] as const;

const LIGHT_OPTIONS = [
  { value: "daylight", label: "Daylight" },
  { value: "night", label: "Blue night" },
  { value: "warm", label: "Warm" },
] as const;

export type SpeciesId = (typeof SPECIES_OPTIONS)[number]["value"];
export type LightId = (typeof LIGHT_OPTIONS)[number]["value"];

export const aquariumMeta = defineEffectMeta({
  id: "aquarium",
  name: "Aquarium",
  description:
    "Through the front glass of a planted tank: small fish school among swaying plants, bubbles rise from an air stone and caustic light ripples over the gravel.",
  params: {
    fish: { kind: "number", label: "Fish", min: 5, max: MAX_FISH, step: 1, default: 24 },
    species: { kind: "select", label: "Species", options: SPECIES_OPTIONS, default: "mixed" },
    plants: { kind: "number", label: "Plants", min: 0, max: 1, step: 0.05, default: 0.6 },
    bubbles: { kind: "boolean", label: "Air stone", default: true },
    light: { kind: "select", label: "Light", options: LIGHT_OPTIONS, default: "daylight" },
    speed: { kind: "number", label: "Speed", min: 0.25, max: 2, step: 0.05, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 86 },
  },
  category: "Water",
  tags: ["fish tank", "tetra", "underwater", "freshwater", "aquascape", "calm", "pets"],
  cost: "low",
  context: "webgl2",
});
