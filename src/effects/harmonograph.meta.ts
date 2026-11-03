import { defineEffectMeta } from "./types";

export const harmonographMeta = defineEffectMeta({
  id: "harmonograph",
  name: "Harmonograph",
  description: "Glowing pendulum curves that slowly draw themselves, then fade.",
  category: "Science",
  tags: ["lissajous", "spirograph", "geometry"],
  cost: "very low",
  context: "webgl2",
  params: {
    palette: {
      kind: "select",
      label: "Palette",
      options: [
        { value: "neon", label: "Neon" },
        { value: "ember", label: "Ember" },
        { value: "ocean", label: "Ocean" },
        { value: "mono", label: "Mono" },
      ],
      default: "neon",
    },
    background: { kind: "color", label: "Background", default: "#05060c" },
    drawTime: {
      kind: "number",
      label: "Seconds per figure",
      min: 30,
      max: 180,
      step: 5,
      default: 75,
    },
    lineWidth: { kind: "number", label: "Line width", min: 1, max: 6, step: 0.5, default: 2.5 },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.6 },
    complexity: { kind: "number", label: "Complexity", min: 0, max: 1, step: 0.01, default: 0.4 },
    position: {
      kind: "select",
      label: "Position",
      options: [
        { value: "centre", label: "Centre" },
        { value: "left", label: "Left" },
        { value: "right", label: "Right" },
      ],
      default: "centre",
    },
  },
});
