import type { PaletteId } from "./cells-sim";
import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

/** Cell count range; the shader's uniform arrays hold MAX_CELLS. */
export const MIN_CELLS = 12;
export const MAX_CELLS = 64;

export const PALETTE_OPTIONS = [
  { value: "stain", label: "Stain" },
  { value: "fluorescent", label: "Fluorescent" },
  { value: "mono", label: "Mono" },
  { value: "pastel", label: "Pastel" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const cellsMeta = defineEffectMeta({
  id: "cells",
  name: "Dividing Cells",
  description:
    "A soft microscope view of living cells that pack together, jostle gently, grow, and now and then pinch in two.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "stain" },
    cells: { kind: "number", label: "Cells", min: MIN_CELLS, max: MAX_CELLS, step: 1, default: 40 },
    division: {
      kind: "number",
      label: "Divisions per minute",
      min: 0,
      max: 12,
      step: 0.5,
      default: 3,
    },
    motion: { kind: "number", label: "Jostling", min: 0, max: 1, step: 0.05, default: 0.5 },
    nuclei: { kind: "boolean", label: "Nuclei", default: true },
    calmCentre: { kind: "boolean", label: "Calm centre", default: true },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Science",
  tags: ["biology", "microscope", "mitosis", "petri dish", "lab", "organic", "voronoi"],
  cost: "medium",
  context: "webgl2",
});
