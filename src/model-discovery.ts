/**
 * Runtime model discovery: asking an engine what its subscription serves, without
 * breaking the plugin's "booting the harness starts no external process" contract.
 *
 * ## Why this exists
 *
 * The registry DECLARES each engine's model catalog, because probing one means
 * spawning the engine and a plugin that spawns ten CLIs at boot is a plugin nobody
 * can start. The cost of that decision was real: when a vendor shipped a new model,
 * the list in `engine-registry.ts` went stale, and a user saw the new model only
 * after a plugin release. That is a maintenance burden on the maintainer and a
 * stale menu for everyone else.
 *
 * This module removes the burden WITHOUT reintroducing the boot cost, by splitting
 * discovery into two kinds:
 *
 *   - **FREE discovery** — the answer is already on disk or already in a frame the
 *     driver received. Reading `~/.kimi-code/config.toml` spawns nothing; the
 *     model list inside a `session/new` response was paid for by a session the user
 *     opened anyway. These run whenever a catalog is asked for.
 *   - **COSTLY discovery** — it needs a new child process (`grok models`,
 *     `agy models`). Those are NOT run here: they belong behind an explicit refresh,
 *     which is the caller's decision rather than something a menu render triggers.
 *
 * ## Precedence, and why declared stays
 *
 * A discovered catalog wins over the declared one when it is non-empty, because it
 * describes the account RIGHT NOW. The declared catalog remains as the fallback for
 * when discovery is impossible (CLI absent, not signed in, subscription lapsed) —
 * so the menu is never empty and a deployment with no config file still works.
 *
 * A stale DECLARED id fails loudly at the engine; a stale DISCOVERED one cannot,
 * because it came from the engine itself.
 *
 * @module dsh-loop-engine-allinone/model-discovery
 */

import type { EngineModel } from './engine-registry.ts'

/**
 * One discovered catalog, with where it came from.
 *
 * The provenance travels because the settings page shows it: "these came from the
 * engine's own config" and "these are the plugin's declared fallback" are different
 * claims, and a user debugging a missing model needs to know which one they are
 * looking at.
 */
export interface DiscoveredCatalog {
  /** The models the engine's own state says this account can use. */
  readonly models: readonly EngineModel[]
  /** Where they were read from, for the settings page and for diagnostics. */
  readonly source: 'kimi-config' | 'acp-session' | 'codex-binary'
}

/**
 * Read a TOML `[models."<provider>/<id>"]` block set into model entries.
 *
 * The Kimi Code app writes one block per provisioned model, each carrying the
 * vendor's own `display_name` and its `model` id:
 *
 * ```toml
 * [models."kimi-code/k3"]
 * model = "k3"
 * display_name = "K3"
 * ```
 *
 * A minimal parser rather than a TOML dependency: this reads exactly two keys out of
 * a file this project does not own, and a dependency for that would be a larger
 * liability than the twenty lines below. Anything it does not recognize is skipped,
 * so a config format change degrades to "no discovered models" (and the declared
 * fallback applies) rather than throwing.
 * @param text - the config file's contents.
 * @returns the models, in file order, deduplicated by id.
 */
export function parseKimiConfigModels(text: string): readonly EngineModel[] {
  const models: EngineModel[] = []
  const seen = new Set<string>()
  let currentId: string | undefined
  let currentLabel: string | undefined

  /** Commit the block being read, if it named a model. */
  const flush = (): void => {
    if (currentId !== undefined && !seen.has(currentId)) {
      seen.add(currentId)
      models.push({ id: currentId, label: currentLabel ?? currentId })
    }
    currentId = undefined
    currentLabel = undefined
  }

  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      flush()
      // `[models."kimi-code/k3"]` - the id inside the quotes is the block's key.
      const header = /^\[models\."([^"]+)"\]$/u.exec(line)
      if (header !== null) {
        // The key is `<provider>/<id>`; the id is what the engine's `model` takes.
        const key = header[1]!
        const slash = key.indexOf('/')
        currentId = slash === -1 ? key : key.slice(slash + 1)
      }
      continue
    }
    if (currentId === undefined) continue
    const label = /^display_name\s*=\s*"([^"]*)"/u.exec(line)
    if (label !== null) currentLabel = label[1]
  }
  flush()
  return models
}

/**
 * Read a model catalog out of an ACP `session/new` result's `configOptions`.
 *
 * ACP agents publish their session options at `session/new`; a `model` option
 * carries the engine's own composite ids plus the labels it wants rendered
 * (measured on MiniMax Code: `m:minimax:MiniMax-M3:v:thinking` -> `M3 · thinking`).
 * That list cost the user nothing extra - it arrived with a session they opened.
 * @param configOptions - the `configOptions` array from a `session/new` result.
 * @returns the models, or undefined when the frame carried no model option.
 */
export function modelsFromAcpConfigOptions(configOptions: unknown): readonly EngineModel[] | undefined {
  if (!Array.isArray(configOptions)) return undefined
  for (const option of configOptions) {
    const entry = option as { id?: unknown, options?: unknown } | undefined
    if (entry?.id !== 'model' || !Array.isArray(entry.options)) continue
    const models: EngineModel[] = []
    for (const candidate of entry.options) {
      const value = (candidate as { value?: unknown } | undefined)?.value
      if (typeof value !== 'string' || value === '') continue
      const name = (candidate as { name?: unknown } | undefined)?.name
      models.push({ id: value, label: typeof name === 'string' && name !== '' ? name : value })
    }
    return models.length === 0 ? undefined : models
  }
  return undefined
}

/**
 * Pick the catalog a surface should render for one engine.
 *
 * Discovered wins when non-empty; the declared list is the fallback. Both being
 * absent is the engine's own "I have no catalog" answer, which the model menu
 * renders as the shared `external` group.
 * @param discovered - what runtime discovery found, if anything.
 * @param declared - the registry's declaration, if any.
 * @returns the models to render, and which of the two produced them.
 */
export function effectiveCatalog(
  discovered: DiscoveredCatalog | undefined,
  declared: readonly EngineModel[] | undefined,
): { models: readonly EngineModel[], origin: 'discovered' | 'declared' | 'none' } {
  if (discovered !== undefined && discovered.models.length > 0) {
    return { models: discovered.models, origin: 'discovered' }
  }
  if (declared !== undefined && declared.length > 0) {
    return { models: declared, origin: 'declared' }
  }
  return { models: [], origin: 'none' }
}
