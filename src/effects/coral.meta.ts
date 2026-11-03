import type { PaletteId } from "./coral-sim";
import { defineEffectMeta } from "./types";

export const PALETTE_OPTIONS = [
  { value: "reef", label: "Reef" },
  { value: "sunset", label: "Sunset" },
  { value: "deep", label: "Deep" },
  { value: "bleached", label: "Bleached" },
] as const satisfies readonly { value: PaletteId; label: string }[];

/** Range of the `growth` param: a multiplier on the whole grow / hold / fade cycle. */
export const MIN_GROWTH = 0.25;
export const MAX_GROWTH = 4;

export const coralMeta = defineEffectMeta({
  id: "coral",
  name: "Coral Growth",
  description:
    "Branching corals, sea fans and rounded mounds slowly grow up from the sea floor under rippling light, then fade and regrow as a new reef.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "reef" },
    density: { kind: "number", label: "Density", min: 0.3, max: 2, step: 0.05, default: 1 },
    height: {
      kind: "number",
      label: "Reef height",
      min: 0.25,
      max: 0.6,
      step: 0.01,
      default: 0.45,
    },
    growth: {
      kind: "number",
      label: "Growth speed",
      min: MIN_GROWTH,
      max: MAX_GROWTH,
      step: 0.05,
      default: 1,
    },
    cycle: { kind: "boolean", label: "Fade and regrow", default: true },
    caustics: { kind: "boolean", label: "Caustic light", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Water",
  tags: ["ocean", "underwater", "reef", "sea", "tropical", "diving", "calm", "nature"],
  cost: "low",
  context: "webgl2",
});
