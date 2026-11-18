import { describe, expect, it } from "vitest";
import { cabinetLayout, paintCabinet } from "./arcade-cabinet";

describe("the cabinet", () => {
  it.each([
    [1920, 1080],
    [2560, 1080],
    [1080, 1920],
    [640, 480],
    [1, 1],
  ])("puts the screen inside the frame, in its upper two-thirds, at %i x %i", (w, h) => {
    const l = cabinetLayout(w, h);
    expect(l.screenX).toBeGreaterThanOrEqual(0);
    expect(l.screenX + l.screenW).toBeLessThanOrEqual(w);
    expect(l.screenY).toBeGreaterThanOrEqual(0);
    expect(l.screenY + l.screenH).toBeLessThanOrEqual(Math.ceil((h * 2) / 3) + 1);
    expect(l.screenW).toBeGreaterThan(0);
    expect(l.screenH).toBeGreaterThan(0);
  });

  it("keeps the screen in the middle third at 16:9", () => {
    const l = cabinetLayout(1920, 1080);
    expect(l.screenX + l.screenW / 2).toBeCloseTo(960, 0);
    expect(l.screenW).toBeLessThan(1920 / 3);
  });

  it("paints on a context without throwing", () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "createLinearGradient" || key === "createRadialGradient"
            ? () => undefined
            : () => calls.push(String(key)),
        set: () => true,
      },
    ) as OffscreenCanvasRenderingContext2D;
    paintCabinet(ctx, 1920, 1080, "STAR SALVAGE");
    expect(calls.at(-1)).toBe("clearRect");
  });
});
