/**
 * Hermes Agent's dialect for a dsh endpoint: two environment variables and one
 * argv pair, with the user's own `HERMES_HOME` left completely alone.
 *
 * Measured on Hermes Agent 0.21.4 (2026.9.21), and the reason each piece is what
 * it is:
 *
 *   - `hermes` resolves an OpenAI-compatible endpoint for its built-in `openai`
 *     provider as `$OPENAI_BASE_URL` → config `model.base_url` → the canonical
 *     default (`hermes_cli/models.py` `_openai_discovery_base_url`). The env
 *     variable therefore WINS over anything configured, which is what makes a
 *     per-child handover possible without writing a file.
 *   - `--provider openai` is not optional. Hermes' own `custom:` provider table
 *     is what `--provider custom` selects, and that table carries the user's own
 *     `base_url` — measured: `--provider custom` ignored `OPENAI_BASE_URL` and
 *     dialled the configured vendor instead.
 *   - `-m <model>` names the model within that provider. Measured end to end
 *     against a local endpoint: the child POSTed `/v1/chat/completions` with
 *     `Authorization: Bearer <the env key>` and streamed the answer back.
 *
 * Both variables ride the CHILD environment, so nothing is written to disk and
 * the user's sessions, skills and `auth.json` stay in force for that session —
 * the one handover here that does not trade the engine's home away.
 *
 * @module dsh-loop-engine-allinone/engine-hermes/model-handover
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** The provider id whose endpoint `$OPENAI_BASE_URL` overrides. */
export const HERMES_HANDOVER_PROVIDER = 'openai'

/**
 * The wire protocols Hermes' OpenAI-compatible path speaks.
 *
 * `openai-completions` is the one measured; an endpoint that declares a different
 * wire is refused rather than written into an environment Hermes would then dial
 * with the wrong shape.
 */
const HERMES_APIS: ReadonlySet<string> = new Set(['openai-completions'])

/** What one handover contributes to a Hermes step. */
export interface HermesHandover {
  /** Environment entries for the child (the endpoint and the credential). */
  readonly env: Record<string, string>
  /** The provider id the argv must name. */
  readonly provider: string
  /** The model id the argv must name. */
  readonly model: string
}

/**
 * Translate one dsh endpoint into Hermes' environment and argv facts.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the env entries plus the provider/model the argv must carry.
 * @throws LlmError with code `HERMES_UNSUPPORTED_API` when the wire is not Hermes'.
 */
export function hermesHandover(handover: DshModelHandover): HermesHandover {
  const api = handover.api
  if (api === undefined || !HERMES_APIS.has(api)) {
    throw new LlmError(
      `Hermes Agent's OpenAI-compatible path speaks openai-completions, but provider`
      + ` "${handover.provider}" declares the wire "${api ?? 'none'}". Pick a model from`
      + ` Hermes' own configuration, or switch this session's engine.`,
      'HERMES_UNSUPPORTED_API',
    )
  }
  return {
    // The endpoint wins over Hermes' own config for this child only, and the key
    // is the one dsh resolved — never the user's stored provider keys.
    env: { OPENAI_BASE_URL: handover.baseURL, OPENAI_API_KEY: handover.apiKey },
    provider: HERMES_HANDOVER_PROVIDER,
    model: handover.model,
  }
}
