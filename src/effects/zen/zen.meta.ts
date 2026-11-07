import { defineEffectMeta } from "../types";

export const MAX_STONES = 5;

/** Rake line spacing range in reference px. */
export const SPACING_MIN = 12;

export const SPACING_MAX = 24;

export const zenMeta = defineEffectMeta({
  id: "zen",
  name: "Zen garden",
  description:
    "A raked gravel garden from above: rake lines ringing mossy stones, soft leaf shadows, and a slow rake now and then. Low power.",
  params: {
    gravel: { kind: "color", label: "Gravel colour", default: "#d6d0c2" },
    stones: { kind: "number", label: "Stones", min: 0, max: MAX_STONES, step: 1, default: 3 },
    spacing: {
      kind: "number",
      label: "Line spacing",
      min: SPACING_MIN,
      max: SPACING_MAX,
      step: 1,
      default: 16,
    },
    waviness: { kind: "number", label: "Waviness", min: 0, max: 1, step: 0.01, default: 0.4 },
    shadows: { kind: "number", label: "Leaf shadows", min: 0, max: 1, step: 0.01, default: 0.5 },
    rerake: { kind: "boolean", label: "Rerake now and then", default: true },
    seed: { kind: "number", label: "Layout", min: 1, max: 100, step: 1, default: 1 },
  },
  category: "Cosy",
  tags: ["japanese", "sand", "calm", "meditation"],
  cost: "low",
  context: "webgl2",
});
