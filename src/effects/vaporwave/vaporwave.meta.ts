import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "lofi", label: "Lo-fi" },
  { value: "clean", label: "Clean" },
] as const;

const FLOOR_OPTIONS = [
  { value: "pastel", label: "Pink and teal" },
  { value: "mono", label: "Black and white" },
] as const;

/** Code points in the one-line caption. */
const CAPTION_LENGTH = 24;

export const vaporwaveMeta = defineEffectMeta({
  id: "vaporwave",
  name: "Vaporwave",
  description:
    "A E S T H E T I C: a slowly turning marble bust on a pink-and-teal checkerboard under a hazy pastel dusk, with palm silhouettes, floating 90s dialog boxes and full-width katakana, in a soft VHS look or clean.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "lofi" },
    text: {
      kind: "text",
      label: "Caption",
      default: "A E S T H E T I C",
      maxLength: CAPTION_LENGTH,
      maxLines: 1,
    },
    floor: { kind: "select", label: "Floor", options: FLOOR_OPTIONS, default: "pastel" },
    spin: { kind: "boolean", label: "Bust turns", default: true },
    drift: { kind: "boolean", label: "Floor drifts", default: false },
    windows: { kind: "boolean", label: "Dialog boxes", default: true },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "aesthetic",
    "statue",
    "sculpture",
    "palm trees",
    "90s",
    "windows",
    "japanese",
    "chillwave",
    "mall",
  ],
  cost: "low",
  context: "webgl2",
});
