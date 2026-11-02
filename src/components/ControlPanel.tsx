import { useState, useSyncExternalStore } from "react";
import type { AnyParamValues, EffectDefinition, ParamValue } from "../effects/types";
import type { FrameStats } from "./EffectCanvas";
import { FRAME_RATES, type FrameRate } from "../lib/frameRate";
import { RESOLUTIONS, type Resolution } from "../lib/resolution";
import type { Store } from "../lib/store";
import { ParamControl } from "./ParamControl";

interface Props {
  effects: readonly EffectDefinition[];
  effect: EffectDefinition;
  values: AnyParamValues;
  /** Why the current effect failed to start or stopped, if it did. */
  error?: string;
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
  onHide: () => void;
}

const DURATIONS = [10, 20, 30, 60];

export function ControlPanel(props: Props) {
  const { effect, values, recordingLeft } = props;
  const [duration, setDuration] = useState(20);

  return (
    <aside className="panel">
      <header className="panel-header">
        <select
          className="effect-select"
          aria-label="Effect"
          value={effect.id}
          onChange={(e) => props.onEffectChange(e.target.value)}
        >
          {props.effects.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button type="button" onClick={props.onHide} title="Hide controls (H)">
          Hide
        </button>
      </header>
      <p className="description">{effect.description}</p>
      {props.error && (
        <p className="effect-error" role="alert">
          {props.error}
        </p>
      )}

      <section className="controls">
        {Object.entries(effect.params).map(([key, def]) => (
          <ParamControl
            key={`${effect.id}-${key}`}
            id={key}
            def={def}
            value={values[key] ?? def.default}
            onChange={(v) => props.onParamChange(key, v)}
          />
        ))}
      </section>

      <section className="output">
        <div className="control control-inline">
          <label htmlFor="resolution">Resolution</label>
          <select
            id="resolution"
            value={props.resolution}
            onChange={(e) => props.onResolutionChange(e.target.value as Resolution)}
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
            onChange={(e) => props.onFrameRateChange(e.target.value as FrameRate)}
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
            disabled={recordingLeft !== undefined}
            onChange={(e) => setDuration(Number(e.target.value))}
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
            disabled={recordingLeft !== undefined}
            onClick={() => props.onRecord(duration)}
          >
            {recordingLeft === undefined ? "Record clip" : `Recording… ${recordingLeft}s`}
          </button>
        </div>
      </section>

      <footer className="row">
        <button type="button" onClick={props.onReset}>
          Reset
        </button>
        <button type="button" onClick={props.onFullscreen} title="Fullscreen (F)">
          Fullscreen
        </button>
      </footer>
      <p className="hint">H hide · F fullscreen · ← → switch effect</p>
    </aside>
  );
}

/**
 * Live performance readout. Frame time is the CPU cost of the effect's draw call;
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
  if (!current) return null;
  const budget = 1000 / (target ?? 60);
  const load = current.frameMs / budget;
  const level = load > 1 ? "bad" : load > 0.75 ? "warn" : "ok";
  return (
    <div
      className="fps-meter"
      data-level={level}
      title="Frames per second, and average time each frame takes to draw"
    >
      <span>{Math.round(current.fps)} fps</span>
      <span>{current.frameMs.toFixed(1)} ms / frame</span>
    </div>
  );
}
