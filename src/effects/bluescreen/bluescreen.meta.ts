import { defineEffectMeta } from "../types";

const STYLE_OPTIONS = [
  { value: "modern", label: "Modern" },
  { value: "classic", label: "Classic" },
  { value: "kernel", label: "Kernel" },
] as const;

const HUE_OPTIONS = [
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "black", label: "Black" },
] as const;

/** The message: lines, and code points per line. */
export const MESSAGE_LINES = 3;
export const MESSAGE_LENGTH = 48;
/** Code points in the one-line stop code. */
export const CODE_LENGTH = 40;

export const bluescreenMeta = defineEffectMeta({
  id: "bluescreen",
  name: "Blue Screen",
  description:
    "Your background crashed, you didn't: a calm blue screen with a big sad face, an apology and a progress count that creeps up and never quite finishes, or an older text-mode error page or a kernel panic with a silly stack trace.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "modern" },
    text: {
      kind: "text",
      label: "Message",
      default:
        "Your background ran into a problem and needs to\nrestart. We're just collecting some vibes, and\nthen we'll restart for you.",
      maxLength: MESSAGE_LENGTH,
      maxLines: MESSAGE_LINES,
    },
    code: {
      kind: "text",
      label: "Stop code",
      default: "MEETING_COULD_HAVE_BEEN_AN_EMAIL",
      maxLength: CODE_LENGTH,
      maxLines: 1,
    },
    hue: { kind: "select", label: "Colour (Modern)", options: HUE_OPTIONS, default: "blue" },
    speed: { kind: "number", label: "Speed", min: 0, max: 3, step: 0.1, default: 1 },
    seed: { kind: "number", label: "Variation", min: 0, max: 999, step: 1, default: 1 },
  },
  categories: ["Fun", "Retro"],
  tags: [
    "meme",
    "crash",
    "error",
    "bsod",
    "computer",
    "sad face",
    "kernel panic",
    "ironic",
    "restart",
    "fatal exception",
  ],
  cost: "very low",
  context: "webgl2",
});
