import { defineEffectMeta } from "./types";

export const MAX_SNOW = 200;

export const MAX_JELLIES = 20;

export const jellyfishMeta = defineEffectMeta({
  id: "jellyfish",
  name: "Jellyfish",
  description:
    "Translucent jellyfish pulsing slowly through deep blue water, trailing soft tentacles.",
  params: {
    count: { kind: "number", label: "Jellyfish", min: 1, max: MAX_JELLIES, step: 1, default: 7 },
    size: { kind: "number", label: "Size", min: 20, max: 140, step: 1, default: 60 },
    palette: {
      kind: "select",
      label: "Palette",
      options: [
        { value: "moon", label: "Moon" },
        { value: "violet", label: "Violet" },
        { value: "sunset", label: "Sunset" },
        { value: "mixed", label: "Mixed" },
      ],
      default: "mixed",
    },
    pulse: { kind: "number", label: "Pulse rate", min: 0.25, max: 2.5, step: 0.05, default: 1 },
    tentacles: {
      kind: "number",
      label: "Tentacle length",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.7,
    },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.5 },
    particles: {
      kind: "number",
      label: "Marine snow",
      min: 0,
      max: MAX_SNOW,
      step: 1,
      default: 80,
    },
    water: { kind: "color", label: "Water colour", default: "#0a2c52" },
  },
  category: "Water",
  tags: ["ocean", "sea", "deep sea", "aquarium", "creatures"],
  cost: "low",
  context: "webgl2",
});
