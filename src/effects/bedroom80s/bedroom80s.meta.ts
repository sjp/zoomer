import { defineEffectMeta } from "../types";

type ScreenMode = "demo" | "stripes" | "prompt";
type ComputerSide = "left" | "right";

const SCREEN_OPTIONS = [
  { value: "demo", label: "Demo" },
  { value: "stripes", label: "Loading stripes" },
  { value: "prompt", label: "Text prompt" },
] as const satisfies readonly { value: ScreenMode; label: string }[];

const SIDE_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: ComputerSide; label: string }[];

/** Code points in the demo's scrolling message: one line. */
export const SCROLLER_MAX_LENGTH = 80;

export const bedroom80sMeta = defineEffectMeta({
  id: "bedroom80s",
  name: "1980s Bedroom",
  description:
    "A teenager's bedroom in the mid-eighties, late at night: a beige home computer with a chunky CRT running a colourful demo, cassettes and a joystick on the desk, posters on the patterned wallpaper, a lava lamp glowing on the shelf and streetlight through the blinds.",
  params: {
    scroller: {
      kind: "text",
      label: "Scroll text",
      default: "GREETINGS FROM THE BEDROOM - THANKS FOR JOINING THE CALL - STAY RAD",
      maxLength: SCROLLER_MAX_LENGTH,
      maxLines: 1,
    },
    screen: { kind: "select", label: "Screen", options: SCREEN_OPTIONS, default: "demo" },
    lamp: { kind: "color", label: "Lava lamp colour", default: "#ff4f7b" },
    cars: { kind: "boolean", label: "Passing headlights", default: true },
    playing: { kind: "boolean", label: "Tape playing", default: true },
    bedside: { kind: "boolean", label: "Bedside lamp", default: false },
    side: { kind: "select", label: "Computer", options: SIDE_OPTIONS, default: "left" },
  },
  category: "Scenes",
  tags: ["retro", "nostalgia", "home computer", "demoscene", "crt", "80s", "teenager", "night"],
  cost: "low",
  context: "webgl2",
});
