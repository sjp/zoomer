import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ControlPanel } from "./components/ControlPanel";
import { EffectCanvas, type FrameStats } from "./components/EffectCanvas";
import { PanelErrorBoundary } from "./components/PanelErrorBoundary";
import { defaults, encodeHash, stateFromHash } from "./effects/params";
import { visibleEffects, type EffectSort } from "./effects/list";
import { createLatest, neighbours, whenIdle, type EffectEntry } from "./effects/loader";
import { defaultEffect, effectLoader, effects, getEffect } from "./effects/registry";
import type { AnyParamValues, EffectDefinition, ParamValue } from "./effects/types";
import { useIdle } from "./hooks/useIdle";
import { describeError } from "./lib/errors";
import { download, recordCanvas, type FrameSubscriber } from "./lib/recorder";
import { FRAME_RATES, type FrameRate } from "./lib/frameRate";
import { loadSort, saveSort } from "./lib/preferences";
import type { Resolution } from "./lib/resolution";
import { createStore } from "./lib/store";

function initialState() {
  const { effect, values } = stateFromHash(window.location.hash, effects, defaultEffect);
  return { effectId: effect.id, values: { [effect.id]: values } };
}

/** How long the URL waits for params to settle before updating, in ms. */
const HASH_DEBOUNCE = 250;
/** How long a toast stays up, in ms. */
const TOAST_MS = 2500;

const isFormField = (target: EventTarget | null) =>
  target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName);

export function App() {
  const [initial] = useState(initialState);
  // The selected effect. Its code may still be loading, in which case `running` (what the
  // canvas draws) is still the previous effect, or nothing on first load.
  const [effectId, setEffectId] = useState(initial.effectId);
  const [running, setRunning] = useState<EffectDefinition | undefined>(() =>
    effectLoader.get(initial.effectId),
  );
  // Why the selected effect's code failed to load.
  const [loadError, setLoadError] = useState<string>();
  const [latestLoad] = useState(() => createLatest<EffectDefinition>());
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
  // A brief message over the canvas; `id` restarts its timer when it repeats.
  const [toast, setToast] = useState<{ message: string; id: number }>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Told about each drawn frame; the WebCodecs recorder captures frames this way.
  const [frameListeners] = useState(() => new Set<(now: number) => void>());
  const onFrame = useCallback(
    (now: number) => {
      for (const listener of frameListeners) listener(now);
    },
    [frameListeners],
  );
  const subscribeFrames = useCallback<FrameSubscriber>(
    (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    [frameListeners],
  );
  const idle = useIdle(3000);
  // The effect list: its sort is remembered, its search isn't. The search stays while
  // the list is closed, because ← / → follow the filtered list.
  const [listOpen, setListOpen] = useState(false);
  const [listFocus, setListFocus] = useState(0);
  const [sort, setSort] = useState<EffectSort>(loadSort);
  const [query, setQuery] = useState("");
  const listOptions = useMemo(() => ({ sort, query }), [sort, query]);
  const visible = useMemo(() => visibleEffects(effects, listOptions), [listOptions]);
  const changeSort = useCallback((next: EffectSort) => {
    setSort(next);
    saveSort(next);
  }, []);
  const prefetch = useCallback((id: string) => {
    const entry = getEffect(id);
    if (entry) effectLoader.prefetch(entry);
  }, []);

  const effect = getEffect(effectId) ?? defaultEffect;
  const values = useMemo(
    () => valuesById[effect.id] ?? defaults(effect.params),
    [valuesById, effect],
  );
  // Whether the canvas is running the selected effect, rather than the previous one.
  const ready = running?.id === effect.id;
  const loading = !ready && loadError === undefined;
  // While the next effect loads, the previous one keeps drawing with its own values.
  const runningValues = useMemo(
    () => (running ? (valuesById[running.id] ?? defaults(running.params)) : {}),
    [valuesById, running],
  );

  /** Loads an effect and runs it, unless another load has started since. */
  const startLoad = useCallback(
    (entry: EffectEntry) =>
      latestLoad.run(effectLoader.load(entry), setRunning, (err) => {
        console.error(`Failed to load "${entry.name}":`, err);
        setLoadError(`This effect failed to load: ${describeError(err)}`);
      }),
    [latestLoad],
  );
  /**
   * Selects an effect and swaps it onto the canvas once its code has loaded. A cached
   * effect swaps at once; otherwise only the latest selection starts when loads finish
   * out of order. Callers keep this from running while recording.
   */
  const selectEffect = useCallback(
    (id: string) => {
      const entry = getEffect(id) ?? defaultEffect;
      setEffectId(entry.id);
      setLoadError(undefined);
      const loaded = effectLoader.get(entry.id);
      if (loaded) {
        latestLoad.cancel();
        setRunning(loaded);
      } else {
        startLoad(entry);
      }
    },
    [latestLoad, startLoad],
  );

  // The order ← / → step through, and so the order to prefetch in. Issue 120 makes this
  // the list as the user sees it (sorted, filtered).
  const order = effects;

  // Once the selected effect runs, fetch its neighbours in idle time so stepping to
  // them is instant. Failures are dropped from the cache, so a real switch retries.
  useEffect(() => {
    if (!ready) return;
    return whenIdle(() => {
      for (const entry of neighbours(order, effect.id)) effectLoader.prefetch(entry);
    });
  }, [ready, order, effect]);

  // Load the first effect, unless it was already cached at the first render. main.tsx
  // has already started its import, so this joins it.
  useEffect(() => {
    const entry = getEffect(initial.effectId) ?? defaultEffect;
    if (effectLoader.get(entry.id)) return;
    startLoad(entry);
    return () => latestLoad.cancel();
  }, [initial, latestLoad, startLoad]);

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
      const next = stateFromHash(hash, effects, defaultEffect);
      if (now.recording && next.effect.id !== now.effect.id) {
        // Switching effect would break the recording; put the current state back.
        window.history.replaceState(null, "", encodeHash(now.effect, now.values));
        return;
      }
      setValuesById((prev) => ({ ...prev, [next.effect.id]: next.values }));
      selectEffect(next.effect.id);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [selectEffect]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

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
      const i = order.findIndex((e) => e.id === effect.id);
      selectEffect(order[(i + dir + order.length) % order.length].id);
    },
    [order, effect, recording, selectEffect],
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
  /** Shows the panel and the effect list, and focuses its search box. */
  const openList = useCallback(() => {
    if (recording) return;
    setPanelHidden(false);
    setListOpen(true);
    setListFocus((n) => n + 1);
  }, [recording]);

  // Fullscreen can be refused (in an iframe, without a user gesture, or on iPhone,
  // which lacks the API); say so briefly rather than failing silently.
  const toggleFullscreen = useCallback(() => {
    const fail = () =>
      setToast((t) => ({ message: "Fullscreen unavailable", id: (t?.id ?? 0) + 1 }));
    try {
      const change = document.fullscreenElement
        ? document.exitFullscreen()
        : document.documentElement.requestFullscreen();
      Promise.resolve(change).catch(fail);
    } catch {
      fail();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isFormField(e.target)) return;
      if (e.key === "/") {
        e.preventDefault();
        openList();
      } else if (e.key === "h" || e.key === "H") togglePanel();
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, togglePanel, toggleFullscreen, openList]);

  const record = async (seconds: number) => {
    const canvas = canvasRef.current;
    // A pending load would swap the effect mid-recording.
    if (!canvas || recording || !ready) return;
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
        subscribeFrames,
      );
      download(blob, `zoomer-${effect.id}-${canvas.width}x${canvas.height}.${extension}`);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : String(err));
    } finally {
      clearInterval(countdown);
      setRecordingLeft(undefined);
    }
  };

  // An open effect list keeps the panel up, so it doesn't fade out mid-search.
  const showPanel = !panelHidden && (!idle || hoveringPanel || recording || listOpen);

  return (
    <main className="app" data-idle={idle && !hoveringPanel}>
      <EffectCanvas
        ref={canvasRef}
        effect={running}
        params={runningValues}
        resolution={resolution}
        frameRate={frameRate}
        onStats={statsStore.set}
        onError={setEffectError}
        onFrame={onFrame}
      />
      <div
        className="panel-wrap"
        data-visible={showPanel}
        onPointerEnter={() => setHoveringPanel(true)}
        onPointerLeave={() => setHoveringPanel(false)}
      >
        <PanelErrorBoundary>
          <ControlPanel
            list={{
              effects: visible,
              options: listOptions,
              focusRequest: listFocus,
              open: listOpen,
              onOpenChange: setListOpen,
              onQueryChange: setQuery,
              onSortChange: changeSort,
              onPrefetch: prefetch,
            }}
            effect={effect}
            values={values}
            error={loadError ?? (ready ? effectError : undefined)}
            loading={loading}
            canRecord={ready}
            onReload={loadError === undefined ? undefined : () => window.location.reload()}
            resolution={resolution}
            frameRate={frameRate}
            stats={statsStore}
            recordingLeft={recordingLeft}
            onEffectChange={selectEffect}
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
      {toast && (
        <div key={toast.id} className="toast" role="status">
          {toast.message}
        </div>
      )}
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
