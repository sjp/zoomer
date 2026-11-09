import { defineEffectMeta } from "../types";

export const SPECIES_OPTIONS = [
  { value: "orbium", label: "Orbium" },
  { value: "mixed", label: "Mixed" },
  { value: "rotators", label: "Rotators" },
  { value: "soup", label: "Random soup" },
] as const;

export const PALETTE_OPTIONS = [
  { value: "bioluminescent", label: "Bioluminescent" },
  { value: "ink", label: "Ink" },
  { value: "ember", label: "Ember" },
  { value: "pastel", label: "Pastel" },
] as const;

/** Most creatures seeded at once. */
const MAX_COUNT = 8;

export const leniaMeta = defineEffectMeta({
  id: "lenia",
  name: "Lenia",
  description:
    "Soft, glowing creatures from a continuous cellular automaton glide, turn and pulse across the frame.",
  params: {
    species: { kind: "select", label: "Species", options: SPECIES_OPTIONS, default: "mixed" },
    count: { kind: "number", label: "Creatures", min: 1, max: MAX_COUNT, step: 1, default: 4 },
    speed: { kind: "number", label: "Speed", min: 0.05, max: 1, step: 0.05, default: 0.25 },
    palette: {
      kind: "select",
      label: "Palette",
      options: PALETTE_OPTIONS,
      default: "bioluminescent",
    },
    trail: { kind: "number", label: "Trail", min: 0, max: 1, step: 0.05, default: 0.35 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  category: "Science",
  tags: ["artificial life", "cellular automaton", "simulation", "organic", "biology", "microbes"],
  cost: "medium",
  context: "webgl2",
});
