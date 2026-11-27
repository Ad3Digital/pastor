import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { sendGuardedReply } from "./reply-action";

// A multiplexer whose one text verb pastes AND presses Enter (the bridge says `textEntry:
// "submitted"`). Text sent without Enter never shows on its screen, so the type-then-verify sequence
// has nothing to read back: the reply must go as ONE call that types and submits, with no read of the
// pane in front of it and no second call behind it.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

vi.mock("@/lib/mux-capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mux-capability")>()),
  textSubmittedOf: () => true,
}));

function watchNetwork(reply: () => object) {
  const calls: string[] = [];
  const bodies: Array<{ text: string; submit: boolean }> = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, ({ request }) => {
      calls.push(`GET ${new URL(request.url).pathname}`);
      return HttpResponse.json({ paneId: "t7", text: "› Ask Codex to do anything", truncated: false, revision: 1 });
    }),
    http.post<never, { text: string; submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      calls.push(`POST ${new URL(request.url).pathname}`);
      bodies.push(await request.json());
      return HttpResponse.json(reply());
    }),
  );
  return { calls, bodies };
}

describe("sendGuardedReply under a multiplexer that types only with Enter", () => {
  it("sends text and submit as one call, for a harness that has a grammar", async () => {
    const seen = watchNetwork(() => ({ ok: true }));
    const out = await sendGuardedReply({ paneId: "t7", text: "olá, tudo bem?", agent: "codex" });
    expect(out).toEqual({ status: "sent" });
    expect(seen.calls).toEqual(["POST /api/pane/t7/reply"]);
    expect(seen.bodies).toEqual([{ text: "olá, tudo bem?", submit: true }]);
  });

  it("does the same for Claude, whose composer the ordinary path would read first", async () => {
    const seen = watchNetwork(() => ({ ok: true }));
    const out = await sendGuardedReply({ paneId: "t7", text: "continue", agent: "claude" });
    expect(out).toEqual({ status: "sent" });
    expect(seen.calls).toEqual(["POST /api/pane/t7/reply"]);
  });

  it("reports the bridge's refusal as an error and sends nothing more", async () => {
    const seen = watchNetwork(() => ({
      ok: false,
      error: "the reply could not be sent",
      code: "reply.send_failed",
      detail: { reason: "the program is blocked" },
      textDelivered: false,
    }));
    const out = await sendGuardedReply({ paneId: "t7", text: "continue", agent: "codex" });
    expect(out.status).toBe("error");
    expect(seen.calls).toEqual(["POST /api/pane/t7/reply"]);
  });
});
