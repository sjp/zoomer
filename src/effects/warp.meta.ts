import { defineEffectMeta } from "./types";

export const MAX_STARS = 4000;

export const warpMeta = defineEffectMeta({
  id: "warp",
  name: "Warp Speed",
  description: "A starfield where stars stretch into streaks at faster-than-light speed.",
  category: "Space",
  tags: ["sci-fi", "space travel", "spaceship", "lightspeed"],
  cost: "very low",
  context: "webgl2",
  params: {
    speed: { kind: "number", label: "Speed", min: 0, max: 10, step: 0.1, default: 3 },
    count: { kind: "number", label: "Stars", min: 100, max: MAX_STARS, step: 100, default: 1200 },
    streak: { kind: "number", label: "Streak length", min: 0, max: 1, step: 0.01, default: 0.35 },
    size: { kind: "number", label: "Star size", min: 0.5, max: 6, step: 0.1, default: 2 },
    starColor: { kind: "color", label: "Star colour", default: "#ffffff" },
    tint: { kind: "color", label: "Tint colour", default: "#8fb8ff" },
    tintAmount: {
      kind: "number",
      label: "Tint variation",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.5,
    },
    aberration: {
      kind: "number",
      label: "Chromatic aberration",
      min: 0,
      max: 1,
      step: 0.01,
      default: 0.25,
    },
    background: { kind: "color", label: "Background", default: "#000008" },
  },
});
