/**
 * Per-session model-menu scoping.
 *
 * The Host builds one model catalog per generation, so this plugin's per-engine
 * routes all appear in every session's menu. The fix is a VIEW filter over each
 * session's `ModelDirectory` store: this spec pins the filter's rule, the
 * store wrapping that makes a switch re-render, and the raw-service binding that
 * keeps the composer's model seat alive.
 *
 * @module tests/client/model-catalog-scope
 */

import { describe, expect, it } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionEngineReport } from '../../src/agent-preset-ids.ts'
import {
  installModelCatalogScope,
  modelMenuScope,
  scopeModelDirectoryState,
  type DirectoryStoreLike,
  type ModelDirectoryResolverLike,
} from '../../src/client/model-catalog-scope.ts'
import type { SessionEngineCache } from '../../src/client/session-engine.ts'

/** One directory state in the shape the model directory produces. */
function state(groups: readonly string[], failures: readonly string[] = []) {
  return {
    current: null,
    groups: groups.map(id => ({ id, name: id, models: [] })),
    failures: failures.map(id => ({ id, name: id, message: 'x' })),
    status: 'ready' as const,
  }
}

/** An in-memory store with the SnapshotStore surface the module wraps. */
function fakeStore(initial: ReturnType<typeof state>) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next: ReturnType<typeof state>) {
      value = next
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

/** The engine cache face, driven by the test rather than a Remote. */
function fakeEngines(report: SessionEngineReport | undefined) {
  const listeners = new Set<() => void>()
  return {
    current: report,
    read: () => undefined as SessionEngineReport | undefined,
    watch: (_sessionId: string, listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish(next: SessionEngineReport | undefined) {
      this.current = next
      for (const listener of [...listeners]) listener()
    },
  }
}

const MINIMAX = { engine: { kind: 'engine', engine: 'minimaxcode' } } as SessionEngineReport
const AGY = { engine: { kind: 'engine', engine: 'agy' } } as SessionEngineReport
const IN_PROCESS = { engine: { kind: 'engine', engine: 'in-process' } } as SessionEngineReport
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/** Present a fake resolver the way Cordis does: as a traceable proxy. */
function asServiceProxy<T extends object>(target: T): T {
  if ((target as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL] !== undefined) return target
  return new Proxy(target, {
    get(inner, prop, receiver) {
      if (prop === CORDIS_ORIGINAL) return inner
      return Reflect.get(inner, prop, receiver)
    },
  })
}

describe('modelMenuScope', () => {
  it('scopes a hosted engine to itself and the harness loop to in-process', () => {
    expect(modelMenuScope(MINIMAX)).toBe('minimaxcode')
    expect(modelMenuScope(IN_PROCESS)).toBe('in-process')
    // No answer yet (or a legacy/unset record): leave the menu unscoped rather
    // than hide the wrong things.
    expect(modelMenuScope(undefined)).toBeUndefined()
    expect(modelMenuScope({ engine: { kind: 'legacy' } } as SessionEngineReport)).toBeUndefined()
  })
})

describe('scopeModelDirectoryState', () => {
  it('keeps the session engine’s group plus every non-engine provider', () => {
    const raw = state(['external', 'agy', 'minimaxcode', 'deepseek-account'], ['agy', 'deepseek-account'])
    const scoped = scopeModelDirectoryState(raw, 'minimaxcode')
    expect(scoped.groups.map(group => group.id)).toEqual(['external', 'minimaxcode', 'deepseek-account'])
    expect(scoped.failures.map(failure => failure.id)).toEqual(['deepseek-account'])
  })

  it('drops every engine group AND the placeholder route for an in-process session', () => {
    const scoped = scopeModelDirectoryState(state(['external', 'agy', 'grok', 'deepseek-account']), 'in-process')
    expect(scoped.groups.map(group => group.id)).toEqual(['deepseek-account'])
  })

  it('still fails open to the raw catalog when the filter would empty the menu', () => {
    const raw = state(['external', 'agy'])
    expect(scopeModelDirectoryState(raw, 'in-process')).toBe(raw)
  })

  it('returns the SAME object when nothing needs dropping, and while the engine is unknown', () => {
    const raw = state(['external', 'deepseek-account'])
    expect(scopeModelDirectoryState(raw, 'minimaxcode')).toBe(raw)
    const unknown = state(['external', 'agy'])
    expect(scopeModelDirectoryState(unknown, undefined)).toBe(unknown)
  })
})

describe('installModelCatalogScope', () => {
  /** Install the wrapper over one fake host service. */
  function install(resolver: ModelDirectoryResolverLike, engines: SessionEngineCache): void {
    const ctx = {
      inject: (_services: readonly string[], callback: (scope: ClientContext) => void) =>
        callback({ modelDirectories: asServiceProxy(resolver) } as unknown as ClientContext),
    } as unknown as ClientContext
    installModelCatalogScope(ctx, engines)
  }

  it('filters the store and re-renders when the session’s engine changes', () => {
    const store = fakeStore(state(['external', 'agy', 'minimaxcode']))
    const directory = { store: store as unknown as DirectoryStoreLike }
    const resolver: ModelDirectoryResolverLike = { directoryFor: () => directory }
    const engines = fakeEngines(undefined)
    // `read` answers the CURRENT report, as the real cache does.
    engines.read = () => engines.current
    install(resolver, engines as unknown as SessionEngineCache)

    engines.current = MINIMAX
    const patched = resolver.directoryFor('s1')
    expect((patched.store.getSnapshot() as ReturnType<typeof state>).groups.map(group => group.id))
      .toEqual(['external', 'minimaxcode'])
    // Same engine + same raw snapshot → the SAME object (useSyncExternalStore
    // requires it; a fresh object per read would loop).
    expect(patched.store.getSnapshot()).toBe(patched.store.getSnapshot())

    let notified = 0
    const stop = patched.store.subscribe(() => { notified += 1 })
    engines.publish(AGY)
    expect(notified).toBe(1)
    expect((patched.store.getSnapshot() as ReturnType<typeof state>).groups.map(group => group.id))
      .toEqual(['external', 'agy'])
    stop()
    expect(store.listenerCount()).toBe(0)
  })

  it('hides every CLI catalog for an in-process session, keeping only native providers', () => {
    const store = fakeStore(state(['external', 'agy', 'minimaxcode', 'deepseek-account']))
    const directory = { store: store as unknown as DirectoryStoreLike }
    const resolver: ModelDirectoryResolverLike = { directoryFor: () => directory }
    const engines = fakeEngines(IN_PROCESS)
    engines.read = () => engines.current
    install(resolver, engines as unknown as SessionEngineCache)

    const patched = resolver.directoryFor('s1')
    expect((patched.store.getSnapshot() as ReturnType<typeof state>).groups.map(group => group.id))
      .toEqual(['deepseek-account'])
  })

  it('calls the raw service so a proxy-bound ctx cannot drop the model seat', () => {
    const store = fakeStore(state(['external', 'agy', 'minimaxcode']))
    const directory = { store: store as unknown as DirectoryStoreLike }
    const target = {
      // The real `directoryFor` reads `this.ctx`; the wrapper must not rebind it
      // to the plugin's context (which lacks `remote.session`).
      calls: 0,
      directoryFor(this: { calls: number }): { store: DirectoryStoreLike } {
        this.calls += 1
        return directory
      },
    }
    const original = Symbol.for('cordis.original')
    const proxy = new Proxy(target, {
      get(inner, prop, receiver) {
        if (prop === original) return inner
        return Reflect.get(inner, prop, receiver)
      },
    }) as unknown as ModelDirectoryResolverLike
    const engines = fakeEngines(MINIMAX)
    engines.read = () => engines.current
    install(proxy, engines as unknown as SessionEngineCache)

    expect(target.directoryFor('s1')).toBe(directory)
    expect(target.calls).toBe(1)
    expect((directory.store.getSnapshot() as ReturnType<typeof state>).groups.map(group => group.id))
      .toEqual(['external', 'minimaxcode'])
  })

  it('stops its engine watch when the session directory is disposed', () => {
    const store = fakeStore(state(['external', 'agy', 'minimaxcode']))
    let disposed = 0
    const directory = {
      store: store as unknown as DirectoryStoreLike,
      dispose: () => { disposed += 1 },
    }
    const resolver: ModelDirectoryResolverLike = { directoryFor: () => directory }
    const engines = fakeEngines(MINIMAX)
    engines.read = () => engines.current
    install(resolver, engines as unknown as SessionEngineCache)

    const patched = resolver.directoryFor('s1')
    let notified = 0
    patched.store.subscribe(() => { notified += 1 })
    patched.dispose?.()
    expect(disposed).toBe(1)
    engines.publish(AGY)
    expect(notified).toBe(0)
  })

  it('leaves the directory untouched when the host serves no modelDirectories', () => {
    const ctx = {
      inject: (_services: readonly string[], callback: (scope: ClientContext) => void) =>
        callback({} as unknown as ClientContext),
    } as unknown as ClientContext
    expect(() => installModelCatalogScope(ctx, fakeEngines(undefined) as unknown as SessionEngineCache))
      .not.toThrow()
  })
})
