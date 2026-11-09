import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../../test/fake-gl";
import { lowResSize } from "../lowres";
import { defaults } from "../params";
import type { EffectDefinition } from "../types";
import { frost } from "./frost";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frost", () => {
  it("retries a failed diffuse target only when the size changes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fake = createFakeGl();
    // Only the diffuse target (1/16 of the canvas width) fails to allocate.
    let canvasWidth = 640;
    let storedWidth = 0;
    const gl = new Proxy(fake.gl, {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (key === "texStorage2D") {
          return (t: GLenum, levels: number, format: GLenum, w: number, h: number) => {
            storedWidth = w;
            target.texStorage2D(t, levels, format, w, h);
          };
        }
        if (key === "checkFramebufferStatus") {
          return (t: GLenum) =>
            storedWidth === lowResSize(canvasWidth, 16) ? 0 : target.checkFramebufferStatus(t);
        }
        return value;
      },
    });
    const effect: EffectDefinition = frost;
    const instance = effect.create(gl);
    const params = defaults(effect.params);
    instance.resize({ width: 640, height: 360, scale: 1 / 3 });
    instance.frame(1 / 60, params);
    const textures = fake.created.get("Texture") ?? 0;
    const draws = fake.draws();
    for (let i = 0; i < 10; i++) {
      instance.frame(1 / 60, params);
    }
    // No new targets, and the scene isn't redrawn every frame.
    expect(fake.created.get("Texture") ?? 0).toBe(textures);
    expect(fake.draws() - draws).toBeLessThanOrEqual(10);
    expect(warn).toHaveBeenCalledOnce();
    // A new size tries again.
    canvasWidth = 1280;
    instance.resize({ width: 1280, height: 720, scale: 2 / 3 });
    instance.frame(1 / 60, params);
    expect(fake.created.get("Texture") ?? 0).toBeGreaterThan(textures);
    expect(warn).toHaveBeenCalledTimes(2);
    instance.dispose?.();
  });
});
