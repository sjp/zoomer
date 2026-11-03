import { defineEffectMeta } from "./types";

export const MAX_STREAKS = 3000;

export const hyperspaceMeta = defineEffectMeta({
  id: "hyperspace",
  name: "Hyperspace",
  description:
    "Stars stretch into a blue-white tunnel of light, with an optional jump in/out cycle.",
  context: "webgl2",
  params: {
    speed: { kind: "number", label: "Speed", min: 0.1, max: 5, step: 0.1, default: 1.5 },
    count: {
      kind: "number",
      label: "Streaks",
      min: 200,
      max: MAX_STREAKS,
      step: 100,
      default: 900,
    },
    stretch: { kind: "number", label: "Stretch", min: 0.05, max: 1, step: 0.01, default: 0.8 },
    width: { kind: "number", label: "Streak width", min: 0.5, max: 6, step: 0.1, default: 2 },
    color: { kind: "color", label: "Streak colour", default: "#d6e4ff" },
    glowColor: { kind: "color", label: "Glow colour", default: "#3060ff" },
    glow: { kind: "number", label: "Glow", min: 0, max: 1, step: 0.01, default: 0.5 },
    mode: {
      kind: "select",
      label: "Jump",
      options: [
        { value: "cycle", label: "Auto cycle in/out" },
        { value: "in", label: "Jump to hyperspace" },
        { value: "out", label: "Drop to normal space" },
      ],
      default: "cycle",
    },
    jumpSeconds: {
      kind: "number",
      label: "Jump duration (s)",
      min: 0.3,
      max: 5,
      step: 0.1,
      default: 1.6,
    },
    cycleSeconds: {
      kind: "number",
      label: "Cycle length (s)",
      min: 6,
      max: 60,
      step: 1,
      default: 16,
    },
    flash: { kind: "boolean", label: "Flash on jump", default: true },
    background: { kind: "color", label: "Background", default: "#000005" },
  },
});
