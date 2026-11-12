import { defineEffectMeta } from "../types";

export type BouncingLogoCorners = "natural" | "sometimes" | "often";

const STYLE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "modern", label: "Modern" },
] as const;

const PALETTE_OPTIONS = [
  { value: "classic", label: "Classic" },
  { value: "pastel", label: "Pastel" },
  { value: "mono", label: "Mono" },
] as const;

const CORNER_OPTIONS = [
  { value: "natural", label: "Natural" },
  { value: "sometimes", label: "Sometimes" },
  { value: "often", label: "Often" },
] as const satisfies readonly { value: BouncingLogoCorners; label: string }[];

/**
 * Fastest drift, reference px per second on each axis. The logo moves at 45
 * degrees, so its edges travel sqrt(2) times this, a little more while a corner
 * is planned; that stays under the codec's per-frame limit (see the sim tests).
 */
export const MAX_LOGO_SPEED = 180;
/** Code points in the big letters. */
const LOGO_TEXT_LENGTH = 8;

export const bouncingLogoMeta = defineEffectMeta({
  id: "bouncinglogo",
  name: "Bouncing Logo",
  description:
    "The DVD player's idle screen: a logo drifting across black, bouncing off the edges and changing colour each time, and every so often landing exactly in a corner.",
  params: {
    style: { kind: "select", label: "Style", options: STYLE_OPTIONS, default: "classic" },
    speed: {
      kind: "number",
      label: "Speed",
      min: 20,
      max: MAX_LOGO_SPEED,
      step: 5,
      default: 90,
    },
    size: { kind: "number", label: "Size", min: 0.08, max: 0.35, step: 0.01, default: 0.18 },
    palette: { kind: "select", label: "Colours", options: PALETTE_OPTIONS, default: "classic" },
    color: { kind: "color", label: "Mono colour", default: "#ffffff" },
    corners: {
      kind: "select",
      label: "Corner hits",
      options: CORNER_OPTIONS,
      default: "sometimes",
    },
    counter: { kind: "boolean", label: "Corner counter", default: false },
    text: {
      kind: "text",
      label: "Letters",
      default: "DVD",
      maxLength: LOGO_TEXT_LENGTH,
      maxLines: 1,
    },
    background: { kind: "color", label: "Background", default: "#000000" },
    seed: { kind: "number", label: "Variation", min: 0, max: 99, step: 1, default: 0 },
  },
  category: "Retro",
  tags: ["dvd", "screensaver", "corner", "idle", "nostalgia", "bounce", "tv", "video"],
  cost: "very low",
  context: "webgl2",
});
