import { defineEffectMeta } from "../types";

export const MAX_BUBBLES = 400;

export const bubblesMeta = defineEffectMeta({
  id: "bubbles",
  name: "Rising Bubbles",
  description:
    "Bubbles wobbling up through an aquarium, a glass of champagne or a cola, lit softly from above.",
  params: {
    mode: {
      kind: "select",
      label: "Liquid",
      options: [
        { value: "aquarium", label: "Aquarium" },
        { value: "champagne", label: "Champagne" },
        { value: "soda", label: "Soda" },
      ],
      default: "aquarium",
    },
    count: { kind: "number", label: "Bubbles", min: 20, max: MAX_BUBBLES, step: 5, default: 200 },
    size: { kind: "number", label: "Mean size", min: 3, max: 24, step: 0.5, default: 10 },
    speed: { kind: "number", label: "Rise speed", min: 0, max: 1.5, step: 0.05, default: 1 },
    streams: { kind: "boolean", label: "Streams from fixed points", default: true },
    shafts: { kind: "number", label: "Light shafts", min: 0, max: 1, step: 0.01, default: 0.6 },
    customColors: { kind: "boolean", label: "Custom liquid colours", default: false },
    liquidTop: { kind: "color", label: "Liquid top colour", default: "#2a8a9a" },
    liquidBottom: { kind: "color", label: "Liquid bottom colour", default: "#04222f" },
  },
  category: "Water",
  tags: ["fizz", "soda", "drink", "underwater"],
  cost: "very low",
  context: "webgl2",
});
