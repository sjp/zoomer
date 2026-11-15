// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffect } from "../effects/registry";
import { defaults } from "../effects/params";
import { createStore } from "../lib/store";
import type { FrameStats } from "../lib/renderLoop";
import { defined } from "../test/defined";
import { mockMedia } from "../test/media";
import { ControlPanel } from "./ControlPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

const warp = (() => {
  const e = getEffect("warp");
  if (!e) {
    throw new Error("warp is not registered");
  }
  return e;
})();

type Props = ComponentProps<typeof ControlPanel>;

function renderPanel(overrides: Partial<Props> = {}) {
  const props: Props = {
    list: renderPanelList(),
    effect: warp,
    values: defaults(warp.params),
    loading: false,
    canRecord: true,
    resolution: "window",
    frameRate: "display",
    stats: createStore<FrameStats | undefined>(undefined),
    recordingLeft: undefined,
    onEffectChange: vi.fn<(id: string) => void>(),
    onParamChange: vi.fn<Props["onParamChange"]>(),
    onReset: vi.fn<() => void>(),
    onResolutionChange: vi.fn<Props["onResolutionChange"]>(),
    onFrameRateChange: vi.fn<Props["onFrameRateChange"]>(),
    onRecord: vi.fn<(s: number) => void>(),
    onFullscreen: vi.fn<() => void>(),
    onCopyLink: vi.fn<() => void>(),
    onHide: vi.fn<() => void>(),
    ...overrides,
  };
  render(<ControlPanel {...props} />);
  return props;
}

describe("ControlPanel", () => {
  it("builds a control for every param and reports changes by key", () => {
    const props = renderPanel();
    expect(screen.getAllByRole("slider").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByRole("slider", { name: /^Speed/ }), { target: { value: "2" } });
    expect(props.onParamChange).toHaveBeenCalledExactlyOnceWith("speed", 2);
  });

  it("resets one param to its default", () => {
    const props = renderPanel({ values: { ...defaults(warp.params), speed: 2 } });
    expect(
      screen.getAllByRole("button", { name: /^Reset / }).map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Reset Speed"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset Speed" }));
    expect(props.onParamChange).toHaveBeenCalledExactlyOnceWith("speed", warp.params.speed.default);
  });

  it("records a clip of the chosen length", () => {
    const props = renderPanel();
    fireEvent.change(screen.getByLabelText("Clip length"), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Record clip" }));
    expect(props.onRecord).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("locks the picker, resolution and clip length while recording, but not fullscreen", () => {
    renderPanel({ recordingLeft: 12, list: { ...renderPanelList(), open: true } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Effect: / }).disabled).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLSelectElement>("Resolution").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>("Clip length").disabled).toBe(true);
    expect(screen.getByRole("button", { name: "Recording… 12s" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Fullscreen" }).disabled).toBe(
      false,
    );
    // An open list closes while recording.
    expect(screen.queryByLabelText("Search effects")).toBeNull();
  });

  it("keeps output and recording in a section that starts closed and remembers its state", () => {
    renderPanel();
    const section = () => defined(document.querySelector("details"), "the output section");
    expect(section().open).toBe(false);
    expect(section().querySelector("summary")?.textContent).toBe("Output & recording");
    for (const control of [
      screen.getByLabelText("Resolution"),
      screen.getByLabelText("Frame rate"),
      screen.getByLabelText("Clip length"),
      screen.getByRole("button", { name: "Record clip" }),
    ]) {
      expect(section().contains(control)).toBe(true);
    }
    // As a click on the summary does.
    section().open = true;
    fireEvent(section(), new Event("toggle"));
    cleanup();
    renderPanel();
    expect(section().open).toBe(true);
    section().open = false;
    fireEvent(section(), new Event("toggle"));
    cleanup();
    renderPanel();
    expect(section().open).toBe(false);
  });

  it("shows the frame rate meter in the header", () => {
    const stats = createStore<FrameStats | undefined>({
      fps: 59.6,
      frameMs: 4,
      source: "gpu",
      displayMs: 1000 / 60,
    });
    renderPanel({ stats });
    const meter = defined(document.querySelector(".fps-meter"), "the meter");
    expect(meter.closest("header")).toBeTruthy();
    expect(meter.textContent).toBe("60 fps4.0 ms");
    expect(meter.getAttribute("title")).toMatch(/GPU time/);
  });

  it("can't record before the selected effect runs", () => {
    renderPanel({ canRecord: false, loading: true });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Record clip" }).disabled).toBe(
      true,
    );
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows a closed list's search as a hint with a Clear button", () => {
    const list = { ...renderPanelList(), options: { sort: "featured" as const, query: " sea " } };
    renderPanel({ list });
    expect(screen.getByText(/step through 1 match for “sea”/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(list.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(list.onCategoriesChange).toHaveBeenCalledExactlyOnceWith(new Set());
  });

  it("includes a closed list's category filter in the hint", () => {
    const list = {
      ...renderPanelList(),
      options: {
        sort: "featured" as const,
        query: "",
        categories: new Set(["Water", "Space"] as const),
      },
    };
    renderPanel({ list });
    expect(screen.getByText(/step through 1 match in Space or Water/)).toBeTruthy();
    cleanup();
    renderPanel({ list: { ...list, options: { ...list.options, query: "sea" } } });
    expect(screen.getByText(/step through 1 match for “sea” in Space or Water/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(list.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(list.onCategoriesChange).toHaveBeenCalledExactlyOnceWith(new Set());
  });

  it("shows keyboard shortcuts where the pointer can hover, and not on touch screens", () => {
    renderPanel();
    expect(screen.getByText(/S star · H hide/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide" }).title).toBe("Hide controls (H)");
    expect(screen.getByRole("button", { name: /^Add Warp/ }).title).toMatch(/\(S\)$/);
    cleanup();
    mockMedia(["(hover: none)"]);
    renderPanel();
    expect(screen.queryByText(/S star · H hide/)).toBeNull();
    expect(screen.getByRole("button", { name: "Hide" }).title).toBe("Hide controls");
    expect(screen.getByRole("button", { name: "Fullscreen" }).title).toBe("Fullscreen");
    expect(screen.getByRole("button", { name: /^Effect: / }).title).toBe("Choose an effect");
    expect(screen.getByRole("button", { name: /^Add Warp/ }).title).not.toMatch(/\(S\)$/);
  });

  it("leaves the Fullscreen button out when fullscreen isn't offered", () => {
    renderPanel({ onFullscreen: undefined });
    expect(screen.queryByRole("button", { name: "Fullscreen" })).toBeNull();
  });

  it("shows an error, with a reload button when one is offered", () => {
    const onReload = vi.fn<() => void>();
    renderPanel({ error: "This effect failed to load: offline", onReload });
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it.each([
    // 6 ms on a 120 Hz display is within budget; 10 ms misses every other refresh.
    ["display", 6, 1000 / 120, "ok"],
    ["display", 7, 1000 / 120, "warn"],
    ["display", 10, 1000 / 120, "bad"],
    ["display", 10, 1000 / 60, "ok"],
    // A 30 fps cap allows 33 ms whatever the display.
    ["30", 20, 1000 / 120, "ok"],
  ] as const)(
    "meters frame rate %s at %d ms against the display interval",
    (frameRate, frameMs, displayMs, level) => {
      const stats = createStore<FrameStats | undefined>({
        fps: 120,
        frameMs,
        source: "gpu",
        displayMs,
      });
      renderPanel({ frameRate, stats });
      expect(document.querySelector(".fps-meter")?.getAttribute("data-level")).toBe(level);
    },
  );
});

function renderPanelList() {
  return {
    effects: [warp],
    options: { sort: "featured" as const, query: "", favourites: new Set<string>() },
    focusRequest: 0,
    open: false,
    onOpenChange: vi.fn<(open: boolean) => void>(),
    onQueryChange: vi.fn<(q: string) => void>(),
    onCategoriesChange: vi.fn<Props["list"]["onCategoriesChange"]>(),
    onSortChange: vi.fn<Props["list"]["onSortChange"]>(),
    onPrefetch: vi.fn<(id: string) => void>(),
    onToggleFavourite: vi.fn<(id: string) => void>(),
  };
}
