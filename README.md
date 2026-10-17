# dsh-loop-engine-allinone

**English** · [简体中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Harness: 0.1.5 | 0.1.7 | 0.2.0](https://img.shields.io/badge/harness-0.1.5%20%7C%200.1.7%20%7C%200.2.0-6f42c1)](#version-compatibility)

**dsh-loop-engine-allinone** is an all-in-one agent loop engine switcher for **[DeepSeek Harness](https://github.com/deepseek-ai)** (`dsh`). It enables per-session engine switching across **10 hosted engines** (Claude Code, Codex, Pi, Kimi Code, Antigravity, ZCode, Qoder CN, Hermes Agent, Grok Build, MiniMax Code) alongside the built-in `in-process` loop.

> `dsh` is the harness CLI. `dsh web` boots its **web profile**, which is the UI this plugin's engine picker and settings page live in.

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
# From npm (recommended)
dsh plugin --profile web add dsh-loop-engine-allinone
```

Then boot the web profile once and open **Settings → Loop engine**:

```sh
dsh web
```

Installing into a profile other than `web` (the Desktop app's `desktop`, a
`headless` deployment, a renamed profile) means naming that profile instead:
`dsh plugin --profile desktop add dsh-loop-engine-allinone`, **and** setting
`profile: desktop` in the composition entry — see the notes below, because
forgetting the second half is the one mistake that leaves the plugin mounted but
unable to run any engine.

### Installation Notes

- **Profile Configuration**: The installer automatically injects a managed configuration block into your profile's `cordis.patch.yml`. All other custom configuration in that file is preserved.
- **Non-web Profiles**: When installing into non-web profiles (such as `desktop` or headless), explicitly specify `profile: <name>` in the composition entry:
  ```yaml
  - id: loop-engine
    config:
      profile: desktop
  ```
  *(Without this, configuration defaults to `web` and the plugin will not attach to custom profiles.)*
- **Uninstallation**: Run `dsh plugin --profile web remove dsh-loop-engine-allinone`, then remove the managed `loop-engine` block from `cordis.patch.yml`.
- **pnpm 10+**: If dependency build scripts are blocked (`ERR_PNPM_IGNORED_BUILDS` mentioning `esbuild`, `@google/genai`, etc.), run `pnpm approve-builds`.
- **Harness from Source**: If launching the harness directly from a source checkout, bridge peer dependencies using `file:` shims as described in [docs/source-checkout.md](docs/source-checkout.md).

---

---

## Supported Engines

| Engine | Type / Protocol | Host Requirements & Authentication |
|---|---|---|
| **Claude Code** | Bundled SDK / `ndjson` | Nothing, by default (the SDK ships a binary); set `bins.claudeBin` to run your own install instead |
| **Codex** | Bundled / `jsonrpc` | `codex login` or `CODEX_API_KEY` |
| **Pi** | Bundled / `jsonrpc` | `~/.pi/agent/auth.json`, or the provider's API-key variable |
| **Kimi Code** | External CLI / `acp` | `kimi` CLI installed and authenticated (`kimi login`) |
| **Antigravity** | External CLI / `ndjson` | `agy` CLI installed and signed in to Google |
| **ZCode** | External CLI / `jsonrpc` | `zcode` CLI installed, with a live GLM Coding Plan subscription |
| **Qoder CN** | External CLI / `ndjson` | `qoderclicn` CLI installed and authenticated |
| **Hermes Agent** | External CLI / `text` | `hermes` CLI installed and configured (`hermes setup`) |
| **Grok Build** | External CLI / `acp` | `grok` CLI installed and signed in once (`grok login`) |
| **MiniMax Code** | External CLI / `acp` | `npm i -g @minimax-ai/code`, `mcode login --region cn\|global`, then `mcode provider use token-plan` |

> **Model lists are discovered, not listed here.** Each engine's models come from the engine itself — Kimi Code's own config file at boot, an ACP engine's `session/new` response as soon as a session opens — so a vendor shipping a model does not need a plugin release. Engines whose catalog this build cannot read fall back to a declared list, and one with neither shows the shared `external` group. The settings page shows which is which.

> **Note**: For external CLI engines (`bundled: false`), the plugin spawns your locally installed binaries; it does not download or authenticate them automatically. Please install and log in on your host machine beforehand.

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
  - An engine whose catalog this build cannot read falls back to a **declared** list, and the settings page says which of the two you are looking at. **Pi** has none by design (it refreshes from each provider at runtime via `pi update --models`); **ZCode**'s could not be read because its GLM Coding Plan subscription has lapsed, and an expired account cannot enumerate what it may use.
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

| Plugin Release | Supported DeepSeek Harness Line |
|---|---|
| `0.2.0-rcX` | `0.2.0-rc.1`, `0.2.0-rc.2` |
| `0.1.7-rcX` | `0.1.7-rc.1`, `0.1.7-rc.2` |
| `0.1.5-rcX` | `0.1.5-rc.1`, `0.1.5-rc.2` |

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
