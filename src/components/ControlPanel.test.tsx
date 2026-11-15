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
    onStep: vi.fn<(dir: 1 | -1) => void>(),
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
      screen
        .getAllByRole("button", { name: /^Reset (?!all$)/ })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Reset Speed"]);
    fireEvent.click(screen.getByRole("button", { name: "Reset Speed" }));
    expect(props.onParamChange).toHaveBeenCalledExactlyOnceWith("speed", warp.params.speed.default);
  });

  it("records a clip of the chosen length", () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Output" }));
    const lengths = screen.getByRole("group", { name: "Clip length" });
    expect([...lengths.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "10s",
      "20s",
      "30s",
      "60s",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "30s" }));
    expect(screen.getByRole("button", { name: "30s" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Record clip" }));
    expect(props.onRecord).toHaveBeenCalledExactlyOnceWith(30);
  });

  it("locks the picker, resolution and clip length while recording, but not fullscreen", () => {
    renderPanel({ recordingLeft: 12, list: { ...renderPanelList(), open: true } });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /^Effect: / }).disabled).toBe(
      true,
    );
    expect(screen.getByLabelText<HTMLSelectElement>("Resolution").disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { hidden: true, name: "30s" }).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Recording… 12s" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Fullscreen" }).disabled).toBe(
      false,
    );
    // An open list closes while recording.
    expect(screen.queryByLabelText("Search effects")).toBeNull();
  });

  it("keeps output in a section that starts closed and remembers its state", () => {
    renderPanel();
    const toggle = () => screen.getByRole("button", { name: "Output" });
    const region = () =>
      defined(
        document.getElementById(toggle().getAttribute("aria-controls") ?? ""),
        "the output region",
      );
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(region().hidden).toBe(true);
    for (const control of [
      screen.getByLabelText("Resolution"),
      screen.getByLabelText("Frame rate"),
      screen.getByLabelText("Clip length"),
    ]) {
      expect(region().contains(control)).toBe(true);
    }
    fireEvent.click(toggle());
    expect(region().hidden).toBe(false);
    cleanup();
    renderPanel();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle());
    cleanup();
    renderPanel();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // Its own key, apart from the param sections'.
    expect(window.localStorage.getItem("zoomer.outputOpen")).toBe("closed");
  });

  it("shows grouped params in sections that remember being closed across effects", () => {
    const bokeh = defined(getEffect("bokeh"), "bokeh");
    renderPanel({ effect: bokeh, values: { ...defaults(bokeh.params), speed: 3, wander: 0.1 } });
    const headers = screen
      .getAllByRole("button", { expanded: true })
      .filter((b) => b.classList.contains("section-header"));
    expect(headers.map((b) => b.textContent)).toEqual(["Lights", "Motion2 changed", "Colours"]);
    // Output comes last.
    expect([...document.querySelectorAll(".section-header")].map((b) => b.textContent).at(-1)).toBe(
      "Output",
    );
    const motion = screen.getByRole("region", { name: "Motion" });
    expect(motion.contains(screen.getByRole("slider", { name: /^Drift speed/ }))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Colours" }));
    expect(screen.getByRole("button", { name: "Colours" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    cleanup();
    // Another effect's Colours section starts closed too.
    const aurora = defined(getEffect("aurora"), "aurora");
    renderPanel({ effect: aurora, values: defaults(aurora.params) });
    expect(screen.getByRole("button", { name: "Colours" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("still works when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    const bokeh = defined(getEffect("bokeh"), "bokeh");
    renderPanel({ effect: bokeh, values: defaults(bokeh.params) });
    fireEvent.click(screen.getByRole("button", { name: "Motion" }));
    expect(screen.getByRole("button", { name: "Motion" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Output" }));
    expect(screen.getByRole("button", { name: "Output" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
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

  it("puts Record in the header's toolbar beside the other actions", () => {
    const props = renderPanel();
    const record = screen.getByRole("button", { name: "Record clip" });
    expect(record.textContent).toBe("Record");
    const toolbar = defined(record.closest(".panel-toolbar"), "the toolbar");
    expect(toolbar.closest("header")).toBeTruthy();
    for (const name of [/^Add Warp/, "Copy link", "Fullscreen"]) {
      expect(toolbar.contains(screen.getByRole("button", { name }))).toBe(true);
    }
    fireEvent.click(record);
    expect(props.onRecord).toHaveBeenCalledExactlyOnceWith(20);
  });

  it("steps to the previous and next effect, except while recording", () => {
    const onStep = vi.fn<(dir: 1 | -1) => void>();
    renderPanel({ onStep });
    fireEvent.click(screen.getByRole("button", { name: "Previous effect" }));
    fireEvent.click(screen.getByRole("button", { name: "Next effect" }));
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
    cleanup();
    renderPanel({ onStep, recordingLeft: 5 });
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next effect" }).disabled).toBe(
      true,
    );
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
    expect(screen.getByRole("button", { name: "Hide controls" }).title).toBe("Hide controls (H)");
    expect(screen.getByRole("button", { name: "Next effect" }).title).toBe("Next effect (→)");
    expect(screen.getByRole("button", { name: /^Add Warp/ }).title).toMatch(/\(S\)$/);
    cleanup();
    mockMedia(["(hover: none)"]);
    renderPanel();
    expect(screen.queryByText(/S star · H hide/)).toBeNull();
    expect(screen.getByRole("button", { name: "Hide controls" }).title).toBe("Hide controls");
    expect(screen.getByRole("button", { name: "Fullscreen" }).title).toBe("Fullscreen");
    expect(screen.getByRole("button", { name: /^Effect: / }).title).toBe("Choose an effect");
    expect(screen.getByRole("button", { name: /^Add Warp/ }).title).not.toMatch(/\(S\)$/);
  });

  it("offers Reset all apart from the icon buttons, which keep their names", () => {
    const props = renderPanel();
    const fullscreen = screen.getByRole("button", { name: "Fullscreen" });
    const copy = screen.getByRole("button", { name: "Copy link" });
    expect(fullscreen.textContent).toBe("");
    expect(fullscreen.title).toBe("Fullscreen (F)");
    expect(copy.textContent).toBe("");
    expect(copy.title).toMatch(/^Copy a link/);
    fireEvent.click(copy);
    expect(props.onCopyLink).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(props.onReset).toHaveBeenCalledTimes(1);
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

describe("ControlPanel as a bottom sheet", () => {
  const sheetState = () => document.querySelector(".panel")?.getAttribute("data-sheet");
  const handle = () => screen.getByRole("button", { name: /^(Expand|Collapse) controls$/ });
  const drag = (from: number, to: number) => {
    const el = handle();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientY: from });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: (from + to) / 2 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: to });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: to });
    // The click a browser sends after the press: ignored after a drag.
    fireEvent.click(el, { detail: 1 });
  };

  it("has no handle as a floating card", () => {
    renderPanel();
    expect(screen.queryByRole("button", { name: "Expand controls" })).toBeNull();
    expect(sheetState()).toBeNull();
  });

  it("starts collapsed to its peek bar, with Record in it, and a tap on the handle expands it", () => {
    const props = renderPanel({ layout: "sheet" });
    expect(sheetState()).toBe("collapsed");
    expect(handle().getAttribute("aria-expanded")).toBe("false");
    const record = screen.getByRole("button", { name: "Record clip" });
    expect(record.closest("header")).toBeTruthy();
    // A dot alone, to leave the picker room.
    expect(record.textContent).toBe("");
    // Toolbar actions stay in the footer.
    expect(screen.getByRole("button", { name: "Copy link" }).closest("footer")).toBeTruthy();
    fireEvent.click(record);
    expect(props.onRecord).toHaveBeenCalledExactlyOnceWith(20);
    fireEvent.click(handle(), { detail: 1 });
    expect(sheetState()).toBe("expanded");
    expect(handle().getAttribute("aria-label")).toBe("Collapse controls");
    expect(handle().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(handle(), { detail: 0 });
    expect(sheetState()).toBe("collapsed");
  });

  it("offers previous and next only while expanded", () => {
    renderPanel({ layout: "sheet", onStep: vi.fn<(dir: 1 | -1) => void>() });
    expect(screen.queryByRole("button", { name: "Next effect" })).toBeNull();
    fireEvent.click(handle(), { detail: 1 });
    expect(screen.getByRole("button", { name: "Next effect" }).closest("header")).toBeTruthy();
    cleanup();
    renderPanel({ layout: "drawer", onStep: vi.fn<(dir: 1 | -1) => void>() });
    expect(screen.queryByRole("button", { name: "Next effect" })).toBeNull();
  });

  it("follows a drag on the handle and snaps on release", () => {
    renderPanel({ layout: "sheet" });
    const el = handle();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientY: 700 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 600 });
    expect(sheetState()).toBe("dragging");
    expect(document.querySelector<HTMLElement>(".panel")?.style.height).toMatch(/px$/);
    fireEvent.pointerUp(el, { pointerId: 1, clientY: 600 });
    expect(sheetState()).toBe("expanded");
    // A short drag springs back.
    drag(600, 580);
    expect(sheetState()).toBe("expanded");
    drag(500, 700);
    expect(sheetState()).toBe("collapsed");
  });

  it("hides the panel when dragged down from the peek bar", () => {
    const props = renderPanel({ layout: "sheet" });
    drag(700, 800);
    expect(props.onHide).toHaveBeenCalledTimes(1);
  });

  it("ignores a cancelled drag", () => {
    renderPanel({ layout: "sheet" });
    const el = handle();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientY: 700 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 500 });
    fireEvent.pointerCancel(el, { pointerId: 1, clientY: 500 });
    expect(sheetState()).toBe("collapsed");
  });

  it("lets an open effect list take the whole expanded sheet", () => {
    const list = { ...renderPanelList(), open: true };
    renderPanel({ layout: "sheet", list });
    expect(sheetState()).toBe("expanded");
    expect(document.querySelector(".panel")?.getAttribute("data-list-fills")).toBe("true");
    expect(screen.getByLabelText("Search effects")).toBeTruthy();
    expect(document.querySelector(".description")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    // Collapsing the sheet closes the list.
    fireEvent.click(handle(), { detail: 1 });
    expect(list.onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("keeps the list beside the controls on a floating card", () => {
    renderPanel({ list: { ...renderPanelList(), open: true } });
    expect(document.querySelector(".panel")?.getAttribute("data-list-fills")).toBe("false");
    expect(document.querySelector(".description")).toBeTruthy();
  });
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
