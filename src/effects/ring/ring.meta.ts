import { defineEffectMeta } from "../types";

export type BodyId = "earth" | "moon" | "none";
export type WindowSide = "left" | "right";

export const BODY_OPTIONS = [
  { value: "earth", label: "Earth" },
  { value: "moon", label: "Moon" },
  { value: "none", label: "None" },
] as const satisfies readonly { value: BodyId; label: string }[];

export const WINDOW_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: WindowSide; label: string }[];

/** Fewest and most seconds the station takes to turn once. */
export const MIN_SPIN = 30;
export const MAX_SPIN = 300;

export const ringMeta = defineEffectMeta({
  id: "ring",
  name: "Station Ring",
  description:
    "Inside the spinning wheel of a space station: a bright white corridor curves up and out of sight, and through a row of tall windows the stars wheel past as the Earth rises and sets.",
  params: {
    spin: {
      kind: "number",
      label: "Seconds per turn",
      min: MIN_SPIN,
      max: MAX_SPIN,
      step: 5,
      default: 90,
    },
    body: { kind: "select", label: "Outside", options: BODY_OPTIONS, default: "earth" },
    accent: { kind: "color", label: "Seat colour", default: "#c8102e" },
    windows: { kind: "select", label: "Windows", options: WINDOW_OPTIONS, default: "right" },
  },
  category: "Scenes",
  tags: ["space station", "orbit", "retro-futurist", "corridor", "1960s", "sci-fi", "earth"],
  cost: "low",
  context: "webgl2",
});
