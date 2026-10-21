/**
 * Qoder CN's config-root handover: the plaintext provider table, the model key,
 * and the private root's copy-and-remove lifecycle.
 *
 * The measured facts these assertions encode are in
 * `src/engine-qoderclicn/model-handover.ts`: `--config-dir` selects a private
 * root, a plaintext `providers` entry points at the dsh endpoint, and
 * `-m <provider>/<model>` selects it. The agent-level wiring is pinned in
 * `agent.spec.ts`.
 *
 * @module tests/engine-qoderclicn/model-handover
 */

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'
import {
  QODERCLICN_HANDOVER_PROVIDER_ID,
  prepareQoderclicnHandover,
  qoderclicnConfigRoot,
  qoderclicnHandoverSettings,
  qoderclicnModelKey,
  removeQoderclicnHandover,
} from '../../src/engine-qoderclicn/model-handover.ts'

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'anthropic-messages',
  apiKey: 'sk-dsh-secret',
  contextWindow: 128_000,
}

/** Scratch roots created by the tests, removed afterwards. */
const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** A fake signed-in config root. */
function signedInRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
  mkdirSync(join(root, '.auth'))
  writeFileSync(join(root, '.auth', 'user.json'), '{"uid":"user-1"}')
  writeFileSync(join(root, 'installation_id'), 'install-1')
  scratch.push(root)
  return root
}

describe('qoderclicnConfigRoot', () => {
  it('prefers the CLI’s own config-dir override', () => {
    expect(qoderclicnConfigRoot({ QODER_CONFIG_DIR: '/cfg', QODER_HOME: '/home' })).toBe('/cfg')
  })

  it('falls back to QODER_HOME, and treats a blank override as absent', () => {
    expect(qoderclicnConfigRoot({ QODER_CONFIG_DIR: '  ', QODER_HOME: '/home' })).toBe('/home')
  })

  it('defaults to ~/.qoder-cn', () => {
    expect(qoderclicnConfigRoot({})).toBe(join(homedir(), '.qoder-cn'))
  })
})

describe('qoderclicnHandoverSettings', () => {
  it('writes one plaintext custom provider with the endpoint, key and model', () => {
    const settings = qoderclicnHandoverSettings(HANDOVER)
    expect(settings.providers[QODERCLICN_HANDOVER_PROVIDER_ID]).toMatchObject({
      protocol: 'anthropic',
      baseUrl: 'https://ai.example.com/litellm',
      apiKey: 'sk-dsh-secret',
      model: 'deepseek-flash',
    })
    expect(settings.providers[QODERCLICN_HANDOVER_PROVIDER_ID]!.models).toEqual([{
      model: 'deepseek-flash',
      contextWindow: 128_000,
      capabilities: { tools: true },
    }])
    // No context window is a normal answer, not an empty field.
    expect(qoderclicnHandoverSettings({ ...HANDOVER, contextWindow: undefined })
      .providers[QODERCLICN_HANDOVER_PROVIDER_ID]!.models).toEqual([{
      model: 'deepseek-flash',
      capabilities: { tools: true },
    }])
  })

  it('translates openai-completions to the CLI’s openai protocol', () => {
    const settings = qoderclicnHandoverSettings({ ...HANDOVER, api: 'openai-completions' })
    expect(settings.providers[QODERCLICN_HANDOVER_PROVIDER_ID]!.protocol).toBe('openai')
  })

  it('refuses a wire its custom-provider path does not implement', () => {
    for (const api of ['openai-responses', undefined]) {
      try {
        qoderclicnHandoverSettings({ ...HANDOVER, api })
        throw new Error('expected a refusal')
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(LlmError)
        const failure = (error as LlmError).failure
        expect(failure.code).toBe('QODERCLICN_UNSUPPORTED_API')
        expect(failure.message).toContain('"meicloud"')
        expect(failure.message).toContain(api ?? 'none')
      }
    }
  })
})

describe('qoderclicnModelKey', () => {
  it('names the provider and the model, slashes in the model included', () => {
    // Qoder splits on the first slash (measured with a namespaced model id).
    expect(qoderclicnModelKey('deepseek-flash')).toBe('dsh-handover/deepseek-flash')
    expect(qoderclicnModelKey('deepseek-ai/DeepSeek-V3')).toBe('dsh-handover/deepseek-ai/DeepSeek-V3')
  })
})

describe('the private config root', () => {
  it('copies the login state, writes the settings file, and removes the root', async () => {
    const source = signedInRoot()
    const handover = await prepareQoderclicnHandover(HANDOVER, source)
    scratch.push(handover.configDir)

    expect(handover.modelKey).toBe('dsh-handover/deepseek-flash')
    expect(existsSync(join(handover.configDir, '.auth', 'user.json'))).toBe(true)
    expect(existsSync(join(handover.configDir, 'installation_id'))).toBe(true)
    expect(JSON.parse(await readFile(join(handover.configDir, 'settings.json'), 'utf8')))
      .toEqual(qoderclicnHandoverSettings(HANDOVER))

    await removeQoderclicnHandover(handover.configDir)
    expect(existsSync(handover.configDir)).toBe(false)
  })

  it('does not require an installation id', async () => {
    // Some installs never write one; the copy is optional by design.
    const source = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
    mkdirSync(join(source, '.auth'))
    writeFileSync(join(source, '.auth', 'user.json'), '{"uid":"user-1"}')
    scratch.push(source)
    const handover = await prepareQoderclicnHandover(HANDOVER, source)
    scratch.push(handover.configDir)
    expect(existsSync(join(handover.configDir, 'installation_id'))).toBe(false)
    expect(existsSync(join(handover.configDir, '.auth', 'user.json'))).toBe(true)
  })

  it('refuses with the login command when `.auth` is missing', async () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
    scratch.push(source)
    await expect(prepareQoderclicnHandover(HANDOVER, source)).rejects.toMatchObject({
      failure: { code: 'QODERCLICN_NOT_LOGGED_IN' },
    })
    expect(await readdir(source)).toEqual([])
  })

  it('refuses an unsupported wire before creating a directory', async () => {
    const source = signedInRoot()
    await expect(prepareQoderclicnHandover({ ...HANDOVER, api: 'openai-responses' }, source))
      .rejects.toBeInstanceOf(LlmError)
    expect((await readdir(source)).filter(entry => entry.startsWith('dsh-qoder-handover-'))).toEqual([])
  })
})
