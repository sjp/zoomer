import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  EFFECT_SORTS,
  FAVOURITES_GROUP,
  categoryFilterLabel,
  effectGroup,
  isEffectSort,
  type EffectSort,
  type ListableEffect,
  type ListOptions,
} from "../effects/list";
import { EFFECT_CATEGORIES, type EffectCategory } from "../effects/types";
import { StarButton } from "./StarButton";

/** The heading for the effects below the favourites, in sorts without groups. */
const OTHERS_GROUP = "More effects";

/**
 * The categories a row shows: all of them, or under "By category", whose headings
 * already name the primary one, only the others.
 */
function categoryLabel(effect: ListableEffect, sort: EffectSort): string {
  return (sort === "category" ? effect.categories.slice(1) : effect.categories).join(" · ");
}

const NO_CATEGORIES: ReadonlySet<EffectCategory> = new Set();

const optionDomId = (uid: string, id: string) => `${uid}-option-${id}`;

export interface EffectListProps {
  /** The effects to show, already sorted and filtered by `options` (`visibleEffects`). */
  effects: readonly ListableEffect[];
  options: ListOptions & { query: string };
  currentId: string;
  /** Bumped to move focus back to the search box, e.g. when `/` is pressed again. */
  focusRequest: number;
  onSelect: (id: string) => void;
  /** Stars or unstars an effect. */
  onToggleFavourite: (id: string) => void;
  onQueryChange: (query: string) => void;
  /** Sets the category filter; an empty set lists every category. */
  onCategoriesChange: (categories: ReadonlySet<EffectCategory>) => void;
  onSortChange: (sort: EffectSort) => void;
  /** Starts loading an effect's code, when it's hovered or becomes active. */
  onPrefetch: (id: string) => void;
  onClose: () => void;
}

/**
 * The searchable effect list, as an ARIA combobox: focus stays in the search box and
 * ↑ / ↓ move the active option (`aria-activedescendant`), so screen readers announce
 * each option as it becomes active.
 *
 * Each row has a star for the pointer. Options mustn't contain interactive elements, so
 * the star is hidden from assistive technology and never takes focus; keyboard and
 * screen reader users star the active option with `*` in the search box (search ignores
 * punctuation, so the key isn't needed for typing), and the option says it's starred.
 *
 * Between the search box and the list, a group of category chips (toggle buttons)
 * narrows the list to effects in any of the pressed categories. The group is one Tab
 * stop (a roving tabindex): ← / → move between chips, Home / End go to the ends, and
 * the app's single-key shortcuts leave keys pressed in it alone (`data-own-keys`).
 * Esc clears the search, then the chips, then closes the list.
 */
export function EffectList(props: EffectListProps) {
  const { effects, options, currentId, onPrefetch } = props;
  const { query, sort, favourites } = options;
  const categories = options.categories ?? NO_CATEGORIES;
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionId = (id: string) => optionDomId(uid, id);
  const inputRef = useRef<HTMLInputElement>(null);
  // The option ↑ / ↓ or the pointer last picked. When it's filtered out, the active
  // option falls back to the current effect (or the top result while searching).
  const [activeId, setActiveId] = useState<string>();
  // Bumped to scroll the active option into view after it moves, e.g. when starred.
  const [scrollRequest, setScrollRequest] = useState(0);
  // Read out by the status region, in place of the count, after starring with `*`.
  const [announcement, setAnnouncement] = useState<string>();
  // The chip that takes the group's one Tab stop: the last one focused.
  const [chipIndex, setChipIndex] = useState(0);
  const chipRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const active =
    effects.find((e) => e.id === activeId) ??
    (query !== "" ? undefined : effects.find((e) => e.id === currentId)) ??
    effects.at(0);

  useEffect(() => {
    inputRef.current?.focus();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- focusRequest is a counter whose only job is to re-run this effect
  }, [props.focusRequest]);

  useEffect(() => {
    if (active) {
      document.getElementById(optionDomId(uid, active.id))?.scrollIntoView({ block: "nearest" });
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- scrollRequest is a counter whose only job is to re-run this effect after starring
  }, [active, uid, scrollRequest]);

  const activate = (effect: ListableEffect | undefined) => {
    if (!effect) {
      return;
    }
    setActiveId(effect.id);
    onPrefetch(effect.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const i = active ? effects.indexOf(active) : -1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activate(effects[Math.min(i + 1, effects.length - 1)]);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activate(effects[Math.max(i - 1, 0)]);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      activate(effects[Math.min(i + 8, effects.length - 1)]);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      activate(effects[Math.max(i - 8, 0)]);
    } else if (e.key === "*") {
      e.preventDefault();
      if (!active) {
        return;
      }
      const starred = favourites?.has(active.id) ?? false;
      props.onToggleFavourite(active.id);
      setAnnouncement(
        `${starred ? "Removed" : "Added"} ${active.name} ${starred ? "from" : "to"} favourites`,
      );
      setScrollRequest((n) => n + 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active) {
        props.onSelect(active.id);
      }
    } else if (e.key === "Escape") {
      // A search input clears itself on Esc in some browsers; do it here instead.
      e.preventDefault();
      escape();
    }
  };

  /** Esc: clears the search, then the category filter, then closes the list. */
  const escape = () => {
    if (query !== "") {
      changeQuery("");
    } else if (categories.size > 0) {
      changeCategories(new Set());
    } else {
      props.onClose();
    }
  };

  const changeQuery = (next: string) => {
    setActiveId(undefined);
    setAnnouncement(undefined);
    props.onQueryChange(next);
  };

  const changeCategories = (next: ReadonlySet<EffectCategory>) => {
    setActiveId(undefined);
    setAnnouncement(undefined);
    props.onCategoriesChange(next);
  };

  const toggleCategory = (category: EffectCategory) => {
    const next = new Set(categories);
    if (!next.delete(category)) {
      next.add(category);
    }
    changeCategories(next);
  };

  const filterLabel = categoryFilterLabel(categories);
  const countText = `${effects.length === 1 ? "1 effect" : `${String(effects.length)} effects`}${
    filterLabel !== "" ? ` in ${filterLabel}` : ""
  }`;

  // Consecutive effects with the same heading form a group. Below the favourites, the
  // rest get a heading too when the sort has no groups of its own.
  const groups: { heading: string | undefined; items: ListableEffect[] }[] = [];
  for (const effect of effects) {
    const heading =
      effectGroup(effect, options) ??
      (groups[0]?.heading === FAVOURITES_GROUP ? OTHERS_GROUP : undefined);
    const last = groups.at(-1);
    if (last && last.heading === heading) {
      last.items.push(effect);
    } else {
      groups.push({ heading, items: [effect] });
    }
  }

  const renderOption = (effect: ListableEffect): ReactNode => {
    const isActive = effect === active;
    const isCurrent = effect.id === currentId;
    const isFavourite = favourites?.has(effect.id) ?? false;
    return (
      <div
        key={effect.id}
        id={optionId(effect.id)}
        role="option"
        aria-selected={isActive}
        className="effect-option"
        data-active={isActive}
        data-current={isCurrent}
        data-favourite={isFavourite}
        onPointerEnter={() => {
          activate(effect);
        }}
        // Keep focus in the search box.
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          props.onSelect(effect.id);
        }}
      >
        <span className="effect-option-name">
          {effect.name}
          {isFavourite && <span className="sr-only">, starred</span>}
          {isCurrent && <span className="sr-only"> (current)</span>}
        </span>
        {categoryLabel(effect, sort) !== "" && (
          <span className="effect-option-category">{categoryLabel(effect, sort)}</span>
        )}
        {/* For the pointer only: see the component's doc comment. */}
        <StarButton
          className="effect-option-star"
          starred={isFavourite}
          name={effect.name}
          hidden
          onToggle={() => {
            props.onToggleFavourite(effect.id);
          }}
        />
        <span className="effect-option-description">{effect.description}</span>
      </div>
    );
  };

  return (
    <section className="effect-list" aria-label="Choose an effect">
      <div className="effect-list-controls">
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-label="Search effects"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-describedby={`${uid}-star-help`}
          aria-activedescendant={active ? optionId(active.id) : undefined}
          placeholder="Search effects"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            changeQuery(e.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <select
          aria-label="Sort effects"
          value={sort}
          onChange={(e) => {
            if (isEffectSort(e.target.value)) {
              props.onSortChange(e.target.value);
            }
          }}
        >
          {Object.entries(EFFECT_SORTS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div
        role="group"
        aria-label="Filter by category"
        className="category-chips"
        data-own-keys
        onKeyDown={(e) => {
          const last = EFFECT_CATEGORIES.length - 1;
          const to =
            e.key === "ArrowRight"
              ? Math.min(chipIndex + 1, last)
              : e.key === "ArrowLeft"
                ? Math.max(chipIndex - 1, 0)
                : e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? last
                    : undefined;
          if (to !== undefined) {
            e.preventDefault();
            setChipIndex(to);
            chipRefs.current[to]?.focus();
          } else if (e.key === "Escape") {
            e.preventDefault();
            escape();
          }
        }}
      >
        {EFFECT_CATEGORIES.map((category, i) => (
          <button
            key={category}
            ref={(el) => {
              chipRefs.current[i] = el;
            }}
            type="button"
            className="category-chip"
            aria-pressed={categories.has(category)}
            tabIndex={i === chipIndex ? 0 : -1}
            onFocus={() => {
              setChipIndex(i);
            }}
            onClick={() => {
              toggleCategory(category);
            }}
          >
            {category}
          </button>
        ))}
      </div>
      <p id={`${uid}-star-help`} className="sr-only">
        Press * to star or unstar the highlighted effect.
      </p>
      <p className="sr-only" role="status">
        {announcement ?? countText}
      </p>
      {query.trim() === "" &&
        categories.size === 0 &&
        !effects.some((e) => favourites?.has(e.id) === true) && (
          <p className="hint effect-list-hint">Star effects to keep them at the top</p>
        )}
      <div id={listboxId} role="listbox" aria-label="Effects" className="effect-listbox">
        {groups.map((group, g) =>
          group.heading === undefined ? (
            group.items.map(renderOption)
          ) : (
            <div
              key={`${String(g)}-${group.heading}`}
              role="group"
              aria-labelledby={`${uid}-group-${String(g)}`}
            >
              <div id={`${uid}-group-${String(g)}`} role="presentation" className="effect-group">
                {group.heading}
              </div>
              {group.items.map(renderOption)}
            </div>
          ),
        )}
      </div>
      {effects.length === 0 && (
        <div className="effect-empty">
          <p>
            No effects
            {query.trim() !== "" && <> match “{query.trim()}”</>}
            {filterLabel !== "" && <> in {filterLabel}</>}.
          </p>
          <button
            type="button"
            onClick={() => {
              changeQuery("");
              changeCategories(new Set());
              inputRef.current?.focus();
            }}
          >
            {filterLabel !== "" ? "Clear filters" : "Clear search"}
          </button>
        </div>
      )}
    </section>
  );
}
