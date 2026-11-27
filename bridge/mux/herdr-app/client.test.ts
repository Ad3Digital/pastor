import { describe, expect, test } from "bun:test";

import type { JsonObject, JsonValue } from "../../json.ts";
import {
  HC_HELD_TEXT_MS,
  HcClient,
  HcError,
  hcBinaryCandidates,
  hcSessionEnv,
  parseHcStatus,
  replyOf,
  resolveHcBinary,
  type HcCallOptions,
  type HcStream,
  type HcStreamHandlers,
  type HcWire,
} from "./client.ts";

interface Call {
  readonly method: string;
  readonly params: JsonObject;
  readonly own: boolean;
}

/** A scripted wire: it records every call and answers from a table, as the core would. */
class ScriptedWire implements HcWire {
  readonly calls: Call[] = [];
  readonly answers = new Map<string, JsonValue | HcError>();
  handlers: HcStreamHandlers | null = null;
  closed = 0;

  call(method: string, params: JsonObject, options: HcCallOptions = {}): Promise<JsonValue> {
    this.calls.push({ method, params, own: options.own === true });
    const answer = this.answers.get(method) ?? null;
    return answer instanceof HcError ? Promise.reject(answer) : Promise.resolve(answer);
  }

  stream(_method: string, _params: JsonObject, handlers: HcStreamHandlers): HcStream {
    this.handlers = handlers;
    return {
      close: () => {
        this.closed += 1;
      },
    };
  }

  writes(): Call[] {
    return this.calls.filter((call) => call.own);
  }
}

const LIVE: JsonObject = { address: "t7", state: "live", cwd: "/home/dev", title: "", labels: {} };

function clientAt(clock: { now: number }) {
  const wire = new ScriptedWire();
  wire.answers.set("terminal.get", LIVE);
  return { wire, client: new HcClient(wire, 5000, () => clock.now) };
}

describe("text goes in together with Enter", () => {
  test("typed text is held, and the Enter that follows sends both as one terminal.send", async () => {
    const { wire, client } = clientAt({ now: 0 });
    await client.typeText("t7", "olá, ");
    await client.typeText("t7", "tudo bem?");
    expect(wire.writes()).toEqual([]);
    await client.pressKeys("t7", ["enter"]);
    expect(wire.writes()).toEqual([{ method: "terminal.send", params: { terminal: "t7", text: "olá, tudo bem?" }, own: true }]);
  });

  test("keys after that Enter go out as keys, in order", async () => {
    const { wire, client } = clientAt({ now: 0 });
    await client.typeText("t7", "/model");
    await client.pressKeys("t7", ["enter", "down", "enter"]);
    expect(wire.writes().map((call) => [call.method, call.params])).toEqual([
      ["terminal.send", { terminal: "t7", text: "/model" }],
      ["terminal.keys", { terminal: "t7", keys: ["down", "enter"] }],
    ]);
  });

  test("any other first key drops the held text, because the program never received it", async () => {
    const { wire, client } = clientAt({ now: 0 });
    await client.typeText("t7", "a draft nobody sent");
    await client.pressKeys("t7", ["ctrl+c"]);
    await client.pressKeys("t7", ["enter"]);
    expect(wire.writes().map((call) => [call.method, call.params])).toEqual([
      ["terminal.keys", { terminal: "t7", keys: ["ctrl+c"] }],
      ["terminal.keys", { terminal: "t7", keys: ["enter"] }],
    ]);
  });

  test("held text does not outlive its window", async () => {
    const clock = { now: 0 };
    const { wire, client } = clientAt(clock);
    await client.typeText("t7", "stale");
    clock.now = HC_HELD_TEXT_MS + 1;
    await client.pressKeys("t7", ["enter"]);
    expect(wire.writes().map((call) => call.method)).toEqual(["terminal.keys"]);
  });

  test("text is held per terminal", async () => {
    const { wire, client } = clientAt({ now: 0 });
    await client.typeText("t7", "for seven");
    await client.pressKeys("t8", ["enter"]);
    expect(wire.writes().map((call) => [call.method, call.params])).toEqual([["terminal.keys", { terminal: "t8", keys: ["enter"] }]]);
  });

  test("text aimed at a terminal that has gone is refused now, not held", async () => {
    const { wire, client } = clientAt({ now: 0 });
    wire.answers.set("terminal.get", new HcError("not_found", 'no terminal "t9"'));
    await expect(client.typeText("t9", "lost")).rejects.toThrow('no terminal "t9"');
    wire.answers.set("terminal.get", { ...LIVE, state: "finished" });
    await expect(client.typeText("t7", "lost")).rejects.toThrow("has ended");
  });

  test("submitText is one terminal.send, with held text in front", async () => {
    const { wire, client } = clientAt({ now: 0 });
    await client.typeText("t7", "first ");
    await client.submitText("t7", "second");
    expect(wire.writes()).toEqual([{ method: "terminal.send", params: { terminal: "t7", text: "first second" }, own: true }]);
  });

  test("a send the core refuses leaves nothing held", async () => {
    const { wire, client } = clientAt({ now: 0 });
    wire.answers.set("terminal.send", new HcError("blocked", "the program is blocked"));
    await client.typeText("t7", "into a dialog");
    await expect(client.pressKeys("t7", ["enter"])).rejects.toThrow("blocked");
    wire.answers.delete("terminal.send");
    await client.pressKeys("t7", ["enter"]);
    expect(wire.writes().map((call) => call.method)).toEqual(["terminal.send", "terminal.keys"]);
  });
});

describe("reading the core's records", () => {
  test("a terminal is read field by field, with a default where the core said nothing", async () => {
    const wire = new ScriptedWire();
    wire.answers.set("terminal.list", {
      terminals: [
        {
          address: "t3k",
          state: "live",
          cwd: "/home/pl1",
          title: "Aulas",
          labels: { "herdr.space": "sp1", where: "praticas / Claude Code", odd: 7 },
          status: { app: "claude-code", state: "idle" },
          foreground: { name: "claude", argv: ["claude", "--resume", "abc"], cwd: "/home/pl1/aulas", pid: 9 },
          parent: null,
          created_ms: 1795367908576,
        },
        { address: "t4", state: "live" },
        { state: "live" },
      ],
    });
    const terminals = await new HcClient(wire).listTerminals();
    expect(terminals).toEqual([
      {
        address: "t3k",
        state: "live",
        cwd: "/home/pl1",
        title: "Aulas",
        labels: { "herdr.space": "sp1", where: "praticas / Claude Code" },
        status: { app: "claude-code", state: "idle" },
        foreground: { name: "claude", argv: ["claude", "--resume", "abc"], cwd: "/home/pl1/aulas" },
        parent: "",
        createdMs: 1795367908576,
      },
      { address: "t4", state: "live", cwd: "", title: "", labels: {}, status: null, foreground: null, parent: "", createdMs: 0 },
    ]);
  });

  test("a reply line is its result, or the core's error with its stable word", () => {
    expect(replyOf({ id: 1, result: { text: "ok" } })).toEqual({ text: "ok" });
    const refused = { id: 2, error: { code: -32000, data: { kind: "not_found" }, message: 'no terminal "t9"' } };
    expect(() => replyOf(refused)).toThrow(new HcError("not_found", 'no terminal "t9"'));
  });

  test("the status read names the version and the running terminals, or is not a core's answer", () => {
    expect(parseHcStatus('{"version":"0.1.22","live":4,"finished":5}\n')).toEqual({ version: "0.1.22", live: 4 });
    expect(parseHcStatus("")).toBeNull();
    expect(parseHcStatus("hc: cannot reach the core")).toBeNull();
    expect(parseHcStatus('{"version":"0.1.22"}')).toBeNull();
  });
});

describe("the watch", () => {
  test("the first line is the acknowledgement, and each event after it names its terminal", () => {
    const wire = new ScriptedWire();
    const seen: string[] = [];
    const stream = new HcClient(wire).subscribe({
      onUp: () => seen.push("up"),
      onEvent: (event) => seen.push(`${event.type}:${event.terminal}`),
      onDown: (reason) => seen.push(`down:${reason}`),
    });
    wire.handlers?.onLine({ id: 1, result: { seq: 5, terminals: [] } });
    wire.handlers?.onLine({ jsonrpc: "2.0", method: "event", params: { type: "status", terminal: "t7", seq: 6, data: {} } });
    wire.handlers?.onLine({ jsonrpc: "2.0", method: "heartbeat" });
    wire.handlers?.onLine({ jsonrpc: "2.0", method: "missed", params: { seq: 9, terminals: [] } });
    stream.close();
    stream.close();
    expect(seen).toEqual(["up", "status:t7", "missed:", "down:closed"]);
    expect(wire.closed).toBeGreaterThan(0);
  });

  test("a refused subscription and an ended child each report down once", () => {
    const wire = new ScriptedWire();
    const seen: string[] = [];
    new HcClient(wire).subscribe({ onUp: () => seen.push("up"), onEvent: () => seen.push("event"), onDown: (reason) => seen.push(reason) });
    wire.handlers?.onLine({ id: 1, error: { code: -32000, data: { kind: "unavailable" }, message: "the core is restarting" } });
    wire.handlers?.onEnd("hc connect ended");
    expect(seen).toEqual(["the core is restarting"]);
  });
});

describe("finding hc", () => {
  const absent = { exists: () => false, which: () => null };

  test("Windows looks where the installer puts it, under the user's local programs", () => {
    const probe = { platform: "win32", home: "C:\\Users\\Ana", env: { LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local" } };
    const [first, second] = hcBinaryCandidates(probe);
    expect(first).toContain("herdr-core.exe");
    expect(first).toContain("Programs");
    expect(second).toContain("hc.exe");
  });

  test("an installed copy wins over PATH, and PATH is the last resort", () => {
    const probe = { platform: "linux", home: "/home/ana", env: {} };
    const installed = "/home/ana/.local/bin/herdr-core";
    expect(resolveHcBinary({ ...probe, exists: (path) => path === installed, which: () => "/elsewhere/hc" })).toBe(installed);
    expect(resolveHcBinary({ ...probe, ...absent, which: (name) => (name === "hc" ? "/usr/local/sbin/hc" : null) })).toBe("/usr/local/sbin/hc");
    expect(resolveHcBinary({ ...probe, ...absent })).toBeNull();
  });

  test("a named session travels as HC_SESSION, and the default session sets nothing", () => {
    expect(hcSessionEnv("")).toEqual({});
    expect(hcSessionEnv(" aula ")).toEqual({ HC_SESSION: "aula" });
  });
});
