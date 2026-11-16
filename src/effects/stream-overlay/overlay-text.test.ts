import { beforeEach, describe, expect, it } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import {
  cssRgba,
  drawPanel,
  fillLine,
  fillTabular,
  fitText,
  hashString,
  measureTabular,
  OVERLAY_FONT_STACK,
  overlayFont,
  PANEL_MUTED,
  PANEL_PADDING,
  PANEL_RADIUS,
  PANEL_TEXT,
  USERNAME_COLOURS,
  usernameColour,
} from "./overlay-text";

/** A recording 2D context whose text is 0.5 em per character. */
function context() {
  MeasuringCanvas.reset(0.5);
  return new MeasuringCanvas(800, 600).getContext() as unknown as OffscreenCanvasRenderingContext2D;
}

const calls = (method: string) => MeasuringCanvas.calls.filter((c) => c.method === method);

describe("overlayFont", () => {
  it("names a whole pixel size, the weight and the shared stack", () => {
    expect(overlayFont(20.4, 700)).toBe(`700 20px ${OVERLAY_FONT_STACK}`);
    expect(overlayFont(0)).toBe(`400 1px ${OVERLAY_FONT_STACK}`);
  });
});

describe("cssRgba", () => {
  it("turns a hex colour and alpha into CSS, clamping the alpha", () => {
    expect(cssRgba("#a48cf0", 0.5)).toBe("rgba(164, 140, 240, 0.5)");
    expect(cssRgba("#000000", 2)).toBe("rgba(0, 0, 0, 1)");
    expect(cssRgba("#ffffff", Number.NaN)).toBe("rgba(255, 255, 255, 0)");
  });
});

describe("drawPanel", () => {
  let ctx: OffscreenCanvasRenderingContext2D;
  beforeEach(() => {
    ctx = context();
  });

  it("fills a rounded rect at the given opacity, inside its whole-pixel rect", () => {
    drawPanel(ctx, 10.4, 20.6, 300.2, 400, 1, 0.85);
    const [fill, rim] = calls("roundRect");
    expect(fill.args).toEqual([10, 21, 300, 400, PANEL_RADIUS]);
    expect(rim.args[0]).toBeGreaterThanOrEqual(10);
    expect(Number(rim.args[0]) + Number(rim.args[2])).toBeLessThanOrEqual(310);
    expect(calls("fill")[0].fillStyle).toBe("rgba(14, 12, 24, 0.85)");
    expect(calls("fillRect")).toEqual([]);
  });

  it("adds the accent strip along the top", () => {
    drawPanel(ctx, 0, 0, 200, 100, 2, 1, "#ff0000");
    const [strip] = calls("fillRect");
    expect(strip.args).toEqual([0, 0, 200, 6]);
    expect(strip.fillStyle).toBe("#ff0000");
  });

  it("keeps the corner radius within a small panel", () => {
    drawPanel(ctx, 0, 0, 10, 8, 2, 1);
    expect(calls("roundRect")[0].args[4]).toBe(4);
  });

  it("draws nothing for an empty rect", () => {
    drawPanel(ctx, 0, 0, 0, 100, 1, 1);
    expect(MeasuringCanvas.calls).toEqual([]);
  });

  it("scales its geometry from 1080p", () => {
    expect(PANEL_PADDING).toBeGreaterThan(0);
    drawPanel(ctx, 0, 0, 400, 400, 2, 1);
    expect(calls("roundRect")[0].args[4]).toBe(2 * PANEL_RADIUS);
  });
});

describe("fitText", () => {
  let ctx: OffscreenCanvasRenderingContext2D;
  beforeEach(() => {
    ctx = context();
    ctx.font = "20px sans-serif";
  });

  it("leaves text that fits alone", () => {
    expect(fitText(ctx, "hello", 50)).toBe("hello");
  });

  it("cuts text with an ellipsis to the most that fits", () => {
    // 10 px a character: 6 characters including the ellipsis fit 60 px.
    expect(fitText(ctx, "hello world", 60)).toBe("hello…");
    expect(fitText(ctx, "hello world", 59)).toBe("hell…");
  });

  it("drops a space left before the ellipsis", () => {
    expect(fitText(ctx, "ab cdefgh", 40)).toBe("ab…");
  });

  it("never splits a surrogate pair", () => {
    expect(fitText(ctx, "𝔸𝔹ℂ𝔻𝔼𝔽", 30)).toBe("𝔸𝔹…");
  });

  it("gives nothing when not even the ellipsis fits", () => {
    expect(fitText(ctx, "hello", 5)).toBe("");
    expect(fitText(ctx, "hello", 0)).toBe("");
    expect(fitText(ctx, "hello", Number.NaN)).toBe("");
  });
});

describe("fillLine", () => {
  it("draws the fitted text centred on y and returns its width", () => {
    const ctx = context();
    const w = fillLine(ctx, "hello world", 5.4, 9.6, "20px x", PANEL_TEXT, 60);
    const [text] = calls("fillText");
    expect(text.args).toEqual(["hello…", 5, 10]);
    expect(text.fillStyle).toBe(PANEL_TEXT);
    expect(ctx.textBaseline).toBe("middle");
    expect(w).toBe(60);
  });

  it("draws nothing where nothing fits", () => {
    const ctx = context();
    expect(fillLine(ctx, "hello", 0, 0, "20px x", PANEL_MUTED, 4)).toBe(0);
    expect(calls("fillText")).toEqual([]);
  });
});

describe("fillTabular", () => {
  it("gives every digit the same cell, so the figures stay put", () => {
    const ctx = context();
    const total = fillTabular(ctx, "1:05.3", 100, 50, "20px x", PANEL_TEXT, "right");
    const xs = calls("fillText").map((c) => c.args[1]);
    // Every character is 10 px wide here: right-aligned at 100, six cells from 40.
    expect(total).toBe(60);
    expect(xs).toEqual([45, 55, 65, 75, 85, 95]);
    expect(calls("fillText").map((c) => c.args[0])).toEqual(["1", ":", "0", "5", ".", "3"]);
  });

  it("aligns left and centre", () => {
    const ctx = context();
    fillTabular(ctx, "12", 0, 0, "20px x", PANEL_TEXT, "left");
    fillTabular(ctx, "12", 100, 0, "20px x", PANEL_TEXT, "center");
    expect(calls("fillText").map((c) => c.args[1])).toEqual([5, 15, 95, 105]);
  });
});

describe("measureTabular", () => {
  it("gives the width fillTabular draws", () => {
    const ctx = context();
    expect(measureTabular(ctx, "1:05.3", "20px x")).toBe(60);
    expect(measureTabular(ctx, "", "20px x")).toBe(0);
  });
});

describe("on a canvas without text metrics", () => {
  const bare = new Proxy(
    {},
    { get: () => () => undefined },
  ) as unknown as OffscreenCanvasRenderingContext2D;

  it("measures nothing and draws without throwing", () => {
    expect(fitText(bare, "Speedrun", 100)).toBe("Speedrun");
    expect(fillLine(bare, "Speedrun", 0, 0, "20px x", PANEL_TEXT, 100)).toBe(0);
    expect(fillTabular(bare, "1:05.3", 0, 0, "20px x", PANEL_TEXT)).toBe(0);
    expect(measureTabular(bare, "1:05.3", "20px x")).toBe(0);
  });
});

describe("usernameColour", () => {
  it("is stable per name", () => {
    expect(usernameColour("mossy_kettle")).toBe(usernameColour("mossy_kettle"));
    expect(hashString("PixelOtter42")).toBe(hashString("PixelOtter42"));
  });

  it("comes from the palette and uses all of it", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = usernameColour(`viewer${String(i)}`);
      expect(USERNAME_COLOURS).toContain(c);
      seen.add(c);
    }
    expect(seen.size).toBe(USERNAME_COLOURS.length);
  });

  it("tells similar names apart", () => {
    const names = ["quietcomet", "quietcomet1", "quietcomet2", "quietcomeu", "Quietcomet"];
    expect(new Set(names.map((n) => hashString(n))).size).toBe(names.length);
  });

  it("has distinct, valid colours", () => {
    expect(new Set(USERNAME_COLOURS).size).toBe(USERNAME_COLOURS.length);
    for (const c of USERNAME_COLOURS) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
