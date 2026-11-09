import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyParamValues, EffectWebGL2, Viewport } from "../effects/types";
import { createFakeGl } from "../test/fake-gl";
import type { FrameRate } from "./frameRate";
import {
  createRenderLoop,
  fitSize,
  MAX_FIT_PIXELS,
  STATS_INTERVAL,
  type FrameStats,
  type LoopCanvas,
  type LoopHost,
  type RenderLoopOptions,
} from "./renderLoop";

/** A canvas with a fake WebGL2 context and dispatchable context events. */
function fakeCanvas(clientWidth = 800, clientHeight = 450) {
  const fake = createFakeGl();
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const canvas = {
    width: 300,
    height: 150,
    clientWidth,
    clientHeight,
    getContext: (kind: string) => (kind === "webgl2" ? fake.gl : null),
    addEventListener: (type: string, fn: (e: Event) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
  };
  const dispatch = (type: string) => {
    const event = { type, preventDefault: vi.fn<() => void>() };
    for (const fn of listeners.get(type) ?? []) {
      fn(event as unknown as Event);
    }
    return event;
  };
  const listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { canvas, loopCanvas: canvas as unknown as LoopCanvas, dispatch, listenerCount };
}

/** A host with a manual clock, frame queue and resize trigger. */
function fakeHost(dpr = 1) {
  let time = 0;
  let nextId = 1;
  const queue = new Map<number, (now: number) => void>();
  let resizeCallback: (() => void) | undefined;
  const disconnect = vi.fn<() => void>();
  const host: LoopHost = {
    requestFrame: (cb) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      queue.delete(id);
    },
    now: () => time,
    devicePixelRatio: () => dpr,
    observeResize: (_canvas, cb) => {
      resizeCallback = cb;
      return disconnect;
    },
  };
  /** Advances the clock by `ms` and runs the queued frame callbacks. */
  const step = (ms: number) => {
    time += ms;
    const due = [...queue.entries()];
    queue.clear();
    for (const [, cb] of due) {
      cb(time);
    }
  };
  return {
    host,
    step,
    disconnect,
    pending: () => queue.size,
    resize: () => resizeCallback?.(),
    hasObserver: () => resizeCallback !== undefined,
  };
}

/** A minimal effect whose instance methods are spies. */
function fakeEffect() {
  const instance = {
    resize: vi.fn<(v: Viewport) => void>(),
    frame: vi.fn<(dt: number, p: AnyParamValues) => void>(),
    dispose: vi.fn<() => void>(),
  };
  const create = vi.fn<(gl: WebGL2RenderingContext) => typeof instance>(() => instance);
  const effect = {
    id: "fake",
    name: "Fake",
    description: "",
    category: "Abstract",
    tags: [],
    context: "webgl2",
    params: {},
    create,
  } satisfies EffectWebGL2;
  return { effect, instance, create };
}

function start(overrides: Partial<RenderLoopOptions> & { dpr?: number } = {}) {
  const c = fakeCanvas();
  const h = fakeHost(overrides.dpr ?? 1);
  const e = fakeEffect();
  let frameRate: FrameRate = "display";
  const onStats = vi.fn<(s: FrameStats | undefined) => void>();
  const onError = vi.fn<(m: string | undefined) => void>();
  const onFrame = vi.fn<(now: number) => void>();
  const loop = createRenderLoop({
    canvas: c.loopCanvas,
    effect: e.effect,
    resolution: "window",
    getParams: () => ({}),
    getFrameRate: () => frameRate,
    onStats,
    onError,
    onFrame,
    host: h.host,
    ...overrides,
  });
  return {
    ...c,
    ...h,
    ...e,
    loop,
    onStats,
    onError,
    onFrame,
    setFrameRate: (r: FrameRate) => {
      frameRate = r;
    },
  };
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("fitSize", () => {
  it("multiplies the layout size by the device pixel ratio", () => {
    expect(fitSize(800, 450, 1)).toEqual({ width: 800, height: 450 });
    expect(fitSize(800, 450, 2)).toEqual({ width: 1600, height: 900 });
  });

  it("caps the ratio at 2 and the pixel count at 1080p", () => {
    expect(fitSize(400, 225, 3)).toEqual({ width: 800, height: 450 });
    const big = fitSize(1920, 1080, 2);
    expect(big.width * big.height).toBeLessThanOrEqual(MAX_FIT_PIXELS);
    expect(big).toEqual({ width: 1920, height: 1080 });
  });

  it("never returns a zero size", () => {
    expect(fitSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe("createRenderLoop", () => {
  it("creates the effect, sizes the buffer and resizes it once", () => {
    const t = start({ dpr: 2 });
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.canvas.width).toBe(1600);
    expect(t.canvas.height).toBe(900);
    expect(t.instance.resize).toHaveBeenCalledExactlyOnceWith({
      width: 1600,
      height: 900,
      scale: 900 / 1080,
    });
    expect(t.onError).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("skips a resize that doesn't change the buffer size", () => {
    const t = start();
    t.resize();
    expect(t.instance.resize).toHaveBeenCalledTimes(1);
    t.canvas.clientWidth = 640;
    t.resize();
    expect(t.instance.resize).toHaveBeenCalledTimes(2);
    expect(t.canvas.width).toBe(640);
  });

  it("uses a fixed resolution without observing the layout", () => {
    const t = start({ resolution: "720p" });
    expect(t.hasObserver()).toBe(false);
    expect(t.canvas.width).toBe(1280);
    expect(t.canvas.height).toBe(720);
  });

  it("draws every frame at the display rate and reports stats", () => {
    const t = start();
    for (let i = 0; i < 40; i++) {
      t.step(1000 / 60);
    }
    expect(t.instance.frame).toHaveBeenCalledTimes(40);
    expect(t.onFrame).toHaveBeenCalledTimes(40);
    const stats = t.onStats.mock.calls.map(([s]) => s).filter((s) => s !== undefined);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats[0].fps).toBeCloseTo(60, 0);
    expect(stats[0].source).toBe("cpu");
    expect(STATS_INTERVAL).toBeLessThan(40 * (1000 / 60));
  });

  it("draws every 4th frame for a 30 fps cap on a 120 Hz display", () => {
    const t = start();
    t.setFrameRate("30");
    for (let i = 0; i < 20; i++) {
      t.step(1000 / 120);
    }
    const before = t.instance.frame.mock.calls.length;
    for (let i = 0; i < 100; i++) {
      t.step(1000 / 120);
    }
    expect(t.instance.frame.mock.calls.length - before).toBe(25);
  });

  it.each(["frame", "resize"] as const)(
    "stops, disposes and reports once when %s throws",
    (stage) => {
      const t = start();
      for (let i = 0; i < 40; i++) {
        t.step(1000 / 60);
      }
      expect(t.onStats).toHaveBeenLastCalledWith(expect.objectContaining({ source: "cpu" }));
      const boom = new Error("boom");
      if (stage === "frame") {
        t.instance.frame.mockImplementation(() => {
          throw boom;
        });
      } else {
        t.instance.resize.mockImplementation(() => {
          throw boom;
        });
        t.canvas.clientWidth = 500;
        t.resize();
      }
      for (let i = 0; i < 10; i++) {
        t.step(1000 / 60);
      }
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(t.instance.dispose).toHaveBeenCalledTimes(1);
      expect(t.onError).toHaveBeenLastCalledWith("This effect stopped after an error: boom");
      expect(t.onError).toHaveBeenCalledTimes(2);
      expect(t.onStats).toHaveBeenLastCalledWith(undefined);
    },
  );

  it("reports an effect that fails to start, and keeps the loop idle", () => {
    const broken = fakeEffect();
    broken.create.mockImplementation(() => {
      throw new Error("bad shader");
    });
    const t = start({ effect: broken.effect });
    expect(t.onError).toHaveBeenLastCalledWith("This effect failed to start: bad shader");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    t.step(16);
    expect(t.instance.frame).not.toHaveBeenCalled();
    expect(t.pending()).toBe(1);
  });

  it("drops the effect on context loss and re-creates it on restore", () => {
    const t = start();
    t.step(16);
    const lost = t.dispatch("webglcontextlost");
    expect(lost.preventDefault).toHaveBeenCalled();
    t.step(16);
    t.step(16);
    expect(t.instance.frame).toHaveBeenCalledTimes(1);
    expect(t.instance.dispose).not.toHaveBeenCalled();
    t.dispatch("webglcontextrestored");
    expect(t.create).toHaveBeenCalledTimes(2);
    expect(t.instance.resize).toHaveBeenCalledTimes(2);
    t.step(16);
    expect(t.instance.frame).toHaveBeenCalledTimes(2);
  });

  it("stops everything on dispose", () => {
    const t = start();
    t.step(16);
    t.loop.dispose();
    expect(t.pending()).toBe(0);
    expect(t.disconnect).toHaveBeenCalledTimes(1);
    expect(t.instance.dispose).toHaveBeenCalledTimes(1);
    expect(t.listenerCount()).toBe(0);
    expect(t.onStats).toHaveBeenLastCalledWith(undefined);
  });
});
