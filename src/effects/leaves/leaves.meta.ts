import { defineEffectMeta } from "../types";

export const leavesMeta = defineEffectMeta({
  id: "leaves",
  name: "Falling Leaves",
  description: "Autumn leaves or cherry-blossom petals tumbling down in a gentle, gusty breeze.",
  params: {
    season: {
      kind: "select",
      label: "Season",
      options: [
        { value: "autumn", label: "Autumn leaves" },
        { value: "blossom", label: "Cherry blossom" },
      ],
      default: "autumn",
    },
    count: { kind: "number", label: "Pieces", min: 10, max: 300, step: 5, default: 90 },
    size: { kind: "number", label: "Size", min: 4, max: 40, step: 0.5, default: 16 },
    speed: { kind: "number", label: "Fall speed", min: 0, max: 3, step: 0.05, default: 1 },
    wind: {
      kind: "number",
      label: "Wind (negative = left)",
      min: -1,
      max: 1,
      step: 0.05,
      default: 0.15,
    },
    gusts: { kind: "number", label: "Gusts", min: 0, max: 1, step: 0.01, default: 0.4 },
    foliage: {
      kind: "number",
      label: "Foliage at the edges",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    customBackground: { kind: "boolean", label: "Custom background colours", default: false },
    topColor: { kind: "color", label: "Background top colour", default: "#f1d7ae" },
    bottomColor: { kind: "color", label: "Background bottom colour", default: "#b9774a" },
  },
  category: "Nature",
  tags: ["sakura", "spring", "hanami"],
  cost: "very low",
  context: "webgl2",
});
