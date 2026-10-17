# Changelog

All notable changes to this fork. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.6.0]

### Added

- **Kimi Code declares its model catalog** (K3, K3-256k, K2.8 Preview, K2.7 Code
  Highspeed), read out of `~/.kimi-code/config.toml` — the file the Kimi Code
  desktop app writes for a signed-in account. Those are the ids the app passes as
  `model`, so they are the right vocabulary for this driver's `session/set_model`.

### Documented

- **Why ZCode has no catalog**: its GLM Coding Plan subscription has lapsed
  (`[1309] 您的GLM Coding Plan套餐已到期`), and an expired account cannot enumerate
  what it may use. This is an account state, not a missing CLI.
- **Why Pi has no catalog**: it refreshes its model list at runtime
  (`pi update --models`) from each provider, so any list shipped here would be stale
  by design.
- The model-menu section now says what a **shared** group means (the menu collapsing
  engines whose catalogs this build has not measured) and that declaring a `models`
  row gives an engine its own group.

## [0.5.0]

### Added

- **Codex declares its model catalog**, so the model menu gives it a group of its
  own instead of the shared `external` one. The ids were read out of the bundled
  0.149.1 CLI binary — they are what `thread/start`'s `model` accepts, which the
  driver passes straight through.

### Changed

- **Installation is the first section of both READMEs.** It used to sit below a
  ten-row requirements table, which put a gate in front of the one thing a reader
  wants first. The requirements table is reference, so it now follows.
- The **local-checkout install command is gone**: it told a stranger to run
  `dsh plugin add /path/to/dsh-loop-engine-allinone`, a path nobody has. npm is the
  documented path.
- **`dsh web` was written as if it were the harness's name.** `dsh` is the CLI and
  `web` is one of its profiles; that is now said once, where a reader meets it.
- The model-menu section explains what a **shared** group means: it is the menu
  collapsing engines whose catalogs this build has not measured, not a restriction
  on what an engine can run. A `models` row gives an engine its own group.

### Notes

- **Pi deliberately has no declared catalog.** It refreshes its model list at
  runtime (`pi update --models`) from each provider, so any list shipped here would
  be stale by design. Kimi and ZCode have none either: neither was installed on the
  machine this release was measured on, so nothing could be observed.

## [0.4.1]

### Added

- A language switch in both READMEs (`English · 简体中文`). GitHub only renders
  `README.md`, so the pair is linked rather than auto-detected.

### Fixed

- `README.zh.md` was a translation of the UPSTREAM plugin: four hosted engines, no
  registry chapter, nothing about grok/minimaxcode or the ACP capability bridges. It
  is rewritten from the English README section by section (same nine sections, same
  order).
- `tsconfig.json` no longer extends a `../deepseek-harness/` checkout that only
  exists in the author's working tree, and `vitest.config.ts` applies its harness
  aliases only when that checkout is present. Before this, a fresh clone could not
  run `node build.mjs` (TS5083) or `vitest run` (32 suites could not resolve
  `@deepseek-ai/cordis`).

## [0.4.0]

### Added

- **Grok Build (`grok`)** — ACP engine over `grok agent stdio`.
  - `session/new` refuses an unauthenticated client, so the driver answers ACP's
    `authenticate` with the method id `initialize` published, retries once, and
    otherwise reports the registry's login hint instead of a raw JSON-RPC error.
  - Model selection is `session/set_config_option` with a **bare value**; the
    `{ value }` wrapper the vendor's documentation shows is rejected `-32602`.
    (Measured after signing in; the earlier "documented spelling first, fall back"
    guess was wrong and is gone.)
  - The model catalog is read from the signed-in agent's own
    `initialize._meta.modelState` (`grok-4.7`), not from the unauthenticated
    `grok models` command, which reports ids this surface refuses.
  - Declares `images: false`: `promptCapabilities.image` is false, and sending an
    image block would reject the whole prompt.
- **MiniMax Code (`minimaxcode`)** — ACP engine over `mcode acp`, aimed at the
  M Plan **subscription** rather than an API key (`mcode login`, then
  `mcode provider use token-plan`; the plugin never logs in and never reads the
  credential).
  - Resolves the npm package entrypoint, and launches a Windows `.cmd` shim
    through the command interpreter — `spawn('mcode')` fails `ENOENT` and
    `spawn('mcode.cmd')` throws `EINVAL`, both measured.
  - Region travels as `MAVIS_REGION` (measured as the variable this surface
    honours; `MCODE_REGION` is inert here), with the `cn|en` value domain the CLI
    validates — not the login flag's `cn|global`.
  - States `permissionMode` on every opened session rather than inheriting
    whatever the CLI last persisted, because that default can be Full access.
- **ACP client-side capabilities** (`driver-acp/capabilities.ts`,
  `driver-acp/terminal.ts`) — the other half of ACP, and what makes a
  tool-using ACP engine actually work.
  - `terminal/create` and its lifecycle, plus `fs/read_text_file`.
  - The terminal bridge routes through the harness's own `shell` service, i.e. the
    same executor dsh's `bash` tool uses, so an engine's command gets the same
    sandbox, timeout policy and output caps. With no shell service it **refuses**
    rather than falling back to an unconfined spawn.
  - The announced `clientCapabilities` is derived from the implemented handlers, so
    a declared capability is always an implemented one; a filesystem **write** is
    never announced.
- `capabilities.acpProtocolVersion` — the version announced at `initialize` is
  registry data now, not a constant in the shared client.
- `EngineDescriptor.region` — an engine whose CLI scopes accounts by region
  declares the knob, the environment variable and the accepted values.
- `scripts/probe/acp-handshake.mjs` and `scripts/probe/smoke-acp.ts` — dump an ACP
  engine's frames, or drive one through the plugin's own profile.
- `CONTRIBUTING.md`, `SECURITY.md`, this changelog.

### Changed

- **`engine-kimi/acp/` → `driver-acp/`**, and `KimiAgent`'s turn/step machine
  generalised into `AcpEngineAgent`. Kimi keeps its class names and constructor
  shapes; its entire suite passes unchanged, which is the regression pin for the
  move.
- An ACP engine is now a **profile** (argv, protocol version, model dialect,
  session handshake, endpoint handover) plus four small files. Adding the fourth
  one does not touch shared code.
- Tool vocabulary: MiniMax Code's measured `bash` call is a **declared identity**
  (a table row meaning "read and found to agree"), and grok deliberately has no
  row — its only measured tool runs through the client-side terminal bridge, and
  renaming it to dsh's `bash` would dress a failing call up as a working one.

### Fixed

- `smoke-acp.ts <engine>` skipped the engine name as if it were `--bin`'s value
  when `--bin` was absent, so `smoke-acp.ts grok` silently ran minimaxcode.
- grok's `authenticate` sat outside its `try`, so a failure there (which is what a
  signed-out host produces, since the call starts the vendor's browser sign-in)
  surfaced "process exited unexpectedly" instead of an actionable hint.
- `.gitignore` now covers a stray CLI home directory: a relative `GROK_HOME` once
  made an engine write its whole state dir — `auth.json` included — into this repo.

### Known limitations

- **grok's tools need the harness shell service.** Its shell tools run through the
  client-side terminal bridge; a composition without `ctx.shell` refuses them
  rather than running them unconfined. Grok's reasoning and conversation work
  either way.
- **`claudeBin` cannot unload the bundled SDK.** Pointing it at an external binary
  changes what executes, but `@anthropic-ai/claude-agent-sdk` is a value import in
  `engine-claude/agent.ts`, so the package stays required. `codexBin` and `piBin`
  CAN fully unbind their bundled copies.
- **Bundled engines have no runtime updater** by design: their version is this
  package's dependency pin, so upgrading means changing the dependency, not
  rewriting it in place.

## [0.3.0] and earlier

The upstream plugin's history. See
[`kuun993/dsh-loop-engine`](https://github.com/kuun993/dsh-loop-engine).
