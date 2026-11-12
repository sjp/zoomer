import { defineEffectMeta } from "../types";

export const MAX_CURVES = 3;
export const MAX_SEGMENTS = 5;
export const MAX_TRAIL = 30;
/** Fastest `speed` slider value; one unit is a tenth of the frame height per second. */
export const MAX_SPEED = 2.5;

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

export const beziersMeta = defineEffectMeta({
  id: "beziers",
  name: "Béziers",
  description:
    "The classic Windows screensaver: closed loops of smooth curves whose control points bounce around a black screen, each trailing a ribbon of echoes as its colour drifts through the spectrum.",
  category: "Retro",
  tags: ["lines", "90s", "nostalgia", "vector", "rainbow", "bezier", "splines"],
  cost: "very low",
  context: "webgl2",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    curves: { kind: "number", label: "Loops", min: 1, max: MAX_CURVES, step: 1, default: 1 },
    segments: {
      kind: "number",
      label: "Segments",
      min: 1,
      max: MAX_SEGMENTS,
      step: 1,
      default: 2,
    },
    trail: { kind: "number", label: "Echoes", min: 0, max: MAX_TRAIL, step: 1, default: 12 },
    speed: { kind: "number", label: "Speed", min: 0.2, max: MAX_SPEED, step: 0.1, default: 0.6 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
});
