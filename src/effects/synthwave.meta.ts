import { defineEffectMeta } from "./types";

export const synthwaveMeta = defineEffectMeta({
  id: "synthwave",
  name: "Synthwave Grid",
  description:
    "A retro 80s neon horizon with a striped sun, mountains and a glowing grid rolling toward you.",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 5, step: 0.1, default: 1 },
    gridColor: { kind: "color", label: "Grid colour", default: "#ff3fd2" },
    gridGlow: { kind: "number", label: "Grid glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    gridSize: {
      kind: "number",
      label: "Grid cell size",
      min: 0.2,
      max: 1.2,
      step: 0.05,
      default: 0.5,
    },
    skyTop: { kind: "color", label: "Sky top colour", default: "#0a0220" },
    skyBottom: { kind: "color", label: "Sky horizon colour", default: "#6a1a7a" },
    sunTop: { kind: "color", label: "Sun top colour", default: "#ffe45c" },
    sunBottom: { kind: "color", label: "Sun bottom colour", default: "#ff2a8a" },
    sunSize: { kind: "number", label: "Sun size", min: 0.05, max: 0.45, step: 0.01, default: 0.24 },
    sunGlow: { kind: "number", label: "Sun glow", min: 0, max: 1, step: 0.01, default: 0.5 },
    sunStripes: { kind: "boolean", label: "Sun stripes", default: true },
    mountains: { kind: "boolean", label: "Mountains", default: true },
    horizon: {
      kind: "number",
      label: "Horizon height",
      min: 0.25,
      max: 0.75,
      step: 0.01,
      default: 0.45,
    },
    sway: { kind: "number", label: "Camera sway", min: 0, max: 1, step: 0.01, default: 0.15 },
    scanlines: { kind: "boolean", label: "CRT scanlines", default: false },
  },
  category: "Retro",
  tags: ["outrun", "vaporwave", "sunset", "eighties", "retrowave"],
  cost: "low",
  context: "webgl2",
});
