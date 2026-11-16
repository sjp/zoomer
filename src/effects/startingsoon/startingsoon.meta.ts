import { streamOverlayParams } from "../stream-overlay/overlay-params.meta";
import { CLOCK_TIME_HINT } from "../stream-overlay/overlay-types.meta";
import { defineEffectMeta, type ParamSchema } from "../types";

/** Limits of the text params: the title's lines, and characters per line. */
export const TITLE_LINES = 2;
const TITLE_LENGTH = 24;
const SUBTITLE_LENGTH = 40;
const ZERO_TEXT_LENGTH = 30;

/** Bounds of the `countdown` param, minutes. */
export const MIN_COUNTDOWN_MINUTES = 1;
export const MAX_COUNTDOWN_MINUTES = 60;

const CARD_OPTIONS = [
  { value: "starting", label: "Starting soon" },
  { value: "brb", label: "Be right back" },
  { value: "ending", label: "Stream ending" },
] as const;

const TIMER_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "duration", label: "Duration" },
  { value: "until", label: "Until time" },
] as const;

const BACKDROP_OPTIONS = [
  { value: "blobs", label: "Blobs" },
  { value: "rain", label: "Rainy window" },
  { value: "shapes", label: "Shapes" },
  { value: "stars", label: "Stars" },
] as const;

/** The `card` select's values. */
export type CardId = (typeof CARD_OPTIONS)[number]["value"];
/** The `timer` select's values. */
export type TimerMode = (typeof TIMER_OPTIONS)[number]["value"];
/** The `backdrop` select's values. */
export type BackdropId = (typeof BACKDROP_OPTIONS)[number]["value"];

/** The scene's own params, before the stream overlays'. */
export const STARTING_SOON_PARAMS = {
  card: { kind: "select", label: "Card", options: CARD_OPTIONS, default: "starting" },
  title: {
    kind: "text",
    label: "Title (empty uses the card's own)",
    default: "",
    maxLength: TITLE_LENGTH,
    maxLines: TITLE_LINES,
  },
  subtitle: {
    kind: "text",
    label: "Subtitle",
    default: "",
    maxLength: SUBTITLE_LENGTH,
    maxLines: 1,
  },
  timer: { kind: "select", label: "Countdown", options: TIMER_OPTIONS, default: "duration" },
  countdown: {
    kind: "number",
    label: "Duration (minutes)",
    min: MIN_COUNTDOWN_MINUTES,
    max: MAX_COUNTDOWN_MINUTES,
    step: 1,
    default: 5,
  },
  endsAt: {
    kind: "text",
    label: `Until (${CLOCK_TIME_HINT}; empty or invalid counts the duration)`,
    default: "",
    maxLength: 8,
    maxLines: 1,
  },
  zeroText: {
    kind: "text",
    label: "At zero",
    default: "Any moment now…",
    maxLength: ZERO_TEXT_LENGTH,
    maxLines: 1,
  },
  backdrop: { kind: "select", label: "Background", options: BACKDROP_OPTIONS, default: "blobs" },
  accent: { kind: "color", label: "Accent", default: "#8b6cff" },
} as const satisfies ParamSchema;

export const startingsoonMeta = defineEffectMeta({
  id: "startingsoon",
  name: "Starting Soon",
  description:
    "A stream's holding screen: a big Starting soon, Be right back or Thanks for watching card with a countdown and a slow little loader, over drifting colour, a rainy pixel window, floating shapes or stars.",
  params: {
    ...STARTING_SOON_PARAMS,
    ...streamOverlayParams({ ovChat: true, ovFrame: true }),
  },
  categories: ["Scenes", "Fun"],
  tags: ["brb", "be right back", "intermission", "away", "break", "stream", "countdown"],
  cost: "low",
  context: "webgl2",
});
