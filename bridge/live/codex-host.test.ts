import { describe, expect, test } from "bun:test";
import { rolloutEvent } from "./codex-host.ts";

describe("rolloutEvent reads the two lines a Codex turn reports through", () => {
  test("task_complete is the final message, even when empty", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "Pronto." } });
    expect(rolloutEvent(line)).toEqual({ kind: "final", text: "Pronto." });
    expect(rolloutEvent(JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }))).toEqual({ kind: "final", text: "" });
  });

  test("agent_message is progress; an empty one is nothing", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Lendo o arquivo." } });
    expect(rolloutEvent(line)).toEqual({ kind: "progress", text: "Lendo o arquivo." });
    expect(rolloutEvent(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "" } }))).toBeNull();
  });

  test("every other row, and a torn line, is ignored", () => {
    expect(rolloutEvent(JSON.stringify({ type: "response_item", payload: { type: "message" } }))).toBeNull();
    expect(rolloutEvent(JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }))).toBeNull();
    expect(rolloutEvent('{"type":"event_msg","payl')).toBeNull();
  });
});
