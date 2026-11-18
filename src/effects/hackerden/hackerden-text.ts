/**
 * The made-up text on Hacker Thriller Den's screens, generated from a seed and
 * an index so every screen is deterministic: terminal commands and their
 * output, lines of code with their syntax roles, hex bytes and keys, node and
 * file names, and IP addresses.
 *
 * All of it is film hacking: invented, harmless-looking nonsense. No real tool,
 * exploit, vulnerability or company appears, and every IP address comes from
 * the ranges reserved for documentation (192.0.2.0/24, 198.51.100.0/24 and
 * 203.0.113.0/24), so none of them is anyone's real machine.
 */
import { hash32 } from "../noise";
import { sanitizeText } from "../params";
import { DEFAULT_HANDLE, hackerdenMeta } from "./hackerden.meta";

/** A uniform number in 0..1 from a seed, a salt (one per kind of choice) and an index. */
export function unitHash(seed: number, salt: number, i: number): number {
  const h = hash32(hash32((seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0) ^ hash32(i >>> 0));
  return h / 4294967296;
}

/** An entry of `list` picked by `unitHash`. */
function pick<T>(list: readonly T[], seed: number, salt: number, i: number): T {
  return list[Math.floor(unitHash(seed, salt, i) * list.length)];
}

/** An integer in lo..hi (inclusive) picked by `unitHash`. */
function intIn(lo: number, hi: number, seed: number, salt: number, i: number): number {
  return lo + Math.floor(unitHash(seed, salt, i) * (hi - lo + 1));
}

const SALT_NET = 1;
const SALT_HOST = 2;
const SALT_NODE = 3;
const SALT_NODE_NUM = 4;
const SALT_HEX = 5;
const SALT_COMMAND = 6;
const SALT_COMMAND_ARG = 7;
const SALT_OUTPUTS = 8;
const SALT_OUTPUT = 9;
const SALT_OUTPUT_ARG = 10;
const SALT_TASK = 11;
const SALT_FILE = 12;
const SALT_FILE_NUM = 13;
const SALT_EXT = 14;
const SALT_BLOCK = 15;
const SALT_CODE = 16;

/** The three networks reserved for documentation, whose addresses no real machine has. */
const DOC_NETWORKS = ["192.0.2", "198.51.100", "203.0.113"] as const;

/** An address from the documentation ranges, host 1..254. */
export function docIp(seed: number, i: number): string {
  const net = pick(DOC_NETWORKS, seed, SALT_NET, i);
  return `${net}.${String(intIn(1, 254, seed, SALT_HOST, i))}`;
}

const NODE_PREFIXES = [
  "RELAY",
  "NODE",
  "GATE",
  "PROXY",
  "HUB",
  "ECHO",
  "SHADE",
  "VAULT",
  "SPIRE",
  "WRAITH",
  "ORBIT",
  "CIPHER",
] as const;

/** A made-up node name such as "RELAY-07". */
export function nodeName(seed: number, i: number): string {
  const n = intIn(1, 99, seed, SALT_NODE_NUM, i);
  return `${pick(NODE_PREFIXES, seed, SALT_NODE, i)}-${String(n).padStart(2, "0")}`;
}

const HEX = "0123456789ABCDEF";

/** A byte as two upper-case hex digits. */
function hexByte(seed: number, i: number): string {
  const b = hash32(hash32((seed ^ Math.imul(SALT_HEX, 0x85ebca6b)) >>> 0) ^ hash32(i >>> 0)) & 255;
  return HEX[b >> 4] + HEX[b & 15];
}

/** Four hex digits, from two bytes. */
const hexWord = (seed: number, i: number) => hexByte(seed, 2 * i) + hexByte(seed, 2 * i + 1);

/** Characters a terminal line holds. */
export const TERMINAL_COLUMNS = 44;
/** The longest command typed after the prompt, so the longest handle's prompt still fits. */
export const MAX_COMMAND_LENGTH = 20;

/**
 * The handle param as the prompt shows it: sanitised as the text param is
 * (so a value that didn't come through the panel is safe too), spaces turned
 * into underscores, and the default when nothing is left.
 */
export function promptHandle(raw: string): string {
  const def = hackerdenMeta.params.handle;
  const clean = sanitizeText(def, raw)
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "");
  return clean === "" ? DEFAULT_HANDLE : clean;
}

/** The terminal's prompt for `handle` (already through `promptHandle`), ending in a space. */
export const promptFor = (handle: string): string => `${handle}@den:~$ `;

type CommandTemplate = (seed: number, i: number) => string;

const COMMANDS: readonly CommandTemplate[] = [
  (s, i) => `trace ${docIp(s, i)}`,
  (s, i) => `ping ${docIp(s, i)}`,
  (s, i) => `relay ${docIp(s, i)}`,
  () => "bypass --stealth",
  () => "decrypt vault.key",
  (s, i) => `scan --deep -p ${String(intIn(1000, 9999, s, SALT_COMMAND_ARG, i))}`,
  () => "spoof --mac-random",
  () => "mask signal -v",
  (s, i) => `unlock gate.${String(intIn(1, 99, s, SALT_COMMAND_ARG, i)).padStart(2, "0")}`,
  () => "sync mirror --all",
  () => "compile core.c",
  (s, i) => `upload pkt_${String(intIn(1000, 9999, s, SALT_COMMAND_ARG, i))}.dat`,
  () => "status --verbose",
  (s, i) => `locate ${nodeName(s, i).toLowerCase()}`,
  () => "handshake -k 4096",
  () => "list /vault",
  () => "override --level 5",
  () => "ghost --on",
];

/** The `i`th command typed at the prompt. */
export function terminalCommand(seed: number, i: number): string {
  return pick(COMMANDS, seed, SALT_COMMAND, i)(seed, i);
}

/** How many output lines the `i`th command prints. */
export function terminalOutputCount(seed: number, i: number): number {
  return intIn(1, 5, seed, SALT_OUTPUTS, i);
}

const OUTPUTS: readonly CommandTemplate[] = [
  () => "[ok] handshake complete",
  (s, i) => `routing via ${docIp(s, i)}`,
  (s, i) => `resolving ${nodeName(s, i)}...`,
  (s, i) => {
    const n = String(intIn(256, 8192, s, SALT_OUTPUT_ARG, i));
    return `packets ${n}/${n} received`;
  },
  (s, i) => `signal locked: ${String(intIn(4, 220, s, SALT_OUTPUT_ARG, i))} ms`,
  (s, i) => `checksum ${hexWord(s, i)}-${hexWord(s, i + 7919)}`,
  (s, i) => `[..] ${nodeName(s, i)} responding`,
  (s, i) => `access level ${String(intIn(1, 5, s, SALT_OUTPUT_ARG, i))} confirmed`,
  (s, i) => `firewall layer ${String(intIn(1, 9, s, SALT_OUTPUT_ARG, i))} offline`,
  (s, i) => `key fragment ${hexWord(s, i)}${hexWord(s, i + 104729)}`,
  () => "connection secured",
  (s, i) => `${String(intIn(12, 4096, s, SALT_OUTPUT_ARG, i))} blocks verified`,
  (s, i) => `[!!] ${nodeName(s, i)} timeout, retrying`,
  (s, i) => `tunnel open on port ${String(intIn(1024, 65000, s, SALT_OUTPUT_ARG, i))}`,
  (s, i) => `mirror ${String(intIn(3, 99, s, SALT_OUTPUT_ARG, i))}% synced`,
  (s, i) => `${docIp(s, i)} -> ${docIp(s, i + 15485863)}`,
];

/** Line `j` of the `i`th command's output. */
export function terminalOutput(seed: number, i: number, j: number): string {
  const k = i * 8 + j;
  return pick(OUTPUTS, seed, SALT_OUTPUT, k)(seed, k);
}

const TASKS = ["UPLOADING", "COMPILING", "DOWNLOADING", "ENCRYPTING", "SYNCING"] as const;

/** The progress screen's `i`th task, in capitals. */
export function progressTask(seed: number, i: number): string {
  return pick(TASKS, seed, SALT_TASK, i);
}

const FILE_STEMS = [
  "archive",
  "shadow",
  "vault",
  "ledger",
  "blueprint",
  "relay",
  "cipher",
  "signal",
  "keyring",
  "nightly",
  "payload",
  "core",
] as const;
const FILE_EXTS = ["dat", "bin", "enc", "pkg", "log", "img"] as const;

/** File `j` of the progress screen's `i`th task, such as "vault_07.enc". */
export function progressFile(seed: number, i: number, j: number): string {
  const k = i * 64 + j;
  const n = String(intIn(1, 99, seed, SALT_FILE_NUM, k)).padStart(2, "0");
  return `${pick(FILE_STEMS, seed, SALT_FILE, k)}_${n}.${pick(FILE_EXTS, seed, SALT_EXT, k)}`;
}

/** How a part of a line of code is coloured: plain, a comment, or a keyword or literal. */
const CODE_PLAIN = 0;
export const CODE_COMMENT = 1;
export const CODE_ACCENT = 2;
type CodeRole = typeof CODE_PLAIN | typeof CODE_COMMENT | typeof CODE_ACCENT;

interface CodePart {
  readonly text: string;
  readonly role: CodeRole;
}

/** A line of code: its indent (in levels) and its coloured parts, left to right. */
export interface CodeLine {
  readonly indent: number;
  readonly parts: readonly CodePart[];
}

const FUNCTIONS = [
  "decrypt_stream",
  "route_packet",
  "mask_trace",
  "open_tunnel",
  "verify_key",
  "spoof_signal",
  "sync_mirror",
  "split_payload",
  "seal_vault",
  "ghost_node",
  "rotate_cipher",
  "scramble",
] as const;
const CALLS = ["mix", "fold", "xor", "shift", "pack", "seal", "probe", "hash", "spin"] as const;
const VARS = [
  "block",
  "key",
  "buf",
  "node",
  "sig",
  "hops",
  "frame",
  "mask",
  "salt",
  "link",
] as const;
const METHODS = ["checksum", "len", "peek", "flip", "digest", "ping"] as const;
const STRINGS = ["retry", "locked", "handshake", "no route", "relay up", "clean"] as const;
const COMMENTS = [
  "route packets through the relay ring",
  "fold the key into each block",
  "keep the trace under the noise floor",
  "never touch the same node twice",
  "rotate before the window closes",
  "hand off to the mirror",
  "TODO: faster",
] as const;

const kw = (text: string): CodePart => ({ text, role: CODE_ACCENT });
const id = (text: string): CodePart => ({ text, role: CODE_PLAIN });
const line = (indent: number, ...parts: CodePart[]): CodeLine => ({ indent, parts });

/**
 * Block `b` of an endless made-up source file: an optional comment, a function
 * with a few statements (some inside a loop or a test), its closing brace and a
 * blank line.
 */
export function codeBlock(seed: number, b: number): CodeLine[] {
  let n = 0;
  const u = () => unitHash(seed, SALT_CODE, b * 97 + n++);
  const from = <T>(list: readonly T[]): T => list[Math.floor(u() * list.length)];
  const num = () => String(Math.floor(u() * 250) + 2);
  const hex = () => `0x${hexWord(seed, b * 31 + n++).toLowerCase()}`;

  const out: CodeLine[] = [];
  if (unitHash(seed, SALT_BLOCK, b) < 0.6) {
    out.push(line(0, { text: `// ${from(COMMENTS)}`, role: CODE_COMMENT }));
  }
  const a = from(VARS);
  const v = from(VARS);
  out.push(line(0, kw("fn "), id(`${from(FUNCTIONS)}(${a}, ${v}) {`)));
  out.push(line(1, kw("let "), id(`${v} = ${from(CALLS)}(${a}, `), kw(num()), id(");")));
  const statements = 2 + Math.floor(u() * 4);
  for (let s = 0; s < statements; s++) {
    const r = u();
    if (r < 0.25) {
      out.push(line(1, kw("for "), id("i "), kw("in "), kw(`0..${num()}`), id(" {")));
      out.push(line(2, id(`${v} = ${from(CALLS)}(${v}, ${from(VARS)}[i]);`)));
      out.push(line(1, id("}")));
    } else if (r < 0.45) {
      out.push(line(1, kw("if "), id(`${v}.${from(METHODS)}() != `), kw(hex()), id(" {")));
      out.push(line(2, id("log("), kw(`"${from(STRINGS)}"`), id(`, ${v});`)));
      out.push(line(1, id("}")));
    } else if (r < 0.7) {
      out.push(line(1, id(`${v} = ${from(CALLS)}(${v}, `), kw(hex()), id(");")));
    } else if (r < 0.85) {
      out.push(line(1, id(`${from(CALLS)}(${v}.${from(METHODS)}());`)));
    } else {
      out.push(line(1, kw("let "), id(`${from(VARS)} = ${v}.${from(METHODS)}();`)));
    }
  }
  out.push(line(1, kw("return "), id(`${v};`)));
  out.push(line(0, id("}")));
  out.push(line(0));
  return out;
}

/** A line of code as plain text, indented two spaces a level. */
export function codeText(l: CodeLine): string {
  let s = "  ".repeat(l.indent);
  for (const p of l.parts) {
    s += p.text;
  }
  return s;
}
