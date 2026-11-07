import { defineEffectMeta } from "../types";

/** Most particles; the particle buffers are this size whatever the params. */
export const MAX_PARTICLES = 60000;

export const SYSTEM_OPTIONS = [
  { value: "lorenz", label: "Lorenz" },
  { value: "aizawa", label: "Aizawa" },
  { value: "thomas", label: "Thomas" },
] as const;

export const PALETTE_OPTIONS = [
  { value: "cyanamber", label: "Cyan and amber" },
  { value: "ice", label: "Ice" },
  { value: "ember", label: "Ember" },
  { value: "rainbow", label: "Rainbow" },
] as const;

export const POSITION_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
  { value: "centre", label: "Centre" },
] as const;

export const lorenzMeta = defineEffectMeta({
  id: "lorenz",
  name: "Lorenz Attractor",
  description:
    "Tens of thousands of glowing particles stream around the butterfly wings of a chaotic attractor as the camera slowly circles it.",
  category: "Science",
  tags: ["chaos", "butterfly effect", "strange attractor", "maths", "aizawa", "thomas"],
  cost: "low",
  context: "webgl2",
  params: {
    system: { kind: "select", label: "System", options: SYSTEM_OPTIONS, default: "lorenz" },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "cyanamber" },
    particles: {
      kind: "number",
      label: "Particles",
      min: 5000,
      max: MAX_PARTICLES,
      step: 1000,
      default: 30000,
    },
    speed: { kind: "number", label: "Flow speed", min: 0.25, max: 2, step: 0.05, default: 1 },
    orbit: { kind: "number", label: "Camera orbit", min: -1, max: 1, step: 0.05, default: 0.4 },
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "left" },
  },
});
