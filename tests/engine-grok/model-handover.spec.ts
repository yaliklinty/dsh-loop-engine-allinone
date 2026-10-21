/**
 * Grok's environment-only handover: what the child receives, which protocol it
 * refuses, and the one directory it gets instead of the user's `~/.grok`.
 *
 * @module tests/engine-grok/model-handover
 */

import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import { grokHandoverEnv, grokHomeFor } from '../../src/engine-grok/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'openai-completions',
  apiKey: 'sk-dsh-secret',
}

describe('grokHandoverEnv', () => {
  it('points the child\'s catalogue, inference, credential, and model at the dsh endpoint', () => {
    const env = grokHandoverEnv(HANDOVER)
    expect(env.GROK_MODELS_BASE_URL).toBe(HANDOVER.baseURL)
    expect(env.XAI_API_KEY).toBe(HANDOVER.apiKey)
    expect(env.GROK_DEFAULT_MODEL).toBe(HANDOVER.model)
    // The helper calls follow the same model: left alone they would ask the dsh
    // endpoint for a built-in grok id it does not serve.
    expect(env.GROK_SESSION_SUMMARY_MODEL).toBe(HANDOVER.model)
    expect(env.GROK_IMAGE_DESCRIPTION_MODEL).toBe(HANDOVER.model)
    expect(env.GROK_PROMPT_SUGGESTIONS_MODEL).toBe(HANDOVER.model)
    // Web search is deliberately NOT redirected: it needs the Responses API.
    expect('GROK_WEB_SEARCH_MODEL' in env).toBe(false)
  })

  it('takes over GROK_HOME so the account session token can never ride along', () => {
    const env = grokHandoverEnv(HANDOVER)
    // Measured on 1.0.59: with the user's real home the child attaches the
    // account's `eyJ…` JWT to a helper request aimed at this endpoint.
    expect(env.GROK_HOME).not.toContain('.grok')
    expect(env.GROK_HOME).toBe(grokHomeFor(HANDOVER))
    expect(existsSync(env.GROK_HOME)).toBe(true)
  })

  it('reuses one home per endpoint, and a different one per endpoint', () => {
    expect(grokHomeFor(HANDOVER)).toBe(grokHomeFor({ ...HANDOVER }))
    expect(grokHomeFor({ ...HANDOVER, baseURL: 'https://other.example.com/v1' }))
      .not.toBe(grokHomeFor(HANDOVER))
  })

  it('refuses a wire grok cannot speak, naming the protocol and the engine', () => {
    // Grok's custom-endpoint path is OpenAI-compatible only; a wrong wire written
    // into its environment would read as an endpoint or auth failure later.
    for (const api of ['anthropic-messages', 'openai-responses', undefined]) {
      try {
        grokHandoverEnv({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('GROK_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
        expect(failure.message).toContain("grok's own group")
      }
    }
  })
})
