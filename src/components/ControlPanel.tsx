import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AnyParamValues, EffectMeta, ParamValue } from "../effects/types";
import type { FrameStats } from "./EffectCanvas";
import { FRAME_RATES, type FrameRate } from "../lib/frameRate";
import { RESOLUTIONS, type Resolution } from "../lib/resolution";
import type { Store } from "../lib/store";
import { Description } from "./Description";
import { EffectList, type EffectListProps } from "./EffectList";
import { categoryFilterLabel } from "../effects/list";
import { ParamSections, Section } from "./ParamSections";
import { Segmented } from "./ParamControl";
import { SheetHandle } from "./SheetHandle";
import { StarButton } from "./StarButton";
import { has } from "../effects/lookup";
import { useCanHover, type PanelLayout } from "../hooks/useMediaQuery";
import {
  loadClosedSections,
  loadOutputOpen,
  saveClosedSections,
  saveOutputOpen,
} from "../lib/preferences";

const isResolution = (v: string): v is Resolution => has(RESOLUTIONS, v);
const isFrameRate = (v: string): v is FrameRate => has(FRAME_RATES, v);

/** The effect list's state, owned by the app because ← / → follow it too. */
type EffectListState = Omit<EffectListProps, "currentId" | "onSelect" | "onClose"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

interface Props {
  list: EffectListState;
  /** A floating card (the default), a bottom sheet or a drawer: see `usePanelLayout`. */
  layout?: PanelLayout;
  effect: EffectMeta;
  values: AnyParamValues;
  /** Why the current effect failed to load or start, or stopped, if it did. */
  error?: string | undefined;
  /** Whether the selected effect's code is still loading. */
  loading: boolean;
  /** False while the canvas isn't running the selected effect yet. */
  canRecord: boolean;
  resolution: Resolution;
  frameRate: FrameRate;
  stats: Store<FrameStats | undefined>;
  recordingLeft: number | undefined;
  onEffectChange: (id: string) => void;
  onParamChange: (key: string, value: ParamValue) => void;
  onReset: () => void;
  onResolutionChange: (resolution: Resolution) => void;
  onFrameRateChange: (frameRate: FrameRate) => void;
  onRecord: (seconds: number) => void;
  /** Left out where the browser has no fullscreen for pages (iPhone Safari): no button. */
  onFullscreen?: (() => void) | undefined;
  /** Copies a link with every setting spelled out that opens with the panel hidden. */
  onCopyLink: () => void;
  onHide: () => void;
  /** Steps to the previous (-1) or next (1) effect in the list, as ← / → do. */
  onStep?: ((dir: 1 | -1) => void) | undefined;
  /** Shown with the error when the effect's code failed to load, e.g. after a redeploy. */
  onReload?: (() => void) | undefined;
}

const DURATIONS = [10, 20, 30, 60];

export function ControlPanel(props: Props) {
  const { effect, values, recordingLeft, list } = props;
  const recording = recordingLeft !== undefined;
  const [duration, setDuration] = useState(20);
  // Remembered per browser rather than in the link, which describes the effect only.
  const [outputOpen, setOutputOpen] = useState(() => loadOutputOpen());
  const [closedSections, setClosedSections] = useState(() => loadClosedSections());
  const toggleSection = (name: string) => {
    const next = new Set(closedSections);
    if (!next.delete(name)) {
      next.add(name);
    }
    setClosedSections(next);
    saveClosedSections(next);
  };
  const pickerRef = useRef<HTMLButtonElement>(null);
  // Keyboard shortcuts in tooltips and the hint line, left out on touch screens.
  const canHover = useCanHover();
  const shortcut = (k: string) => (canHover ? ` (${k})` : "");
  const listOpen = list.open && !recording;
  // The search and category filter stay applied after the list closes, because
  // ← / → follow them.
  const filter = list.options.query.trim();
  const categoryFilter = categoryFilterLabel(list.options.categories);
  const closeList = () => {
    list.onOpenChange(false);
    pickerRef.current?.focus();
  };

  const layout = props.layout ?? "float";
  const sheet = layout === "sheet";
  // On a phone the open list takes the whole sheet or drawer, and only it scrolls.
  const listFills = layout !== "float" && listOpen;
  // The bottom sheet: collapsed to a peek bar or expanded. An open list expands it.
  const [expanded, setExpanded] = useState(false);
  const sheetOpen = expanded || listOpen;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  // The peek bar's height is the header's, which depends on the font and the effect's
  // name; it's measured so the collapsed sheet can animate to it.
  const [peek, setPeek] = useState<number>();
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!sheet || !header) {
      return undefined;
    }
    const measure = () => {
      setPeek(header.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, [sheet]);
  const changeSheet = (open: boolean) => {
    setExpanded(open);
    if (!open && list.open) {
      list.onOpenChange(false);
    }
  };
  const sheetStyle: Record<string, string> = {};
  if (sheet && peek !== undefined) {
    sheetStyle["--peek-height"] = `${String(peek)}px`;
  }
  if (sheet && dragHeight !== null) {
    // Below the peek bar the whole sheet slides down with the finger, towards hiding.
    const floor = peek ?? 0;
    sheetStyle.height = `${String(Math.max(floor, dragHeight))}px`;
    if (dragHeight < floor) {
      sheetStyle.transform = `translateY(${String(floor - dragHeight)}px)`;
    }
  }

  // On a phone the header is the sheet's peek bar (or the drawer's top), so it keeps
  // to the picker, star, Record and Hide; a floating card has room for a toolbar.
  const compact = layout !== "float";
  const recordLabel = recording ? `Recording… ${String(recordingLeft)}s` : "Record clip";
  const recordButton = (
    <button
      type="button"
      className="record-button"
      disabled={recording || !props.canRecord}
      title="Keep this tab visible while recording"
      aria-label={compact || !recording ? recordLabel : undefined}
      onClick={() => {
        props.onRecord(duration);
      }}
    >
      {(!compact || !recording) && (
        <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
          <circle cx="5" cy="5" r="5" fill="currentColor" />
        </svg>
      )}
      {compact
        ? recording && `${String(recordingLeft)}s`
        : recording
          ? `Recording… ${String(recordingLeft)}s`
          : "Record"}
    </button>
  );
  const star = (
    <StarButton
      className="icon-button"
      starred={list.options.favourites?.has(effect.id) ?? false}
      name={effect.name}
      titleSuffix={shortcut("S")}
      onToggle={() => {
        list.onToggleFavourite(effect.id);
      }}
    />
  );
  const fps = <FpsMeter stats={props.stats} target={FRAME_RATES[props.frameRate].fps} />;
  const fullscreenButton = props.onFullscreen && (
    <button
      type="button"
      className="icon-button"
      aria-label="Fullscreen"
      title={`Fullscreen${shortcut("F")}`}
      onClick={props.onFullscreen}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M3 7.5V3h4.5M12.5 3H17v4.5M17 12.5V17h-4.5M7.5 17H3v-4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
  const copyLinkButton = (
    <button
      type="button"
      className="icon-button"
      aria-label="Copy link"
      title="Copy a link with every setting, that opens with the controls hidden (for OBS browser sources)"
      onClick={props.onCopyLink}
    >
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path
          d="M8.5 11.5a3.2 3.2 0 0 0 4.6 0l2.6-2.6a3.2 3.2 0 0 0-4.6-4.6l-1 1M11.5 8.5a3.2 3.2 0 0 0-4.6 0l-2.6 2.6a3.2 3.2 0 0 0 4.6 4.6l1-1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
  // ← / → as buttons. A phone has no arrow keys, but its header has room for these
  // only while the sheet is expanded (and not on the narrowest screens; see the CSS).
  const onStep = props.onStep;
  const stepButtons =
    onStep && (!compact || (sheet && sheetOpen)) ? (
      <div className="step-buttons">
        {(
          [
            [-1, "Previous effect", "←", "M12.5 4.5L7 10l5.5 5.5"],
            [1, "Next effect", "→", "M7.5 4.5L13 10l-5.5 5.5"],
          ] as const
        ).map(([dir, label, key, path]) => (
          <button
            key={dir}
            type="button"
            className="icon-button"
            aria-label={label}
            title={recording ? "Locked while recording" : `${label}${shortcut(key)}`}
            disabled={recording}
            onClick={() => {
              onStep(dir);
            }}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ))}
      </div>
    ) : null;

  return (
    <aside
      ref={panelRef}
      className="panel"
      data-sheet={
        sheet
          ? dragHeight !== null
            ? "dragging"
            : sheetOpen
              ? "expanded"
              : "collapsed"
          : undefined
      }
      data-list-fills={listFills}
      style={sheetStyle}
    >
      <header ref={headerRef} className="panel-header">
        {sheet && (
          <SheetHandle
            open={sheetOpen}
            onOpenChange={changeSheet}
            onDismiss={props.onHide}
            onDrag={setDragHeight}
            sheetHeight={() => panelRef.current?.getBoundingClientRect().height ?? 0}
          />
        )}
        <div className="panel-header-row">
          <button
            ref={pickerRef}
            type="button"
            className="effect-picker"
            aria-expanded={listOpen}
            disabled={recording}
            title={recording ? "Locked while recording" : `Choose an effect${shortcut("/")}`}
            onClick={() => {
              list.onOpenChange(!list.open);
            }}
          >
            <span className="sr-only">Effect: </span>
            <span className="effect-picker-name">{effect.name}</span>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
              <path
                d="M5 7.5l5 5 5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {stepButtons}
          {compact && star}
          {compact && recordButton}
          <button
            type="button"
            className="icon-button"
            aria-label="Hide controls"
            title={`Hide controls${shortcut("H")}`}
            onClick={props.onHide}
          >
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
              <path
                d={sheet ? "M5 5l5 5 5-5M5 11l5 5 5-5" : "M5 5l5 5-5 5M11 5l5 5-5 5"}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        {!compact && <Description key={effect.id} text={effect.description} clamp={false} />}
        {!compact && (
          <div className="panel-toolbar">
            {star}
            {copyLinkButton}
            {fullscreenButton}
            {fps}
            {recordButton}
          </div>
        )}
      </header>
      {listOpen && (
        <EffectList
          {...list}
          currentId={effect.id}
          onSelect={(id) => {
            props.onEffectChange(id);
            closeList();
          }}
          onClose={closeList}
        />
      )}
      {!listFills && (
        <>
          {!listOpen && (filter !== "" || categoryFilter !== "") && (
            <p className="hint filter-hint">
              ← → step through {list.effects.length}{" "}
              {list.effects.length === 1 ? "match" : "matches"}
              {filter !== "" && <> for “{filter}”</>}
              {categoryFilter !== "" && <> in {categoryFilter}</>}{" "}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  list.onQueryChange("");
                  list.onCategoriesChange(new Set());
                }}
              >
                Clear
              </button>
            </p>
          )}
          {compact && <Description key={effect.id} text={effect.description} clamp />}
          {recording && (
            <p className="hint" role="status">
              Keep this tab visible until the recording finishes; hidden tabs make clips run long.
            </p>
          )}
          {props.loading && (
            <p className="loading" role="status">
              Loading…
            </p>
          )}
          {props.error !== undefined && props.error !== "" && (
            <div className="effect-error" role="alert">
              <p>{props.error}</p>
              {props.onReload && (
                <button type="button" onClick={props.onReload}>
                  Reload page
                </button>
              )}
            </div>
          )}

          <ParamSections
            effectId={effect.id}
            schema={effect.params}
            values={values}
            closed={closedSections}
            onToggle={toggleSection}
            onParamChange={props.onParamChange}
          />

          <Section
            title="Output"
            open={outputOpen}
            onToggle={() => {
              setOutputOpen(!outputOpen);
              saveOutputOpen(!outputOpen);
            }}
          >
            <div className="controls">
              <div className="control control-inline">
                <label htmlFor="resolution">Resolution</label>
                <select
                  id="resolution"
                  value={props.resolution}
                  disabled={recording}
                  title={recording ? "Locked while recording" : undefined}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (isResolution(value)) {
                      props.onResolutionChange(value);
                    }
                  }}
                >
                  {Object.entries(RESOLUTIONS).map(([key, r]) => (
                    <option key={key} value={key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control control-inline">
                <label htmlFor="frame-rate">Frame rate</label>
                <select
                  id="frame-rate"
                  value={props.frameRate}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (isFrameRate(value)) {
                      props.onFrameRateChange(value);
                    }
                  }}
                >
                  {Object.entries(FRAME_RATES).map(([key, r]) => (
                    <option key={key} value={key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control">
                <span id="clip-length-label" className="control-label">
                  Clip length
                </span>
                <Segmented
                  labelledBy="clip-length-label"
                  options={DURATIONS.map((d) => ({ value: d, label: `${String(d)}s` }))}
                  value={duration}
                  onChange={setDuration}
                  disabled={recording}
                  title={recording ? "Locked while recording" : undefined}
                />
              </div>
            </div>
          </Section>

          <footer className="panel-footer">
            <div className="footer-actions">
              {/* Apart from the others and quieter, since it throws away every change. */}
              <button
                type="button"
                className="text-button"
                title="Put every setting of this effect back to its default"
                onClick={props.onReset}
              >
                Reset all
              </button>
              {compact && fps}
              {compact && fullscreenButton}
              {compact && copyLinkButton}
            </div>
            {canHover && (
              <p className="hint">/ search · S star · H hide · F fullscreen · ← → switch effect</p>
            )}
          </footer>
        </>
      )}
    </aside>
  );
}

/**
 * Live performance readout, a small badge in the header. Frame time is the GPU cost of the effect's draw calls
 * where the browser supports timer queries, otherwise the CPU cost of issuing them;
 * it turns amber past 75% of the frame budget and red once over it. The budget is the
 * display's refresh interval, or the capped rate's interval if that is longer.
 */
function FpsMeter({
  stats,
  target,
}: {
  stats: Store<FrameStats | undefined>;
  target: number | undefined;
}) {
  const current = useSyncExternalStore(stats.subscribe, stats.get);
  if (!current) {
    return null;
  }
  // "Match display" draws once per refresh, so the budget is the display's interval;
  // a cap can only lengthen it.
  const budget = Math.max(current.displayMs, target === undefined ? 0 : 1000 / target);
  const load = current.frameMs / budget;
  const level = load > 1 ? "bad" : load > 0.75 ? "warn" : "ok";
  return (
    <div
      className="fps-meter"
      data-level={level}
      title={`${
        current.source === "gpu"
          ? "Frames per second, and average GPU time each frame takes to draw"
          : "Frames per second, and average CPU time each frame takes to submit (GPU timing is unavailable in this browser)"
      }. Budget ${budget.toFixed(1)} ms a frame (display ≈ ${String(Math.round(1000 / current.displayMs))} Hz).`}
    >
      <span>{Math.round(current.fps)} fps</span>
      <span>{current.frameMs.toFixed(1)} ms</span>
    </div>
  );
}
