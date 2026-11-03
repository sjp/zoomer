import { defineEffectMeta } from "./types";

export const MIN_CRANES = 3;
export const MAX_CRANES = 20;
/** Hanging cranes along the top edge when the mobile is on. */
export const MOBILE_CRANES = 4;

export const PALETTE_OPTIONS = [
  { value: "pastel", label: "Pastel" },
  { value: "washi", label: "Washi" },
  { value: "white", label: "White" },
  { value: "rainbow", label: "Rainbow" },
] as const;

export const SKY_OPTIONS = [
  { value: "dawn", label: "Dawn" },
  { value: "blue", label: "Pale blue" },
  { value: "paper", label: "Paper" },
] as const;

export const cranesMeta = defineEffectMeta({
  id: "cranes",
  name: "Origami Cranes",
  description:
    "Folded paper cranes drifting across a pale sky, banking gently and now and then flapping their wings.",
  params: {
    cranes: {
      kind: "number",
      label: "Cranes",
      min: MIN_CRANES,
      max: MAX_CRANES,
      step: 1,
      default: 9,
    },
    palette: { kind: "select", label: "Paper", options: PALETTE_OPTIONS, default: "pastel" },
    sky: { kind: "select", label: "Sky", options: SKY_OPTIONS, default: "dawn" },
    mobile: { kind: "boolean", label: "Hanging mobile", default: true },
    speed: { kind: "number", label: "Speed", min: 0, max: 2, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  category: "Cosy",
  tags: ["origami", "paper", "birds", "papercraft", "senbazuru", "japanese", "calm"],
  cost: "very low",
  context: "webgl2",
});
