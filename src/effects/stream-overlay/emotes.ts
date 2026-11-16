/**
 * The emote wall: little emotes of our own rising up the outer thirds of the
 * frame on a slow sway, a light trickle with now and then a burst of one
 * emote (`emote-sim.ts`). Bursts come on the wall's own clock, and a moment
 * after a gift or some subs in the stream's events, so one follows the alert.
 *
 * Nothing touches the panel canvas: the emotes are sprites from the shared
 * atlas (the same designs chat uses inline), drawn behind the panels in the
 * layer's back sprite draw. The wall keeps running while it is switched off,
 * so it comes back mid-flow rather than empty.
 */
import { approach, clamp } from "../math";
import type { AnyParamValues } from "../types";
import { EMOTE_IDS, paintEmote } from "./emote-art";
import { createEmoteWall, type EmotePose, eventBurstCount, MAX_EMOTES } from "./emote-sim";
import { emotesMeta } from "./emotes.meta";
import type { OverlayDefinition, OverlayView } from "./overlay-layer";

/** Seconds after a gift or sub before its burst starts, so it follows the alert in. */
const EVENT_BURST_DELAY = 1;

/** How fast the drawn size follows the size param, per second, so a jump eases. */
const SIZE_EASE_PER_SECOND = 1;

const sizeDef = emotesMeta.params.emoteSize;
const SIZE_MIN = sizeDef.kind === "number" ? sizeDef.min : 0.5;
const SIZE_MAX = sizeDef.kind === "number" ? sizeDef.max : 1.5;

const number = (v: unknown, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export const emotesOverlay: OverlayDefinition = {
  meta: emotesMeta,
  create({ events, reserveSprites }) {
    const firstCell = reserveSprites(EMOTE_IDS.length, paintEmote);
    const wall = createEmoteWall();
    const pose: EmotePose = { id: 0, cell: 0, x: 0, y: 0, half: 0, angle: 0, alpha: 0 };
    let size = -1;

    return {
      update(dt: number, values: Readonly<AnyParamValues>, _view: OverlayView) {
        const bursts = values.emoteBursts !== false;
        if (bursts) {
          for (const e of events.fresh) {
            const n = eventBurstCount(e);
            if (n > 0) {
              wall.burst(EVENT_BURST_DELAY, n);
            }
          }
        }
        wall.step(dt, clamp(number(values.emoteRate, 0.3), 0, 1), bursts);
        const want = clamp(number(values.emoteSize, 1), SIZE_MIN, SIZE_MAX);
        size =
          size < 0
            ? want
            : approach(size, want, Number.isFinite(dt) && dt > 0 ? dt * SIZE_EASE_PER_SECOND : 0);
      },
      draw2d() {
        // Sprites only: nothing on the panel canvas.
      },
      drawGl(out, view) {
        for (let i = 0; i < MAX_EMOTES; i++) {
          if (wall.pose(i, view.layout, view.scale, size, pose)) {
            out.sprite(
              firstCell + pose.cell,
              pose.x,
              pose.y,
              pose.half,
              pose.angle,
              pose.alpha * view.fade,
              true,
            );
          }
        }
      },
    };
  },
};
