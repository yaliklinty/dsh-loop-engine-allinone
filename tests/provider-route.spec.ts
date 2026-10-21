/**
 * Provider-route placeholder suite: the one shared route label, the single model
 * entry it advertises, the display name its provider group carries, the legacy
 * labels it still recognizes, and the loud failure a real model call reaching it
 * gets.
 *
 * The entry's id is the whole point of advertising one at all: the web model
 * menu resolves a session's `(provider, model)` against the catalog by
 * `model.id` (`packages/client/ui-model-selection/src/client/ModelSelect.tsx`
 * `choices`/`selectedIndex`), and a hosted engine logs its own model label into
 * the session's `request/header` — so the id has to be the label every engine
 * logs, or the seat renders the raw `provider/model` string instead.
 * @module tests/provider-route
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LlmError, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  HOSTED_DEFAULT_MODEL,
  HOSTED_ENGINE_IDS,
  HOSTED_ROUTE_LABEL,
  HOSTED_ROUTE_NAME,
} from '../src/agent-preset-ids.ts'
import {
  DEFAULT_ENGINE_CONTEXT_WINDOW,
  HOSTED_SUBSCRIPTION_MARKER,
  HostedEngineRouteAdapter,
  effortLabel,
  engineGroupName,
  engineReasoningLadder,
  hostedEngineOfRouteLabel,
  hostedRouteLabelOf,
  isHostedProviderRoute,
} from '../src/provider-route.ts'
import { ENGINE_REGISTRY, type EngineDescriptor } from '../src/engine-registry.ts'

describe('HOSTED_ROUTE_LABEL', () => {
  it('is the ASCII wire label every hosted engine logs', () => {
    // ASCII, non-empty, and different from every engine id: it is written into
    // each session's `request/header` and compared by the host, so it may not
    // collide with a provider a deployment composes.
    expect(HOSTED_ROUTE_LABEL).toBe('external')
    expect(HOSTED_ROUTE_NAME).toBe('external')
    expect(HOSTED_ENGINE_IDS).not.toContain(HOSTED_ROUTE_LABEL)
  })

  it('gives an engine with no declared catalog the shared label', () => {
    // The shared route exists for exactly this: an engine whose models this
    // build does not know keeps one `default` entry meaning "the engine decides",
    // rather than adding a group of identical rows to every session's menu.
    for (const engine of HOSTED_ENGINE_IDS) {
      if (ENGINE_REGISTRY[engine].models !== undefined) continue
      expect(hostedRouteLabelOf(engine)).toBe(HOSTED_ROUTE_LABEL)
    }
  })

  it('gives an engine that declares a catalog a route of its own', () => {
    // A group earns its place in the menu only by carrying models the others do
    // not, so an engine with a catalog is named by its id.
    let sawCatalog = false
    for (const engine of HOSTED_ENGINE_IDS) {
      if (ENGINE_REGISTRY[engine].models === undefined) continue
      sawCatalog = true
      expect(hostedRouteLabelOf(engine)).toBe(engine)
      expect(hostedEngineOfRouteLabel(engine)).toBe(engine)
    }
    expect(sawCatalog).toBe(true)
  })

  it('attributes a per-engine route back to its engine, and no other label', () => {
    expect(hostedEngineOfRouteLabel(HOSTED_ROUTE_LABEL)).toBeUndefined()
    expect(hostedEngineOfRouteLabel('not-an-engine')).toBeUndefined()
    // An engine WITHOUT a catalog has no route of its own, so its id must not be
    // attributed as one — else a selection naming it would look like a native
    // pick rather than the shared route.
    for (const engine of HOSTED_ENGINE_IDS) {
      if (ENGINE_REGISTRY[engine].models !== undefined) continue
      expect(hostedEngineOfRouteLabel(engine)).toBeUndefined()
    }
  })
})

describe('isHostedProviderRoute', () => {
  it('recognizes the one registered label', () => {
    expect(isHostedProviderRoute(HOSTED_ROUTE_LABEL)).toBe(true)
  })

  it('still recognizes the per-engine labels earlier builds logged', () => {
    // A pre-existing session's header names one of these; no adapter serves
    // them any more, so recognizing them is what lets the reset guard rewrite
    // the seat before the host refuses the session's turn.
    for (const legacy of ['claude-code', 'codex', 'pi', 'kimi']) {
      expect(isHostedProviderRoute(legacy)).toBe(true)
    }
  })

  it('rejects every other provider, including a real one and the harness loop', () => {
    expect(isHostedProviderRoute('deepseek-official')).toBe(false)
    expect(isHostedProviderRoute('in-process')).toBe(false)
    expect(isHostedProviderRoute('')).toBe(false)
  })
})

describe('HostedEngineRouteAdapter', () => {
  it('serves the one route with its display name and its single default entry', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter([HOSTED_ROUTE_LABEL], new HostedEngineRouteAdapter())

    // Exactly one provider: four engines sharing a route means one group in the
    // model menu, named `external`, not four groups named after the engines.
    expect(llm.listProviders()).toEqual([{ id: HOSTED_ROUTE_LABEL, name: HOSTED_ROUTE_NAME }])
    // Exactly one entry: the group is what makes the route appear in the menu,
    // and the id is what a hosted session's logged label resolves to. The
    // modalities are declared so the host's image gate is answered by this
    // plugin, not by the field's absence (see `HOSTED_MODEL_MODALITIES`).
    await expect(llm.listModels(HOSTED_ROUTE_LABEL)).resolves.toEqual([
      {
        provider: HOSTED_ROUTE_LABEL,
        id: HOSTED_DEFAULT_MODEL,
        name: HOSTED_DEFAULT_MODEL,
        inputModalities: ['text', 'image'],
      },
    ])

    release()
    expect(llm.listProviders()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('declares the configured context window and the route modalities on the resolved entry', async () => {
    const adapter = new HostedEngineRouteAdapter(131072)
    // The capacity is what dsh's compaction pressure path reads
    // (`resolveModelInfo`), and it rides the resolved entry rather than the
    // catalog entry because `LlmModelInfo` has no context field.
    await expect(adapter.resolveModel(HOSTED_ROUTE_LABEL, HOSTED_DEFAULT_MODEL)).resolves.toEqual({
      provider: HOSTED_ROUTE_LABEL,
      id: HOSTED_DEFAULT_MODEL,
      name: HOSTED_DEFAULT_MODEL,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 131072 },
    })
  })

  it('echoes the exact model label it was asked about, whatever a deployment pinned', async () => {
    // The harness rejects a result whose `id` differs from the query, and a
    // deployment may pin `config.model`, so the logged label is not always
    // `default` — the entry has to answer for it.
    const adapter = new HostedEngineRouteAdapter(200000)
    await expect(adapter.resolveModel(HOSTED_ROUTE_LABEL, 'kimi-k2')).resolves.toEqual({
      provider: HOSTED_ROUTE_LABEL,
      id: 'kimi-k2',
      name: 'kimi-k2',
      inputModalities: ['text', 'image'],
      context: { contextWindow: 200000 },
    })
  })

  it('falls back to the documented default window for an absent or non-positive value', async () => {
    for (const value of [undefined, 0, -1, 1.5, Number.NaN]) {
      const adapter = new HostedEngineRouteAdapter(value)
      await expect(adapter.resolveModel(HOSTED_ROUTE_LABEL, HOSTED_DEFAULT_MODEL))
        .resolves.toMatchObject({ context: { contextWindow: DEFAULT_ENGINE_CONTEXT_WINDOW } })
    }
    expect(DEFAULT_ENGINE_CONTEXT_WINDOW).toBe(262144)
  })

  it('passes the registry’s own metadata validation with its declared window', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const llm = ctx.get('llm') as LlmRuntime
    const release = llm.registerAdapter([HOSTED_ROUTE_LABEL], new HostedEngineRouteAdapter(200000))

    // `normalizeModelInfo` is what the compaction path goes through, so the
    // contract is pinned against the real registry rather than the adapter alone.
    await expect(llm.resolveModelInfo(HOSTED_ROUTE_LABEL, HOSTED_DEFAULT_MODEL)).resolves.toEqual({
      provider: HOSTED_ROUTE_LABEL,
      id: HOSTED_DEFAULT_MODEL,
      name: HOSTED_DEFAULT_MODEL,
      inputModalities: ['text', 'image'],
      context: { contextWindow: 200000 },
    })

    release()
    await ctx.fiber.dispose()
  })

  it('fails loud when a model query reaches the placeholder', () => {
    const adapter = new HostedEngineRouteAdapter()
    const options = undefined as unknown as GenerateOptions
    expect(() => adapter.stream(options)).toThrow(LlmError)
    expect(() => adapter.stream(options)).toThrow('provider "external" is a hosted loop engine route, not a model endpoint')
    try {
      adapter.stream(options)
      expect.unreachable()
    } catch (error: unknown) {
      expect((error as LlmError).failure.code).toBe('HOSTED_ENGINE_ROUTE')
    }
  })
})


describe('HostedEngineRouteAdapter group identity', () => {
  /** The engine that declares a model catalog, for the per-engine cases. */
  const owner = HOSTED_ENGINE_IDS.find(engine => ENGINE_REGISTRY[engine].models !== undefined)!

  it('keeps the shared route’s fixed name', () => {
    const adapter = new HostedEngineRouteAdapter()
    expect(adapter.providerInfo(HOSTED_ROUTE_LABEL)).toEqual({ id: HOSTED_ROUTE_LABEL, name: HOSTED_ROUTE_NAME })
  })

  it('names an engine’s own group by its DISPLAY label, not its wire id', () => {
    // The wire id is what the registry compares against the registration; the
    // menu must show `Antigravity`, not `agy`.
    const adapter = new HostedEngineRouteAdapter(undefined, owner, ENGINE_REGISTRY[owner].models, ENGINE_REGISTRY[owner].label)
    expect(adapter.providerInfo(owner)).toEqual({ id: owner, name: ENGINE_REGISTRY[owner].label })
    expect(ENGINE_REGISTRY[owner].label).not.toBe(owner)
  })

  it('advertises `default` first, then the catalog with its display labels', async () => {
    const models = ENGINE_REGISTRY[owner].models!
    const adapter = new HostedEngineRouteAdapter(undefined, owner, models, ENGINE_REGISTRY[owner].label)
    const advertised = await adapter.listModels(owner)
    expect(advertised[0]).toEqual({
      provider: owner, id: HOSTED_DEFAULT_MODEL, name: HOSTED_DEFAULT_MODEL, inputModalities: ['text', 'image'],
    })
    expect(advertised.slice(1)).toEqual(models.map(model => ({
      provider: owner, id: model.id, name: model.label, inputModalities: ['text', 'image'],
    })))
  })

  it('resolves a native id with the declared context window', async () => {
    const models = ENGINE_REGISTRY[owner].models!
    const adapter = new HostedEngineRouteAdapter(8192, owner, models, ENGINE_REGISTRY[owner].label)
    const resolved = await adapter.resolveModel(owner, models[0]!.id)
    expect(resolved.id).toBe(models[0]!.id)
    expect(resolved.context).toEqual({ contextWindow: 8192 })
  })

  it('fails loud on any of its routes, naming that route', () => {
    // A real model call reaching an engine's group means a session the harness
    // loop drives was handed an engine label — a wiring bug, not a request.
    const adapter = new HostedEngineRouteAdapter(undefined, owner, ENGINE_REGISTRY[owner].models, ENGINE_REGISTRY[owner].label)
    expect(() => adapter.stream({} as never)).toThrow(new RegExp(`provider "${owner}" is a hosted loop engine route`))
  })
})

describe('engineReasoningLadder', () => {
  /** A real descriptor with one capability overridden, so the table stays valid. */
  const withCapabilities = (capabilities: Record<string, unknown>): EngineDescriptor =>
    ({
      ...ENGINE_REGISTRY.grok,
      capabilities: { ...ENGINE_REGISTRY.grok.capabilities, ...capabilities },
    }) as unknown as EngineDescriptor

  it('renders an engine effort value as the label the menu shows', () => {
    // The engine's own menu spells these the same way; a per-value table would be
    // one more place a vendor value loses its name.
    expect(effortLabel('default')).toBe('Default')
    expect(effortLabel('xhigh')).toBe('Xhigh')
    expect(effortLabel('max')).toBe('Max')
  })

  it('declares MiniMax Code\'s six measured levels on its thinking variants only', () => {
    const ladder = engineReasoningLadder(ENGINE_REGISTRY.minimaxcode)
    expect(ladder).toBeDefined()
    // A non-thinking variant is refused by the CLI itself, so it must not offer
    // an effort the engine would reject.
    expect(ladder!('m:minimax:MiniMax-M3.1-Flash:v:')).toBeUndefined()
    expect(ladder!('m:minimax:MiniMax-M3.1-Flash:v:thinking')).toEqual({
      efforts: [
        { id: 'default', name: 'Default' },
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'Xhigh' },
        { id: 'max', name: 'Max' },
      ],
      defaultEffort: 'default',
    })
  })

  it('answers no ladder for an engine that declares none', () => {
    // Grok exposes no effort surface this plugin has measured: no ladder means no
    // effort row, which is the pre-existing behavior.
    expect(engineReasoningLadder(ENGINE_REGISTRY.grok)).toBeUndefined()
  })

  it('treats an empty ladder or a suffixless declaration as no ladder', () => {
    expect(engineReasoningLadder(withCapabilities({ reasoningEfforts: [], reasoningModelSuffix: ':v:thinking' }))).toBeUndefined()
    expect(engineReasoningLadder(withCapabilities({ reasoningEfforts: ['high'] }))).toBeUndefined()
    expect(engineReasoningLadder(withCapabilities({ reasoningEfforts: ['high'], reasoningModelSuffix: '' }))).toBeUndefined()
  })

  it('omits the default effort when the ladder does not name one', () => {
    // `default` is the engine's own "whatever I would do": without it, dsh must
    // leave the field absent rather than invent a strength.
    const ladder = engineReasoningLadder(withCapabilities({
      reasoningEfforts: ['low', 'high'],
      reasoningModelSuffix: ':v:thinking',
    }))
    expect(ladder!('x:v:thinking')).toEqual({ efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] })
  })
})

describe('a hosted route that declares a reasoning ladder', () => {
  it('resolves the ladder for a thinking model and nothing for the others', async () => {
    const adapter = new HostedEngineRouteAdapter(
      undefined,
      'minimaxcode',
      [],
      'MiniMax Code',
      engineReasoningLadder(ENGINE_REGISTRY.minimaxcode),
    )
    const thinking = await adapter.resolveModel('minimaxcode', 'm:minimax:MiniMax-M3:v:thinking')
    expect(thinking.reasoning).toMatchObject({ defaultEffort: 'default' })
    expect(thinking.reasoning!.efforts.map(effort => effort.id)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max'])
    // The catalogue entry carries no reasoning field at all; the RESOLVED shape is
    // the one the menu and `selectModel` validate against.
    const plain = await adapter.resolveModel('minimaxcode', 'm:minimax:MiniMax-M3:v:')
    expect(plain).not.toHaveProperty('reasoning')
    // The shared `default` seat is never a model with an effort.
    expect(await adapter.resolveModel('minimaxcode', 'default')).not.toHaveProperty('reasoning')
  })

  it('leaves the field absent for a route built without one', async () => {
    const adapter = new HostedEngineRouteAdapter(undefined, 'minimaxcode', [], 'MiniMax Code')
    expect(await adapter.resolveModel('minimaxcode', 'm:minimax:MiniMax-M3:v:thinking')).not.toHaveProperty('reasoning')
  })
})

describe('engineGroupName', () => {
  it('marks an engine group as the subscription it is', () => {
    // Two groups can carry the same vendor name — a direct provider route and the
    // CLI's own catalog — and they are not interchangeable.
    expect(engineGroupName('MiniMax Code')).toBe(`MiniMax Code${HOSTED_SUBSCRIPTION_MARKER}`)
    expect(engineGroupName('MiniMax Code')).toContain('订阅')
    // The shared placeholder route keeps its bare name: it is not a subscription.
    expect(engineGroupName('external')).not.toBe('external')
  })
})
