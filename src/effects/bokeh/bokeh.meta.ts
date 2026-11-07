import { defineEffectMeta } from "../types";

export const MAX_LIGHTS = 200;

export const bokehMeta = defineEffectMeta({
  id: "bokeh",
  name: "Bokeh Lights",
  description: "Soft, out-of-focus discs of light drifting slowly, like lights behind a wide lens.",
  params: {
    count: { kind: "number", label: "Lights", min: 5, max: MAX_LIGHTS, step: 1, default: 55 },
    size: { kind: "number", label: "Light size", min: 20, max: 220, step: 1, default: 80 },
    sizeVariation: {
      kind: "number",
      label: "Size variation",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    softness: { kind: "number", label: "Edge softness", min: 0, max: 1, step: 0.01, default: 0.35 },
    speed: { kind: "number", label: "Drift speed", min: 0, max: 5, step: 0.1, default: 1 },
    direction: {
      kind: "number",
      label: "Drift direction (degrees, 90 = up)",
      min: 0,
      max: 360,
      step: 1,
      default: 100,
    },
    wander: { kind: "number", label: "Wander", min: 0, max: 1, step: 0.01, default: 0.5 },
    twinkle: { kind: "number", label: "Twinkle", min: 0, max: 1, step: 0.01, default: 0.35 },
    brightness: {
      kind: "number",
      label: "Brightness",
      min: 0.2,
      max: 2,
      step: 0.05,
      default: 1,
    },
    color1: { kind: "color", label: "Light colour 1", default: "#ffb347" },
    color2: { kind: "color", label: "Light colour 2", default: "#ff6f91" },
    color3: { kind: "color", label: "Light colour 3", default: "#ffe08a" },
    shape: {
      kind: "select",
      label: "Aperture shape",
      options: [
        { value: "circle", label: "Circle" },
        { value: "hexagon", label: "Hexagon" },
      ],
      default: "circle",
    },
    backgroundTop: { kind: "color", label: "Background top colour", default: "#07050f" },
    backgroundBottom: { kind: "color", label: "Background bottom colour", default: "#2a0f22" },
  },
  category: "Abstract",
  tags: ["blur", "circles", "christmas", "sparkle"],
  cost: "low",
  context: "webgl2",
});
