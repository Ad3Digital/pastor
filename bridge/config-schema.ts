// ── EVERY PASTOR SETTING, DECLARED ONCE ──────────────────────────────────────
//
// One table. The config-file reader, `pastor config init`'s generated file, `pastor config show`'s
// source column, `pastor config check`'s validation and `pastor doctor`'s finding all read it, so a
// setting cannot exist in one of those surfaces and be missing from the others.
//
// This module is a DECLARATION and nothing else: no `process.env`, no filesystem, no parsing. It
// names each setting's file key, its environment name, its kind, its default and one sentence of
// documentation. `bridge/config-source.ts` turns a file into an environment against it, and
// `bridge/config.ts` still does the actual reading exactly as it always did.
//
// **A key is derived from its environment name, mechanically**: `PASTOR_POLL_MS` is `poll_ms` in
// the `[bridge]` section. `bridge/config-schema.test.ts` asserts that for the whole table, so a row
// cannot invent a name. `HERDR_SOCKET_PATH` is the one row whose environment name does not start
// with `PASTOR_`, and it declares the key it takes.
//
// **A config file adds no environment key** (CREW_PROTOCOL.md §11). Moving these literals here does
// not change what any process reads; `bridge/solo-baseline.test.ts` pins the same 37 names it always
// pinned, now read from {@link CONFIG_SETTINGS} instead of from `bridge/config.ts`'s source.

import { DEFAULT_MUX } from "./mux/registry.ts";
import { DEFAULT_MAX_UPLOAD_MB } from "./uploads.ts";

/**
 * A `[section]` in the config file. Derived from what `bridge/config.ts`, `bridge/crew/`,
 * `bridge/stt/`, `cli/update.ts` and `cli/serve.ts` already group today, not invented.
 */
export type ConfigSection =
  | "bridge"
  | "network"
  | "mux"
  | "access"
  | "push"
  | "uploads"
  | "journal"
  | "crew"
  | "standby"
  | "update"
  | "serve"
  | "stt";

/** The sections in file order — the order `config init` writes and `config show` prints. */
export const CONFIG_SECTIONS: readonly ConfigSection[] = [
  "bridge",
  "network",
  "mux",
  "access",
  "push",
  "uploads",
  "journal",
  "crew",
  "standby",
  "update",
  "serve",
  "stt",
];

/** One line per section, printed as the banner comment `config init` writes above it. */
export const SECTION_DOC = {
  bridge: "How often the bridge looks, how much it reads, and where its state lives.",
  network: "The listener, the bind address and which hosts and origins may reach it.",
  mux: "Which multiplexer this pastor mirrors and where that multiplexer lives.",
  access: "Who may write: the Tailscale identity gate, the device header and the audit trail.",
  push: "Web Push (VAPID). All three are needed before a phone can be notified.",
  uploads: "The attachment size cap and the extra text types the upload route accepts.",
  journal: "Where each harness keeps its own session log, per harness.",
  crew: "The budgets a lead gives a member, and whether a peer keeps its own browser.",
  standby: "The deputy's second door: its port, its bind address and when it arms.",
  update: "Where releases come from, how many old versions stay, and the health budget.",
  serve: "The managed front door: whether Pastor publishes it, and on what.",
  stt: "Speech-to-text, which is absent until `pastor stt setup` writes it.",
} satisfies Record<ConfigSection, string>;

/**
 * How a value is read.
 *
 * One per reader in `bridge/config.ts` (`envInt`, `envBool`, `envEnum`, `envList`, `envRoots`) plus
 * `string` for a raw read and `secret` — a `string` that `config show` masks and that raises the
 * `.env` permission rule on the file holding it.
 */
export type ConfigKind = "int" | "bool" | "enum" | "list" | "roots" | "string" | "secret";

/** A default as it would appear in the file: the TOML value `config init` writes, commented out. */
export type ConfigDefault = string | number | boolean | readonly string[];

/** What every row carries whatever its kind is. */
interface ConfigSettingBase {
  /** The TOML key inside `[section]`. Derived from {@link ConfigSettingBase.env} unless declared. */
  readonly key: string;
  /** The environment name this setting has always had. The file maps onto it; it never replaces it. */
  readonly env: string;
  readonly section: ConfigSection;
  /** One sentence, written for the operator reading the generated file. */
  readonly doc: string;
  /** A deprecated environment name this row also answers to. */
  readonly alias?: string;
  /**
   * The `Config` field in `bridge/config.ts` this setting resolves into, when it is one.
   *
   * Absent for every setting resolved somewhere else — the crew budgets, the standby door, the
   * update lane, the front door and speech-to-text all read their own environment in their own
   * module. `bridge/solo-baseline.test.ts` reads this field: the rows that carry one are exactly the
   * env keys a SOLO instance's `loadConfig` names, which is the list §11's zero-tax contract pins.
   */
  readonly configField?: string;
}

/**
 * One setting, discriminated by its kind.
 *
 * A union rather than one interface with optional fields, so the COMPILER holds what a test would
 * otherwise have to assert: an `int` row's default is a number and may carry bounds, an `enum` row
 * must list its values, a `list` row's default is an array. A row that contradicts its own kind does
 * not typecheck, which is the earliest place to find it.
 */
export type ConfigSetting =
  | (ConfigSettingBase & {
      readonly kind: "int";
      readonly default: number;
      /** The bounds `envInt` already enforces. */
      readonly min?: number;
      readonly max?: number;
    })
  | (ConfigSettingBase & { readonly kind: "bool"; readonly default: boolean })
  | (ConfigSettingBase & {
      readonly kind: "enum";
      /** One of {@link values}, or `""` when the feature is absent until something configures it. */
      readonly default: string;
      readonly values: readonly string[];
    })
  | (ConfigSettingBase & { readonly kind: "list" | "roots"; readonly default: readonly string[] })
  | (ConfigSettingBase & { readonly kind: "string" | "secret"; readonly default: string });

/**
 * Every setting, in file order.
 *
 * A new `PASTOR_*` name anywhere under `bridge/` or `cli/` needs a row here or a named exemption in
 * `bridge/config-schema.test.ts`. That test greps the tree and fails with the missing name and the
 * file it found it in, so the fix is one row.
 */
export const CONFIG_SETTINGS: readonly ConfigSetting[] = [
  // ── bridge ─────────────────────────────────────────────────────────────────
  {
    key: "poll_ms",
    env: "PASTOR_POLL_MS",
    section: "bridge",
    kind: "int",
    default: 1500,
    min: 250,
    doc: "How often the bridge polls the multiplexer, in milliseconds.",
    configField: "pollMs",
  },
  {
    key: "poll_idle_ms",
    env: "PASTOR_POLL_IDLE_MS",
    section: "bridge",
    kind: "int",
    default: 12_000,
    min: 1000,
    doc: "The relaxed poll used while the event stream is healthy, in milliseconds.",
    configField: "pollIdleMs",
  },
  {
    key: "notify_delay_ms",
    env: "PASTOR_NOTIFY_DELAY_MS",
    section: "bridge",
    kind: "int",
    default: 30_000,
    min: 0,
    doc: "How long a blocked or done pane waits before it becomes a push, in milliseconds.",
    configField: "notifyDelayMs",
  },
  {
    key: "task_run_level",
    env: "PASTOR_TASK_RUN_LEVEL",
    section: "bridge",
    kind: "enum",
    values: ["limited", "highest"],
    default: "limited",
    doc: "Windows only: the privilege of the Task Scheduler task. highest needs an elevated shell at start.",
  },
  {
    key: "read_lines",
    env: "PASTOR_READ_LINES",
    section: "bridge",
    kind: "int",
    default: 200,
    min: 1,
    doc: "How many lines of the pane the detail view pulls.",
    configField: "readLines",
  },
  {
    key: "submit_keys",
    env: "PASTOR_SUBMIT_KEYS",
    section: "bridge",
    kind: "list",
    default: ["Enter"],
    doc: "The key sequence sent after a reply's text to submit it.",
    configField: "submitKeys",
  },
  {
    key: "multi_session",
    env: "PASTOR_MULTI_SESSION",
    section: "bridge",
    kind: "bool",
    default: true,
    doc: "Front every running session this pastor discovers, not only the primary one.",
    configField: "multiSession",
  },
  {
    key: "transcript",
    env: "PASTOR_TRANSCRIPT",
    section: "bridge",
    kind: "bool",
    default: true,
    doc: "Serve agent history from the agent's own on-disk session log.",
    configField: "transcript",
  },
  {
    key: "state_dir",
    env: "PASTOR_STATE_DIR",
    section: "bridge",
    kind: "string",
    default: "",
    doc: "Where runtime state lives. Empty takes ~/.local/state/pastor.",
    configField: "stateDir",
  },

  // ── network ────────────────────────────────────────────────────────────────
  {
    key: "port",
    env: "PASTOR_PORT",
    section: "network",
    kind: "int",
    default: 8787,
    min: 1,
    max: 65_535,
    doc: "The loopback port the bridge listens on.",
    configField: "port",
  },
  {
    key: "host",
    env: "PASTOR_HOST",
    section: "network",
    kind: "string",
    default: "127.0.0.1",
    doc: "The bind address. Loopback is required unless allow_non_loopback_bind is set.",
    configField: "host",
  },
  {
    key: "allow_non_loopback_bind",
    env: "PASTOR_ALLOW_NON_LOOPBACK_BIND",
    section: "network",
    kind: "bool",
    default: false,
    doc: "Permit a bind that is not loopback. Every browser-side write gate loses its basis.",
    configField: "allowNonLoopbackBind",
  },
  {
    key: "allow_any_host",
    env: "PASTOR_ALLOW_ANY_HOST",
    section: "network",
    kind: "bool",
    default: false,
    doc: "Turn Host validation off entirely. This is the DNS-rebinding hole.",
    configField: "allowAnyHost",
  },
  {
    key: "allowed_origins",
    env: "PASTOR_ALLOWED_ORIGINS",
    section: "network",
    kind: "list",
    default: [],
    doc: "Extra request origins beyond loopback.",
    configField: "allowedOrigins",
  },
  {
    key: "public_hosts",
    env: "PASTOR_PUBLIC_HOSTS",
    section: "network",
    kind: "list",
    default: [],
    doc: "Extra Host header values beyond loopback and the discovered Tailscale names.",
    configField: "publicHosts",
  },
  {
    key: "tailscale_hosts",
    env: "PASTOR_TAILSCALE_HOSTS",
    section: "network",
    kind: "list",
    default: [],
    doc: "Discovered and injected by the CLI. Operators do not set this.",
    configField: "tailscaleHosts",
  },
  {
    key: "public_url",
    env: "PASTOR_PUBLIC_URL",
    section: "network",
    kind: "string",
    default: "",
    doc: "The URL this pastor is reached at when Pastor did not publish the front door itself.",
  },

  // ── mux ────────────────────────────────────────────────────────────────────
  {
    key: "mux",
    env: "PASTOR_MUX",
    section: "mux",
    kind: "string",
    default: DEFAULT_MUX,
    doc: "Which multiplexer this pastor mirrors: herdr, herdr-app (the Herdr app), tern, tmux, zellij, tuios or durable.",
    configField: "mux",
  },
  {
    key: "socket_path",
    env: "HERDR_SOCKET_PATH",
    section: "mux",
    kind: "string",
    default: "",
    doc: "Herdr's control socket. Empty takes Herdr's own default location.",
    configField: "socketPath",
  },
  {
    key: "herdr_dial",
    env: "PASTOR_HERDR_DIAL",
    section: "mux",
    kind: "enum",
    values: ["auto", "net", "bun"],
    default: "auto",
    doc: "Which dialer opens the Herdr socket. auto is correct everywhere.",
    configField: "dialMode",
  },
  {
    key: "tmux_bin",
    env: "PASTOR_TMUX_BIN",
    section: "mux",
    kind: "string",
    default: "",
    doc: "Absolute path to the tmux binary, when it sits somewhere unusual.",
    configField: "tmuxBin",
  },
  {
    key: "tern_bin",
    env: "PASTOR_TERN_BIN",
    section: "mux",
    kind: "string",
    default: "",
    doc: "Absolute path to the tern binary, when it sits somewhere unusual.",
    configField: "ternBin",
  },
  {
    key: "zellij_bin",
    env: "PASTOR_ZELLIJ_BIN",
    section: "mux",
    kind: "string",
    default: "",
    doc: "Absolute path to the zellij binary, when it sits somewhere unusual.",
    configField: "zellijBin",
  },
  {
    key: "mux_endpoint_tmux",
    env: "PASTOR_MUX_ENDPOINT_TMUX",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The tmux server to drive. Empty takes tmux's own default server.",
    configField: "muxEndpoint",
  },
  {
    key: "mux_endpoint_zellij",
    env: "PASTOR_MUX_ENDPOINT_ZELLIJ",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The zellij session to drive. Empty works only when exactly one is running.",
    configField: "muxEndpoint",
  },
  {
    key: "mux_endpoint_tern",
    env: "PASTOR_MUX_ENDPOINT_TERN",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The tern daemon socket to drive. Empty takes the socket tern itself uses.",
    configField: "muxEndpoint",
  },
  {
    key: "durable_socket",
    env: "PASTOR_DURABLE_SOCKET",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The Unix socket a durable agent program listens on, when PASTOR_MUX is durable. Absolute, and private to your user (mode 0600).",
  },
  {
    key: "durable_url",
    env: "PASTOR_DURABLE_URL",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The https address of a durable agent program behind TLS, used instead of durable_socket and always with durable_token. Plain http only to 127.0.0.1 or localhost with a port.",
  },
  {
    key: "durable_token",
    env: "PASTOR_DURABLE_TOKEN",
    section: "mux",
    kind: "secret",
    default: "",
    doc: "The bearer token sent with every request to durable_url, at least 32 bytes. A file holding it must be mode 600.",
  },
  {
    key: "mux_endpoint_herdr_app",
    env: "PASTOR_MUX_ENDPOINT_HERDR_APP",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The herdr-core session behind the Herdr app to drive. Empty takes the default session, the one the app opens.",
    configField: "muxEndpoint",
  },
  {
    key: "mux_endpoint_tuios",
    env: "PASTOR_MUX_ENDPOINT_TUIOS",
    section: "mux",
    kind: "string",
    default: "",
    doc: "The tuios daemon socket to drive. Empty takes the socket tuios itself uses.",
    configField: "muxEndpoint",
  },

  // ── access ─────────────────────────────────────────────────────────────────
  {
    key: "trusted_user",
    env: "PASTOR_TRUSTED_USER",
    section: "access",
    kind: "string",
    default: "",
    doc: "The Tailscale login a request must carry. Empty leaves the gate off.",
    configField: "trustedUser",
  },
  {
    key: "trusted_user_optional",
    env: "PASTOR_TRUSTED_USER_OPTIONAL",
    section: "access",
    kind: "bool",
    default: false,
    doc: "Accept a request with no Tailscale-User-Login header. Re-opens the tagged-node gap.",
    configField: "trustedUserOptional",
  },
  {
    key: "access_team",
    env: "PASTOR_ACCESS_TEAM",
    section: "access",
    kind: "string",
    default: "",
    doc: "The Cloudflare Access team whose signed token every tunnel request must carry. Needs access_aud.",
    configField: "accessTeam",
  },
  {
    key: "access_aud",
    env: "PASTOR_ACCESS_AUD",
    section: "access",
    kind: "list",
    default: [],
    doc: "The Cloudflare Access application audience tag. Needs access_team.",
    configField: "accessAud",
  },
  {
    key: "device_header",
    env: "PASTOR_DEVICE_HEADER",
    section: "access",
    kind: "string",
    default: "",
    doc: "The request header a trusted proxy puts a device identifier in.",
    configField: "deviceHeader",
  },
  {
    key: "device_allowlist",
    env: "PASTOR_DEVICE_ALLOWLIST",
    section: "access",
    kind: "list",
    default: [],
    doc: "The device identifiers allowed to write. Everything else carrying the header reads only.",
    configField: "deviceAllowlist",
  },
  {
    key: "audit_content",
    env: "PASTOR_AUDIT_CONTENT",
    section: "access",
    kind: "enum",
    values: ["preview", "none"],
    default: "preview",
    doc: "How much of each value the audit trail keeps.",
    configField: "auditContent",
  },
  {
    key: "redact",
    env: "PASTOR_REDACT",
    section: "access",
    kind: "bool",
    default: true,
    doc: "Mask known secret shapes in pane text before it reaches a phone or a push.",
    configField: "redact",
  },

  // ── push ───────────────────────────────────────────────────────────────────
  {
    key: "vapid_public",
    env: "PASTOR_VAPID_PUBLIC",
    section: "push",
    kind: "string",
    default: "",
    doc: "The Web Push public key. All three push settings are needed before push works.",
    configField: "vapidPublic",
  },
  {
    key: "vapid_private",
    env: "PASTOR_VAPID_PRIVATE",
    section: "push",
    kind: "secret",
    default: "",
    doc: "The Web Push signing key. A file holding it must be mode 600.",
    configField: "vapidPrivate",
  },
  {
    key: "vapid_subject",
    env: "PASTOR_VAPID_SUBJECT",
    section: "push",
    kind: "string",
    default: "mailto:admin@example.com",
    doc: "The mailto: or https: subject the push service is told to reach you at.",
    configField: "vapidSubject",
  },
  {
    key: "cache_warn_seconds",
    env: "PASTOR_CACHE_WARN_SECONDS",
    section: "push",
    kind: "int",
    default: 300,
    min: 30,
    max: 3600,
    doc: "Seconds before a watched pane's prompt cache expires that the warning push is sent.",
    configField: "cacheWarnSeconds",
  },

  // ── uploads ────────────────────────────────────────────────────────────────
  {
    key: "max_upload_mb",
    env: "PASTOR_MAX_UPLOAD_MB",
    section: "uploads",
    kind: "int",
    default: DEFAULT_MAX_UPLOAD_MB,
    min: 1,
    max: 512,
    doc: "The largest attachment the upload route accepts, in whole megabytes.",
    configField: "maxUploadBytes",
  },
  {
    key: "upload_extra_types",
    env: "PASTOR_UPLOAD_EXTRA_TYPES",
    section: "uploads",
    kind: "list",
    default: [],
    doc: "Extra text extensions the upload route accepts, bare and lowercase.",
    configField: "uploadExtraTypes",
  },

  // ── journal ────────────────────────────────────────────────────────────────
  {
    key: "transcript_root",
    env: "PASTOR_TRANSCRIPT_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where Claude keeps its session logs. Empty takes ~/.claude/projects.",
    configField: "journalRoots",
  },
  {
    key: "codex_root",
    env: "PASTOR_CODEX_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where Codex keeps its session logs. Empty follows CODEX_HOME.",
    configField: "journalRoots",
  },
  {
    key: "pi_root",
    env: "PASTOR_PI_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where pi keeps its session logs. Empty follows PI_CODING_AGENT_DIR.",
    configField: "journalRoots",
  },
  {
    key: "opencode_root",
    env: "PASTOR_OPENCODE_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where OpenCode keeps its database. Empty follows XDG_DATA_HOME.",
    configField: "journalRoots",
  },
  {
    key: "grok_root",
    env: "PASTOR_GROK_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where Grok keeps its session logs. Empty follows GROK_HOME.",
    configField: "journalRoots",
  },
  {
    key: "hermes_root",
    env: "PASTOR_HERMES_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where Hermes keeps its session logs. Empty takes ~/.hermes.",
    configField: "journalRoots",
  },
  {
    key: "muse_root",
    env: "PASTOR_MUSE_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where Muse keeps its session logs. Empty takes $XDG_DATA_HOME/muse/sessions.",
    configField: "journalRoots",
  },
  {
    key: "openclaw_root",
    env: "PASTOR_OPENCLAW_ROOT",
    section: "journal",
    kind: "roots",
    default: [],
    doc: "Where OpenClaw keeps its state. Empty follows OPENCLAW_STATE_DIR, else ~/.openclaw.",
    configField: "journalRoots",
  },

  // ── crew ───────────────────────────────────────────────────────────────────
  {
    key: "crew_timeout_ms",
    env: "PASTOR_CREW_TIMEOUT_MS",
    section: "crew",
    kind: "int",
    default: 1200,
    min: 1,
    doc: "How long a member has to answer a lead's poll. Clamped to 0.8 of poll_ms.",
  },
  {
    key: "crew_hello_timeout_ms",
    env: "PASTOR_CREW_HELLO_TIMEOUT_MS",
    section: "crew",
    kind: "int",
    default: 5000,
    min: 1,
    doc: "How long a hello probe may take before the lead calls a member gone.",
  },
  {
    key: "peer_browser",
    env: "PASTOR_PEER_BROWSER",
    section: "crew",
    kind: "bool",
    default: false,
    doc: "Keep this peer's own browser front door up. Peer mode only.",
  },

  // ── standby ────────────────────────────────────────────────────────────────
  {
    key: "standby_port",
    env: "PASTOR_STANDBY_PORT",
    section: "standby",
    kind: "int",
    default: 0,
    min: 1,
    max: 65_535,
    doc: "The deputy's standby door. Absent means no door is bound at all.",
  },
  {
    key: "standby_host",
    env: "PASTOR_STANDBY_HOST",
    section: "standby",
    kind: "string",
    default: "127.0.0.1",
    doc: "Where the standby door binds.",
  },
  {
    key: "standby_arm_ms",
    env: "PASTOR_STANDBY_ARM_MS",
    section: "standby",
    kind: "int",
    default: 0,
    min: 1,
    doc: "How long the lead may be silent before the door arms. Empty uses the formula.",
  },

  // ── update ─────────────────────────────────────────────────────────────────
  {
    key: "update_repo",
    env: "PASTOR_UPDATE_REPO",
    section: "update",
    kind: "string",
    default: "Ad3Digital/pastor",
    doc: "The owner/repo releases are taken from. Set it only when you run a fork on purpose.",
  },
  {
    key: "github_token",
    env: "PASTOR_GITHUB_TOKEN",
    section: "update",
    kind: "secret",
    default: "",
    doc: "A GitHub token for the release check, so the API rate limit is yours and not your network's. No scopes are needed. GH_TOKEN and GITHUB_TOKEN are read too.",
  },
  {
    key: "keep_versions",
    env: "PASTOR_KEEP_VERSIONS",
    section: "update",
    kind: "int",
    default: 2,
    min: 1,
    doc: "How many installed versions a binary install keeps, the current one included.",
  },
  {
    key: "update_health_timeout_ms",
    env: "PASTOR_UPDATE_HEALTH_TIMEOUT_MS",
    section: "update",
    kind: "int",
    default: 30_000,
    min: 1,
    doc: "How long an update waits for the restarted bridge to answer.",
  },

  // ── serve ──────────────────────────────────────────────────────────────────
  {
    key: "skip_serve",
    env: "PASTOR_SKIP_SERVE",
    section: "serve",
    kind: "bool",
    default: false,
    doc: "Publish no front door. Your own reverse proxy owns the ingress instead.",
    configField: "skipServe",
  },
  {
    key: "base_path",
    env: "PASTOR_BASE_PATH",
    section: "serve",
    kind: "string",
    default: "",
    doc: "The path Pastor is mounted under when a proxy gives it one, such as /pastor. Empty means the root.",
    configField: "basePath",
  },
  {
    key: "serve_mode",
    env: "PASTOR_SERVE_MODE",
    section: "serve",
    kind: "enum",
    values: ["https", "http"],
    default: "https",
    doc: "Whether tailscale serve terminates TLS. Use http on Headscale or .internal domains.",
  },
  {
    key: "serve_port",
    env: "PASTOR_SERVE_PORT",
    section: "serve",
    kind: "int",
    default: 443,
    min: 1,
    max: 65_535,
    doc: "The https listener port. Inert under serve_mode = http.",
  },

  // ── stt ────────────────────────────────────────────────────────────────────
  {
    key: "stt_provider",
    env: "PASTOR_STT_PROVIDER",
    section: "stt",
    kind: "enum",
    values: ["openai-compatible", "codex", "local-cli"],
    default: "",
    doc: "Which speech-to-text provider to build. Absent leaves the feature off.",
  },
  {
    key: "stt_url",
    env: "PASTOR_STT_URL",
    section: "stt",
    kind: "string",
    default: "",
    doc: "The OpenAI-compatible API base, its version prefix included and no trailing slash.",
  },
  {
    key: "stt_model",
    env: "PASTOR_STT_MODEL",
    section: "stt",
    kind: "string",
    default: "gpt-transcribe",
    doc: "The transcription model that endpoint understands.",
  },
  {
    key: "stt_key",
    env: "PASTOR_STT_KEY",
    section: "stt",
    kind: "secret",
    default: "",
    doc: "The bearer credential for that endpoint. A file holding it must be mode 600.",
  },
  {
    key: "stt_lang",
    env: "PASTOR_STT_LANG",
    section: "stt",
    kind: "string",
    default: "",
    doc: "The language you speak, as ISO-639-1. Empty lets the model detect it.",
  },
  {
    key: "stt_wire_identity",
    env: "PASTOR_STT_WIRE_IDENTITY",
    section: "stt",
    kind: "enum",
    values: ["honest", "codex-cli"],
    default: "honest",
    doc: "Which identity the codex provider wears on the wire.",
  },
  {
    key: "codex_bin",
    env: "PASTOR_CODEX_BIN",
    section: "stt",
    kind: "string",
    default: "codex",
    doc: "The codex binary the codex provider borrows your session from.",
  },
  {
    key: "stt_command",
    env: "PASTOR_STT_COMMAND",
    section: "stt",
    kind: "string",
    default: "",
    doc: "The command the local-cli provider runs, an absolute path or a name on PATH.",
  },
];

/** Every environment name the table answers to, aliases included. Built once. */
const BY_ENV: ReadonlyMap<string, ConfigSetting> = new Map(
  CONFIG_SETTINGS.flatMap((s) =>
    s.alias === undefined
      ? ([[s.env, s]] as const)
      : ([
          [s.env, s],
          [s.alias, s],
        ] as const),
  ),
);

const BY_KEY: ReadonlyMap<string, ConfigSetting> = new Map(
  CONFIG_SETTINGS.map((s) => [`${s.section}.${s.key}`, s]),
);

/** The row an environment name belongs to, or `undefined`. Answers to a deprecated alias too. */
export function settingByEnv(env: string): ConfigSetting | undefined {
  return BY_ENV.get(env);
}

/** The row a `[section]` key belongs to, or `undefined` — which is what makes an unknown key. */
export function settingByKey(section: ConfigSection, key: string): ConfigSetting | undefined {
  return BY_KEY.get(`${section}.${key}`);
}

/**
 * The environment name a file key maps onto — the naming rule APPLIED, never guessed.
 *
 * Looked up in the table first, so `socket_path` lands on `HERDR_SOCKET_PATH` rather than on a name
 * nothing reads. An unknown key falls back to the mechanical rule, which is what makes the
 * validation message able to say which name the key would have meant.
 */
export function envNameFor(key: string, section: ConfigSection): string {
  return settingByKey(section, key)?.env ?? `PASTOR_${key.toUpperCase()}`;
}
