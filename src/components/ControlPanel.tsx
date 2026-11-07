import { useRef, useState, useSyncExternalStore } from "react";
import type { AnyParamValues, EffectMeta, ParamValue } from "../effects/types";
import type { FrameStats } from "./EffectCanvas";
import { FRAME_RATES, type FrameRate } from "../lib/frameRate";
import { RESOLUTIONS, type Resolution } from "../lib/resolution";
import type { Store } from "../lib/store";
import { EffectList, type EffectListProps } from "./EffectList";
import { ParamControl } from "./ParamControl";
import { StarButton } from "./StarButton";
import { has } from "../effects/lookup";

const isResolution = (v: string): v is Resolution => has(RESOLUTIONS, v);
const isFrameRate = (v: string): v is FrameRate => has(FRAME_RATES, v);

/** The effect list's state, owned by the app because ← / → follow it too. */
export type EffectListState = Omit<EffectListProps, "currentId" | "onSelect" | "onClose"> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

interface Props {
  list: EffectListState;
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
  onFullscreen: () => void;
  /** Copies a link with every setting spelled out that opens with the panel hidden. */
  onCopyLink: () => void;
  onHide: () => void;
  /** Shown with the error when the effect's code failed to load, e.g. after a redeploy. */
  onReload?: (() => void) | undefined;
}

const DURATIONS = [10, 20, 30, 60];

export function ControlPanel(props: Props) {
  const { effect, values, recordingLeft, list } = props;
  const recording = recordingLeft !== undefined;
  const [duration, setDuration] = useState(20);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const listOpen = list.open && !recording;
  // The search stays applied after the list closes, because ← / → follow it.
  const filter = list.options.query.trim();
  const closeList = () => {
    list.onOpenChange(false);
    pickerRef.current?.focus();
  };

  return (
    <aside className="panel">
      <header className="panel-header">
        <button
          ref={pickerRef}
          type="button"
          className="effect-picker"
          aria-expanded={listOpen}
          disabled={recording}
          title={recording ? "Locked while recording" : "Choose an effect (/)"}
          onClick={() => {
            list.onOpenChange(!list.open);
          }}
        >
          <span className="sr-only">Effect: </span>
          {effect.name}
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <StarButton
          starred={list.options.favourites?.has(effect.id) ?? false}
          name={effect.name}
          titleSuffix=" (S)"
          onToggle={() => {
            list.onToggleFavourite(effect.id);
          }}
        />
        <button type="button" onClick={props.onHide} title="Hide controls (H)">
          Hide
        </button>
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
      {!listOpen && filter !== "" && (
        <p className="hint filter-hint">
          ← → step through {list.effects.length} {list.effects.length === 1 ? "match" : "matches"}{" "}
          for “{filter}”{" "}
          <button
            type="button"
            className="link-button"
            onClick={() => {
              list.onQueryChange("");
            }}
          >
            Clear
          </button>
        </p>
      )}
      <p className="description">{effect.description}</p>
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

      <section className="controls">
        {Object.entries(effect.params).map(([key, def]) => (
          <ParamControl
            key={`${effect.id}-${key}`}
            id={key}
            def={def}
            value={values[key] ?? def.default}
            onChange={(v) => {
              props.onParamChange(key, v);
            }}
          />
        ))}
      </section>

      <section className="output">
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
        <FpsMeter stats={props.stats} target={FRAME_RATES[props.frameRate].fps} />
        <div className="row">
          <select
            aria-label="Clip length"
            value={duration}
            disabled={recording}
            onChange={(e) => {
              setDuration(Number(e.target.value));
            }}
          >
            {DURATIONS.map((d) => (
              <option key={d} value={d}>
                {d}s
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={recording || !props.canRecord}
            title="Keep this tab visible while recording"
            onClick={() => {
              props.onRecord(duration);
            }}
          >
            {recording ? `Recording… ${String(recordingLeft)}s` : "Record clip"}
          </button>
        </div>
        {recording && (
          <p className="hint" role="status">
            Keep this tab visible until the recording finishes; hidden tabs make clips run long.
          </p>
        )}
      </section>

      <footer className="row">
        <button type="button" onClick={props.onReset}>
          Reset
        </button>
        <button type="button" onClick={props.onFullscreen} title="Fullscreen (F)">
          Fullscreen
        </button>
        <button
          type="button"
          onClick={props.onCopyLink}
          title="Copy a link with every setting, that opens with the controls hidden (for OBS browser sources)"
        >
          Copy link
        </button>
      </footer>
      <p className="hint">/ search · S star · H hide · F fullscreen · ← → switch effect</p>
    </aside>
  );
}

/**
 * Live performance readout. Frame time is the GPU cost of the effect's draw calls
 * where the browser supports timer queries, otherwise the CPU cost of issuing them;
 * it turns amber past 75% of the frame budget and red once over it.
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
  const budget = 1000 / (target ?? 60);
  const load = current.frameMs / budget;
  const level = load > 1 ? "bad" : load > 0.75 ? "warn" : "ok";
  return (
    <div
      className="fps-meter"
      data-level={level}
      title={
        current.source === "gpu"
          ? "Frames per second, and average GPU time each frame takes to draw"
          : "Frames per second, and average CPU time each frame takes to submit (GPU timing is unavailable in this browser)"
      }
    >
      <span>{Math.round(current.fps)} fps</span>
      <span>
        {current.frameMs.toFixed(1)} {current.source === "gpu" ? "GPU" : "CPU"} ms
      </span>
    </div>
  );
}
