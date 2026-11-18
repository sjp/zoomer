import { defineEffectMeta } from "../types";

const FRAMING_OPTIONS = [
  { value: "screen", label: "Screen" },
  { value: "cabinet", label: "Cabinet" },
] as const;

const PALETTE_OPTIONS = [
  { value: "arcade", label: "Arcade" },
  { value: "amber", label: "Amber monochrome" },
  { value: "green", label: "Green monochrome" },
] as const;

/** The game's title: one line of up to this many characters; empty shows the default. */
const TITLE_MAX_LENGTH = 16;
export const DEFAULT_TITLE = "STAR SALVAGE";

/** The pace slider's range: how fast the attract loop runs. */
export const MIN_PACE = 0.5;
export const MAX_PACE = 1.5;

export const arcadeMeta = defineEffectMeta({
  id: "arcade",
  name: "Arcade Attract Mode",
  description:
    "An arcade machine idling with no coin in: the title screen, a demo of a little salvage tug collecting crates among drifting mines, the high-score table and a blinking INSERT COIN, round and round on a curved CRT, or seen on the cabinet in a dim arcade.",
  params: {
    framing: { kind: "select", label: "Framing", options: FRAMING_OPTIONS, default: "screen" },
    title: {
      kind: "text",
      label: "Game title",
      default: "",
      maxLength: TITLE_MAX_LENGTH,
      maxLines: 1,
    },
    initials: { kind: "text", label: "Your initials", default: "", maxLength: 3, maxLines: 1 },
    palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "arcade" },
    crt: { kind: "number", label: "CRT", min: 0, max: 1, step: 0.05, default: 0.6 },
    pace: { kind: "number", label: "Pace", min: MIN_PACE, max: MAX_PACE, step: 0.05, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Retro", "Fun", "Night"],
  tags: ["coin-op", "80s", "retro gaming", "video game", "pixel art", "joystick", "scanlines"],
  cost: "low",
  context: "webgl2",
});
