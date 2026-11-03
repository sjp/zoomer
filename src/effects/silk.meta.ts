import { defineEffectMeta } from "./types";

export const MIN_FOLDS = 3;

export const MAX_FOLDS = 12;

/** Top of the breeze slider: the fastest wave then still takes a few seconds per cycle. */
export const MAX_BREEZE = 2;

export const silkMeta = defineEffectMeta({
  id: "silk",
  name: "Silk drapery",
  description:
    "Deep folds of satin rippling slowly in a breeze, with a sheen that slides along the crests.",
  params: {
    layout: {
      kind: "select",
      label: "Layout",
      options: [
        { value: "hanging", label: "Hanging" },
        { value: "flowing", label: "Flowing" },
        { value: "billowing", label: "Billowing" },
      ],
      default: "hanging",
    },
    color: { kind: "color", label: "Colour", default: "#7a1a36" },
    shotColor: { kind: "color", label: "Shot colour", default: "#c7862c" },
    shot: { kind: "number", label: "Shot", min: 0, max: 1, step: 0.01, default: 0.35 },
    sheen: { kind: "number", label: "Sheen", min: 0, max: 1, step: 0.01, default: 0.6 },
    folds: {
      kind: "number",
      label: "Folds",
      min: MIN_FOLDS,
      max: MAX_FOLDS,
      step: 0.5,
      default: 6,
    },
    depth: { kind: "number", label: "Fold depth", min: 0, max: 2, step: 0.05, default: 1 },
    breeze: { kind: "number", label: "Breeze", min: 0, max: MAX_BREEZE, step: 0.05, default: 1 },
    lightAngle: {
      kind: "number",
      label: "Light angle (degrees)",
      min: 0,
      max: 360,
      step: 1,
      default: 120,
    },
  },
  category: "Abstract",
  tags: ["fabric", "cloth", "luxury", "curtain"],
  cost: "low",
  context: "webgl2",
});
