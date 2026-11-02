import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlPanel } from "./components/ControlPanel";
import { EffectCanvas, type FrameStats } from "./components/EffectCanvas";
import { decodeHash, defaults, encodeHash, parseValues } from "./effects/params";
import { effects, getEffect } from "./effects/registry";
import type { AnyParamValues, ParamValue } from "./effects/types";
import { useIdle } from "./hooks/useIdle";
import { download, recordCanvas } from "./lib/recorder";
import { FRAME_RATES, type FrameRate } from "./lib/frameRate";
import type { Resolution } from "./lib/resolution";
import { createStore } from "./lib/store";

function initialState() {
  const { effectId, raw } = decodeHash(window.location.hash);
  const effect = getEffect(effectId) ?? effects[0];
  return { effectId: effect.id, values: { [effect.id]: parseValues(effect.params, raw) } };
}

/** How long the URL waits for params to settle before updating, in ms. */
const HASH_DEBOUNCE = 250;

const isFormField = (target: EventTarget | null) =>
  target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);

export function App() {
  const [initial] = useState(initialState);
  const [effectId, setEffectId] = useState(initial.effectId);
  const [valuesById, setValuesById] = useState<Record<string, AnyParamValues>>(initial.values);
  const [resolution, setResolution] = useState<Resolution>("window");
  const [frameRate, setFrameRate] = useState<FrameRate>("display");
  // Stats arrive a few times a second; a store re-renders only the meter, not the app.
  const [statsStore] = useState(() => createStore<FrameStats | undefined>(undefined));
  const [panelHidden, setPanelHidden] = useState(false);
  const [hoveringPanel, setHoveringPanel] = useState(false);
  const [recordingLeft, setRecordingLeft] = useState<number>();
  // Why the current effect failed to start or stopped; the canvas clears it on switch.
  const [effectError, setEffectError] = useState<string>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const idle = useIdle(3000);

  const effect = getEffect(effectId) ?? effects[0];
  const values = useMemo(
    () => valuesById[effect.id] ?? defaults(effect.params),
    [valuesById, effect],
  );

  // Debounced: dragging a slider changes params on every input event, and each
  // replaceState is an IPC round-trip that browsers throttle when called rapidly.
  useEffect(() => {
    const timer = setTimeout(
      () => window.history.replaceState(null, "", encodeHash(effect, values)),
      HASH_DEBOUNCE,
    );
    return () => clearTimeout(timer);
  }, [effect, values]);

  const setParam = useCallback(
    (key: string, value: ParamValue) =>
      setValuesById((prev) => ({
        ...prev,
        [effect.id]: { ...(prev[effect.id] ?? defaults(effect.params)), [key]: value },
      })),
    [effect],
  );

  const step = useCallback(
    (dir: number) => {
      const i = effects.findIndex((e) => e.id === effect.id);
      setEffectId(effects[(i + dir + effects.length) % effects.length].id);
    },
    [effect],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isFormField(e.target)) return;
      if (e.key === "h" || e.key === "H") setPanelHidden((h) => !h);
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, toggleFullscreen]);

  const record = async (seconds: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRecordingLeft(seconds);
    const countdown = setInterval(
      () => setRecordingLeft((s) => (s === undefined ? s : Math.max(0, s - 1))),
      1000,
    );
    try {
      const { blob, extension } = await recordCanvas(
        canvas,
        seconds,
        FRAME_RATES[frameRate].fps ?? 60,
      );
      download(blob, `zoomer-${effect.id}-${canvas.width}x${canvas.height}.${extension}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      clearInterval(countdown);
      setRecordingLeft(undefined);
    }
  };

  const showPanel = !panelHidden && (!idle || hoveringPanel || recordingLeft !== undefined);

  return (
    <main className="app" data-idle={idle && !hoveringPanel}>
      <EffectCanvas
        ref={canvasRef}
        effect={effect}
        params={values}
        resolution={resolution}
        frameRate={frameRate}
        onStats={statsStore.set}
        onError={setEffectError}
      />
      <div
        className="panel-wrap"
        data-visible={showPanel}
        onPointerEnter={() => setHoveringPanel(true)}
        onPointerLeave={() => setHoveringPanel(false)}
      >
        <ControlPanel
          effects={effects}
          effect={effect}
          values={values}
          error={effectError}
          resolution={resolution}
          frameRate={frameRate}
          stats={statsStore}
          recordingLeft={recordingLeft}
          onEffectChange={setEffectId}
          onParamChange={setParam}
          onReset={() =>
            setValuesById((prev) => ({ ...prev, [effect.id]: defaults(effect.params) }))
          }
          onResolutionChange={setResolution}
          onFrameRateChange={setFrameRate}
          onRecord={(s) => void record(s)}
          onFullscreen={toggleFullscreen}
          onHide={() => setPanelHidden(true)}
        />
      </div>
    </main>
  );
}
