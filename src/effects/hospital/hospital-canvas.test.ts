import { describe, expect, it } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { BOARD_BAND, BOARD_HEADING, drawBoard } from "./hospital-canvas";

describe("drawBoard", () => {
  const W = 400;
  const H = 300;

  const draw = (text: string) => {
    MeasuringCanvas.reset(0.5);
    const ctx = new MeasuringCanvas(
      W,
      H,
    ).getContext() as unknown as OffscreenCanvasRenderingContext2D;
    drawBoard(ctx, W, H, text);
    return MeasuringCanvas.calls.filter((c) => c.method === "fillText");
  };
  /** The handwritten lines: everything after the printed heading. */
  const lines = (text: string) => draw(text).slice(1);
  const px = (font: string) => Number(/([\d.]+)px/.exec(font)?.[1]);

  it("prints the heading even with nothing written", () => {
    const calls = draw("");
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0]).toBe(BOARD_HEADING);
  });

  it("writes one line per text line, trimmed, the first in the other marker", () => {
    const calls = lines("  Nurse: Sam  \nDoctor: Lee\nGoal: rest");
    expect(calls.map((c) => c.args[0])).toEqual(["Nurse: Sam", "Doctor: Lee", "Goal: rest"]);
    expect(calls.map((c) => c.fillStyle)).toEqual(["#0f0", "#f00", "#f00"]);
  });

  it("drops trailing blank lines but keeps blank lines between", () => {
    const calls = lines("One\n\nThree\n  \n\n");
    expect(calls.map((c) => c.args[0])).toEqual(["One", "", "Three"]);
    expect(lines("\n \n")).toEqual([]);
  });

  it("spaces lines evenly below the heading's band, at least three rows' pitch", () => {
    const band = BOARD_BAND * H;
    const pitch3 = (H - band) / 3.35;
    const ys = lines("A\nB").map((c) => Number(c.args[2]));
    expect(ys[0]).toBeCloseTo(band + pitch3 * 0.95, 9);
    expect(ys[1] - ys[0]).toBeCloseTo(pitch3, 9);
    const five = lines("1\n2\n3\n4\n5").map((c) => Number(c.args[2]));
    expect(five[1] - five[0]).toBeCloseTo((H - band) / 5.35, 9);
    expect(five[4]).toBeLessThan(H);
  });

  it("shrinks a line too long for the board to fit its width", () => {
    const calls = lines(`Short\n${"W".repeat(80)}`);
    const short = px(calls[0].font);
    const long = px(calls[1].font);
    expect(long).toBeLessThan(short);
    expect(80 * 0.5 * long).toBeCloseTo(W * 0.86, 6);
  });
});
