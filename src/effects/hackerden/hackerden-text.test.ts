import { describe, expect, it } from "vitest";
import { HANDLE_MAX_LENGTH } from "./hackerden.meta";
import {
  codeBlock,
  codeText,
  docIp,
  MAX_COMMAND_LENGTH,
  nodeName,
  progressFile,
  progressTask,
  promptFor,
  promptHandle,
  TERMINAL_COLUMNS,
  terminalCommand,
  terminalOutput,
  terminalOutputCount,
} from "./hackerden-text";

const SEEDS = [1, 20_611, 987_654_321];

/** Every dotted quad in `s`. */
const ips = (s: string) => s.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];

/** Whether `ip` is in one of the documentation ranges, with a usable host. */
function isDocIp(ip: string): boolean {
  const m = /^(192\.0\.2|198\.51\.100|203\.0\.113)\.(\d+)$/.exec(ip);
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 254;
}

/** All the terminal text for the first `n` commands. */
function terminalText(seed: number, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(terminalCommand(seed, i));
    for (let j = 0; j < terminalOutputCount(seed, i); j++) {
      out.push(terminalOutput(seed, i, j));
    }
  }
  return out;
}

describe("hacker den text", () => {
  it.each(SEEDS)("is the same every time for seed %i", (seed) => {
    expect(terminalText(seed, 50)).toEqual(terminalText(seed, 50));
    expect(codeBlock(seed, 3)).toEqual(codeBlock(seed, 3));
    expect(docIp(seed, 9)).toBe(docIp(seed, 9));
    expect(nodeName(seed, 9)).toBe(nodeName(seed, 9));
  });

  it("differs between seeds", () => {
    expect(terminalText(1, 30)).not.toEqual(terminalText(2, 30));
  });

  it.each(SEEDS)("only uses documentation-range addresses (seed %i)", (seed) => {
    const lines = terminalText(seed, 400);
    for (let i = 0; i < 400; i++) {
      lines.push(docIp(seed, i));
    }
    const found = lines.flatMap((l) => ips(l));
    expect(found.length).toBeGreaterThan(50);
    expect(found.filter((ip) => !isDocIp(ip))).toEqual([]);
  });

  it.each(SEEDS)("fits every command after the longest prompt (seed %i)", (seed) => {
    const prompt = promptFor("x".repeat(HANDLE_MAX_LENGTH));
    for (let i = 0; i < 400; i++) {
      const c = terminalCommand(seed, i);
      expect(c.length).toBeLessThanOrEqual(MAX_COMMAND_LENGTH);
      expect(prompt.length + c.length).toBeLessThanOrEqual(TERMINAL_COLUMNS);
      for (let j = 0; j < terminalOutputCount(seed, i); j++) {
        expect(terminalOutput(seed, i, j).length).toBeLessThanOrEqual(TERMINAL_COLUMNS);
      }
    }
  });

  it.each([
    ["ghost", "ghost"],
    ["", "ghost"],
    ["   ", "ghost"],
    ["zero cool", "zero_cool"],
    ["  acid  burn ", "acid_burn"],
    ["a\u0007b‮c", "abc"],
    ["neo\u{1F600}", "neo"],
    ["line one\nline two", "line_one"],
    ["x".repeat(40), "x".repeat(HANDLE_MAX_LENGTH)],
  ])("sanitises the handle %j", (raw, handle) => {
    expect(promptHandle(raw)).toBe(handle);
    expect(promptFor(promptHandle(raw))).toBe(`${handle}@den:~$ `);
  });

  it("names nodes, tasks and files in capitals or plain words", () => {
    for (let i = 0; i < 100; i++) {
      expect(nodeName(5, i)).toMatch(/^[A-Z]+-\d\d$/);
      expect(progressTask(5, i)).toMatch(/^[A-Z]+$/);
      expect(progressFile(5, i, 3)).toMatch(/^[a-z]+_\d\d\.[a-z]+$/);
    }
  });

  it.each(SEEDS)("writes code in balanced blocks (seed %i)", (seed) => {
    for (let b = 0; b < 40; b++) {
      const block = codeBlock(seed, b);
      const text = block.map((l) => codeText(l)).join("\n");
      expect(text.split("{").length).toBe(text.split("}").length);
      expect(block.at(-1)?.parts).toEqual([]);
      expect(ips(text)).toEqual([]);
    }
  });
});
