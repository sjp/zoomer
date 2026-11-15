import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeGl } from "../test/fake-gl";
import { FakeOffscreenCanvas } from "../test/offscreen-canvas";
import { createCanvasAtlas } from "./canvas-texture";
import { createScope } from "./gl";

describe("createCanvasAtlas", () => {
  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const build = () => {
    const fake = createFakeGl({ record: true });
    const scope = createScope();
    const atlas = createCanvasAtlas(fake.gl, scope);
    const uploads = () => ({
      full: fake.calls.filter((c) => c.name === "texImage2D").length,
      rects: fake.calls.filter((c) => c.name === "texSubImage2D").length,
    });
    return { fake, scope, atlas, uploads };
  };

  it("uploads the whole canvas once more rects are cleared than it keeps", () => {
    const { fake, scope, atlas, uploads } = build();
    atlas.resize(200, 100);
    atlas.flush();
    const before = uploads();
    // Well past the rects it keeps between flushes.
    for (let i = 0; i < 100; i++) {
      atlas.clear(i * 2, 0, 1, 1);
    }
    atlas.flush();
    expect(uploads()).toEqual({ full: before.full + 1, rects: before.rects });
    // Then back to rects.
    atlas.clear(0, 0, 4, 4);
    atlas.flush();
    expect(uploads()).toEqual({ full: before.full + 1, rects: before.rects + 1 });
    scope.dispose();
    expect(fake.errors).toEqual([]);
  });

  it("comes back after release at the same size, with a full upload", () => {
    const { fake, scope, atlas, uploads } = build();
    atlas.resize(64, 32);
    atlas.flush();
    expect(atlas.ready).toBe(true);
    atlas.release();
    expect(atlas.ctx).toBeNull();
    expect(atlas.ready).toBe(false);
    // A flush with no canvas uploads nothing.
    const released = uploads();
    atlas.flush();
    expect(uploads()).toEqual(released);
    // The same size as before release still makes a new canvas.
    expect(atlas.resize(64, 32)).toBe(true);
    expect(atlas.ctx).not.toBeNull();
    expect([atlas.width, atlas.height]).toEqual([64, 32]);
    expect(atlas.ready).toBe(false);
    atlas.clear(0, 0, 8, 8);
    atlas.flush();
    expect(uploads()).toEqual({ full: released.full + 1, rects: released.rects });
    expect(atlas.ready).toBe(true);
    scope.dispose();
    expect(fake.errors).toEqual([]);
    expect(fake.live()).toEqual([]);
  });
});
