/**
 * Per-session scoping of the browser model menu.
 *
 * ## The problem
 *
 * The harness builds ONE model catalog per Host generation
 * (`packages/api/session-controller/src/catalog.ts` `buildModelCatalog`): it has
 * no session argument, and every selector in every session reads the same
 * groups. This plugin registers one provider route per engine that declares a
 * catalog (Antigravity, Grok Build, MiniMax Code, Kimi), so without scoping every
 * session's menu lists every engine's subscription models — picking one in a
 * session of another engine is the cross-engine refusal the drivers already
 * report, but the menu should not offer it at all.
 *
 * ## What this module does
 *
 * The catalog cannot be filtered on the Host (it is global and cached), but the
 * per-session `ModelDirectory` CAN: the client's model selector reads one
 * directory per session, and that directory's store is the data the menu renders.
 * This module wraps `ctx.modelDirectories.directoryFor` and scopes the store's
 * snapshot to the session's own engine:
 *
 *  - a session running a hosted engine keeps that engine's group (and every
 *    non-engine provider group: DeepSeek, `llm-pi-ai`, …);
 *  - the harness loop (`in-process`) keeps only the non-engine groups;
 *  - an unknown engine (the read has not answered yet) is left unscoped rather
 *    than guessed — the menu shows the global list for that instant, then the
 *    engine answer arrives and the watch re-renders it scoped.
 *
 * Only the VIEW is filtered. The provider routes stay registered and keep
 * serving every engine's current selection (the Host's `modelAvailable` check on
 * send reads `listModels`, which this module never touches), so a background
 * session of another engine keeps working while its group is out of this
 * session's menu.
 *
 * The snapshot is cached by `(raw snapshot, engine)` identity because React's
 * `useSyncExternalStore` requires `getSnapshot()` to return the same object until
 * something changes; building a fresh object per call would loop.
 *
 * @module dsh-loop-engine-allinone/client/model-catalog-scope
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { HOSTED_ENGINE_IDS } from '../engine-registry.ts'
import { HOSTED_ROUTE_LABEL, type SessionEngineReport } from '../agent-preset-ids.ts'
import type { SessionEngineCache } from './session-engine.ts'

/**
 * The scope one session's menu renders: its hosted engine, the harness loop, or
 * undefined while the engine is not known yet.
 */
export type ModelMenuScope = (typeof HOSTED_ENGINE_IDS)[number] | 'in-process' | undefined

/** The subset of a provider group this module reads. */
export interface ModelGroupLike {
  readonly id: string
}

/** The subset of `ModelDirectoryState` this module reads and rewrites. */
export interface ModelDirectoryStateLike {
  readonly groups: readonly ModelGroupLike[]
  readonly failures: readonly ModelGroupLike[]
  readonly [key: string]: unknown
}

/** The store face both the selector and this module use. */
export interface DirectoryStoreLike {
  getSnapshot(): unknown
  subscribe(listener: () => void): () => void
}

/** One per-session model directory. */
export interface ModelDirectoryLike {
  readonly store: DirectoryStoreLike
}

/** The host client service this module wraps. */
export interface ModelDirectoryResolverLike {
  directoryFor(sessionId: string): ModelDirectoryLike
}

/**
 * The menu scope one session's engine report names.
 *
 * A hosted id scopes to that engine; `in-process` (and any report whose engine is
 * not a hosted id) scopes to no engine group at all; an absent report is
 * "unknown", which must not hide anything yet.
 * @param report - the session-engine cache's answer, when it has one.
 * @returns the scope to render.
 */
export function modelMenuScope(report: SessionEngineReport | undefined): ModelMenuScope {
  if (report === undefined) return undefined
  // `legacy`/`unset` name no engine (and predate presets): leave the menu global
  // rather than guessing which group belongs to them.
  if (report.engine.kind !== 'engine') return undefined
  return report.engine.engine === 'in-process' ? 'in-process' : report.engine.engine
}

/**
 * Keep the groups a session may pick from: its own engine's group, plus every
 * group that is not a hosted engine's catalog.
 *
 * Object identity is preserved when nothing is dropped, which is what lets the
 * caller's snapshot cache work.
 * @param state - the directory's raw snapshot.
 * @param scope - the session's menu scope.
 * @returns the scoped snapshot (the same object when nothing is filtered).
 */
export function scopeModelDirectoryState<T extends ModelDirectoryStateLike>(
  state: T,
  scope: ModelMenuScope,
): T {
  if (scope === undefined) return state
  const engines = new Set<string>(HOSTED_ENGINE_IDS)
  const keep = (id: string): boolean => {
    if (engines.has(id)) return id === scope
    // The shared placeholder route only makes sense for a hosted session. An
    // in-process session must not be offered a model whose adapter fails loud.
    if (id === HOSTED_ROUTE_LABEL) return scope !== 'in-process'
    return true
  }
  const groups = state.groups.filter(group => keep(group.id))
  const failures = state.failures.filter(failure => keep(failure.id))
  if (groups.length === state.groups.length && failures.length === state.failures.length) return state
  return { ...state, groups, failures }
}

/**
 * Wrap the host's per-session directory factory so every selector renders the
 * session's own engine group only.
 *
 * Best-effort by design: a Host generation without `modelDirectories` (or with a
 * different service shape) is left alone rather than failing the whole client
 * plugin — the menu then behaves exactly as before this module existed.
 * @param ctx - the client root context.
 * @param engines - the plugin's per-session engine cache.
 */
export function installModelCatalogScope(ctx: ClientContext, engines: SessionEngineCache): void {
  ctx.inject(['modelDirectories'], (scope: ClientContext) => {
    const resolver = (scope as unknown as { modelDirectories?: ModelDirectoryResolverLike }).modelDirectories
    if (resolver === undefined || typeof resolver.directoryFor !== 'function') return
    const patched = new WeakSet<object>()
    const original = resolver.directoryFor.bind(resolver)
    try {
      resolver.directoryFor = (sessionId: string): ModelDirectoryLike => {
        const directory = original(sessionId)
        if (!patched.has(directory)) {
          patched.add(directory)
          // A host build whose store is not writable keeps its previous (global)
          // menu: a missing scope is cosmetic, a thrown patch is a broken page.
          try {
            patchDirectory(directory, sessionId, engines)
          } catch {
            // Leave this directory unscoped.
          }
        }
        return directory
      }
    } catch {
      // The service is frozen in this host build; keep the global menu.
    }
  })
}

/**
 * Scope one directory's store in place.
 *
 * `getSnapshot` returns a cached object per `(raw, scope)` pair; `subscribe`
 * combines the store's own notifications with the engine cache's, so a switch
 * re-renders the menu even though the raw catalog did not change.
 * @param directory - the per-session directory to wrap.
 * @param sessionId - the session whose engine scopes it.
 * @param engines - the plugin's per-session engine cache.
 */
function patchDirectory(
  directory: ModelDirectoryLike,
  sessionId: string,
  engines: SessionEngineCache,
): void {
  const store = directory.store
  const rawSnapshot = store.getSnapshot.bind(store)
  const rawSubscribe = store.subscribe.bind(store)
  let lastRaw: unknown
  let lastScope: ModelMenuScope
  let lastScoped: unknown
  store.getSnapshot = (): unknown => {
    const raw = rawSnapshot() as ModelDirectoryStateLike
    const scope = modelMenuScope(engines.read(sessionId))
    if (raw === lastRaw && scope === lastScope) return lastScoped
    lastRaw = raw
    lastScope = scope
    lastScoped = scopeModelDirectoryState(raw, scope)
    return lastScoped
  }
  store.subscribe = (listener: () => void): (() => void) => {
    const stopStore = rawSubscribe(listener)
    // `watch` re-reads the engine on the first watcher and notifies when the
    // answer changes; that is the event a switch would otherwise never deliver.
    const stopEngine = engines.watch(sessionId, listener)
    return () => {
      stopStore()
      stopEngine()
    }
  }
}
