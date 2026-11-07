import { defineEffectMeta } from "../types";

export const AGENT_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
] as const;

export const PALETTE_OPTIONS = [
  { value: "gold", label: "Gold" },
  { value: "bioluminescent", label: "Bioluminescent" },
  { value: "ember", label: "Ember" },
  { value: "mono", label: "Mono" },
] as const;

export const physarumMeta = defineEffectMeta({
  id: "physarum",
  name: "Slime Mould",
  description:
    "Glowing vein networks grow, branch and slowly re-route, like a slime mould foraging.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "gold" },
    agents: { kind: "select", label: "Agents", options: AGENT_OPTIONS, default: "medium" },
    scale: { kind: "number", label: "Network scale", min: 0.75, max: 2, step: 0.05, default: 1.25 },
    speed: { kind: "number", label: "Agent speed", min: 0.1, max: 1.5, step: 0.05, default: 0.5 },
    decay: { kind: "number", label: "Trail decay", min: 0.08, max: 0.3, step: 0.01, default: 0.15 },
    food: { kind: "boolean", label: "Drifting food sources", default: true },
    calmCentre: { kind: "boolean", label: "Calm centre", default: true },
  },
  category: "Science",
  tags: ["biology", "simulation", "organic", "veins", "mycelium", "fungus"],
  cost: "medium",
  context: "webgl2",
});
