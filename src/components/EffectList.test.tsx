// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ListableEffect } from "../effects/list";
import { EFFECT_CATEGORIES } from "../effects/types";
import { defined } from "../test/defined";
import { mockMedia } from "../test/media";
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
  vi.restoreAllMocks();
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
    const press = (key: string) => fireEvent.keyDown(document.activeElement ?? group, { key });
    expect(tabStops()).toEqual([chips[0]]);
    act(() => {
      chips[0]?.focus();
    });
    press("ArrowRight");
    expect(document.activeElement).toBe(chips[1]);
    expect(tabStops()).toEqual([chips[1]]);
    press("End");
    expect(document.activeElement).toBe(chips.at(-1));
    press("ArrowRight");
    expect(document.activeElement).toBe(chips.at(-1));
    press("ArrowLeft");
    expect(document.activeElement).toBe(chips.at(-2));
    press("Home");
    expect(document.activeElement).toBe(chips[0]);
    press("ArrowLeft");
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

  it("fades the ends of the chip row that have chips scrolled out past them", () => {
    renderList();
    const group = screen.getByRole("group", { name: "Filter by category" });
    const layout = (scrollLeft: number) => {
      Object.defineProperties(group, {
        clientWidth: { configurable: true, value: 300 },
        scrollWidth: { configurable: true, value: 900 },
        scrollLeft: { configurable: true, value: scrollLeft },
      });
      fireEvent.scroll(group);
    };
    const fades = () => [group.dataset.moreStart, group.dataset.moreEnd];
    // Nothing lays out in happy-dom, so the row starts out fitting.
    expect(fades()).toEqual(["false", "false"]);
    layout(0);
    expect(fades()).toEqual(["false", "true"]);
    layout(250);
    expect(fades()).toEqual(["true", "true"]);
    layout(600);
    expect(fades()).toEqual(["true", "false"]);
  });

  /** Lays the chip row out as `width` of a 900px row scrolled to `scrollLeft`. */
  function layoutChips(scrollLeft: number, width = 300) {
    const group = screen.getByRole("group", { name: "Filter by category" });
    Object.defineProperties(group, {
      clientWidth: { configurable: true, value: width },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, writable: true, value: scrollLeft },
    });
    fireEvent.scroll(group);
    return group;
  }
  const arrow = (dir: "left" | "right") =>
    screen.queryByRole("button", { name: `Scroll categories ${dir}` });

  it("shows an arrow at each end of the chip row with more chips beyond it", () => {
    renderList();
    expect([arrow("left"), arrow("right")]).toEqual([null, null]);
    layoutChips(0);
    expect(arrow("left")).toBeNull();
    expect(arrow("right")).toBeTruthy();
    layoutChips(250);
    expect(arrow("left")).toBeTruthy();
    expect(arrow("right")).toBeTruthy();
    layoutChips(600);
    expect(arrow("left")).toBeTruthy();
    expect(arrow("right")).toBeNull();
    // A row that fits has none.
    layoutChips(0, 900);
    expect([arrow("left"), arrow("right")]).toEqual([null, null]);
  });

  it("scrolls the chip row by most of its width, keeping focus in the search box", () => {
    renderList();
    const group = layoutChips(250);
    const scrollBy = vi.fn<(options: ScrollToOptions) => void>();
    group.scrollBy = scrollBy as unknown as typeof group.scrollBy;
    const search = screen.getByRole("combobox", { name: "Search effects" });
    const right = defined(arrow("right"), "the right arrow");
    expect(right.tabIndex).toBe(-1);
    expect(fireEvent.mouseDown(right)).toBe(false);
    fireEvent.click(right);
    fireEvent.click(defined(arrow("left"), "the left arrow"));
    expect(scrollBy.mock.calls).toEqual([
      [{ left: 240, behavior: "smooth" }],
      [{ left: -240, behavior: "smooth" }],
    ]);
    expect(document.activeElement).toBe(search);
  });

  it("jumps the chip row without smooth scrolling under reduced motion", () => {
    mockMedia(["(prefers-reduced-motion: reduce)"]);
    renderList();
    const group = layoutChips(0);
    const scrollBy = vi.fn<(options: ScrollToOptions) => void>();
    group.scrollBy = scrollBy as unknown as typeof group.scrollBy;
    fireEvent.click(defined(arrow("right"), "the right arrow"));
    expect(scrollBy).toHaveBeenCalledExactlyOnceWith({ left: 240, behavior: "auto" });
  });

  it("leaves the chip row to swiping on touch screens", () => {
    mockMedia(["(hover: none)"]);
    renderList();
    layoutChips(250);
    expect([arrow("left"), arrow("right")]).toEqual([null, null]);
  });

  it("scrolls the chip row sideways with a plain mouse wheel, until it reaches that end", () => {
    renderList();
    const group = layoutChips(250);
    const wheel = (init: WheelEventInit) => {
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
      group.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel({ deltaY: 100 })).toBe(true);
    expect(group.scrollLeft).toBe(350);
    expect(wheel({ deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE })).toBe(true);
    expect(group.scrollLeft).toBe(302);
    // Sideways deltas are left to the browser.
    expect(wheel({ deltaX: 40, deltaY: 10 })).toBe(false);
    expect(group.scrollLeft).toBe(302);
    // At an end the wheel passes through, to the list or the page.
    layoutChips(600);
    expect(wheel({ deltaY: 100 })).toBe(false);
    expect(wheel({ deltaY: -100 })).toBe(true);
    layoutChips(0);
    expect(wheel({ deltaY: -100 })).toBe(false);
    // As does a row that fits.
    layoutChips(0, 900);
    expect(wheel({ deltaY: 100 })).toBe(false);
  });

  it("scrolls a focused chip into view", () => {
    const scrolled = vi.spyOn(Element.prototype, "scrollIntoView");
    renderList();
    const chip = screen.getByRole("button", { name: EFFECT_CATEGORIES[5] });
    act(() => {
      chip.focus();
    });
    expect(scrolled.mock.contexts).toContain(chip);
    scrolled.mockRestore();
  });

  it("puts the sort under the chips beside a count, or beside the search", () => {
    renderList({ searchEnd: <button type="button">Close</button> });
    const searchRow = () => screen.getByRole("combobox", { name: "Search effects" }).parentElement;
    expect(screen.getByText("12 effects", { selector: "[aria-hidden]" })).toBeTruthy();
    expect(searchRow()?.contains(screen.getByRole("combobox", { name: "Sort effects" }))).toBe(
      false,
    );
    expect(searchRow()?.contains(screen.getByRole("button", { name: "Close" }))).toBe(true);
    cleanup();
    renderList({ sortBesideSearch: true });
    expect(searchRow()?.contains(screen.getByRole("combobox", { name: "Sort effects" }))).toBe(
      true,
    );
    expect(screen.queryByText("12 effects", { selector: "[aria-hidden]" })).toBeNull();
  });
});
