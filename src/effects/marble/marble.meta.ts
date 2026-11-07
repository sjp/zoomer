import type { MarblePaletteName, StrokeMode } from "./marble-sim";
import { defineEffectMeta } from "../types";

export const PALETTE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "ocean", label: "Ocean" },
  { value: "earth", label: "Earth" },
  { value: "pastel", label: "Pastel" },
] as const satisfies readonly { value: MarblePaletteName; label: string }[];

export const STROKE_OPTIONS = [
  { value: "combs", label: "Combs" },
  { value: "swirls", label: "Swirls" },
  { value: "mixed", label: "Mixed" },
] as const satisfies readonly { value: StrokeMode; label: string }[];

export const marbleMeta = defineEffectMeta({
  id: "marble",
  name: "Liquid Marble",
  description:
    "Paper marbling in motion: bands and drops of colour on a flat surface are slowly combed, swirled and folded into feathered patterns, and fresh drops keep refreshing it.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "classic" },
    strokes: { kind: "select", label: "Strokes", options: STROKE_OPTIONS, default: "mixed" },
    speed: { kind: "number", label: "Stroke speed", min: 0.25, max: 3, step: 0.05, default: 1 },
    drops: {
      kind: "number",
      label: "Drop bursts per minute",
      min: 0,
      max: 6,
      step: 0.25,
      default: 1.5,
    },
    scale: { kind: "number", label: "Pattern scale", min: 0.5, max: 2, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 11 },
  },
  category: "Abstract",
  tags: ["marbling", "ebru", "paper", "paint", "swirl", "art", "craft", "suminagashi"],
  cost: "low",
  context: "webgl2",
});
