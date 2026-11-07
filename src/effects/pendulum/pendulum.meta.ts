import { defineEffectMeta } from "../types";

export const MIN_PENDULUMS = 8;

export const MAX_PENDULUMS = 24;

/** Largest swing, degrees from vertical. */
export const MAX_AMPLITUDE = 20;

export const VIEW_OPTIONS = [
  { value: "front", label: "Front" },
  { value: "angled", label: "Angled" },
  { value: "above", label: "Above" },
] as const;

export const FINISH_OPTIONS = [
  { value: "chrome", label: "Chrome" },
  { value: "brass", label: "Brass" },
  { value: "coloured", label: "Coloured" },
] as const;

export const PLACEMENT_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const;

export const pendulumMeta = defineEffectMeta({
  id: "pendulum",
  name: "Pendulum Wave",
  description:
    "A row of polished pendulums, each a little longer than the last, drifts out of step into travelling waves and back into a single line.",
  params: {
    count: {
      kind: "number",
      label: "Pendulums",
      min: MIN_PENDULUMS,
      max: MAX_PENDULUMS,
      step: 1,
      default: 15,
    },
    cycle: { kind: "number", label: "Cycle (s)", min: 30, max: 120, step: 5, default: 60 },
    amplitude: {
      kind: "number",
      label: "Swing (°)",
      min: 4,
      max: MAX_AMPLITUDE,
      step: 1,
      default: 12,
    },
    view: { kind: "select", label: "View", options: VIEW_OPTIONS, default: "angled" },
    finish: { kind: "select", label: "Finish", options: FINISH_OPTIONS, default: "chrome" },
    placement: { kind: "select", label: "Placement", options: PLACEMENT_OPTIONS, default: "top" },
  },
  category: "Science",
  tags: ["physics", "harmonic", "oscillation", "demonstration", "kinetic", "desk toy", "snake"],
  cost: "very low",
  context: "webgl2",
});
