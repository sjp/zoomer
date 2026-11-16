/**
 * The speedrun splits overlay's run, without any drawing: reading the split
 * list the viewer typed, making up comparison times for lines without one,
 * and a looping run that finishes each split ahead of, behind, or faster than
 * ever against those times.
 *
 * Times are cumulative seconds from the start of the run, as in a real splits
 * file. Nothing here throws on bad input: a time that doesn't parse, or that
 * isn't later than the one before it, is simply treated as missing.
 */
import { clamp } from "../math";
import { hash32 } from "../noise";

/** One line of the split list: its name (possibly empty) and given time, if any. */
interface SplitLine {
  readonly name: string;
  readonly time: number | null;
}

/**
 * Parses a split time: `s`, `m:ss` or `h:mm:ss`, each with an optional
 * fraction (`.5`, `.45`). Seconds and minutes after a colon run 00–59.
 * Returns seconds, or null.
 */
export function parseSplitTime(text: string): number | null {
  const m = /^(?:(?:(\d{1,3}):)?(\d{1,3}):)?(\d{1,5})(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (m === null) {
    return null;
  }
  const h = m.at(1);
  const mins = m.at(2);
  const secs = m[3];
  const frac = m.at(4);
  const s = Number(secs);
  const fraction = frac === undefined ? 0 : Number(`0.${frac}`);
  if (mins === undefined) {
    return s + fraction;
  }
  // After a colon: exactly two digits, under 60.
  if (secs.length !== 2 || s >= 60) {
    return null;
  }
  const min = Number(mins);
  if (h !== undefined && (mins.length !== 2 || min >= 60)) {
    return null;
  }
  return Number(h ?? 0) * 3600 + min * 60 + s + fraction;
}

/**
 * Parses one line of the split list: a name, then optionally two or more
 * spaces and a time. A line that is only a time is a split with no name.
 * Returns null for a blank line.
 */
export function parseSplitLine(line: string): SplitLine | null {
  const text = line.trim();
  if (text === "") {
    return null;
  }
  const alone = parseSplitTime(text);
  if (alone !== null) {
    return { name: "", time: alone };
  }
  const m = /^(.*?\S)\s{2,}(\S+)$/.exec(text);
  const time = m === null ? null : parseSplitTime(m[2]);
  const name = m !== null && time !== null ? m[1] : text;
  return { name: name.replace(/\s+/g, " "), time };
}

/** A run's splits: names and cumulative comparison times in seconds. */
interface SplitsPlan {
  readonly names: string[];
  readonly comparison: Float64Array;
}

/** The shortest made-up segment, in seconds, when the given times leave no room. */
const MIN_SEGMENT = 15;

/** A seeded unit value in [0, 1) for `seed` and the integers `a`, `b`. */
function unit(seed: number, a: number, b = 0): number {
  return hash32(seed ^ hash32(a * 0x9e3779b1 + hash32(b + 0x632be5ab))) / 4294967296;
}

/** A stable 32-bit seed from a string. */
export function textSeed(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h = hash32(h ^ (ch.codePointAt(0) ?? 0));
  }
  return h;
}

/**
 * Reads the split list (one split per line) into a plan for a run of about
 * `runSeconds`. Blank lines are skipped; a split with no name is called
 * "Split n"; an empty list is one split, "Finish". Given times that aren't
 * later than the last valid one are dropped. Missing times share out the gap
 * up to the next given time, or after the last one the rest of `runSeconds`
 * (at least `MIN_SEGMENT` each, or an even share of a short run), in seeded
 * proportions, rounded to tenths.
 */
export function planSplits(list: string, runSeconds: number, seed: number): SplitsPlan {
  const lines: SplitLine[] = [];
  for (const line of list.split("\n")) {
    const parsed = parseSplitLine(line);
    if (parsed !== null) {
      lines.push(parsed);
    }
  }
  if (lines.length === 0) {
    lines.push({ name: "Finish", time: null });
  }
  const n = lines.length;
  const names = lines.map((l, i) => (l.name === "" ? `Split ${String(i + 1)}` : l.name));
  // Given times, kept only while they increase.
  const known: (number | null)[] = [];
  let last = 0;
  for (const { time } of lines) {
    if (time !== null && time > last) {
      known.push(time);
      last = time;
    } else {
      known.push(null);
    }
  }
  const total = Number.isFinite(runSeconds) && runSeconds > 0 ? runSeconds : 300;
  const comparison = new Float64Array(n);
  // Short runs of many splits may have shorter segments than `MIN_SEGMENT`.
  const shortest = Math.min(MIN_SEGMENT, total / n);
  let prev = 0;
  let i = 0;
  while (i < n) {
    const given = known[i];
    if (given !== null) {
      comparison[i] = given;
      prev = given;
      i++;
      continue;
    }
    let j = i;
    while (j < n && known[j] === null) {
      j++;
    }
    // Lines i..j-1 have no time. Before a given time they share the gap up to it
    // with that line's own segment; at the end they share what is left of the run.
    const next = j < n ? known[j] : null;
    const parts = next === null ? j - i : j - i + 1;
    const span = next === null ? Math.max(total - prev, (j - i) * shortest) : next - prev;
    let sum = 0;
    for (let k = 0; k < parts; k++) {
      sum += 0.6 + 0.8 * unit(seed, i + k);
    }
    let acc = 0;
    for (let k = i; k < j; k++) {
      acc += 0.6 + 0.8 * unit(seed, k);
      const t = prev + (span * acc) / sum;
      comparison[k] = k === n - 1 && next === null ? prev + span : Math.round(t * 10) / 10;
    }
    prev = comparison[j - 1];
    i = j;
  }
  return { names, comparison };
}

/** How far a segment's real time strays from its comparison, as a fraction of it. */
const SPREAD_MIN = 0.01;
const SPREAD_MAX = 0.12;

/**
 * Real segment times (not cumulative) for run number `run` against
 * cumulative `comparison` times: each segment is quicker than its
 * comparison with probability `luck` (0 never, 1 always), slower otherwise,
 * by a seeded 1–12 %. Deterministic for a given seed and run. Writes `out`.
 */
export function simulateRun(
  comparison: Float64Array,
  luck: number,
  seed: number,
  run: number,
  out: Float64Array = new Float64Array(comparison.length),
): Float64Array {
  const odds = clamp(Number.isFinite(luck) ? luck : 0.5, 0, 1);
  const runSeed = hash32(seed ^ hash32(run + 1));
  let prev = 0;
  for (let i = 0; i < comparison.length; i++) {
    const segment = comparison[i] - prev;
    prev = comparison[i];
    const ahead = unit(runSeed, i, 1) < odds;
    const u = unit(runSeed, i, 2);
    const size = SPREAD_MIN + (SPREAD_MAX - SPREAD_MIN) * u * u;
    out[i] = segment * (ahead ? 1 - size : 1 + size);
  }
  return out;
}

/** How a finished split went: ahead of or behind the comparison, or its best segment yet. */
export const SPLIT_PENDING = 0;
export const SPLIT_AHEAD = 1;
export const SPLIT_BEHIND = 2;
export const SPLIT_BEST = 3;

/** Seconds the timer rests at zero before a run starts. */
export const START_SECONDS = 1.5;
/** Seconds the final time holds before the next run. */
export const HOLD_SECONDS = 5;

/** The looping run the overlay shows. Its arrays are reused; read them, don't keep them. */
interface SplitsSession {
  /** The split names, renamed in place when the list changes but its length doesn't. */
  readonly names: readonly string[];
  /** Cumulative comparison times for this run. */
  readonly comparison: Float64Array;
  /** How many splits this run has. */
  readonly count: number;
  /** Seconds since the run started (0 while waiting to start; held at the final time after). */
  readonly time: number;
  /** The split under way, or `count` once the run has finished. */
  readonly current: number;
  /** Per split: `SPLIT_PENDING`, `SPLIT_AHEAD`, `SPLIT_BEHIND` or `SPLIT_BEST`. */
  readonly results: Uint8Array;
  /** Per finished split: its real cumulative time, and that minus the comparison. */
  readonly finished: Float64Array;
  readonly diffs: Float64Array;
  /** Runs started so far, counting this one from 0. */
  readonly run: number;
  /** Bumped whenever the names change, and whenever a new run starts. */
  readonly namesVersion: number;
  /**
   * Sets the list, run length and luck. A new list or length takes effect at
   * the next run, except that a list with as many splits renames them now.
   * Luck is read at the start of each run. Cheap when nothing changed.
   */
  configure: (list: string, runMinutes: number, luck: number) => void;
  /** Advances the run by `dt` seconds, finishing splits and starting runs. */
  step: (dt: number) => void;
}

/** A splits session, `seed` varying the runs (the made-up times come from the list itself). */
export function createSplitsSession(seed = 1): SplitsSession {
  let list: string | null = null;
  let minutes = Number.NaN;
  let luck = 0.5;
  /** The plan the next run uses, if different from this one's. */
  let pending: SplitsPlan | null = null;
  let plan: SplitsPlan = { names: [], comparison: new Float64Array(0) };
  let segments = new Float64Array(0);
  let best = new Float64Array(0);
  let realCum = new Float64Array(0);
  let names: string[] = [];
  let namesVersion = 0;
  let clock = -START_SECONDS;
  let held = 0;

  const state = {
    names,
    comparison: plan.comparison,
    count: 0,
    time: 0,
    current: 0,
    results: new Uint8Array(0),
    finished: new Float64Array(0),
    diffs: new Float64Array(0),
    run: -1,
    namesVersion,
    configure,
    step,
  };

  /** Each segment of a comparison, as the starting bests. */
  const segmentsOf = (comparison: Float64Array) =>
    comparison.map((t, i) => t - (i > 0 ? comparison[i - 1] : 0));

  const sameTimes = (a: Float64Array, b: Float64Array) =>
    a.length === b.length && a.every((t, i) => t === b[i]);

  /** Starts the next run, taking up a pending plan. */
  function startRun() {
    if (pending !== null) {
      if (!sameTimes(pending.comparison, plan.comparison)) {
        best = segmentsOf(pending.comparison);
      }
      plan = pending;
      pending = null;
      const n = plan.comparison.length;
      if (n !== state.count) {
        segments = new Float64Array(n);
        realCum = new Float64Array(n);
        state.results = new Uint8Array(n);
        state.finished = new Float64Array(n);
        state.diffs = new Float64Array(n);
      }
      names = plan.names.slice();
      state.count = n;
    }
    state.run++;
    state.comparison = plan.comparison;
    state.names = names;
    simulateRun(plan.comparison, luck, seed, state.run, segments);
    let acc = 0;
    for (let i = 0; i < segments.length; i++) {
      acc += segments[i];
      realCum[i] = acc;
    }
    state.results.fill(SPLIT_PENDING);
    state.finished.fill(0);
    state.diffs.fill(0);
    state.current = 0;
    state.time = 0;
    clock = -START_SECONDS;
    held = 0;
    state.namesVersion = ++namesVersion;
  }

  function configure(text: string, runMinutes: number, runLuck: number) {
    luck = runLuck;
    if (text === list && runMinutes === minutes) {
      return;
    }
    const fresh = planSplits(text, runMinutes * 60, textSeed(text));
    const first = list === null;
    list = text;
    minutes = runMinutes;
    pending = fresh;
    if (first) {
      startRun();
      return;
    }
    if (fresh.names.length === state.count && fresh.names.some((n, i) => n !== names[i])) {
      names = fresh.names.slice();
      state.names = names;
      state.namesVersion = ++namesVersion;
    }
  }

  function step(dt: number) {
    if (state.run < 0 || !(dt > 0) || !Number.isFinite(dt)) {
      return;
    }
    let left = dt;
    // A long step (a hidden tab catching up) may cross several runs.
    while (left > 0) {
      const n = state.count;
      if (state.current >= n) {
        const wait = HOLD_SECONDS - held;
        if (left < wait) {
          held += left;
          return;
        }
        left -= wait;
        startRun();
        continue;
      }
      const end = realCum[n - 1];
      const until = end - clock;
      const take = Math.min(left, until);
      clock += take;
      left -= take;
      state.time = Math.max(0, clock);
      while (state.current < n && clock >= realCum[state.current]) {
        const i = state.current;
        const segment = segments[i];
        state.finished[i] = realCum[i];
        state.diffs[i] = realCum[i] - plan.comparison[i];
        if (segment < best[i]) {
          best[i] = segment;
          state.results[i] = SPLIT_BEST;
        } else {
          state.results[i] = state.diffs[i] < 0 ? SPLIT_AHEAD : SPLIT_BEHIND;
        }
        state.current++;
      }
      if (state.current >= n) {
        state.time = end;
      }
    }
  }

  return state;
}

/**
 * The first of `visible` rows to show out of `count`, keeping split `current`
 * (or the last, once finished) in view, as near the middle as the ends allow.
 * Moving to the next split moves the window at most one row.
 */
export function windowStart(current: number, count: number, visible: number): number {
  const v = Math.max(1, Math.floor(visible));
  if (v >= count) {
    return 0;
  }
  const c = clamp(Math.floor(current), 0, count - 1);
  return clamp(c - Math.floor((v - 1) / 2), 0, count - v);
}

/**
 * A run time as the timer shows it, to the tenth (truncated, so it never
 * shows a tenth early): `12.3`, `4:05.0`, `1:02:10.5`.
 */
export function formatSplitTime(seconds: number): string {
  const tenths = Math.max(0, Math.floor(seconds * 10 + 1e-6));
  const s = Math.floor(tenths / 10);
  const frac = String(tenths % 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const ss = s % 60;
  if (h > 0) {
    return `${String(h)}:${pad2(m)}:${pad2(ss)}.${frac}`;
  }
  if (m > 0) {
    return `${String(m)}:${pad2(ss)}.${frac}`;
  }
  return `${String(ss)}.${frac}`;
}

/** A difference from the comparison, signed: `+4.2`, `−1:03.5` (a true minus sign). */
export function formatSplitDiff(seconds: number): string {
  const sign = seconds < 0 ? "−" : "+";
  return `${sign}${formatSplitTime(Math.abs(seconds))}`;
}

const pad2 = (n: number) => (n < 10 ? `0${String(n)}` : String(n));
