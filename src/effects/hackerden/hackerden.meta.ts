import { defineEffectMeta } from "../types";

const PALETTE_OPTIONS = [
  { value: "green", label: "Green phosphor" },
  { value: "amber", label: "Amber" },
  { value: "ice", label: "Ice blue" },
  { value: "movie", label: "Movie (a colour per screen)" },
] as const;
export type PaletteId = (typeof PALETTE_OPTIONS)[number]["value"];

/** The terminal prompt's user name: one line of up to this many characters. */
export const HANDLE_MAX_LENGTH = 16;
export const DEFAULT_HANDLE = "ghost";

/** How many screens can show. */
export const MIN_SCREENS = 5;
export const MAX_SCREENS = 7;

export const hackerdenMeta = defineEffectMeta({
  id: "hackerden",
  name: "Hacker Thriller Den",
  description:
    "Play the hacker in a dark room lit only by a wall of monitors: a terminal types away, code steps past, a trace hops across a world map and a grid of hex decrypts itself, and now and then a screen announces ACCESS GRANTED.",
  params: {
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "green" },
    handle: {
      kind: "text",
      label: "Handle",
      default: DEFAULT_HANDLE,
      maxLength: HANDLE_MAX_LENGTH,
      maxLines: 1,
    },
    pace: { kind: "number", label: "Pace", min: 0.2, max: 1, step: 0.05, default: 0.5 },
    alerts: { kind: "boolean", label: "Alerts", default: true },
    screens: {
      kind: "number",
      label: "Screens",
      min: MIN_SCREENS,
      max: MAX_SCREENS,
      step: 1,
      default: 6,
    },
  },
  categories: ["Scenes", "Night", "Fun"],
  tags: ["hacking", "cyber", "movie", "spy", "heist", "command line", "programmer", "computer"],
  cost: "low",
  context: "webgl2",
});
