import { defineEffectMeta } from "./types";

export const tunnelMeta = defineEffectMeta({
  id: "tunnel",
  name: "Wormhole Tunnel",
  description: "Fly forward through an endless, gently bending tunnel of glowing, swirling energy.",
  params: {
    speed: { kind: "number", label: "Forward speed", min: 0, max: 4, step: 0.05, default: 1 },
    twist: {
      kind: "number",
      label: "Twist (turns per minute)",
      min: -30,
      max: 30,
      step: 0.5,
      default: 4,
    },
    spiral: {
      kind: "number",
      label: "Spiral (corkscrew)",
      min: -2,
      max: 2,
      step: 0.05,
      default: 0.6,
    },
    bend: {
      kind: "number",
      label: "Bend (centre wander)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    color1: { kind: "color", label: "Colour 1 (dim)", default: "#0b0640" },
    color2: { kind: "color", label: "Colour 2 (mid)", default: "#7a2cff" },
    color3: { kind: "color", label: "Colour 3 (bright)", default: "#46e8ff" },
    rings: { kind: "number", label: "Ring bands", min: 0, max: 1, step: 0.01, default: 0.35 },
    core: {
      kind: "select",
      label: "Tunnel core",
      options: [
        { value: "bright", label: "Bright light" },
        { value: "dark", label: "Dark void" },
      ],
      default: "bright",
    },
    brightness: { kind: "number", label: "Brightness", min: 0.2, max: 2, step: 0.05, default: 1 },
  },
  context: "webgl2",
});
