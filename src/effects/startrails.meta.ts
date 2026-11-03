import { defineEffectMeta } from "./types";

export const TRAIL_LENGTH_MIN = 5;

export const TRAIL_LENGTH_MAX = 180;

export const startrailsMeta = defineEffectMeta({
  id: "startrails",
  name: "Star Trails",
  description:
    "A long-exposure night sky: star trails arc around the celestial pole over a dark landscape, turning slowly.",
  params: {
    pole: {
      kind: "select",
      label: "Pole",
      options: [
        { value: "topLeft", label: "Top left" },
        { value: "topRight", label: "Top right" },
        { value: "above", label: "Above frame" },
        { value: "centre", label: "Centre" },
      ],
      default: "topRight",
    },
    trailLength: {
      kind: "number",
      label: "Trail length (°)",
      min: TRAIL_LENGTH_MIN,
      max: TRAIL_LENGTH_MAX,
      step: 1,
      default: 40,
    },
    density: { kind: "number", label: "Density", min: 0.05, max: 1, step: 0.05, default: 0.5 },
    speed: { kind: "number", label: "Speed (°/min)", min: 0, max: 60, step: 1, default: 6 },
    style: {
      kind: "select",
      label: "Style",
      options: [
        { value: "photo", label: "Photo" },
        { value: "comet", label: "Comet" },
      ],
      default: "photo",
    },
    colorful: { kind: "number", label: "Colour", min: 0, max: 1, step: 0.05, default: 0.6 },
    milkyWay: { kind: "number", label: "Milky Way", min: 0, max: 1, step: 0.05, default: 0.4 },
    foreground: {
      kind: "select",
      label: "Foreground",
      options: [
        { value: "treeline", label: "Treeline" },
        { value: "mountains", label: "Mountains" },
        { value: "tree", label: "Lone tree" },
        { value: "none", label: "None" },
      ],
      default: "treeline",
    },
    skyTop: { kind: "color", label: "Sky top", default: "#020309" },
    skyBottom: { kind: "color", label: "Sky bottom", default: "#13204a" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 7 },
  },
  context: "webgl2",
});
