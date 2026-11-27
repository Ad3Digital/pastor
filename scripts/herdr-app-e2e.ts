#!/usr/bin/env bun
// The Herdr app adapter against a REAL herdr-core, on whatever machine this runs on.
//
//   bun scripts/herdr-app-e2e.ts
//
// It starts a herdr-core session of its own (`HC_SESSION=pastor-e2e-<pid>`), so it never sees or
// touches the terminals of the Herdr app on this machine. In that session it opens one shell,
// labelled the way the app labels a terminal, and then drives it through the adapter the bridge
// uses: list it, read it, send a line with Enter as one act, send a line as held text plus Enter,
// press a key, close it. The session's core is stopped at the end, pass or fail.
//
// This is the layer the conformance fixture cannot be: the real `hc connect` child, the real
// named pipe on Windows, and a real shell echoing what was typed. `.github/workflows/herdr-app.yml`
// runs it on Windows and Linux. With no herdr-core installed it says so and exits 2, never 0.

import { herdrAppMuxFactory } from "../bridge/mux/herdr-app/adapter.ts";
import { hcSessionEnv, machineHcProbe, resolveHcBinary } from "../bridge/mux/herdr-app/client.ts";
import type { MuxAdapter } from "../bridge/mux/types.ts";

const SESSION = `pastor-e2e-${String(process.pid)}`;
const SPACE = "spe2e0000000000000000000000000001";
const TAB = "tbe2e0000000000000000000000000001";
const READBACK_TIMEOUT_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function hc(binary: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([binary, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...hcSessionEnv(SESSION) },
    windowsHide: true,
  });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, stdout, stderr };
}

/** How many times `needle` shows on the pane's screen and recent history. */
async function occurrences(adapter: MuxAdapter, paneId: string, needle: string): Promise<number> {
  const grid = await adapter.readGrid(paneId, { scope: "recent", lines: 200, styling: "strip" });
  if (!grid.ok) throw new Error(`reading ${paneId} answered ${grid.reason}: ${grid.detail}`);
  return grid.value.text.split(needle).length - 1;
}

/** Wait until the shell has echoed `needle` at least `times` times: the typed line and its output. */
async function awaitEcho(adapter: MuxAdapter, paneId: string, needle: string, times: number): Promise<void> {
  const deadline = Date.now() + READBACK_TIMEOUT_MS;
  let seen = 0;
  while (Date.now() < deadline) {
    seen = await occurrences(adapter, paneId, needle);
    if (seen >= times) return;
    await sleep(500);
  }
  throw new Error(`"${needle}" showed ${String(seen)} time(s) on ${paneId}, expected ${String(times)}: the line was not run`);
}

async function drive(adapter: MuxAdapter): Promise<void> {
  if (!(await adapter.reachable())) throw new Error("the adapter says herdr-core is not reachable");

  const snapshot = await adapter.snapshot();
  const pane = snapshot.panes.find((candidate) => candidate.spaceId === SPACE);
  if (pane === undefined) throw new Error(`no pane in space ${SPACE}; saw ${snapshot.panes.map((p) => p.paneId).join(", ") || "none"}`);
  if (pane.spaceLabel !== "Aula") throw new Error(`the space reads "${pane.spaceLabel}", expected the first part of the where label, "Aula"`);
  if (pane.tabLabel !== "Codex") throw new Error(`the tab reads "${String(pane.tabLabel)}", expected the second part of the where label, "Codex"`);
  if (pane.tabId !== TAB) throw new Error(`the tab id reads "${pane.tabId}", expected the herdr.tab label`);
  console.log(`   ✓ listed ${pane.paneId} in space "${pane.spaceLabel}", tab "${pane.tabLabel}"`);

  // Give the shell a moment to draw its prompt before anything is typed at it.
  await sleep(2000);

  if (adapter.typeAndSubmit === undefined) throw new Error("the adapter offers no typeAndSubmit");
  const first = `pastor-e2e-one-${String(process.pid)}`;
  const sent = await adapter.typeAndSubmit(pane.paneId, `echo ${first}`);
  if (!sent.ok) throw new Error(`typeAndSubmit answered ${sent.reason}: ${sent.detail}`);
  await awaitEcho(adapter, pane.paneId, first, 2);
  console.log("   ✓ a line sent as one act was run by the shell");

  // The reply route's two steps: the text is held, and goes in with the Enter that follows.
  const second = `pastor-e2e-two-${String(process.pid)}`;
  const typed = await adapter.typeText(pane.paneId, `echo ${second}`);
  if (!typed.ok) throw new Error(`typeText answered ${typed.reason}: ${typed.detail}`);
  if ((await occurrences(adapter, pane.paneId, second)) !== 0) throw new Error("text typed without Enter showed on the screen; it should be held");
  const entered = await adapter.sendKeys(pane.paneId, ["Enter"]);
  if (!entered.ok) throw new Error(`sendKeys answered ${entered.reason}: ${entered.detail}`);
  await awaitEcho(adapter, pane.paneId, second, 2);
  console.log("   ✓ held text went in with its Enter");

  const key = await adapter.sendKeys(pane.paneId, ["ctrl+c"]);
  if (!key.ok) throw new Error(`a ctrl+c answered ${key.reason}: ${key.detail}`);
  const refused = await adapter.sendKeys(pane.paneId, ["?"]);
  if (refused.ok || refused.reason !== "refused") throw new Error("a key herdr-core has no name for was not refused");
  console.log("   ✓ a key was pressed, and a key hc cannot press was refused");

  const changes: string[] = [];
  const watch = adapter.watch({
    panes: [pane.paneId],
    onUp: () => changes.push("up"),
    onDown: (reason) => changes.push(`down:${reason}`),
    onTopologyChange: () => changes.push("topology"),
    onPaneChange: () => changes.push("pane"),
  });
  await sleep(1500);
  const closed = await adapter.closePane(pane.paneId);
  if (!closed.ok) throw new Error(`closePane answered ${closed.reason}: ${closed.detail}`);
  await sleep(1500);
  watch.close();
  if (changes.at(0) !== "up") throw new Error(`the watch never came up: ${changes.join(", ") || "nothing"}`);
  if (!changes.includes("topology")) throw new Error(`closing the pane announced nothing: ${changes.join(", ")}`);
  const after = await adapter.snapshot();
  if (after.panes.some((candidate) => candidate.paneId === pane.paneId)) throw new Error("the closed pane is still listed");
  const gone = await adapter.typeText(pane.paneId, "into nothing");
  if (gone.ok || gone.reason !== "gone") throw new Error("text aimed at the closed pane was not answered gone");
  console.log("   ✓ the pane closed, the watch announced it, and a write to it answers gone");
}

async function main(): Promise<number> {
  const binary = resolveHcBinary(machineHcProbe());
  if (binary === null) {
    console.error("herdr-core (hc) is not installed here, so nothing was tested. Install it from https://herdr.dev");
    return 2;
  }
  console.log(`── herdr-app @ ${SESSION} — ${binary}`);
  let failure: string | null = null;
  try {
    const started = await hc(binary, [
      "run",
      "--bg",
      "--no-parent",
      "--name",
      "e2e",
      "--label",
      `herdr.space=${SPACE}`,
      "--label",
      `herdr.tab=${TAB}`,
      "--label",
      "where=Aula / Codex",
    ]);
    if (started.code !== 0) throw new Error(`hc run exited ${String(started.code)}: ${started.stderr.trim() || started.stdout.trim()}`);
    await drive(herdrAppMuxFactory.create({ endpoint: SESSION, timeoutMs: 10_000, options: {} }));
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  } finally {
    const stopped = await hc(binary, ["server", "stop"]);
    if (stopped.code !== 0) console.error(`   (hc server stop exited ${String(stopped.code)}: ${stopped.stderr.trim()})`);
  }
  if (failure !== null) {
    console.error(`   ✗ ${failure}`);
    return 1;
  }
  console.log("herdr-app: the adapter drives a real herdr-core.");
  return 0;
}

process.exit(await main());
