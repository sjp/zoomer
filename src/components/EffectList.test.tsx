// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ListableEffect } from "../effects/list";
import { EFFECT_CATEGORIES } from "../effects/types";
import { EffectList, type EffectListProps } from "./EffectList";

const effect = (
  id: string,
  categories: ListableEffect["categories"] = ["Abstract"],
): ListableEffect => ({
  id,
  name: id.toUpperCase(),
  description: `The ${id} effect`,
  categories,
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
    onCategoriesChange: vi.fn<EffectListProps["onCategoriesChange"]>(),
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

  it("clears the search, then the category filter, with Esc, then closes", () => {
    const categories = new Set(["Water"] as const);
    const both = renderList({ options: { sort: "featured", query: "x", categories } });
    both.key("Escape");
    expect(both.props.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(both.props.onCategoriesChange).not.toHaveBeenCalled();
    cleanup();
    const filtered = renderList({ options: { sort: "featured", query: "", categories } });
    filtered.key("Escape");
    expect(filtered.props.onCategoriesChange).toHaveBeenCalledExactlyOnceWith(new Set());
    expect(filtered.props.onClose).not.toHaveBeenCalled();
    // Esc on a chip does the same.
    fireEvent.keyDown(screen.getByRole("button", { name: "Water" }), { key: "Escape" });
    expect(filtered.props.onCategoriesChange).toHaveBeenCalledTimes(2);
  });

  it("offers every category as a toggle chip in a labelled group", () => {
    const { props } = renderList({
      options: { sort: "featured", query: "", categories: new Set(["Water"]) },
    });
    const group = screen.getByRole("group", { name: "Filter by category" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual([...EFFECT_CATEGORIES]);
    const pressed = (name: string) =>
      within(group).getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Water")).toBe("true");
    expect(pressed("Space")).toBe("false");
    fireEvent.click(within(group).getByRole("button", { name: "Space" }));
    expect(props.onCategoriesChange).toHaveBeenLastCalledWith(new Set(["Water", "Space"]));
    fireEvent.click(within(group).getByRole("button", { name: "Water" }));
    expect(props.onCategoriesChange).toHaveBeenLastCalledWith(new Set());
  });

  it("makes the chips one Tab stop, moved with ← / →, Home and End", () => {
    renderList();
    const group = screen.getByRole("group", { name: "Filter by category" });
    const chips = within(group).getAllByRole("button");
    const tabStops = () => chips.filter((c) => c.tabIndex === 0);
    expect(tabStops()).toEqual([chips[0]]);
    act(() => {
      chips[0]?.focus();
    });
    fireEvent.keyDown(chips[0]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips[1]);
    expect(tabStops()).toEqual([chips[1]]);
    fireEvent.keyDown(chips[1]!, { key: "End" });
    expect(document.activeElement).toBe(chips.at(-1));
    fireEvent.keyDown(chips.at(-1)!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(chips.at(-1));
    fireEvent.keyDown(chips.at(-1)!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(chips.at(-2));
    fireEvent.keyDown(chips.at(-2)!, { key: "Home" });
    expect(document.activeElement).toBe(chips[0]);
    fireEvent.keyDown(chips[0]!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(chips[0]);
    // A chip focused by the pointer takes the Tab stop too.
    act(() => {
      chips[4]?.focus();
    });
    expect(tabStops()).toEqual([chips[4]]);
    // The app's shortcuts leave keys pressed in the group alone.
    expect(chips[4]?.closest("[data-own-keys]")).toBe(group);
  });

  it("announces the count with the category filter", () => {
    renderList({
      effects: ALL.slice(0, 3),
      options: { sort: "featured", query: "", categories: new Set(["Water", "Space"]) },
    });
    expect(screen.getByRole("status").textContent).toBe("3 effects in Space or Water");
  });

  it("shows every category on a row, and only the others when grouped by category", () => {
    const multi = effect("m", ["Cosy", "Water"]);
    renderList({ effects: [multi] });
    expect(document.querySelector(".effect-option-category")?.textContent).toBe("Cosy · Water");
    cleanup();
    renderList({ effects: [multi], options: { sort: "category", query: "" } });
    expect(document.querySelector(".effect-option-category")?.textContent).toBe("Water");
    cleanup();
    renderList({ effects: [effect("s")], options: { sort: "category", query: "" } });
    expect(document.querySelector(".effect-option-category")).toBeNull();
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

  it("offers to clear both the search and the category filter with no matches", () => {
    const { props } = renderList({
      effects: [],
      options: { sort: "featured", query: "zzz", categories: new Set(["Retro"]) },
    });
    expect(screen.getByText("No effects match “zzz” in Retro.")).toBeTruthy();
    fireEvent.click(screen.getByText("Clear filters"));
    expect(props.onQueryChange).toHaveBeenCalledExactlyOnceWith("");
    expect(props.onCategoriesChange).toHaveBeenCalledExactlyOnceWith(new Set());
  });

  it("selects an option on click", () => {
    const { props } = renderList();
    fireEvent.click(screen.getByText("F"));
    expect(props.onSelect).toHaveBeenCalledExactlyOnceWith("f");
  });
});
