// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ListableEffect } from "../effects/list";
import { EffectList, type EffectListProps } from "./EffectList";

const effect = (id: string, category: ListableEffect["category"] = "Abstract"): ListableEffect => ({
  id,
  name: id.toUpperCase(),
  description: `The ${id} effect`,
  category,
  tags: [],
  cost: "low",
});
/** Twelve effects, so PageUp / PageDown (8 rows) stop at either end. */
const ALL = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((id) => effect(id));

beforeAll(() => {
  // happy-dom lays nothing out, so it has no scrollIntoView.
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  cleanup();
});

function renderList(overrides: Partial<EffectListProps> = {}) {
  const props: EffectListProps = {
    effects: ALL,
    options: { sort: "featured", query: "", favourites: new Set() },
    currentId: "c",
    focusRequest: 0,
    onSelect: vi.fn<(id: string) => void>(),
    onToggleFavourite: vi.fn<(id: string) => void>(),
    onQueryChange: vi.fn<(q: string) => void>(),
    onSortChange: vi.fn<EffectListProps["onSortChange"]>(),
    onPrefetch: vi.fn<(id: string) => void>(),
    onClose: vi.fn<() => void>(),
    ...overrides,
  };
  const view = render(<EffectList {...props} />);
  const input = screen.getByLabelText<HTMLInputElement>("Search effects");
  const activeName = () => {
    const id = input.getAttribute("aria-activedescendant");
    return id === null
      ? undefined
      : document.getElementById(id)?.querySelector(".effect-option-name")?.firstChild?.textContent;
  };
  const key = (k: string) => fireEvent.keyDown(input, { key: k });
  return { props, view, input, activeName, key };
}

describe("EffectList", () => {
  it("focuses the search box and starts on the current effect", () => {
    const { input, activeName } = renderList();
    expect(document.activeElement).toBe(input);
    expect(activeName()).toBe("C");
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(12);
  });

  it("moves the active option with the arrow and page keys, clamped at the ends", () => {
    const { activeName, key, props } = renderList();
    key("ArrowDown");
    expect(activeName()).toBe("D");
    expect(props.onPrefetch).toHaveBeenLastCalledWith("d");
    key("ArrowUp");
    key("ArrowUp");
    expect(activeName()).toBe("B");
    key("PageDown");
    expect(activeName()).toBe("J");
    key("PageDown");
    expect(activeName()).toBe("L");
    key("PageUp");
    expect(activeName()).toBe("D");
    key("PageUp");
    expect(activeName()).toBe("A");
    key("ArrowUp");
    expect(activeName()).toBe("A");
  });

  it("marks only the active option selected", () => {
    const { key } = renderList();
    key("ArrowDown");
    const selected = screen
      .getAllByRole("option")
      .filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected.map((o) => o.id)).toEqual([
      screen.getByLabelText("Search effects").getAttribute("aria-activedescendant"),
    ]);
  });

  it("selects the active option with Enter", () => {
    const { key, props } = renderList();
    key("ArrowDown");
    key("Enter");
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("d");
  });

  it("clears the search with Esc, then closes", () => {
    const withQuery = renderList({
      options: { sort: "featured", query: "x", favourites: new Set() },
    });
    withQuery.key("Escape");
    expect(withQuery.props.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(withQuery.props.onClose).not.toHaveBeenCalled();
    cleanup();
    const empty = renderList();
    empty.key("Escape");
    expect(empty.props.onClose).toHaveBeenCalledTimes(1);
  });

  it("stars the active option with * and announces it", () => {
    const { key, props } = renderList();
    key("*");
    expect(props.onToggleFavourite).toHaveBeenCalledExactlyOnceWith("c");
    expect(screen.getByRole("status").textContent).toBe("Added C to favourites");
    cleanup();
    const starred = renderList({
      options: { sort: "featured", query: "", favourites: new Set(["c"]) },
    });
    starred.key("*");
    expect(screen.getByRole("status").textContent).toBe("Removed C from favourites");
  });

  it("shows the star hint only without favourites or a search", () => {
    const hint = "Star effects to keep them at the top";
    renderList();
    expect(screen.queryByText(hint)).not.toBeNull();
    cleanup();
    renderList({ options: { sort: "featured", query: "", favourites: new Set(["a"]) } });
    expect(screen.queryByText(hint)).toBeNull();
    cleanup();
    renderList({ options: { sort: "featured", query: "a", favourites: new Set() } });
    expect(screen.queryByText(hint)).toBeNull();
  });

  it("reports search and sort changes", () => {
    const { input, props } = renderList();
    fireEvent.change(input, { target: { value: "sea" } });
    expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith("sea");
    fireEvent.change(screen.getByLabelText("Sort effects"), { target: { value: "az" } });
    expect(props.onSortChange).toHaveBeenCalledExactlyOnceWith("az");
  });

  it("offers to clear a search with no matches", () => {
    const { props } = renderList({
      effects: [],
      options: { sort: "featured", query: "zzz", favourites: new Set() },
    });
    expect(screen.getByText("No effects match “zzz”.")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear search"));
    expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("selects an option on click", () => {
    const { props } = renderList();
    fireEvent.click(screen.getByText("F"));
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("f");
  });
});
