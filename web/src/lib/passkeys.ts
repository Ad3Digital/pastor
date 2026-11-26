// Chaves de acesso (passkeys): parear um aparelho novo sem código. A rota fica no bridge
// (bridge/passkeys.ts); aqui fica a cerimônia WebAuthn do navegador.
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/browser";

import { postPasskey, type PasskeyRefusal } from "./api";

/** Registers a passkey for this bridge from a device that is already paired. */
export async function createPasskey(): Promise<{ ok: true } | PasskeyRefusal> {
  const { startRegistration } = await import("@simplewebauthn/browser");
  const options = await postPasskey<PublicKeyCredentialCreationOptionsJSON>("/api/passkey/register/options", "{}");
  if ("ok" in options) return options;
  const response = await startRegistration({ optionsJSON: options });
  return postPasskey<{ ok: true }>("/api/passkey/register/verify", JSON.stringify({ response }));
}

/** Pairs THIS device under `label` by signing in with a passkey, instead of a code. */
export async function pairWithPasskey(
  label: string,
): Promise<{ ok: true; token: string; label: string } | PasskeyRefusal> {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const options = await postPasskey<PublicKeyCredentialRequestOptionsJSON>("/api/passkey/login/options", "{}");
  if ("ok" in options) return options;
  const response = await startAuthentication({ optionsJSON: options });
  const res = await postPasskey<{ token: string; label: string }>(
    "/api/passkey/login/verify",
    JSON.stringify({ response, label }),
  );
  return "token" in res ? { ok: true, token: res.token, label: res.label } : res;
}
