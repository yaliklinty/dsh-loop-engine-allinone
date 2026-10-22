/**
 * Per-session scoping of the browser model menu.
 *
 * ## The problem
 *
 * The harness builds ONE model catalog per Host generation
 * (`packages/api/session-controller/src/catalog.ts` `buildModelCatalog`): it has
 * no session argument, and every selector in every session reads the same
 * groups. This plugin registers one provider route per engine that declares a
 * catalog, so without scoping every session's menu lists every engine's
 * subscription models — picking one in a session of another engine is the
 * cross-engine refusal the drivers already report, but the menu should not offer
 * it at all. A session on the harness loop has no engine group of its own, so it
 * must not be shown any engine's subscription either.
 *
 * ## What this module does
 *
 * The catalog cannot be filtered on the Host (it is global and cached), but the
 * per-session `ModelDirectory` CAN: the client's model selector reads one
 * directory per session, and that directory's store is the data the menu renders.
 * This module wraps `ctx.modelDirectories.directoryFor` and scopes the store's
 * snapshot to the session's own engine:
 *
 *  - a session running a hosted engine keeps that engine's group (plus the
 *    shared placeholder route and every non-engine provider group: DeepSeek,
 *    `llm-pi-ai`, …);
 *  - the harness loop (`in-process`) keeps only the non-engine groups — it has no
 *    engine subscription of its own, so none of the CLI catalogs may appear;
 *  - an unknown engine (the read has not answered yet) is left unscoped rather
 *    than guessed — the menu shows the global list for that instant, then the
 *    engine answer arrives and the watch re-renders it scoped;
 *  - a scope that would leave NO group at all falls back to the raw catalog, so a
 *    deployment without a native provider still keeps a usable model seat.
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
 * ## Why the wrapper binds the raw service, not the traceable proxy
 *
 * `ctx.modelDirectories` is a Cordis traceable proxy: a method called through it
 * runs with `this.ctx` rebound to the CALLER's context. A third-party plugin's
 * context does not inject `remote.session`, so calling the wrapped
 * `directoryFor` through that proxy throws `cannot get property "remote.session"
 * without inject` before it can return a directory. That is why 0.7.8/0.7.9 lost
 * the composer's model seat. The fix is to call the implementation with `this`
 * bound to the REAL service object (`Symbol.for('cordis.original')`), whose
 * `ctx` is the ui-model-selection plugin context that injects `remote.session` —
 * exactly the context the unwrapped method always ran in.
 *
 * @module dsh-loop-engine-allinone/client/model-catalog-scope
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { HOSTED_ENGINE_IDS } from '../engine-registry.ts'
import { HOSTED_ROUTE_LABEL, type SessionEngineReport } from '../agent-preset-ids.ts'
import type { SessionEngineCache } from './session-engine.ts'

/** Cordis's key for the raw object behind a traceable service proxy. */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * The menu scope one session's engine report names: a hosted engine to narrow
 * to, `in-process` to hide every engine catalog, or `undefined` while unknown.
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
  set(state: unknown): void
  subscribe(listener: () => void): () => void
}

/** One per-session model directory. */
export interface ModelDirectoryLike {
  readonly store: DirectoryStoreLike
  /** Present on the host's directory; called when the session scope tears down. */
  dispose?(): void
}

/** The host client service this module wraps. */
export interface ModelDirectoryResolverLike {
  directoryFor(sessionId: string): ModelDirectoryLike
}

/**
 * The menu scope one session's engine report names.
 *
 * A hosted id scopes to that engine; `in-process` scopes to no engine catalog at
 * all; an absent report is "unknown", which must not hide anything yet.
 * @param report - the session-engine cache's answer, when it has one.
 * @returns the scope to render.
 */
export function modelMenuScope(report: SessionEngineReport | undefined): ModelMenuScope {
  if (report === undefined) return undefined
  // `legacy`/`unset` name no engine (and predate presets): leave the menu global
  // rather than guessing which group belongs to them.
  if (report.engine.kind !== 'engine') return undefined
  return report.engine.engine
}

/**
 * Keep the groups a session may pick from: its own engine's group plus every
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
    if (!engines.has(id)) {
      // The shared placeholder only makes sense for a hosted session. An
      // in-process session must not be offered a model whose adapter fails loud.
      if (id === HOSTED_ROUTE_LABEL) return scope !== 'in-process'
      return true
    }
    return id === scope
  }
  const groups = state.groups.filter(group => keep(group.id))
  const failures = state.failures.filter(failure => keep(failure.id))
  // Fail open when the filter would empty the menu: a deployment with no native
  // provider at all must keep a usable model seat rather than lose it.
  if (groups.length === 0) return state
  if (groups.length === state.groups.length && failures.length === state.failures.length) return state
  return { ...state, groups, failures }
}

/**
 * Wrap the host's per-session directory factory so every selector renders the
 * session's own engine group only.
 *
 * Best-effort: a Host without `modelDirectories` (or with a different shape) is
 * left alone rather than failing the whole client plugin — the menu then behaves
 * exactly as before this module existed.
 * @param ctx - the client root context.
 * @param engines - the plugin's per-session engine cache.
 */
export function installModelCatalogScope(ctx: ClientContext, engines: SessionEngineCache): void {
  ctx.inject(['modelDirectories'], (scope: ClientContext) => {
    const resolver = (scope as unknown as { modelDirectories?: ModelDirectoryResolverLike }).modelDirectories
    if (resolver === undefined || typeof resolver.directoryFor !== 'function') return
    // The traceable proxy rebinds `this.ctx` to the caller (this plugin), which
    // does not inject `remote.session`; strip to the raw service before wrapping.
    // A host whose service is not proxy-wrapped offers no raw object — leave its
    // menu global rather than call a method that would throw on every render.
    const target = rawServiceOf(resolver)
    if (target === resolver) return
    const original = target.directoryFor
    if (typeof original !== 'function') return
    const patched = new WeakSet<object>()
    try {
      target.directoryFor = (sessionId: string): ModelDirectoryLike => {
        const directory = original.call(target, sessionId)
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

/** The raw object behind a Cordis traceable proxy (the proxy itself otherwise). */
function rawServiceOf<T extends object>(value: T): T {
  const original = (value as unknown as Record<PropertyKey, unknown>)[CORDIS_ORIGINAL]
  const usable = original !== null && (typeof original === 'object' || typeof original === 'function')
  return (usable ? original : value) as T
}

/**
 * Scope one directory's store in place.
 *
 * `getSnapshot` returns a cached object per `(raw, scope)` pair; the engine
 * watch hands the store a fresh raw copy when the session's engine changes, so
 * the untouched subscribers (React's `useSyncExternalStore` included) hear it
 * without this module replacing the store object itself.
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
  // One watch per directory (never per subscriber): an engine switch wakes the
  // store's own subscribers through `set`, and the next `getSnapshot` re-filters.
  const stopWatch = engines.watch(sessionId, () => {
    try {
      store.set({ ...(rawSnapshot() as object) })
    } catch {
      // A frozen store keeps the previous menu rather than throwing in a listener.
    }
  })
  // The directory is disposed with its session scope; drop the engine watch with
  // it so a long page does not accumulate one watcher per closed session.
  const dispose = directory.dispose
  if (typeof dispose === 'function') {
    try {
      directory.dispose = () => {
        stopWatch()
        dispose.call(directory)
      }
    } catch {
      // A non-writable instance keeps its watcher; the cache is page-scoped.
    }
  }
}
