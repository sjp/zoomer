import { beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { FakeOffscreenCanvas } from "../../test/offscreen-canvas";
import { beginFrame, createScope } from "../gl";
import { fallbackWidthEm } from "../neon-tubes";
import { fitScale } from "../scene-layout";
import {
  createStreamOverlays,
  OVERLAY_DEFINITIONS,
  type OverlayDefinition,
  type OverlayDraw,
} from "../stream-overlay/overlay-layer";
import type { Rect } from "../stream-overlay/overlay-layout";
import { overlayKeyClashes, OVERLAY_METAS } from "../stream-overlay/overlay-params.meta";
import type { AnyParamValues, ParamSchema } from "../types";
import {
  designFrame,
  fitSign,
  leafCentre,
  plantParts,
  PLAQUE_H,
  signPlace,
} from "./justchatting-layout";
import { JUST_CHATTING_PARAMS, justchattingMeta } from "./justchatting.meta";

describe("Just Chatting Corner's params", () => {
  it("share no key with the stream overlays", () => {
    expect(overlayKeyClashes(JUST_CHATTING_PARAMS)).toEqual([]);
  });

  it("include every overlay, each off by default", () => {
    const params: ParamSchema = justchattingMeta.params;
    for (const meta of OVERLAY_METAS) {
      expect(params[meta.toggle]).toMatchObject({ kind: "boolean", default: false });
    }
    expect(Object.keys(params)).toEqual(
      expect.arrayContaining(["ovAccent", "ovOpacity", ...Object.keys(JUST_CHATTING_PARAMS)]),
    );
  });
});

const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * Runs the real stream overlays at 1920 x 1080 with every one switched on, and
 * returns the screen rects of the panels they draw once settled. Sprites
 * (confetti, emotes) are small and pass by, so they don't count.
 */
function panelsWithEverythingOn(): Rect[] {
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  const drawn: Rect[] = [];
  const recording = (out: OverlayDraw): OverlayDraw => ({
    panel(sx, sy, sw, sh, dx, dy, dw, dh, alpha, back) {
      if (alpha > 0 && dw > 0 && dh > 0) {
        drawn.push({ x: dx, y: dy, w: dw, h: dh });
      }
      out.panel(sx, sy, sw, sh, dx, dy, dw, dh, alpha, back);
    },
    sprite: out.sprite,
  });
  const definitions: OverlayDefinition[] = OVERLAY_DEFINITIONS.map((def) => ({
    meta: def.meta,
    create(ctx) {
      const inner = def.create(ctx);
      return {
        ...inner,
        drawGl(out, view) {
          const rec = recording(out);
          if (inner.drawGl) {
            inner.drawGl(rec, view);
            return;
          }
          for (const slot of def.meta.slots) {
            if (slot !== "edges") {
              const t = view.target(slot);
              const s = view.shown(slot);
              rec.panel(t.x, t.y, t.w, t.h, s.x, s.y, s.w, s.h, view.fade, slot === "border");
            }
          }
        },
      };
    },
  }));
  const fake = createFakeGl();
  const scope = createScope();
  const layer = createStreamOverlays(fake.gl, scope, definitions);
  layer.resize({ width: WIDTH, height: HEIGHT, scale: HEIGHT / 1080 });
  const values: AnyParamValues = {};
  for (const [key, def] of Object.entries(justchattingMeta.params as ParamSchema)) {
    values[key] = def.default;
  }
  for (const meta of OVERLAY_METAS) {
    values[meta.toggle] = true;
  }
  for (let i = 0; i < 300; i++) {
    drawn.length = 0;
    beginFrame(fake.gl, WIDTH, HEIGHT);
    layer.frame(1 / 30, values);
  }
  scope.dispose();
  vi.unstubAllGlobals();
  return drawn;
}

/** Design units to device pixels, y down. */
function toScreen(x: number, y: number): [number, number] {
  const unit = HEIGHT * fitScale(WIDTH / HEIGHT);
  return [WIDTH / 2 + x * unit, HEIGHT / 2 - y * unit];
}

const under = (panels: readonly Rect[], x: number, y: number) =>
  panels.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

describe("Just Chatting Corner with every overlay on, at 16:9", () => {
  let panels: Rect[] = [];
  beforeAll(() => {
    panels = panelsWithEverythingOn();
  });
  const aspect = WIDTH / HEIGHT;

  it("draws the overlays' panels", () => {
    // Splits, chat, the goal, uptime and ticker pills, and the border's strips.
    expect(panels.length).toBeGreaterThan(5);
  });

  it.each([
    ["left", -1],
    ["right", 1],
  ])("keeps most of the sign's plaque clear with the sign on the %s", (_, side) => {
    // The default text, measured as widely as the font fallback does: its widest plaque.
    const plaqueW = fitSign(fallbackWidthEm("good vibes")).plaqueW;
    const at = signPlace(aspect, side);
    const [x0, y0] = toScreen(at.x - plaqueW / 2, at.top);
    const [x1, y1] = toScreen(at.x + plaqueW / 2, at.top - PLAQUE_H);
    let clear = 0;
    let all = 0;
    for (let y = y0 + 2; y < y1; y += 4) {
      for (let x = x0 + 2; x < x1; x += 4) {
        all++;
        clear += under(panels, x, y) ? 0 : 1;
      }
    }
    expect(clear / all).toBeGreaterThan(0.6);
  });

  it.each([
    ["right", 1],
    ["left", -1],
  ])("keeps some of the plant's leaves clear with the plant on the %s", (_, side) => {
    const { halfW } = designFrame(aspect);
    const { leaves } = plantParts();
    let clear = 0;
    for (const leaf of leaves) {
      const [lx, ly] = leafCentre(leaf);
      const [x, y] = toScreen(side * (halfW - lx), ly);
      if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT && !under(panels, x, y)) {
        clear++;
      }
    }
    // Its crown, reaching in towards the speaker over a column's top and inner edge.
    expect(clear / leaves.length).toBeGreaterThan(0.2);
  });
});
