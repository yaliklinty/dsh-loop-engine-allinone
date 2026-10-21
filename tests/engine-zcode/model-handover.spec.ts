/**
 * ZCode's file-based handover: the provider document it writes, the wire names it
 * translates, and the single-use lifecycle of the file.
 *
 * The measured facts these assertions encode are recorded in
 * `src/engine-zcode/model-handover.ts`: `-p` reads the document named by
 * `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`, and `config.defaultModelSelection`
 * chooses the model. The agent-level wiring (both env vars, cleanup after the
 * step) is pinned in `agent.spec.ts`.
 *
 * @module tests/engine-zcode/model-handover
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import {
  ZCODE_HANDOVER_PROVIDER_ID,
  removeZcodePersonalProviderConfig,
  writeZcodePersonalProviderConfig,
  zcodePersonalProviderConfig,
  zcodePersonalProviderDocument,
} from '../../src/engine-zcode/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'anthropic-messages',
  apiKey: 'sk-dsh-secret',
  contextWindow: 128_000,
}

/** Scratch parents created by the lifecycle tests, removed afterwards. */
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('zcodePersonalProviderDocument', () => {
  it('writes one custom provider, the key, and the default selection', () => {
    const document = zcodePersonalProviderDocument(HANDOVER)
    const rule = document.config.providerConfigRules.providerRules[0] as {
      providerId: string
      providerName: string
      config: Record<string, unknown>
    }
    expect(rule.providerId).toBe(ZCODE_HANDOVER_PROVIDER_ID)
    // `standard-personal` is the group ZCode's own custom providers use; a
    // different group makes the entry visible to the app but not selectable here.
    expect(rule.config).toMatchObject({
      group: 'standard-personal',
      access: { type: 'api-key', apiKey: 'sk-dsh-secret' },
      api: { type: 'anthropic-messages', baseUrl: 'https://ai.example.com/litellm' },
      personalModelIds: ['deepseek-flash'],
      modelOrder: ['deepseek-flash'],
    })
    expect(document.config.providerOrder).toEqual([ZCODE_HANDOVER_PROVIDER_ID])
    expect(document.config.defaultModelSelection).toEqual({
      providerId: ZCODE_HANDOVER_PROVIDER_ID,
      modelId: 'deepseek-flash',
    })
  })

  it('carries the context window when dsh resolves one', () => {
    const document = zcodePersonalProviderDocument(HANDOVER)
    expect(document.config.modelConfigRules.providerModelRules).toEqual([{
      providerId: ZCODE_HANDOVER_PROVIDER_ID,
      modelId: 'deepseek-flash',
      config: { properties: { contextWindow: 128_000 } },
    }])
    // No window is a normal answer, not an empty rule.
    expect(zcodePersonalProviderDocument({ ...HANDOVER, contextWindow: undefined })
      .config.modelConfigRules.providerModelRules).toEqual([])
  })

  it('translates dsh wires into the two types the CLI implements', () => {
    const openai = zcodePersonalProviderDocument({ ...HANDOVER, api: 'openai-completions' })
    const rule = openai.config.providerConfigRules.providerRules[0] as { config: { api: { type: string } } }
    expect(rule.config.api.type).toBe('openai-chat-completions')
  })

  it('refuses a wire its custom-provider path does not implement', () => {
    for (const api of ['openai-responses', undefined]) {
      try {
        zcodePersonalProviderDocument({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('ZCODE_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
      }
    }
  })

  it('serializes to a plain JSON document with a trailing newline', () => {
    const text = zcodePersonalProviderConfig(HANDOVER)
    expect(text.endsWith('\n')).toBe(true)
    expect(JSON.parse(text)).toEqual(zcodePersonalProviderDocument(HANDOVER))
  })
})

describe('the single-use provider file', () => {
  it('is written under a fresh directory and removed with it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-zcode-handover-test-'))
    scratch.push(parent)
    const file = await writeZcodePersonalProviderConfig(HANDOVER, parent)
    expect(file.endsWith(join('provider_config.json'))).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(zcodePersonalProviderDocument(HANDOVER))

    await removeZcodePersonalProviderConfig(file)
    expect(existsSync(file)).toBe(false)
    expect(existsSync(dirname(file))).toBe(false)
  })

  it('refuses an unsupported wire before creating a directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'dsh-zcode-handover-test-'))
    scratch.push(parent)
    await expect(writeZcodePersonalProviderConfig({ ...HANDOVER, api: 'openai-responses' }, parent))
      .rejects.toBeInstanceOf(LlmError)
    // The parent is untouched: nothing named `dsh-zcode-handover-*` appeared.
    const entries = await readdir(parent)
    expect(entries.filter(entry => entry.startsWith('dsh-zcode-handover-'))).toEqual([])
  })
})
