/**
 * ZCode's dialect for a dsh endpoint: one provider-config document and two
 * environment variables, with the user's own `~/.zcode` left completely alone.
 *
 * ## What was measured (ZCode CLI 0.16.9, bundled in ZCode 3.14.4)
 *
 * The earlier probe concluded that ZCode selects its provider from the desktop
 * app's SQLite state and that a headless run therefore could not be pointed at a
 * custom endpoint. That conclusion was wrong, and the correction matters because
 * it is the difference between "unsupported" and "two env vars":
 *
 *   - `zcode -p` reads its provider table from the file named by
 *     `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` (default
 *     `~/.zcode/v2/provider_config.json`), NOT from `~/.zcode/v2/config.json`
 *     (the desktop app's own provider table) and not from the app's SQLite.
 *   - The model is chosen by that document's `config.defaultModelSelection`
 *     (`{ providerId, modelId }`), the value the app's own
 *     `NodeModelSelectionConfigRepository` reads and writes. `--model` is NOT a
 *     CLI option in 0.16.9 — it is rejected with `Unknown option '--model'`.
 *   - Both provider files must be named together: the CLI's
 *     `prepareCliProviderRuntimeEnv` short-circuits only when BOTH
 *     `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
 *     `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` are set, and otherwise tries to
 *     locate the built-in catalog itself (which fails outside the desktop app).
 *   - A personal provider entry is a custom provider: `providerId`,
 *     `providerName`, and a `config` carrying `group: "standard-personal"`,
 *     an `access` block (`type: "api-key"`, `apiKey`) and an `api` block
 *     (`type`, `baseUrl`). `personalModelIds`/`modelOrder` list its models.
 *
 * Measured end to end against a local mock: `zcode -p "…" --json` POSTed
 * `/v1/messages` (or `/chat/completions`) to the endpoint in the handed-over
 * document, with the handed-over key, and answered with the model's reply. The
 * request showed `Authorization: Bearer <key>` and `x-api-key: <key>`.
 *
 * ## Why the document is a temp file
 *
 * The CLI's only seam for a custom provider is a file path, so this handover
 * writes one document per step into a private temp directory, points the child's
 * environment at it, and removes the directory when the step ends. Nothing in
 * the user's `~/.zcode` is read as configuration or written to; the user's own
 * sessions, login and provider table stay in force for the step.
 *
 * The document necessarily carries the dsh-resolved credential (the CLI reads
 * keys from the file, not from an env var). That is the same exposure as the
 * existing engines' child environment, narrowed to a 0600 file in the OS temp
 * directory that lives for one step.
 *
 * @module dsh-loop-engine-allinone/engine-zcode/model-handover
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** The environment entry naming ZCode's personal provider document. */
export const ZCODE_PERSONAL_PROVIDER_CONFIG_ENV = 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'

/** The provider id this handover writes into the personal document. */
export const ZCODE_HANDOVER_PROVIDER_ID = 'dsh-handover'

/** The provider label shown by ZCode's own picker, should a user open it. */
export const ZCODE_HANDOVER_PROVIDER_NAME = 'DSH model handover'

/**
 * dsh wire protocol → ZCode's `api.type`.
 *
 * Both values were measured end to end (see the module comment). `openai-responses`
 * and an undeclared protocol are refused rather than guessed: a document naming a
 * wire the CLI does not implement would fail later, in the engine's words, with no
 * hint that the handover was the cause.
 */
const ZCODE_API_TYPES: Readonly<Record<string, string>> = {
  'anthropic-messages': 'anthropic-messages',
  'openai-completions': 'openai-chat-completions',
}

/** One personal provider document, in the shape ZCode's schema accepts. */
export interface ZcodePersonalProviderDocument {
  readonly schemaVersion: 1
  readonly config: {
    readonly providerOrder: readonly string[]
    readonly providerConfigRules: {
      readonly providerRules: readonly unknown[]
    }
    readonly modelConfigRules: {
      readonly providerModelRules: readonly unknown[]
      readonly manualProviderModelRules: readonly unknown[]
    }
    readonly defaultModelSelection: {
      readonly providerId: string
      readonly modelId: string
    }
  }
}

/**
 * Translate one dsh endpoint into ZCode's personal provider document.
 *
 * Pure, so the shape can be asserted without touching the filesystem.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the document to serialize into the child's provider file.
 * @throws LlmError with code `ZCODE_UNSUPPORTED_API` when the wire is not one ZCode speaks.
 */
export function zcodePersonalProviderDocument(handover: DshModelHandover): ZcodePersonalProviderDocument {
  const api = handover.api
  const type = api === undefined ? undefined : ZCODE_API_TYPES[api]
  if (type === undefined) {
    throw new LlmError(
      `ZCode's custom-provider path speaks anthropic-messages or openai-completions, but`
      + ` provider "${handover.provider}" declares the wire "${api ?? 'none'}". Pick a model`
      + ` from ZCode's own provider table, or switch this session's engine.`,
      'ZCODE_UNSUPPORTED_API',
    )
  }
  const model = handover.model
  const context = handover.contextWindow
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [ZCODE_HANDOVER_PROVIDER_ID],
      providerConfigRules: {
        providerRules: [{
          providerId: ZCODE_HANDOVER_PROVIDER_ID,
          providerName: ZCODE_HANDOVER_PROVIDER_NAME,
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: handover.apiKey },
            api: { type, baseUrl: handover.baseURL },
            personalModelIds: [model],
            modelOrder: [model],
          },
        }],
      },
      modelConfigRules: {
        // ZCode sizes its own compaction from this when it knows a window; the
        // handover carries one only when dsh can resolve it.
        providerModelRules: context === undefined
          ? []
          : [{ providerId: ZCODE_HANDOVER_PROVIDER_ID, modelId: model, config: { properties: { contextWindow: context } } }],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: ZCODE_HANDOVER_PROVIDER_ID, modelId: model },
    },
  }
}

/**
 * Serialize one dsh endpoint into the exact bytes of a personal provider file.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the file contents.
 * @throws LlmError with code `ZCODE_UNSUPPORTED_API` when the wire is not one ZCode speaks.
 */
export function zcodePersonalProviderConfig(handover: DshModelHandover): string {
  return `${JSON.stringify(zcodePersonalProviderDocument(handover), null, 2)}\n`
}

/**
 * Write a private, single-use personal provider file for one step.
 *
 * A fresh directory per step keeps concurrent sessions from sharing (or racing
 * on) one document, and makes cleanup one recursive remove.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @param parent - directory to create the step directory under; the OS temp dir by default.
 * @returns the absolute path of the written `provider_config.json`.
 * @throws LlmError with code `ZCODE_UNSUPPORTED_API` when the wire is not one ZCode speaks.
 */
export async function writeZcodePersonalProviderConfig(
  handover: DshModelHandover,
  parent: string = tmpdir(),
): Promise<string> {
  // Serialize first: an unsupported wire must fail before a directory exists.
  const contents = zcodePersonalProviderConfig(handover)
  const directory = await mkdtemp(join(parent, 'dsh-zcode-handover-'))
  const file = join(directory, 'provider_config.json')
  await writeFile(file, contents, { encoding: 'utf8', mode: 0o600 })
  return file
}

/**
 * Remove the step directory that holds one written personal provider file.
 *
 * Takes the FILE path because that is what the caller holds; the directory is
 * this module's own `mkdtemp` result, so removing it recursively cannot reach
 * anything the caller chose.
 * @param file - a path returned by {@link writeZcodePersonalProviderConfig}.
 */
export async function removeZcodePersonalProviderConfig(file: string): Promise<void> {
  await rm(dirname(file), { recursive: true, force: true })
}
