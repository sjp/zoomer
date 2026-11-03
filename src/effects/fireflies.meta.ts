import { defineEffectMeta } from "./types";

export const MAX_SPECKS = 300;

export const MAX_BEAMS = 3;

export const firefliesMeta = defineEffectMeta({
  id: "fireflies",
  name: "Fireflies",
  description:
    "Glowing fireflies blinking over a dusky gradient, or dust motes drifting through soft beams of light.",
  params: {
    scene: {
      kind: "select",
      label: "Scene",
      options: [
        { value: "fireflies", label: "Fireflies" },
        { value: "dust", label: "Dust in light" },
      ],
      default: "fireflies",
    },
    count: { kind: "number", label: "Specks", min: 5, max: MAX_SPECKS, step: 1, default: 70 },
    size: { kind: "number", label: "Speck size", min: 1, max: 10, step: 0.1, default: 3 },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 4, step: 0.05, default: 1 },
    brightness: {
      kind: "number",
      label: "Brightness",
      min: 0.2,
      max: 2,
      step: 0.05,
      default: 1,
    },
    glowColor: { kind: "color", label: "Firefly colour", default: "#d8ff6a" },
    lightColor: { kind: "color", label: "Light colour (dust)", default: "#ffe6bf" },
    topColor: { kind: "color", label: "Background top colour", default: "#0c1a26" },
    bottomColor: { kind: "color", label: "Background bottom colour", default: "#050c08" },
    beams: { kind: "number", label: "Beams (dust)", min: 1, max: MAX_BEAMS, step: 1, default: 2 },
    beamAngle: {
      kind: "number",
      label: "Beam angle (dust, degrees)",
      min: -45,
      max: 45,
      step: 1,
      default: 24,
    },
  },
  context: "webgl2",
});
