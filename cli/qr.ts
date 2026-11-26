import type { CliContext } from "./context.ts";
import { EXIT, type Io } from "./io.ts";
import type { Exec } from "./sys.ts";
import { bridgeUrl, configuredPublicUrl, tailnetInboundBlocked } from "./tailnet.ts";
import { renderQr } from "../scripts/qr.ts";

// `qr` — scan your way onto the bridge instead of typing a MagicDNS name on a phone keyboard.
// Ported from `cmd_qr` (the pre-shim pastor-ctl.sh), which is where it lived until the plugin's
// actions became a shim over this binary.
//
// Opt-in as its own verb rather than part of `start`: a scannable QR is ~16 rows even in the compact
// renderer, and Pastor is a PWA — once it's on your home screen you never need the URL again, so
// this is a first-run convenience that shouldn't tax every start.
//
// What lives HERE is which URL is worth a QR at all; the drawing stays in `scripts/qr.ts`, whose
// own suite decodes what it prints. `pastor pair` draws a second QR from the same decision — it is
// exported for that, so the refusals below are worded once and read identically from both verbs.

/** What deciding on a URL needs: where things are, the tailnet, and somewhere to talk. */
export interface QrDeps {
  ctx: CliContext;
  io: Io;
  exec: Exec;
}

/**
 * The URL to encode, or null with the reason already reported. `PASTOR_PUBLIC_URL` answers it
 * outright wherever it is set — see `configuredPublicUrl`. Without one, two refusals, both because
 * a QR is a promise that scanning it gets you somewhere:
 *
 *  - `PASTOR_SKIP_SERVE=1` with no `PASTOR_PUBLIC_URL` — Pastor publishes no front door there
 *    (ADR 0001), so only the operator can say what the ingress URL is;
 *  - no tailnet name — encoding `bridgeUrl`'s loopback placeholder would send a phone to its OWN
 *    localhost.
 */
export function urlToEncode(deps: QrDeps): string | null {
  // Named by the operator: encode exactly that, and skip the tailnet probes below — they describe a
  // front door Pastor published, which this URL by definition isn't.
  const named = configuredPublicUrl(deps.ctx.env);
  if (named !== null) return named;
  if (deps.ctx.env.PASTOR_SKIP_SERVE === "1") {
    deps.io.err(
      "sem endereço para o QR: PASTOR_SKIP_SERVE=1 e PASTOR_PUBLIC_URL não está definido — defina com o endereço",
    );
    deps.io.err("do seu proxy reverso, ou tire PASTOR_SKIP_SERVE para publicar o acesso pelo tailnet.");
    return null;
  }
  const url = bridgeUrl(deps.exec, deps.ctx);
  if (url.includes("(nome no Tailscale indisponível)")) {
    deps.io.err("sem endereço para o QR: o acesso pelo tailnet não está publicado (rode 'pastor serve')");
    return null;
  }
  // A QR for a URL nothing can reach is just a prettier dead end — it scans perfectly and then
  // hangs. Say so before drawing it, but still draw it: the ACL is the thing to fix, not the URL.
  if (tailnetInboundBlocked(deps.exec)) {
    deps.io.err("⚠ o filtro deste computador no Tailscale não aceita nenhum aparelho — o QR vai travar até a política do");
    deps.io.err("  tailnet liberar o acesso, ou outro aparelho entrar no tailnet. Veja 'pastor status'.");
  }
  return url;
}

export async function cmdQr(deps: QrDeps): Promise<number> {
  const url = urlToEncode(deps);
  if (url === null) return EXIT.FAIL;
  let code: string;
  try {
    code = await renderQr(url);
  } catch (err) {
    deps.io.err(`erro: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.FAIL;
  }
  // The URL is printed as plain text below the code — for anyone piping this, and for a camera that
  // won't focus. Same framing the shell's `qr.ts` entry point wrote.
  deps.io.out("");
  for (const line of code.split("\n")) deps.io.out(line);
  deps.io.out("");
  deps.io.out(url);
  deps.io.out("");
  return EXIT.OK;
}
