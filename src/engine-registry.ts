/**
 * The engine registry: the ONE data table every engine-shaped decision derives
 * from.
 *
 * Before this module the engine roster lived in five places that had to be kept
 * in step by hand — the `LOOP_ENGINE_IDS` array, the `buildEngine` switch, the
 * settings schema's engine union, the preset display-name map, and the browser
 * half's option list and glyph table. Adding an engine meant finding all of
 * them, and a miss showed up as an engine that mounts but cannot be selected, or
 * one the settings schema rejects. Now the roster is declared ONCE here and
 * everything else is derived:
 *
 *   - {@link HOSTED_ENGINE_IDS} / {@link LOOP_ENGINE_IDS} (this module)
 *   - the settings schema's union (`./settings.ts` maps the ids to `z.const`)
 *   - the preset id prefix arithmetic (`./agent-preset-ids.ts`)
 *   - the browser half's option list, glyph and copy key (`./client/**`)
 *   - the driver dispatch (`./engine-drivers.ts`, which is the one node-side
 *     table that must import the engine modules — it cannot live here)
 *
 * ## Why this module imports NOTHING
 *
 * It is read by the browser bundle (the settings page renders the option list
 * from it), and the client artifact must never pull a host package
 * (`dsh-settings`, `schemastery`, `node:fs`) into the browser. So this file is
 * plain data and pure functions — no imports at all, not even type-only ones
 * from a host package. `tests/agent-preset-ids.spec.ts` pins that property.
 *
 * Anything that needs the host (probing a binary, reading an auth file, spawning
 * a child) lives in `./engine-probe.ts` on the node side and is keyed by
 * {@link EngineDescriptor.id}. The split is the reason a descriptor can declare
 * `authPaths` — a fact the settings page renders — while the *probe* that reads
 * them stays out of the browser bundle.
 *
 * ## Adding an engine
 *
 * 1. add its id to {@link HOSTED_ENGINE_IDS};
 * 2. add its {@link EngineDescriptor} row to {@link ENGINE_REGISTRY} (TypeScript
 *    refuses the build until the record is exhaustive again);
 * 3. add its driver to `./engine-drivers.ts` (same exhaustiveness rule);
 * 4. add its copy to `./client/locales.ts` under the descriptor's
 *    {@link EngineDescriptor.localeKey}.
 *
 * Nothing else: the settings schema, the preset ids, the option lists and the
 * glyph table all read this table.
 *
 * @module dsh-loop-engine-allinone/engine-registry
 */

/**
 * The wire shape an engine speaks, as a coarse family.
 *
 * The four families are the ones the drivers' protocol skeletons implement
 * (`./driver-cli/`): line-delimited JSON frames, JSON-RPC 2.0, the Agent Client
 * Protocol (JSON-RPC with ACP's method names), and plain text. The value is
 * declared rather than inferred so the settings page can say what an engine can
 * do without importing the driver.
 */
export const ENGINE_PROTOCOLS = ['ndjson', 'jsonrpc', 'acp', 'text'] as const

/** One engine's wire-protocol family. */
export type EngineProtocol = (typeof ENGINE_PROTOCOLS)[number]

/**
 * What one engine can do, declared rather than discovered.
 *
 * Every surface that would otherwise hardcode "engine X supports Y" reads this
 * instead: the settings page hides a control an engine cannot honour, and a
 * driver asked for something outside its declaration fails loud rather than
 * pretending. A capability that is genuinely unknown is declared `false` — the
 * rule is that a surface must never claim more than the engine was verified to
 * do (`docs/engine-registry.md` records what was verified and how).
 */
export interface EngineCapabilities {
  /** Whether the engine streams partial output, rather than answering in one block at the end. */
  readonly streaming: boolean
  /** The wire-protocol family the driver speaks. */
  readonly protocol: EngineProtocol
  /** Whether a session can be continued by id across separate process launches. */
  readonly sessionResume: boolean
  /**
   * The engine's own permission/approval mode names, when it has a mode switch
   * the driver can map dsh's sandbox/approval knobs onto. Absent means the
   * engine has no such switch — the driver then relies on the subprocess
   * sandbox alone, and the settings page shows no mode control.
   */
  readonly permissionModes?: readonly string[]
  /** Whether the engine accepts image input natively. */
  readonly images: boolean
  /** Whether the engine exposes a reasoning-effort/thinking level. */
  readonly reasoningLevels: boolean
  /**
   * The effort values this engine accepts, in its own vocabulary and from least
   * to greatest, when {@link reasoningLevels} is true.
   *
   * Declared as DATA because the values are the engine's, not a dsh scale
   * (`ReasoningEffortId` is an opaque string for exactly that reason): the
   * driver forwards a value verbatim, so a ladder the plugin invented would be a
   * silently wrong strength. Measured on MiniMax Code 0.6.12 from the live
   * `session/new` `thinkingEffort` option — `default` is the engine's own
   * "whatever I would do", and every other value was accepted by
   * `session/set_config_option`.
   *
   * Absent means the engine has no effort surface this plugin can name: no model
   * under its route advertises one, so the model menu shows no effort row (the
   * pre-existing behavior for every hosted engine).
   */
  readonly reasoningEfforts?: readonly string[]
  /**
   * The model-id suffix that marks a variant as the one those efforts apply to.
   *
   * MiniMax Code's composite ids end in `:v:<variant>` (`…:v:thinking`), and its
   * effort option is only valid for a thinking variant — the CLI itself refuses
   * `thinkingEffort` for a non-thinking pick ("Thinking effort is not advertised
   * for the selected model"). A suffix rather than per-model flags, because the
   * catalog is often DISCOVERED at runtime (`session/new`) and a discovered entry
   * carries an id and a label only; deriving from the id keeps the effort row
   * alive across a discovery.
   */
  readonly reasoningModelSuffix?: string
  /**
   * Whether this engine can be pointed at a dsh model's endpoint at all.
   *
   * `true` means the driver carries the session's dsh selection into the engine —
   * each engine in its own dialect (Claude Code `Options.env`, Codex `-c`, Pi's
   * plugin-owned agent directory, Kimi's `KIMI_MODEL_*` variables, Grok's
   * environment + owned home, MiniMax Code's owned data directory).
   *
   * `false` means the engine runs only models from its own sign-in, and a session
   * that selects a dsh model is REFUSED with a message saying so (`UNSERVABLE_MODEL`)
   * rather than handed an id its provider table has never heard of.
   *
   * Declared as data, and pinned against the drivers' own wiring by
   * `tests/engine-drivers.spec.ts`, so the settings page and the release notes can
   * state the matrix without asking each driver at runtime.
   */
  readonly modelHandover: boolean
  /**
   * The ACP protocol version this engine's client announces at `initialize`.
   *
   * Declared rather than hardcoded because three engines now share ONE ACP
   * skeleton (`driver-acp/`): before it, the announced version was a constant
   * inside that client, so an engine that moved to a different protocol version
   * would have been advanced — or silently frozen — for all of them at once. The
   * value is per engine and optional; an engine that omits it (or that does not
   * speak ACP at all) is announced as {@link DEFAULT_ACP_PROTOCOL_VERSION}.
   */
  readonly acpProtocolVersion?: number
}

/**
 * The ACP protocol version a client announces when its engine's row declares
 * none.
 *
 * `1` is what every ACP engine on this fork's reference host answered to a client
 * that announced `1` (measured: kimi, grok and MiniMax Code all reply
 * `protocolVersion: 1`), and it is also the value the shared client sent before
 * this became registry data — so an engine that declares nothing keeps the
 * behavior it had.
 */
export const DEFAULT_ACP_PROTOCOL_VERSION = 1

/**
 * One engine's account REGION, when its CLI makes the account's region a
 * first-class deployment fact.
 *
 * MiniMax Code is the case: its login endpoint is region-scoped
 * (`mcode login --region cn|global`), its credentials are stored per region
 * (`~/.minimax/auth/prod/<region>/…`) and its own environment variable
 * (`MCODE_REGION`) selects one. The descriptor declares the knob so the driver
 * can set it on the child WITHOUT naming the engine's variable in shared code,
 * and a deployment can override the default.
 */
export interface EngineRegion {
  /** The composition-entry key a deployment sets to override {@link default}. */
  readonly configKey: string
  /** The environment variable the CLI reads. */
  readonly envVar: string
  /** The region used when a deployment pins none. */
  readonly default: string
  /** Every region value the CLI accepts. */
  readonly values: readonly string[]
}

/**
 * One model an engine offers from its OWN subscription.
 *
 * Distinct from a dsh model: a hosted engine answers with its own account, so
 * these ids are the engine's vocabulary, not something any dsh adapter serves.
 * Picking one in the model menu hands that id to the engine (`--model <id>`),
 * which is how a user chooses among the models their subscription includes
 * instead of accepting "the engine decides".
 *
 * The list is DECLARED rather than discovered, for the same reason the
 * capabilities are: probing an engine's catalog means spawning it, and this
 * plugin's contract is that booting the harness starts **no** external process.
 * A deployment whose subscription changed refreshes the list by editing it —
 * and a stale id fails loudly at the engine, which is the honest outcome.
 */
export interface EngineModel {
  /** The engine's own model id, passed verbatim to the engine. */
  readonly id: string
  /** Human-readable name shown in the model menu. */
  readonly label: string
}

/**
 * Everything the rest of the plugin needs to know about one engine, as data.
 *
 * The two groups are deliberately different in kind: the fields above
 * {@link capabilities} are deployment facts (where the binary is, how to
 * upgrade it, whether it ships with the plugin), and `capabilities` is what the
 * engine can do. A surface that renders an engine reads the second; the settings
 * page's engine-management area reads the first.
 */
export interface EngineDescriptor {
  /** Stable engine id: the value stored in settings, records and preset ids. */
  readonly id: string
  /** Human-readable name, used for the authored preset's metadata and as the fallback label. */
  readonly label: string
  /** Where the engine comes from, shown as a link in the settings page's engine-management area. */
  readonly repo?: string
  /**
   * Whether the engine ships as an npm dependency of this plugin.
   *
   * The distinction is load-bearing rather than cosmetic: a bundled engine's
   * version is pinned by this package's `package.json`, so it is upgraded by
   * changing the dependency and reinstalling — never by running the CLI's own
   * updater at runtime. Only an external CLI gets an upgrade button.
   */
  readonly bundled: boolean
  /**
   * The composition-entry key that pins this engine's executable, when the
   * deployment may point it at its own build. External CLIs and the bundled
   * engines that can be unbound (`claude`'s SDK option, codex's and pi's own
   * binaries) both carry one; an engine that can only ever run the bundled copy
   * omits it.
   */
  readonly binConfigKey?: string
  /** argv (after the executable) that prints the engine's version. */
  readonly versionArgv?: readonly string[]
  /**
   * argv (after the executable) that updates an EXTERNAL CLI in place.
   *
   * Absent for a bundled engine on purpose: its version is this package's
   * dependency pin, and rewriting a dependency at runtime is an anti-pattern
   * (`docs/engine-registry.md` §4).
   */
  readonly updateArgv?: readonly string[]
  /** What to tell a user whose engine is installed but not signed in. */
  readonly loginHint?: string
  /**
   * The engine's account region, when its CLI scopes accounts by region.
   *
   * Absent for every engine whose account is region-independent. See
   * {@link EngineRegion} for what the deployment can do with it.
   */
  readonly region?: EngineRegion
  /**
   * Home-relative paths whose existence means "this engine has been signed in
   * at least once", for the settings page's diagnostic.
   *
   * A hint, never a gate: engines own their credentials, and the plugin never
   * reads, writes or refreshes them. The probe only reports whether the path
   * exists (`./engine-probe.ts`).
   */
  readonly authPaths?: readonly string[]
  /** The copy key naming this engine in the browser half's dictionary. */
  readonly localeKey: string
  /**
   * The models this engine offers from its own subscription, when the plugin
   * knows them.
   *
   * An engine that omits this keeps the shared `external` route with its single
   * `default` entry ("the engine decides") — which is the right answer for an
   * engine whose catalog this build has no verified list for. An engine that
   * declares one gets its OWN provider group in the model menu, holding
   * `default` plus these entries, and selecting one passes its id to the engine.
   */
  readonly models?: readonly EngineModel[]
  /** What the engine can do. */
  readonly capabilities: EngineCapabilities
}

/**
 * Every engine this plugin hosts, in selection order.
 *
 * The order is the settings dropdown's order and the order the authored presets
 * are written in. New engines are APPENDED: the ids are persisted in session
 * logs, sidecar records and preset ids, so an existing id may never be removed
 * or reordered without a migration (`docs/engine-registry.md` §5).
 */
export const HOSTED_ENGINE_IDS = [
  'claude-code',
  'codex',
  'pi',
  'kimi',
  'agy',
  'zcode',
  'qoderclicn',
  'hermes',
  'grok',
  'minimaxcode',
] as const

/** An engine this plugin hosts itself; `in-process` is the harness's own loop. */
export type HostedEngineId = (typeof HOSTED_ENGINE_IDS)[number]

/**
 * Every selectable engine, the harness's own loop first.
 *
 * `in-process` is not a descriptor: it is the harness's loop, not something this
 * plugin hosts, so it has no binary, no protocol and no capabilities to declare.
 * Keeping it out of {@link ENGINE_REGISTRY} is what makes the record exhaustive
 * over {@link HostedEngineId} alone.
 */
export const LOOP_ENGINE_IDS = ['in-process', ...HOSTED_ENGINE_IDS] as const

/** Installed agent loop engine id. */
export type LoopEngineId = (typeof LOOP_ENGINE_IDS)[number]

/**
 * The registry itself: one row per hosted engine.
 *
 * `satisfies` rather than a plain annotation, for two reasons at once. The
 * `Record` half is the exhaustiveness check: TypeScript refuses to build when an
 * id in {@link HOSTED_ENGINE_IDS} has no row, so "add an engine" cannot
 * half-land. The `as const` half keeps every field's LITERAL type, which is what
 * lets the browser half derive its copy keys from this table
 * (`EngineLocaleKey` in `./client/locales.ts`) instead of restating the roster —
 * an annotation would widen `localeKey` to `string` and destroy that.
 */
export const ENGINE_REGISTRY = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    repo: 'https://github.com/anthropics/claude-code',
    // The SDK is an npm dependency, but its `pathToClaudeCodeExecutable` option
    // hands the work to an external binary, so the deployment may unbind it.
    bundled: true,
    binConfigKey: 'claudeBin',
    versionArgv: ['--version'],
    loginHint: 'run `claude` once and sign in, or point `claudeBin` at a signed-in install',
    authPaths: ['.claude/.credentials.json', '.claude.json'],
    localeKey: 'engineClaudeCode',
    capabilities: {
      streaming: true,
      // The Agent SDK delivers an async message stream; the driver reads it as
      // frames, which is the ndjson family's shape.
      protocol: 'ndjson',
      sessionResume: true,
      permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
      images: true,
      reasoningLevels: false,
      modelHandover: true,
    },
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    repo: 'https://github.com/openai/codex',
    bundled: true,
    binConfigKey: 'codexBin',
    versionArgv: ['--version'],
    loginHint: 'run `codex login`, or set CODEX_API_KEY, or point `codexBin` at a signed-in install',
    authPaths: ['.codex/auth.json'],
    localeKey: 'engineCodex',
    // Read out of the bundled CLI binary (0.149.1), which carries the ids its
    // `thread/start` accepts; the driver passes the picked id straight through as
    // `model`. Only the codex-family ids are listed: the binary also mentions
    // `gpt-4.1`/`gpt-5.6` in contexts this build did not verify, and a wrong id
    // fails loudly at the engine rather than silently falling back.
    models: [
      { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
      { id: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
      { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'gpt-5.4', label: 'GPT-5.4' },
      { id: 'gpt-5.2', label: 'GPT-5.2' },
      { id: 'gpt-5.1', label: 'GPT-5.1' },
    ],
    capabilities: {
      streaming: true,
      protocol: 'jsonrpc',
      sessionResume: true,
      // Codex declares its stance as a (sandbox mode, approval policy) PAIR at
      // `thread/start`, so the modes are the sandbox half.
      permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
      images: true,
      reasoningLevels: true,
      modelHandover: true,
    },
  },
  pi: {
    id: 'pi',
    label: 'Pi',
    repo: 'https://github.com/earendil-works/pi',
    bundled: true,
    binConfigKey: 'piBin',
    versionArgv: ['--version'],
    loginHint: 'run `pi` once and sign in, or set the provider API-key variable pi expects',
    authPaths: ['.pi/agent/auth.json'],
    localeKey: 'enginePi',
    capabilities: {
      streaming: true,
      protocol: 'jsonrpc',
      // Every step opens a fresh `pi --mode rpc` session, so there is no id to
      // resume across launches.
      sessionResume: false,
      permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
      images: true,
      reasoningLevels: true,
      modelHandover: true,
    },
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi Code',
    repo: 'https://github.com/MoonshotAI/kimi-cli',
    bundled: false,
    binConfigKey: 'kimiBin',
    versionArgv: ['--version'],
    updateArgv: ['update'],
    loginHint: 'run `kimi` once and sign in (or `kimi login`)',
    authPaths: ['.kimi-code/credentials.json', '.kimi-code/auth.json'],
    localeKey: 'engineKimi',
    // Read out of `~/.kimi-code/config.toml`, which the Kimi Code app writes for
    // the signed-in account: one `[models."kimi-code/<id>"]` block per model the
    // account is provisioned for, with the vendor's own display name. The ids are
    // what the app passes as `model`, so they are the right vocabulary for this
    // driver's `session/set_model`. The catalog was NOT read off the ACP surface
    // itself, because the `kimi` CLI is not installed on the machine this was
    // measured on (only the desktop app is) — a stale id fails loudly at the
    // engine rather than silently falling back.
    models: [
      { id: 'k3', label: 'K3' },
      { id: 'k3-256k', label: 'K3-256k' },
      { id: 'kimi-for-coding', label: 'K2.8 Preview' },
      { id: 'kimi-for-coding-highspeed', label: 'K2.7 Code Highspeed' },
    ],
    capabilities: {
      streaming: true,
      protocol: 'acp',
      sessionResume: true,
      permissionModes: ['ask', 'allow', 'deny'],
      images: true,
      reasoningLevels: false,
      modelHandover: true,
    },
  },
  agy: {
    id: 'agy',
    label: 'Antigravity',
    repo: 'https://antigravity.google',
    bundled: false,
    binConfigKey: 'agyBin',
    versionArgv: ['--version'],
    updateArgv: ['update'],
    loginHint: 'run `agy` once and complete the Google sign-in it opens',
    authPaths: ['.gemini/oauth_creds.json'],
    localeKey: 'engineAgy',
    // Verified with `agy models` on a signed-in host (2026-10-17) and confirmed
    // selectable end to end: `--model gemini-3.8-flash-low` answered PONG.
    models: [
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
      { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    ],
    capabilities: {
      // VERIFIED against a signed-in host: `step_update` frames carry
      // `text_delta` increments, and the driver maps them (see
      // `engine-agy/frames.ts`).
      streaming: true,
      protocol: 'ndjson',
      // The CLI continues a conversation with `--conversation <id>` and reports
      // the id it used, but this driver does NOT use it: the plugin is stateless
      // by design, replaying the durable transcript into every step, so there is
      // nothing to carry across steps and nothing that could leak between them.
      sessionResume: true,
      // The CLI's EXECUTION modes. They are deliberately not treated as the
      // permission switch: `--mode accept-edits` and `--mode plan` were both
      // verified to leave `permission_mode` at `request-review`. What actually
      // gates tools headless is `--dangerously-skip-permissions`, mapped from
      // dsh's sandbox knob (`agyDangerouslySkipPermissions`).
      permissionModes: ['accept-edits', 'auto', 'plan'],
      // Verified absent: there is no image input on this surface.
      images: false,
      reasoningLevels: true,
      modelHandover: false,
    },
  },
  zcode: {
    id: 'zcode',
    label: 'ZCode',
    repo: 'https://z.ai',
    bundled: false,
    binConfigKey: 'zcodeBin',
    versionArgv: ['version'],
    updateArgv: ['plugins', 'update'],
    loginHint: 'run `zcode login` to sign in with Z.AI',
    authPaths: ['.zcode/v2', '.zcode/cli'],
    localeKey: 'engineZcode',
    capabilities: {
      streaming: true,
      protocol: 'jsonrpc',
      sessionResume: true,
      permissionModes: ['build', 'edit', 'plan', 'yolo'],
      images: false,
      reasoningLevels: false,
      modelHandover: false,
    },
  },
  qoderclicn: {
    id: 'qoderclicn',
    label: 'Qoder CN',
    repo: 'https://qoder.com',
    bundled: false,
    binConfigKey: 'qoderclicnBin',
    versionArgv: ['--version'],
    updateArgv: ['update'],
    loginHint: 'run `qoderclicn login` to sign in to Qoder CN',
    authPaths: ['.qoder-cn/.auth/user'],
    localeKey: 'engineQoderclicn',
    capabilities: {
      streaming: true,
      // `-p --output-format stream-json` emits Claude Code's stream-json frames,
      // one JSON document per line.
      protocol: 'ndjson',
      sessionResume: true,
      permissionModes: ['default', 'accept_edits', 'bypass_permissions', 'dont_ask', 'auto'],
      // `--attachment` takes files, but a probe could not confirm image blocks
      // survive the round trip, so the engine does not claim the capability.
      images: false,
      reasoningLevels: true,
      modelHandover: false,
    },
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Agent',
    repo: 'https://github.com/NousResearch/hermes',
    bundled: false,
    binConfigKey: 'hermesBin',
    versionArgv: ['--version'],
    updateArgv: ['update'],
    loginHint: 'run `hermes setup` (or `hermes auth`) to sign in to an inference provider',
    authPaths: ['auth.json'],
    localeKey: 'engineHermes',
    capabilities: {
      // `-z PROMPT` prints the finished answer; a probe found no structured
      // stream, so the driver reads the whole of stdout as one reply.
      streaming: false,
      protocol: 'text',
      sessionResume: true,
      permissionModes: ['safe-mode', 'yolo'],
      images: false,
      reasoningLevels: true,
      modelHandover: true,
    },
  },
  grok: {
    id: 'grok',
    label: 'Grok Build',
    repo: 'https://github.com/xai-org/grok-build',
    bundled: false,
    binConfigKey: 'grokBin',
    versionArgv: ['--version'],
    // Verified against the released binary (1.0.59): `grok update  Check for
    // updates or install a specific version`. The vendor's own installer
    // (`x.ai/cli/install.sh`) is the other upgrade path and reinstalls in place.
    updateArgv: ['update'],
    loginHint: 'run `grok` once and complete the sign-in it opens (or `grok login`), then retry',
    authPaths: ['.grok/auth.json'],
    localeKey: 'engineGrok',
    // Measured from the SIGNED-IN agent's own `initialize` answer
    // (`_meta.modelState`): the catalog it will actually serve, whose
    // `currentModelId` is `grok-4.7`. This REPLACED an earlier list taken from
    // the unauthenticated `grok models` command, which reported `grok-4.6` and
    // `grok-4.5` — ids the ACP surface then rejected with `-32602 unknown model
    // id`. The lesson is the fork's own rule: a catalog is read from the surface
    // the driver talks to, not from a sibling command that may be reading a
    // different source.
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7' },
    ],
    capabilities: {
      // Measured: `session/update` frames carry `agent_message_chunk` and
      // `agent_thought_chunk` increments.
      streaming: true,
      protocol: 'acp',
      // Measured: `initialize` answers `loadSession: true` with
      // `sessionCapabilities.resume`, and the user guide documents
      // `session/load` plus headless `--resume`/`--continue`.
      sessionResume: true,
      // The ACP gate is `session/request_permission`, and this engine's own
      // always-approve switch is the `--always-approve` argv flag (alias
      // `--yolo`), which `session/new` can also express as `_meta.yoloMode`.
      permissionModes: ['ask', 'always-approve'],
      // Measured: `initialize` answers `promptCapabilities.image: false`, so the
      // driver keeps images as path-bearing placeholders instead of sending
      // blocks this engine would refuse.
      images: false,
      // The user guide documents the `reasoning_effort` session config option
      // (`minimal`, `low`, `medium`, `high`, `xhigh`).
      reasoningLevels: true,
      modelHandover: true,
      // Measured: the engine answers `protocolVersion: 1` to a client that
      // announces 1.
      acpProtocolVersion: 1,
    },
  },
  minimaxcode: {
    id: 'minimaxcode',
    label: 'MiniMax Code',
    // The vendor's documentation site; the GitHub org (`github.com/MiniMax-AI`)
    // publishes no CLI repository for this product.
    repo: 'https://agent.minimax.io/docs/cli/quick-start',
    bundled: false,
    binConfigKey: 'minimaxcodeBin',
    versionArgv: ['--version'],
    // Verified against 0.6.12: `mcode update  Check for and install a Minimax
    // Code update`.
    updateArgv: ['update'],
    // The subscription path is the whole point of this engine: signing in is what
    // enables the M Plan allowance, and `provider use token-plan` is what makes
    // the CLI spend it instead of an API key.
    loginHint: 'run `mcode login --region cn|global`, then `mcode provider use token-plan` to spend your M Plan subscription',
    // Measured on this host: credentials live per REGION under
    // `~/.minimax/auth/prod/<region>/mcode-public/auth.json`, and the CLI writes
    // an `auth-state.json` beside them. The directory, not the file, is the
    // "signed in at least once" fact.
    authPaths: ['.minimax/auth/prod'],
    region: {
      configKey: 'mcodeRegion',
      // MEASURED, and not the name one would guess: `MCODE_REGION` is INERT on
      // the `mcode acp` path (a child with `MCODE_REGION=en` still authenticated
      // as the `cn` account), while `MAVIS_REGION=en` flipped it to "auth
      // required" — so `MAVIS_REGION` is the variable THIS surface honours. The
      // `MCODE_*` family belongs to the CLI's Electron/mcode-tools broker, which
      // is a different process. A driver that set `MCODE_REGION` would look
      // correct and change nothing.
      envVar: 'MAVIS_REGION',
      default: 'cn',
      // TWO vocabularies, and conflating them would set a value the CLI rejects:
      // the LOGIN flag speaks `cn|global` (`mcode login --region cn|global`),
      // while the region VALUE the runtime reads and validates is `cn|en`
      // (shipped code: `i!=="cn"&&i!=="en"` throws "The MCode mcode-tools host
      // environment is incomplete"; the same value picks the `zh`/`en` locale and
      // the `mavis` endpoint host). So `en` is this knob's spelling of the
      // non-China account, and the values below are the ones this variable
      // accepts. Only `cn` was measurable here — this host's account is a `cn`
      // one, and the `en` side was observed only as "the cn credentials no longer
      // apply".
      values: ['cn', 'en'],
    },
    localeKey: 'engineMinimaxcode',
    // Measured from the live `session/new` answer (unauthenticated catalog):
    // MiniMax Code's own composite model ids, whose `v:` suffix selects the
    // variant. A subscription can expose more; a stale id fails loud at the
    // engine, which is the honest outcome.
    // Re-measured on 0.6.12 (2026-10-21): the live `session/new` catalog advertises
    // `MiniMax-M3.1-Flash` and `MiniMax-M3` only, and the `-Preview` id this row used
    // to carry is refused by the engine as "Model selection is not advertised". The
    // M2.7 rows went the same way. Thinking variants come first because they are the
    // only form an effort can be applied to (the M3.1 one has no non-thinking form at
    // all). A discovery replaces this list at the first step, so this is the
    // boot-time answer, not a second source of truth.
    models: [
      { id: 'm:minimax:MiniMax-M3.1-Flash:v:thinking', label: 'M3.1-Flash · thinking' },
      { id: 'm:minimax:MiniMax-M3:v:thinking', label: 'M3 · thinking' },
      { id: 'm:minimax:MiniMax-M3.1-Flash:v:', label: 'M3.1-Flash' },
      { id: 'm:minimax:MiniMax-M3:v:', label: 'M3' },
    ],
    capabilities: {
      // Measured: `agent_message_chunk` / `agent_thought_chunk` increments, and
      // the ACP handshake answered a real prompt with `stopReason: end_turn`.
      streaming: true,
      protocol: 'acp',
      // Measured: `loadSession: true`, `sessionCapabilities.resume`, and a real
      // `session/load` was ACCEPTED on 0.6.12.
      sessionResume: true,
      // Measured from the live `session/new` configOptions: the engine's
      // `permissionMode` option is exactly these three values.
      permissionModes: ['default', 'auto', 'bypassPermissions'],
      // Measured: `promptCapabilities.image: true` (and the engine's own catalog
      // declares image/video modalities for the M3 models).
      images: true,
      // Measured: a `thinkingEffort` config option
      // (`default`/`low`/`medium`/`high`/`xhigh`/`max`).
      reasoningLevels: true,
      modelHandover: true,
      // The same config option's values, re-measured on 0.6.12: `session/new`
      // advertises exactly these six, and `session/set_config_option` accepts
      // each of them for a thinking variant.
      reasoningEfforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
      // The effort option is only valid for a `…:v:thinking` pick — a
      // non-thinking variant is refused by the CLI itself with
      // "Thinking effort is not advertised for the selected model".
      reasoningModelSuffix: ':v:thinking',
      // Measured: the engine answers `protocolVersion: 1`.
      acpProtocolVersion: 1,
    },
  },
} as const satisfies Readonly<Record<HostedEngineId, EngineDescriptor>>

/** Every hosted engine descriptor, in selection order. */
export const ENGINE_DESCRIPTORS: readonly EngineDescriptor[] =
  HOSTED_ENGINE_IDS.map(id => ENGINE_REGISTRY[id])

/**
 * Whether an engine is one this plugin hosts — an external CLI some other
 * vendor runs, which owns its own model — rather than the harness's own loop.
 *
 * The judgement a surface needs to say "the model is the engine's own business"
 * without hardcoding one engine's name: every hosted engine behaves the same
 * way here, and naming one of them would make a general fact read as a property
 * of that engine. An engine nobody has answered for yet is not hosted: a surface
 * that does not know says nothing rather than claiming the wrong half.
 * @param engine - an engine id, or undefined while one is still being read.
 * @returns whether that engine is hosted by this plugin.
 */
export function isHostedEngine(engine: LoopEngineId | undefined): engine is HostedEngineId {
  return engine !== undefined && engine !== 'in-process'
}

/**
 * Whether an untyped value is one of {@link LOOP_ENGINE_IDS}.
 *
 * The boundary test both halves need: a value crossing the wire, the sidecar
 * file, or a projection read is only an engine when it is one of these.
 * @param value - the value to classify.
 * @returns whether `value` is an installed engine id.
 */
export function isLoopEngineId(value: unknown): value is LoopEngineId {
  return (LOOP_ENGINE_IDS as readonly unknown[]).includes(value)
}

/**
 * The descriptor of one hosted engine.
 *
 * Total rather than partial by construction: the parameter is
 * {@link HostedEngineId}, so there is no unknown-id case to answer for. Callers
 * holding an untyped id narrow it with {@link isHostedEngine} first.
 * @param engine - the hosted engine to describe.
 * @returns that engine's descriptor.
 */
export function descriptorOf(engine: HostedEngineId): EngineDescriptor {
  return ENGINE_REGISTRY[engine]
}

/**
 * The copy key naming one engine in the browser half's dictionary.
 *
 * Derived from the table rather than declared, so the union of valid keys grows
 * with the registry: adding an engine makes its `localeKey` a required entry in
 * both dictionaries (`./client/locales.ts`), and a typo in a registry row is a
 * compile error rather than a blank label at runtime.
 */
export type EngineLocaleKey = (typeof ENGINE_REGISTRY)[HostedEngineId]['localeKey']

/**
 * The descriptor of one engine, or undefined for `in-process` and for anything
 * this build does not know.
 * @param engine - an engine id from any source.
 * @returns that engine's descriptor, or undefined when it is not hosted.
 */
export function descriptorOfOptional(engine: LoopEngineId | undefined): EngineDescriptor | undefined {
  return isHostedEngine(engine) ? ENGINE_REGISTRY[engine] : undefined
}

/**
 * The ACP protocol version to announce on behalf of one engine.
 *
 * The ONE reader of {@link EngineCapabilities.acpProtocolVersion}: every ACP
 * driver goes through here, so the fallback to
 * {@link DEFAULT_ACP_PROTOCOL_VERSION} is applied in one place and an engine that
 * declares a different version cannot be missed by a driver that forgot to ask.
 * @param engine - the hosted engine whose version is being announced.
 * @returns the declared version, or the default when the engine declares none.
 */
export function acpProtocolVersionOf(engine: HostedEngineId): number {
  // Widened to the base descriptor on purpose: the table is `as const`, so a
  // direct read would be typed against a UNION that only some rows satisfy, and
  // an engine that omits the optional field would be a type error rather than
  // the documented default.
  const descriptor: EngineDescriptor = ENGINE_REGISTRY[engine]
  return descriptor.capabilities.acpProtocolVersion ?? DEFAULT_ACP_PROTOCOL_VERSION
}

/**
 * The region one engine's child should run under, or undefined when the engine
 * declares no region.
 * @param engine - the hosted engine.
 * @param override - the deployment's own value from the descriptor's `configKey`.
 * @returns the region to use, the engine's default when the deployment pins none.
 * @throws when the deployment pins a value the engine's CLI does not accept —
 *   fail loud at resolve time rather than spelling an invalid region into the
 *   child's environment, where the CLI would silently fall back to its own.
 */
export function regionOf(engine: HostedEngineId, override?: string): string | undefined {
  const descriptor: EngineDescriptor = ENGINE_REGISTRY[engine]
  const region = descriptor.region
  if (region === undefined) return undefined
  if (override === undefined || override === '') return region.default
  if (!region.values.includes(override)) {
    throw new Error(
      `loop-engine: ${descriptor.label} has no region "${override}" — expected one of ${region.values.join(', ')}`,
    )
  }
  return override
}
