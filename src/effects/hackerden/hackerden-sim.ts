/**
 * Hacker Thriller Den without any drawing: where the monitors stand, which
 * screen shows what, each screen's own schedule (what it types, steps or
 * redraws, and when), and the alert banners.
 *
 * Screens change a few times a second at most: text types a few characters a
 * tick, lines appear one at a time and steps of a whole line ease over a
 * quarter of a second, so nothing small slides continuously. The pace param
 * sets the tick rate, latched per tick. The trace's head, the network's pulse
 * and the waveform move smoothly, within the codec motion limits.
 */
import { createCountFade } from "../fade";
import { clamp, smoothstep } from "../math";
import { EASE_PEAK, pxPerReferenceFrame } from "../motion-limits";
import { createRng } from "../noise";
import { MAX_SCREENS, MIN_SCREENS } from "./hackerden.meta";
import {
  type CodeLine,
  codeBlock,
  progressFile,
  progressTask,
  terminalCommand,
  terminalOutput,
  terminalOutputCount,
  unitHash,
} from "./hackerden-text";

// ---------------------------------------------------------------------------
// Layout

/** A monitor's screen: its centre and half size in design units (frame heights at 16:9, y up). */
interface Slot {
  readonly x: number;
  readonly y: number;
  readonly hw: number;
  readonly hh: number;
  /** On an arm from the wall, rather than a stand on the desk. */
  readonly wall: boolean;
}

/**
 * The seven monitors, left to right: a portrait screen at each end, a row of
 * three along the top with the widest behind the speaker, and two lower down
 * on the desk, in the outer thirds. The top row hangs on arms from the wall;
 * the rest stand on the desk.
 */
export const SLOTS: readonly Slot[] = [
  { x: -0.785, y: 0.17, hw: 0.085, hh: 0.19, wall: false },
  { x: -0.53, y: -0.15, hw: 0.15, hh: 0.1, wall: false },
  { x: -0.5, y: 0.26, hw: 0.16, hh: 0.12, wall: true },
  { x: 0, y: 0.24, hw: 0.29, hh: 0.155, wall: true },
  { x: 0.5, y: 0.26, hw: 0.16, hh: 0.12, wall: true },
  { x: 0.53, y: -0.15, hw: 0.15, hh: 0.1, wall: false },
  { x: 0.785, y: 0.17, hw: 0.085, hh: 0.19, wall: false },
];

/** The screen directly behind the speaker. */
export const CENTRE_SLOT = 3;

/**
 * The order screens are added in as the count grows: the middle five always
 * show, then the right-hand end, then the left, so added screens come in at
 * the ends of the arrangement and the rest stay where they are.
 */
export const ADD_ORDER = [3, 2, 4, 1, 5, 6, 0] as const;

/** Slots that always show (the first five added), where the terminal must go. */
const ALWAYS_SHOWN = [1, 2, 4, 5] as const;

/** Text rows on a screen per design unit of its height. */
const ROWS_PER_UNIT = 62;

/** How many text rows fit on `slot`: more on the tall, portrait end screens. */
export function slotRows(slot: Slot): number {
  return Math.max(6, Math.floor(2 * slot.hh * ROWS_PER_UNIT));
}

// ---------------------------------------------------------------------------
// Screen kinds

export const SCREEN_KINDS = [
  "terminal",
  "code",
  "map",
  "decrypt",
  "progress",
  "network",
  "wave",
] as const;
export type ScreenKind = (typeof SCREEN_KINDS)[number];

/**
 * Each slot's kind for `seed`, without repeats: the calm world map behind the
 * speaker, the rest shuffled over the outer screens, with the terminal (which
 * shows the owner's handle) on a screen that always shows.
 */
export function assignKinds(seed: number): ScreenKind[] {
  const rng = createRng(seed);
  const others = SCREEN_KINDS.filter((k) => k !== "map");
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const kinds: ScreenKind[] = [];
  let o = 0;
  for (let s = 0; s < MAX_SCREENS; s++) {
    kinds.push(s === CENTRE_SLOT ? "map" : others[o++]);
  }
  const at = kinds.indexOf("terminal");
  if (!(ALWAYS_SHOWN as readonly number[]).includes(at)) {
    const swap = ALWAYS_SHOWN[Math.floor(rng() * ALWAYS_SHOWN.length)];
    kinds[at] = kinds[swap];
    kinds[swap] = "terminal";
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// Ticks

/** Most ticks a screen makes per second, at pace 1. */
export const MAX_TICK_HZ = 6;
/** Most ticks a screen catches up in one step (after a pause, the rest are dropped). */
const MAX_CATCH_UP = 8;

/** Seconds between ticks at `pace` (0.2..1): 1/6 s at full pace. */
export const tickSeconds = (pace: number): number =>
  1 / (MAX_TICK_HZ * clamp(Number.isFinite(pace) ? pace : 0.5, 0.2, 1));

/** Seconds a step of a whole line of text takes to ease into place. */
export const LINE_STEP_SECONDS = 0.25;

/**
 * How far (0..1 of a line) text that just stepped up a line still sits below
 * its place, `age` seconds after the step.
 */
export const lineStepOffset = (age: number): number =>
  1 - smoothstep(0, LINE_STEP_SECONDS, Math.max(0, age));

/** Redraw nothing, or everything on the screen. */
export const DIRTY_NONE = -2;
export const DIRTY_ALL = -1;

interface TickClock {
  /** Seconds until the next tick. */
  wait: number;
}

/** Counts the ticks due after `dt` seconds, scheduling each next one at `pace`. */
function dueTicks(c: TickClock, dt: number, pace: number): number {
  c.wait -= Number.isFinite(dt) && dt > 0 ? dt : 0;
  let n = 0;
  while (c.wait <= 0) {
    c.wait += tickSeconds(pace);
    n++;
    if (n >= MAX_CATCH_UP) {
      c.wait = Math.max(c.wait, tickSeconds(pace) * 0.5);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Terminal

export interface TerminalSim {
  readonly kind: "terminal";
  readonly rows: number;
  /** Lines, oldest first: up to `rows + 1`, the first of a full screen hidden above it. */
  readonly lines: string[];
  /** Whether each line is a prompt (the prompt is drawn before the text). */
  readonly prompt: boolean[];
  /** The row to redraw (0 is the top shown row), DIRTY_ALL or DIRTY_NONE. */
  dirty: number;
  /** Seconds since the text last stepped up a line. */
  stepAge: number;
  /** The command being typed, its index, how much is typed and how much output is left. */
  command: string;
  index: number;
  typed: number;
  outputLeft: number;
  /** Ticks to wait before typing the next command. */
  idle: number;
  readonly clock: TickClock;
  readonly seed: number;
}

export function createTerminal(seed: number, rows: number): TerminalSim {
  const t: TerminalSim = {
    kind: "terminal",
    rows,
    lines: [],
    prompt: [],
    dirty: DIRTY_ALL,
    stepAge: Infinity,
    command: terminalCommand(seed, 0),
    index: 0,
    typed: 0,
    outputLeft: -1,
    idle: 3,
    clock: { wait: 0 },
    seed,
  };
  // Start with a screen of earlier commands already run.
  for (let i = -12; i < 0; i++) {
    pushLine(t, terminalCommand(seed, i + 100000), true);
    for (let j = 0; j < terminalOutputCount(seed, i + 100000); j++) {
      pushLine(t, terminalOutput(seed, i + 100000, j), false);
    }
  }
  pushLine(t, "", true);
  t.dirty = DIRTY_ALL;
  t.stepAge = Infinity;
  return t;
}

/** The terminal's line shown on `row` (-1 is the hidden line above), or -1 for none. */
export function terminalLine(t: TerminalSim, row: number): number {
  const first = Math.max(0, t.lines.length - t.rows);
  const i = first + row;
  return i >= 0 && i < t.lines.length ? i : -1;
}

function pushLine(t: TerminalSim, text: string, prompt: boolean): void {
  t.lines.push(text);
  t.prompt.push(prompt);
  if (t.lines.length > t.rows + 1) {
    t.lines.shift();
    t.prompt.shift();
  }
  if (t.lines.length > t.rows) {
    t.dirty = DIRTY_ALL;
    t.stepAge = 0;
  } else {
    markLast(t);
  }
}

function markLast(t: TerminalSim): void {
  if (t.dirty === DIRTY_ALL) {
    return;
  }
  const row = t.lines.length - 1 - Math.max(0, t.lines.length - t.rows);
  t.dirty = t.dirty === DIRTY_NONE || t.dirty === row ? row : DIRTY_ALL;
}

function tickTerminal(t: TerminalSim): void {
  if (t.idle > 0) {
    t.idle--;
    return;
  }
  if (t.outputLeft < 0) {
    // Typing: a few characters a tick.
    const burst = 1 + Math.floor(unitHash(t.seed, 40, t.index * 64 + t.typed) * 3);
    t.typed = Math.min(t.command.length, t.typed + burst);
    t.lines[t.lines.length - 1] = t.command.slice(0, t.typed);
    markLast(t);
    if (t.typed >= t.command.length) {
      t.outputLeft = terminalOutputCount(t.seed, t.index);
      t.idle = 1;
    }
    return;
  }
  const count = terminalOutputCount(t.seed, t.index);
  if (t.outputLeft > 0) {
    pushLine(t, terminalOutput(t.seed, t.index, count - t.outputLeft), false);
    t.outputLeft--;
    return;
  }
  // Done: a new prompt, and a pause before the next command.
  t.index++;
  t.command = terminalCommand(t.seed, t.index);
  t.typed = 0;
  t.outputLeft = -1;
  t.idle = 2 + Math.floor(unitHash(t.seed, 41, t.index) * 5);
  pushLine(t, "", true);
}

// ---------------------------------------------------------------------------
// Code editor

/** Ticks between the editor's steps (so a step's ease ends well before the next), and the most extra it pauses. */
const CODE_STEP_TICKS = 3;
const CODE_MAX_PAUSE_TICKS = 6;

export interface CodeSim {
  readonly kind: "code";
  readonly rows: number;
  /** `rows + 1` lines: the first is hidden above the screen, for the step's ease. */
  readonly lines: CodeLine[];
  /** The line number of `lines[0]`. */
  first: number;
  dirty: number;
  stepAge: number;
  /** Ticks left before the next step. */
  wait: number;
  /** The block of the file being read from, and the next line of it. */
  block: number;
  blockLines: CodeLine[];
  blockAt: number;
  readonly clock: TickClock;
  readonly seed: number;
}

function nextCodeLine(c: CodeSim): CodeLine {
  while (c.blockAt >= c.blockLines.length) {
    c.block++;
    c.blockLines = codeBlock(c.seed, c.block);
    c.blockAt = 0;
  }
  return c.blockLines[c.blockAt++];
}

export function createCode(seed: number, rows: number): CodeSim {
  const c: CodeSim = {
    kind: "code",
    rows,
    lines: [],
    first: 1,
    dirty: DIRTY_ALL,
    stepAge: Infinity,
    wait: CODE_STEP_TICKS,
    block: 0,
    blockLines: codeBlock(seed, 0),
    blockAt: 0,
    clock: { wait: 0 },
    seed,
  };
  for (let i = 0; i <= rows; i++) {
    c.lines.push(nextCodeLine(c));
  }
  return c;
}

function tickCode(c: CodeSim): void {
  if (--c.wait > 0) {
    return;
  }
  c.lines.shift();
  c.lines.push(nextCodeLine(c));
  c.first++;
  c.dirty = DIRTY_ALL;
  c.stepAge = 0;
  const pause = unitHash(c.seed, 42, c.first) < 0.2;
  c.wait =
    CODE_STEP_TICKS +
    (pause ? 1 + Math.floor(unitHash(c.seed, 43, c.first) * CODE_MAX_PAUSE_TICKS) : 0);
}

// ---------------------------------------------------------------------------
// Decrypt

/** Hex cells that change in place each tick, besides the one that settles. */
const DECRYPT_FLIPS = 3;
/** Ticks the found key holds before the grid starts over. */
const DECRYPT_HOLD_TICKS = 14;

export interface DecryptSim {
  readonly kind: "decrypt";
  readonly cols: number;
  readonly rows: number;
  /** Each cell's byte, row by row. */
  readonly values: Uint8Array;
  /** Whether each cell has settled into the key. */
  readonly settled: Uint8Array;
  /** Cells settled so far, column by column. */
  settledCount: number;
  round: number;
  /** Ticks left showing the found key. */
  hold: number;
  /** Cells changed since the last draw (up to `DECRYPT_FLIPS + 1`), or the lot. */
  readonly changed: Int16Array;
  changedCount: number;
  dirtyAll: boolean;
  /** Whether the status line changed. */
  statusDirty: boolean;
  ticks: number;
  readonly clock: TickClock;
  readonly seed: number;
}

/** The byte cell `cell` settles to in round `round`. */
const keyByte = (seed: number, round: number, cell: number): number =>
  Math.floor(unitHash(seed, 50 + round, cell) * 256);

const noiseByte = (d: DecryptSim, cell: number) =>
  Math.floor(unitHash(d.seed, 51, d.ticks * 4096 + cell) * 256);

export function createDecrypt(seed: number, cols: number, rows: number): DecryptSim {
  const d: DecryptSim = {
    kind: "decrypt",
    cols,
    rows,
    values: new Uint8Array(cols * rows),
    settled: new Uint8Array(cols * rows),
    settledCount: 0,
    round: 0,
    hold: 0,
    changed: new Int16Array(DECRYPT_FLIPS + 1),
    changedCount: 0,
    dirtyAll: true,
    statusDirty: true,
    ticks: 0,
    clock: { wait: 0 },
    seed,
  };
  for (let i = 0; i < d.values.length; i++) {
    d.values[i] = noiseByte(d, i);
  }
  return d;
}

function markCell(d: DecryptSim, cell: number): void {
  if (d.dirtyAll) {
    return;
  }
  for (let i = 0; i < d.changedCount; i++) {
    if (d.changed[i] === cell) {
      return;
    }
  }
  if (d.changedCount >= d.changed.length) {
    d.dirtyAll = true;
    return;
  }
  d.changed[d.changedCount++] = cell;
}

function tickDecrypt(d: DecryptSim): void {
  d.ticks++;
  const total = d.cols * d.rows;
  if (d.settledCount >= total) {
    if (--d.hold > 0) {
      return;
    }
    d.round++;
    d.settledCount = 0;
    d.settled.fill(0);
    for (let i = 0; i < total; i++) {
      d.values[i] = noiseByte(d, i);
    }
    d.dirtyAll = true;
    d.statusDirty = true;
    return;
  }
  for (let f = 0; f < DECRYPT_FLIPS; f++) {
    const cell = Math.floor(unitHash(d.seed, 52, d.ticks * 8 + f) * total);
    if (d.settled[cell] === 0) {
      d.values[cell] = noiseByte(d, cell);
      markCell(d, cell);
    }
  }
  // Settle the next cell, down each column in turn.
  const k = d.settledCount++;
  const cell = (k % d.rows) * d.cols + Math.floor(k / d.rows);
  d.values[cell] = keyByte(d.seed, d.round, cell);
  d.settled[cell] = 1;
  markCell(d, cell);
  d.statusDirty = true;
  if (d.settledCount >= total) {
    d.hold = DECRYPT_HOLD_TICKS;
  }
}

// ---------------------------------------------------------------------------
// Progress

/** Ticks "COMPLETE" holds before the next task. */
const PROGRESS_HOLD_TICKS = 12;

export interface ProgressSim {
  readonly kind: "progress";
  /** Rows in the file list. */
  readonly rows: number;
  task: number;
  /** 0..100. */
  percent: number;
  /** Files listed so far. */
  files: number;
  hold: number;
  barDirty: boolean;
  /** The list row to redraw, DIRTY_ALL or DIRTY_NONE. */
  dirty: number;
  ticks: number;
  readonly clock: TickClock;
  readonly seed: number;
}

function createProgress(seed: number, rows: number): ProgressSim {
  return {
    kind: "progress",
    rows,
    task: 0,
    percent: 37,
    files: Math.floor(0.37 * rows),
    hold: 0,
    barDirty: true,
    dirty: DIRTY_ALL,
    ticks: 0,
    clock: { wait: 0 },
    seed,
  };
}

function tickProgress(p: ProgressSim): void {
  p.ticks++;
  if (p.percent >= 100) {
    if (--p.hold > 0) {
      return;
    }
    p.task++;
    p.percent = 0;
    p.files = 0;
    p.barDirty = true;
    p.dirty = DIRTY_ALL;
    return;
  }
  p.percent = Math.min(100, p.percent + 0.3 + unitHash(p.seed, 60, p.ticks) * 2.2);
  p.barDirty = true;
  const files = Math.min(p.rows, Math.floor((p.percent / 100) * p.rows + 0.999));
  while (p.files < files) {
    p.dirty = p.dirty === DIRTY_NONE ? p.files : DIRTY_ALL;
    p.files++;
  }
  if (p.percent >= 100) {
    p.hold = PROGRESS_HOLD_TICKS;
  }
}

/** The name of file `row` in the progress screen's current list. */
export const progressFileAt = (p: ProgressSim, row: number): string =>
  progressFile(p.seed, p.task, row);

/** The progress screen's current task, in capitals. */
export const progressTaskOf = (p: ProgressSim): string => progressTask(p.seed, p.task);

// ---------------------------------------------------------------------------
// Network graph

const NETWORK_NODES = 9;
/** Links per node, to its nearest neighbours. */
const NETWORK_LINKS = 2;
/** Most nodes a pulse's path visits. */
const MAX_PATH = 6;
/** The pulse's speed along a link, design units a second. */
export const PULSE_SPEED = 0.12;
/** Seconds the pulse takes to fade in or out at a path's ends, and the pause between paths. */
const PULSE_FADE = 0.4;
const PULSE_PAUSE = 1.2;

export interface NetworkSim {
  readonly kind: "network";
  /** Node positions, 0..1 across and down the screen's graph area. */
  readonly nodes: Float32Array;
  /** Pairs of linked node indices. */
  readonly links: number[];
  /** The pulse's path, its length and which link of it the pulse is on. */
  readonly path: Int8Array;
  pathLen: number;
  segment: number;
  /** 0..1 along the current link. */
  along: number;
  /** The pulse's position (as `nodes`) and brightness, 0..1. */
  pulseX: number;
  pulseY: number;
  pulseLevel: number;
  /** Seconds of pause left before the next path. */
  pause: number;
  paths: number;
  /** The graph needs redrawing (a new path is highlighted). */
  dirty: boolean;
  /** The stats line changed. */
  statsDirty: boolean;
  ticks: number;
  /** The graph area's size in design units, for the pulse's speed. */
  readonly width: number;
  readonly height: number;
  readonly clock: TickClock;
  readonly seed: number;
}

export function createNetwork(seed: number, width: number, height: number): NetworkSim {
  const rng = createRng(seed ^ 0x5bd1e995);
  const nodes = new Float32Array(2 * NETWORK_NODES);
  // Spread the nodes out: each the best of a few candidates, farthest from the rest.
  for (let i = 0; i < NETWORK_NODES; i++) {
    let best = -1;
    for (let c = 0; c < 12; c++) {
      const x = 0.08 + 0.84 * rng();
      const y = 0.1 + 0.8 * rng();
      let near = Infinity;
      for (let j = 0; j < i; j++) {
        near = Math.min(
          near,
          Math.hypot((x - nodes[2 * j]) * width, (y - nodes[2 * j + 1]) * height),
        );
      }
      if (near > best) {
        best = near;
        nodes[2 * i] = x;
        nodes[2 * i + 1] = y;
      }
    }
  }
  const links: number[] = [];
  for (let i = 0; i < NETWORK_NODES; i++) {
    const order = Array.from({ length: NETWORK_NODES }, (_, j) => j)
      .filter((j) => j !== i)
      .toSorted(
        (a, b) =>
          Math.hypot(
            (nodes[2 * a] - nodes[2 * i]) * width,
            (nodes[2 * a + 1] - nodes[2 * i + 1]) * height,
          ) -
          Math.hypot(
            (nodes[2 * b] - nodes[2 * i]) * width,
            (nodes[2 * b + 1] - nodes[2 * i + 1]) * height,
          ),
      );
    for (let k = 0; k < NETWORK_LINKS; k++) {
      if (!hasLink(links, i, order[k])) {
        links.push(i, order[k]);
      }
    }
  }
  const n: NetworkSim = {
    kind: "network",
    nodes,
    links,
    path: new Int8Array(MAX_PATH),
    pathLen: 0,
    segment: 0,
    along: 0,
    pulseX: 0,
    pulseY: 0,
    pulseLevel: 0,
    pause: 0,
    paths: 0,
    dirty: true,
    statsDirty: true,
    ticks: 0,
    width,
    height,
    clock: { wait: 0 },
    seed,
  };
  newPath(n);
  return n;
}

/** Whether `links` (pairs of node indices) links `a` and `b`. */
function hasLink(links: readonly number[], a: number, b: number): boolean {
  for (let k = 0; k < links.length; k += 2) {
    if ((links[k] === a && links[k + 1] === b) || (links[k] === b && links[k + 1] === a)) {
      return true;
    }
  }
  return false;
}

/** Whether nodes `a` and `b` of the network are linked. */
export const networkLinked = (n: NetworkSim, a: number, b: number): boolean =>
  hasLink(n.links, a, b);

/** A walk along the links, never straight back, from a seeded start. */
function newPath(n: NetworkSim): void {
  n.paths++;
  let at = Math.floor(unitHash(n.seed, 70, n.paths) * NETWORK_NODES);
  let prev = -1;
  n.path[0] = at;
  n.pathLen = 1;
  for (let s = 1; s < MAX_PATH; s++) {
    let choices = 0;
    for (let k = 0; k < n.links.length; k += 2) {
      const other = n.links[k] === at ? n.links[k + 1] : n.links[k + 1] === at ? n.links[k] : -1;
      if (other >= 0 && other !== prev) {
        choices++;
      }
    }
    if (choices === 0) {
      break;
    }
    let pickIndex = Math.floor(unitHash(n.seed, 71, n.paths * 16 + s) * choices);
    for (let k = 0; k < n.links.length; k += 2) {
      const other = n.links[k] === at ? n.links[k + 1] : n.links[k + 1] === at ? n.links[k] : -1;
      if (other >= 0 && other !== prev && pickIndex-- === 0) {
        prev = at;
        at = other;
        break;
      }
    }
    n.path[n.pathLen++] = at;
  }
  n.segment = 0;
  n.along = 0;
  n.dirty = true;
  n.pulseX = n.nodes[2 * n.path[0]];
  n.pulseY = n.nodes[2 * n.path[0] + 1];
}

function stepNetwork(n: NetworkSim, dt: number): void {
  if (n.pause > 0) {
    n.pause -= dt;
    n.pulseLevel = Math.max(0, n.pulseLevel - dt / PULSE_FADE);
    if (n.pause <= 0) {
      newPath(n);
    }
    return;
  }
  n.pulseLevel = Math.min(1, n.pulseLevel + dt / PULSE_FADE);
  let left = dt;
  while (left > 0 && n.segment < n.pathLen - 1) {
    const a = n.path[n.segment];
    const b = n.path[n.segment + 1];
    const len = Math.max(
      1e-3,
      Math.hypot(
        (n.nodes[2 * b] - n.nodes[2 * a]) * n.width,
        (n.nodes[2 * b + 1] - n.nodes[2 * a + 1]) * n.height,
      ),
    );
    const need = ((1 - n.along) * len) / PULSE_SPEED;
    if (left < need) {
      n.along += (left * PULSE_SPEED) / len;
      left = 0;
    } else {
      left -= need;
      n.segment++;
      n.along = 0;
    }
  }
  if (n.segment >= n.pathLen - 1) {
    const end = n.path[n.pathLen - 1];
    n.pulseX = n.nodes[2 * end];
    n.pulseY = n.nodes[2 * end + 1];
    n.pause = PULSE_PAUSE;
    return;
  }
  const a = n.path[n.segment];
  const b = n.path[n.segment + 1];
  n.pulseX = n.nodes[2 * a] + (n.nodes[2 * b] - n.nodes[2 * a]) * n.along;
  n.pulseY = n.nodes[2 * a + 1] + (n.nodes[2 * b + 1] - n.nodes[2 * a + 1]) * n.along;
}

// ---------------------------------------------------------------------------
// Waveform

/** The trace's two waves: cycles across the screen and their phase speeds, cycles a second. */
export const WAVE_CYCLES = [3, 7] as const;
export const WAVE_HZ = [0.35, 0.6] as const;

export interface WaveSim {
  readonly kind: "wave";
  /** Each wave's phase, radians in 0..2pi, and the trace's amplitude, 0..1. */
  phase1: number;
  phase2: number;
  amplitude: number;
  time: number;
  statsDirty: boolean;
  ticks: number;
  readonly clock: TickClock;
  readonly seed: number;
}

function createWave(seed: number): WaveSim {
  return {
    kind: "wave",
    phase1: 0,
    phase2: 1,
    amplitude: 0.6,
    time: 0,
    statsDirty: true,
    ticks: 0,
    clock: { wait: 0 },
    seed,
  };
}

const TAU = Math.PI * 2;

function stepWave(w: WaveSim, dt: number): void {
  w.time += dt;
  w.phase1 = (w.phase1 + dt * TAU * WAVE_HZ[0]) % TAU;
  w.phase2 = (w.phase2 + dt * TAU * WAVE_HZ[1]) % TAU;
  w.amplitude = 0.55 + 0.25 * Math.sin(w.time * 0.31) * Math.sin(w.time * 0.17 + 1);
}

// ---------------------------------------------------------------------------
// Trace map

/** Cities the trace hops between, as longitude and latitude in degrees. */
const CITIES: readonly (readonly [number, number])[] = [
  [-74, 40.7],
  [-118.2, 34],
  [-87.6, 41.9],
  [-99.1, 19.4],
  [-74, 4.7],
  [-77, -12],
  [-46.6, -23.5],
  [-58.4, -34.6],
  [-70.6, -33.4],
  [-123, 49.3],
  [-79.4, 43.7],
  [-21.9, 64.1],
  [-0.1, 51.5],
  [2.35, 48.9],
  [13.4, 52.5],
  [-3.7, 40.4],
  [12.5, 41.9],
  [18, 59.3],
  [37.6, 55.8],
  [29, 41],
  [31.2, 30],
  [3.4, 6.5],
  [36.8, -1.3],
  [28, -26.2],
  [55.3, 25.2],
  [72.9, 19.1],
  [77.2, 28.6],
  [100.5, 13.8],
  [103.8, 1.35],
  [114.2, 22.3],
  [121.5, 31.2],
  [127, 37.6],
  [139.7, 35.7],
  [121, 14.6],
  [106.8, -6.2],
  [151.2, -33.9],
  [115.9, -32],
  [174.8, -36.8],
  [-157.9, 21.3],
  [-149.9, 61.2],
];

/** The map's left edge's longitude, and the latitudes of its top and bottom. */
export const MAP_WEST = -170;
export const MAP_NORTH = 78;
export const MAP_SOUTH = -58;

/** A city's position on the map: 0..1 across from the west edge and down from the north. */
function cityUv(i: number, out: Float32Array, o: number): void {
  const [lon, lat] = CITIES[i];
  out[o] = ((((lon - MAP_WEST) % 360) + 360) % 360) / 360;
  out[o + 1] = (MAP_NORTH - lat) / (MAP_NORTH - MAP_SOUTH);
}

export const MAX_HOPS = 6;
/**
 * The trace's speed limit, design units a second: a hop takes its length over
 * this, kept to 1-2 s, so its eased peak stays under 8 px a frame at 1080p30.
 */
export const HOP_SPEED = (8 * 30) / 1080 / EASE_PEAK;
const MIN_HOP_SECONDS = 1;
const MAX_HOP_SECONDS = 2;
/** The shortest hop, design units, so each one reads as a move. */
const MIN_HOP = 0.05;
/** Seconds the finished trace holds, then fades. */
const TRACE_HOLD = 4;
const TRACE_FADE = 1;

export interface MapSim {
  readonly kind: "map";
  /** Cities on the route so far, and their map positions (as `cityUv`). */
  readonly route: Int16Array;
  readonly points: Float32Array;
  /** Points on the route, counting the one the head is moving to. */
  count: number;
  /** 0..1 along the current hop (1 once it has arrived). */
  hop: number;
  hopSeconds: number;
  /** Seconds to wait at the current city, or (finished) to hold, then fade. */
  wait: number;
  finished: boolean;
  /** 0..1: the route's brightness, fading after a finished trace. */
  level: number;
  trace: number;
  /** The node list's row to redraw, DIRTY_ALL or DIRTY_NONE. */
  dirty: number;
  /** The map's size in design units, for hop lengths. */
  readonly width: number;
  readonly height: number;
  readonly clock: TickClock;
  readonly seed: number;
}

/** A hop's length in design units between map positions. */
function hopLength(m: MapSim, a: number, b: number): number {
  return Math.hypot(
    (m.points[2 * b] - m.points[2 * a]) * m.width,
    (m.points[2 * b + 1] - m.points[2 * a + 1]) * m.height,
  );
}

const scratchUv = new Float32Array(2);

function startTrace(m: MapSim): void {
  m.trace++;
  m.route[0] = Math.floor(unitHash(m.seed, 80, m.trace) * CITIES.length);
  cityUv(m.route[0], m.points, 0);
  m.count = 1;
  m.hop = 1;
  m.wait = 1;
  m.finished = false;
  m.level = 1;
  m.dirty = DIRTY_ALL;
}

/** Picks the next city in reach, further from the start, or returns false when none is. */
function nextHop(m: MapSim): boolean {
  if (m.count > MAX_HOPS) {
    return false;
  }
  const from = m.route[m.count - 1];
  const fx = m.points[2 * (m.count - 1)];
  const fy = m.points[2 * (m.count - 1) + 1];
  const reach = HOP_SPEED * MAX_HOP_SECONDS;
  const start = Math.floor(unitHash(m.seed, 81, m.trace * 16 + m.count) * CITIES.length);
  for (let k = 0; k < CITIES.length; k++) {
    const c = (start + k) % CITIES.length;
    if (c === from || m.route.subarray(0, m.count).includes(c)) {
      continue;
    }
    cityUv(c, scratchUv, 0);
    const d = Math.hypot((scratchUv[0] - fx) * m.width, (scratchUv[1] - fy) * m.height);
    // Always further from where the trace began, so it never doubles back.
    const out = Math.hypot(
      (scratchUv[0] - m.points[0]) * m.width,
      (scratchUv[1] - m.points[1]) * m.height,
    );
    const here = Math.hypot((fx - m.points[0]) * m.width, (fy - m.points[1]) * m.height);
    if (d >= MIN_HOP && d <= reach && out > here + MIN_HOP / 2) {
      m.route[m.count] = c;
      m.points[2 * m.count] = scratchUv[0];
      m.points[2 * m.count + 1] = scratchUv[1];
      m.count++;
      m.hop = 0;
      m.hopSeconds = clamp(
        hopLength(m, m.count - 2, m.count - 1) / HOP_SPEED,
        MIN_HOP_SECONDS,
        MAX_HOP_SECONDS,
      );
      return true;
    }
  }
  return false;
}

export function createMap(seed: number, width: number, height: number): MapSim {
  const m: MapSim = {
    kind: "map",
    route: new Int16Array(MAX_HOPS + 1),
    points: new Float32Array(2 * (MAX_HOPS + 1)),
    count: 0,
    hop: 1,
    hopSeconds: 1,
    wait: 0,
    finished: false,
    level: 1,
    trace: 0,
    dirty: DIRTY_ALL,
    width,
    height,
    clock: { wait: 0 },
    seed,
  };
  startTrace(m);
  return m;
}

/** The trace head's eased position along the current hop, 0..1. */
export const hopEase = (m: MapSim): number => smoothstep(0, 1, m.hop);

function stepMap(m: MapSim, dt: number, pace: number): void {
  if (m.hop < 1) {
    m.hop = Math.min(1, m.hop + dt / m.hopSeconds);
    if (m.hop >= 1) {
      // Arrived: the node list gains a row, then the trace waits a while.
      const row = m.count - 1;
      m.dirty = m.dirty === DIRTY_NONE ? row : DIRTY_ALL;
      m.wait = tickSeconds(pace) * (6 + 6 * unitHash(m.seed, 82, m.trace * 16 + m.count));
    }
    return;
  }
  if (m.finished) {
    m.wait -= dt;
    if (m.wait < TRACE_FADE) {
      m.level = Math.max(0, m.wait / TRACE_FADE);
    }
    if (m.wait <= 0) {
      startTrace(m);
    }
    return;
  }
  m.wait -= dt;
  if (m.wait <= 0 && !nextHop(m)) {
    m.finished = true;
    m.wait = TRACE_HOLD + TRACE_FADE;
    m.dirty = DIRTY_ALL;
  }
}

/** Peak px per frame at 1080p30 of the trace's head over a hop of `length` design units. */
export function hopPeakPx(length: number): number {
  const seconds = clamp(length / HOP_SPEED, MIN_HOP_SECONDS, MAX_HOP_SECONDS);
  return pxPerReferenceFrame((EASE_PEAK * length) / seconds);
}

// ---------------------------------------------------------------------------
// Screens

export type ScreenSim =
  | TerminalSim
  | CodeSim
  | DecryptSim
  | ProgressSim
  | NetworkSim
  | WaveSim
  | MapSim;

/** Hex columns on a decrypt screen: fewer on the narrow portrait ones. */
const decryptCols = (slot: Slot): number => (slot.hw > 0.1 ? 8 : 5);

/** Rows of a decrypt grid and of a progress file list, below their headers. */
const decryptRows = (slot: Slot): number => slotRows(slot) - 3;
const progressRows = (slot: Slot): number => slotRows(slot) - 6;

/** The sim for a screen of `kind` on `slot`. */
export function createScreen(kind: ScreenKind, slot: Slot, seed: number): ScreenSim {
  switch (kind) {
    case "terminal":
      return createTerminal(seed, slotRows(slot) - 1);
    case "code":
      return createCode(seed, slotRows(slot) - 1);
    case "decrypt":
      return createDecrypt(seed, decryptCols(slot), decryptRows(slot));
    case "progress":
      return createProgress(seed, progressRows(slot));
    case "network":
      return createNetwork(seed, 2 * slot.hw, 2 * slot.hh * 0.8);
    case "wave":
      return createWave(seed);
    case "map":
      break;
  }
  return createMap(seed, 2 * slot.hw, 2 * slot.hh);
}

/** Steps a screen by `dt` seconds at `pace`: its ticks, and anything that moves smoothly. */
export function stepScreen(s: ScreenSim, dt: number, pace: number): void {
  const d = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
  const n = dueTicks(s.clock, d, pace);
  switch (s.kind) {
    case "terminal":
      s.stepAge += d;
      for (let i = 0; i < n; i++) {
        tickTerminal(s);
      }
      return;
    case "code":
      s.stepAge += d;
      for (let i = 0; i < n; i++) {
        tickCode(s);
      }
      return;
    case "decrypt":
      for (let i = 0; i < n; i++) {
        tickDecrypt(s);
      }
      return;
    case "progress":
      for (let i = 0; i < n; i++) {
        tickProgress(s);
      }
      return;
    case "network":
      stepNetwork(s, d);
      // The stats change every other tick.
      for (let i = 0; i < n; i++) {
        if (++s.ticks % 2 === 0) {
          s.statsDirty = true;
        }
      }
      return;
    case "wave":
      stepWave(s, d);
      for (let i = 0; i < n; i++) {
        if (++s.ticks % 2 === 0) {
          s.statsDirty = true;
        }
      }
      return;
    case "map":
      stepMap(s, d, pace);
      return;
  }
}

// ---------------------------------------------------------------------------
// Alerts

export const ALERT_TEXTS = ["ACCESS GRANTED", "TRACE DETECTED", "FIREWALL BYPASSED"] as const;
/** The alert shown in red, which tints its screen's glow. */
export const RED_ALERT = 1;
/** Seconds between alerts (the first comes after half a gap), and each one's ramp in, hold and fade. */
export const ALERT_MIN_GAP = 60;
export const ALERT_MAX_GAP = 120;
export const ALERT_IN = 0.5;
export const ALERT_MIN_HOLD = 3;
export const ALERT_MAX_HOLD = 5;
export const ALERT_OUT = 0.8;

interface AlertSim {
  /** Seconds to the next alert, or -1 while alerts are off. */
  wait: number;
  count: number;
  /** The screen showing the alert and which alert it is. */
  slot: number;
  text: number;
  /** 0 idle, 1 ramping in, 2 holding, 3 fading out. */
  phase: number;
  /** 0..1, linear; `alertLevel` eases it. */
  ramp: number;
  hold: number;
  readonly seed: number;
}

export const createAlerts = (seed: number): AlertSim => ({
  wait: -1,
  count: 0,
  slot: -1,
  text: 0,
  phase: 0,
  ramp: 0,
  hold: 0,
  seed,
});

/** The alert banner's opacity, 0..1, eased at both ends. */
export const alertLevel = (a: AlertSim): number => smoothstep(0, 1, a.ramp);

/**
 * Steps the alerts by `dt`: while `on`, one every 60-120 s on a screen that
 * shows fully (`life` by slot), never the one behind the speaker. Turning them
 * off fades the one showing.
 */
export function stepAlerts(a: AlertSim, dt: number, on: boolean, life: ArrayLike<number>): void {
  const d = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (!on) {
    a.wait = -1;
    if (a.phase === 1 || a.phase === 2) {
      a.phase = 3;
    }
  } else if (a.wait < 0 && a.phase === 0) {
    const gap = ALERT_MIN_GAP + (ALERT_MAX_GAP - ALERT_MIN_GAP) * unitHash(a.seed, 90, a.count);
    a.wait = a.count === 0 ? gap / 2 : gap;
  }
  switch (a.phase) {
    case 0:
      if (a.wait >= 0) {
        a.wait -= d;
        if (a.wait <= 0) {
          startAlert(a, life);
        }
      }
      return;
    case 1:
      a.ramp = Math.min(1, a.ramp + d / ALERT_IN);
      if (a.ramp >= 1) {
        a.phase = 2;
      }
      return;
    case 2:
      a.hold -= d;
      if (a.hold <= 0) {
        a.phase = 3;
      }
      return;
    default:
      a.ramp = Math.max(0, a.ramp - d / ALERT_OUT);
      if (a.ramp <= 0) {
        a.phase = 0;
        a.slot = -1;
      }
  }
}

function startAlert(a: AlertSim, life: ArrayLike<number>): void {
  const i = a.count++;
  a.wait = -1;
  let shown = 0;
  for (let s = 0; s < MAX_SCREENS; s++) {
    if (s !== CENTRE_SLOT && life[s] >= 1) {
      shown++;
    }
  }
  if (shown === 0) {
    return;
  }
  let k = Math.floor(unitHash(a.seed, 91, i) * shown);
  for (let s = 0; s < MAX_SCREENS; s++) {
    if (s !== CENTRE_SLOT && life[s] >= 1 && k-- === 0) {
      a.slot = s;
    }
  }
  a.text = Math.floor(unitHash(a.seed, 92, i) * ALERT_TEXTS.length);
  a.hold = ALERT_MIN_HOLD + (ALERT_MAX_HOLD - ALERT_MIN_HOLD) * unitHash(a.seed, 93, i);
  a.phase = 1;
  a.ramp = 0;
}

// ---------------------------------------------------------------------------
// The den

/** Seconds an added screen takes to fade in, and a removed one to fade out. */
const SCREEN_FADE_IN = 1;
const SCREEN_FADE_OUT = 0.8;

interface Den {
  /** Each slot's kind and sim (every slot's, shown or not, so hidden ones keep time). */
  readonly kinds: readonly ScreenKind[];
  readonly screens: readonly ScreenSim[];
  /** How much each slot's monitor shows, 0..1. */
  readonly life: Float32Array;
  readonly alerts: AlertSim;
  readonly fade: ReturnType<typeof createCountFade>;
  started: boolean;
}

export function createDen(seed: number): Den {
  const kinds = assignKinds(seed);
  return {
    kinds,
    screens: kinds.map((kind, s) => createScreen(kind, SLOTS[s], seed + 7919 * (s + 1))),
    life: new Float32Array(MAX_SCREENS),
    alerts: createAlerts(seed),
    fade: createCountFade(MAX_SCREENS),
    started: false,
  };
}

/** The screens param as a count, 5..7. */
export const screenCount = (screens: number): number =>
  clamp(Number.isFinite(screens) ? Math.round(screens) : 6, MIN_SCREENS, MAX_SCREENS);

/** Steps every screen, the monitors' fades and the alerts by `dt` seconds. */
export function stepDen(
  den: Den,
  dt: number,
  pace: number,
  screens: number,
  alerts: boolean,
): void {
  const count = screenCount(screens);
  if (!den.started) {
    den.started = true;
    den.fade.snap(count);
  } else {
    den.fade.step(count, dt, SCREEN_FADE_IN, SCREEN_FADE_OUT);
  }
  for (let i = 0; i < MAX_SCREENS; i++) {
    den.life[ADD_ORDER[i]] = den.fade.life[i];
  }
  for (const s of den.screens) {
    stepScreen(s, dt, pace);
  }
  stepAlerts(den.alerts, dt, alerts, den.life);
}
