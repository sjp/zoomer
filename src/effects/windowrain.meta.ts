import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const MAX_LIGHTS = 150;

export const windowRainMeta = defineEffectMeta({
  id: "windowrain",
  name: "Rain on a Window",
  description: "Raindrops run down a night window in front of blurred city lights.",
  params: {
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.01, default: 0.5 },
    speed: { kind: "number", label: "Runner speed", min: 0, max: 3, step: 0.05, default: 1 },
    lights: {
      kind: "number",
      label: "Background lights",
      min: 0,
      max: MAX_LIGHTS,
      step: 1,
      default: 60,
    },
    blur: { kind: "number", label: "Background blur", min: 0, max: 1, step: 0.01, default: 0.6 },
    lightColor1: { kind: "color", label: "Light colour 1", default: "#ffb05c" },
    lightColor2: { kind: "color", label: "Light colour 2", default: "#5cb8ff" },
    background: { kind: "color", label: "Background", default: "#0b1020" },
    fog: { kind: "boolean", label: "Fogged glass", default: false },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  category: "Sky & weather",
  tags: ["rainy day", "glass", "storm", "bokeh"],
  cost: "medium",
  context: "webgl2",
});
