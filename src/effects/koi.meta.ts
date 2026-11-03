import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const MAX_FISH = 15;

export const MAX_PADS = 20;

export const koiMeta = defineEffectMeta({
  id: "koi",
  name: "Koi Pond",
  description: "Koi gliding beneath lily pads over a pebbled floor, with now-and-then ripples.",
  category: "Water",
  tags: ["fish", "japanese", "garden", "carp"],
  cost: "medium",
  context: "webgl2",
  params: {
    fish: { kind: "number", label: "Fish", min: 3, max: MAX_FISH, step: 1, default: 7 },
    size: { kind: "number", label: "Fish size", min: 60, max: 220, step: 1, default: 130 },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.05, default: 1 },
    varieties: {
      kind: "select",
      label: "Varieties",
      options: [
        { value: "mixed", label: "Mixed" },
        { value: "kohaku", label: "Kohaku" },
        { value: "ogon", label: "Ogon" },
        { value: "showa", label: "Showa" },
      ],
      default: "mixed",
    },
    lilyPads: { kind: "number", label: "Lily pads", min: 0, max: MAX_PADS, step: 1, default: 7 },
    ripples: { kind: "boolean", label: "Ripples", default: true },
    water: { kind: "color", label: "Water colour", default: "#2c4a38" },
    caustics: { kind: "number", label: "Caustics", min: 0, max: 1, step: 0.01, default: 0.45 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
});
