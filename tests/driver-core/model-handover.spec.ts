/**
 * Unit tests for the shared dsh-endpoint resolver: the provider → settings
 * address mapping read from the llm registry's directory, the defensive profile
 * read, the credential resolution (seam first, ambient environment as the
 * fallback), and the warn-once refusal path. These tests drive the seams a real
 * composition provides — the fake `llm`/`settings`/`credentials` objects stand
 * in for `ctx.llm`, `ctx.settings`, and `ctx.credentials`.
 *
 * @module tests/driver-core/model-handover
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SettingsForms from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { resolveModelHandover } from '../../src/driver-core/model-handover.ts'
import type { SessionModelOverride } from '../../src/driver-core/session-model.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

/** One registry entry mapping a provider route to a settings address. */
function address(provider: string, settingsNs: string, settingsPath: readonly string[] = ['providers', provider]) {
  return { provider, settingsNs, settingsPath }
}

/** A provider profile as `llm-pi-ai` stores it. */
function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiKeyEnv: 'MEICLOUD_API_KEY',
    api: 'anthropic-messages',
    baseURL: 'https://ai.example.com/litellm',
    ...overrides,
  }
}

/** Mount the seams a full composition provides. */
function mount(options: {
  providers?: readonly ReturnType<typeof address>[]
  section?: unknown
  /** Namespace the fake settings service answers for (defaults to `llm-pi-ai`). */
  settingsNs?: string
  /** `null` composes no settings service at all. */
  settings?: unknown
  credentials?: unknown
  directory?: unknown
} = {}): Context {
  const ctx = new Context()
  ctx.provide('llm', options.directory ?? { listConfigurableProviders: () => options.providers ?? [] })
  if (options.settings !== null) {
    ctx.provide('settings', options.settings ?? {
      // The real service's read: one descriptor per registered namespace, each
      // carrying that namespace's resolved value. The fake answers for ONE
      // namespace, which is all a resolver test needs.
      describe: () => [{
        ns: options.settingsNs ?? 'llm-pi-ai',
        value: options.section,
      }],
    })
  }
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  return ctx
}

const OVERRIDE: SessionModelOverride = { provider: 'meicloud', model: 'deepseek-flash' }

/**
 * Mount the REAL profile-backed settings service (`@deepseek-ai/dsh-settings`)
 * around one `llm-pi-ai` entry, so the read path is exercised against the host's
 * own descriptor projection rather than a hand-shaped object.
 *
 * This is the regression guard for a resolver that read `settings.get(ns)` — a
 * method the profile-backed service never had. Every fake in this file agreed
 * with that call, so the unit suite was green while a real deployment resolved
 * nothing and refused every real dsh model on every hosted engine.
 * @returns a context whose `ctx.settings` is the host's own implementation.
 */
async function mountWithRealSettings(): Promise<Context> {
  const schema = z.object({
    providers: z.dict(z.object({
      baseURL: z.string(),
      api: z.string(),
      apiKeyEnv: z.string(),
    })).default({}).volatile(),
  })
  const entry = {
    id: 'llm-pi-ai',
    options: { id: 'llm-pi-ai', config: {} },
    fiber: {
      uid: 'u-real-settings',
      state: 2,
      runtime: { Config: schema },
      config: {
        providers: {
          meicloud: {
            baseURL: 'https://ai.example.com/litellm',
            api: 'anthropic-messages',
            apiKeyEnv: 'MEICLOUD_API_KEY',
          },
        },
      },
      ctx: {},
    },
  }
  const ctx = new Context()
  ctx.provide('configEditor', {
    documentPath: '/tmp/dsh-real-settings-document.yml',
    configuration: () => [{ entry, inherited: {}, override: {} }],
    entries: () => [entry],
  } as never)
  ctx.provide('profileContext', { home: '/tmp/dsh-real-settings-home', name: 'test' } as never)
  // The service's constructor awaits the Loader before importing the legacy
  // settings document; a bare test Context has no Loader, so stub that one call.
  Object.defineProperty(ctx.root, 'loader', {
    value: { await: () => Promise.resolve() },
    configurable: true,
  })
  await ctx.plugin(SettingsForms)
  ctx.provide('llm', {
    listConfigurableProviders: () => [address('meicloud', 'llm-pi-ai')],
  } as never)
  ctx.provide('credentials', { resolve: () => Promise.resolve({ value: 'sk-secret' }) } as never)
  vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  return ctx
}

describe('resolveModelHandover', () => {
  it('injects nothing when the session selected no real dsh model', async () => {
    const ctx = mount()
    await expect(resolveModelHandover(ctx, undefined)).resolves.toBeUndefined()
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('reads the endpoint through the host\'s real SettingsForms service', async () => {
    const ctx = await mountWithRealSettings()
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toEqual({
      provider: 'meicloud',
      model: 'deepseek-flash',
      baseURL: 'https://ai.example.com/litellm',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
    })
  })

  it('resolves endpoint, protocol, and credential through the host seams', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile() } },
      credentials: { resolve: (ref: string) => Promise.resolve(ref === 'MEICLOUD_API_KEY' ? { value: 'sk-secret' } : undefined) },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toEqual({
      provider: 'meicloud',
      model: 'deepseek-flash',
      baseURL: 'https://ai.example.com/litellm',
      api: 'anthropic-messages',
      apiKey: 'sk-secret',
    })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('reads a section that IS the profile when the registry path is empty', async () => {
    const ctx = mount({
      providers: [address('deepseek-official', 'llm-deepseek', [])],
      settingsNs: 'llm-deepseek',
      section: profile({ provider: 'deepseek-official' }),
      credentials: { resolve: () => Promise.resolve({ value: 'sk-official' }) },
    })
    await expect(resolveModelHandover(ctx, { provider: 'deepseek-official', model: 'deepseek-chat' }))
      .resolves.toMatchObject({ apiKey: 'sk-official' })
  })

  it('falls back to the ambient environment when the credentials seam is not composed', async () => {
    process.env.DSH_LOOP_ENGINE_TEST_KEY = 'from-env'
    try {
      const ctx = mount({
        providers: [address('meicloud', 'llm-pi-ai')],
        section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_TEST_KEY' }) } },
      })
      await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toMatchObject({ apiKey: 'from-env' })
    } finally {
      delete process.env.DSH_LOOP_ENGINE_TEST_KEY
    }
  })

  it('falls back to the ambient environment when the seam answers an empty value', async () => {
    process.env.DSH_LOOP_ENGINE_TEST_KEY = 'from-env'
    try {
      const ctx = mount({
        providers: [address('meicloud', 'llm-pi-ai')],
        section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_TEST_KEY' }) } },
        credentials: { resolve: () => Promise.resolve({ value: '' }) },
      })
      await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toMatchObject({ apiKey: 'from-env' })
    } finally {
      delete process.env.DSH_LOOP_ENGINE_TEST_KEY
    }
  })

  it('injects nothing, and warns once, when no registry route maps the provider', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')] })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
    expect(String((ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]))
      .toContain('meicloud/deepseek-flash')
  })

  it('injects nothing when the llm registry is absent', async () => {
    const ctx = new Context()
    vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the registry exposes no configurable-provider directory', async () => {
    const ctx = mount({ directory: {} })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the settings service is absent', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')], settings: null })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the settings service exposes no read', async () => {
    const ctx = mount({ providers: [address('meicloud', 'llm-pi-ai')], settings: {} })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('resolves through describe() when the settings service lists no such namespace', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      settings: { describe: () => [{ ns: 'another-entry', value: { providers: { meicloud: profile() } } }] },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('contains a describe() that throws instead of failing the step', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      settings: { describe: () => { throw new Error('profile still importing') } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('falls back to a legacy get(ns) read when describe() is absent', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      settings: {
        get: (ns: string) => ns === 'llm-pi-ai'
          ? { providers: { meicloud: profile() } }
          : undefined,
      },
      credentials: { resolve: () => Promise.resolve({ value: 'sk-secret' }) },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toMatchObject({
      baseURL: 'https://ai.example.com/litellm',
      apiKey: 'sk-secret',
    })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('contains a legacy get(ns) that throws', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      settings: { get: () => { throw new TypeError('bad namespace') } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the registry path does not reach an object', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: {} },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when the profile names no base URL', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ baseURL: undefined }) } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('hands the endpoint over with no protocol when the profile names no wire', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ api: undefined }) } },
      credentials: { resolve: () => Promise.resolve({ value: 'sk-secret' }) },
    })
    // The missing wire is NOT a refusal: refusing would let the engine send dsh's
    // model id to its own endpoint, which reads like an auth problem and is not.
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toEqual({
      provider: 'meicloud',
      model: 'deepseek-flash',
      baseURL: 'https://ai.example.com/litellm',
      api: undefined,
      apiKey: 'sk-secret',
    })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('supplies the wire for a shipped route whose adapter owns it', async () => {
    const ctx = mount({
      providers: [address('deepseek-official', 'llm-deepseek', [])],
      settingsNs: 'llm-deepseek',
      // The harness's own deepseek adapter has no `api` field to read; its
      // settings section carries the endpoint and the credential reference
      // (`apiKeyEnv` comes from that schema's default) and nothing else.
      section: { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
      credentials: { resolve: () => Promise.resolve({ value: 'sk-official' }) },
    })
    await expect(resolveModelHandover(ctx, { provider: 'deepseek-official', model: 'deepseek-flash' }))
      .resolves.toEqual({
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        baseURL: 'https://api.deepseek.com',
        api: 'openai-completions',
        apiKey: 'sk-official',
      })
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('prefers a declared protocol over the shipped-route table', async () => {
    const ctx = mount({
      providers: [address('deepseek-official', 'llm-deepseek', [])],
      settingsNs: 'llm-deepseek',
      section: {
        baseURL: 'https://api.deepseek.com',
        apiKeyEnv: 'DEEPSEEK_API_KEY',
        api: 'openai-responses',
      },
      credentials: { resolve: () => Promise.resolve({ value: 'sk-official' }) },
    })
    await expect(resolveModelHandover(ctx, { provider: 'deepseek-official', model: 'deepseek-flash' }))
      .resolves.toMatchObject({ api: 'openai-responses' })
  })

  it('injects nothing when the profile names no credential reference', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: undefined }) } },
    })
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('injects nothing when no credential resolves and the ambient environment has none', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: 'DSH_LOOP_ENGINE_ABSENT_KEY' }) } },
      credentials: { resolve: () => Promise.resolve(undefined) },
    })
    delete process.env.DSH_LOOP_ENGINE_ABSENT_KEY
    await expect(resolveModelHandover(ctx, OVERRIDE)).resolves.toBeUndefined()
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('warns once per unresolved selection even when re-resolved every step', async () => {
    const ctx = mount({ providers: [] })
    await resolveModelHandover(ctx, OVERRIDE)
    await resolveModelHandover(ctx, OVERRIDE)
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)

    // A different model is a different reason, so it warns on its own.
    await resolveModelHandover(ctx, { provider: 'meicloud', model: 'other-model' })
    expect(ctx.logger.warn).toHaveBeenCalledTimes(2)
  })

  it('never puts the credential, or the raw profile value, in the warning text', async () => {
    const ctx = mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile({ apiKeyEnv: 'MEICLOUD_API_KEY' }) } },
      credentials: { resolve: () => Promise.resolve(undefined) },
    })
    delete process.env.MEICLOUD_API_KEY
    await resolveModelHandover(ctx, OVERRIDE)
    const message = String((ctx.logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0])
    expect(message).not.toContain('sk-')
    expect(message).toContain('no credential resolves')
  })
})

describe('the capacity a handover carries', () => {
  /** Mount the seams plus a registry that can describe one route's capacity. */
  function mountWithCapacity(resolveModelInfo: unknown): Context {
    return mount({
      providers: [address('meicloud', 'llm-pi-ai')],
      section: { providers: { meicloud: profile() } },
      credentials: { resolve: () => Promise.resolve({ value: 'sk-secret' }) },
      directory: { listConfigurableProviders: () => [address('meicloud', 'llm-pi-ai')], resolveModelInfo },
    })
  }

  it('carries the endpoint\'s window and output cap when the registry answers them', async () => {
    // MiniMax Code writes both into its own config: without them the engine sizes
    // its compaction from a guess.
    const ctx = mountWithCapacity(() => Promise.resolve({
      context: { contextWindow: 128000 },
      defaultMaxTokens: 8192,
    }))
    const handover = await resolveModelHandover(ctx, OVERRIDE)
    expect(handover).toMatchObject({ contextWindow: 128000, maxOutputTokens: 8192 })
  })

  it('carries only what the registry answered', async () => {
    const windowOnly = await resolveModelHandover(mountWithCapacity(() => Promise.resolve({ context: { contextWindow: 64000 } })), OVERRIDE)
    expect(windowOnly).toMatchObject({ contextWindow: 64000 })
    expect(windowOnly).not.toHaveProperty('maxOutputTokens')
    const empty = await resolveModelHandover(mountWithCapacity(() => Promise.resolve({})), OVERRIDE)
    expect(empty).not.toHaveProperty('contextWindow')
    expect(empty).not.toHaveProperty('maxOutputTokens')
  })

  it('leaves capacity absent when the registry cannot describe the route', async () => {
    // Three ways to answer "I cannot": no method, a null context, and a throw. All
    // three mean "the engine keeps its own default", never a refused handover.
    const noMethod = await resolveModelHandover(mountWithCapacity(undefined), OVERRIDE)
    expect(noMethod).not.toHaveProperty('contextWindow')
    const nullContext = await resolveModelHandover(mountWithCapacity(() => Promise.resolve({ context: undefined })), OVERRIDE)
    expect(nullContext).not.toHaveProperty('contextWindow')
    const thrown = await resolveModelHandover(mountWithCapacity(() => Promise.reject(new Error('not routable'))), OVERRIDE)
    expect(thrown).toMatchObject({ model: 'deepseek-flash' })
    expect(thrown).not.toHaveProperty('contextWindow')
  })
})
