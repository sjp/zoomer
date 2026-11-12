// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Ref } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { defaults, encodeHash } from "./effects/params";
import { getEffect } from "./effects/registry";
import type { EffectEntry } from "./effects/loader";

// No WebGL here: a bare canvas stands in for the effect canvas.
vi.mock("./components/EffectCanvas", () => ({
  EffectCanvas: ({ ref }: { ref?: Ref<HTMLCanvasElement> }) => <canvas ref={ref} />,
}));

// A recording that runs until the test finishes it, at the asked-for length by default.
let finishRecording: ((seconds?: number) => void) | undefined;
let recordingProgress: ((seconds: number) => void) | undefined;
vi.mock("./lib/recorder", () => ({
  recordCanvas: (
    _canvas: unknown,
    seconds: number,
    _fps: unknown,
    _frames: unknown,
    onProgress?: (seconds: number) => void,
  ) =>
    new Promise((resolve) => {
      recordingProgress = onProgress;
      finishRecording = (length = seconds) => {
        resolve({ blob: new Blob(), extension: "mp4", seconds: length });
      };
    }),
  download: () => undefined,
}));

const entry = (id: string): EffectEntry => {
  const e = getEffect(id);
  if (!e) {
    throw new Error(`no effect ${id}`);
  }
  return e;
};
const WARP = entry("warp");
const SNOW = entry("snow");

/** Sets the hash without an event, as a page load would see it. */
function setHash(hash: string) {
  window.history.replaceState(null, "", hash === "" ? window.location.pathname : hash);
}
/** Changes the hash the way a hand edit or a pasted link does. */
function editHash(hash: string) {
  setHash(hash);
  act(() => {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
}
const pickerName = () =>
  screen.getByRole("button", { expanded: false, name: /^Effect: / }).textContent;
const press = (key: string, target: EventTarget = window) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
};
const panelVisible = () =>
  document.querySelector(".panel-wrap")?.getAttribute("data-visible") === "true";
/** Waits until the selected effect's code has loaded (recording needs it). */
const whenReady = () =>
  waitFor(() => {
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Record clip" }).disabled).toBe(
      false,
    );
  });

beforeAll(async () => {
  Element.prototype.scrollIntoView = () => undefined;
  // Load the effects' code up front: an import is module I/O, which fake time can't
  // move, so the app's own imports then resolve from the module cache.
  await Promise.all([WARP.load(), SNOW.load()]);
});
beforeEach(() => {
  window.localStorage.clear();
  setHash("");
  finishRecording = undefined;
  recordingProgress = undefined;
});
afterEach(() => {
  finishRecording?.();
  cleanup();
  vi.restoreAllMocks();
});

describe("App", () => {
  it("opens the effect and values a link names", () => {
    setHash(encodeHash(SNOW, { ...defaults(SNOW.params), speed: 2 }));
    render(<App />);
    expect(pickerName()).toContain(SNOW.name);
  });

  it("follows a hand-edited hash", async () => {
    render(<App />);
    expect(pickerName()).toContain(WARP.name);
    editHash(encodeHash(SNOW, defaults(SNOW.params), { panelHidden: true }));
    expect(pickerName()).toContain(SNOW.name);
    expect(panelVisible()).toBe(false);
    await whenReady();
  });

  it("writes param changes to the hash once they settle, without looping", () => {
    render(<App />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    const replace = vi.spyOn(window.history, "replaceState");
    const slider = screen.getByRole<HTMLInputElement>("slider", { name: /^Speed/ });
    fireEvent.change(slider, { target: { value: "3" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.change(slider, { target: { value: "4" } });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(replace.mock.calls.map((c) => c[2])).toEqual([
      encodeHash(WARP, { ...defaults(WARP.params), speed: 4 }),
    ]);
    // A hashchange for the app's own state changes nothing.
    editHash(window.location.hash);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(slider.value).toBe("4");
    expect(replace).toHaveBeenCalledTimes(2);
  });

  it("puts the hash back when a link would switch effect mid-recording", async () => {
    render(<App />);
    await whenReady();
    fireEvent.click(screen.getByRole("button", { name: "Record clip" }));
    expect(screen.getByRole("button", { name: /^Recording…/ })).toBeTruthy();
    const before = encodeHash(WARP, defaults(WARP.params));
    editHash(encodeHash(SNOW, defaults(SNOW.params)));
    expect(window.location.hash).toBe(before);
    expect(pickerName()).toContain(WARP.name);
    // ← / → and / are locked too.
    press("ArrowRight");
    press("/");
    expect(pickerName()).toContain(WARP.name);
    expect(screen.queryByLabelText("Search effects")).toBeNull();
    await act(async () => {
      finishRecording?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record clip" })).toBeTruthy();
    });
  });

  it("counts the recording down by its own clock", async () => {
    render(<App />);
    await whenReady();
    fireEvent.click(screen.getByRole("button", { name: "Record clip" }));
    expect(screen.getByRole("button", { name: "Recording… 20s" })).toBeTruthy();
    act(() => {
      recordingProgress?.(2.5);
    });
    expect(screen.getByRole("button", { name: "Recording… 18s" })).toBeTruthy();
    await act(async () => {
      finishRecording?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Record clip" })).toBeTruthy();
    });
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("says when a clip came out shorter than asked", async () => {
    render(<App />);
    await whenReady();
    fireEvent.click(screen.getByRole("button", { name: "Record clip" }));
    await act(async () => {
      finishRecording?.(3.2);
      await Promise.resolve();
    });
    expect(await screen.findByText(/stopped early, at 3\.2 s of 20 s/)).toBeTruthy();
  });

  it("H toggles the panel", () => {
    render(<App />);
    expect(panelVisible()).toBe(true);
    press("h");
    expect(panelVisible()).toBe(false);
    press("H");
    expect(panelVisible()).toBe(true);
  });

  it("F asks for fullscreen, and says so when refused", async () => {
    const request = vi.fn<() => Promise<void>>(() => Promise.reject(new Error("no")));
    document.documentElement.requestFullscreen = request;
    render(<App />);
    press("f");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Fullscreen unavailable")).toBeTruthy();
  });

  it("S stars the current effect with a toast", () => {
    render(<App />);
    press("s");
    expect(screen.getByRole("status", { name: "" }).textContent).toBe(
      `Added ${WARP.name} to favourites`,
    );
    press("S");
    expect(screen.getByText(`Removed ${WARP.name} from favourites`)).toBeTruthy();
  });

  it("/ opens the effect list with the search box focused", () => {
    render(<App />);
    press("/");
    expect(document.activeElement).toBe(screen.getByLabelText("Search effects"));
  });

  it("← and → step through the list", () => {
    render(<App />);
    press("ArrowRight");
    const next = pickerName();
    expect(next).not.toContain(WARP.name);
    press("ArrowLeft");
    expect(pickerName()).toContain(WARP.name);
  });

  it("ignores shortcuts typed into form fields and with modifiers", () => {
    render(<App />);
    const slider = screen.getByRole("slider", { name: /^Speed/ });
    press("h", slider);
    press("ArrowRight", slider);
    expect(panelVisible()).toBe(true);
    expect(pickerName()).toContain(WARP.name);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "h", ctrlKey: true }));
    });
    expect(panelVisible()).toBe(true);
  });
});
