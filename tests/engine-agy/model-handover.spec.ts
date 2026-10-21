/**
 * Antigravity's gateway handover: what the child receives and which wire it
 * refuses. The driver-level wiring is pinned in `agent.spec.ts`.
 *
 * @module tests/engine-agy/model-handover
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import { AGY_HANDOVER_WIRE, agyHandoverEnv } from '../../src/engine-agy/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'openai-completions',
  apiKey: 'sk-dsh-secret',
}

describe('agyHandoverEnv', () => {
  it('points the CLI at the dsh gateway with the dsh credential', () => {
    // Measured: these three variables make `agy -p` fetch `{url}/models` and POST
    // `{url}/chat/completions` with the key as `Bearer`.
    expect(agyHandoverEnv(HANDOVER)).toEqual({
      AGY_LLM_GATEWAY_URL: 'https://ai.example.com/litellm',
      AGY_LLM_GATEWAY_API_KEY: 'sk-dsh-secret',
      AGY_LLM_GATEWAY_WIRE_PROTOCOL: AGY_HANDOVER_WIRE,
    })
    expect(AGY_HANDOVER_WIRE).toBe('openai')
  })

  it('refuses a wire its gateway cannot speak', () => {
    for (const api of ['anthropic-messages', 'openai-responses', undefined]) {
      try {
        agyHandoverEnv({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('AGY_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
      }
    }
  })
})
