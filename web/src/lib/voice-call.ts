// CALL DE VOZ COM O CODEX (patch local do Antonio).
//
// O `/voice` do Codex fala pelo microfone e pela caixa de som do PC. O serviço `collie-voice`
// (~/Projects/collie-voice, montado em `/voice-call` neste mesmo endereço) troca os dois por
// dispositivos virtuais durante a call e passa o áudio por um WebSocket, PCM 16-bit mono a 24 kHz.
// Este módulo é o lado do celular: um só por app, no nível do módulo, para a call sobreviver a uma
// troca de tela. A bolinha (components/voice-bubble.tsx) só lê o estado e encerra.
import { useSyncExternalStore } from "react";

const RATE = 24000;
const BASE = "/voice-call";

export type VoiceCallState =
  | { phase: "idle"; error?: string }
  | { phase: "connecting" | "live"; paneId: string };

let state: VoiceCallState = { phase: "idle" };
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let nextTime = 0;

function set(next: VoiceCallState): void {
  state = next;
  for (const fn of listeners) fn();
}

export function useVoiceCall(): VoiceCallState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

function play(pcm: Int16Array): void {
  if (!ctx) return;
  const buf = ctx.createBuffer(1, pcm.length, RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 0x8000;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  const now = ctx.currentTime;
  // Atraso acumulado vira conversa defasada: descarta e recomeça perto do agora.
  if (nextTime < now || nextTime > now + 0.6) nextTime = now + 0.08;
  src.start(nextTime);
  nextTime += buf.duration;
}

function teardown(error?: string): void {
  const socket = ws;
  ws = null;
  if (socket && socket.readyState <= WebSocket.OPEN) {
    try {
      socket.send("stop");
    } catch {
      /* já fechando */
    }
    socket.close();
  }
  for (const track of stream?.getTracks() ?? []) track.stop();
  void ctx?.close();
  ctx = null;
  stream = null;
  set(error === undefined ? { phase: "idle" } : { phase: "idle", error });
}

export function stopVoiceCall(): void {
  teardown();
}

export async function startVoiceCall(paneId: string): Promise<void> {
  if (state.phase !== "idle") return;
  set({ phase: "connecting", paneId });
  try {
    // Criado dentro do toque: iOS só libera áudio num gesto do usuário.
    ctx = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await ctx.audioWorklet.addModule("/voice-tap.js");
    const node = new AudioWorkletNode(ctx, "voice-tap");
    ctx.createMediaStreamSource(stream).connect(node);

    const url = new URL(`${BASE}/ws?pane=${encodeURIComponent(paneId)}`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    ws = socket;
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(e.data);
    };
    socket.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data !== "string") {
        play(new Int16Array(e.data));
        return;
      }
      const msg = JSON.parse(e.data) as { type: string; message?: string };
      if (msg.type === "started") set({ phase: "live", paneId });
      if (msg.type === "error") teardown(msg.message ?? "erro na call");
    };
    socket.onclose = () => {
      if (ws === socket) teardown(state.phase === "connecting" ? "não conectou" : undefined);
    };
  } catch (err) {
    teardown(err instanceof Error ? err.message : "erro na call");
  }
}
