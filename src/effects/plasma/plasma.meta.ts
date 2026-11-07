import { defineEffectMeta } from "../types";

export type PlasmaCorner = "left" | "right";
export type PlasmaColourId = "violet" | "blue" | "green" | "rainbow";

export const COLOUR_OPTIONS = [
  { value: "violet", label: "Violet" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "rainbow", label: "Rainbow" },
] as const satisfies readonly { value: PlasmaColourId; label: string }[];

export const CORNER_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: PlasmaCorner; label: string }[];

/** Most filaments the globe holds; the `filaments` param's maximum. */
export const MAX_FILAMENTS = 16;
/** Globe diameter as a fraction of the frame height: the `size` param's bounds. */
export const SIZE_MIN = 0.25;
export const SIZE_MAX = 0.6;

export const plasmaMeta = defineEffectMeta({
  id: "plasma",
  name: "Plasma Globe",
  description:
    "A plasma globe glowing in a dark corner, its soft violet filaments wandering slowly from the bright electrode out to the glass, with no flicker.",
  params: {
    filaments: {
      kind: "number",
      label: "Filaments",
      min: 4,
      max: MAX_FILAMENTS,
      step: 1,
      default: 9,
    },
    drift: { kind: "number", label: "Drift", min: 0, max: 2, step: 0.05, default: 0.6 },
    colour: { kind: "select", label: "Colour", options: COLOUR_OPTIONS, default: "violet" },
    size: {
      kind: "number",
      label: "Size",
      min: SIZE_MIN,
      max: SIZE_MAX,
      step: 0.01,
      default: 0.42,
    },
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "right" },
  },
  category: "Science",
  tags: ["electricity", "lightning", "tesla", "novelty", "lamp", "neon", "glow", "retro"],
  cost: "very low",
  context: "webgl2",
});
