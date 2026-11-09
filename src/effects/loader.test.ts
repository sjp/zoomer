import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEffectLoader, createLatest, whenIdle, type EffectEntry } from "./loader";
import { defineEffect, defineEffectMeta, type EffectDefinition } from "./types";

const meta = (id: string) =>
  defineEffectMeta({
    id,
    name: id,
    description: id,
    category: "Abstract",
    tags: ["test"],
    context: "webgl2",
    params: { speed: { kind: "number", label: "Speed", min: 0, max: 1, step: 0.1, default: 0.5 } },
  });

const impl = (id: string): EffectDefinition =>
  defineEffect(meta(id), {
    create: () => ({ resize() {}, frame() {} }),
  });

/** A deferred promise, to resolve loads in any order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((_resolve, _reject) => {
    resolve = _resolve;
    reject = _reject;
  });
  return { promise, resolve, reject };
}

describe("defineEffect", () => {
  it("joins the metadata with create", () => {
    const m = meta("a");
    const e = defineEffect(m, { create: () => ({ resize() {}, frame() {} }) });
    expect(e).toMatchObject({ id: "a", context: "webgl2", params: m.params });
    expect(typeof e.create).toBe("function");
  });

  it("types frame's params from the metadata", () => {
    const e = defineEffect(meta("a"), {
      create: () => ({
        resize() {},
        frame(_dt, p) {
          const speed: number = p.speed;
          // @ts-expect-error: not in the schema.
          void p.missing;
          void speed;
        },
      }),
    });
    expect(e.params.speed.default).toBe(0.5);
  });
});

describe("createEffectLoader", () => {
  it("shares one import between repeated and concurrent loads", async () => {
    const loadA = vi.fn<() => Promise<EffectDefinition>>(() => Promise.resolve(impl("a")));
    const entry: EffectEntry = { ...meta("a"), load: loadA };
    const loader = createEffectLoader();
    expect(loader.get("a")).toBeUndefined();
    const first = loader.load(entry);
    expect(loader.load(entry)).toBe(first);
    const effect = await first;
    expect(loader.load(entry)).toBe(first);
    expect(loader.get("a")).toBe(effect);
    expect(loadA).toHaveBeenCalledTimes(1);
  });

  it("drops a failed load so the next one retries", async () => {
    const loadA = vi
      .fn<() => Promise<EffectDefinition>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(impl("a"));
    const entry: EffectEntry = { ...meta("a"), load: loadA };
    const loader = createEffectLoader();
    await expect(loader.load(entry)).rejects.toThrow("offline");
    expect(loader.get("a")).toBeUndefined();
    await expect(loader.load(entry)).resolves.toMatchObject({ id: "a" });
    expect(loadA).toHaveBeenCalledTimes(2);
  });

  it("rejects an implementation whose id doesn't match its entry", async () => {
    const loader = createEffectLoader();
    const entry: EffectEntry = { ...meta("a"), load: () => Promise.resolve(impl("b")) };
    await expect(loader.load(entry)).rejects.toThrow(/"b" for "a"/);
    expect(loader.get("a")).toBeUndefined();
  });

  it("swallows prefetch failures", async () => {
    const loader = createEffectLoader();
    const entry: EffectEntry = { ...meta("a"), load: () => Promise.reject(new Error("x")) };
    loader.prefetch(entry);
    await Promise.resolve();
    await expect(loader.load(entry)).rejects.toThrow("x");
  });
});

describe("createLatest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes on only the latest request's result when loads finish out of order", async () => {
    const latest = createLatest<string>();
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();
    const results: string[] = [];
    const errors: unknown[] = [];
    for (const d of [a, b, c]) {
      latest.run(
        d.promise,
        (v) => {
          results.push(v);
        },
        (e) => {
          errors.push(e);
        },
      );
    }
    c.resolve("c");
    a.resolve("a");
    b.reject(new Error("b"));
    await Promise.allSettled([a.promise, b.promise, c.promise]);
    await Promise.resolve();
    expect(results).toEqual(["c"]);
    expect(errors).toEqual([]);
  });

  it("reports the latest request's error", async () => {
    const latest = createLatest<string>();
    const errors: unknown[] = [];
    const failure = new Error("gone");
    latest.run(
      Promise.reject(failure),
      () => {},
      (e) => {
        errors.push(e);
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([failure]);
  });

  it("drops everything in flight on cancel", async () => {
    const latest = createLatest<string>();
    const results: string[] = [];
    latest.run(
      Promise.resolve("a"),
      (v) => {
        results.push(v);
      },
      () => {},
    );
    latest.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
  });
});

describe("whenIdle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("falls back to a timeout without requestIdleCallback, and can be cancelled", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const task = vi.fn<() => void>();
    whenIdle(task);
    const cancel = whenIdle(task);
    cancel();
    vi.runAllTimers();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("uses requestIdleCallback where it exists", () => {
    const request = vi.fn<(cb: () => void) => number>(() => 7);
    const cancelIdle = vi.fn<(handle: number) => void>();
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", cancelIdle);
    const task = vi.fn<() => void>();
    whenIdle(task)();
    expect(request).toHaveBeenCalledWith(task, { timeout: 2000 });
    expect(cancelIdle).toHaveBeenCalledWith(7);
  });
});
