import { defineEffectMeta } from "../types";

const PALETTE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "hotpink", label: "Hot pink + yellow" },
  { value: "neon", label: "Neon on black" },
  { value: "pastel", label: "Pastel" },
  { value: "primary", label: "Primary" },
] as const;

const ANIMATION_OPTIONS = [
  { value: "paint", label: "Paint on/off" },
  { value: "drift", label: "Drift" },
  { value: "wobble", label: "Wobble" },
  { value: "still", label: "Still" },
] as const;

/** The smallest `scale`: many small strokes. 1 is a few big, cup-sized ones. */
export const MIN_SCALE = 0.4;

export const jazzMeta = defineEffectMeta({
  id: "jazz",
  name: "90s Jazz",
  description:
    "The early-90s paper-cup print: fat dry-brush swashes in teal with thin purple squiggles riding across them, confetti, Memphis zig-zags and paint splatter on white paper, painting themselves on and off one at a time, drifting or gently wobbling, with a sparser middle for you.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "classic" },
    animation: {
      kind: "select",
      label: "Animation",
      options: ANIMATION_OPTIONS,
      default: "paint",
    },
    speed: { kind: "number", label: "Speed", min: 0, max: 1, step: 0.05, default: 0.5 },
    scale: { kind: "number", label: "Scale", min: MIN_SCALE, max: 1, step: 0.05, default: 1 },
    confetti: { kind: "boolean", label: "Confetti", default: true },
    shapes: { kind: "boolean", label: "Memphis shapes", default: true },
    splatter: { kind: "boolean", label: "Paint splatter", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro", "Abstract"],
  tags: [
    "90s",
    "jazz",
    "pattern",
    "squiggle",
    "brush stroke",
    "paper cup",
    "confetti",
    "memphis design",
    "print",
    "teal",
    "purple",
    "geometric",
  ],
  cost: "very low",
  context: "webgl2",
});
