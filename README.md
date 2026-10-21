# dsh-loop-engine-allinone

**English** · [简体中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Harness: 0.1.5 | 0.1.7 | 0.2.0 | 0.2.1](https://img.shields.io/badge/harness-0.1.5%20%7C%200.1.7%20%7C%200.2.0%20%7C%200.2.1-6f42c1)](#version-compatibility)

**dsh-loop-engine-allinone** is an all-in-one agent loop engine switcher for **[DeepSeek Harness](https://github.com/deepseek-ai)** (`dsh`). It enables per-session engine switching across **10 hosted engines** (Claude Code, Codex, Pi, Kimi Code, Antigravity, ZCode, Qoder CN, Hermes Agent, Grok Build, MiniMax Code) alongside the built-in `in-process` loop.

> `dsh` is the harness CLI. `dsh --profile <name>` boots one of its **profiles**, and the engine picker plus this plugin's settings page appear in whichever profile renders a web UI (the shipped `web` template is one; the Desktop app uses `desktop`).

Sessions are fully independent: run Codex in one chat while another runs Kimi Code or Antigravity simultaneously. Handover between two hosted engines happens seamlessly in place; switching to or from the native `in-process` engine performs an in-browser reload without restarting the backend process. All without modifying the DeepSeek Harness core codebase.

> **Fork Note**: This project is a fork of [`kuun993/dsh-loop-engine`](https://github.com/kuun993/dsh-loop-engine).  
> While the upstream plugin introduced per-session switching for 4 initial engines, this fork refactors the internals into a **unified data-driven engine registry** and **shared driver infrastructure**, expanding support to **10 distinct engines**.

---

### Highlights & Comparison with Upstream

| Feature | Upstream (`kuun993`) | This Fork (`allinone`) |
|---|---|---|
| **Supported Engines** | 4 engines | **10 engines** (+ native `in-process`) |
| **Engine Configuration** | Hardcoded across 5+ files | **Single registry table** (`src/engine-registry.ts`) |
| **Adding New Engines** | Modify 5 separate files | **1 registry row + 1 driver** |
| **ACP Protocol** | 1 engine (Kimi) | **3 engines** (Kimi, Grok, MiniMax) on a shared ACP skeleton |
| **CLI Drivers** | Ad-hoc implementations | Standardized `driver-cli/` & `driver-acp/` runtimes |
| **Model Selection** | Global default only | **Per-engine subscription catalogs**, discovered at runtime (no release needed when a vendor ships a model) |
| **UI Integration** | Standard labels | **Custom branded marks & status badges** for all 10 engines |

---

## Installation

```sh
dsh plugin --profile web add dsh-loop-engine-allinone
```

Restart `dsh web`, then open **Settings → Loop engine**.

### From GitHub instead of npm

```sh
dsh plugin --profile web add yaliklinty/dsh-loop-engine-allinone
```

### From a local clone

Only when you are working on the plugin itself:

```sh
git clone https://github.com/yaliklinty/dsh-loop-engine-allinone.git
dsh plugin --profile web add ./dsh-loop-engine-allinone
```

### Not on the `web` profile?

`web` is the profile the harness's own CLI documents (`dsh web` is short for
`dsh --profile web`), so it is the right default. But the Desktop app boots
`desktop`, a CI deployment may boot `headless`, and you may have made your own.

**Installing with `dsh plugin --profile desktop add dsh-loop-engine-allinone` is
enough**: the plugin resolves the profile it is actually serving — the launcher's
`profileContext` when the generation provides it, otherwise the profile directory
it was installed into (the nearest ancestor with a `dsh.profile` manifest). Only a
`link:`/source checkout has neither, and there the composition entry still wins:

```yaml
- id: loop-engine
  config:
    profile: desktop      # only needed for a linked checkout / global install
```

Before 0.7.5 the field defaulted to `web` and nothing else was consulted. A market
install into `desktop` then wrote the managed block into `profiles/web/`, the
`desktop` base `agent-loop` kept the agent-factory slot, and every per-session
engine switch answered `router-unmounted` ("the loop engine router is not ready")
— with nothing logged. The same omission could disable `agent-loop` in a `web`
profile that had no plugin at all. 0.7.5 fixes both ends: it finds the right
profile, and it warns when the resolved profile has no `package.json` beside it.

If 0.7.4 already wrote the managed block into `web` while you did not install the
plugin there, delete that block (from `# -- dsh-loop-engine managed block --` through
`# -- /dsh-loop-engine managed block --`, plus the preset block) before booting
`web`; otherwise that profile has no agent factory.

### Installation notes

- The installer rewrites one managed block in the profile's `cordis.patch.yml`; every
  other byte you wrote there is preserved, so upgrading needs no hand edit.
- **Uninstall**: `dsh plugin --profile web remove dsh-loop-engine-allinone`, **then
  delete the managed `loop-engine` block** from that profile's `cordis.patch.yml`. The
  block outlives the plugin, and while it is present the profile has no agent factory,
  so no session can be created.
- **One-time script approval.** pnpm 10+ refuses to run dependency install scripts
  until the installing project approves them, so a fresh `dsh plugin add` can stop at
  `ERR_PNPM_IGNORED_BUILDS` naming `@google/genai` and `protobufjs`. **This is not a
  missing dependency and there is nothing to install by hand** — the whole tree,
  including the bundled Pi engine, is already on disk; pnpm is only asking whether to
  execute two scripts those packages ship:

  | Package | Script | What it actually does |
  |---|---|---|
  | `@google/genai` | `preinstall` | `echo 'preinstall: no-op'` |
  | `protobufjs` | `postinstall` | reads its own `package.json`, prints a version-scheme warning |

  Both are no-ops, so **either answer is safe**: approving runs them, and
  `allowBuilds: false` skips them. Verified for the second case — with both set to
  `false`, `@google/genai` loads (145 exports), `protobufjs` loads, and Pi's
  `dist/cli.js` is present. They arrive only through the bundled Pi engine;
  Claude Code and Codex ship no install scripts, so this prompt never appears
  because of them.

  The question is asked **once per profile** — the answer is written into that
  profile's `pnpm-workspace.yaml` and later installs and upgrades do not ask again.
  To pre-answer it before the first install, add to the profile's
  `pnpm-workspace.yaml`:

  ```yaml
  allowBuilds:
    '@google/genai': false
    protobufjs: false
  ```
- **Harness from source**: bridge the profile's harness peers with `file:` shims, or
  session resume fails with `agent-presets: refusing to compose an unscoped context`.
  Steps in [docs/source-checkout.md](docs/source-checkout.md).

## Supported Engines

| Engine | Type / Protocol | Host Requirements & Authentication |
|---|---|---|
| **Claude Code** | Bundled SDK / `ndjson` | Nothing, by default (the SDK ships a binary); set `bins.claudeBin` to run your own install instead |
| **Codex** | Bundled / `jsonrpc` | `codex login` or `CODEX_API_KEY` |
| **Pi** | Bundled / `jsonrpc` | `~/.pi/agent/auth.json`, or the provider's API-key variable |
| **Kimi Code** | External CLI / `acp` | `kimi` CLI installed and authenticated (`kimi login`) |
| **Antigravity** | External CLI / `ndjson` | `agy` CLI installed and signed in to Google |
| **ZCode** | External CLI / `ndjson` | `zcode` CLI installed; a live GLM Coding Plan for ZCode's own models, or any DSH model through the handover |
| **Qoder CN** | External CLI / `ndjson` | `qoderclicn` CLI installed and authenticated; a DSH model additionally needs the startup entitlement check to reach Qoder's API (`allow_byok >= 2`) |
| **Hermes Agent** | External CLI / `ndjson` | `hermes` CLI installed and configured (`hermes setup`) |
| **Grok Build** | External CLI / `acp` | `grok` CLI installed and signed in once (`grok login`) |
| **MiniMax Code** | External CLI / `acp` | `npm i -g @minimax-ai/code`, `mcode login --region cn\|global`, then `mcode provider use token-plan` |

> **Model lists are discovered, not listed here.** Each engine's models come from the engine itself — Kimi Code's own config file at boot, an ACP engine's `session/new` response as soon as a session opens — so a vendor shipping a model does not need a plugin release. Engines whose catalog this build cannot read fall back to a declared list, and one with neither shows the shared `external` group. The settings page shows which is which.

> **Note**: For external CLI engines (`bundled: false`), the plugin spawns your locally installed binaries; it does not download or authenticate them automatically. Please install and log in on your host machine beforehand.

### Which engines can run a model configured in DSH

Every hosted engine can run **its own** models. A model from DSH's own provider
list (DeepSeek, a `llm-pi-ai` provider, an API key you configured in DSH) is a
different question: the plugin must hand that model's endpoint and credential to
the engine, and each engine accepts that in its own way — or not at all.

| Engine | A DSH model can be used | How it is handed over | Notes |
|---|---|---|---|
| **Claude Code** | ✅ | `Options.env` on the bundled SDK | the endpoint rides the SDK's environment |
| **Codex** | ✅ | `-c` config overrides on `codex app-server` | wire must be OpenAI-compatible |
| **Pi** | ✅ | a plugin-owned agent directory (`PI_CODING_AGENT_DIR`) + `--api-key` | the engine's `~/.pi` is never written; that session does not see your `~/.pi` skills/auth |
| **Kimi Code** | ✅ | `KIMI_MODEL_NAME` / `KIMI_MODEL_BASE_URL` / `KIMI_MODEL_API_KEY` | environment only, nothing written to disk |
| **Grok Build** | ✅ | `GROK_MODELS_BASE_URL` + `XAI_API_KEY` + a plugin-owned empty `GROK_HOME` | **OpenAI-compatible endpoints only.** The owned home is load-bearing: with your real `~/.grok` the CLI attaches the account's session JWT to a helper request aimed at that endpoint |
| **MiniMax Code** | ✅ | a plugin-owned data directory (`MINIMAX_DATA_DIR`) holding a BYOK `custom_provider` | supports `anthropic-messages`, `openai-completions`, and `openai-responses`; the key is written to a `0600` file inside a `0700` directory this plugin removes at exit, because this CLI has no environment indirection for it |
| **Antigravity** | ✅ | `AGY_LLM_GATEWAY_URL` + `AGY_LLM_GATEWAY_API_KEY` + `AGY_LLM_GATEWAY_WIRE_PROTOCOL=openai` | environment only: the CLI's own LLM gateway is repointed, its sign-in is untouched |
| **ZCode** | ✅ | a private `provider_config.json` named by `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (+ the app’s `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`) | one document per step, removed when the step ends: `defaultModelSelection` points ZCode at the dsh endpoint and the dsh key. `~/.zcode` is neither read as configuration nor written to. Supports `anthropic-messages` and `openai-completions`; anything else is refused with `ZCODE_UNSUPPORTED_API`. |
| **Qoder CN** | ✅ | a private `--config-dir` root holding a plaintext `providers` entry and a copy of your `.auth` | one root per step, removed when the step ends: `-m dsh-handover/<model>` selects the endpoint. Your `~/.qoder-cn` settings, plugins and encrypted model store are untouched. Requires a signed-in account and a reachable Qoder API at startup (`allow_byok >= 2`); supports `openai-completions` and `anthropic-messages`. |
| **Hermes Agent** | ✅ | `OPENAI_BASE_URL` + `OPENAI_API_KEY` + `--provider openai` | environment only: nothing is written and the user's `HERMES_HOME` (sessions, skills, `auth.json`) stays in force |

Every one of the ten hosted engines can now run a DSH model. What still differs
is the price of the handover:

- **An engine that cannot speak the endpoint's wire refuses rather than guesses.**
  The engine's own protocol support is the limit — Grok's custom-endpoint path is
  OpenAI-compatible only, ZCode and Qoder CN take `anthropic-messages` or
  `openai-completions` — and a mismatch is refused before a child spawns, with
  the engine's own code (`GROK_UNSUPPORTED_API`, `ZCODE_UNSUPPORTED_API`,
  `QODERCLICN_UNSUPPORTED_API`). A DSH model whose endpoint or credential dsh
  cannot disclose fails with `UNSERVABLE_MODEL` and names both ways out.
- **The rest are environment-only or a private directory the plugin removes.**
  Claude Code, Codex, Hermes and Antigravity write nothing; Pi, Kimi, Grok,
  MiniMax, ZCode and Qoder CN trade a plugin-owned directory for the session
  that runs the DSH model.

#### Qoder CN: the two hard prerequisites

These belong to the CLI, not to the plugin; the handover cannot remove either.

1. **You must be signed in to Qoder CN.** `-p` runs in the CLI's `local`
   provider-access mode, which requires `isAuthenticated()`. The handover starts
   each step by copying `~/.qoder-cn/.auth` into its private config root; when
   that directory is missing the turn fails before a child spawns, with
   `QODERCLICN_NOT_LOGGED_IN` and the message to run `qoderclicn login`.
2. **The startup entitlement check must reach Qoder.** Before custom providers
   are allowed, the CLI calls `GET https://openapi.qoder.com.cn/api/v3/user/status`
   and requires `featureSwitches.allow_byok >= 2`. Offline — or behind a network
   that blocks that host — the check returns null, custom providers are refused,
   and no request ever reaches the DSH endpoint. **The handover is not an offline
   mode.** A failed turn says so in the CLI's own words; it does not silently
   fall back to a Qoder model.

> **ZCode has one prerequisite of the same kind:** the desktop app's
> `resources/config/provider/zcode-builtin.json` must be discoverable, because
> the CLI requires the built-in and personal provider files in the same breath.
> Install ZCode normally (`%LOCALAPPDATA%\Programs\ZCode`,
> `%ProgramFiles%\ZCode`, or `%ZCODE_HOME%`), or point
> `env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` at a catalog yourself. A standalone
> `zcode` on PATH with no catalog is not enough for a handover.

The settings page repeats this matrix ("Which engines can run a model configured
in dsh"), so the answer is reachable without reading this file.
> **Tool cards.** All ten hosted engines stream `tool/call` and `tool/result`
> with the engine's own arguments and output. Hermes Agent and ZCode reach this
> through their documented JSONL event streams (`hermes chat -q … --format
> stream-json` / `zcode -p … --output-format stream-json`), which are the same
> structured surfaces their desktop apps consume — the old `-z` / plain `-p`
> renderings printed only the final answer.


---

---

## Configuration

Custom settings can be configured under your profile's composition entry:

```yaml
- id: loop-engine
  config:
    # 1. Custom executable paths (optional - overrides default PATH / bundled binaries)
    bins:
      claudeBin: 'D:/tools/claude.exe'
      kimiBin: 'D:/tools/kimi.exe'
      agyBin: 'D:/tools/agy.exe'
      qoderclicnBin: 'D:/tools/qoderclicn.exe'
      grokBin: 'C:/Users/user/.grok/bin/grok.exe'
      minimaxcodeBin: 'D:/npm-global/node_modules/@minimax-ai/code/cli.js'
      zcodeBin: 'D:/Programs/ZCode/resources/glm/zcode.cjs'

    # 2. Region override (optional - MiniMax Code supports 'cn' or 'en')
    regions:
      mcodeRegion: 'cn'

    # 3. Child process idle timeout in milliseconds (default: 0 = disabled)
    # Applies to engines with persistent subprocesses (Kimi, Codex, Grok, MiniMax).
    childIdleMs: 300000

    # 4. Context window for hosted sessions (default: 262144 tokens)
    # Used by dsh auto-compaction (triggers at 80% of this limit).
    engineContextWindow: 262144

    # 5. Summarizer model for session compaction (must be set together)
    # Hosted sessions route compaction through this model.
    summarizerProvider: 'deepseek-official'
    summarizerModel: 'deepseek-flash'
```

**ZCode's install location.** ZCode ships as a desktop bundle rather than a plain
executable, so it is found by probing an install root: `%ZCODE_HOME%` first, then
`%LOCALAPPDATA%\Programs\ZCode` and `%ProgramFiles%\ZCode`. A manual install
anywhere else (`D:\Programs\ZCode`, say) is named either with the `ZCODE_HOME`
environment variable or with `bins.zcodeBin` — nothing hardcodes a drive letter.

---

## Usage Guide

- **Creating Sessions**: Select an engine from the preset dropdown next to the workspace picker, or leave it as `standard` to use the native `in-process` loop. Subagents automatically inherit their parent's engine.
- **Default Engine**: Configure the default engine for new chats under **Settings → Loop engine**. Existing sessions remain unchanged.
- **Switching Engines Mid-Session**: Enable *Show the engine selector in the chat page* in settings to switch engines directly from the composer:
  - **Hosted ↔ Hosted**: Handover occurs in place immediately.
  - **Hosted ↔ In-Process**: Prompts for confirmation and reloads the browser tab (chat history is preserved; unsent drafts and scroll positions are reset).
  - *Note*: Engine switching is permitted only when the current session is idle.
- **Header Badge**: Shows the engine actively powering the current session. Can be toggled via *Show the engine badge in the conversation header*.
- **Model Selection**:
  - **A catalog is discovered, not shipped.** Kimi Code's is read from its own config file at boot; an ACP engine's arrives in its `session/new` response the first time a session opens; Codex's is static in its bundled CLI. Picking a discovered model passes its id to the engine. **A vendor shipping a model therefore needs no plugin release.**
  - **The menu is global.** The harness builds one model catalog per Host generation, so every declared engine's subscription group appears in every session's menu. A per-session filter was attempted in 0.7.8/0.7.9 and REMOVED in 0.7.10: wrapping the client's model directory broke the composer's model seat. Picking another engine's group is refused by the driver with an explicit message.
  - An engine whose catalog this build cannot read falls back to a **declared** list, and the settings page says which of the two you are looking at. **Pi** has none by design (it refreshes from each provider at runtime via `pi update --models`); **ZCode** has no declared catalog: its own model list needs a live GLM Coding Plan, and an expired account cannot enumerate what it may use — but a DSH model can still be handed to it through the handover above.
  - Other hosted engines share one `external` group holding a single `default`, which means "let the engine decide". A shared group is not a limitation on what you can run — it is the menu collapsing engines whose catalogs this build has not measured. Declaring a catalog (one `models` row in the registry) gives an engine its own group.
  - Picking a **real dsh model** instead hands the engine that model's endpoint and credential as well; whether the engine can serve it is the engine's business, and a refusal is reported rather than swallowed.
  - Native dsh commands (`/export`, `/feedback`, `/permission`) and context auto-compaction remain fully functional.

---

## Architecture & Extending

Adding a new engine is straightforward thanks to the unified registry:

1. **Register Descriptor**: Add the engine ID to `HOSTED_ENGINE_IDS` and define its metadata and capabilities in `src/engine-registry.ts`.
2. **Implement Driver**: Create a driver implementing `runStep` (leveraging `src/driver-cli/` or `src/driver-acp/`).
3. **Bind Driver**: Register the driver class in `src/engine-drivers.ts`.
4. **UI Localization**: Add display strings in `src/client/locales.ts` and an optional SVG icon in `src/client/engine-marks.ts`.

Both tables enforce compile-time exhaustiveness checks — incomplete engine registrations fail at build time rather than runtime. Detailed instructions are in [docs/engine-registry.md](docs/engine-registry.md).

---

## Version Compatibility

A single release seamlessly supports multiple DeepSeek Harness generations via runtime detection:

| Plugin release | Supported DeepSeek Harness |
|---|---|
| `0.7.4`+ | `0.2.0-rc.1` … `0.2.1-rc.1` |
| `0.7.0` – `0.7.3` | `0.1.5-rc.1` … `0.2.0-rc.2` |

The union range is `>=0.1.5-rc.1 <0.1.6-0 || >=0.1.7-rc.1 <0.1.8-0 || >=0.2.0-rc.1 <0.2.2-0`.
`0.2.0` and `0.2.1` share the last segment because the harness kept the same API shape
across them, so one range covers both. `dsh`'s compatibility check reads these peers
and refuses to load a plugin that misses one, which is what made `0.7.3` uninstallable
on `0.2.1`.

See [docs/compatibility.md](docs/compatibility.md) for harness upgrade checklists and API surface diffs.

---

## Technical Notes & Limitations

- **Agent Factory Replacement**: The plugin registers a unified facade over the harness agent factory. Any session that cannot be routed to a hosted engine gracefully falls back to the native `in-process` loop.
- **Engine State Persistence**: Active session engine bindings are stored in `$DSH_HOME/.loop-engine/engines.json`. If this file is cleared, sessions revert to their preset defaults.
- **Subprocess Concurrency**: Multi-session execution shares the respective CLI's local authentication and configuration directory.
- **Grok Build Shell Execution**: Grok tools rely on the harness client terminal bridge (`ctx.shell`).

---

## Documentation Links

- [docs/engine-registry.md](docs/engine-registry.md) — Engine registration guide & ACP engine recipe.
- [docs/per-session-engine.md](docs/per-session-engine.md) — Detailed user-facing behaviors and handover specs.
- [docs/architecture.md](docs/architecture.md) — Core routing, factory slots, and configuration patches.
- [docs/driver-core.md](docs/driver-core.md) — Shared driver runtime and lifecycle management.
- [docs/compatibility.md](docs/compatibility.md) — Multi-version harness compatibility guide.
- [docs/source-checkout.md](docs/source-checkout.md) — Running alongside a harness source checkout.
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development and probe verification workflows.

---

## License

[MIT](LICENSE) © contributors of `dsh-loop-engine-allinone` and upstream `kuun993/dsh-loop-engine`. See [NOTICE](NOTICE) for license and attribution details.
