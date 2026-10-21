/**
 * MiniMax Code's BYOK handover: the config document the CLI reads, the protocol it
 * refuses, and the data directory that carries both.
 *
 * @module tests/engine-minimaxcode/model-handover
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import {
  MCODE_DATA_DIR_ENV,
  mcodeConfigDocument,
  mcodeDataDirFor,
  mcodeHandoverEnv,
} from '../../src/engine-minimaxcode/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'openai-completions',
  apiKey: 'sk-dsh-secret',
  contextWindow: 128000,
  maxOutputTokens: 8192,
}

describe('mcodeConfigDocument', () => {
  it('declares the endpoint as a BYOK custom provider and defaults to it', () => {
    const document = mcodeConfigDocument(HANDOVER, 'openai-completions')
    // The default MUST name the custom provider: a managed default makes
    // `session/new` resolve through the account and answer "Authentication
    // required", even with the custom entry configured.
    expect(document).toContain('defaultModel: "custom_provider:dsh/deepseek-flash"')
    expect(document).toContain('  dsh:')
    expect(document).toContain('    kind: custom')
    expect(document).toContain('    api: "openai-completions"')
    expect(document).toContain('      baseURL: "https://ai.example.com/litellm"')
    expect(document).toContain('      apiKey: "sk-dsh-secret"')
    expect(document).toContain('      "deepseek-flash":')
    // Declaring reasoning + a thinking default is what exposes `…:v:thinking`.
    expect(document).toContain('        reasoning: true')
    expect(document).toContain('          default_value: "true"')
  })

  it('carries the endpoint capacity, so the engine compacts at the right pressure', () => {
    const document = mcodeConfigDocument(HANDOVER, 'openai-completions')
    expect(document).toContain('          context: 128000')
    expect(document).toContain('          output: 8192')
  })

  it('omits the capacity block when the endpoint declares none, and caps output by default', () => {
    const bare = mcodeConfigDocument({ ...HANDOVER, contextWindow: undefined, maxOutputTokens: undefined }, 'openai-completions')
    expect(bare).not.toContain('limit:')
    const windowed = mcodeConfigDocument({ ...HANDOVER, maxOutputTokens: undefined }, 'openai-completions')
    expect(windowed).toContain('          context: 128000')
    expect(windowed).toContain('          output: 8192')
  })

  it('quotes a model id and a URL so YAML cannot read them as structure', () => {
    // A `#` or `: ` in user data would end the scalar and change the document.
    const document = mcodeConfigDocument(
      { ...HANDOVER, model: 'org/model:fast #1', baseURL: 'https://x.example.com/v1?a=b#c' },
      'openai-completions',
    )
    expect(document).toContain('      "org/model:fast #1":')
    expect(document).toContain('      baseURL: "https://x.example.com/v1?a=b#c"')
    expect(document).toContain('defaultModel: "custom_provider:dsh/org/model:fast #1"')
  })
})

describe('mcodeDataDirFor', () => {
  it('writes config.yaml 0600 inside a plugin-owned directory', () => {
    const dir = mcodeDataDirFor(HANDOVER, 'openai-completions')
    const file = `${dir}/config.yaml`
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('defaultModel:')
    // Windows does not model POSIX modes, so the mode is asserted where it exists.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reuses one directory per endpoint and a new one for a changed endpoint', () => {
    expect(mcodeDataDirFor(HANDOVER, 'openai-completions')).toBe(mcodeDataDirFor({ ...HANDOVER }, 'openai-completions'))
    expect(mcodeDataDirFor({ ...HANDOVER, apiKey: 'sk-other' }, 'openai-completions'))
      .not.toBe(mcodeDataDirFor(HANDOVER, 'openai-completions'))
    // The protocol is part of the identity: the same endpoint on two wires is two
    // different documents.
    expect(mcodeDataDirFor(HANDOVER, 'anthropic-messages'))
      .not.toBe(mcodeDataDirFor(HANDOVER, 'openai-completions'))
  })
})

describe('mcodeHandoverEnv', () => {
  it('hands the child its data directory, the only way `mcode acp` takes config', () => {
    const env = mcodeHandoverEnv(HANDOVER)
    expect(Object.keys(env)).toEqual([MCODE_DATA_DIR_ENV])
    expect(env[MCODE_DATA_DIR_ENV]).toBe(mcodeDataDirFor(HANDOVER, 'openai-completions'))
  })

  it('accepts all three protocols the CLI\'s custom providers declare', () => {
    for (const api of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
      expect(Object.keys(mcodeHandoverEnv({ ...HANDOVER, api }))).toEqual([MCODE_DATA_DIR_ENV])
    }
  })

  it('refuses a wire the engine cannot declare, before writing anything', () => {
    for (const api of ['openai-embeddings', undefined]) {
      try {
        mcodeHandoverEnv({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('MCODE_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
      }
    }
  })
})
