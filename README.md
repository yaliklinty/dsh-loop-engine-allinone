# dsh-loop-engine

[![npm version](https://img.shields.io/npm/v/dsh-loop-engine?color=cb3837)](https://www.npmjs.com/package/dsh-loop-engine)

Pick **dsh web**'s agent loop engine **per session** — the built-in `in-process` loop (the default), or one of the hosted engines `claude-code` / `codex` / `pi` / `kimi` / `agy` / `zcode` / `qoderclicn` / `hermes`. Sessions are independent: one chat can run Codex while another runs Kimi. Any open, idle session can move engines — between two hosted engines the handover is **in place**, and a move involving `in-process` **reloads the page** (the `dsh web` process never restarts). Nothing in the main repository changes.

> **This is a fork.** It adds a data-driven engine registry and a pluggable CLI
> driver layer, so that adding an engine is a registry row plus a driver instead
> of edits in five places. The four original engines are untouched. See
> [docs/engine-registry.md](docs/engine-registry.md) for the "add an engine"
> recipe, and the fork's `output/` reports for the protocol probes each new
> engine was written against.

## Engine marks

Every engine has its own mark in the engine picker and its own colour + glyph on
the chat's turn-status row; **only `in-process` carries the DeepSeek fish**.

The three engines this fork added as external CLIs are **traced or measured from
the vendors' own artwork found on this machine** — Antigravity's arch, ZCode's
knocked-out `Z` (written out from measured spans, because its straight edges
defeat a raster trace), and Qoder's green disc with the white crescent between its
two forms. Kimi's mark was rebuilt from its app tile: a bold `K` plus the brand's
blue dot, which rides an `accent` subpath because one path can only be filled one
way.

Hermes is the exception worth knowing about: that vendor's mark is a detailed
character portrait rather than a glyph, so its mark is the portrait's own line art.
Marks live in [`src/client/engine-marks.ts`](src/client/engine-marks.ts) as data
rather than JSX, so a test can assert that every registered engine has one.

Both tables are exhaustive over the hosted roster and pinned by tests — the
failure this prevents is real: when four engines were first added, every one of
them fell through the mark switch's `default` arm and rendered the DeepSeek fish
beside its name.

## Engine registry

Every engine-shaped decision derives from ONE table,
[`src/engine-registry.ts`](src/engine-registry.ts): the id roster, the settings
schema's union, the authored preset ids and display names, the browser half's
option list and copy keys, and the driver dispatch
([`src/engine-drivers.ts`](src/engine-drivers.ts)). Both tables are total over
the hosted ids, so a half-added engine fails the build rather than shipping an
engine that mounts but cannot be selected.

Each row declares what the surfaces need to know: human-readable label, source
repo, whether the engine is an npm-bundled dependency or an external CLI, the key
its executable override reads, its version/update argv, its login hint, its
credential paths, and its **capabilities** (`streaming`, wire `protocol`,
`sessionResume`, `permissionModes`, `images`, `reasoningLevels`). Capabilities are
declarations, not discoveries: a surface never promises more than the engine was
verified to do, and a driver asked for something outside its declaration refuses
with the user's next action rather than degrading silently.

New engines implement one method. `src/driver-cli/` supplies the rest: the
turn/step lifecycle (`cli-agent.ts`), the durable-log writer
(`session-sink.ts` — where the session format's "refuse to load" rules are
enforced in one place), the subprocess transport, and four protocol skeletons
(`ndjson`, `stream-json` for the Claude-Code dialect, `text`, plus the existing
engines' ACP and JSON-RPC drivers as their templates).

## Install

```sh
dsh plugin --profile web add dsh-loop-engine
```

Boot `dsh web` once (the router retries for a bounded window while the base bundle still holds the agent-factory slot), then open **Settings → Loop engine**.

**Install notes**

- The install rewrites one **engine-agnostic** managed block in the profile's `cordis.patch.yml`; every other byte you wrote there is preserved. Upgrading from an older release needs no hand edit.
- **Installing into any profile but `web`** — the Desktop app's `desktop`, a `headless` deployment, a renamed profile — needs `profile: <name>` in the composition entry for that profile:
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  `profile` defaults to `web`, so without it the plugin writes its managed block into `<home>/profiles/web/cordis.patch.yml` while the running profile never reads it: the plugin mounts, but the base `agent-loop` row is never disabled, so its router cannot take the factory slot and no hosted engine is reachable. (Found by installing into the Desktop app.)
- **Uninstall** is `dsh plugin --profile web remove dsh-loop-engine` **plus deleting that managed block** — the block outlives the plugin, and while it is present the profile has no agent factory, so no session can be created.
- **pnpm 10+** may block dependency build scripts (`ERR_PNPM_IGNORED_BUILDS`, naming `esbuild`, `@google/genai`, `protobufjs`). Run `pnpm approve-builds` (or add an `allowBuilds` entry) and retry; only the installing project can grant this.
- **Booting the harness from its source checkout** additionally needs the profile's harness peers bridged with `file:` shims — otherwise session resume fails with `agent-presets: refusing to compose an unscoped context`. Steps in [docs/source-checkout.md](docs/source-checkout.md).

## Requirements

| Engine | Needs, on the host |
|---|---|
| Claude Code | the Claude Code CLI installed and logged in (or none: the SDK ships a bundled binary) |
| Codex | `codex login`, or a `CODEX_API_KEY` environment entry |
| Pi | whatever `pi` expects (its own `~/.pi/agent/auth.json`, or the provider's API-key variable) |
| Kimi Code | the `kimi` CLI installed and logged in, on `PATH` (or pinned via `bins.kimiBin`) |
| Antigravity | the `agy` CLI installed and signed in to Google |
| ZCode | the ZCode CLI and a live GLM Coding Plan subscription |
| Qoder CN | the `qoderclicn` CLI installed and signed in |
| Hermes Agent | the `hermes` CLI installed and signed in; it reads its own `HERMES_HOME`, which the child inherits |

## Usage

- **New session** — pick the engine on the preset chip beside the workspace picker, or keep the deployment's default (`standard`) for the in-process loop. A child agent inherits its parent's engine.
- **Settings → Loop engine** sets the default for **new** sessions. It lands immediately; running sessions are unaffected. **In-process** restores whatever default the plugin replaced.
- **Move a session you are in** with the composer's engine selector (enable *Show the engine selector in the chat page*).
  - Hosted → hosted: in place, applies on the spot.
  - Anything involving `in-process`: the composer asks first, then the page reloads and reopens the same session (scroll position and unsent draft are lost; the record is not).
  - A mid-turn session is refused, and a subagent's session cannot be moved.
- **The header chip** beside the preset label names the engine the session on screen actually runs; *Show the engine badge in the conversation header* turns it off (and the header keeps no trace of the plugin).
- **Models** — two kinds of group, on purpose.
  - **An engine that declares its own catalog gets a group of its own**, named by the engine (today: `Antigravity`), holding `default` plus the models that engine's own subscription includes. Picking one hands that id to the engine (`agy --model gemini-3.8-flash-low`), so you choose among the models you actually pay for instead of accepting "the engine decides". `default` still means exactly that.
  - **Every other engine shares the `external` group** with its single `default`. That is not a leftover: the model catalog is built per Host *generation*, not per session, so a group per engine would put eight identical `default` rows in every session's menu. A group only earns its place by carrying models the others do not.
  - Picking a **real dsh model** still hands it to the engine together with its endpoint and credential; whether the engine can serve it is the engine's business, and a refusal is reported rather than swallowed. A pick belonging to a *different* engine's group is refused with the mismatch named, never silently ignored.
  - The catalog is **declared in the engine registry**, not probed at boot — this plugin starts no external process when the harness boots. A deployment whose subscription changed updates [`src/engine-registry.ts`](src/engine-registry.ts)'s `models` row; a stale id then fails loudly at the engine, which is the honest outcome.
  - `in-process` sessions use dsh's models normally.
- **`bins`** (composition entry, optional) — per-engine executable overrides, keyed by each engine's registry `binConfigKey`. Pointing a **bundled** engine at an external CLI is how it is unbound: `claudeBin` reaches the SDK's own `pathToClaudeCodeExecutable`, while `codexBin` / `piBin` replace the entrypoint those drivers launch. Not setting one keeps the bundled copy and its argv byte for byte:
  ```yaml
  - id: loop-engine
    config:
      bins:
        claudeBin: 'D:/tools/claude.exe'
        kimiBin: 'D:/tools/kimi.exe'
        qoderclicnBin: 'D:/tools/qoderclicn.exe'
  ```
- **`childIdleMs`** (composition entry, milliseconds, default `0` = off) — Kimi and Codex keep **one child process per session** across steps; this closes it after that much idle time and respawns it on the next step. Only the child is closed, so nothing reloads. Pi and Claude Code spawn per step and are unaffected.
- **`engineContextWindow`** (composition entry, tokens, default `262144`) — the context window dsh assumes for the shared hosted route. It is what dsh's auto-compaction measures a hosted session against (it fires at 80% of this by default), because a hosted engine reports no capacity of its own. Set it to the **smallest** window among the engines you run.
- **`summarizerProvider` / `summarizerModel`** (composition entry, **set together or not at all**) — the real dsh model a hosted session's **compaction** summarizes through, e.g. `deepseek-official` / `deepseek-flash`. Compaction is dsh's own (its preset keeps the `compaction` group), but the summarizing *call* is an ordinary llm request, and a hosted session's routed model is the plugin's placeholder route — so without this pair a hosted session can never be folded down: every attempt logs a warning and the turn continues. The pair only serves that call; the engine still answers every user turn itself. Composing just one of the two (or an empty string) is refused at boot, not silently ignored.
- **dsh's own commands** (`/export`, `/feedback`, `/permission`) keep working under a hosted engine. Its preset is a copy of `standard` with the dsh-native rows an external engine replaces stripped out (dsh's `/plan`, the goal tool and `/goal`, the skill rows). dsh's **compaction is kept**: it is what keeps the session log — and so the transcript replayed to the engine on every step — bounded, which an engine's own per-turn compaction cannot do (a fresh engine session is opened per step, so the engine's shrink is discarded while the log keeps growing). Configure `summarizerProvider` / `summarizerModel` (above) or its summarizing call has no model to run on.

## Version compatibility

One release serves the **0.1.5 line** (`>=0.1.5-rc.1 <0.1.6-0`), the **0.1.7 line** (`>=0.1.7-rc.1 <0.1.8-0`) and the **0.2.0 line** (`>=0.2.0-rc.1 <0.2.1-0`): the plugin detects the running generation at load and takes the matching code path. Those union ranges are what it declares in `peerDependencies`, and a harness outside them fails loudly at boot or session resume.

Read the version as `<harness line>-rcN`, where **`rcN` is this plugin's own release counter for that line** — not the harness's `rc` number. Within a covered line a new harness `rc` needs no plugin release unless an API surface moved; [docs/compatibility.md](docs/compatibility.md) §1 lists those surfaces and the diff command that decides it.

| Plugin | Harness |
|---|---|
| `0.2.0-rc1` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.1.7-rc1` … `0.1.7-rc5` | `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.1.5-rc3` … `0.1.5-rc5` | `0.1.5-rc.2` |
| `0.1.5-rc1` / `0.1.5-rc2` | `0.1.5-rc.1` |
| `1.0.0-rc8` … `1.0.0-rc15` | `0.1.2-rc.1` |
| `1.0.0-rc7` and earlier | `0.1.1-rc.2` |

`0.2.0-rc1` is the first release that serves three lines at once, and the first one published after the harness started enforcing a peer-range gate at boot: the plugin is still mounted alongside an incompatible one, but a harness outside the ranges above is now skipped by dsh itself rather than failing later.

## Known limitations

- **It replaces the harness's agent factory.** One facade serves every session, so the plugin promises to stay out of the way: any session it cannot answer for — including sessions with nothing to do with hosted engines — degrades to the `in-process` loop instead of failing to open. See [docs/per-session-engine.md](docs/per-session-engine.md) §6.
- **The engine record is a sidecar**, `$DSH_HOME/.loop-engine/engines.json`, not part of the session log: changing machine or `DSH_HOME` loses it and the session falls back to its preset. See §5.5.
- **Moving a session involving `in-process` reloads the page** — the harness loop neither hands over a live session nor adopts one it did not create. See §5.2/§5.4.
- **Sessions that already ran a turn** can still move, but only while idle, and the move rebuilds that session's agent. See §5.
- **Old sessions with the legacy preset id `loop-engine`** read as "legacy hosted engine" until rebuilt once. See §7.
- **Same-engine sessions share that CLI's own auth directory**, with no lock added by the plugin. See §6.
- **Switching back to `in-process` leaves the shared `external` group in the model menu** (the catalog is not scoped per session).

## Where the details live

- [docs/per-session-engine.md](docs/per-session-engine.md) — the full user-visible behavior (§ numbers above refer to it).
- [docs/architecture.md](docs/architecture.md) — plugin core: the single factory slot, the managed block, routing, the provider route.
- [docs/compatibility.md](docs/compatibility.md) — **start here when the harness upgrades**: every generation-dependent code site and the checklist for the next generation.
- [docs/driver-core.md](docs/driver-core.md) — the shared driver infrastructure.
- [docs/engine-claude.md](docs/engine-claude.md) · [engine-codex](docs/engine-codex.md) · [engine-kimi](docs/engine-kimi.md) · [engine-pi](docs/engine-pi.md) — per-engine internals.
- [docs/source-checkout.md](docs/source-checkout.md) — the `file:` shims a source-launched harness needs.
- [docs/optimization-backlog.md](docs/optimization-backlog.md) — known issues and the optimization list.
- [docs/proposals/](docs/proposals/) — main-repo proposals.

## License

MIT
