import { defineEffectMeta } from "../types";

type TurntablePosition = "left" | "right";
export type RpmId = "33" | "45";
export type PlinthId = "walnut" | "black" | "white";
export type TurntableRoomId = "lamp" | "window" | "dark";

export const POSITION_OPTIONS = [
  { value: "left", label: "Bottom left" },
  { value: "right", label: "Bottom right" },
] as const satisfies readonly { value: TurntablePosition; label: string }[];

export const RPM_OPTIONS = [
  { value: "33", label: "33⅓" },
  { value: "45", label: "45" },
] as const satisfies readonly { value: RpmId; label: string }[];

export const PLINTH_OPTIONS = [
  { value: "walnut", label: "Walnut" },
  { value: "black", label: "Black" },
  { value: "white", label: "White" },
] as const satisfies readonly { value: PlinthId; label: string }[];

export const ROOM_OPTIONS = [
  { value: "lamp", label: "Warm lamp" },
  { value: "window", label: "Window" },
  { value: "dark", label: "Dark" },
] as const satisfies readonly { value: TurntableRoomId; label: string }[];

export const turntableMeta = defineEffectMeta({
  id: "turntable",
  name: "Record Player",
  description:
    "A turntable in the corner with a vinyl record turning slowly under the light, the tonearm creeping inwards, and a warm, out-of-focus room behind.",
  params: {
    position: { kind: "select", label: "Position", options: POSITION_OPTIONS, default: "right" },
    rpm: { kind: "select", label: "Speed (rpm)", options: RPM_OPTIONS, default: "33" },
    label: { kind: "color", label: "Label colour", default: "#c4462e" },
    plinth: { kind: "select", label: "Plinth", options: PLINTH_OPTIONS, default: "walnut" },
    room: { kind: "select", label: "Room", options: ROOM_OPTIONS, default: "lamp" },
  },
  category: "Cosy",
  tags: ["vinyl", "turntable", "music", "lp", "hi-fi", "retro", "living room", "jazz"],
  cost: "very low",
  context: "webgl2",
});
