import { defineEffectMeta } from "./types";

export const MAX_SHADOW_SOFTNESS = 4;

export const MIN_RIDGES = 3;

export const MAX_RIDGES = 5;

/** Largest crest softness (see `duneShape` and `fillRidgeTable`). */
export const MAX_CREST_SOFTNESS = 4;

export const dunesMeta = defineEffectMeta({
  id: "dunes",
  name: "Sand Dunes",
  description:
    "Calm desert dunes under a clear sky, with long shadows that creep as the sun slowly moves.",
  params: {
    sandColor: { kind: "color", label: "Sand colour", default: "#d9a76f" },
    skyTop: { kind: "color", label: "Sky top colour", default: "#3f78c0" },
    skyHorizon: { kind: "color", label: "Sky horizon colour", default: "#efd9b8" },
    sunHeight: { kind: "number", label: "Sun height", min: 0, max: 1, step: 0.01, default: 0.15 },
    sunDrift: { kind: "boolean", label: "Sun drift", default: true },
    driftSpeed: {
      kind: "number",
      label: "Sun cycle (minutes)",
      min: 5,
      max: 20,
      step: 1,
      default: 10,
    },
    ridges: {
      kind: "number",
      label: "Ridges",
      min: MIN_RIDGES,
      max: MAX_RIDGES,
      step: 1,
      default: 4,
    },
    crestSoftness: {
      kind: "number",
      label: "Crest softness",
      min: 0,
      max: MAX_CREST_SOFTNESS,
      step: 0.01,
      default: 2,
    },
    shadowSoftness: {
      kind: "number",
      label: "Shadow softness",
      min: 0,
      max: MAX_SHADOW_SOFTNESS,
      step: 0.01,
      default: 2,
    },
    ripples: { kind: "number", label: "Ripples", min: 0, max: 1, step: 0.01, default: 0.5 },
    seed: { kind: "number", label: "Seed", min: 1, max: 100, step: 1, default: 1 },
  },
  context: "webgl2",
});
