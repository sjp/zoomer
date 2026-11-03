import { defineEffectMeta } from "./types";

export type MixId = "natural" | "alpha" | "muon";
export type LightId = "white" | "blue" | "warm";

export const MIX_OPTIONS = [
  { value: "natural", label: "Natural" },
  { value: "alpha", label: "Alpha-rich" },
  { value: "muon", label: "Muon-rich" },
] as const satisfies readonly { value: MixId; label: string }[];

export const LIGHT_OPTIONS = [
  { value: "white", label: "Side white" },
  { value: "blue", label: "Blue" },
  { value: "warm", label: "Warm" },
] as const satisfies readonly { value: LightId; label: string }[];

/** Most tracks per second. */
export const RATE_MAX = 6;

export const chamberMeta = defineEffectMeta({
  id: "chamber",
  name: "Cloud Chamber",
  description:
    "A dark, misty chamber lit from the side, where particle tracks keep appearing out of nowhere: thick alpha stubs, wiggly electrons and long, faint muons bloom into vapour trails and slowly fade.",
  params: {
    rate: {
      kind: "number",
      label: "Tracks per second",
      min: 0.2,
      max: RATE_MAX,
      step: 0.1,
      default: 1.5,
    },
    mix: { kind: "select", label: "Particle mix", options: MIX_OPTIONS, default: "natural" },
    magnetic: { kind: "boolean", label: "Magnetic field", default: false },
    light: { kind: "select", label: "Light", options: LIGHT_OPTIONS, default: "white" },
    mist: { kind: "number", label: "Mist", min: 0, max: 1, step: 0.05, default: 0.5 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 3 },
  },
  category: "Science",
  tags: ["physics", "subatomic", "radiation", "laboratory", "experiment", "cosmic rays", "wilson"],
  cost: "very low",
  context: "webgl2",
});
