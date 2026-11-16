/**
 * The emote wall's metadata: little emotes of our own floating up the outer
 * thirds of the frame, a light trickle with now and then a burst of one emote
 * (on its own, and after a gift or some subs).
 */
import type { OverlayMeta } from "./overlay-types.meta";

export const emotesMeta: OverlayMeta = {
  id: "emotes",
  toggle: "ovEmotes",
  label: "Emote wall",
  slots: ["edges"],
  params: {
    emoteRate: {
      kind: "number",
      label: "Trickle",
      group: "Emotes",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.3,
    },
    emoteBursts: {
      kind: "boolean",
      label: "Hype bursts",
      group: "Emotes",
      default: true,
    },
    emoteSize: {
      kind: "number",
      label: "Size",
      group: "Emotes",
      min: 0.5,
      max: 1.5,
      step: 0.05,
      default: 1,
    },
  },
};
