import { beforeEach, describe, expect, it } from "vitest";
import { drawLogo, letterFont, logoLayout } from "./logo-art";
import { MeasuringCanvas } from "../../test/offscreen-canvas";

describe("logoLayout", () => {
  it("draws the default letters with the built-in outlines, in a wide box", () => {
    const l = logoLayout("dvd", () => undefined);
    expect(l.text).toBe("DVD");
    expect(l.builtIn).toBe(true);
    expect(l.width / l.height).toBeGreaterThan(1.9);
    expect(l.width / l.height).toBeLessThan(2.4);
  });

  it("sets other text in the system font, as wide as measured", () => {
    const l = logoLayout(" Zoom ", (s) => (s === "ZOOM" ? 3 : undefined));
    expect(l.text).toBe("ZOOM");
    expect(l.builtIn).toBe(false);
    expect(l.lettersWidth).toBeGreaterThan(3);
    expect(l.width).toBeGreaterThanOrEqual(l.lettersWidth);
  });

  it("falls back to an estimate per character when nothing can be measured", () => {
    const short = logoLayout("AB", () => undefined);
    const long = logoLayout("ABCDEF", () => undefined);
    expect(long.lettersWidth).toBeGreaterThan(short.lettersWidth);
    expect(Number.isFinite(long.width)).toBe(true);
  });

  it("keeps the disc inside the box, and shows the disc alone for empty text", () => {
    for (const text of ["", "DVD", "V", "WWWWWWWW"]) {
      const l = logoLayout(text, () => undefined);
      expect(l.discX - l.discRx).toBeGreaterThanOrEqual(0);
      expect(l.discX + l.discRx).toBeLessThanOrEqual(l.width + 1e-9);
      expect(l.discY + l.discRy).toBeCloseTo(l.height, 12);
    }
    const empty = logoLayout("  ", () => undefined);
    expect(empty.text).toBe("");
    expect(empty.lettersWidth).toBe(0);
    expect(empty.discY - empty.discRy).toBe(0);
  });

  it("sizes the font so its capitals are the asked height", () => {
    expect(letterFont(72)).toMatch(/^italic 900 100px /);
  });
});

describe("drawLogo", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
  });

  const draw = (text: string) => {
    const ctx = new MeasuringCanvas(
      1,
      1,
    ).getContext() as unknown as OffscreenCanvasRenderingContext2D;
    drawLogo(
      ctx,
      logoLayout(text, () => undefined),
      10,
      20,
      50,
    );
    return MeasuringCanvas.calls;
  };

  it("fills each built-in letter even-odd, so the D keeps its counter", () => {
    const calls = draw("DVD");
    expect(calls.filter((c) => c.method === "fill" && c.args[0] === "evenodd")).toHaveLength(3);
    expect(calls.filter((c) => c.method === "ellipse")).toHaveLength(1);
    // The skew is undone afterwards.
    const transforms = calls.filter((c) => c.method === "setTransform");
    expect(transforms.at(-1)?.args).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("cuts VIDEO out of the disc letter by letter", () => {
    const text = draw("DVD")
      .filter((c) => c.method === "fillText")
      .map((c) => c.args[0])
      .join("");
    expect(text).toBe("VIDEO");
  });

  it("sets other text in the heavy italic font", () => {
    const calls = draw("Zoom").filter((c) => c.method === "fillText");
    expect(calls[0].args[0]).toBe("ZOOM");
    expect(calls[0].font).toBe(letterFont(50));
  });
});
