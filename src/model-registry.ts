/**
 * Runtime model discovery, wired to the provider routes.
 *
 * ## The timing problem this solves
 *
 * Routes are registered at APPLY (plugin boot), but discovery only produces an
 * answer once an engine has run: an ACP catalog arrives in `session/new`, and a
 * config file exists only after the app has been used. So boot cannot wait for it.
 *
 * The resolution is: boot registers each engine's route from what is knowable then
 * (the declared catalog, or a FREE disk read), and a later discovery REPLACES that
 * route's model list in place. `registerAdapter` is not re-called - the adapter
 * object is asked for its models on every catalog build, so swapping the list it
 * holds is what makes a newly discovered model appear without a restart.
 *
 * ## What is free, and what is not
 *
 * - `kimi`: read `~/.kimi-code/config.toml`. No process, safe at boot.
 * - any ACP engine: the catalog in `session/new`'s `configOptions`, already paid
 *   for by the session the user opened.
 * - `codex`: the ids are static in the bundled binary; declared, not probed.
 * - `grok` / `agy`: would need `grok models` / `agy models`, i.e. a NEW child
 *   process. Not run here on purpose - the plugin still starts no external process
 *   to build a menu. Those stay declared.
 *
 * @module dsh-loop-engine-allinone/model-registry
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINE_REGISTRY, type EngineDescriptor, type EngineModel, type HostedEngineId } from './engine-registry.ts'
import { kimiHomeDir } from './engine-kimi/process.ts'
import { parseKimiConfigModels, type DiscoveredCatalog } from './model-discovery.ts'

/**
 * The live catalog per engine, mutable so a discovery can replace it.
 *
 * The provider route holds a REFERENCE to this map's value, not a copy, which is
 * what makes an update visible to the next catalog build.
 */
const discovered = new Map<HostedEngineId, DiscoveredCatalog>()

/**
 * Read Kimi's catalog from the app's own config, if the file is there.
 *
 * Free: one `readFileSync`, no child process. A missing or unreadable file is not
 * an error - it means "this host has not used Kimi Code", and the declared catalog
 * applies.
 * @returns the catalog, or undefined when there is nothing to read.
 */
export function discoverKimiCatalog(): DiscoveredCatalog | undefined {
  try {
    const text = readFileSync(join(kimiHomeDir(), 'config.toml'), 'utf8')
    const models = parseKimiConfigModels(text)
    return models.length === 0 ? undefined : { models, source: 'kimi-config' }
  } catch {
    return undefined
  }
}

/**
 * Record a catalog an engine published at runtime (an ACP `session/new`).
 * @param engine - the engine that published it.
 * @param models - the models it published.
 */
export function recordDiscoveredCatalog(engine: HostedEngineId, models: readonly EngineModel[]): void {
  if (models.length === 0) return
  discovered.set(engine, { models, source: 'acp-session' })
}

/**
 * The catalog to register a route with at boot: discovered-if-free, else declared.
 *
 * Only the FREE sources are consulted here, so apply never spawns anything.
 * @param engine - the engine whose route is being registered.
 * @returns the models to advertise, and where they came from.
 */
export function bootCatalog(engine: HostedEngineId): { models: readonly EngineModel[], origin: 'discovered' | 'declared' | 'none' } {
  const free = engine === 'kimi' ? discoverKimiCatalog() : undefined
  if (free !== undefined) discovered.set(engine, free)
  const declared = declaredModels(engine)
  if (free !== undefined) return { models: free.models, origin: 'discovered' }
  if (declared !== undefined && declared.length > 0) return { models: declared, origin: 'declared' }
  return { models: [], origin: 'none' }
}

/**
 * The catalog to render RIGHT NOW for one engine.
 *
 * A route asks this on every catalog build, so a discovery made after boot shows up
 * without a restart.
 * @param engine - the engine whose catalog is wanted.
 * @returns the live models, discovered taking precedence over declared.
 */
export function liveCatalog(engine: HostedEngineId): readonly EngineModel[] {
  const found = discovered.get(engine)
  if (found !== undefined && found.models.length > 0) return found.models
  /* v8 ignore start -- every registry row declares a models catalog, so the empty fallback is defensive */
  return declaredModels(engine) ?? []
  /* v8 ignore stop */
}

/** What one engine's catalog currently is, and where it came from. */
export interface CatalogReport {
  readonly engine: HostedEngineId
  readonly models: readonly EngineModel[]
  readonly origin: 'discovered' | 'declared' | 'none'
  /** Where a discovered catalog was read from; absent for a declared one. */
  readonly source?: DiscoveredCatalog['source']
}

/**
 * Every engine's catalog with its provenance, for the settings page and diagnostics.
 * @returns one report per engine that has any catalog.
 */
export function catalogReport(): readonly CatalogReport[] {
  const reports: CatalogReport[] = []
  for (const engine of Object.keys(ENGINE_REGISTRY) as HostedEngineId[]) {
    const found = discovered.get(engine)
    const declared = declaredModels(engine)
    if (found !== undefined && found.models.length > 0) {
      reports.push({ engine, models: found.models, origin: 'discovered', source: found.source })
      continue
    }
    if (declared !== undefined && declared.length > 0) {
      reports.push({ engine, models: declared, origin: 'declared' })
    }
  }
  return reports
}

/**
 * One engine's DECLARED catalog, read through {@link EngineDescriptor}.
 *
 * The table is `as const satisfies`, so a row that declares no `models` does not
 * carry the key at all and a direct read does not type-check across the union.
 * @param engine - the engine whose declaration is wanted.
 * @returns the declared models, or undefined when the row declares none.
 */
function declaredModels(engine: HostedEngineId): readonly EngineModel[] | undefined {
  const descriptor: EngineDescriptor = ENGINE_REGISTRY[engine]
  return descriptor.models
}
