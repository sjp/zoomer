// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen } from "@testing-library/preact";
import { act } from "../test/act";
import { useLayoutEffect } from "preact/hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "../lib/store";
import { useExternalStore } from "./useExternalStore";

type Subscribe = Store<number>["subscribe"];

afterEach(() => {
  cleanup();
});

describe("useExternalStore", () => {
  it("returns the current value and follows changes", () => {
    const store = createStore(1);
    const { result } = renderHook(() => useExternalStore(store.subscribe, store.get));
    expect(result.current).toBe(1);
    act(() => {
      store.set(2);
    });
    expect(result.current).toBe(2);
  });

  it("re-renders only when the snapshot changes", () => {
    const store = createStore({ n: 1 });
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useExternalStore(store.subscribe, () => store.get().n);
    });
    const before = renders;
    act(() => {
      store.set({ n: 1 });
    });
    expect(renders).toBe(before);
    act(() => {
      store.set({ n: 2 });
    });
    expect(result.current).toBe(2);
    expect(renders).toBe(before + 1);
  });

  it("catches a change made between render and subscribe", () => {
    const store = createStore("first");
    function Probe() {
      const value = useExternalStore(store.subscribe, store.get);
      return <p>{value}</p>;
    }
    // Writer's layout effect runs after Probe renders but before it subscribes.
    function Writer() {
      useLayoutEffect(() => {
        store.set("second");
      }, []);
      return null;
    }
    render(
      <>
        <Writer />
        <Probe />
      </>,
    );
    expect(screen.getByText("second")).toBeTruthy();
  });

  it("re-subscribes when subscribe changes and unsubscribes on unmount", () => {
    const a = createStore(1);
    const b = createStore(10);
    const spied = (store: Store<number>) => {
      const unsubscribe = vi.fn<() => void>();
      const subscribe = vi.fn<Subscribe>((listener) => {
        const off = store.subscribe(listener);
        return () => {
          unsubscribe();
          off();
        };
      });
      return { subscribe, unsubscribe };
    };
    const spyA = spied(a);
    const spyB = spied(b);
    const { result, rerender, unmount } = renderHook<
      number,
      { store: Store<number>; subscribe: Subscribe }
    >(({ store, subscribe }) => useExternalStore(subscribe, store.get), {
      initialProps: { store: a, subscribe: spyA.subscribe },
    });
    expect(spyA.subscribe).toHaveBeenCalledTimes(1);
    rerender({ store: b, subscribe: spyB.subscribe });
    expect(result.current).toBe(10);
    expect(spyA.unsubscribe).toHaveBeenCalledTimes(1);
    expect(spyB.subscribe).toHaveBeenCalledTimes(1);
    act(() => {
      b.set(11);
    });
    expect(result.current).toBe(11);
    unmount();
    expect(spyB.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
