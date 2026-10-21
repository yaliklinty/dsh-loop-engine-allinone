/**
 * Hermes' environment-only handover: what the child receives and which wire it
 * refuses. The agent-level wiring (argv, refusal) is pinned in `agent.spec.ts`.
 *
 * @module tests/engine-hermes/model-handover
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import { hermesHandover, HERMES_HANDOVER_PROVIDER } from '../../src/engine-hermes/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'openai-completions',
  apiKey: 'sk-dsh-secret',
}

describe('hermesHandover', () => {
  it('hands the endpoint and the credential over through the environment', () => {
    const handover = hermesHandover(HANDOVER)
    // `$OPENAI_BASE_URL` outranks Hermes' own config for this child — measured in
    // `hermes_cli/models.py` and against a live endpoint — so nothing is written
    // to disk and the user's HERMES_HOME stays in force.
    expect(handover.env).toEqual({
      OPENAI_BASE_URL: 'https://ai.example.com/litellm',
      OPENAI_API_KEY: 'sk-dsh-secret',
    })
    // The argv must name the provider, or the user's own `custom:` table wins.
    expect(handover.provider).toBe(HERMES_HANDOVER_PROVIDER)
    expect(handover.model).toBe('deepseek-flash')
  })

  it('refuses a wire its OpenAI-compatible path cannot speak', () => {
    for (const api of ['anthropic-messages', 'openai-responses', undefined]) {
      try {
        hermesHandover({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('HERMES_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
      }
    }
  })
})
