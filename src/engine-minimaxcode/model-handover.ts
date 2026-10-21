/**
 * MiniMax Code's dialect for a dsh endpoint: a plugin-owned data directory whose
 * `config.yaml` declares the endpoint as a BYOK `custom_provider`.
 *
 * Measured on `mcode` 0.6.12 (raw ACP frames in `tests/engine-minimaxcode/`), and
 * the reason each fact below is what it is:
 *
 *   - `mcode acp` has NO `--config` flag (only system-prompt switches), so its
 *     configuration can only be reached through `MINIMAX_DATA_DIR` — the same
 *     variable the CLI's own docs name (`$MINIMAX_DATA_DIR/config.yaml`).
 *   - a `custom_provider` entry needs `api` (`anthropic-messages`,
 *     `openai-completions`, `openai-responses` — measured from
 *     `mcode provider add --help`) plus `options.baseURL`/`options.apiKey`.
 *     There is NO env indirection: `apiKeyEnv` is accepted nowhere, which is why
 *     the key is written into the file, `0600`, in a `0700` directory this plugin
 *     owns and removes at exit.
 *   - `defaultModel` MUST name the custom provider. Measured: with a managed
 *     (`minimax/…`) default, `session/new` answers
 *     `Authentication required: Run mcode login` even when a custom provider is
 *     configured — the session resolves its default model through the account
 *     path. With `defaultModel: custom_provider:<id>/<model>` the same directory
 *     opens a session with NO account at all.
 *   - `thinking_config` with a `true` default is what makes the model appear as
 *     `…:v:thinking` in `session/new`. The M3.1 model has no non-thinking form,
 *     and an effort is only accepted for a thinking pick.
 *
 * The cost is the trade this plugin documents for every handover: the child does
 * not see the user's `~/.minimax` (sign-in, subscription, skills) while a dsh
 * model is in force. Switching the session back to one of the engine's own
 * models drops the handover, and the real home is used again.
 *
 * @module dsh-loop-engine-allinone/engine-minimaxcode/model-handover
 */

import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** Root under the OS temp dir holding one plugin-owned data directory per endpoint. */
const DATA_ROOT = join(tmpdir(), 'dsh-loop-engine-allinone-mcode')

/** Directories already materialized this process, so a per-step handover never re-writes one. */
const materialized = new Set<string>()

/**
 * Remove every data directory this process created, at exit.
 *
 * Synchronous on purpose: an `exit` handler cannot await, and a lingering copy of
 * a credential file is worth blocking the last few milliseconds for.
 */
/* v8 ignore start -- runs only at real process exit, which a test does not reach */
process.once('exit', () => {
  for (const dir of materialized) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A directory the OS already cleaned is not an error.
    }
  }
  materialized.clear()
})
/* v8 ignore stop */

/**
 * The wire protocols MiniMax Code's `custom_provider` can speak, as its own
 * `provider add --api-format` accepts them.
 */
const MCODE_APIS: ReadonlySet<string> = new Set([
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
])

/** The provider id this plugin's handover declares inside the generated config. */
export const MCODE_HANDOVER_PROVIDER = 'dsh'

/** Output cap written when the endpoint declares a window but no cap of its own. */
const MCODE_DEFAULT_OUTPUT = 8192

/** The environment variable `mcode acp` reads its data directory from. */
export const MCODE_DATA_DIR_ENV = 'MINIMAX_DATA_DIR'

/**
 * Render one YAML scalar as a double-quoted string.
 *
 * Hand-built because the plugin carries no YAML writer, and a model id or base URL
 * is user data: an unquoted `#`, `: `, or leading `{` would change the document's
 * meaning. A newline is refused rather than escaped — no legitimate endpoint fact
 * contains one, and a silently multi-line scalar would be a config injection.
 * @param value - the scalar to quote.
 * @returns the quoted scalar.
 */
function yamlString(value: string): string {
  /* v8 ignore start -- a newline in an endpoint fact is rejected at the edge, so this arm is defensive */
  if (/[\r\n]/.test(value)) throw new LlmError('a handover fact contains a newline', 'MCODE_HANDOVER_INVALID')
  /* v8 ignore stop */
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * The `config.yaml` one handover writes.
 *
 * Kept as a pure string builder so the document can be asserted without touching
 * a filesystem: the shape is the contract with the CLI, not an implementation
 * detail.
 * @param handover - the resolved dsh endpoint.
 * @param api - the endpoint's wire protocol, already validated.
 * @returns the YAML document.
 */
export function mcodeConfigDocument(handover: DshModelHandover, api: string): string {
  const lines = [
    'logLevel: info',
    // Load-bearing: a managed default would resolve through the account and fail
    // with `Authentication required`, even though the custom entry is configured.
    `defaultModel: ${yamlString(`custom_provider:${MCODE_HANDOVER_PROVIDER}/${handover.model}`)}`,
    'custom_provider:',
    `  ${MCODE_HANDOVER_PROVIDER}:`,
    '    name: DSH',
    '    kind: custom',
    '    enabled: true',
    `    api: ${yamlString(api)}`,
    '    options:',
    `      apiKey: ${yamlString(handover.apiKey)}`,
    `      baseURL: ${yamlString(handover.baseURL)}`,
    '      authMode: api-key',
    '    models:',
    `      ${yamlString(handover.model)}:`,
    '        name: DSH Model',
    // Declaring reasoning + a thinking default is what makes the model appear as
    // `…:v:thinking`, the only form an effort can be applied to.
    '        reasoning: true',
    '        thinking_config:',
    '          mode: switchable',
    '          default_value: "true"',
  ]
  if (handover.contextWindow !== undefined) {
    // The engine sizes its own compaction from this window; without it the model
    // falls back to the CLI's default and compacts at the wrong pressure.
    lines.push('        limit:', `          context: ${String(handover.contextWindow)}`)
    lines.push(`          output: ${String(handover.maxOutputTokens ?? MCODE_DEFAULT_OUTPUT)}`)
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * The plugin-owned data directory for one handover, materialized on first use.
 *
 * The directory name is a hash of the endpoint facts, so two sessions on the same
 * endpoint share one directory and a changed endpoint gets its own; the file
 * carries the credential, so it is written `0600` inside a `0700` directory.
 * @param handover - the resolved dsh endpoint.
 * @param api - the endpoint's wire protocol, already validated.
 * @returns the absolute path to hand the child as `MINIMAX_DATA_DIR`.
 */
export function mcodeDataDirFor(handover: DshModelHandover, api: string): string {
  const dir = join(
    DATA_ROOT,
    createHash('sha256')
      .update(JSON.stringify({
        provider: handover.provider,
        baseURL: handover.baseURL,
        api,
        apiKey: handover.apiKey,
        model: handover.model,
      }))
      .digest('hex')
      .slice(0, 32),
  )
  if (!materialized.has(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'config.yaml'), mcodeConfigDocument(handover, api), { mode: 0o600 })
    materialized.add(dir)
  }
  return dir
}

/**
 * Translate one dsh endpoint into MiniMax Code's environment.
 *
 * A protocol the engine's `custom_provider` cannot declare is refused here,
 * before a directory is written or a child spawned: the alternative is a session
 * that opens and then fails every turn against a wire the CLI never spoke.
 * @param handover - the resolved dsh endpoint.
 * @returns the environment entries for the child.
 * @throws LlmError with code `MCODE_UNSUPPORTED_API` when the wire is unsupported.
 */
export function mcodeHandoverEnv(handover: DshModelHandover): Record<string, string> {
  const api = handover.api
  if (api === undefined || !MCODE_APIS.has(api)) {
    throw new LlmError(
      `MiniMax Code custom providers speak anthropic-messages, openai-completions,`
      + ` or openai-responses, but provider "${handover.provider}" declares the wire`
      + ` "${api ?? 'none'}". Pick a model from MiniMax Code's own group, or switch`
      + ` this session's engine.`,
      'MCODE_UNSUPPORTED_API',
    )
  }
  return { [MCODE_DATA_DIR_ENV]: mcodeDataDirFor(handover, api) }
}
