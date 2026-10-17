# Changelog

All notable changes to this fork. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

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
