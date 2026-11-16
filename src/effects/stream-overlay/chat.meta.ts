/**
 * The chat column overlay's metadata: a made-up live chat down one side, with
 * new messages arriving at a rate from a quiet stream to a busy one.
 */
import { OVERLAY_SIDE_OPTIONS, type OverlayMeta } from "./overlay-types.meta";

export const chatMeta: OverlayMeta = {
  id: "chat",
  toggle: "ovChat",
  label: "Chat",
  slots: ["column"],
  sideKey: "chatSide",
  params: {
    chatSide: {
      kind: "select",
      label: "Side",
      group: "Chat",
      options: OVERLAY_SIDE_OPTIONS,
      default: "left",
    },
    chatBusy: {
      kind: "number",
      label: "Busy",
      group: "Chat",
      min: 0,
      max: 1,
      step: 0.05,
      default: 0.3,
    },
    chatTitle: {
      kind: "text",
      label: "Title",
      group: "Chat",
      default: "Chat",
      maxLength: 20,
      maxLines: 1,
    },
    chatLines: {
      kind: "text",
      label: "Your own messages, one per line (emotes such as :heart: work)",
      group: "Chat",
      default: "",
      maxLength: 60,
      maxLines: 30,
    },
  },
};
