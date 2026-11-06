/** The parts of `EXT_disjoint_timer_query_webgl2` the timer uses. */
interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: GLenum;
  readonly GPU_DISJOINT_EXT: GLenum;
}

/**
 * Measures GPU time spent between `begin` and `end` with timer queries. Results
 * arrive a few frames late, so a small ring of queries is kept in flight; frames
 * that find every query busy are simply not measured.
 */
export interface GpuTimer {
  /** Starts timing a frame's GL commands. */
  begin(): void;
  /** Stops timing. Safe to call without a matching `begin`. */
  end(): void;
  /**
   * Average GPU time per measured frame, in ms, since the last call; `undefined`
   * if no results have arrived since then.
   */
  takeAverage(): number | undefined;
  dispose(): void;
}

/** Queries in flight at once. Results usually land 1-3 frames later. */
const RING = 4;

/**
 * Creates a timer if the context supports `EXT_disjoint_timer_query_webgl2`, which
 * not every browser exposes; returns `undefined` otherwise.
 */
export function createGpuTimer(gl: WebGL2RenderingContext): GpuTimer | undefined {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2") as TimerQueryExt | null;
  if (!ext) return undefined;
  const queries: WebGLQuery[] = [];
  for (let i = 0; i < RING; i++) {
    // Null on a lost context, although the DOM typings omit it.
    const q = gl.createQuery() as WebGLQuery | null;
    if (!q) {
      for (const made of queries) gl.deleteQuery(made);
      return undefined;
    }
    queries.push(q);
  }

  /** Index of the oldest query awaiting its result. */
  let head = 0;
  /** Queries ended but not yet read. */
  let pending = 0;
  let active = false;
  let sumMs = 0;
  let samples = 0;

  /** Reads every finished query, oldest first, discarding disjoint results. */
  const collect = () => {
    while (pending > 0) {
      const q = queries[head];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      // A disjoint event (e.g. a GPU clock change) makes in-flight results unreliable.
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      if (!disjoint) {
        sumMs += ns / 1e6;
        samples++;
      }
      head = (head + 1) % RING;
      pending--;
    }
  };

  return {
    begin() {
      if (active) return;
      collect();
      if (pending === RING) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, queries[(head + pending) % RING]);
      active = true;
    },
    end() {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      active = false;
      pending++;
    },
    takeAverage() {
      collect();
      if (samples === 0) return undefined;
      const avg = sumMs / samples;
      sumMs = 0;
      samples = 0;
      return avg;
    },
    dispose() {
      if (active) gl.endQuery(ext.TIME_ELAPSED_EXT);
      active = false;
      pending = 0;
      for (const q of queries) gl.deleteQuery(q);
    },
  };
}
