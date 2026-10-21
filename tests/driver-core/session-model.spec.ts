/**
 * Unit tests for the shared session-model judgement: the host-style selection
 * read (`currentSelection`), the one decision every hosted engine consumes
 * (`sessionModelOverride`), and the context-bound convenience the drivers call
 * (`sessionModelOverrideOf`).
 *
 * @module tests/driver-core/session-model
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, canonicalHeader, type Session } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  currentSelection,
  currentSelectionOf,
  foreignHostedModelRefusal,
  modelForStep,
  nativeModelOf,
  sessionModelOverride,
  sessionModelOverrideOf,
  unservableModelRefusal,
} from '../../src/driver-core/session-model.ts'
import { ENGINE_REGISTRY, HOSTED_ENGINE_IDS } from '../../src/engine-registry.ts'
import { hostedRouteLabelOf } from '../../src/provider-route.ts'
import { modelSelectionProjections } from '../helpers/model-selection-projection.ts'

/** A session plus the reads its context carries, for the assertions. */
interface Fixture {
  readonly ctx: Context
  readonly session: Session
  /** The registry `currentSelection` is handed, when one was composed. */
  readonly projections: ReturnType<typeof modelSelectionProjections> | undefined
}

/**
 * Boot a bare session store, optionally composing the host's `modelSelection`
 * fold, and prepare one session on it.
 * @param withProjections - whether the session-projection registry is composed.
 * @returns the context, a prepared session, and the registry when present.
 */
async function boot(withProjections = true): Promise<Fixture> {
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SessionStore)
  const projections = withProjections ? modelSelectionProjections(ctx) : undefined
  if (projections !== undefined) ctx.provide('sessionProjections', projections)
  const session = ctx.sessions.prepare(SessionId('session-model-s'), { meta: { cwd: process.cwd() } })
  return { ctx, session, projections }
}

/** Contexts to unload after each test. */
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

/** Log a request header with the given provider and model. */
function logHeader(session: Session, provider: string, model: string): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider, model } }),
    reason: 'initial',
  })
}

/** Log a request header that also carries an effort, the shape a routed call has. */
function logHeaderWithEffort(session: Session, provider: string, model: string, effort: string): void {
  session.append('request/header', {
    header: canonicalHeader({ config: { provider, model, reasoningEffort: ReasoningEffortId(effort) } }),
    reason: 'initial',
  })
}

describe('sessionModelOverride', () => {
  it('sends nothing when the log records no selection', () => {
    expect(sessionModelOverride(undefined)).toBeUndefined()
  })

  it('passes a real dsh model through, provider and model intact', () => {
    expect(sessionModelOverride({ provider: 'meicloud', model: 'deepseek-flash' }))
      .toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('sends nothing for the shared hosted label, the engine\'s own default', () => {
    expect(sessionModelOverride({ provider: 'external', model: 'default' })).toBeUndefined()
  })

  it('sends nothing for an earlier build\'s per-engine label', () => {
    for (const provider of ['claude-code', 'codex', 'pi', 'kimi']) {
      expect(sessionModelOverride({ provider, model: 'default' })).toBeUndefined()
    }
  })
})

describe('currentSelection', () => {
  it('prefers a pending selection over the logged header', async () => {
    const { session, projections } = await boot()
    logHeader(session, 'external', 'default')
    session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
    expect(currentSelection(session, projections)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('falls back to the logged header when nothing is pending', async () => {
    const { session, projections } = await boot()
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(currentSelection(session, projections)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('answers undefined when the log records neither a pending selection nor a header', async () => {
    const { session, projections } = await boot()
    expect(currentSelection(session, projections)).toBeUndefined()
  })

  it('reads the header when no projection registry is composed', async () => {
    const { session } = await boot()
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(currentSelection(session, undefined)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })
})

describe('sessionModelOverrideOf', () => {
  it('resolves the pending selection through the composed registry', async () => {
    const { ctx, session } = await boot()
    session.append('model/selection', { provider: 'meicloud', model: 'deepseek-flash' })
    expect(sessionModelOverrideOf(ctx, session)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })

  it('sends nothing when the selection names the hosted seat', async () => {
    const { ctx, session } = await boot()
    logHeader(session, 'external', 'default')
    expect(sessionModelOverrideOf(ctx, session)).toBeUndefined()
  })

  it('reads the header when the deployment composes no projection registry', async () => {
    const { ctx, session } = await boot(false)
    logHeader(session, 'meicloud', 'deepseek-flash')
    expect(sessionModelOverrideOf(ctx, session)).toEqual({ provider: 'meicloud', model: 'deepseek-flash' })
  })
})


describe('nativeModelOf: picking a model from the engine’s own catalog', () => {
  it('names the pick when the session selects one of THIS engine’s models', () => {
    // The engine's own group in the model menu advertises its subscription's
    // models; selecting one must hand that exact id to the engine.
    const first = ENGINE_REGISTRY.agy.models![0]!
    expect(nativeModelOf({ provider: hostedRouteLabelOf('agy'), model: first.id }, 'agy')).toBe(first.id)
  })

  it('answers nothing for `default`, which still means "the engine decides"', () => {
    expect(nativeModelOf({ provider: hostedRouteLabelOf('agy'), model: 'default' }, 'agy')).toBeUndefined()
  })

  it('answers nothing for the shared route, or for another engine’s route', () => {
    expect(nativeModelOf({ provider: 'external', model: 'default' }, 'agy')).toBeUndefined()
    expect(nativeModelOf({ provider: 'external', model: 'gemini-3.8-flash-low' }, 'agy')).toBeUndefined()
    expect(nativeModelOf({ provider: hostedRouteLabelOf('pi'), model: 'x' }, 'agy')).toBeUndefined()
  })

  it('answers nothing for a real dsh model — that is the handover path, not this one', () => {
    expect(nativeModelOf({ provider: 'meicloud', model: 'deepseek-flash' }, 'agy')).toBeUndefined()
    expect(nativeModelOf(undefined, 'agy')).toBeUndefined()
  })

  it('covers every engine that declares a catalog', () => {
    for (const engine of HOSTED_ENGINE_IDS) {
      const models = ENGINE_REGISTRY[engine].models
      if (models === undefined) continue
      expect(nativeModelOf({ provider: hostedRouteLabelOf(engine), model: models[0]!.id }, engine)).toBe(models[0]!.id)
    }
  })
})

describe('modelForStep: one place decides what the child is asked to run', () => {
  it('prefers the session’s native pick over the deployment’s pin', () => {
    const pick = ENGINE_REGISTRY.agy.models![1]!
    expect(modelForStep({ provider: hostedRouteLabelOf('agy'), model: pick.id }, 'agy', 'pinned-model')).toBe(pick.id)
  })

  it('falls back to the deployment’s pin when nothing was picked', () => {
    expect(modelForStep({ provider: 'external', model: 'default' }, 'agy', 'pinned-model')).toBe('pinned-model')
    expect(modelForStep(undefined, 'agy', 'pinned-model')).toBe('pinned-model')
  })

  it('answers nothing when neither was set, leaving the engine its own default', () => {
    expect(modelForStep(undefined, 'agy', undefined)).toBeUndefined()
  })
})

describe('foreignHostedModelRefusal: a pick from another engine’s catalog', () => {
  const label = ENGINE_REGISTRY.agy.label

  it('refuses a model belonging to a different engine, naming both', () => {
    // The reachable direction today: a session on an engine WITHOUT a catalog
    // picking a model from the one engine that HAS one. The model catalog is
    // built per Host generation, so every engine's group is in every session's
    // menu — this state is producible by clicking.
    const owner = HOSTED_ENGINE_IDS.find(engine => ENGINE_REGISTRY[engine].models !== undefined)!
    const refusal = foreignHostedModelRefusal(
      { provider: hostedRouteLabelOf(owner), model: 'some-model' },
      'kimi',
      ENGINE_REGISTRY.kimi.label,
    )
    expect(refusal).toContain('Kimi Code')
    expect(refusal).toContain('some-model')
    expect(refusal).toContain('another hosted engine')
    expect(refusal).toContain('switch this session')
  })

  it('permits this engine’s own route and the shared one', () => {
    expect(foreignHostedModelRefusal({ provider: hostedRouteLabelOf('agy'), model: 'x' }, 'agy', label)).toBeUndefined()
    expect(foreignHostedModelRefusal({ provider: 'external', model: 'default' }, 'agy', label)).toBeUndefined()
  })

  it('permits a real dsh model, which is the handover path', () => {
    expect(foreignHostedModelRefusal({ provider: 'meicloud', model: 'deepseek-flash' }, 'agy', label)).toBeUndefined()
    expect(foreignHostedModelRefusal(undefined, 'agy', label)).toBeUndefined()
  })

  it('owes no refusal for a pick that belongs to no catalog at all', () => {
    // An engine with no catalog has no route of its own, so a selection naming it
    // is not a foreign MODEL — it is the shared route or a dsh model.
    for (const engine of HOSTED_ENGINE_IDS) {
      if (ENGINE_REGISTRY[engine].models !== undefined) continue
      expect(foreignHostedModelRefusal({ provider: engine, model: 'x' }, 'agy', label)).toBeUndefined()
    }
  })
})

describe('the reasoning effort beside a selection', () => {
  it('is read back from the logged header, which is where a routed call leaves it', async () => {
    const { session, projections } = await boot(true)
    logHeaderWithEffort(session, 'minimaxcode', 'm:minimax:MiniMax-M3:v:thinking', 'high')
    // Dropping it here would lose a session's strength the moment its pending
    // selection is consumed — the read a driver makes on EVERY step.
    expect(currentSelection(session, projections)).toEqual({
      provider: 'minimaxcode',
      model: 'm:minimax:MiniMax-M3:v:thinking',
      reasoningEffort: 'high',
    })
  })

  it('rides the override so a driver can forward it to the engine', async () => {
    expect(sessionModelOverride({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low' }))
      .toEqual({ provider: 'minimax', model: 'MiniMax-M3.1-Flash', reasoningEffort: 'low' })
    // Absent stays absent: an engine's own default is not a strength to assert.
    expect(sessionModelOverride({ provider: 'minimax', model: 'MiniMax-M3.1-Flash' }))
      .toEqual({ provider: 'minimax', model: 'MiniMax-M3.1-Flash' })
  })

  it('is readable through the context-bound helper the drivers call', async () => {
    const { ctx, session } = await boot(true)
    session.append('model/selection', {
      provider: 'minimaxcode',
      model: 'm:minimax:MiniMax-M3:v:thinking',
      reasoningEffort: ReasoningEffortId('xhigh'),
    })
    expect(currentSelectionOf(ctx, session)).toMatchObject({ reasoningEffort: 'xhigh' })
  })
})

describe('unservableModelRefusal', () => {
  it('says nothing when the pick is not a dsh model at all', () => {
    // A hosted seat applies no model, so there is nothing to refuse.
    expect(unservableModelRefusal(undefined, 'MiniMax Code')).toBeUndefined()
  })

  it('names the engine, the provider route, the model, and both ways out', () => {
    const message = unservableModelRefusal(
      { provider: 'minimax', model: 'MiniMax-M3.1-Flash' },
      'MiniMax Code',
    )
    // The engine's own complaint ("Invalid model config value: …") names neither
    // cause nor cure; this one has to name both.
    expect(message).toContain('MiniMax Code')
    expect(message).toContain('"MiniMax-M3.1-Flash"')
    expect(message).toContain('"minimax"')
    expect(message).toContain("MiniMax Code's own group")
    expect(message).toContain('in-process')
  })
})
