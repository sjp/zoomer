import { defineEffectMeta } from "../types";

export type PaletteId = "oak" | "walnut" | "painted" | "archive";
export type BeamId = "left" | "right" | "off";

export const PALETTE_OPTIONS = [
  { value: "oak", label: "Oak" },
  { value: "walnut", label: "Walnut" },
  { value: "painted", label: "Painted" },
  { value: "archive", label: "Archive" },
] as const satisfies readonly { value: PaletteId; label: string }[];

export const BEAM_OPTIONS = [
  { value: "left", label: "From left" },
  { value: "right", label: "From right" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: BeamId; label: string }[];

/** Most dust motes. */
export const MAX_DUST = 600;

export const libraryMeta = defineEffectMeta({
  id: "library",
  name: "Library Window",
  description:
    "A quiet, softly out-of-focus corner of a library: bookshelves, a warm lamp, and a sunbeam with dust drifting through it as clouds pass.",
  params: {
    palette: { kind: "select", label: "Shelves", options: PALETTE_OPTIONS, default: "oak" },
    beam: { kind: "select", label: "Sunbeam", options: BEAM_OPTIONS, default: "left" },
    lamp: { kind: "boolean", label: "Lamp", default: true },
    dust: { kind: "number", label: "Dust motes", min: 0, max: MAX_DUST, step: 10, default: 260 },
    clouds: { kind: "boolean", label: "Passing clouds", default: true },
    blur: { kind: "number", label: "Blur", min: 0, max: 1, step: 0.01, default: 0.6 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Cosy",
  tags: ["books", "bookcase", "study", "reading", "sunlight", "bokeh", "academia"],
  cost: "very low",
  context: "webgl2",
});
