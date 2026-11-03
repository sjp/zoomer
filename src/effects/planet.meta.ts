import { QUALITY_OPTIONS } from "./param-options";
import { defineEffectMeta } from "./types";

export const WORLD_OPTIONS = [
  { value: "earth", label: "Earth-like" },
  { value: "ice", label: "Ice moon" },
  { value: "desert", label: "Desert world" },
  { value: "gas", label: "Gas giant" },
] as const;

export const FRAMING_OPTIONS = [
  { value: "bottomLeft", label: "Bottom left" },
  { value: "bottom", label: "Bottom" },
  { value: "bottomRight", label: "Bottom right" },
  { value: "left", label: "Left" },
  { value: "full", label: "Full disc" },
  { value: "right", label: "Right" },
  { value: "topLeft", label: "Top left" },
  { value: "top", label: "Top" },
  { value: "topRight", label: "Top right" },
] as const;

export const planetMeta = defineEffectMeta({
  id: "planet",
  name: "Planet from orbit",
  description:
    "A planet filling a corner or edge of the frame, or whole, turning at an adjustable speed, with day and night sides, clouds, city lights and a glowing atmosphere.",
  params: {
    world: { kind: "select", label: "World", options: WORLD_OPTIONS, default: "earth" },
    framing: { kind: "select", label: "Framing", options: FRAMING_OPTIONS, default: "bottomLeft" },
    size: { kind: "number", label: "Size", min: 0.4, max: 2, step: 0.01, default: 1 },
    rotation: {
      kind: "number",
      label: "Rotation speed",
      min: -20,
      max: 20,
      step: 0.1,
      default: 1,
    },
    sunAngle: { kind: "number", label: "Sun angle", min: 0, max: 180, step: 1, default: 60 },
    clouds: { kind: "number", label: "Clouds", min: 0, max: 1, step: 0.01, default: 0.5 },
    cities: { kind: "number", label: "City lights", min: 0, max: 1, step: 0.01, default: 0.7 },
    seed: { kind: "number", label: "Seed", min: 0, max: 999, step: 1, default: 1 },
    quality: { kind: "select", label: "Quality", options: QUALITY_OPTIONS, default: "balanced" },
  },
  context: "webgl2",
});
