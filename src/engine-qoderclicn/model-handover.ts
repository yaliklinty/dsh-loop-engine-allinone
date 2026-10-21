/**
 * Qoder CN's dialect for a dsh endpoint: a private `--config-dir` root carrying a
 * plaintext `providers` entry, plus a `<provider>/<model>` model key.
 *
 * ## What was measured (qoderclicn 1.1.56)
 *
 * The earlier probe concluded that Qoder CN was blocked because custom endpoints
 * live in an encrypted store (`.models/<uid>/customs`) and the gateway is fixed.
 * The encrypted store is real — it is Qoder's server-side BYOK cache, decrypted
 * with the machine id — but it is NOT the only way in. The CLI's own settings
 * schema has a plaintext `providers` table for local custom providers:
 *
 * ```
 * providers.<id> = {
 *   protocol: "openai" | "openai-responses" | "anthropic",
 *   baseUrl, apiKey, model,
 *   models: [{ model, contextWindow?, maxOutputTokens?, capabilities: { tools } }]
 * }
 * ```
 *
 * With `--config-dir <temp>` and that table written to `<temp>/settings.json`,
 * `-m <providerId>/<modelId> -p "…"` posted a full OpenAI or Anthropic request to
 * a local mock, with the caller's key, and returned the mock's answer. Nothing
 * under the user's `~/.qoder-cn` was modified.
 *
 * ## The two preconditions this handover cannot remove
 *
 * 1. **A signed-in Qoder CN account.** `-p` runs in the CLI's "local" provider
 *    access mode, which requires `isAuthenticated()`. The private root therefore
 *    starts as a COPY of the user's `.auth` directory — the login state is read,
 *    never moved or written.
 * 2. **The startup entitlement check must reach Qoder's own API.** Before custom
 *    providers are allowed, the CLI calls `GET /api/v3/user/status` on
 *    `openapi.qoder.com.cn` and requires `featureSwitches.allow_byok >= 2`.
 *    Offline, that check returns null, custom providers are refused, and the turn
 *    fails in the CLI's words. A handover is therefore not a way to run Qoder
 *    offline.
 *
 * ## Why a copied config root, not the user's
 *
 * `--config-dir` makes the root per-invocation. The copy carries `.auth` (and
 * `installation_id`, when present) so the CLI can authenticate, and the provider
 * table so the request goes where dsh says. The directory is created with
 * `mkdtemp`, the key-bearing `settings.json` is written `0600`, and the whole
 * root is removed when the step ends. The user's own settings, plugins, sessions
 * and encrypted model cache are untouched.
 *
 * @module dsh-loop-engine-allinone/engine-qoderclicn/model-handover
 */

import { existsSync } from 'node:fs'
import { copyFile, cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** The provider id this handover writes into the private settings file. */
export const QODERCLICN_HANDOVER_PROVIDER_ID = 'dsh-handover'

/**
 * dsh wire protocol → Qoder's `providers.<id>.protocol`.
 *
 * `openai` and `anthropic` were both measured end to end. `openai-responses`
 * exists in the CLI's schema but was NOT measured by this fork, so it is refused
 * rather than guessed — a wrong wire is a silently broken request.
 */
const QODERCLICN_PROTOCOLS: Readonly<Record<string, string>> = {
  'openai-completions': 'openai',
  'anthropic-messages': 'anthropic',
}

/**
 * The config root holding the user's login state.
 *
 * `QODER_CONFIG_DIR` is the CLI's own root override; `QODER_HOME` is what the
 * driver already honours for the install location. Both are accepted so a
 * deployment that relocated either still hands over the right login.
 * @param env - the environment to read.
 * @returns the root whose `.auth` is copied into the private step root.
 */
export function qoderclicnConfigRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.QODER_CONFIG_DIR?.trim()
  if (configured !== undefined && configured !== '') return configured
  const home = env.QODER_HOME?.trim()
  if (home !== undefined && home !== '') return home
  return join(homedir(), '.qoder-cn')
}

/** One provider entry, in the shape Qoder's settings schema accepts. */
export interface QoderclicnProviderEntry {
  readonly protocol: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly models: readonly unknown[]
}

/** The settings document a private Qoder root carries. */
export interface QoderclicnHandoverSettings {
  readonly providers: Readonly<Record<string, QoderclicnProviderEntry>>
}

/**
 * Translate one dsh endpoint into Qoder's plaintext custom-provider settings.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the settings document.
 * @throws LlmError with code `QODERCLICN_UNSUPPORTED_API` when the wire is not one Qoder speaks.
 */
export function qoderclicnHandoverSettings(handover: DshModelHandover): QoderclicnHandoverSettings {
  const api = handover.api
  const protocol = api === undefined ? undefined : QODERCLICN_PROTOCOLS[api]
  if (protocol === undefined) {
    throw new LlmError(
      `Qoder CN's custom-provider path speaks openai-completions or anthropic-messages, but`
      + ` provider "${handover.provider}" declares the wire "${api ?? 'none'}". Pick a model`
      + ` from Qoder's own catalog, or switch this session's engine.`,
      'QODERCLICN_UNSUPPORTED_API',
    )
  }
  return {
    providers: {
      [QODERCLICN_HANDOVER_PROVIDER_ID]: {
        protocol,
        baseUrl: handover.baseURL,
        apiKey: handover.apiKey,
        model: handover.model,
        // The model entry is what the CLI advertises to its own router; without
        // it the model key resolves to a provider but not to a model.
        models: [{
          model: handover.model,
          ...handover.contextWindow === undefined ? {} : { contextWindow: handover.contextWindow },
          capabilities: { tools: true },
        }],
      },
    },
  }
}

/**
 * The `-m` value naming the handover's provider and model.
 *
 * Qoder's selector is `<providerId>/<modelId>`; a model id may itself contain
 * slashes, and the CLI splits on the first one (measured with
 * `deepseek-ai/DeepSeek-V3`).
 * @param model - the dsh model id.
 * @returns the selector key.
 */
export function qoderclicnModelKey(model: string): string {
  return `${QODERCLICN_HANDOVER_PROVIDER_ID}/${model}`
}

/** The private root one step runs in, and the model key that names its provider. */
export interface QoderclicnHandover {
  /** `--config-dir` for this step. */
  readonly configDir: string
  /** `-m` value for this step. */
  readonly modelKey: string
}

/**
 * Create the private config root for one step.
 *
 * The root is a copy of the user's login state plus the handover's provider
 * table. A missing `.auth` is refused with a clear login message rather than
 * letting the child fail with its own generic one.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @param sourceRoot - the user's config root; the environment's by default.
 * @returns the private root and the model key to pass on argv.
 * @throws LlmError with code `QODERCLICN_UNSUPPORTED_API` or `QODERCLICN_NOT_LOGGED_IN`.
 */
export async function prepareQoderclicnHandover(
  handover: DshModelHandover,
  sourceRoot: string = qoderclicnConfigRoot(),
): Promise<QoderclicnHandover> {
  // Serialize first: an unsupported wire must fail before a directory exists.
  const settings = qoderclicnHandoverSettings(handover)
  const auth = join(sourceRoot, '.auth')
  if (!existsSync(auth)) {
    throw new LlmError(
      `Qoder CN's handover needs a signed-in account, but ${auth} does not exist.`
      + ` Run \`qoderclicn login\` once, or switch this session's engine.`,
      'QODERCLICN_NOT_LOGGED_IN',
    )
  }
  const configDir = await mkdtemp(join(tmpdir(), 'dsh-qoder-handover-'))
  try {
    await cp(auth, join(configDir, '.auth'), { recursive: true })
    // Optional: the CLI's installer identity. Its absence is normal on some
    // installs, and the probe ran with it copied; copy it when it is there.
    const installation = join(sourceRoot, 'installation_id')
    if (existsSync(installation)) await copyFile(installation, join(configDir, 'installation_id'))
    await writeFile(join(configDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
  } catch (error) {
    await rm(configDir, { recursive: true, force: true })
    throw error
  }
  return { configDir, modelKey: qoderclicnModelKey(handover.model) }
}

/**
 * Remove the private config root created by {@link prepareQoderclicnHandover}.
 * @param configDir - the directory that call returned.
 */
export async function removeQoderclicnHandover(configDir: string): Promise<void> {
  await rm(configDir, { recursive: true, force: true })
}
