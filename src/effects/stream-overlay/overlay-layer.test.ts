import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { FakeOffscreenCanvas } from "../../test/offscreen-canvas";
import { beginFrame, createScope } from "../gl";
import type { AnyParamValues } from "../types";
import {
  createStreamOverlays,
  MAX_SPRITES,
  OVERLAY_DEFINITIONS,
  OVERLAY_FADE_SECONDS,
  type OverlayCanvas,
  type OverlayContext,
  type OverlayDefinition,
  type OverlayDraw,
  type OverlayInstance,
  type OverlayView,
  SPRITE_CELL,
  type StreamOverlays,
} from "./overlay-layer";
import { type Rect, SLOT_EASE_SECONDS } from "./overlay-layout";
import { OVERLAY_METAS, streamOverlayParams } from "./overlay-params.meta";
import { OVERLAY_SIDE_OPTIONS, type OverlayMeta, type OverlaySlot } from "./overlay-types.meta";

/** What a test overlay saw, frame by frame. */
interface Log {
  updates: number;
  /** Seconds of `dt` it was given in all. */
  time: number;
  draws: boolean[];
  views: OverlayView[];
  fades: number[];
  sides: (string | null)[];
  shownX: number[];
  disposed: number;
}

function testOverlay(
  id: string,
  slots: readonly OverlaySlot[],
  options: { sprites?: number; drawGl?: boolean } = {},
): { def: OverlayDefinition; log: Log; painted: number[] } {
  const name = id[0].toUpperCase() + id.slice(1);
  const column = slots.includes("column");
  const meta: OverlayMeta = {
    id,
    toggle: `ov${name}`,
    label: name,
    slots,
    ...(column ? { sideKey: `${id}Side` } : {}),
    params: column
      ? {
          [`${id}Side`]: {
            kind: "select",
            label: "Side",
            group: name,
            options: OVERLAY_SIDE_OPTIONS,
            default: "right",
          },
        }
      : {},
  };
  const log: Log = {
    updates: 0,
    time: 0,
    draws: [],
    views: [],
    fades: [],
    sides: [],
    shownX: [],
    disposed: 0,
  };
  const painted: number[] = [];
  const def: OverlayDefinition = {
    meta,
    create(ctx: OverlayContext): OverlayInstance {
      const first =
        options.sprites === undefined
          ? -1
          : ctx.reserveSprites(options.sprites, (_, i, size) => {
              // A cell of the wrong size shows up as a negative index.
              painted.push(size === SPRITE_CELL ? i : -1);
            });
      return {
        update(dt, _values, view) {
          log.updates++;
          log.time += dt;
          log.fades.push(view.fade);
          log.sides.push(view.side);
          log.shownX.push(view.shown(slots[0]).x);
          log.views[0] = view;
        },
        draw2d(canvas: OverlayCanvas, view, full) {
          log.draws.push(full);
          for (const slot of slots) {
            const t = view.target(slot);
            if (full) {
              canvas.ctx.fillRect(t.x, t.y, t.w, t.h);
            }
          }
        },
        ...(options.drawGl === true
          ? {
              drawGl(out: OverlayDraw, view: OverlayView) {
                for (let i = 0; i < 3; i++) {
                  out.sprite(first + i, 100 + i, 100, 20, 0, view.fade, slots.includes("edges"));
                }
              },
            }
          : {}),
        dispose() {
          log.disposed++;
        },
      };
    },
  };
  return { def, log, painted };
}

const VIEWPORT = { width: 1920, height: 1080, scale: 1 };
const DT = 1 / 60;

function setup(defs: OverlayDefinition[]) {
  const fake = createFakeGl({ record: true });
  const scope = createScope();
  const layer = createStreamOverlays(fake.gl, scope, defs);
  layer.resize(VIEWPORT);
  const values: AnyParamValues = { ...defaultsOf(defs) };
  const frame = (dt = DT) => {
    beginFrame(fake.gl, VIEWPORT.width, VIEWPORT.height);
    layer.frame(dt, values);
  };
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      frame();
    }
  };
  /** GL calls made by `fn`, apart from the scene's `beginFrame`. */
  const callsDuring = (fn: () => void) => {
    const before = fake.calls.length;
    fn();
    return fake.calls.slice(before).filter((c) => !BEGIN_FRAME.has(c.name));
  };
  return { fake, scope, layer, values, frame, run, callsDuring };
}

const BEGIN_FRAME = new Set([
  "bindFramebuffer",
  "viewport",
  "disable",
  "blendEquation",
  "colorMask",
  "bindVertexArray",
]);

const defaultsOf = (defs: OverlayDefinition[]) => {
  const schema = streamOverlayParams(
    {},
    defs.map((d) => d.meta),
  );
  return Object.fromEntries(Object.entries(schema).map(([k, d]) => [k, d.default]));
};

describe("the registry", () => {
  it("has an implementation for every overlay's metadata, in the same order", () => {
    expect(OVERLAY_DEFINITIONS.map((d) => d.meta)).toEqual(OVERLAY_METAS);
  });

  it("builds a layer with every registered overlay and frees it all", () => {
    const fake = createFakeGl();
    const scope = createScope();
    const layer: StreamOverlays = createStreamOverlays(fake.gl, scope);
    layer.resize(VIEWPORT);
    layer.frame(DT, defaultsOf([...OVERLAY_DEFINITIONS]));
    scope.dispose();
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });
});

describe("createStreamOverlays", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips its pass entirely, holding no canvas, while every overlay is off", () => {
    const a = testOverlay("chat", ["column"]);
    const b = testOverlay("alerts", ["topCentre"]);
    const { fake, frame, callsDuring } = setup([a.def, b.def]);
    expect(callsDuring(frame)).toEqual([]);
    expect(callsDuring(frame)).toEqual([]);
    expect(fake.draws()).toBe(0);
    expect(fake.created.get("Texture")).toBe(1);
    // Still updated, so their clocks run while hidden.
    expect(a.log.updates).toBe(2);
    expect(b.log.time).toBeCloseTo(2 * DT);
    expect(a.log.draws).toEqual([]);
  });

  it("skips its pass with no overlays registered at all", () => {
    const { frame, callsDuring } = setup([]);
    expect(callsDuring(frame)).toEqual([]);
  });

  it("fades an overlay in when toggled on, drawing it in one blended pass", () => {
    const a = testOverlay("alerts", ["topCentre"]);
    const { fake, values, frame, run } = setup([a.def]);
    values.ovAlerts = true;
    frame();
    expect(a.log.fades[0]).toBeGreaterThan(0);
    expect(a.log.fades[0]).toBeLessThan(0.05);
    run(OVERLAY_FADE_SECONDS);
    expect(a.log.fades.at(-1)).toBe(1);
    // The fade never steps by much in a frame.
    const steps = a.log.fades.slice(1).map((f, i) => f - a.log.fades[i]);
    expect(Math.max(...steps)).toBeLessThan(0.06);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    expect(fake.draws()).toBe(a.log.fades.length);
    // Leaves the shared state as it found it.
    expect(fake.gl.isEnabled(fake.gl.BLEND)).toBe(false);
    expect(fake.state.vertexArray).toBeNull();
    expect(fake.state.drawFramebuffer).toBeNull();
    expect(fake.errors).toEqual([]);
  });

  it("redraws everything only when it must", () => {
    const a = testOverlay("alerts", ["topCentre"]);
    const { values, frame, layer } = setup([a.def]);
    values.ovAlerts = true;
    frame();
    frame();
    frame();
    expect(a.log.draws).toEqual([true, false, false]);
    values.ovAccent = "#ff0000";
    frame();
    frame();
    values.ovOpacity = 0.5;
    frame();
    layer.resize({ width: 1280, height: 720, scale: 720 / 1080 });
    frame();
    frame();
    expect(a.log.draws).toEqual([true, false, false, true, false, true, true, false]);
  });

  it("uploads only the rects that changed", () => {
    const a = testOverlay("alerts", ["topCentre"]);
    const { fake, values, frame, callsDuring } = setup([a.def]);
    values.ovAlerts = true;
    frame();
    const quiet = callsDuring(frame);
    expect(quiet.filter((c) => c.name === "texImage2D" || c.name === "texSubImage2D")).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it("fades out when toggled off, keeps updating, then stops the pass and frees the canvas", () => {
    const a = testOverlay("alerts", ["topCentre"]);
    const { fake, values, frame, run, callsDuring } = setup([a.def]);
    values.ovAlerts = true;
    run(1);
    values.ovAlerts = false;
    const drawsBefore = fake.draws();
    run(OVERLAY_FADE_SECONDS + 2 * DT);
    expect(a.log.fades.at(-1)).toBe(0);
    expect(fake.draws() - drawsBefore).toBeGreaterThan(25);
    const updates = a.log.updates;
    const calls = callsDuring(frame);
    expect(calls).toEqual([]);
    expect(a.log.updates).toBe(updates + 1);
    // Back on: drawn whole again.
    values.ovAlerts = true;
    frame();
    expect(a.log.draws.at(-1)).toBe(true);
    expect(fake.errors).toEqual([]);
  });

  it("gives two column overlays a side each, the earlier keeping a shared side", () => {
    const a = testOverlay("splits", ["column"]);
    const b = testOverlay("chat", ["column"]);
    const { values, frame, layer } = setup([a.def, b.def]);
    values.ovSplits = true;
    values.ovChat = true;
    values.splitsSide = "right";
    values.chatSide = "right";
    frame();
    expect(a.log.sides.at(-1)).toBe("right");
    expect(b.log.sides.at(-1)).toBe("left");
    // Placed at once, not slid in from somewhere.
    expect(b.log.shownX.at(-1)).toBe(layer.layout.columnLeft.x);
    // The panel's own choice is left alone.
    expect(values.chatSide).toBe("right");
  });

  it("leaves the other column's panel alone when a second column overlay appears", () => {
    const a = testOverlay("splits", ["column"]);
    const b = testOverlay("chat", ["column"]);
    const { fake, values, run, frame, callsDuring, layer } = setup([a.def, b.def]);
    Object.assign(values, { ovSplits: true, splitsSide: "right", chatSide: "right" });
    run(1);
    const aDraws = a.log.draws.length;
    values.ovChat = true;
    const uploads = callsDuring(frame).filter((c) => c.name === "texSubImage2D");
    expect(b.log.sides.at(-1)).toBe("left");
    // The new one appears in place rather than sliding over from the other side.
    expect(b.log.shownX.at(-1)).toBe(layer.layout.columnLeft.x);
    expect(a.log.draws.slice(aDraws)).toEqual([false]);
    const right = layer.layout.columnRight;
    const touchesRight = uploads.some((c) => Number(c.args[2]) + Number(c.args[4]) > right.x);
    expect(touchesRight).toBe(false);
    expect(fake.errors).toEqual([]);
  });

  it("slides the later column back to its own side once the earlier has faded out", () => {
    const a = testOverlay("splits", ["column"]);
    const b = testOverlay("chat", ["column"]);
    const { values, frame, run, layer } = setup([a.def, b.def]);
    Object.assign(values, { ovSplits: true, ovChat: true, splitsSide: "right", chatSide: "right" });
    run(1);
    values.ovSplits = false;
    run(OVERLAY_FADE_SECONDS - 2 * DT);
    // Still waiting for the earlier one to leave.
    expect(b.log.sides.at(-1)).toBe("left");
    run(4 * DT);
    expect(b.log.sides.at(-1)).toBe("right");
    const from = b.log.shownX.length - 1;
    run(SLOT_EASE_SECONDS + 2 * DT);
    const xs = b.log.shownX.slice(from);
    const steps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(xs.at(-1)).toBe(layer.layout.columnRight.x);
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    // No jump: the biggest step is the eased curve's peak.
    const travel = layer.layout.columnRight.x - layer.layout.columnLeft.x;
    expect(Math.max(...steps)).toBeLessThan(1.6 * travel * (DT / SLOT_EASE_SECONDS));
    frame();
  });

  it("slides a column overlay across when its side changes, redrawing it once there", () => {
    const a = testOverlay("chat", ["column"]);
    const { values, run, layer } = setup([a.def]);
    Object.assign(values, { ovChat: true, chatSide: "left" });
    run(1);
    const draws = a.log.draws.length;
    values.chatSide = "right";
    run(SLOT_EASE_SECONDS / 2);
    const mid = a.log.shownX.at(-1) ?? 0;
    expect(mid).toBeGreaterThan(layer.layout.columnLeft.x);
    expect(mid).toBeLessThan(layer.layout.columnRight.x);
    run(SLOT_EASE_SECONDS);
    expect(a.log.shownX.at(-1)).toBe(layer.layout.columnRight.x);
    expect(a.log.draws.slice(draws).filter(Boolean)).toEqual([true]);
  });

  it("frees a centred rect clear of the overlays that are on", () => {
    const a = testOverlay("chat", ["column"]);
    const b = testOverlay("alerts", ["topCentre"]);
    const { values, frame, layer } = setup([a.def, b.def]);
    const rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
    frame();
    const open = { ...layer.freeRect(rect) };
    Object.assign(values, { ovChat: true, ovAlerts: true });
    frame();
    const narrowed = { ...layer.freeRect(rect) };
    expect(narrowed.w).toBeLessThan(open.w);
    expect(narrowed.y).toBeGreaterThan(open.y);
    expect(narrowed.x + narrowed.w / 2).toBeCloseTo(VIEWPORT.width / 2);
  });

  it("paints the sprite atlas once, on first use, and draws sprites behind or in front", () => {
    const front = testOverlay("alerts", ["topCentre"], { sprites: 3, drawGl: true });
    const back = testOverlay("emotes", ["edges"], { sprites: 5, drawGl: true });
    const { fake, values, frame } = setup([front.def, back.def]);
    frame();
    expect(front.painted).toEqual([]);
    values.ovAlerts = true;
    values.ovEmotes = true;
    frame();
    frame();
    expect(front.painted).toEqual([0, 1, 2]);
    expect(back.painted).toEqual([0, 1, 2, 3, 4]);
    expect(fake.calls.filter((c) => c.name === "generateMipmap")).toHaveLength(1);
    // Two sprite draws a frame (back, front), and no panels: both overlays draw their own.
    expect(fake.draws()).toBe(4);
    expect(fake.errors).toEqual([]);
  });

  it("draws no sprites where the atlas can't be painted", () => {
    vi.unstubAllGlobals();
    const a = testOverlay("alerts", ["topCentre"], { sprites: 3, drawGl: true });
    const { fake, values, frame } = setup([a.def]);
    values.ovAlerts = true;
    frame();
    frame();
    expect(fake.draws()).toBe(0);
  });

  it("reserves sprites only while overlays are built", () => {
    let later: ((n: number) => number) | undefined;
    const def: OverlayDefinition = {
      meta: { id: "x", toggle: "ovX", label: "X", slots: ["topLeft"], params: {} },
      create(ctx) {
        later = (n) => ctx.reserveSprites(n, () => undefined);
        return { update: () => undefined, draw2d: () => undefined };
      },
    };
    setup([def]);
    expect(() => later?.(1)).toThrow(/reserved/);
  });

  it("caps the sprites a frame", () => {
    const many: OverlayDefinition = {
      meta: { id: "many", toggle: "ovMany", label: "Many", slots: ["edges"], params: {} },
      create(ctx) {
        const cell = ctx.reserveSprites(1, () => undefined);
        return {
          update: () => undefined,
          draw2d: () => undefined,
          drawGl(out) {
            for (let i = 0; i < 2 * MAX_SPRITES; i++) {
              out.sprite(cell, i, i, 10, 0, 1, true);
            }
          },
        };
      },
    };
    const { fake, values, frame } = setup([many]);
    values.ovMany = true;
    frame();
    const draw = fake.calls.find((c) => c.name === "drawArraysInstanced");
    expect(draw?.args[3]).toBe(MAX_SPRITES);
    expect(fake.errors).toEqual([]);
  });

  it("disposes every overlay and GL object with the scope", () => {
    const a = testOverlay("chat", ["column"], { sprites: 2, drawGl: true });
    const b = testOverlay("frame", ["border", "topLeft", "topRight"]);
    const { fake, scope, values, run } = setup([a.def, b.def]);
    Object.assign(values, { ovChat: true, ovFrame: true });
    run(0.5);
    scope.dispose();
    expect(a.log.disposed).toBe(1);
    expect(b.log.disposed).toBe(1);
    expect(fake.live()).toEqual([]);
    expect(fake.errors).toEqual([]);
  });

  it("rejects two overlays with the same id", () => {
    const a = testOverlay("chat", ["column"]);
    expect(() => setup([a.def, a.def])).toThrow(/share an id/);
  });
});
