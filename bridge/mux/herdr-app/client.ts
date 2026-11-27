import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { HOST } from "../../host.ts";
import type { JsonObject, JsonValue } from "../../json.ts";

// ─────────────────────────────────────────────────────────────────────────────
// herdr-core (`hc`), the program under the Herdr app — the TRANSPORT. This is the only file that
// knows hc's method names and wire shapes; `adapter.ts` next to it is the only file that knows
// these typed methods, and everything above that talks the mux port (bridge/mux/types.ts).
//
// The Herdr app is a window over herdr-core: the core owns the terminals and keeps them alive, the
// app arranges them in spaces and tabs and writes that arrangement onto each terminal as labels.
// So one core connection answers both "which terminals" and "where the app shows them".
//
// Wire facts, each probed against herdr-core 0.1.22 on 2026-11-27 (MUX_CONTRACT.md, source **HA**):
//
//  • **`hc connect` is the API over stdin and stdout**, JSON-RPC 2.0, one message per line, many
//    requests per connection. This client talks to that child rather than to the core's socket,
//    because the socket is a Unix socket on Linux and macOS and a named pipe on Windows, and the
//    child is the same on all three.
//  • **A connection that sent `events.subscribe` carries only notifications after the answer**, so
//    the watch has a child of its own.
//  • **Text goes in together with Enter.** `terminal.send` pastes and submits; `terminal.keys` takes
//    key names and refuses any character outside its own list (`á`, `~`, `"`), so it cannot spell a
//    sentence. There is no call that leaves text unsubmitted. {@link HcClient.typeText} therefore
//    HOLDS the text and {@link HcClient.pressKeys} sends it with the Enter that follows.
//  • **`terminal.send` waits for a quiet terminal**: about 3 s after the program's last output, and
//    up to 60 s while a person at the computer has an unsent draft. It answers `blocked` rather than
//    typing into a program that is showing a dialog.
//  • **Any hc command starts the core when none runs.** A probe therefore costs a small daemon and
//    is otherwise read-only.
// ─────────────────────────────────────────────────────────────────────────────

/** Per-request wall-clock budget for a read, when the target names none. */
export const DEFAULT_HC_TIMEOUT_MS = 5000;

/**
 * The budget of a call that types. Longer than a read's, because the core holds a send until the
 * terminal is quiet. Past it the connection is closed, which is how a held send is withdrawn.
 */
export const HC_WRITE_TIMEOUT_MS = 30_000;

/** How long held text waits for its Enter before it is dropped. */
export const HC_HELD_TEXT_MS = 120_000;

/** The watch calls the stream down when the core has been silent this long (it beats every 15 s). */
export const HC_STREAM_SILENCE_MS = 45_000;

/** The program in a terminal's foreground, as the core reports it. */
export interface WireForeground {
  /** Its name as the OS has it (`node`, `bash`, `codex.exe`). */
  readonly name: string;
  readonly argv: readonly string[];
  /** Its working directory now. Empty when the core could not read it. */
  readonly cwd: string;
}

/** The status record a program reported about itself. The words are the program's own. */
export interface WireStatus {
  /** `idle`, `working`, `done`, `blocked` or `error`. */
  readonly state: string;
  /** Which program reported it (`claude-code`, `codex`). Empty when it did not say. */
  readonly app: string;
}

/** A terminal's labels: free-form `key=value`, which the core never interprets. */
export type HcLabels = Readonly<Record<string, string>>;

/** A terminal, as `terminal.list` and `terminal.get` report it. Only the fields Pastor reads. */
export interface WireTerminal {
  /** `t7`: this terminal forever on this core. A terminal of another machine reads `machine/t7`. */
  readonly address: string;
  /** `live` while its program runs. */
  readonly state: string;
  readonly cwd: string;
  /** The title its program printed. Empty when it printed none. */
  readonly title: string;
  /** The labels on it. The Herdr app writes `herdr.space`, `herdr.tab` and `where`. */
  readonly labels: HcLabels;
  /** Null until a program in it reports one. */
  readonly status: WireStatus | null;
  /** Null once nothing runs in it. */
  readonly foreground: WireForeground | null;
  /** The terminal that started it, or empty. */
  readonly parent: string;
  /** When it was created, in milliseconds. Zero when the core did not say. */
  readonly createdMs: number;
}

/** What `terminal.read` answers. */
export interface WireRead {
  readonly text: string;
  readonly complete: boolean;
}

/** What `hello` says about the core. */
export interface WireHello {
  readonly version: string;
  readonly generation: number;
  /** Stays the same across a restart of the core. */
  readonly coreId: string;
}

/** One change the core announced. `terminal` is empty for a change that names none. */
export interface HcEvent {
  readonly type: string;
  readonly terminal: string;
}

/** An error the core answered. `kind` is its stable word (`not_found`, `blocked`, …). */
export class HcError extends Error {
  constructor(
    readonly kind: string,
    message: string,
  ) {
    super(message);
    this.name = "HcError";
  }
}

/** How one call is carried. */
export interface HcCallOptions {
  /**
   * On a connection of its own, closed when the budget runs out. For a call that types: closing the
   * connection is how a send the core is still holding is withdrawn, so a budget that ran out can
   * never type later.
   */
  readonly own?: boolean;
  readonly timeoutMs?: number;
}

export interface HcStreamHandlers {
  onLine(line: JsonObject): void;
  onEnd(reason: string): void;
}

/**
 * The process seam: everything this client needs from a running `hc connect`.
 *
 * An interface so the client's own rules (held text, the error mapping, the watch) are proved with
 * a scripted wire and no hc on the box. {@link SpawnHcWire} is the one implementation that spawns.
 */
export interface HcWire {
  /** One request and its `result`. A core error is thrown as an {@link HcError}. */
  call(method: string, params: JsonObject, options?: HcCallOptions): Promise<JsonValue>;
  /** Send one request and hand every line that comes back to `handlers`, until closed. */
  stream(method: string, params: JsonObject, handlers: HcStreamHandlers): HcStream;
}

/** The handle a stream or a subscription hands back. `close()` is idempotent. */
export interface HcStream {
  close(): void;
}

/** What {@link HcClient.subscribe} is asked for. */
export interface HcSubscribeOptions {
  onUp(): void;
  onEvent(event: HcEvent): void;
  onDown(reason: string): void;
}

/** hc's own name for a key. */
export type HcKey = string;

const ENTER: HcKey = "enter";

// ── Field readers — the parse. Every `typeof` in this file sits in one of these. ──

function asObject(value: JsonValue | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function str(record: JsonObject, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function num(record: JsonObject, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: JsonValue | undefined): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

function parseLabels(value: JsonValue | undefined) {
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(asObject(value))) {
    if (typeof label === "string") labels[key] = label;
  }
  return labels;
}

function parseTerminal(raw: JsonValue | undefined): WireTerminal {
  const record = asObject(raw);
  const status = asObject(record.status);
  const foreground = asObject(record.foreground);
  return {
    address: str(record, "address"),
    state: str(record, "state"),
    cwd: str(record, "cwd"),
    title: str(record, "title"),
    labels: parseLabels(record.labels),
    status: str(status, "state") === "" ? null : { state: str(status, "state"), app: str(status, "app") },
    foreground:
      record.foreground === null || record.foreground === undefined
        ? null
        : { name: str(foreground, "name"), argv: strings(foreground.argv), cwd: str(foreground, "cwd") },
    parent: str(record, "parent"),
    createdMs: num(record, "created_ms"),
  };
}

interface HeldText {
  text: string;
  at: number;
}

export class HcClient {
  /** Text typed and not yet submitted, per terminal. See the header: hc types only with Enter. */
  private readonly held = new Map<string, HeldText>();

  constructor(
    private readonly wire: HcWire,
    private readonly timeoutMs: number = DEFAULT_HC_TIMEOUT_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async hello(): Promise<WireHello> {
    const answer = asObject(await this.read("hello", { generation: 1 }));
    return {
      version: str(answer, "version"),
      generation: num(answer, "generation"),
      coreId: str(asObject(answer.core), "id"),
    };
  }

  /** Every terminal the core knows that is still running, this machine's and linked machines'. */
  async listTerminals(): Promise<WireTerminal[]> {
    const answer = asObject(await this.read("terminal.list", {}));
    return asArray(answer.terminals)
      .map((entry) => parseTerminal(entry))
      .filter((terminal) => terminal.address !== "");
  }

  async getTerminal(address: string): Promise<WireTerminal> {
    const terminal = parseTerminal(await this.read("terminal.get", { terminal: address }));
    if (terminal.address === "") throw new HcError("not_found", `hc answered no terminal for ${address}`);
    return terminal;
  }

  /** The screen, plus `lines` of history above it, as plain text. */
  async readTerminal(address: string, lines: number): Promise<WireRead> {
    const answer = asObject(await this.read("terminal.read", { terminal: address, lines: Math.max(0, Math.trunc(lines)) }));
    return { text: str(answer, "text"), complete: answer.complete !== false };
  }

  /**
   * Hold text for a terminal until its Enter comes ({@link pressKeys}).
   *
   * The terminal is looked up first, so text aimed at one that has gone is refused now rather than
   * accepted and lost.
   */
  async typeText(address: string, text: string): Promise<void> {
    const terminal = await this.getTerminal(address);
    if (terminal.state !== "live") throw new HcError("finished", `terminal ${address} has ended`);
    const waiting = this.heldFor(address);
    this.held.set(address, { text: waiting + text, at: this.now() });
  }

  /**
   * Press keys, by hc's names, in order.
   *
   * When text is held for the terminal and the first key is Enter, the text goes in with that Enter
   * as one `terminal.send`. Any other first key drops the held text: the program never received it,
   * so a key meant to clear or cancel a draft has nothing left to act on.
   */
  async pressKeys(address: string, keys: readonly HcKey[]): Promise<void> {
    if (keys.length === 0) return;
    const waiting = this.heldFor(address);
    this.held.delete(address);
    let rest = keys;
    if (waiting !== "" && keys[0] === ENTER) {
      await this.write("terminal.send", { terminal: address, text: waiting });
      rest = keys.slice(1);
    }
    if (rest.length > 0) await this.write("terminal.keys", { terminal: address, keys: [...rest] });
  }

  /** Type text and submit it, as one act. Text already held for the terminal goes in front of it. */
  async submitText(address: string, text: string): Promise<void> {
    const waiting = this.heldFor(address);
    this.held.delete(address);
    await this.write("terminal.send", { terminal: address, text: waiting + text });
  }

  async killTerminal(address: string): Promise<void> {
    this.held.delete(address);
    await this.write("terminal.kill", { terminal: address });
  }

  /**
   * Follow the core's changes. `onUp` fires once the core has acknowledged; `onDown` fires exactly
   * once, when the stream ends for any reason; `close()` is idempotent.
   */
  subscribe(options: HcSubscribeOptions): HcStream {
    let up = false;
    let down = false;
    let silence: ReturnType<typeof setTimeout> | null = null;
    const end = (reason: string): void => {
      if (down) return;
      down = true;
      if (silence !== null) clearTimeout(silence);
      stream.close();
      options.onDown(reason);
    };
    const heard = (): void => {
      if (silence !== null) clearTimeout(silence);
      silence = setTimeout(() => end("herdr-core went silent"), HC_STREAM_SILENCE_MS);
    };
    const stream = this.wire.stream("events.subscribe", {}, {
      onLine: (line) => {
        if (down) return;
        heard();
        if (line.error !== undefined) {
          end(str(asObject(line.error), "message") || "herdr-core refused the subscription");
          return;
        }
        if (!up) {
          // The first line is the answer to the subscription. Everything after it is a notification.
          up = true;
          options.onUp();
          return;
        }
        const method = str(line, "method");
        if (method === "event") {
          const params = asObject(line.params);
          options.onEvent({ type: str(params, "type"), terminal: str(params, "terminal") });
        } else if (method === "missed") {
          // The core dropped events for a slow reader and sent a fresh snapshot: look at everything.
          options.onEvent({ type: "missed", terminal: "" });
        }
      },
      onEnd: (reason) => end(reason),
    });
    heard();
    return { close: () => end("closed") };
  }

  private heldFor(address: string): string {
    const waiting = this.held.get(address);
    if (waiting === undefined) return "";
    if (this.now() - waiting.at > HC_HELD_TEXT_MS) {
      this.held.delete(address);
      return "";
    }
    return waiting.text;
  }

  private read(method: string, params: JsonObject): Promise<JsonValue> {
    return this.wire.call(method, params, { timeoutMs: this.timeoutMs });
  }

  private async write(method: string, params: JsonObject): Promise<void> {
    await this.wire.call(method, params, { own: true, timeoutMs: HC_WRITE_TIMEOUT_MS });
  }
}

/**
 * The calls the adapter next door makes — the shape it depends on, rather than this class.
 *
 * A `Pick` of {@link HcClient}, so it cannot drift from the real transport. A fake of this shape is
 * what the conformance fixture drives.
 */
export type HcRpc = Pick<
  HcClient,
  "hello" | "listTerminals" | "getTerminal" | "readTerminal" | "typeText" | "pressKeys" | "submitText" | "killTerminal" | "subscribe"
>;

// ── Finding and running hc ───────────────────────────────────────────────────

/** What {@link resolveHcBinary} reads off the machine. Injected so the search is a pure function. */
export interface HcBinaryProbe {
  readonly platform: string;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  exists(path: string): boolean;
  which(name: string): string | null;
}

/**
 * Where herdr-core's own installers put it, most specific first.
 *
 * `herdr-core` before `hc`: the installer links `hc` only when no other `hc` is on the machine, so
 * the long name is the one that always means this program.
 */
export function hcBinaryCandidates(probe: Pick<HcBinaryProbe, "platform" | "home" | "env">): string[] {
  if (probe.platform === "win32") {
    const local = probe.env.LOCALAPPDATA ?? join(probe.home, "AppData", "Local");
    const dir = join(local, "Programs", "herdr-core");
    return [join(dir, "herdr-core.exe"), join(dir, "hc.exe")];
  }
  return [
    join(probe.home, ".local", "bin", "herdr-core"),
    join(probe.home, ".local", "bin", "hc"),
    "/usr/local/bin/herdr-core",
    "/usr/local/bin/hc",
    "/opt/homebrew/bin/hc",
    "/usr/bin/hc",
  ];
}

/** The hc to run: where its installer puts it, else whichever one PATH names. Null when there is none. */
export function resolveHcBinary(probe: HcBinaryProbe): string | null {
  const installed = hcBinaryCandidates(probe).find((candidate) => probe.exists(candidate));
  return installed ?? probe.which("herdr-core") ?? probe.which("hc");
}

/** The probe of the machine this process runs on. */
export function machineHcProbe(): HcBinaryProbe {
  return {
    platform: HOST.platform,
    home: homedir(),
    env: process.env,
    exists: existsSync,
    which: (name) => Bun.which(name),
  };
}

export const NO_HC_BINARY =
  "herdr-core (hc) was not found. The Herdr app installs it; open the Herdr app once, or install it from https://herdr.dev";

/** The session a core serves, when the operator named one. hc's own default is `default`. */
export function hcSessionEnv(endpoint: string): Record<string, string> {
  const session = endpoint.trim();
  return session === "" ? {} : { HC_SESSION: session };
}

/** `hc server status --json`, the read `pastor start` and `pastor doctor` make of a core. */
export const HC_STATUS_ARGS: readonly string[] = ["server", "status", "--json"];

/** What that read says about a core. */
export interface HcStatus {
  readonly version: string;
  /** How many terminals are running. */
  readonly live: number;
}

/** What that read says, or null when the text is not a core's answer. */
export function parseHcStatus(stdout: string): HcStatus | null {
  const status = parseLine(stdout.trim());
  if (status === null || str(status, "version") === "" || status.live === undefined) return null;
  return { version: str(status, "version"), live: num(status, "live") };
}

/** How `hc connect` is started. */
function connectArgv(binary: string): string[] {
  return [binary, "connect"];
}

interface Waiter {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type HcChild = ReturnType<typeof spawnConnect>;

function spawnConnect(binary: string, env: Record<string, string | undefined>) {
  return Bun.spawn(connectArgv(binary), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env,
    windowsHide: true,
  });
}

async function pumpLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of stream) {
    buffered += decoder.decode(chunk, { stream: true });
    let cut = buffered.indexOf("\n");
    while (cut >= 0) {
      onLine(buffered.slice(0, cut).replace(/\r$/u, ""));
      buffered = buffered.slice(cut + 1);
      cut = buffered.indexOf("\n");
    }
  }
  if (buffered.trim().length > 0) onLine(buffered);
}

function parseLine(line: string): JsonObject | null {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

/** The answer of one JSON-RPC reply line: its result, or the core's error as an {@link HcError}. */
export function replyOf(line: JsonObject): JsonValue {
  if (line.error !== undefined) {
    const error = asObject(line.error);
    throw new HcError(str(asObject(error.data), "kind") || "error", str(error, "message") || "herdr-core answered an error");
  }
  return line.result ?? null;
}

/**
 * The real wire: `hc connect` children.
 *
 * Reads share one long-lived child, so a snapshot is not a process start. A call that types gets a
 * child of its own ({@link HcCallOptions.own}), killed at its budget.
 */
export class SpawnHcWire implements HcWire {
  private shared: HcChild | null = null;
  private readonly waiting = new Map<number, Waiter>();
  private nextId = 1;
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly binary: string | null,
    endpoint: string,
  ) {
    // The bridge may have been started from inside an hc terminal. Its own terminal is not the
    // caller of anything Pastor sends, so that identity does not travel to the child.
    const { HC_TERMINAL_ID: _own, ...inherited } = process.env;
    this.env = { ...inherited, ...hcSessionEnv(endpoint) };
  }

  call(method: string, params: JsonObject, options: HcCallOptions = {}): Promise<JsonValue> {
    const binary = this.binary;
    if (binary === null) return Promise.reject(new Error(NO_HC_BINARY));
    const timeoutMs = options.timeoutMs ?? DEFAULT_HC_TIMEOUT_MS;
    return options.own === true ? this.callOwn(binary, method, params, timeoutMs) : this.callShared(binary, method, params, timeoutMs);
  }

  stream(method: string, params: JsonObject, handlers: HcStreamHandlers): HcStream {
    const binary = this.binary;
    if (binary === null) {
      queueMicrotask(() => handlers.onEnd(NO_HC_BINARY));
      return { close: () => undefined };
    }
    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      handlers.onEnd(reason);
    };
    let child: HcChild;
    try {
      child = spawnConnect(binary, this.env);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
      void child.stdin.flush();
    } catch (err) {
      queueMicrotask(() => end(err instanceof Error ? err.message : String(err)));
      return { close: () => undefined };
    }
    void (async () => {
      try {
        await pumpLines(child.stdout, (text) => {
          const line = parseLine(text);
          if (line !== null && !ended) handlers.onLine(line);
        });
        end("hc connect ended");
      } catch (err) {
        end(err instanceof Error ? err.message : String(err));
      }
    })();
    return {
      close: () => {
        ended = true;
        child.kill();
      },
    };
  }

  private callShared(binary: string, method: string, params: JsonObject, timeoutMs: number): Promise<JsonValue> {
    return new Promise<JsonValue>((resolve, reject) => {
      let child: HcChild;
      try {
        child = this.sharedChild(binary);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`herdr-core did not answer ${method} in ${String(timeoutMs)} ms`));
        // An answer that late is not coming on this connection in order. Start a fresh one.
        this.dropShared(child, "timed out");
      }, timeoutMs);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        void child.stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        this.waiting.delete(id);
        this.dropShared(child, "write failed");
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private sharedChild(binary: string): HcChild {
    if (this.shared !== null) return this.shared;
    const child = spawnConnect(binary, this.env);
    this.shared = child;
    void (async () => {
      let reason = "hc connect ended";
      try {
        await pumpLines(child.stdout, (text) => this.settle(text));
      } catch (err) {
        reason = err instanceof Error ? err.message : String(err);
      }
      this.dropShared(child, reason);
    })();
    return child;
  }

  private settle(text: string): void {
    const line = parseLine(text);
    if (line === null) return;
    const id = num(line, "id");
    const waiter = this.waiting.get(id);
    if (waiter === undefined) return;
    this.waiting.delete(id);
    clearTimeout(waiter.timer);
    try {
      waiter.resolve(replyOf(line));
    } catch (err) {
      waiter.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Retire the shared child and fail whatever was still waiting on it. */
  private dropShared(child: HcChild, reason: string): void {
    if (this.shared !== child) return;
    this.shared = null;
    child.kill();
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`herdr-core connection lost: ${reason}`));
      this.waiting.delete(id);
    }
  }

  private async callOwn(binary: string, method: string, params: JsonObject, timeoutMs: number): Promise<JsonValue> {
    const child = spawnConnect(binary, this.env);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
      void child.stdin.flush();
      let answer: JsonObject | null = null;
      await pumpLines(child.stdout, (text) => {
        if (answer !== null) return;
        const line = parseLine(text);
        if (line === null || line.id !== 1) return;
        answer = line;
        // One request, one answer: the connection has nothing more to say.
        child.kill();
      });
      if (answer === null) {
        throw new HcError(
          timedOut ? "cancelled" : "unavailable",
          timedOut
            ? `herdr-core held ${method} for ${String(Math.round(timeoutMs / 1000))} s, so it was withdrawn. The terminal is busy, or someone is typing in it at the computer.`
            : `herdr-core closed the connection without answering ${method}`,
        );
      }
      return replyOf(answer);
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  }
}
