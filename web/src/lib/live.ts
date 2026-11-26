// The live-call wire, as the phone sees it. Mirrors bridge/live/types.ts field for field; it is
// restated here because that file sits in the bridge's type graph (Bun types), which the web
// typecheck does not load. No credentials or local paths are on this wire.

export type LivePhase = "idle" | "connecting" | "listening" | "working" | "muted" | "error";

export interface LiveTranscript {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface LiveStatus {
  available: boolean;
  phase: LivePhase;
  muted: boolean;
  transcripts: LiveTranscript[];
  error?: string;
}

export type LiveCommand =
  | { action: "offer"; requestId: string; sdp: string }
  | { action: "ready" | "heartbeat" | "stop"; requestId: string }
  | { action: "mute"; requestId: string; muted: boolean };

export interface LiveReply {
  ok: true;
  status: LiveStatus;
  sdp?: string;
}
