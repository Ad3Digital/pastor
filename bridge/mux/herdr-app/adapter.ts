import { meaningfulTabLabel, meaningfulTerminalTitle } from "../../activity.ts";
import type { ForegroundProcess } from "../../journal/types.ts";
import type { AgentStatus } from "../../types.ts";
import { MUX_AGENT_NAMES } from "../agents.ts";
import { declareCapabilities } from "../capabilities.ts";
import { HERDR_LOGO_SVG } from "../herdr/logo.ts";
import type { MuxAdapterFactory, MuxTarget } from "../registry.ts";
import {
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  type MuxAck,
  type MuxAdapter,
  type MuxCreatedPane,
  type MuxGrid,
  type MuxGridRequest,
  type MuxOutcome,
  type MuxPane,
  type MuxRefusalOutcome,
  type MuxSession,
  type MuxSnapshot,
  type MuxSpace,
  type MuxSpaceRequest,
  type MuxSubscription,
  type MuxTab,
  type MuxTabRequest,
  type MuxWatchOptions,
  type MuxWorktree,
  type MuxWorktreeCreateRequest,
  type MuxWorktreeOpenRequest,
  type MuxWorktreeOpened,
  type MuxWorktreeScope,
} from "../types.ts";
import {
  DEFAULT_HC_TIMEOUT_MS,
  HcClient,
  HcError,
  machineHcProbe,
  resolveHcBinary,
  SpawnHcWire,
  type HcRpc,
  type WireTerminal,
} from "./client.ts";
import { HERDR_APP_UNSENDABLE_KEYS, toHerdrAppKey } from "./keys.ts";

// The Herdr app, driven through herdr-core (`hc`): the WHOLE translation between the core's
// terminals and the mux port. `client.ts` is the only file that knows hc's wire; this file is the
// only one that knows its typed methods. Ground truth: MUX_CONTRACT.md § The Herdr app, source **HA**.
//
//   a terminal of the core        = a pane   (its address, `t7`, which the core never reuses)
//   the `herdr.space` label       = a space  (named by the first part of the `where` label)
//   the `herdr.tab` label         = a tab    (named by the second part of `where`)
//
// The app writes those three labels on every terminal it shows. A terminal with no place of its own
// (an agent's helper started with `hc run`) is listed in its parent's space and tab, and one with
// neither is listed in a space of its own, so nothing the core runs is hidden.

export const HERDR_APP_MUX = "herdr-app";

/** The space of terminals the app shows nowhere and nothing started. */
const LOOSE_SPACE_ID = "hc";
const LOOSE_SPACE_LABEL = "hc";

const NO_ARRANGING =
  "The Herdr app arranges its own spaces, tabs and panes. Pastor reads that arrangement from herdr-core and does not change it.";

const HERDR_APP_CAPABILITIES = declareCapabilities({
  supports: [
    "paneGrid",
    "gridScrollback",
    "agentDetection",
    "agentSessionRef",
    "typeText",
    "sendKeys",
    "closePane",
    "pushTopologyEvents",
    "pushPaneEvents",
  ],
  unsupportedKeys: HERDR_APP_UNSENDABLE_KEYS,
  textEntry: "submitted",
  // The core announces a terminal appearing, ending, being removed, relabelled and retitled.
  topologyLatency: { kind: "push" },
  notes: {
    paneGrid: "herdr-core hands over a pane's screen as plain text, so the mirror shows no colour.",
    agentSessionRef:
      "herdr-core does not know an agent's session. A pane carries one only when something wrote it on the terminal as the resume.session label.",
    typeText:
      "herdr-core types text together with Enter. Text sent without Enter waits here and goes in with the Enter that follows; any other key drops it.",
    sendKeys:
      "herdr-core has no key for a character that needs Shift on a US keyboard, such as ? or !, nor for a character outside ASCII. Those are refused as keys and go in as text.",
    renamePane: NO_ARRANGING,
    setFocus: NO_ARRANGING,
    createTab: NO_ARRANGING,
    renameTab: NO_ARRANGING,
    closeTab: NO_ARRANGING,
    createSpace: NO_ARRANGING,
    listWorktrees: "herdr-core has no Git vocabulary.",
    createWorktree: "herdr-core has no Git vocabulary.",
    openWorktree: "herdr-core has no Git vocabulary.",
    listSessions: "One pastor drives one herdr-core session. A second session is reached by pointing a second pastor at it.",
  },
  spaces: "many",
});

/** The core's words that mean the terminal is no longer there to act on. */
const GONE_KINDS: ReadonlySet<string> = new Set(["not_found", "finished", "machine_unknown"]);

function refusalFor<T>(err: T): MuxRefusalOutcome {
  if (err instanceof HcError) return GONE_KINDS.has(err.kind) ? muxGone(err.message) : muxRefused(err.message);
  return muxUnreachable(err instanceof Error ? err.message : String(err));
}

/**
 * The app a program reported itself as (or, failing that, the name of the program in the
 * foreground) → the Pastor harness that reads it. Anything else is a shell.
 */
const AGENT_BY_APP = new Map<string, string>([
  ["claude-code", "claude"],
  ["claude", "claude"],
  ["codex", "codex"],
  ["opencode", "opencode"],
  ["pi", "pi"],
  ["omp", "omp"],
  ["grok", "grok"],
  ["hermes", "hermes"],
  ["antigravity", "antigravity"],
  ["agy", "agy"],
  ["muse", "muse"],
  ["openclaw", "openclaw"],
]);
for (const name of AGENT_BY_APP.values()) {
  if (!MUX_AGENT_NAMES.includes(name)) throw new Error(`herdr-app adapter maps to ${name}, which is not a Pastor harness`);
}

/** Programs that are a prompt, not an agent. A status left by an agent that has exited is ignored under one. */
const SHELLS: ReadonlySet<string> = new Set(["bash", "zsh", "fish", "sh", "dash", "nu", "pwsh", "powershell", "cmd", "xonsh", "elvish"]);

/** A program's name without its folder or a Windows extension, lower-cased. */
function programName(raw: string | undefined): string {
  const base = (raw ?? "").trim().split(/[\\/]/u).at(-1) ?? "";
  return base.toLowerCase().replace(/\.(?:exe|cmd|bat)$/u, "");
}

function agentOf(terminal: WireTerminal): string | null {
  const foreground = programName(terminal.foreground?.name);
  if (SHELLS.has(foreground)) return null;
  const reported = programName(terminal.status?.app);
  return AGENT_BY_APP.get(reported) ?? AGENT_BY_APP.get(foreground) ?? null;
}

function agentStatus(state: string | undefined): AgentStatus {
  switch (state) {
    case "idle":
    case "working":
    case "blocked":
    case "done":
      return state;
    default:
      return "unknown";
  }
}

/** FNV-1a over the text: enough to tell two screens apart, and nothing leaves the process. */
function contentDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${String(text.length)}:${(hash >>> 0).toString(36)}`;
}

/** How many request shapes one pane's revision tracker remembers. */
const REVISION_VARIANTS = 16;

/** How much history the core is asked for when a read has no bound of its own to offer. */
const HISTORY_CEILING = 10_000;

interface PaneRevision {
  revision: number;
  readonly variants: Map<string, string>;
}

/** Which events mean the herd's shape may have changed, rather than one pane's state. */
const TOPOLOGY_EVENTS: ReadonlySet<string> = new Set(["created", "finished", "removed", "lost", "restarted", "labels", "title", "foreground", "missed"]);

type MutableMuxPane = { -readonly [K in keyof MuxPane]: MuxPane[K] };

export class HerdrAppMux implements MuxAdapter {
  readonly mux = HERDR_APP_MUX;
  readonly capabilities = HERDR_APP_CAPABILITIES;
  readonly logo = HERDR_LOGO_SVG;

  /**
   * The derived revision, per pane. herdr-core has no content revision (its `turn` counts an
   * agent's turns, not repaints), so the contract's race-guard token is built from what a read
   * returned: it advances when a read of the same shape comes back different.
   */
  private readonly revisions = new Map<string, PaneRevision>();

  constructor(private readonly rpc: HcRpc) {}

  async reachable(): Promise<boolean> {
    try {
      await this.rpc.hello();
      return true;
    } catch {
      return false;
    }
  }

  async snapshot(): Promise<MuxSnapshot> {
    const snapshot = toSnapshot(localLive(await this.rpc.listTerminals()));
    this.forgetGonePanes(snapshot.panes);
    return snapshot;
  }

  /** Every snapshot is a fresh list and the watch is a real stream, so there is no clock to move. */
  refresh(): Promise<void> {
    return Promise.resolve();
  }

  async readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> {
    const history = request.scope === "viewport" ? 0 : Math.min(HISTORY_CEILING, Math.max(0, request.lines));
    try {
      const read = await this.rpc.readTerminal(paneId, history);
      // The core's text is plain already, so `strip` and `preserve` are the same read.
      const text = read.text.replace(/\n+$/u, "");
      return muxOk({
        paneId,
        text,
        truncated: !read.complete,
        revision: this.advanceRevision(paneId, `${request.scope}|${String(history)}`, text),
      });
    } catch (err) {
      return refusalFor(err);
    }
  }

  async foregroundProcesses(paneId: string): Promise<MuxOutcome<readonly ForegroundProcess[]>> {
    try {
      const argv = (await this.rpc.getTerminal(paneId)).foreground?.argv ?? [];
      return muxOk(argv.length === 0 ? [] : [{ argv: [...argv] }]);
    } catch (err) {
      return refusalFor(err);
    }
  }

  async typeText(paneId: string, text: string): Promise<MuxAck> {
    if (text.length === 0) return muxAck();
    return this.attempt(() => this.rpc.typeText(paneId, text));
  }

  /** Text and its Enter as one act, which is the only way the core types. */
  async typeAndSubmit(paneId: string, text: string): Promise<MuxAck> {
    return this.attempt(() => this.rpc.submitText(paneId, text));
  }

  async sendKeys(paneId: string, keys: readonly string[]): Promise<MuxAck> {
    const translated: string[] = [];
    for (const key of keys) {
      const result = toHerdrAppKey(key);
      if (!result.ok) {
        // A batch is a sequence: one key that cannot be sent means none of it is.
        return result.reason === "unsendable"
          ? muxRefused(`herdr-core has no key for ${key}. Send it as text instead.`)
          : muxRefused(`not a key: ${key}`);
      }
      translated.push(result.key);
    }
    if (translated.length === 0) return muxAck();
    return this.attempt(() => this.rpc.pressKeys(paneId, translated));
  }

  renamePane(_paneId: string, _label: string | null): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renamePane", NO_ARRANGING));
  }

  async closePane(paneId: string): Promise<MuxAck> {
    return this.attempt(() => this.rpc.killTerminal(paneId));
  }

  setFocus(_paneId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("setFocus", NO_ARRANGING));
  }

  createTab(_request: MuxTabRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createTab", NO_ARRANGING));
  }

  renameTab(_tabId: string, _label: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("renameTab", NO_ARRANGING));
  }

  closeTab(_tabId: string): Promise<MuxAck> {
    return Promise.resolve(muxUnsupported("closeTab", NO_ARRANGING));
  }

  createSpace(_request: MuxSpaceRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createSpace", NO_ARRANGING));
  }

  listWorktrees(_scope: MuxWorktreeScope): Promise<MuxOutcome<readonly MuxWorktree[]>> {
    return Promise.resolve(muxUnsupported("listWorktrees", "herdr-core has no Git vocabulary"));
  }

  createWorktree(_request: MuxWorktreeCreateRequest): Promise<MuxOutcome<MuxCreatedPane>> {
    return Promise.resolve(muxUnsupported("createWorktree", "herdr-core has no Git vocabulary"));
  }

  openWorktree(_request: MuxWorktreeOpenRequest): Promise<MuxOutcome<MuxWorktreeOpened>> {
    return Promise.resolve(muxUnsupported("openWorktree", "herdr-core has no Git vocabulary"));
  }

  listSessions(): Promise<MuxOutcome<readonly MuxSession[]>> {
    return Promise.resolve(muxUnsupported("listSessions", "one pastor drives one herdr-core session"));
  }

  watch(options: MuxWatchOptions): MuxSubscription {
    const watched = new Set(options.panes);
    return this.rpc.subscribe({
      onUp: () => options.onUp(),
      onEvent: (event) => {
        if (event.terminal !== "" && watched.has(event.terminal) && !TOPOLOGY_EVENTS.has(event.type)) {
          options.onPaneChange(event.terminal);
        } else {
          // A change to a pane nobody watches is still news about the herd: its status is in the snapshot.
          options.onTopologyChange();
        }
      },
      onDown: (reason) => options.onDown(reason),
    });
  }

  private async attempt(call: () => Promise<void>): Promise<MuxAck> {
    try {
      await call();
      return muxAck();
    } catch (err) {
      return refusalFor(err);
    }
  }

  private forgetGonePanes(panes: readonly MuxPane[]): void {
    if (this.revisions.size === 0) return;
    const live = new Set(panes.map((pane) => pane.paneId));
    for (const paneId of this.revisions.keys()) {
      if (!live.has(paneId)) this.revisions.delete(paneId);
    }
  }

  private advanceRevision(paneId: string, variant: string, text: string): number {
    const tracked = this.revisions.get(paneId) ?? { revision: 1, variants: new Map<string, string>() };
    this.revisions.set(paneId, tracked);
    const digest = contentDigest(text);
    const previous = tracked.variants.get(variant);
    if (previous === undefined) {
      if (tracked.variants.size > 0) tracked.revision += 1;
    } else if (previous !== digest) {
      tracked.revision += 1;
    }
    tracked.variants.delete(variant);
    tracked.variants.set(variant, digest);
    if (tracked.variants.size > REVISION_VARIANTS) {
      const oldest = tracked.variants.keys().next();
      if (!oldest.done) tracked.variants.delete(oldest.value);
    }
    return tracked.revision;
  }
}

/**
 * This machine's running terminals. A terminal of a linked machine reads `machine/t7`, and it is
 * that machine's own pastor that shows it: nothing here reaches across a machine boundary (ADR 0011).
 */
function localLive(terminals: readonly WireTerminal[]): WireTerminal[] {
  return terminals.filter((terminal) => terminal.state === "live" && !terminal.address.includes("/"));
}

interface Place {
  readonly spaceId: string;
  readonly tabId: string;
  /** The terminal whose labels name this place: the pane itself, or the ancestor it sits with. */
  readonly namedBy: WireTerminal;
}

/** Where the app shows a terminal: its own labels, else its nearest ancestor's, else on its own. */
function placeOf(terminal: WireTerminal, byAddress: ReadonlyMap<string, WireTerminal>): Place {
  let current: WireTerminal | undefined = terminal;
  // Bounded by the herd's size, so a parent loop in a damaged listing cannot spin.
  for (let hops = 0; current !== undefined && hops <= byAddress.size; hops += 1) {
    const spaceId = safeId(current.labels["herdr.space"]);
    if (spaceId !== null) {
      return { spaceId, tabId: safeId(current.labels["herdr.tab"]) ?? `tab-${current.address}`, namedBy: current };
    }
    current = current.parent === "" ? undefined : byAddress.get(current.parent);
  }
  return { spaceId: LOOSE_SPACE_ID, tabId: `tab-${terminal.address}`, namedBy: terminal };
}

/** A label value usable as an id on the wire, or null. The app's ids are hex, so this refuses nothing real. */
function safeId(raw: string | undefined): string | null {
  const id = (raw ?? "").trim();
  return id.length > 0 && id.length <= 128 && /^[\w.:-]+$/u.test(id) ? id : null;
}

/** The app's `where` label reads `space / tab`. Either half may be missing. */
function whereOf(terminal: WireTerminal): { space: string; tab: string } {
  const where = (terminal.labels.where ?? "").trim();
  const cut = where.indexOf(" / ");
  return cut < 0 ? { space: where, tab: "" } : { space: where.slice(0, cut).trim(), tab: where.slice(cut + 3).trim() };
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/u).findLast((part) => part.length > 0) ?? "";
}

function toSnapshot(terminals: readonly WireTerminal[]): MuxSnapshot {
  // Oldest first, so a space's and a tab's number stay put while terminals come and go after them.
  const ordered = terminals.toSorted((a, b) => a.createdMs - b.createdMs || a.address.localeCompare(b.address));
  const byAddress = new Map(ordered.map((terminal) => [terminal.address, terminal]));

  const spaces = new Map<string, { label: string; number: number; tabs: string[]; panes: number }>();
  const tabs = new Map<string, { spaceId: string; label: string; named: boolean; number: number; panes: number }>();
  const panes: MuxPane[] = [];

  for (const terminal of ordered) {
    const place = placeOf(terminal, byAddress);
    const where = whereOf(place.namedBy);
    const cwd = terminal.foreground?.cwd || terminal.cwd;

    let space = spaces.get(place.spaceId);
    if (space === undefined) {
      const label = place.spaceId === LOOSE_SPACE_ID ? LOOSE_SPACE_LABEL : where.space || folderName(cwd) || place.spaceId;
      space = { label, number: spaces.size + 1, tabs: [], panes: 0 };
      spaces.set(place.spaceId, space);
    }
    space.panes += 1;

    let tab = tabs.get(place.tabId);
    if (tab === undefined) {
      space.tabs.push(place.tabId);
      // The app calls an unnamed tab by its number, which is a position and not a name.
      const name = meaningfulTabLabel(where.tab) ?? "";
      tab = { spaceId: place.spaceId, label: name, named: name !== "", number: space.tabs.length, panes: 0 };
      tabs.set(place.tabId, tab);
    }
    tab.panes += 1;

    const pane: MutableMuxPane = {
      paneId: terminal.address,
      spaceId: place.spaceId,
      spaceLabel: space.label,
      spaceNumber: space.number,
      tabId: place.tabId,
      cwd,
      // The core does not know which pane the app's window shows, so none is claimed.
      focused: false,
      alive: true,
      agent: "shell",
      status: "unknown",
    };
    const agent = agentOf(terminal);
    if (agent !== null) {
      pane.agent = agent;
      pane.status = agentStatus(terminal.status?.state);
    }
    const session = (terminal.labels["resume.session"] ?? "").trim();
    if (session !== "") {
      pane.agentSession = { kind: "id", value: session };
      const wrote = AGENT_BY_APP.get(programName(terminal.labels["resume.agent"]));
      if (wrote !== undefined && wrote !== pane.agent) pane.sessionAgent = wrote;
    }
    if (tab.named) {
      pane.tabLabel = tab.label;
      pane.tabNamed = true;
    }
    const title = meaningfulTerminalTitle(terminal.title, undefined, pane.agent, space.label);
    if (title !== undefined) pane.terminalTitle = title;
    const foreground = programName(terminal.foreground?.name);
    if (foreground !== "") pane.foregroundCommand = foreground;
    panes.push(pane);
  }

  const spaceList: MuxSpace[] = [...spaces].map(([spaceId, space]) => ({
    spaceId,
    number: space.number,
    label: space.label,
    focused: false,
    activeTabId: space.tabs.at(0) ?? "",
    tabCount: space.tabs.length,
    paneCount: space.panes,
  }));
  const tabList: MuxTab[] = [...tabs].map(([tabId, tab]) => ({
    tabId,
    spaceId: tab.spaceId,
    number: tab.number,
    label: tab.named ? tab.label : String(tab.number),
    focused: false,
    paneCount: tab.panes,
  }));
  return { panes, spaces: spaceList, tabs: tabList };
}

export const herdrAppMuxFactory: MuxAdapterFactory = {
  mux: HERDR_APP_MUX,
  create(target: MuxTarget) {
    const wire = new SpawnHcWire(resolveHcBinary(machineHcProbe()), target.endpoint);
    return new HerdrAppMux(new HcClient(wire, target.timeoutMs || DEFAULT_HC_TIMEOUT_MS));
  },
  describeTarget(endpoint: string) {
    const session = endpoint.trim();
    return session === "" ? "herdr-core, its default session" : `herdr-core session ${session}`;
  },
};
