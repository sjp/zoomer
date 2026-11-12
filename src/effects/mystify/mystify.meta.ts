import { defineEffectMeta } from "../types";

export const MAX_SHAPES = 4;
export const MIN_POINTS = 3;
export const MAX_POINTS = 8;
export const MAX_TRAIL = 20;
/** Fastest `speed` slider value; one unit is a tenth of the frame height per second. */
export const MAX_SPEED = 2.5;

export type MystifyMirror = "off" | "horizontal" | "vertical" | "both";

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

const MIRROR_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "horizontal", label: "Horizontal" },
  { value: "vertical", label: "Vertical" },
  { value: "both", label: "Both" },
] as const satisfies readonly { value: MystifyMirror; label: string }[];

export const mystifyMeta = defineEffectMeta({
  id: "mystify",
  name: "Mystify",
  description:
    "The classic Windows screensaver: polygons whose corners bounce around a black screen, each trailing a fan of echo outlines as its colour drifts through the spectrum.",
  category: "Retro",
  tags: ["lines", "90s", "nostalgia", "geometric", "vector", "rainbow"],
  cost: "very low",
  context: "webgl2",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    shapes: { kind: "number", label: "Shapes", min: 1, max: MAX_SHAPES, step: 1, default: 2 },
    points: {
      kind: "number",
      label: "Corners",
      min: MIN_POINTS,
      max: MAX_POINTS,
      step: 1,
      default: 4,
    },
    trail: { kind: "number", label: "Echoes", min: 0, max: MAX_TRAIL, step: 1, default: 8 },
    speed: { kind: "number", label: "Speed", min: 0.2, max: MAX_SPEED, step: 0.1, default: 0.6 },
    mirror: { kind: "select", label: "Mirror", options: MIRROR_OPTIONS, default: "off" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
});
