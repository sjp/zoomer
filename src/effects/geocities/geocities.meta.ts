import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "crisp", label: "Crisp" },
] as const;

export const TILE_OPTIONS = [
  { value: "stars", label: "Stars" },
  { value: "stone", label: "Stone" },
  { value: "paper", label: "Paper" },
] as const;

export type TileId = (typeof TILE_OPTIONS)[number]["value"];

/** Code points in the one-line page title and the one-line marquee. */
export const TITLE_LENGTH = 28;
export const MARQUEE_LENGTH = 60;
/** Largest starting hit count the slider offers. */
const MAX_COUNTER = 999999;

export const geocitiesMeta = defineEffectMeta({
  id: "geocities",
  name: "Under Construction",
  description:
    "A proudly unfinished late-90s homepage round the edges of the frame: a tiled background, a blinking construction sign with a digging worker, bevelled buttons, a spinning NEW! badge, a marquee and a hit counter.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    text: {
      kind: "text",
      label: "Page title",
      default: "Welcome to my homepage!!!",
      maxLength: TITLE_LENGTH,
      maxLines: 1,
    },
    marquee: {
      kind: "text",
      label: "Marquee",
      default: "Thanks for visiting!! Sign my guestbook!!",
      maxLength: MARQUEE_LENGTH,
      maxLines: 1,
    },
    tile: { kind: "select", label: "Background", options: TILE_OPTIONS, default: "stars" },
    counter: {
      kind: "number",
      label: "Hit count",
      min: 0,
      max: MAX_COUNTER,
      step: 1,
      default: 1337,
    },
    motion: { kind: "number", label: "Motion", min: 0, max: 1, step: 0.05, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "geocities",
    "homepage",
    "90s",
    "web",
    "visitor counter",
    "webring",
    "comic sans",
    "guestbook",
    "website",
  ],
  cost: "very low",
  context: "webgl2",
});
