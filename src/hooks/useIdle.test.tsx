// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIdle } from "./useIdle";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useIdle", () => {
  it("goes idle after ms without activity", () => {
    const { result } = renderHook(() => useIdle(1000));
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current).toBe(false);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(true);
  });

  it.each(["pointermove", "pointerdown", "keydown", "wheel"])(
    "wakes on %s and restarts",
    (type) => {
      const { result } = renderHook(() => useIdle(1000));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current).toBe(true);
      act(() => {
        window.dispatchEvent(new Event(type));
      });
      expect(result.current).toBe(false);
      act(() => {
        vi.advanceTimersByTime(600);
        window.dispatchEvent(new Event(type));
        vi.advanceTimersByTime(600);
      });
      expect(result.current).toBe(false);
      act(() => {
        vi.advanceTimersByTime(400);
      });
      expect(result.current).toBe(true);
    },
  );

  it("with startIdle, is idle from the start until the first activity", () => {
    const { result } = renderHook(() => useIdle(1000, true));
    expect(result.current).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("pointermove"));
    });
    expect(result.current).toBe(false);
  });

  it("stops listening on unmount", () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useIdle(1000));
    unmount();
    const types = remove.mock.calls.map(([type]) => type);
    expect(types).toEqual(
      expect.arrayContaining(["pointermove", "pointerdown", "keydown", "wheel"]),
    );
  });
});
