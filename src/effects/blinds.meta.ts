import { defineEffectMeta } from "./types";

export const MAX_MOTES = 80;

export const blindsMeta = defineEffectMeta({
  id: "blinds",
  name: "Light through blinds",
  description:
    "Soft stripes of late-afternoon sun through venetian blinds on a plain wall, with passing clouds and drifting dust.",
  params: {
    wallColor: { kind: "color", label: "Wall colour", default: "#d6cab8" },
    lightColor: { kind: "color", label: "Sunlight colour", default: "#ffd9a0" },
    angle: {
      kind: "number",
      label: "Stripe angle (degrees)",
      min: 0,
      max: 60,
      step: 1,
      default: 25,
    },
    slats: { kind: "number", label: "Slats", min: 6, max: 20, step: 1, default: 11 },
    softness: { kind: "number", label: "Softness", min: 0, max: 1, step: 0.01, default: 0.35 },
    position: {
      kind: "select",
      label: "Window position",
      options: [
        { value: "topRight", label: "Top right" },
        { value: "topLeft", label: "Top left" },
        { value: "right", label: "Right" },
        { value: "left", label: "Left" },
      ],
      default: "topRight",
    },
    clouds: { kind: "number", label: "Clouds", min: 0, max: 1, step: 0.01, default: 0.4 },
    dust: { kind: "number", label: "Dust motes", min: 0, max: MAX_MOTES, step: 1, default: 30 },
    plaster: { kind: "number", label: "Plaster texture", min: 0, max: 1, step: 0.01, default: 0.3 },
    sunDrift: { kind: "boolean", label: "Sun drift", default: true },
  },
  category: "Cosy",
  tags: ["sunlight", "shadows", "window", "office"],
  cost: "very low",
  context: "webgl2",
});
