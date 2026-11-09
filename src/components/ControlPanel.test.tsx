// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEffect } from "../effects/registry";
import { defaults } from "../effects/params";
import { createStore } from "../lib/store";
import type { FrameStats } from "../lib/renderLoop";
import { ControlPanel } from "./ControlPanel";

afterEach(() => {
  cleanup();
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
  });

  it("shows an error, with a reload button when one is offered", () => {
    const onReload = vi.fn<() => void>();
    renderPanel({ error: "This effect failed to load: offline", onReload });
    expect(screen.getByRole("alert").textContent).toContain("offline");
    fireEvent.click(screen.getByRole("button", { name: "Reload page" }));
    expect(onReload).toHaveBeenCalledTimes(1);
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
    onSortChange: vi.fn<Props["list"]["onSortChange"]>(),
    onPrefetch: vi.fn<(id: string) => void>(),
    onToggleFavourite: vi.fn<(id: string) => void>(),
  };
}
