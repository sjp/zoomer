import { defineEffectMeta } from "../types";

const BACKGROUND_OPTIONS = [
  { value: "cream", label: "Cream" },
  { value: "sky", label: "Sky" },
  { value: "pastel", label: "Pastel" },
] as const;

/** Lines in the phrase list, and code points per phrase. */
export const PHRASE_LINES = 12;
export const PHRASE_LENGTH = 24;
/** Phrases visible at once, at most. */
export const MAX_COUNT = 8;

export const suchwowMeta = defineEffectMeta({
  id: "suchwow",
  name: "Such Background",
  description:
    "Broken-English phrases in multicoloured Comic Sans drift and fade round the edges of the frame (such meeting, very agenda, wow), with an optional clip-art shiba side-eyeing from a corner.",
  params: {
    phrases: {
      kind: "text",
      label: "Phrases (one per line)",
      default: "",
      maxLength: PHRASE_LENGTH,
      maxLines: PHRASE_LINES,
    },
    background: {
      kind: "select",
      label: "Background",
      options: BACKGROUND_OPTIONS,
      default: "cream",
    },
    count: {
      kind: "number",
      label: "Phrases at once",
      min: 3,
      max: MAX_COUNT,
      step: 1,
      default: 5,
    },
    shiba: { kind: "boolean", label: "Shiba", default: false },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: ["meme", "doge", "wow", "comic sans", "text", "shiba", "dog", "ironic", "2010s"],
  cost: "very low",
  context: "webgl2",
});
