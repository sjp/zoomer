import { defineEffectMeta } from "../types";

export type CoatId = "ginger" | "tabby" | "black" | "tuxedo";
export type TimeOfDayId = "morning" | "afternoon" | "golden";
type CatCorner = "left" | "right";

export const COAT_OPTIONS = [
  { value: "ginger", label: "Ginger" },
  { value: "tabby", label: "Grey tabby" },
  { value: "black", label: "Black" },
  { value: "tuxedo", label: "Tuxedo" },
] as const satisfies readonly { value: CoatId; label: string }[];

export const TIME_OPTIONS = [
  { value: "morning", label: "Morning" },
  { value: "afternoon", label: "Afternoon" },
  { value: "golden", label: "Golden hour" },
] as const satisfies readonly { value: TimeOfDayId; label: string }[];

export const CORNER_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: CatCorner; label: string }[];

/** Most dust motes at `motes` 1. */
export const MAX_MOTES = 48;

export const catMeta = defineEffectMeta({
  id: "cat",
  name: "Sleeping Cat",
  description:
    "A cat curled up asleep on a cushion on a sunny windowsill, breathing slowly, with dust motes drifting in the light.",
  params: {
    coat: { kind: "select", label: "Coat", options: COAT_OPTIONS, default: "ginger" },
    time: { kind: "select", label: "Time of day", options: TIME_OPTIONS, default: "afternoon" },
    motes: { kind: "number", label: "Dust motes", min: 0, max: 1, step: 0.05, default: 0.5 },
    corner: { kind: "select", label: "Corner", options: CORNER_OPTIONS, default: "left" },
    size: { kind: "number", label: "Cat size", min: 0.25, max: 0.55, step: 0.01, default: 0.4 },
    cushion: { kind: "color", label: "Cushion colour", default: "#7f9da6" },
  },
  category: "Cosy",
  tags: ["kitten", "pet", "nap", "sunbeam", "calm", "home", "purr"],
  cost: "very low",
  context: "webgl2",
});
