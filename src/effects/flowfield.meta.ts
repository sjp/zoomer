import { defineEffectMeta } from "./types";

export const MAX_PARTICLES = 8000;

export const flowfieldMeta = defineEffectMeta({
  id: "flowfield",
  name: "Flow Field",
  description: "Thousands of particles follow a slowly shifting current and leave silky trails.",
  params: {
    count: {
      kind: "number",
      label: "Particles",
      min: 500,
      max: MAX_PARTICLES,
      step: 100,
      default: 2500,
    },
    speed: { kind: "number", label: "Speed", min: 0, max: 4, step: 0.05, default: 1 },
    fieldScale: { kind: "number", label: "Field detail", min: 0.2, max: 4, step: 0.05, default: 1 },
    turbulence: { kind: "number", label: "Turbulence", min: 0.1, max: 3, step: 0.05, default: 1 },
    evolve: {
      kind: "number",
      label: "Field change speed",
      min: 0,
      max: 3,
      step: 0.05,
      default: 0.5,
    },
    trail: { kind: "number", label: "Trail length", min: 0, max: 1, step: 0.01, default: 0.7 },
    lineWidth: { kind: "number", label: "Line width", min: 0.5, max: 6, step: 0.1, default: 1.6 },
    opacity: { kind: "number", label: "Opacity", min: 0.05, max: 1, step: 0.01, default: 0.6 },
    color1: { kind: "color", label: "Colour 1", default: "#3fd0ff" },
    color2: { kind: "color", label: "Colour 2", default: "#8a5cff" },
    color3: { kind: "color", label: "Colour 3", default: "#ff6fa8" },
    useColor3: { kind: "boolean", label: "Use colour 3", default: true },
    colorBy: {
      kind: "select",
      label: "Colour by",
      options: [
        { value: "angle", label: "Flow direction" },
        { value: "random", label: "Random per particle" },
      ],
      default: "angle",
    },
    background: { kind: "color", label: "Background", default: "#05060f" },
    seed: { kind: "number", label: "Field seed", min: 1, max: 9999, step: 1, default: 1 },
  },
  context: "webgl2",
});
