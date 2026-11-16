import { beforeEach, describe, expect, it } from "vitest";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { EMOTE_IDS, emoteIndex, paintEmote } from "./emote-art";

const context = () =>
  new MeasuringCanvas(128, 128).getContext() as unknown as OffscreenCanvasRenderingContext2D;

describe("emote art", () => {
  beforeEach(() => {
    MeasuringCanvas.reset();
  });

  it("has sixteen emotes with unique lowercase ids", () => {
    expect(EMOTE_IDS).toHaveLength(16);
    expect(new Set(EMOTE_IDS).size).toBe(EMOTE_IDS.length);
    for (const id of EMOTE_IDS) {
      expect(id).toMatch(/^[a-z]+$/);
    }
  });

  it("finds an emote by id", () => {
    expect(emoteIndex("happy")).toBe(0);
    expect(emoteIndex("party")).toBe(EMOTE_IDS.length - 1);
    expect(emoteIndex("nope")).toBe(-1);
  });

  it.each(EMOTE_IDS.map((id, i) => [id, i] as const))(
    "paints %s scaled to its square, leaving the context as it was",
    (_, i) => {
      const ctx = context();
      paintEmote(ctx, i, 32);
      const calls = MeasuringCanvas.calls.map((c) => c.method);
      expect(calls.filter((m) => m === "save").length).toBe(
        calls.filter((m) => m === "restore").length,
      );
      expect(MeasuringCanvas.calls[1]).toMatchObject({ method: "scale", args: [0.25, 0.25] });
      expect(calls.some((m) => m === "fill")).toBe(true);
      expect(calls.at(-1)).toBe("restore");
    },
  );

  it("wraps an index outside the set", () => {
    const ctx = context();
    paintEmote(ctx, -1, 128);
    const last = MeasuringCanvas.calls.length;
    MeasuringCanvas.reset();
    paintEmote(context(), EMOTE_IDS.length - 1, 128);
    expect(MeasuringCanvas.calls.length).toBe(last);
  });
});
