// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/preact";
import { afterEach, describe, expect, it } from "vitest";
import { useKeyboardInset } from "./useKeyboardInset";

/** A visual viewport that can be moved and resized, as a keyboard or zoom would. */
class FakeViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
  scale = 1;
  set(changes: Partial<Pick<FakeViewport, "height" | "offsetTop" | "scale">>) {
    Object.assign(this, changes);
    this.dispatchEvent(new Event("resize"));
  }
}

function withViewport(viewport: FakeViewport | undefined) {
  Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
}

const inset = () => document.documentElement.style.getPropertyValue("--keyboard-inset");

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "visualViewport");
});

describe("useKeyboardInset", () => {
  it("tracks how much of the bottom the keyboard covers, and clears it when inactive", () => {
    const viewport = new FakeViewport();
    withViewport(viewport);
    const { rerender } = renderHook(
      ({ active }) => {
        useKeyboardInset(active);
      },
      {
        initialProps: { active: true },
      },
    );
    expect(inset()).toBe("0px");
    act(() => {
      viewport.set({ height: window.innerHeight - 300 });
    });
    expect(inset()).toBe("300px");
    // iOS can scroll the visual viewport down within the layout viewport too.
    act(() => {
      viewport.set({ offsetTop: 100 });
    });
    expect(inset()).toBe("200px");
    // Pinch zoom shrinks the visual viewport without any keyboard.
    act(() => {
      viewport.set({ scale: 2 });
    });
    expect(inset()).toBe("0px");
    rerender({ active: false });
    expect(inset()).toBe("");
  });

  it("does nothing without a visual viewport", () => {
    withViewport(undefined);
    renderHook(() => {
      useKeyboardInset(true);
    });
    expect(inset()).toBe("");
  });
});
