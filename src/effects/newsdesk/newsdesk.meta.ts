import { defineEffectMeta } from "../types";

export type SkylineMode = "cycle" | "day" | "night";

export const SKYLINE_OPTIONS = [
  { value: "cycle", label: "Dusk cycle" },
  { value: "day", label: "Day" },
  { value: "night", label: "Night" },
] as const satisfies readonly { value: SkylineMode; label: string }[];

/** Code points in the lower third's name and title lines. */
export const NAME_MAX_LENGTH = 40;
export const TITLE_MAX_LENGTH = 60;
/** Code points in the ticker's one line. */
export const TICKER_MAX_LENGTH = 160;

export const newsdeskMeta = defineEffectMeta({
  id: "newsdesk",
  name: "Evening News Desk",
  description:
    "Anchoring the evening news from a sleek blue and silver studio: a curved video wall behind you shows a city skyline sliding from sunset into night, with your name on a lower-third bar and a slow ticker along the bottom.",
  params: {
    name: {
      kind: "text",
      label: "Name",
      default: "Your Name",
      maxLength: NAME_MAX_LENGTH,
      maxLines: 1,
    },
    title: {
      kind: "text",
      label: "Title",
      default: "Evening Anchor",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    ticker: {
      kind: "text",
      label: "Ticker",
      default:
        "Meeting runs long, sources say   Coffee levels holding steady   Outlook: clearing by five",
      maxLength: TICKER_MAX_LENGTH,
      maxLines: 1,
    },
    accent: { kind: "color", label: "Lower third colour", default: "#b4142c" },
    live: { kind: "boolean", label: "LIVE tag and clock", default: true },
    skyline: { kind: "select", label: "Skyline", options: SKYLINE_OPTIONS, default: "cycle" },
  },
  category: "Scenes",
  tags: ["tv", "broadcast", "anchor", "studio", "lower third", "presenter", "newsroom"],
  cost: "low",
  context: "webgl2",
});
