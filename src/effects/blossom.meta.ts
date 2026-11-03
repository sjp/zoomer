import { defineEffectMeta } from "./types";

export type CornerId = "topLeft" | "topRight" | "both";
export type SkyId = "morning" | "haze" | "dusk";
export type BlossomId = "pink" | "white" | "deep";

export const CORNER_OPTIONS = [
  { value: "topLeft", label: "Top left" },
  { value: "topRight", label: "Top right" },
  { value: "both", label: "Both" },
] as const satisfies readonly { value: CornerId; label: string }[];

export const SKY_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "haze", label: "Haze" },
  { value: "dusk", label: "Dusk" },
] as const satisfies readonly { value: SkyId; label: string }[];

export const BLOSSOM_OPTIONS = [
  { value: "pink", label: "Pink" },
  { value: "white", label: "White" },
  { value: "deep", label: "Deep pink" },
] as const satisfies readonly { value: BlossomId; label: string }[];

/** Highest shed rate, petals per second. */
export const MAX_SHED_RATE = 4;

export const blossomMeta = defineEffectMeta({
  id: "blossom",
  name: "Blossom Branch",
  description:
    "A flowering cherry branch reaches in from a top corner against a soft spring sky, swaying gently and shedding the odd petal.",
  params: {
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "topLeft" },
    sky: { kind: "select", label: "Sky", options: SKY_OPTIONS, default: "morning" },
    blossom: { kind: "select", label: "Blossom", options: BLOSSOM_OPTIONS, default: "pink" },
    density: { kind: "number", label: "Blossom density", min: 0.3, max: 2, step: 0.05, default: 1 },
    breeze: { kind: "number", label: "Breeze", min: 0, max: 1, step: 0.01, default: 0.4 },
    shedRate: {
      kind: "number",
      label: "Petals shed per second",
      min: 0,
      max: MAX_SHED_RATE,
      step: 0.1,
      default: 0.8,
    },
    background: { kind: "boolean", label: "Faint tree behind", default: true },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 5 },
  },
  category: "Nature",
  tags: ["sakura", "cherry", "spring", "hanami", "flowers", "japan", "calm"],
  cost: "very low",
  context: "webgl2",
});
