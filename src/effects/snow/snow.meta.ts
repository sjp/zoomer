import { defineEffectMeta } from "../types";

export const MAX_FLAKES = 1500;

export const snowMeta = defineEffectMeta({
  id: "snow",
  name: "Snowfall",
  description:
    "Gentle snow drifting down through a night sky, with soft near flakes and a gusty breeze.",
  params: {
    count: { kind: "number", label: "Flakes", min: 50, max: MAX_FLAKES, step: 10, default: 420 },
    size: { kind: "number", label: "Flake size", min: 1, max: 10, step: 0.1, default: 3.5 },
    speed: { kind: "number", label: "Fall speed", min: 0, max: 4, step: 0.05, default: 1 },
    wind: {
      kind: "number",
      label: "Wind (negative = left)",
      min: -2,
      max: 2,
      step: 0.05,
      default: 0.2,
    },
    gustiness: { kind: "number", label: "Gustiness", min: 0, max: 1, step: 0.01, default: 0.35 },
    sway: { kind: "number", label: "Sway", min: 0, max: 1, step: 0.01, default: 0.5 },
    depthBlur: {
      kind: "number",
      label: "Depth blur (near flake softness)",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.6,
    },
    color: { kind: "color", label: "Flake colour", default: "#eef4ff" },
    brightness: {
      kind: "number",
      label: "Flake brightness",
      min: 0.2,
      max: 1.5,
      step: 0.05,
      default: 0.9,
    },
    backgroundTop: { kind: "color", label: "Sky top colour", default: "#040a1c" },
    backgroundBottom: { kind: "color", label: "Horizon colour", default: "#1a2b4d" },
    mist: { kind: "number", label: "Ground mist", min: 0, max: 1, step: 0.01, default: 0.25 },
  },
  category: "Sky & weather",
  tags: ["winter", "christmas", "cold", "snowflakes"],
  cost: "very low",
  context: "webgl2",
});
