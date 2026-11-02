import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlPanel } from "./components/ControlPanel";
import { EffectCanvas, type FrameStats } from "./components/EffectCanvas";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { defaults, encodeHash, stateFromHash } from "./effects/params";
import { effects, getEffect } from "./effects/registry";
import type { AnyParamValues, ParamValue } from "./effects/types";
import { useIdle } from "./hooks/useIdle";
import { download, recordCanvas } from "./lib/recorder";
import { FRAME_RATES, type FrameRate } from "./lib/frameRate";
import type { Resolution } from "./lib/resolution";
import { createStore } from "./lib/store";

function initialState() {
  const { effect, values } = stateFromHash(window.location.hash, effects);
  return { effectId: effect.id, values: { [effect.id]: values } };
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
  // A recording captures one canvas at one size, so switching effect (which can replace
  // the canvas) or resolution is locked until it finishes.
  const recording = recordingLeft !== undefined;
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

  // Follow hand edits and pasted links. The app's own replaceState writes don't fire
  // hashchange, and a hash that already matches the current state is skipped.
  const current = useRef({ effect, values, recording });
  useEffect(() => {
    current.current = { effect, values, recording };
  });
  useEffect(() => {
    const onHashChange = () => {
      const now = current.current;
      const hash = window.location.hash;
      if (hash === encodeHash(now.effect, now.values)) return;
      const next = stateFromHash(hash, effects);
      if (now.recording && next.effect.id !== now.effect.id) {
        // Switching effect would break the recording; put the current state back.
        window.history.replaceState(null, "", encodeHash(now.effect, now.values));
        return;
      }
      setEffectId(next.effect.id);
      setValuesById((prev) => ({ ...prev, [next.effect.id]: next.values }));
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

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
      if (recording) return;
      const i = effects.findIndex((e) => e.id === effect.id);
      setEffectId(effects[(i + dir + effects.length) % effects.length].id);
    },
    [effect, recording],
  );

  // A panel hidden under the pointer gets pointer-events: none, so pointerleave may never
  // fire; clear the hover flag here or the cursor would never idle out.
  const togglePanel = useCallback(() => {
    setPanelHidden((h) => !h);
    setHoveringPanel(false);
  }, []);
  const hidePanel = useCallback(() => {
    setPanelHidden(true);
    setHoveringPanel(false);
  }, []);
  const openPanel = useCallback(() => {
    setPanelHidden(false);
    setHoveringPanel(false);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isFormField(e.target)) return;
      if (e.key === "h" || e.key === "H") togglePanel();
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, togglePanel, toggleFullscreen]);

  const record = async (seconds: number) => {
    const canvas = canvasRef.current;
    if (!canvas || recording) return;
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

  const showPanel = !panelHidden && (!idle || hoveringPanel || recording);

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
        <PanelErrorBoundary>
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
            onHide={hidePanel}
          />
        </PanelErrorBoundary>
      </div>
      {/* The way back to a hidden panel without a keyboard: it fades in on any pointer or
          touch activity and out again with the idle cursor. */}
      <button
        type="button"
        className="show-panel"
        data-visible={panelHidden && !idle}
        aria-label="Show controls"
        title="Show controls (H)"
        onClick={openPanel}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </main>
  );
}
