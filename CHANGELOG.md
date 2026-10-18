# Changelog

All notable changes to this fork. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.7.5]

### Added

- **Coverage is a ratchet now, and the ratchet is at 100%.** `scripts/coverage-gate.mjs`
  replaces `vitest.config.ts`'s `thresholds.perFile`, which had never passed on this
  branch: files the change touches must be at 100% per metric, every other file may not
  fall below `.coverage-baseline.json`. The gate reads the istanbul `json` report, diffs
  against the base commit, and refuses a lowered floor in the same change that needs it
  (the baseline is regenerated deliberately, in its own commit, with a reason).
- The 38 files the old threshold flagged are all at per-file 100% now (1,613 → **1,817
  tests**, 96 files); `.coverage-baseline.json` was rewritten to 119 × 100%, so "do not
  regress" now means the same thing as "must be full".

### Fixed

- **A profile install no longer writes its managed block into `web`.** With
  `config.profile` omitted, `resolvePatchPath()` defaulted to `web`; a market install into
  the Desktop app's `desktop` profile therefore disabled `agent-loop` in a profile that
  had no plugin, while `desktop` kept the base loop in the agent-factory slot and every
  per-session engine switch answered `router-unmounted` ("the loop engine router is not
  ready"). The profile is now resolved from the launcher's `profileContext`, then from the
  directory the package was installed into, and only then from `web`. An explicit
  `profile:` entry still wins (needed for a `link:`/source checkout).
- **Two preset-authoring tests could flake on a loaded runner.** They polled for one second while the plugin's own roster wait is bounded at two; a docs-only push (run `39118609901`) failed both. The helper now polls for the full eight-second budget, which is what the assertion means. (Tests only.)
- **Coverage no longer depends on the host's home directory.** `model-registry.ts` sat at
  93.94% on a clean CI runner while reading 100% locally, because the local machine has a
  real `~/.kimi-code/config.toml` and the tests silently relied on it. The spec now points
  `KIMI_CODE_HOME` at a fixture for the discovered arm and at an empty directory for the
  "not installed" arm, so both run everywhere. (Tests only; runtime behaviour unchanged.)

### Changed

- The README now tells deployments that upgraded from 0.7.4 to delete a managed block
  0.7.4 may have left in a `web` profile that has no plugin. (Documentation only.)
- Coverage-only source edits are comments at genuinely unreachable arms (`/* v8 ignore
  start|stop */` plus a reason: POSIX-only ternaries, registry-constant branches, the
  production-layout early return). Runtime behaviour is unchanged.

## [0.7.4]

### Fixed

- **`0.7.3` could not be installed on DeepSeek Harness `0.2.1`.** `dsh` refuses a
  plugin whose declared peers the running version does not satisfy, and two things
  broke at once. The union range ended at `<0.2.1-0`, so every `0.2.1-rc.N` host fell
  outside it; and `@deepseek-ai/dsh-invariants` — declared as a hard peer — was never
  published for that line and is not part of the `0.2.1` runtime at all. Both are
  fixed: the last segment is now `>=0.2.0-rc.1 <0.2.2-0` (one range covers `0.2.0` and
  `0.2.1`, which kept the same API shape), and the invariants peer is marked
  `optional`, which is what it always was in practice — the `./invariant` companion
  imports it for types only and the built bundle contains no runtime import of it.

### Added

- **The `0.2.1` line is a supported generation**, verified end to end: an isolated
  `.compat/021/` dependency set plus `vitest.config.compat021.ts` run the same 1,613
  specs, `tsconfig.compat021.json` typechecks the sources against `0.2.1`'s published
  declarations, and a real `dsh web` on `0.2.1-rc.1` installs the plugin, writes its
  managed block once (byte-identical on reboot), publishes all ten engine presets,
  and serves the client bundle.
- `npm run test:compat` and `npm run compat:install` cover all four generations, and
  `npm run typecheck:compat` is the `0.2.1`-against-isolated-declarations check.

### Changed

- `devDependencies` moved to the `0.2.1` line; `schemastery` to `3.18.5`,
  `cordis` to `4.0.5`.
- The test suite mounts the JSONL durability backend through the new
  `tests/helpers/jsonl-persistence.ts`. `0.2.1` replaced that package's default
  export with named `{ name, apply }` exports, so the direct default import the specs
  used resolved to `undefined` and cordis rejected the mount with
  `invalid plugin, expect function or object with an "apply" method`.

## [0.7.3]

### Fixed

- **ZCode's path probe only worked on the author's machine.** The resolver and the
  probe script both hardcoded `D:\Programs\ZCode\...` (and the probe also
  `D:\Programs\npm-global`), so on any other host the "well-known location" check
  silently never matched and a user with ZCode installed somewhere normal was told it
  was not installed. Both now derive candidates from the environment:
  `%ZCODE_HOME%` → `%LOCALAPPDATA%\Programs\ZCode` → `%ProgramFiles%\ZCode`, and
  the probe's npm prefixes from the running npm configuration and the standard
  per-machine layouts.
- A test run's probe output directory (`probe-out/`) was picked up by `git add -A`.
  Removed, and ignored from now on.

### Added

- **`ZCODE_HOME` is documented**, with a `zcodeBin` key in the configuration example.
  ZCode ships as a desktop bundle rather than a plain executable, so a manual install
  outside an installer-written root needs one of the two to be found — and the README
  previously mentioned neither, which is why the gap went unnoticed.

## [0.7.2]

### Changed

- **Installation leads with `--profile web` again.** 0.7.1 made `<your-profile>` the
  primary spelling, on the reasoning that `web` is one of several shipped templates.
  That is true but the wrong shape for an install section: `dsh web` is the harness
  CLI's own documented example (`dsh web` = `dsh --profile web`), and every published
  plugin says `dsh plugin --profile web add ...` — dsh-market included. Forcing a
  placeholder substitution before the first command is friction with no payoff for the
  majority.

  The non-`web` case is now a caveat section instead: `desktop`, `headless`, and
  self-named profiles get both steps, plus the silent failure that follows from doing
  only the first one. npm / GitHub / local-clone remain the three sources.

## [0.7.1]

### Fixed

- **Installation no longer assumes a `web` profile.** `web` is one of several shipped
  templates; the Desktop app boots `desktop`, a CI deployment boots `headless`, and
  many people run a profile they named themselves. The instructions now say
  `<your-profile>` and give the three real sources: npm, GitHub, and a local clone for
  plugin development.
- **A wrong `profile:` is now diagnosable.** The field defaults to `web`, so forgetting
  it writes the managed block into another profile's patch file while the profile that
  actually boots never reads it — the plugin mounts, the base `agent-loop` row is never
  disabled, and no hosted engine is reachable, with **nothing logged**. The harness
  gives a plugin no way to ask which profile is running, so `apply` now checks whether
  the target directory holds a profile's `package.json` and warns with the field to set.
  It is a warning, not a failure: a first boot may legitimately precede the profile's
  own files.

### Documented

- The engine picker appears in whichever profile renders a web UI, not specifically in
  `web`.

## [0.7.0]

### Added

- **Runtime model discovery.** A vendor shipping a model no longer needs a plugin
  release. Two kinds of discovery, chosen so that the plugin still starts no external
  process at boot:
  - **free** — Kimi Code's catalog is read from its own `~/.kimi-code/config.toml` at
    boot; an ACP engine's arrives in its `session/new` response the first time a
    session opens (already paid for by that session).
  - **costly** — `grok models` / `agy models` would need a new child process, so they
    are deliberately not run: a menu render must not spawn anything. Those stay
    declared.
- The provider route reads its model list through a thunk, so a catalog discovered
  after boot appears without re-registering the route or restarting the harness.
- `catalogReport()` exposes each engine's catalog with its provenance
  (`discovered` / `declared`), because "the engine told me" and "the plugin assumes"
  are different claims.

### Changed

- **The per-engine "Custom Models" column is gone from both READMEs.** It listed
  model ids that are now discovered, so a hardcoded list was exactly the staleness
  this release removes — and a reader would have taken an old id for the plugin's
  limit. MiniMax Code's region, the one fact in that column that is not a model,
  moved into the requirements cell.
- The model section describes the mechanism (discovered, declared fallback, and the
  settings page saying which) instead of naming engines.
- Claude Code's row no longer reads as if the bundled SDK were the only option:
  `bins.claudeBin` runs an external install. (Pinning changes what executes; it does
  not unload the SDK package, which the driver imports.)

### Verified

- On the reference host, `bootCatalog('kimi')` returns `origin: discovered`,
  `source: kimi-config`, with four models read from the live config file.

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
