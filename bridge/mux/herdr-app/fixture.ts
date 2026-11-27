import type { MuxConformanceFixture, MuxConformanceWorld, MuxWrite } from "../conformance.ts";
import { HERDR_APP_MUX, HerdrAppMux } from "./adapter.ts";
import { HcError, type HcKey, type HcRpc, type HcStream, type HcSubscribeOptions, type WireHello, type WireRead, type WireTerminal } from "./client.ts";

// An in-memory herdr-core, for conformance: the `HcRpc` the adapter depends on, answered the way the
// real core answers it (MUX_CONTRACT.md § The Herdr app, source **HA**), with no hc on the box.
//
// It is as strict as the core where the adapter can tell the difference: a terminal that has gone
// answers `not_found`, exactly as `terminal.get` does, and a linked machine's terminal is in the
// listing under `machine/t7`, which the adapter must leave out.
//
// Two spaces, because one core holds any number: the app's `herdr.space` label is the space.
//
// NO `focusOutOfBand`: the core does not know which pane the app's window shows, so this world is
// held to the opposite promise — no pane is ever reported focused and `setFocus` is unsupported.

interface FakeTerminal {
  readonly address: string;
  readonly cwd: string;
  readonly createdMs: number;
  labels: Record<string, string>;
  title: string;
  name: string | null;
  status: { state: string; app: string } | null;
  foreground: { name: string; argv: string[]; cwd: string };
  parent: string;
  screen: string[];
  history: string[];
  turn: number;
}

interface Subscriber {
  readonly options: HcSubscribeOptions;
  down: boolean;
}

function notFound(address: string): HcError {
  return new HcError("not_found", `no terminal "${address}"`);
}

export class FakeHc implements HcRpc {
  private terminals: FakeTerminal[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly written: MuxWrite[] = [];
  private minted = 0;
  private changes = 0;

  constructor() {
    this.seed();
  }

  // ── HcRpc ──────────────────────────────────────────────────────────────────

  hello(): Promise<WireHello> {
    return Promise.resolve({ version: "0.1.22", generation: 1, coreId: "a120aaeaab37ccddf91283b9fc224e51" });
  }

  listTerminals(): Promise<WireTerminal[]> {
    const local = this.terminals.map((terminal) => this.wire(terminal));
    // A terminal on a linked machine, as the core lists it. It is not this machine's pane.
    const linked: WireTerminal = {
      address: "vps/t1",
      state: "live",
      cwd: "/root",
      title: "",
      labels: {},
      status: null,
      foreground: null,
      parent: "",
      createdMs: 1_795_000_000_999,
    };
    return Promise.resolve([...local, linked]);
  }

  getTerminal(address: string): Promise<WireTerminal> {
    const terminal = this.find(address);
    return terminal === undefined ? Promise.reject(notFound(address)) : Promise.resolve(this.wire(terminal));
  }

  readTerminal(address: string, lines: number): Promise<WireRead> {
    const terminal = this.find(address);
    if (terminal === undefined) return Promise.reject(notFound(address));
    const above = lines <= 0 ? [] : terminal.history.slice(-lines);
    return Promise.resolve({ text: [...above, ...terminal.screen].join("\n"), complete: true });
  }

  typeText(address: string, text: string): Promise<void> {
    if (this.find(address) === undefined) return Promise.reject(notFound(address));
    this.written.push({ paneId: address, kind: "text", payload: [text] });
    return Promise.resolve();
  }

  pressKeys(address: string, keys: readonly HcKey[]): Promise<void> {
    const terminal = this.find(address);
    if (terminal === undefined) return Promise.reject(notFound(address));
    this.written.push({ paneId: address, kind: "keys", payload: [...keys] });
    terminal.screen = [...terminal.screen, `keys: ${keys.join(" ")}`];
    return Promise.resolve();
  }

  submitText(address: string, text: string): Promise<void> {
    const terminal = this.find(address);
    if (terminal === undefined) return Promise.reject(notFound(address));
    this.written.push({ paneId: address, kind: "text", payload: [text] });
    this.written.push({ paneId: address, kind: "keys", payload: ["enter"] });
    terminal.screen = [...terminal.screen, text];
    return Promise.resolve();
  }

  killTerminal(address: string): Promise<void> {
    if (this.find(address) === undefined) return Promise.reject(notFound(address));
    this.terminals = this.terminals.filter((terminal) => terminal.address !== address);
    this.emit("finished", address);
    this.emit("removed", address);
    return Promise.resolve();
  }

  subscribe(options: HcSubscribeOptions): HcStream {
    const subscriber: Subscriber = { options, down: false };
    this.subscribers.add(subscriber);
    queueMicrotask(() => {
      if (!subscriber.down) options.onUp();
    });
    return { close: () => this.drop(subscriber, "closed") };
  }

  // ── What the conformance world asks of it ──────────────────────────────────

  writes(): readonly MuxWrite[] {
    return this.written;
  }

  /** The connection drops: every open stream ends. The terminals are untouched. */
  reconnect(): Promise<void> {
    this.dropAll("hc connect ended");
    return Promise.resolve();
  }

  /** The core restarts and adopts its terminals: same addresses, fresh records. */
  restartMux(): Promise<void> {
    this.dropAll("hc connect ended");
    this.terminals = this.terminals.map((terminal) => ({
      ...terminal,
      labels: { ...terminal.labels },
      screen: [...terminal.screen],
      history: [...terminal.history],
    }));
    return Promise.resolve();
  }

  /** Someone names the terminal with `hc`'s own `--name`. The adapter reports no pane label at all. */
  renameOutOfBand(address: string, label: string): Promise<void> {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.name = label.toLowerCase().replaceAll(/[^a-z0-9_-]/gu, "-").slice(0, 32);
    return Promise.resolve();
  }

  setProgramTitle(address: string, title: string): Promise<void> {
    const terminal = this.find(address);
    if (terminal !== undefined) terminal.title = title;
    return Promise.resolve();
  }

  changePane(address: string): Promise<void> {
    const terminal = this.find(address);
    if (terminal !== undefined) {
      this.changes += 1;
      terminal.screen = [...terminal.screen, `painted ${String(this.changes)}`];
    }
    return Promise.resolve();
  }

  endPane(address: string): Promise<void> {
    this.terminals = this.terminals.filter((terminal) => terminal.address !== address);
    return Promise.resolve();
  }

  /** The app renames a tab, which rewrites `where` on its terminals. Nothing is announced here. */
  pokeTopologyOutOfBand(): Promise<void> {
    const first = this.terminals.at(0);
    if (first !== undefined) {
      this.changes += 1;
      const tab = first.labels["herdr.tab"];
      for (const terminal of this.terminals) {
        if (terminal.labels["herdr.tab"] === tab) terminal.labels = { ...terminal.labels, where: `pastor / renamed ${String(this.changes)}` };
      }
    }
    return Promise.resolve();
  }

  pokeTopology(): void {
    const added = this.add("spb1f0f5de73340f1cb8f64af9e0bfd732", "tb00000000000000000000000000000003", "pastor / extra", "/home/dev/pastor");
    this.emit("created", added.address);
  }

  pokePane(address: string): void {
    const terminal = this.find(address);
    if (terminal === undefined) return;
    terminal.turn += 1;
    this.emit("status", address);
  }

  shutdown(): void {
    this.dropAll("closed");
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private find(address: string): FakeTerminal | undefined {
    return this.terminals.find((terminal) => terminal.address === address);
  }

  private emit(type: string, terminal: string): void {
    for (const subscriber of this.subscribers) {
      if (!subscriber.down) subscriber.options.onEvent({ type, terminal });
    }
  }

  /** End every open stream. The set is copied first, because ending one removes it. */
  private dropAll(reason: string): void {
    const open = Array.from(this.subscribers);
    for (const subscriber of open) this.drop(subscriber, reason);
  }

  private drop(subscriber: Subscriber, reason: string): void {
    if (subscriber.down) return;
    subscriber.down = true;
    this.subscribers.delete(subscriber);
    subscriber.options.onDown(reason);
  }

  private wire(terminal: FakeTerminal): WireTerminal {
    return {
      address: terminal.address,
      state: "live",
      cwd: terminal.cwd,
      title: terminal.title,
      labels: { ...terminal.labels },
      status: terminal.status === null ? null : { ...terminal.status },
      foreground: { ...terminal.foreground, argv: [...terminal.foreground.argv] },
      parent: terminal.parent,
      createdMs: terminal.createdMs,
    };
  }

  private add(space: string | null, tab: string | null, where: string, cwd: string): FakeTerminal {
    this.minted += 1;
    const labels: Record<string, string> = {};
    if (space !== null) labels["herdr.space"] = space;
    if (tab !== null) labels["herdr.tab"] = tab;
    if (where !== "") labels.where = where;
    const terminal: FakeTerminal = {
      // The core never hands an address out twice, so the counter only climbs.
      address: `t${String(this.minted)}`,
      cwd,
      createdMs: 1_795_000_000_000 + this.minted,
      labels,
      title: "",
      name: null,
      status: null,
      foreground: { name: "bash", argv: ["/usr/bin/bash"], cwd },
      parent: "",
      screen: [`$ shell in ${cwd}`, `terminal t${String(this.minted)} on screen`],
      history: Array.from({ length: 30 }, (_, i) => `scrollback line ${String(i)} of t${String(this.minted)}`),
      turn: 0,
    };
    this.terminals.push(terminal);
    return terminal;
  }

  private seed(): void {
    const pastor = "spb1f0f5de73340f1cb8f64af9e0bfd732";
    const agent = this.add(pastor, "tb00000000000000000000000000000001", "pastor / Claude Code", "/home/dev/pastor");
    agent.status = { state: "blocked", app: "claude-code" };
    agent.foreground = { name: "claude", argv: ["claude", "--resume", "0a1b2c3d-1111-4222-8333-444455556666"], cwd: "/home/dev/pastor" };
    agent.labels = { ...agent.labels, "resume.agent": "claude", "resume.session": "0a1b2c3d-1111-4222-8333-444455556666" };
    agent.title = "✳ Writing the conformance suite";
    this.add(pastor, "tb00000000000000000000000000000002", "pastor / 2", "/home/dev/pastor");
    // An agent's helper, started with `hc run`: no place of its own, so it sits with its parent.
    const helper = this.add(null, null, "", "/home/dev/pastor");
    helper.parent = agent.address;
    this.add("sp00000000000000000000000000000002", "tb00000000000000000000000000000004", "scratch / 1", "/tmp");
  }
}

export function herdrAppWorld(fake: FakeHc): MuxConformanceWorld {
  return {
    adapter: new HerdrAppMux(fake),
    writes: () => fake.writes(),
    reconnect: () => fake.reconnect(),
    restartMux: () => fake.restartMux(),
    renameOutOfBand: (paneId, label) => fake.renameOutOfBand(paneId, label),
    setProgramTitle: (paneId, title) => fake.setProgramTitle(paneId, title),
    changePane: (paneId) => fake.changePane(paneId),
    endPane: (paneId) => fake.endPane(paneId),
    pokeTopologyOutOfBand: () => fake.pokeTopologyOutOfBand(),
    pokeTopology: () => fake.pokeTopology(),
    pokePane: (paneId) => fake.pokePane(paneId),
    close: () => {
      fake.shutdown();
      return Promise.resolve();
    },
  };
}

export const herdrAppConformanceFixture: MuxConformanceFixture = {
  mux: HERDR_APP_MUX,
  create(): Promise<MuxConformanceWorld> {
    return Promise.resolve(herdrAppWorld(new FakeHc()));
  },
};
