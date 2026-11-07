import { defineEffectMeta } from "../types";

/** March steps per pixel for each `quality` option. */
export const FERRO_STEPS = { high: 24, low: 12 } as const;

export const ferroMeta = defineEffectMeta({
  id: "ferro",
  name: "Ferrofluid",
  description:
    "A glossy black pool of magnetic liquid slowly rises into a crown of sharp spikes, then relaxes into a smooth blob.",
  params: {
    position: {
      kind: "select",
      label: "Position",
      options: [
        { value: "left", label: "Bottom left" },
        { value: "centre", label: "Bottom" },
        { value: "right", label: "Bottom right" },
      ],
      default: "right",
    },
    size: { kind: "number", label: "Pool size", min: 0.6, max: 1.4, step: 0.05, default: 1 },
    rhythm: {
      kind: "select",
      label: "Rhythm",
      options: [
        { value: "breathe", label: "Breathe" },
        { value: "pulse", label: "Pulse" },
        { value: "hold", label: "Hold" },
      ],
      default: "pulse",
    },
    period: { kind: "number", label: "Cycle (s)", min: 6, max: 40, step: 1, default: 14 },
    spikes: { kind: "number", label: "Spike density", min: 3, max: 8, step: 0.5, default: 4.5 },
    backdrop: {
      kind: "select",
      label: "Backdrop",
      options: [
        { value: "grey", label: "Studio grey" },
        { value: "dark", label: "Dark" },
        { value: "warm", label: "Warm" },
      ],
      default: "grey",
    },
    quality: {
      kind: "select",
      label: "Quality",
      options: [
        { value: "high", label: `High (${String(FERRO_STEPS.high)} steps)` },
        { value: "low", label: `Low (${String(FERRO_STEPS.low)} steps)` },
      ],
      default: "high",
    },
  },
  category: "Science",
  tags: ["magnet", "rosensweig", "physics", "liquid metal", "hypnotic", "studio"],
  cost: "medium",
  context: "webgl2",
});
