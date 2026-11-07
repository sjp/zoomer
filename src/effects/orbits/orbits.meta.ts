import { defineEffectMeta } from "../types";

export const MIN_PLANETS = 2;

export const MAX_PLANETS = 7;

/** Steepest view tilt, degrees from top-down. */
export const MAX_TILT = 60;

export const SYSTEM_OPTIONS = [
  { value: "single", label: "Single star" },
  { value: "binary", label: "Binary" },
  { value: "random", label: "Random" },
] as const;

export const CENTRE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "centre", label: "Centre" },
] as const;

export const orbitsMeta = defineEffectMeta({
  id: "orbits",
  name: "Orbiting Bodies",
  description:
    "An orrery drawn in light: planets and moons glide along their orbits around a glowing star, trailing soft, fading arcs.",
  params: {
    system: { kind: "select", label: "System", options: SYSTEM_OPTIONS, default: "single" },
    planets: {
      kind: "number",
      label: "Planets",
      min: MIN_PLANETS,
      max: MAX_PLANETS,
      step: 1,
      default: 5,
    },
    speed: { kind: "number", label: "Speed", min: 0.1, max: 3, step: 0.05, default: 1 },
    trails: { kind: "number", label: "Trails", min: 0, max: 1, step: 0.05, default: 0.35 },
    orbits: { kind: "boolean", label: "Orbit lines", default: true },
    tilt: { kind: "number", label: "Tilt (°)", min: 0, max: MAX_TILT, step: 1, default: 35 },
    centre: { kind: "select", label: "Centre", options: CENTRE_OPTIONS, default: "right" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 4 },
  },
  category: "Space",
  tags: ["orrery", "solar system", "astronomy", "kepler", "moons", "binary star"],
  cost: "very low",
  context: "webgl2",
});
