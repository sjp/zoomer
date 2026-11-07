import { defineEffectMeta } from "../types";

export type SplitflapStyle = "station" | "airport" | "retro";

export const SPLITFLAP_STYLE_OPTIONS = [
  { value: "station", label: "Station white" },
  { value: "airport", label: "Airport yellow" },
  { value: "retro", label: "Retro cream" },
] as const satisfies readonly { value: SplitflapStyle; label: string }[];

/** Character cells per row: also the `lines` param's line length. */
export const BOARD_COLS = 22;
/** Most rows the board shows (the `rows` param's max). */
export const MAX_ROWS = 6;
/** Most lines of text the board cycles through. */
export const MAX_LINES = 6;

export const splitflapMeta = defineEffectMeta({
  id: "splitflap",
  name: "Split-Flap Board",
  description:
    "An old station departures board across the top of the frame. Every so often its flaps clatter through the alphabet, rippling across the board until each one lands on your next line of text or the time.",
  params: {
    lines: {
      kind: "text",
      label: "Lines",
      default:
        "GOOD MORNING\nNEXT STOP  STAND-UP\nPLATFORM 9  ON TIME\nNOW BOARDING  COFFEE\nMIND THE GAP\nSEE YOU SOON",
      maxLength: BOARD_COLS,
      maxLines: MAX_LINES,
    },
    clock: { kind: "boolean", label: "Clock row", default: true },
    interval: { kind: "number", label: "Change every (s)", min: 5, max: 60, step: 1, default: 15 },
    style: { kind: "select", label: "Style", options: SPLITFLAP_STYLE_OPTIONS, default: "station" },
    rows: { kind: "number", label: "Rows", min: 2, max: MAX_ROWS, step: 1, default: 4 },
  },
  category: "Retro",
  tags: ["solari", "departures", "station", "airport", "railway", "sign", "message", "status"],
  cost: "very low",
  context: "webgl2",
});
