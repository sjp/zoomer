import { defineEffectMeta } from "../types";

export type OnAirMode = "on" | "off" | "auto";
export type MicSide = "left" | "right";

export const ON_AIR_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: OnAirMode; label: string }[];

export const MIC_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const satisfies readonly { value: MicSide; label: string }[];

/** Code points on the sign: one short line. */
export const SIGN_MAX_LENGTH = 12;

export const radiostudioMeta = defineEffectMeta({
  id: "radiostudio",
  name: "Radio Studio",
  description:
    "On air in a cosy radio booth: foam on the walls, a red light glowing over your shoulder, a big microphone on its arm, tape reels turning and meter needles dancing, with the producer's dim control room through the glass.",
  params: {
    onAir: { kind: "select", label: "On air light", options: ON_AIR_OPTIONS, default: "auto" },
    sign: {
      kind: "text",
      label: "Sign",
      default: "ON AIR",
      maxLength: SIGN_MAX_LENGTH,
      maxLines: 1,
    },
    foam: { kind: "color", label: "Foam colour", default: "#56647e" },
    mic: { kind: "select", label: "Microphone", options: MIC_OPTIONS, default: "left" },
    clock: { kind: "boolean", label: "Studio clock (local time)", default: true },
  },
  category: "Scenes",
  tags: ["podcast", "broadcast", "dj", "streaming", "music", "presenter", "vinyl", "recording"],
  cost: "very low",
  context: "webgl2",
});
