import { join } from "node:path";

import { formatAuditLine } from "../bridge/audit.ts";
import { ADDED_FILE, formatAddedFile, parseAddedText } from "../bridge/launchers-added.ts";
import {
  CODE_TTL_MS,
  coerceRegistry,
  DEVICES_FILENAME,
  escapeLabelForTerminal,
  generateCode,
  isExpired,
  newPending,
  type PairedDevice,
  type PairedRegistry,
  parseLifetime,
  PENDING_FILENAME,
  removeDevice,
  setDeviceExpiry,
} from "../bridge/pairing.ts";
import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import { urlToEncode } from "./qr.ts";
import type { Exec, Files } from "./sys.ts";
import { renderQr } from "../scripts/qr.ts";

// `pair`, `devices list`, `devices revoke` — the operator's half of device pairing. The pure
// decisions all live in `bridge/pairing.ts`; this module is the terminal, the two files under the
// state dir, and the words an operator reads.
//
// ── WHY THE TERMINAL MINTS THE CODE, AND NOT THE WEB UI ──────────────────────
// Enrolment is a bootstrap problem: the phone asking to be paired is, by definition, the one party
// that cannot yet prove anything — it holds no token, and the header gate (if configured at all) only
// says what the network asserts about it. A "pair this device" button in Pastor's own UI would
// therefore be authorised by nothing, and would hand a write credential to whoever loaded the page.
// The operator's shell on the host IS the proof: reaching it already implies the access pairing is
// there to fence off. So the code is minted where that proof already exists and carried out of band —
// eyes, from a terminal to a phone keyboard — and the UI's only job is to spend it.
//
// ── WHY THE CODE MAY ALSO BE A QR ────────────────────────────────────────────
// `pair` prints the code as a QR that opens Settings with it filled in. That gives away nothing: the
// terminal is already the out-of-band channel the code travels on, and whoever reads the QR is
// whoever reads the line above it. The QR only spares the phone keyboard eight characters. The code
// it carries is the same one — single-use, dead in 10 minutes, stored as a hash and never as itself
// — so a screenshot of this terminal is worth exactly what a photograph of it was already worth.
//
// The same reasoning runs the other way for revocation: a lost phone is revoked from the machine, not
// from the phone. `devices revoke` needs no service restart — the bridge re-reads
// `paired-devices.json` per request (`readRegistrySync` in bridge/pairing.ts), so the device loses
// write access on its very next call.

/** The `devices` sub-verbs, in the order the usage block prints them. */
export const DEVICES_SUBCOMMANDS = ["list", "revoke", "set-expiry", "clear-expiry"] as const;

export interface PairingDeps {
  ctx: CliContext;
  io: Io;
  files: Files;
  /** The tailnet probes `urlToEncode` runs to decide whether the code is worth a QR. */
  exec: Exec;
  /** Injected so a test can pin the printed expiry; production leaves it. */
  now?: () => number;
  /** Injected so a test can pin the minted code; production leaves it. */
  random?: (n: number) => Buffer;
  /**
   * Append one line to `<stateDir>/audit.log`, the bridge's own trail. `devices revoke` writes the
   * launcher rows it removes there (ADR 0094). Absent writes no line.
   */
  appendAudit?: (line: string) => void;
}

const pendingPath = (ctx: CliContext): string => join(ctx.stateDir, PENDING_FILENAME);
const registryPath = (ctx: CliContext): string => join(ctx.stateDir, DEVICES_FILENAME);

/**
 * The registry as it is on disk. Absent, unreadable or malformed all read as "nothing paired".
 *
 * Exported because `crew deputy` asks the same question for a different reason (RFC §6.4: a lead with
 * nothing paired could never arm a standby door), and two readers of one credential file is two
 * places for "is anything paired?" to answer differently.
 */
export function pairedRegistryOf(files: Files, stateDir: string): PairedRegistry {
  const raw = files.read(join(stateDir, DEVICES_FILENAME));
  if (raw === null) return coerceRegistry(null);
  try {
    return coerceRegistry(JSON.parse(raw));
  } catch {
    return coerceRegistry(null);
  }
}

function readRegistry(deps: PairingDeps): PairedRegistry {
  return pairedRegistryOf(deps.files, deps.ctx.stateDir);
}

/** Owner-only, and the directory too: both files are credentials-in-hash-form. */
function writeOwnerOnly<TDocument>(deps: PairingDeps, path: string, value: TDocument): void {
  deps.files.mkdirp(deps.ctx.stateDir, 0o700);
  deps.files.write(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

const stamp = (ms: number): string => (ms > 0 ? new Date(ms).toISOString() : "nunca");

/** One device's expiry, as the operator reads it: no expiry, a date ahead, or a date passed. */
function expiryText(device: PairedDevice, now: number): string {
  if (device.expiresAt === undefined) return "sem validade";
  const at = new Date(device.expiresAt).toISOString();
  return isExpired(device, now) ? `VENCIDO ${at}` : `vence ${at}`;
}

/** A moment in the operator's own clock and zone, to the minute: `2026-11-06 14:32`. */
const two = (n: number): string => String(n).padStart(2, "0");

function localStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A lifetime in the operator's own unit back: `30 days`, `12 hours`, `2 weeks`. */
function lifetimeText(ms: number): string {
  const units: [number, string][] = [
    [7 * 86_400_000, "semana"],
    [86_400_000, "dia"],
    [3_600_000, "hora"],
  ];
  for (const [size, name] of units) {
    if (ms % size === 0) {
      const n = ms / size;
      return `${n} ${name}${n === 1 ? "" : "s"}`;
    }
  }
  return `${Math.round(ms / 3_600_000)} horas`;
}

/**
 * `pair`'s own arguments: nothing, or `--expires <duration>` (also `--expires=<duration>`). Anything
 * else is refused rather than ignored — `--expire 30d` silently minting a token that never expires
 * is the one typo this verb must not forgive.
 */
function parsePairArgs(args: readonly string[]): { ok: true; lifetimeMs?: number } | { ok: false; reason: string } {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--expires") {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) return { ok: false, reason: "--expires needs a duration, for example `--expires 30d`" };
      raw = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--expires=")) {
      raw = arg.slice("--expires=".length);
      continue;
    }
    return { ok: false, reason: `unknown argument \`${arg}\`` };
  }
  if (raw === undefined) return { ok: true };
  const parsed = parseLifetime(raw);
  return parsed.ok ? { ok: true, lifetimeMs: parsed.ms } : { ok: false, reason: parsed.reason };
}

// ── pair ─────────────────────────────────────────────────────────────────────

/**
 * `pastor pair` — mint the one-time code the phone spends on `/api/pair`.
 *
 * Only the code's HASH is written, so the string printed here is the only copy that will ever exist;
 * a second `pair` overwrites the pending file, which kills the previous code (that is the intended
 * way to cancel one, and the output says so).
 *
 * The QR below the code is best-effort and never a failure: the pending file is already on disk by
 * the time it is drawn, so a missing URL or a broken renderer would only cost a keyboard shortcut.
 */
export async function cmdPair(deps: PairingDeps, args: readonly string[] = []): Promise<number> {
  const parsed = parsePairArgs(args);
  if (!parsed.ok) {
    deps.io.err(`erro: ${parsed.reason}`);
    deps.io.err("uso: pastor pair [--expires <duração>]   durações: 12h, 30d, 2w");
    return EXIT.USAGE;
  }
  const now = (deps.now ?? Date.now)();
  const code = generateCode(deps.random);
  const pending = newPending(code, now, CODE_TTL_MS, parsed.lifetimeMs);
  const path = pendingPath(deps.ctx);
  const replaced = deps.files.exists(path);

  try {
    writeOwnerOnly(deps, path, pending);
  } catch (err) {
    deps.io.err(`erro: não deu para gravar ${path} — ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }

  const minutes = Math.round((pending.expiresAt - now) / 60_000);
  deps.io.out(code);
  deps.io.out("");
  deps.io.out(
    `  uso único · vence ${new Date(pending.expiresAt).toISOString()} (${minutes} minutos)`,
  );
  if (parsed.lifetimeMs !== undefined) {
    deps.io.out(
      `  O aparelho pareado com este código para de funcionar ${lifetimeText(parsed.lifetimeMs)} depois de parear; ` +
        "`pastor devices set-expiry` ou `clear-expiry` muda isso depois.",
    );
    deps.io.out(`  Vence em ${localStamp(now + parsed.lifetimeMs)} depois de usado.`);
  } else {
    deps.io.out("  Este acesso não vence. Use --expires 30d para limitar.");
  }
  deps.io.out("  Abra o Pastor no celular, vá em Configurações e digite este código lá.");
  deps.io.out("  Aparece uma vez só: só o hash fica salvo, e o Pastor aceita o código sem reiniciar.");
  if (replaced) {
    deps.io.out("  Um código de um `pastor pair` anterior ainda estava valendo; agora ele não vale mais.");
  }
  await printPairQr(deps, code);
  return EXIT.OK;
}

/**
 * The scannable half. `urlToEncode` (cli/qr.ts) owns which URL is worth a QR and has already said on
 * stderr why it refused, so the line here only points at that and reassures: the code above stands
 * on its own, and the operator can still type it.
 */
async function printPairQr(deps: PairingDeps, code: string): Promise<void> {
  const base = urlToEncode({ ctx: deps.ctx, io: deps.io, exec: deps.exec });
  if (base === null) {
    deps.io.out("  Sem QR: o endereço do Pastor é desconhecido, veja a nota acima; o código acima funciona mesmo assim.");
    return;
  }
  // NO `#paired-devices` FRAGMENT, deliberately, even though the Settings card answers to one. HTML
  // runs the focusing steps on a fragment target once it exists, and it does that AFTER the page's
  // scripts — so the browser itself would pull focus onto the card and off the name field, which is
  // the only thing left to type. `pair` alone is the signal: the card scrolls itself into view when
  // it sees it (web/src/components/paired-devices.tsx). Measured in a browser, not reasoned about.
  // `CODE_ALPHABET` is URL-safe, so the encode is a no-op — it is here so it stays true if it isn't.
  const url = `${base.replace(/\/+$/, "")}/settings?pair=${encodeURIComponent(code)}`;
  let drawn: string;
  try {
    drawn = await renderQr(url);
  } catch (err) {
    deps.io.out(`  Sem QR: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  deps.io.out("");
  for (const line of drawn.split("\n")) deps.io.out(line);
  deps.io.out("");
  deps.io.out(url);
  deps.io.out("  Leia com a câmera: o Pastor abre as Configurações no celular com o código já preenchido.");
}

// ── devices ──────────────────────────────────────────────────────────────────

/** `pastor devices list` — who holds a write credential for this bridge. */
export function cmdDevicesList(deps: PairingDeps): number {
  const { devices } = readRegistry(deps);
  if (devices.length === 0) {
    deps.io.out("nenhum aparelho pareado: o Pastor não responde a nenhum celular ou navegador até um ser pareado (o pareamento é sempre exigido).");
    deps.io.out("Rode `pastor pair` para parear o primeiro aparelho.");
    return EXIT.OK;
  }
  const now = (deps.now ?? Date.now)();
  const width = Math.max(...devices.map((d) => escapeLabelForTerminal(d.label).length));
  for (const d of devices) {
    deps.io.out(
      `${escapeLabelForTerminal(d.label).padEnd(width)}  pareado ${stamp(d.createdAt)}  visto ${stamp(d.lastSeenAt)}  ${expiryText(d, now)}`,
    );
  }
  if (devices.some((d) => isExpired(d, now))) {
    deps.io.out(
      "Um aparelho vencido é recusado mas continua na lista; revogue, ou dê uma nova validade.",
    );
  }
  return EXIT.OK;
}

/** How a label typed on the command line names a device: exactly one, none, or several. */
type LabelMatch =
  | { kind: "one"; label: string }
  | { kind: "none" }
  | { kind: "many"; labels: string[] };

/**
 * Find the device a typed label names. An exact match always wins. Without one, a case-insensitive
 * match is accepted only when it is unique — `Phone` and `phone` can both exist, and choosing between
 * them is the operator's call, not this verb's.
 */
function matchLabel(registry: PairedRegistry, typed: string): LabelMatch {
  if (registry.devices.some((d) => d.label === typed)) return { kind: "one", label: typed };
  const folded = typed.toLowerCase();
  const labels = registry.devices.filter((d) => d.label.toLowerCase() === folded).map((d) => d.label);
  if (labels.length === 1) return { kind: "one", label: labels[0]! };
  return labels.length === 0 ? { kind: "none" } : { kind: "many", labels };
}

/** Say why a label named nothing (or too much) on stderr, in revoke's words. */
function reportLabelMiss(deps: PairingDeps, registry: PairedRegistry, typed: string, match: LabelMatch): void {
  if (match.kind === "many") {
    deps.io.err(`error: \`${escapeLabelForTerminal(typed)}\` combina com mais de um aparelho pareado: ${match.labels.map(escapeLabelForTerminal).join(", ")}`);
    deps.io.err("  digite o nome exatamente como o `pastor devices list` mostra.");
    return;
  }
  deps.io.err(`erro: nenhum aparelho pareado com o nome \`${escapeLabelForTerminal(typed)}\``);
  deps.io.err(
    registry.devices.length === 0
      ? "  nada está pareado neste computador, veja `pastor devices list`."
      : `  pareados: ${registry.devices.map((d) => escapeLabelForTerminal(d.label)).join(", ")}`,
  );
}

/** Write the registry, or say why not. True on success. */
function writeRegistryOrReport(deps: PairingDeps, next: PairedRegistry): boolean {
  try {
    writeOwnerOnly(deps, registryPath(deps.ctx), next);
    return true;
  } catch (err) {
    deps.io.err(
      `erro: não deu para gravar ${registryPath(deps.ctx)}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * `pastor devices set-expiry <label> <duration>` — give a paired device a lifetime counted from now.
 * Also the way back for an expired device the operator still trusts: a fresh lifetime revives it.
 */
export function cmdDevicesSetExpiry(deps: PairingDeps, args: readonly string[]): number {
  const [typed, duration] = args;
  if (typed === undefined || typed === "" || duration === undefined || duration === "" || args.length > 2) {
    deps.io.err("uso: pastor devices set-expiry <nome> <duração>   durações: 12h, 30d, 2w");
    return EXIT.USAGE;
  }
  const lifetime = parseLifetime(duration);
  if (!lifetime.ok) {
    deps.io.err(`erro: ${lifetime.reason}`);
    return EXIT.USAGE;
  }
  const registry = readRegistry(deps);
  const match = matchLabel(registry, typed);
  if (match.kind !== "one") {
    reportLabelMiss(deps, registry, typed, match);
    return EXIT.FAIL;
  }
  const expiresAt = (deps.now ?? Date.now)() + lifetime.ms;
  const next = setDeviceExpiry(registry, match.label, expiresAt);
  if (next === null) {
    reportLabelMiss(deps, registry, typed, { kind: "none" });
    return EXIT.FAIL;
  }
  if (!writeRegistryOrReport(deps, next)) return EXIT.FAIL;
  deps.io.out(
    `✓ "${escapeLabelForTerminal(match.label)}" vence ${new Date(expiresAt).toISOString()} (daqui a ${lifetimeText(lifetime.ms)}). Não precisa reiniciar.`,
  );
  return EXIT.OK;
}

/** `pastor devices clear-expiry <label>` — the device's token works until it is revoked. */
export function cmdDevicesClearExpiry(deps: PairingDeps, args: readonly string[]): number {
  const [typed] = args;
  if (typed === undefined || typed === "" || args.length > 1) {
    deps.io.err("uso: pastor devices clear-expiry <nome>");
    return EXIT.USAGE;
  }
  const registry = readRegistry(deps);
  const match = matchLabel(registry, typed);
  if (match.kind !== "one") {
    reportLabelMiss(deps, registry, typed, match);
    return EXIT.FAIL;
  }
  const had = registry.devices.find((d) => d.label === match.label)?.expiresAt;
  if (had === undefined) {
    deps.io.out(`"${escapeLabelForTerminal(match.label)}" não tem validade, então não há nada para tirar.`);
    return EXIT.OK;
  }
  const next = setDeviceExpiry(registry, match.label, null);
  if (next === null) {
    reportLabelMiss(deps, registry, typed, { kind: "none" });
    return EXIT.FAIL;
  }
  if (!writeRegistryOrReport(deps, next)) return EXIT.FAIL;
  deps.io.out(`✓ "${escapeLabelForTerminal(match.label)}" não vence mais. O acesso funciona até você revogar.`);
  return EXIT.OK;
}

/** `pastor devices revoke <label>` — drop one device's credential. */
export function cmdDevicesRevoke(deps: PairingDeps, args: readonly string[]): number {
  const label = args[0];
  if (label === undefined || label === "") {
    deps.io.err("uso: pastor devices revoke <nome>");
    return EXIT.USAGE;
  }
  const registry = readRegistry(deps);
  const next = removeDevice(registry, label);
  if (next === null) {
    deps.io.err(`erro: nenhum aparelho pareado com o nome \`${escapeLabelForTerminal(label)}\``);
    deps.io.err(
      registry.devices.length === 0
        ? "  nada está pareado neste computador — `pastor devices list`."
        : `  pareados: ${registry.devices.map((d) => escapeLabelForTerminal(d.label)).join(", ")}`,
    );
    return EXIT.FAIL;
  }

  try {
    writeOwnerOnly(deps, registryPath(deps.ctx), next);
  } catch (err) {
    deps.io.err(
      `erro: não deu para gravar ${registryPath(deps.ctx)} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return EXIT.FAIL;
  }

  deps.io.out(`✓ "${escapeLabelForTerminal(label)}" revogado: perde todo o acesso no próximo pedido (não precisa reiniciar).`);
  const forgotten = forgetLauncherRows(deps, label);
  if (forgotten > 0) {
    deps.io.out(
      `  ${forgotten === 1 ? "Removido 1 atalho" : `Removidos ${forgotten} atalhos`} que ele criou pelo celular. O Pastor em execução remove os que ele criou nos membros da crew.`,
    );
  }
  if (next.devices.length === 0) {
    deps.io.out("  Era o último aparelho pareado: o Pastor agora não responde a nenhum celular ou navegador. Rode `pastor pair` para parear um.");
  }
  return EXIT.OK;
}

/**
 * Remove the launcher rows `label` added from its phone on THIS machine (ADR 0094), and write one
 * audit line per row. The bridge reads `launchers-added.json` by mtime, so the rows leave the launch
 * allowlist on its next read. A file the store would not write over is left alone and said so: the
 * bridge's read-time sweep drops the rows once the file reads again. Answers how many went.
 */
function forgetLauncherRows(deps: PairingDeps, label: string): number {
  const path = join(deps.ctx.stateDir, ADDED_FILE);
  const text = deps.files.read(path);
  if (text === null) return 0;
  const { rows } = parseAddedText(text);
  if (rows === null) {
    deps.io.err(`  nota: ${path} não pode ser lido, então os atalhos que "${escapeLabelForTerminal(label)}" criou ficam até ser possível.`);
    return 0;
  }
  const gone = rows.filter((r) => r.device === label && r.via === "local");
  if (gone.length === 0) return 0;
  try {
    const tmp = `${path}.${process.pid}.cli.tmp`;
    deps.files.write(tmp, formatAddedFile(rows.filter((r) => !gone.includes(r))), 0o600);
    deps.files.rename(tmp, path);
  } catch (err) {
    deps.io.err(`  nota: não deu para gravar ${path} — ${err instanceof Error ? err.message : String(err)}; o Pastor descarta os atalhos na próxima leitura.`);
    return 0;
  }
  const content = deps.ctx.env.PASTOR_AUDIT_CONTENT === "none" ? "none" : "preview";
  const now = (deps.now ?? Date.now)();
  for (const row of gone) {
    deps.appendAudit?.(
      formatAuditLine(
        {
          action: "launcher.remove",
          device: null,
          detail: { requestId: row.id, command: row.command, label: row.label, addedBy: row.device, reason: "device-revoked" },
        },
        now,
        content,
      ),
    );
  }
  return gone.length;
}

export function devicesUsage(): string {
  return `usage: pastor devices {${DEVICES_SUBCOMMANDS.join("|")}}`;
}

/**
 * The parent verb. Reached only when no sub-verb matched — a bare `pastor devices`, or a misspelt
 * one — and it names each sub-verb with its summary, as `cmdCrew` does.
 */
export function cmdDevices(deps: PairingDeps, args: readonly string[]): number {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      return cmdDevicesList(deps);
    case "revoke":
      return cmdDevicesRevoke(deps, rest);
    case "set-expiry":
      return cmdDevicesSetExpiry(deps, rest);
    case "clear-expiry":
      return cmdDevicesClearExpiry(deps, rest);
    default:
      if (sub !== undefined && sub !== "" && sub !== "help") {
        deps.io.err(`erro: subcomando de devices desconhecido \`${sub}\``);
      }
      deps.io.err(devicesUsage());
      deps.io.err("  list           os aparelhos pareados, com quando cada um foi pareado, visto por último e quando vence");
      deps.io.err("  revoke         tira um aparelho pelo nome: `devices revoke <nome>`");
      deps.io.err("  set-expiry     dá uma validade a partir de agora: `devices set-expiry <nome> 30d`");
      deps.io.err("  clear-expiry   tira a validade de um aparelho: `devices clear-expiry <nome>`");
      return EXIT.USAGE;
  }
}
