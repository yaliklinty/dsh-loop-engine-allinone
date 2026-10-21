/**
 * Antigravity's dialect for a dsh endpoint: three environment variables, all read
 * by the CLI's own LLM-gateway layer.
 *
 * Measured on `agy` (Antigravity CLI), and the reason each variable is what it is:
 *
 *   - `AGY_LLM_GATEWAY_URL` replaces the inference base URL. The binary parses it
 *     as a URL (`"%s is malformed"` beside the read) and points its OpenAI-shaped
 *     chat traffic at it.
 *   - `AGY_LLM_GATEWAY_API_KEY` is the credential for that gateway; the CLI sends
 *     it as `Authorization: Bearer …`.
 *   - `AGY_LLM_GATEWAY_WIRE_PROTOCOL` names the wire. `openai` is the value that
 *     was measured end to end; a dsh provider that declares a different protocol is
 *     refused here rather than written into an environment the CLI would dial with
 *     the wrong shape.
 *
 * Measured end to end against a local endpoint: `agy -p "…" --model <model>` with
 * these three variables fetched `GET /v1/models`, then `POST
 * /v1/chat/completions` with the env key, and printed the answer that endpoint
 * returned. Nothing is written to disk, and the CLI's own sign-in stays untouched.
 *
 * @module dsh-loop-engine-allinone/engine-agy/model-handover
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../driver-core/model-handover.ts'

/** The wire-protocol value the CLI accepts for an OpenAI-compatible gateway. */
export const AGY_HANDOVER_WIRE = 'openai'

/** Wire protocols this handover can declare, by dsh's spelling. */
const AGY_APIS: ReadonlySet<string> = new Set(['openai-completions'])

/**
 * Translate one dsh endpoint into Antigravity's gateway environment.
 * @param handover - the resolved dsh endpoint for the session's selection.
 * @returns the environment entries for the child.
 * @throws LlmError with code `AGY_UNSUPPORTED_API` when the wire is not OpenAI-compatible.
 */
export function agyHandoverEnv(handover: DshModelHandover): Record<string, string> {
  const api = handover.api
  if (api === undefined || !AGY_APIS.has(api)) {
    throw new LlmError(
      `Antigravity's LLM gateway speaks openai-completions, but provider`
      + ` "${handover.provider}" declares the wire "${api ?? 'none'}". Pick a model from`
      + ` Antigravity's own group, or switch this session's engine.`,
      'AGY_UNSUPPORTED_API',
    )
  }
  return {
    AGY_LLM_GATEWAY_URL: handover.baseURL,
    AGY_LLM_GATEWAY_API_KEY: handover.apiKey,
    AGY_LLM_GATEWAY_WIRE_PROTOCOL: AGY_HANDOVER_WIRE,
  }
}
