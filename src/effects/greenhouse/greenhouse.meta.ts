import { defineEffectMeta } from "../types";

export type PaletteId = "jungle" | "fern" | "evening";
export type RoofId = "arched" | "pitched" | "hidden";

export const PALETTE_OPTIONS = [
  { value: "jungle", label: "Jungle" },
  { value: "fern", label: "Fern house" },
  { value: "evening", label: "Evening" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const ROOF_OPTIONS = [
  { value: "arched", label: "Arched" },
  { value: "pitched", label: "Pitched" },
  { value: "hidden", label: "Hidden" },
] as const satisfies readonly { value: RoofId; label: string }[];

/** Highest leaf density (plants per layer relative to the default). */
export const DENSITY_MAX = 2;

export const greenhouseMeta = defineEffectMeta({
  id: "greenhouse",
  name: "Rainy Greenhouse",
  description:
    "Inside a Victorian glasshouse during soft rain: big tropical leaves and ferns crowd the edges while rain trickles down the glass roof above.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "jungle" },
    roof: { kind: "select", label: "Roof", options: ROOF_OPTIONS, default: "arched" },
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.01, default: 0.5 },
    density: {
      kind: "number",
      label: "Leaf density",
      min: 0.3,
      max: DENSITY_MAX,
      step: 0.05,
      default: 1,
    },
    haze: { kind: "number", label: "Haze", min: 0, max: 1, step: 0.01, default: 0.5 },
    drips: { kind: "boolean", label: "Drips from the bars", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Nature",
  tags: [
    "glasshouse",
    "conservatory",
    "plants",
    "tropical",
    "jungle",
    "botanical",
    "monstera",
    "cosy",
    "calm",
  ],
  cost: "low",
  context: "webgl2",
});
