import { describe, expect, it } from "vitest";
import { createGpuTimer } from "./gpuTimer";
import { defined } from "../test/defined";

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;
const QUERY_RESULT = 0x8866;
const QUERY_RESULT_AVAILABLE = 0x8867;

interface FakeQuery {
  id: number;
  ns: number;
  available: boolean;
  deleted: boolean;
}

/** A fake context whose queries finish only when `finish()` is called. */
function fakeGl({ supported = true, gpuNsPerFrame = 2_000_000 } = {}) {
  const queries: FakeQuery[] = [];
  let active: FakeQuery | undefined;
  const state = { disjoint: false, begun: 0 };
  const gl = {
    QUERY_RESULT,
    QUERY_RESULT_AVAILABLE,
    getExtension: (name: string) =>
      supported && name === "EXT_disjoint_timer_query_webgl2"
        ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT }
        : null,
    createQuery: () => {
      const q = { id: queries.length, ns: 0, available: false, deleted: false };
      queries.push(q);
      return q;
    },
    deleteQuery: (q: FakeQuery) => {
      q.deleted = true;
    },
    beginQuery: (target: number, q: FakeQuery) => {
      expect(target).toBe(TIME_ELAPSED_EXT);
      expect(active).toBeUndefined();
      expect(q.deleted).toBe(false);
      q.available = false;
      q.ns = gpuNsPerFrame;
      active = q;
      state.begun++;
    },
    endQuery: (target: number) => {
      expect(target).toBe(TIME_ELAPSED_EXT);
      expect(active).toBeDefined();
      active = undefined;
    },
    getQueryParameter: (q: FakeQuery, pname: number) =>
      pname === QUERY_RESULT_AVAILABLE ? q.available : q.ns,
    getParameter: (pname: number) => {
      expect(pname).toBe(GPU_DISJOINT_EXT);
      return state.disjoint;
    },
  };
  const finish = () => {
    for (const q of queries) if (q !== active) q.available = true;
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    queries,
    state,
    finish,
    isActive: () => active !== undefined,
  };
}

describe("createGpuTimer", () => {
  it("returns undefined without the extension", () => {
    expect(createGpuTimer(fakeGl({ supported: false }).gl)).toBeUndefined();
  });

  it("averages finished frames in ms and resets after each read", () => {
    const fake = fakeGl({ gpuNsPerFrame: 3_000_000 });
    const timer = defined(createGpuTimer(fake.gl));
    expect(timer.takeAverage()).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      timer.begin();
      timer.end();
    }
    expect(timer.takeAverage()).toBeUndefined();
    fake.finish();
    expect(timer.takeAverage()).toBeCloseTo(3);
    expect(timer.takeAverage()).toBeUndefined();
  });

  it("skips frames while every query is in flight, then resumes", () => {
    const fake = fakeGl();
    const timer = defined(createGpuTimer(fake.gl));
    for (let i = 0; i < 10; i++) {
      timer.begin();
      timer.end();
    }
    expect(fake.state.begun).toBe(4);
    fake.finish();
    timer.begin();
    timer.end();
    expect(fake.state.begun).toBe(5);
    expect(timer.takeAverage()).toBeCloseTo(2);
  });

  it("drops results from a disjoint period", () => {
    const fake = fakeGl();
    const timer = defined(createGpuTimer(fake.gl));
    timer.begin();
    timer.end();
    fake.finish();
    fake.state.disjoint = true;
    expect(timer.takeAverage()).toBeUndefined();
  });

  it("ignores end without begin and a nested begin", () => {
    const fake = fakeGl();
    const timer = defined(createGpuTimer(fake.gl));
    timer.end();
    timer.begin();
    timer.begin();
    expect(fake.state.begun).toBe(1);
    timer.end();
    expect(fake.isActive()).toBe(false);
  });

  it("ends an active query and deletes all queries on dispose", () => {
    const fake = fakeGl();
    const timer = defined(createGpuTimer(fake.gl));
    timer.begin();
    timer.dispose();
    expect(fake.isActive()).toBe(false);
    expect(fake.queries.every((q) => q.deleted)).toBe(true);
  });
});
