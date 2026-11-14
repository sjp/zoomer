import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "analogue", label: "Analogue" },
  { value: "digital", label: "Digital" },
  { value: "cartoon", label: "Cartoon" },
] as const;

/** Caption lines, and code points per line. */
export const TITLE_LINES = 2;
export const TITLE_LENGTH = 24;
/** Code points in the one-line subtext. */
export const SUBTEXT_LENGTH = 48;

export const standbyMeta = defineEffectMeta({
  id: "standby",
  name: "Please Stand By",
  description:
    "A broadcast fallback slate: colour bars with a sign saying you'll be right back, a station clock, and a choice of a soft CRT, a clean digital card or a hand-drawn cartoon one.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "analogue" },
    text: {
      kind: "text",
      label: "Sign",
      default: "PLEASE STAND BY",
      maxLength: TITLE_LENGTH,
      maxLines: TITLE_LINES,
    },
    subtext: {
      kind: "text",
      label: "Second line",
      default: "We are experiencing technical difficulties",
      maxLength: SUBTEXT_LENGTH,
      maxLines: 1,
    },
    clock: { kind: "boolean", label: "Station clock", default: true },
    static: { kind: "number", label: "Static", min: 0, max: 1, step: 0.05, default: 0.5 },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "test card",
    "colour bars",
    "color bars",
    "technical difficulties",
    "tv",
    "broadcast",
    "be right back",
    "brb",
    "no signal",
  ],
  cost: "very low",
  context: "webgl2",
});
