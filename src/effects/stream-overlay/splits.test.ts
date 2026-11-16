import { beforeEach, describe, expect, it } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { createScope } from "../gl";
import { sanitizeText } from "../params";
import type { AnyParamValues } from "../types";
import type { OverlayCanvas, OverlayDraw, OverlayInstance, OverlayView } from "./overlay-layer";
import { computeOverlayLayout, type Rect } from "./overlay-layout";
import { streamOverlayParams } from "./overlay-params.meta";
import { DIFF_FADE_SECONDS, splitsOverlay } from "./splits";
import { parseSplitLine, planSplits, simulateRun, START_SECONDS, textSeed } from "./splits-run";
import { splitsMeta } from "./splits.meta";
import { createStreamEvents } from "./stream-events";

const DT = 1 / 60;

describe("splitsMeta", () => {
  it("cuts very long split names to the text param's length", () => {
    const def = splitsMeta.params.splitsList;
    if (def.kind !== "text") {
      throw new Error("splitsList is a text param");
    }
    const value = sanitizeText(def, `${"Very long split name ".repeat(5)}  4:32\nNext`);
    const lines = value.split("\n").map((l) => parseSplitLine(l));
    expect(lines).toHaveLength(2);
    expect(Array.from(lines[0]?.name ?? "").length).toBeLessThanOrEqual(def.maxLength);
    expect(lines[1]).toEqual({ name: "Next", time: null });
  });
});

function setup(column?: Rect) {
  MeasuringCanvas.reset();
  const layout = computeOverlayLayout(1920, 1080);
  const target = column ?? layout.columnRight;
  const view: OverlayView = {
    width: 1920,
    height: 1080,
    scale: 1,
    layout,
    on: true,
    fade: 1,
    side: "right",
    accent: "#a48cf0",
    accentRgb: [0.64, 0.55, 0.94],
    opacity: 0.85,
    target: () => target,
    shown: () => target,
  };
  const schema = streamOverlayParams({ ovSplits: true });
  const values: AnyParamValues = Object.fromEntries(
    Object.entries(schema).map(([k, d]) => [k, d.default]),
  );
  const instance: OverlayInstance = splitsOverlay.create({
    gl: {} as WebGL2RenderingContext,
    scope: createScope(),
    reserveSprites: () => 0,
    events: createStreamEvents(),
  });
  const clears: Rect[][] = [];
  let pending: Rect[] = [];
  const canvas: OverlayCanvas = {
    ctx: new MeasuringCanvas(
      1920,
      1080,
    ).getContext() as unknown as OffscreenCanvasRenderingContext2D,
    clear: (x, y, w, h) => {
      pending.push({ x, y, w, h });
    },
  };
  let first = true;
  /** One frame: update, then draw; records the rects cleared. */
  const frame = (dt = DT) => {
    instance.update(dt, values, view);
    pending = [];
    instance.draw2d(canvas, view, first);
    first = false;
    clears.push(pending);
  };
  const run = (seconds: number) => {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      frame();
    }
  };
  return { instance, view, values, clears, frame, run, target };
}

/** When the first split of the default list finishes, in seconds from the start. */
function firstSplitAt(): number {
  const list = String(splitsMeta.params.splitsList.default);
  const plan = planSplits(list, 300, textSeed(list));
  return START_SECONDS + simulateRun(plan.comparison, 0.5, 1, 0)[0];
}

describe("splitsOverlay", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
  });

  it("redraws only the timer's rect each tenth while no split finishes", () => {
    const { clears, frame, run } = setup();
    frame();
    expect(clears[0]).toEqual([]);
    run(START_SECONDS + 1.5);
    const all = clears.slice(1).flat();
    // 1.5 s of counting: a redraw per tenth, at most one a frame.
    expect(all.length).toBeGreaterThanOrEqual(14);
    expect(all.length).toBeLessThanOrEqual(16);
    expect(clears.slice(1).every((c) => c.length <= 1)).toBe(true);
    for (const rect of all) {
      expect(rect).toEqual(all[0]);
    }
    expect(all[0].h).toBe(64);
  });

  it("fades a finished split's difference in, then stops redrawing the rows", () => {
    const { clears, frame, run } = setup();
    frame();
    const at = firstSplitAt();
    run(at - 0.5);
    const before = clears.length;
    run(1.5);
    const rows = clears
      .slice(before)
      .flat()
      .filter((r) => r.h > 64);
    const frames = DIFF_FADE_SECONDS / DT;
    expect(rows.length).toBeGreaterThanOrEqual(frames);
    expect(rows.length).toBeLessThanOrEqual(frames + 3);
    // Six rows of 34 px.
    expect(rows[0].h).toBe(6 * 34);
  });

  it("queues just its panel, at its fade, inside the column", () => {
    const { instance, view, frame, target } = setup();
    frame();
    const panels: number[][] = [];
    const out: OverlayDraw = {
      panel: (...args) => {
        panels.push(args.slice(0, 9).map(Number));
      },
      sprite: () => undefined,
    };
    instance.drawGl?.(out, { ...view, fade: 0.5 });
    expect(panels).toHaveLength(1);
    const [sx, sy, sw, sh, dx, dy, dw, dh, alpha] = panels[0];
    expect([sx, sy, sw]).toEqual([target.x, target.y, target.w]);
    expect(sh).toBeGreaterThan(200);
    expect(sh).toBeLessThan(target.h);
    expect([dx, dy, dw, dh]).toEqual([sx, sy, sw, sh]);
    expect(alpha).toBe(0.5);
  });

  it("fits a long list in a short column, stepping the window a row at a time", () => {
    const column = { x: 1400, y: 200, w: 400, h: 400 };
    const { instance, view, values, clears, frame, run } = setup(column);
    values.splitsList = Array.from({ length: 20 }, (_, i) => `Level ${String(i + 1)}`).join("\n");
    frame();
    // The new list starts with the next run; run through one and into the next.
    run(300 + 60);
    let height = 0;
    instance.drawGl?.(
      {
        panel: (_sx, _sy, _sw, sh) => {
          height = sh;
        },
        sprite: () => undefined,
      },
      view,
    );
    expect(height).toBeLessThanOrEqual(column.h);
    expect(height).toBeGreaterThan(200);
    // Each step of the list redraws the rows for about the step's length, never continuously.
    const rowFrames = clears.filter((c) => c.some((r) => r.h > 64)).length;
    expect(rowFrames).toBeGreaterThan(0);
    expect(rowFrames).toBeLessThan(clears.length / 2);
  });
});
