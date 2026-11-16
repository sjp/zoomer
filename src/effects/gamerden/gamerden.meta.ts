import { streamOverlayParams } from "../stream-overlay/overlay-params.meta";
import { defineEffectMeta, type ParamSchema } from "../types";
import type { PaletteId, PanelMode } from "./gamerden-panels";

const MODE_OPTIONS = [
  { value: "wave", label: "Wave" },
  { value: "breathe", label: "Breathe" },
  { value: "static", label: "Static" },
  { value: "reactive", label: "Reactive" },
] as const satisfies readonly { value: PanelMode; label: string }[];

const PALETTE_OPTIONS = [
  { value: "rainbow", label: "Rainbow" },
  { value: "synth", label: "Synth" },
  { value: "ocean", label: "Ocean" },
  { value: "ember", label: "Ember" },
  { value: "forest", label: "Forest" },
  { value: "mono", label: "Mono (accent)" },
] as const satisfies readonly { value: PaletteId; label: string }[];

/** The scene's own params, before the stream overlays'. */
export const GAMER_DEN_PARAMS = {
  mode: { kind: "select", label: "Panels", options: MODE_OPTIONS, default: "wave" },
  palette: { kind: "select", label: "Palette", options: PALETTE_OPTIONS, default: "synth" },
  accent: { kind: "color", label: "Accent (Mono, desk strip)", default: "#9a4dff" },
  speed: { kind: "number", label: "Speed", min: 0.1, max: 1, step: 0.05, default: 0.4 },
  panelSide: {
    kind: "select",
    label: "Panels on",
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
    ],
    default: "right",
  },
  brightness: {
    kind: "number",
    label: "Brightness",
    min: 0.3,
    max: 1,
    step: 0.05,
    default: 0.75,
  },
} as const satisfies ParamSchema;

export const gamerdenMeta = defineEffectMeta({
  id: "gamerden",
  name: "Gamer Den",
  description:
    "A streaming room at night: a cluster of hexagonal light panels flowing with colour, an LED strip glowing behind the desk, acoustic foam, a shelf of figures and a gaming chair behind you.",
  params: {
    ...GAMER_DEN_PARAMS,
    ...streamOverlayParams(),
  },
  categories: ["Scenes", "Night", "Cosy"],
  tags: ["stream", "streamer", "gaming", "twitch", "rgb", "led", "hexagon", "setup"],
  cost: "low",
  context: "webgl2",
});
