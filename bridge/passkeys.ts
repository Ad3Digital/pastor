// CHAVES DE ACESSO (WebAuthn) — uma segunda porta para o pareamento (patch local do Antonio).
//
// O código de `collie pair` continua sendo a porta de entrada: só um aparelho JÁ pareado registra
// uma chave. Depois disso, qualquer navegador que tenha essa chave (sincronizada pelo gerenciador de
// senhas do Google ou da Apple) se pareia sozinho: a assinatura da chave substitui o código de 8
// letras e o resultado é exatamente o de um `POST /api/pair` — um aparelho novo no registro, com nome
// próprio, revogável por `collie devices revoke`.
//
// Só a chave PÚBLICA fica aqui, em `passkeys.json` no diretório de estado (0600, escrita atômica).
// Os desafios vivem em memória, servem uma vez e expiram em cinco minutos.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

// Loaded on first use, never at startup: the library's certificate parser pulls in `tsyringe`, which
// throws unless `reflect-metadata` was evaluated first — and a bundled import order cannot promise
// that. Loading it lazily, polyfill first, also keeps a bridge that never sees a passkey from paying
// for the crypto stack at all.
const webauthn = () => import("reflect-metadata").then(() => import("@simplewebauthn/server"));

export const PASSKEYS_FILENAME = "passkeys.json";
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 64;

export interface StoredPasskey {
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  /** The paired device that registered it — who to ask if it ever needs explaining. */
  createdBy: string;
  createdAt: number;
}

/** The relying party is the page's own origin; a WebAuthn ceremony is bound to it by the browser. */
export interface RelyingParty {
  rpID: string;
  origin: string;
}

/**
 * The relying party for this request, from its `Origin` header. Null for anything but an https
 * origin on a DNS name (WebAuthn refuses IP addresses anyway). `checkAccess(…, "write")` has already
 * required that origin to be this bridge's own before any route here runs.
 */
export function relyingPartyOf(req: Request): RelyingParty | null {
  const raw = req.headers.get("origin");
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(":")) return null;
  return { rpID: url.hostname, origin: url.origin };
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export class PasskeyStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly challenges = new Map<string, { kind: "register" | "login"; label?: string; expires: number }>();

  constructor(
    private readonly stateDir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(stateDir, PASSKEYS_FILENAME);
  }

  private async read(): Promise<StoredPasskey[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      return Array.isArray(parsed) ? (parsed as StoredPasskey[]) : [];
    } catch {
      return [];
    }
  }

  private write(list: StoredPasskey[]): Promise<void> {
    const op = this.queue.then(async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
      await rename(tmp, this.path);
    });
    this.queue = op.catch(() => undefined);
    return op;
  }

  async count(): Promise<number> {
    return (await this.read()).length;
  }

  private remember(challenge: string, kind: "register" | "login", label?: string): void {
    const now = this.now();
    for (const [key, value] of this.challenges) if (value.expires < now) this.challenges.delete(key);
    // A flood of option requests cannot grow this without bound: the oldest go first.
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(challenge, { kind, label, expires: now + CHALLENGE_TTL_MS });
  }

  /** Single use: a challenge that matched is gone, so a captured response cannot be replayed. */
  private take(challenge: string, kind: "register" | "login"): { label?: string } | null {
    const entry = this.challenges.get(challenge);
    if (!entry || entry.kind !== kind || entry.expires < this.now()) return null;
    this.challenges.delete(challenge);
    return entry;
  }

  async registrationOptions(rp: RelyingParty, label: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = await this.read();
    const { generateRegistrationOptions } = await webauthn();
    const options = await generateRegistrationOptions({
      rpName: "Collie",
      rpID: rp.rpID,
      // One person, one account: every key this bridge holds belongs to the operator.
      userName: `collie@${rp.rpID}`,
      userDisplayName: "Collie",
      userID: new TextEncoder().encode(`collie-operator@${rp.rpID}`),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    this.remember(options.challenge, "register", label);
    return options;
  }

  /** Verifies and stores the key. Returns false when the ceremony does not check out. */
  async register(rp: RelyingParty, response: RegistrationResponseJSON): Promise<boolean> {
    let label: string | undefined;
    let result;
    try {
      const { verifyRegistrationResponse } = await webauthn();
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: (challenge) => {
          const taken = this.take(challenge, "register");
          label = taken?.label;
          return taken !== null;
        },
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch {
      return false;
    }
    if (!result.verified || !label) return false;
    const { credential } = result.registrationInfo;
    const list = (await this.read()).filter((p) => p.id !== credential.id);
    const entry: StoredPasskey = {
      id: credential.id,
      publicKey: b64url(credential.publicKey),
      counter: credential.counter,
      createdBy: label,
      createdAt: this.now(),
    };
    if (credential.transports) entry.transports = credential.transports;
    list.push(entry);
    await this.write(list);
    return true;
  }

  async loginOptions(rp: RelyingParty): Promise<PublicKeyCredentialRequestOptionsJSON> {
    // No allow-list: the keys are discoverable, so the browser offers whichever it holds for this site.
    const { generateAuthenticationOptions } = await webauthn();
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
    this.remember(options.challenge, "login");
    return options;
  }

  /** True when the response is a valid signature, by a key stored here, over a live challenge. */
  async verifyLogin(rp: RelyingParty, response: AuthenticationResponseJSON): Promise<boolean> {
    const list = await this.read();
    const stored = list.find((p) => p.id === response.id);
    if (!stored) return false;
    let result;
    try {
      const { verifyAuthenticationResponse } = await webauthn();
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: (challenge) => this.take(challenge, "login") !== null,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
          id: stored.id,
          publicKey: new Uint8Array(Buffer.from(stored.publicKey, "base64url")),
          counter: stored.counter,
          transports: stored.transports,
        },
        requireUserVerification: false,
      });
    } catch {
      return false;
    }
    if (!result.verified) return false;
    stored.counter = result.authenticationInfo.newCounter;
    await this.write(list);
    return true;
  }
}
