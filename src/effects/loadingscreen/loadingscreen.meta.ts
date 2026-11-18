import { defineEffectMeta } from "../types";

const ART_OPTIONS = [
  { value: "ruins", label: "Ruins" },
  { value: "spaceport", label: "Space port" },
  { value: "forest", label: "Forest shrine" },
] as const;

const PROGRESS_OPTIONS = [
  { value: "never", label: "Never finishes" },
  { value: "steady", label: "Steady" },
] as const;

/** The `art` select's values. */
export type ArtId = (typeof ART_OPTIONS)[number]["value"];

/** Limits of the `tips` text param: lines, and characters per line. */
const MAX_TIPS = 8;
export const TIP_LENGTH = 60;

/** The `tipEvery` slider's range, seconds. */
const MIN_TIP_EVERY = 6;
const MAX_TIP_EVERY = 30;

/** The `loop` slider's range, minutes. */
const MIN_LOOP = 1;
const MAX_LOOP = 30;

export const loadingScreenMeta = defineEffectMeta({
  id: "loadingscreen",
  name: "Loading Screen",
  description:
    "A game's loading screen that never quite finishes: painted key art drifts slowly behind a progress bar that crawls, stalls, lurches and slips back, a spinning emblem and a rotating tip about calls.",
  params: {
    art: { kind: "select", label: "Key art", options: ART_OPTIONS, default: "ruins" },
    tips: {
      kind: "text",
      label: "Tips, one per line (empty uses the built-in ones)",
      default: "",
      maxLength: TIP_LENGTH,
      maxLines: MAX_TIPS,
    },
    tipEvery: {
      kind: "number",
      label: "Seconds per tip",
      min: MIN_TIP_EVERY,
      max: MAX_TIP_EVERY,
      step: 1,
      default: 12,
    },
    progress: { kind: "select", label: "Progress", options: PROGRESS_OPTIONS, default: "never" },
    loop: {
      kind: "number",
      label: "Steady loop (minutes)",
      min: MIN_LOOP,
      max: MAX_LOOP,
      step: 1,
      default: 5,
    },
    accent: { kind: "color", label: "Accent", default: "#5fd4ff" },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Games", "Fun"],
  tags: ["waiting", "please wait", "tips", "video game", "buffering", "brb"],
  cost: "very low",
  context: "webgl2",
});
