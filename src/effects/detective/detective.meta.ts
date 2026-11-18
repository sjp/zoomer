import { defineEffectMeta } from "../types";

/** Code points each line of the door's lettering may hold, and its lines. */
export const DOOR_MAX_LENGTH = 22;
export const DOOR_MAX_LINES = 2;

const TONE_OPTIONS = [
  { value: "mono", label: "Black & white" },
  { value: "sepia", label: "Sepia" },
  { value: "colour", label: "Colour" },
] as const;

export const detectiveMeta = defineEffectMeta({
  id: "detective",
  name: "1940s Detective Office",
  description:
    "A cramped private eye's office at night, in black and white: rain runs down the window behind the desk, a sign across the street blinks its light through the half-closed blinds, a ceiling fan's shadow turns overhead, and the name on the frosted door reads backwards from inside.",
  params: {
    door: {
      kind: "text",
      label: "Door lettering (empty hides it)",
      default: "PRIVATE\nINVESTIGATOR",
      maxLength: DOOR_MAX_LENGTH,
      maxLines: DOOR_MAX_LINES,
    },
    tone: { kind: "select", label: "Tone", options: TONE_OPTIONS, default: "mono" },
    rain: { kind: "number", label: "Rain", min: 0, max: 1, step: 0.01, default: 0.5 },
    sign: { kind: "boolean", label: "Blinking sign", default: true },
    fan: { kind: "boolean", label: "Ceiling fan", default: true },
    grain: { kind: "number", label: "Film grain", min: 0, max: 1, step: 0.01, default: 0.3 },
  },
  categories: ["Scenes", "Night", "Retro"],
  tags: ["noir", "film noir", "gumshoe", "venetian blinds", "neon sign", "mystery", "forties"],
  cost: "low",
  context: "webgl2",
});
