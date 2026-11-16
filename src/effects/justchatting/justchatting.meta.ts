import { streamOverlayParams } from "../stream-overlay/overlay-params.meta";
import { defineEffectMeta, type ParamSchema } from "../types";

/** Code points the neon sign's one line may hold. */
export const SIGN_MAX_LENGTH = 18;

const TIME_OPTIONS = [
  { value: "evening", label: "Evening" },
  { value: "night", label: "Night" },
] as const;

/** The scene's own params, before the stream overlays'. */
export const JUST_CHATTING_PARAMS = {
  sign: {
    kind: "text",
    label: "Neon sign (empty hides it)",
    default: "good vibes",
    maxLength: SIGN_MAX_LENGTH,
    maxLines: 1,
  },
  signColor: { kind: "color", label: "Sign colour", default: "#ff4fa8" },
  signSide: {
    kind: "select",
    label: "Sign on (plant opposite)",
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
    default: "left",
  },
  time: { kind: "select", label: "Time", options: TIME_OPTIONS, default: "evening" },
  warmth: { kind: "number", label: "Warmth", min: 0, max: 1, step: 0.05, default: 0.6 },
} as const satisfies ParamSchema;

export const justchattingMeta = defineEffectMeta({
  id: "justchatting",
  name: "Just Chatting Corner",
  description:
    "A cosy corner for chatting on stream: a sofa behind you, a little neon sign with your own words, a big leafy plant by the window, a shelf of books with a warm lamp, a framed print and a broadcast mic on its arm.",
  params: {
    ...JUST_CHATTING_PARAMS,
    ...streamOverlayParams(),
  },
  categories: ["Scenes", "Cosy"],
  tags: ["stream", "streamer", "talk", "sofa", "couch", "living room", "neon", "plant", "podcast"],
  cost: "low",
  context: "webgl2",
});
