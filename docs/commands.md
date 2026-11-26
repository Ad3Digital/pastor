# Commands

Every verb uses the format **`pastor <verb>`**. This is the canonical syntax across all
installations, implemented directly in the binary (`cli/`). Before adding `pastor` to your PATH
([below](#put-pastor-on-your-path)), run `bin/pastor <verb>` from the repository root. On a
Herdr-managed installation, these same verbs register as Herdr actions ([below](#herdr-actions))
with identical behavior.

If the host runs multiple instances, prepend `PASTOR_INSTANCE=<name>` to every verb. See
[Multiple Pastor instances on one host](deployment.md#multiple-pastor-instances-on-one-host).

| Verb | Command | What it does |
| --- | --- | --- |
| **Start** | `pastor start` | Build if needed, serve, print the URL |
| **Stop** | `pastor stop` | Pause the bridge; removes nothing |
| **Restart** | `pastor restart` | Stop, then start |
| **Status** | `pastor status` | The *Pastor is running* banner + URLs |
| **URL** | `pastor url` | Print the tailnet URL |
| **QR** | `pastor qr` | The same URL as a scannable code |
| **Version** | `pastor version` | The running version (`0.x.y+sha`) |
| **Skill** | `pastor skill` | The agent-facing brief on Pastor, for an AI coding agent working in your terminal (also `pastor --skill`) |
| **Docs** | `pastor docs` · `pastor docs <name>` · `pastor docs --all` | These pages, printed out of the binary itself |
| **Update** | `pastor update` | Stage the newest release of your major, flip to it, restart and verify (`--check` preflights, `--status` reports, `--major` crosses one) |
| **Rollback** | `pastor update --rollback` | Put the previous version back (not on a Herdr-managed checkout, which has none staged) |
| **Uninstall** | `pastor uninstall` | Remove the service; keep `.env` and the install |
| **Pair** | `pastor pair` · `pastor pair --expires <duration>` | Print an 8-character code and a QR code, good for 10 minutes; scan the QR code to open Settings → System → Paired devices with the code filled in, or enter the code manually to get it [paired](security.md#pair-a-device--the-write-credential). Without `--expires` the token never expires and the command says so; with it (`12h`, `30d`, `2w`) the command prints the date the token stops working once claimed. A script claims the code with a label of its own, for example `script`, and pairs once ([Give a device an expiry](security.md#give-a-device-an-expiry)) |
| **Devices** | `pastor devices list` · `pastor devices revoke <label>` · `pastor devices set-expiry <label> <duration>` · `pastor devices clear-expiry <label>` | List / revoke paired devices, or change when one [expires](security.md#give-a-device-an-expiry). `list` shows each device's expiry as `no expiry`, `expires <date>` or `EXPIRED <date>`. `set-expiry` counts a new lifetime from now; `clear-expiry` removes it. A label matches exactly, or without case when only one device fits |
| **Link** | `pastor link` · `pastor unlink` | Put `pastor` on your PATH ([below](#put-pastor-on-your-path)) |
| **Logs** | `pastor logs` | Tail the service log |
| **Config** | `pastor config show` · `pastor config check` · `pastor config init` | Print every setting with its source, validate the file, or write a commented `config.toml` ([the config file](configure.md#the-config-file)) |
| **Voice** | `pastor stt setup` · `stt test` · `stt status` · `stt off` | Configure / check / disable [voice input](voice-and-push.md#voice-input-optional) |
| **Push keys** | `pastor push-keys` | Generate the VAPID keypair into your `.env` |
| **Push test** | `pastor push-test` | Send one notification to prove it works |

The CLI also includes `build`, `serve`, `unserve`, `doctor`, and `crew …` for less frequent tasks.

Both `start` and `status` output the **Pastor is running** banner: a health mark and the version,
then a `service`, a `local` and a `tailnet` line.
[First run](install.md#first-run-what-youll-see) shows it in full, including what a failed health
check prints instead. The reported version reads from the served bundle stamp, reflecting the active
build.

**Ink or plain text.** The `start`, `status`, `doctor`, `crew add`, and `crew status` commands
render an interactive terminal UI when stdout is a TTY. Passing `--plain`, or redirecting output to
a pipe, file, systemd journal, or CI runner, falls back to raw line output.


## Put `pastor` on your PATH

Run `pastor link` to publish `~/.local/bin/pastor`:

```bash
bin/pastor link          # ~/.local/bin/pastor → <checkout>/bin/pastor
pastor status            # from anywhere
bin/pastor unlink        # take the name back down
```

It creates a **symlink to the checkout's binary**, so future `pastor build` updates take effect
immediately without extra steps
([ADR 0021](../.adr/0021-the-path-name-is-a-pointer-never-a-copy.md)). The command replaces existing
links from other Pastor checkouts and prints which one it overwrote. It refuses to overwrite
non-Pastor files at that path. `unlink` removes the symlink only if it targets *your* current
checkout.

If `~/.local/bin` is missing from your `PATH`, `link` warns you and exits. It never edits your shell
profile. Run `pastor doctor` to check the `path-link` line and see which checkout the bare `pastor`
command resolves to.

## Herdr actions

**Applies only to a Herdr-managed install** created with `herdr plugin install Ad3Digital/pastor` or
`herdr plugin link`. Herdr is one of five multiplexers Pastor supports. These actions map directly
to the adapter: each action forwards the verb to the same `pastor` binary documented in the table
above. On binary installs created via `scripts/install.sh`, plugin actions do not exist, and
`pastor <verb>` is the only syntax.

Pastor registers these actions in `herdr-plugin.toml`. Invoke them with
`herdr plugin action invoke <id> --plugin ad3.pastor`, or view them with
`herdr plugin action list --plugin ad3.pastor`:

| `<id>` | Equivalent verb | What it does |
| --- | --- | --- |
| `start` | `pastor start` | Build if needed, start the service, `tailscale serve`, print URL + banner |
| `stop` | `pastor stop` | Pause the bridge; removes nothing |
| `restart` | `pastor restart` | `stop` + `start` |
| `status` | `pastor status` | The *Pastor is running* banner — readiness ✓/⚠, version, URLs |
| `url` | `pastor url` | Print the tailnet URL |
| `version` | `pastor version` | Print the running version (`0.x.y+sha`) |
| `update` | `pastor update` | Advance the checkout (pull, or fetch + re-detach) + rebuild + restart |
| `uninstall` | `pastor uninstall` | Tear down the service (keeps `.env` + checkout) |
| `push-keys` | `pastor push-keys` | Write a VAPID keypair into the `.env` the service reads |
| `push-test` | `pastor push-test` | Push one notification to every subscribed device |

`qr`, `pair`, `devices`, `link`, `logs`, `stt`, and `config` have no corresponding plugin action
because they require a terminal, positional arguments, or both. Run them as `pastor <verb>`.

**Herdr actions return Herdr's JSON envelope instead of the terminal banner.** View the action's
captured stdout with `herdr plugin log list --plugin ad3.pastor`, or run `pastor <verb>` directly
to print output inline. Output from `herdr plugin list --json` reflects the version cached during
`plugin link`, not the active version. For linked clones, `update` re-links automatically to fix the
cache. You can force this with `herdr plugin link "$(pwd)"`. Herdr ≥0.8.0 re-reads the manifest from
disk on each invocation.

> **Note.** `scripts/pastor-ctl.sh <verb>` remains supported. It operates as a bootstrap shim: it locates
> Bun, compiles `bin/pastor` if the checkout lacks it, and passes along argv. A freshly linked clone
> uses this path to build its initial binary. Herdr actions continue to point to this script because
> Herdr <0.8.0 freezes the action definitions cached at install time
> ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)). Each verb is
> implemented once inside the compiled binary in `cli/`.


---

[← back to the README](../README.md)
