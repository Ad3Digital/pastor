// Live calls for Codex panes: the phone talks, Codex works in its own pane, and the voice answers
// with Codex's final message.
//
// The OMP route (omp/extension.ts) runs inside the agent and hands a delegation to OMP's own session.
// Codex has no extension seam, so for a Codex pane the bridge is the host:
//
//   phone ── SDP offer ──▶ bridge ── signaling (the Codex login) ──▶ OpenAI realtime
//   phone ◀═════════════ audio, WebRTC, straight to OpenAI ═════════════▶
//   bridge ◀── sideband WebSocket: transcripts and delegations ──▶ OpenAI
//   delegation ──▶ typed into the Codex pane, like a reply from the phone
//   Codex session log (task_complete) ──▶ the final message goes back to the voice
//
// The audio never passes through the PC, which is what makes this work on Windows too. The bridge
// reads `<CODEX_HOME>/auth.json` only when a call starts, sends the access token only to OpenAI's
// signaling and sideband endpoints, and never returns it to the browser: every status this module
// answers is built field by field from `LiveStatus`.
import { readFile, open, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../json.ts";
import { jsonRecord, jsonStringField } from "../stt/json.ts";
import type { AgentView } from "../types.ts";
import { MAX_LIVE_REQUEST_BYTES, MAX_LIVE_SDP_BYTES, parseLiveCommand } from "./commands.ts";
import { liveJson } from "./proxy.ts";
import {
  appendLiveTranscript,
  buildDelegationContextAppend,
  buildSessionClose,
  chunkLiveContext,
  LIVE_MODEL,
  parseLiveServerEvent,
  type LiveClientMessage,
  type LiveServerEvent,
} from "./protocol.ts";
import type { LiveCommand, LivePhase, LiveReply, LiveStatus, LiveTranscript } from "./types.ts";

const SIGNALING_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const SIDEBAND_BASE = "wss://api.openai.com/v1/live/";
const CODEX_CLIENT_VERSION = "0.153.0";
const LIVE_ORIGINATOR = "Codex Desktop";
const MAX_ERROR_CHARS = 240;
const LEASE_MS = 45_000;
const SIDEBAND_TIMEOUT_MS = 15_000;
const SIDEBAND_ATTEMPTS = 5;
const ROLLOUT_POLL_MS = 800;
/** A turn that never reports done stops being watched after this; the call itself stays up. */
const TURN_WATCH_MS = 30 * 60_000;
/** The most of a session log one poll reads; a turn that writes more is caught up over several polls. */
const MAX_ROLLOUT_READ = 4 * 1024 * 1024;

const INSTRUCTIONS = `You: Codex Live, the realtime voice of one coding assistant for {{firstName}} (OS account: {{username}}).

<critical>
- You and the Codex coding agent in the terminal are one assistant, not two.
- MUST delegate repository work, coding, commands, file changes, browsing and verification to the client backend.
- MUST keep the conversation natural while the client backend works.
- The user prefers Brazilian Portuguese. Speak Brazilian Portuguese unless they ask for another language.
</critical>

The user speaks to you. Answer directly, briefly and conversationally, in speech-friendly phrasing. NEVER use markdown, code blocks or long lists, and never read implementation detail aloud unless asked.

Client backend: the same assistant's execution surface, the Codex session in the user's terminal, with the repository, tools and model. For coding, investigation, changes, commands or verification, MUST promptly create a client delegation with the complete plain-language request and every relevant detail from the conversation; NEVER attempt tool work yourself. A new request while work is running MUST create a new delegation.

Treat delegation context as your own progress and results. NEVER describe the backend as another assistant. You MAY briefly acknowledge that you are working; NEVER claim changes, findings or verification before the backend reports them. Commentary context is silent progress: NEVER recite it. Context that begins with "Agent Final Message": is the backend's final answer: present the useful result naturally as your own, and NEVER mention the label, the protocol, delegation or the backend.

Greetings, clarifications and ordinary conversation that need no repository or tools: answer directly, without delegation. Ask one short clarifying question only when a request is genuinely underspecified.`;

type LiveWebSocketConstructor = new (url: string | URL, options?: Bun.WebSocketOptions) => WebSocket;
// SAFETY: the bridge runs on Bun, whose WebSocket takes `{ headers }`; the DOM lib in this project's
// types declares only the browser overload, so the constructor is re-typed to the one Bun has.
const LiveWebSocket = WebSocket as LiveWebSocketConstructor;

/** The Codex login as `auth.json` holds it: the access token and, when present, the account. */
interface CodexAccess {
  accessToken: string;
  accountId?: string;
}

/** What the bridge supplies per pane: how to type into it, and which session log is its own. */
export interface CodexPaneIO {
  /** Type `text` into the pane and submit it, as a phone reply does. Throws when it did not land. */
  deliver(text: string): Promise<void>;
  /** The pane's Codex session log (`rollout-*.jsonl`), or null when the pane names none yet. */
  rollout(): Promise<string | null>;
}

interface Call {
  requestId: string;
  paneId: string;
  io: CodexPaneIO;
  sessionId: string;
  realtimeSessionId: string;
  abort: AbortController;
  phase: LivePhase;
  muted: boolean;
  transcripts: LiveTranscript[];
  lastHeartbeat: number;
  leaseTimer?: Timer;
  pendingOffer: boolean;
  callId?: string;
  access?: CodexAccess;
  sideband?: WebSocket;
  sidebandPromise?: Promise<void>;
  cleanupPromise?: Promise<void>;
  sendTail: Promise<void>;
  delegationId?: string;
  delegationIds: Set<string>;
  watch?: { timer: Timer; path: string | null; offset: number; carry: string; until: number };
  stopped: boolean;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function cleanError(message: string): string {
  return (
    message
      .replaceAll(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replaceAll(/sk-[\w-]+/g, "[redacted]")
      .replaceAll(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ERROR_CHARS) || "Live call failed."
  );
}

function renderInstructions(): string {
  let username = "user";
  try {
    username = userInfo().username.trim() || username;
  } catch {
    // An account with no name still gets a call; the greeting just says "user".
  }
  const firstName = username.split(/[._\-\s]+/).find((part) => part.length > 0) ?? "there";
  return INSTRUCTIONS.replaceAll("{{username}}", username).replaceAll("{{firstName}}", firstName);
}

function callIdFromLocation(location: string | null): string | undefined {
  if (!location) return undefined;
  for (const segment of location.split("?", 1)[0]?.split("/") ?? []) {
    if (/^rtc_[\w-]+$/.test(segment)) return segment;
  }
  return undefined;
}

function accountIdFromToken(accessToken: string): string | undefined {
  const encoded = accessToken.split(".")[1];
  if (!encoded) return undefined;
  try {
    const claims = jsonRecord(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    const auth = jsonRecord(claims?.["https://api.openai.com/auth"]);
    const accountId = jsonStringField(auth?.chatgpt_account_id);
    return accountId && accountId.length > 0 ? accountId : undefined;
  } catch {
    return undefined;
  }
}

/** The request headers of signaling and of the sideband: the same set Codex Desktop sends. */
interface LiveHeaders {
  Authorization: string;
  "OpenAI-Alpha": string;
  "User-Agent": string;
  "x-session-id": string;
  originator: string;
  version: string;
  "session-id": string;
  "thread-id": string;
  "chatgpt-account-id"?: string;
}

function liveHeaders(access: CodexAccess, sessionId: string, realtimeSessionId: string): LiveHeaders {
  const headers: LiveHeaders = {
    Authorization: `Bearer ${access.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    originator: LIVE_ORIGINATOR,
    version: CODEX_CLIENT_VERSION,
    "session-id": sessionId,
    "thread-id": sessionId,
  };
  const accountId = access.accountId ?? accountIdFromToken(access.accessToken);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const body = await response.arrayBuffer();
  if (body.byteLength > maxBytes) throw new Error("Codex live signaling returned an oversized response.");
  return new TextDecoder().decode(body);
}

/** The two session-log events a turn reports through: a message on the way, and the turn being done. */
export type RolloutEvent = { kind: "progress"; text: string } | { kind: "final"; text: string };

/** Read one line of a Codex session log. Anything but those two events is null. */
export function rolloutEvent(line: string): RolloutEvent | null {
  let raw: JsonValue;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const row = jsonRecord(raw);
  if (jsonStringField(row?.type) !== "event_msg") return null;
  const payload = jsonRecord(row?.payload);
  const type = jsonStringField(payload?.type);
  if (type === "task_complete") return { kind: "final", text: jsonStringField(payload?.last_agent_message) ?? "" };
  if (type === "agent_message") {
    const text = jsonStringField(payload?.message);
    return text ? { kind: "progress", text } : null;
  }
  return null;
}

/** One live call at a time on this machine, as with OMP: one microphone, one phone. */
export class CodexLiveHost {
  private active: Call | undefined;
  private lastError: string | undefined;

  /** `codexHome` is `CODEX_HOME`, or `~/.codex`. */
  constructor(private readonly codexHome: string) {}

  private authPath(): string {
    return join(this.codexHome, "auth.json");
  }

  private async access(): Promise<CodexAccess> {
    let raw: JsonValue;
    try {
      raw = JSON.parse(await readFile(this.authPath(), "utf8"));
    } catch {
      throw new Error("Codex is not signed in on this computer. Run `codex login` and try again.");
    }
    const tokens = jsonRecord(jsonRecord(raw)?.tokens);
    const accessToken = jsonStringField(tokens?.access_token);
    if (!accessToken) throw new Error("Codex is signed in with an API key; Live needs a ChatGPT login (`codex login`).");
    const accountId = jsonStringField(tokens?.account_id) ?? undefined;
    return accountId ? { accessToken, accountId } : { accessToken };
  }

  private async available(): Promise<boolean> {
    try {
      await stat(this.authPath());
      return true;
    } catch {
      return false;
    }
  }

  private statusFor(call: Call | undefined, available: boolean): LiveStatus {
    const error = this.lastError;
    if (!call) {
      return error
        ? { available, phase: "error", muted: false, transcripts: [], error }
        : { available, phase: "idle", muted: false, transcripts: [] };
    }
    const status: LiveStatus = {
      available,
      phase: call.phase,
      muted: call.muted,
      transcripts: call.transcripts.map((t) => ({ ...t })),
    };
    if (error) status.error = error;
    return status;
  }

  private sameCall(call: Call): boolean {
    return this.active === call && !call.stopped;
  }

  /** GET reads the call state for a pane; POST advances the phone's lease. Same wire as OMP. */
  async handle(req: Request, pane: AgentView, io: CodexPaneIO): Promise<Response> {
    if (req.method !== "GET" && req.method !== "POST") return liveJson({ ok: false, error: "Method not allowed" }, 405);
    const available = await this.available();
    const call = this.active?.paneId === pane.paneId ? this.active : undefined;
    if (req.method === "GET") {
      if (!available) {
        return liveJson({ available: false, phase: "idle", muted: false, transcripts: [], error: "Codex is not signed in on this computer. Run `codex login`." });
      }
      return liveJson(this.statusFor(call, available));
    }
    if (req.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return liveJson({ ok: false, error: "JSON required" }, 415);
    }
    const body = await req.text();
    if (Buffer.byteLength(body) > MAX_LIVE_REQUEST_BYTES) return liveJson({ ok: false, error: "Live request too large" }, 413);
    let command: LiveCommand | null = null;
    try {
      command = parseLiveCommand(JSON.parse(body));
    } catch {
      // Malformed JSON is the same client error as a malformed command.
    }
    if (!command) return liveJson({ ok: false, error: "Invalid live request" }, 400);
    try {
      return liveJson(await this.command(command, pane, io, available));
    } catch (error) {
      if (error instanceof HttpError) return liveJson({ ok: false, error: error.message }, error.status);
      return liveJson({ ok: false, error: cleanError(error instanceof Error ? error.message : "Live call failed.") }, 500);
    }
  }

  private async command(command: LiveCommand, pane: AgentView, io: CodexPaneIO, available: boolean): Promise<LiveReply> {
    if (command.action === "offer") return this.startOffer(command, pane, io, available);
    const call = this.active;
    if (!call || call.requestId !== command.requestId || call.paneId !== pane.paneId || !this.sameCall(call)) {
      throw new HttpError(409, "Live call lease is no longer active.");
    }
    call.lastHeartbeat = Date.now();
    switch (command.action) {
      case "ready":
        if (call.pendingOffer) throw new HttpError(409, "Live signaling is still pending.");
        if (!call.sideband) {
          try {
            call.sidebandPromise ??= this.connectSideband(call);
            await call.sidebandPromise;
            if (!this.sameCall(call)) throw new Error("Live call was stopped before it became ready.");
            call.phase = call.muted ? "muted" : "listening";
          } catch (error) {
            const failure = error instanceof Error ? error : new Error("Unable to connect the Codex live sideband.");
            this.failCall(call, failure);
            throw new HttpError(502, cleanError(failure.message));
          } finally {
            call.sidebandPromise = undefined;
          }
        }
        return { ok: true, status: this.statusFor(call, available) };
      case "heartbeat":
        return { ok: true, status: this.statusFor(call, available) };
      case "mute":
        call.muted = command.muted;
        if (!call.delegationId) call.phase = command.muted ? "muted" : "listening";
        return { ok: true, status: this.statusFor(call, available) };
      case "stop":
        await this.stopCall(call);
        this.lastError = undefined;
        return { ok: true, status: this.statusFor(undefined, available) };
    }
  }

  private async startOffer(
    command: Extract<LiveCommand, { action: "offer" }>,
    pane: AgentView,
    io: CodexPaneIO,
    available: boolean,
  ): Promise<LiveReply> {
    if (this.active && !this.active.stopped) throw new HttpError(409, "A live call is already active.");
    if (!available) throw new HttpError(503, "Codex is not signed in on this computer. Run `codex login`.");
    this.lastError = undefined;
    const call: Call = {
      requestId: command.requestId,
      paneId: pane.paneId,
      io,
      sessionId: crypto.randomUUID(),
      realtimeSessionId: crypto.randomUUID(),
      abort: new AbortController(),
      phase: "connecting",
      muted: false,
      transcripts: [],
      lastHeartbeat: Date.now(),
      pendingOffer: true,
      sendTail: Promise.resolve(),
      delegationIds: new Set(),
      stopped: false,
    };
    call.leaseTimer = setInterval(() => {
      if (this.sameCall(call) && Date.now() - call.lastHeartbeat > LEASE_MS) void this.stopCall(call);
    }, 5_000);
    this.active = call;
    try {
      const sdp = await this.signalOffer(call, command.sdp);
      return { ok: true, status: this.statusFor(call, available), sdp };
    } catch (error) {
      const failure = error instanceof Error ? error : new Error("Unable to start the Codex live call.");
      if (this.sameCall(call)) this.failCall(call, failure);
      throw new HttpError(502, cleanError(failure.message));
    }
  }

  private async signalOffer(call: Call, sdp: string): Promise<string> {
    const access = await this.access();
    const headers = liveHeaders(access, call.sessionId, call.realtimeSessionId);
    const response = await fetch(SIGNALING_URL, {
      method: "POST",
      headers: { ...headers, Accept: "*/*", "Content-Type": "application/json" },
      body: JSON.stringify({
        sdp,
        session: {
          model: LIVE_MODEL,
          instructions: renderInstructions(),
          audio: { output: { voice: "sol" } },
          delegation: { type: "client" },
        },
      }),
      signal: call.abort.signal,
    });
    const callId = callIdFromLocation(response.headers.get("location"));
    if (callId) {
      call.callId = callId;
      call.access = access;
    }
    if (!response.ok) {
      const detail = cleanError(await readBounded(response, 64 * 1024).catch(() => ""));
      if (response.status === 401) throw new Error("The Codex login expired. Open Codex on the computer, send any message, and call again.");
      throw new Error(`Codex live signaling failed (${response.status}): ${detail}`);
    }
    const answer = await readBounded(response, MAX_LIVE_SDP_BYTES);
    if (!answer.trim()) throw new Error("Codex live signaling returned an empty SDP answer.");
    if (!callId) throw new Error("Codex live signaling returned no valid call ID.");
    call.pendingOffer = false;
    if (!this.sameCall(call)) throw new Error("Live call was stopped while signaling.");
    return answer;
  }

  private openSideband(call: Call): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const callId = call.callId;
    const access = call.access;
    if (!callId || !access) {
      reject(new Error("Live signaling did not produce a remote session."));
      return promise;
    }
    let settled = false;
    let opened = false;
    const socket = new LiveWebSocket(SIDEBAND_BASE + encodeURIComponent(callId), {
      headers: { ...liveHeaders(access, call.sessionId, call.realtimeSessionId) },
    });
    const timer = setTimeout(() => {
      closeSocket(socket, 1000, "connect timeout");
      settle(new Error("Codex live sideband connection timed out."));
    }, SIDEBAND_TIMEOUT_MS);
    function settle(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    }
    socket.addEventListener("open", () => {
      if (!this.sameCall(call)) {
        closeSocket(socket, 1000, "stale");
        settle(new Error("Live call was stopped before sideband connection."));
        return;
      }
      opened = true;
      call.sideband = socket;
      settle();
    });
    socket.addEventListener("message", (event: MessageEvent<string | Buffer>) => {
      if (call.sideband !== socket || !this.sameCall(call)) return;
      // A text frame arrives as a string, a binary one as a Buffer; String() reads either as UTF-8.
      const parsed = parseLiveServerEvent(String(event.data));
      if (parsed) this.handleLiveEvent(call, parsed);
    });
    socket.addEventListener("error", () => {
      if (!opened) {
        closeSocket(socket, 1011, "connection failed");
        settle(new Error("Codex live sideband connection failed."));
        return;
      }
      if (call.sideband === socket && this.sameCall(call)) this.failCall(call, new Error("Codex live sideband failed."));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (!opened) {
        settle(new Error(`Codex live sideband closed before connecting (${event.code}).`));
        return;
      }
      if (call.sideband !== socket) return;
      call.sideband = undefined;
      if (this.sameCall(call)) this.failCall(call, new Error(`Codex live sideband closed (${event.code}).`));
    });
    return promise;
  }

  private async connectSideband(call: Call): Promise<void> {
    let failure = new Error("Codex live sideband connection failed.");
    for (let attempt = 0; attempt < SIDEBAND_ATTEMPTS; attempt += 1) {
      if (!this.sameCall(call)) throw new Error("Live call was stopped before sideband connection.");
      try {
        await this.openSideband(call);
        return;
      } catch (error) {
        failure = error instanceof Error ? error : failure;
        if (attempt + 1 < SIDEBAND_ATTEMPTS) await Bun.sleep(200 * 2 ** attempt);
      }
    }
    throw failure;
  }

  private send(call: Call, message: LiveClientMessage): Promise<void> {
    const operation = call.sendTail.then(() => {
      if (!this.sameCall(call)) throw new Error("Live call is no longer active.");
      if (call.sideband?.readyState !== WebSocket.OPEN) throw new Error("Live call sideband is not connected.");
      call.sideband.send(JSON.stringify(message));
      return undefined;
    });
    call.sendTail = operation.catch(() => undefined);
    return operation;
  }

  private appendContext(call: Call, text: string, channel?: "commentary"): void {
    const id = call.delegationId;
    if (!id) return;
    for (const chunk of chunkLiveContext(text)) {
      void this.send(call, buildDelegationContextAppend(id, chunk, channel)).catch(() =>
        this.failCall(call, new Error("Unable to send Codex's answer to the live call.")),
      );
    }
  }

  private handleLiveEvent(call: Call, event: LiveServerEvent): void {
    if (!this.sameCall(call)) return;
    switch (event.type) {
      case "input_transcript.added":
        appendLiveTranscript(call.transcripts, "user", event.item.text, false);
        break;
      case "output_transcript.added":
        appendLiveTranscript(call.transcripts, "assistant", event.item.text, false);
        break;
      case "turn.done":
        appendLiveTranscript(call.transcripts, event.turn.role, event.turn.transcript, true);
        break;
      case "delegation.created": {
        if (call.delegationIds.has(event.item.id)) break;
        call.delegationIds.add(event.item.id);
        if (call.delegationIds.size > 64) {
          const oldest = call.delegationIds.values().next().value;
          if (oldest !== undefined) call.delegationIds.delete(oldest);
        }
        const request = event.item.content.map((content) => content.text).join("\n").trim();
        if (!request) break;
        call.delegationId = event.item.id;
        call.phase = "working";
        void this.delegate(call, request);
        break;
      }
      case "error":
        this.failCall(call, new Error(event.message));
        break;
      case "unknown":
        break;
    }
  }

  /** Remember where the session log ends, type the request, then watch the log for the answer. */
  private async delegate(call: Call, request: string): Promise<void> {
    let path: string | null = null;
    let offset = 0;
    try {
      path = await call.io.rollout();
      if (path) offset = (await stat(path)).size;
    } catch {
      path = null;
    }
    try {
      // One line: a newline in the middle would submit half the request in a Codex composer.
      await call.io.deliver(request.replaceAll(/\s*\n\s*/g, " "));
    } catch (error) {
      this.appendContext(call, `"Agent Final Message":\n\nI could not type the request into the terminal: ${cleanError(error instanceof Error ? error.message : "send failed")}`);
      this.finishTurn(call);
      return;
    }
    this.watchRollout(call, path, offset);
  }

  private watchRollout(call: Call, path: string | null, offset: number): void {
    this.stopWatch(call);
    const watch = { timer: setInterval(() => void this.pollRollout(call), ROLLOUT_POLL_MS), path, offset, carry: "", until: Date.now() + TURN_WATCH_MS };
    call.watch = watch;
  }

  private stopWatch(call: Call): void {
    if (call.watch) clearInterval(call.watch.timer);
    call.watch = undefined;
  }

  private async pollRollout(call: Call): Promise<void> {
    const watch = call.watch;
    if (!watch || !this.sameCall(call)) return this.stopWatch(call);
    if (Date.now() > watch.until) {
      this.stopWatch(call);
      this.finishTurn(call);
      return;
    }
    // A fresh Codex session names its log only after the first turn starts: look it up again.
    if (!watch.path) {
      watch.path = await call.io.rollout().catch(() => null);
      if (!watch.path) return;
      watch.offset = 0;
    }
    let size: number;
    try {
      size = (await stat(watch.path)).size;
    } catch {
      return;
    }
    if (size <= watch.offset) return;
    const length = Math.min(size - watch.offset, MAX_ROLLOUT_READ);
    const handle = await open(watch.path, "r");
    let chunk: string;
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, watch.offset);
      chunk = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    if (call.watch !== watch) return;
    watch.offset += length;
    const lines = (watch.carry + chunk).split("\n");
    watch.carry = lines.pop() ?? "";
    for (const line of lines) {
      const event = rolloutEvent(line);
      if (!event) continue;
      if (event.kind === "progress") {
        this.appendContext(call, event.text, "commentary");
        continue;
      }
      this.stopWatch(call);
      this.appendContext(call, `"Agent Final Message":\n\n${event.text || "Done."}`);
      this.finishTurn(call);
      return;
    }
  }

  private finishTurn(call: Call): void {
    call.delegationId = undefined;
    if (this.sameCall(call)) call.phase = call.muted ? "muted" : "listening";
  }

  private failCall(call: Call, cause: Error): void {
    if (!this.sameCall(call)) return;
    this.lastError = cleanError(cause.message);
    call.phase = "error";
    void this.stopCall(call);
  }

  private stopCall(call: Call): Promise<void> {
    if (call.cleanupPromise) return call.cleanupPromise;
    call.stopped = true;
    call.abort.abort();
    if (call.leaseTimer) clearInterval(call.leaseTimer);
    this.stopWatch(call);
    const cleanup = (async (): Promise<void> => {
      const sideband = call.sideband;
      if (sideband?.readyState === WebSocket.OPEN) {
        try {
          sideband.send(JSON.stringify(buildSessionClose()));
        } catch {
          // Closing anyway.
        }
      }
      closeSocket(sideband, 1000, "stopped");
      call.sideband = undefined;
      if (this.active === call) this.active = undefined;
    })();
    call.cleanupPromise = cleanup;
    return cleanup;
  }
}

function closeSocket(socket: WebSocket | undefined, code: number, reason: string): void {
  if (!socket || (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING)) return;
  try {
    socket.close(code, reason);
  } catch {
    // Already closing.
  }
}
