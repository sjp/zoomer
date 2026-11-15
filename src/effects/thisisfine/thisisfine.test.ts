import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { MeasuringCanvas } from "../../test/offscreen-canvas";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { comicFont, paintBubble, paintRoom } from "./room-art";
import { roomLayout } from "./thisisfine-sim";
import { thisisfine } from "./thisisfine";

beforeEach(() => {
  MeasuringCanvas.reset(0.5);
  vi.stubGlobal("OffscreenCanvas", MeasuringCanvas);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("room art", () => {
  it("paints each room differently, at device size", () => {
    const layout = roomLayout(1920, 1080, 1);
    const office = paintRoom("office", layout, 1, 960, 540, 0.5) as unknown as MeasuringCanvas;
    const officeCalls = MeasuringCanvas.calls.length;
    expect([office.width, office.height]).toEqual([960, 540]);
    MeasuringCanvas.reset();
    paintRoom("kitchen", layout, 1, 960, 540, 0.5);
    expect(MeasuringCanvas.calls.length).not.toBe(officeCalls);
  });

  it("shrinks the bubble's lettering to fit a long line", () => {
    const layout = roomLayout(1920, 1080, 1);
    paintBubble("Fine.", layout, 1);
    const short = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
    MeasuringCanvas.reset();
    paintBubble("This is absolutely fine.", layout, 1);
    const long = MeasuringCanvas.calls.findLast((c) => c.method === "fillText");
    expect(short?.font).toBe(comicFont(52));
    const px = Number(/([\d.]+)px/.exec(long?.font ?? "")?.[1]);
    expect(px).toBeLessThan(52);
    expect(24 * px * 0.5).toBeLessThanOrEqual(layout.bubble.w * 0.8);
  });

  it("places the bubble's canvas round the bubble and its tail", () => {
    const layout = roomLayout(1920, 1080, 1);
    const art = paintBubble("This is fine.", layout, 2);
    expect(art.x).toBeLessThan(layout.bubble.x * 2);
    expect(art.x + art.width).toBeGreaterThan(layout.tailX * 2);
    expect(art.y + art.height).toBeGreaterThan(layout.tailY * 2);
  });
});

describe("this is fine", () => {
  it("draws identical frames over time at Motion 0", () => {
    const fake = createFakeGl();
    const uploads: number[][] = [];
    const uniforms: string[] = [];
    let frame = 0;
    const gl = new Proxy(fake.gl, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          if (frame >= 3 && key === "texSubImage2D") {
            const data = args.find((a) => a instanceof Float32Array);
            if (data) {
              uploads.push(Array.from(data));
            }
          }
          if (frame >= 3 && String(key).startsWith("uniform")) {
            uniforms.push(String(key));
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const effect: EffectDefinition = thisisfine;
    const instance = effect.create(gl);
    const params = { ...defaults(effect.params), motion: 0, caption: true };
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    for (frame = 0; frame < 8; frame++) {
      instance.frame(1 / 60, params);
    }
    // After the bubble has started fading in, nothing but its opacity changes,
    // and the still flame profile isn't rebuilt or uploaded.
    expect(new Set(uniforms)).toEqual(new Set(["uniform1f"]));
    expect(uploads).toEqual([]);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });

  it("crossfades a room change, frees the faded-out room, and frees everything", () => {
    const fake = createFakeGl({ record: true });
    const effect: EffectDefinition = thisisfine;
    const instance = effect.create(fake.gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 60, params);
    const blanks = () =>
      fake.calls.filter((c) => c.name === "texImage2D" && c.args[3] === 1 && c.args[4] === 1)
        .length;
    const before = blanks();
    for (let i = 0; i < 60; i++) {
      instance.frame(1 / 60, { ...params, room: "kitchen", style: "painted", caption: true });
    }
    // Mid-fade both rooms are held.
    expect(blanks()).toBe(before);
    for (let i = 0; i < 30; i++) {
      instance.frame(1 / 60, { ...params, room: "kitchen", style: "painted", caption: true });
    }
    expect(MeasuringCanvas.made.filter((c) => c.width === 640).length).toBe(2);
    // Once the old room has faded out, its slot drops to one texel.
    expect(blanks()).toBe(before + 1);
    instance.dispose?.();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });
});
