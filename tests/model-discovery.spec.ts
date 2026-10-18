/**
 * Runtime model discovery: the free kind, and what happens without it.
 *
 * The property that matters is not "it parses a file" — it is that a vendor
 * shipping a new model reaches the menu WITHOUT a plugin release, while the
 * plugin still starts no external process at boot. So these tests pin three
 * things: the two free readers, the precedence rule, and the fallback that keeps
 * the menu non-empty when discovery is impossible.
 *
 * @module tests/model-discovery
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  effectiveCatalog,
  modelsFromAcpConfigOptions,
  parseKimiConfigModels,
} from '../src/model-discovery.ts'
import { bootCatalog, catalogReport, discoverKimiCatalog, liveCatalog, recordDiscoveredCatalog } from '../src/model-registry.ts'
import { ENGINE_REGISTRY } from '../src/engine-registry.ts'

describe("parsing Kimi Code's config", () => {
  /** A config shaped like the one the Kimi Code app writes. */
  const CONFIG = `
default_model = "kimi-code/kimi-for-coding"

[providers."managed:kimi-code"]
base_url = "https://api.kimi.com/coding/v1"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 1048576
display_name = "K2.8 Preview"

[models."kimi-code/k3"]
model = "k3"
display_name = "K3"

[models."kimi-code/k3-256k"]
model = "k3-256k"
display_name = "K3-256k"
`

  it('reads one entry per model block, using the id the engine takes', () => {
    // The block KEY is `<provider>/<id>`; the id after the slash is what the app
    // passes as `model`, which is what this driver's session/set_model needs.
    expect(parseKimiConfigModels(CONFIG)).toEqual([
      { id: 'kimi-for-coding', label: 'K2.8 Preview' },
      { id: 'k3', label: 'K3' },
      { id: 'k3-256k', label: 'K3-256k' },
    ])
  })

  it('falls back to the id as the label when a block names no display name', () => {
    expect(parseKimiConfigModels('[models."p/x"]\nmodel = "x"\n'))
      .toEqual([{ id: 'x', label: 'x' }])
  })

  it('ignores every other table', () => {
    expect(parseKimiConfigModels('[providers."managed:kimi-code"]\nbase_url = "u"\n')).toEqual([])
  })

  it('returns nothing for an empty or unrelated file, rather than throwing', () => {
    // A config format change must degrade to "no discovered models", so the
    // declared fallback applies - never to a crash at boot.
    expect(parseKimiConfigModels('')).toEqual([])
    expect(parseKimiConfigModels('garbage\n[[[\n')).toEqual([])
  })

  it('deduplicates a repeated block', () => {
    const text = '[models."p/a"]\n[models."p/a"]\n'
    expect(parseKimiConfigModels(text)).toEqual([{ id: 'a', label: 'a' }])
  })
})

describe('reading a catalog out of an ACP session/new result', () => {
  it('takes the model option ids and labels', () => {
    // Measured on MiniMax Code: composite ids, and a `name` the menu renders.
    const options = [{
      id: 'model',
      options: [
        { value: 'm:minimax:MiniMax-M3:v:thinking', name: 'M3 · thinking' },
        { value: 'm:minimax:MiniMax-M3:v:', name: 'M3' },
      ],
    }]
    expect(modelsFromAcpConfigOptions(options)).toEqual([
      { id: 'm:minimax:MiniMax-M3:v:thinking', label: 'M3 · thinking' },
      { id: 'm:minimax:MiniMax-M3:v:', label: 'M3' },
    ])
  })

  it('is undefined when the frame published no model option', () => {
    expect(modelsFromAcpConfigOptions(undefined)).toBeUndefined()
    expect(modelsFromAcpConfigOptions([])).toBeUndefined()
    expect(modelsFromAcpConfigOptions([{ id: 'permissionMode', options: [{ value: 'auto' }] }])).toBeUndefined()
  })

  it('skips entries without a usable value, and drops an empty option list', () => {
    expect(modelsFromAcpConfigOptions([{ id: 'model', options: [{ name: 'no value' }] }])).toBeUndefined()
    expect(modelsFromAcpConfigOptions([{ id: 'model', options: [{ value: 'a', name: '' }] }]))
      .toEqual([{ id: 'a', label: 'a' }])
  })
})

describe('which catalog wins', () => {
  const declared = [{ id: 'declared-1', label: 'Declared' }]
  const found = { models: [{ id: 'found-1', label: 'Found' }], source: 'acp-session' as const }

  it('prefers what the engine reported, because it describes the account now', () => {
    expect(effectiveCatalog(found, declared)).toEqual({ models: found.models, origin: 'discovered' })
  })

  it('falls back to the declaration when discovery found nothing', () => {
    // The CLI is absent, unsigned, or lapsed - the menu must still show something.
    expect(effectiveCatalog(undefined, declared)).toEqual({ models: declared, origin: 'declared' })
    expect(effectiveCatalog({ models: [], source: 'kimi-config' }, declared))
      .toEqual({ models: declared, origin: 'declared' })
  })

  it('reports none when there is neither', () => {
    expect(effectiveCatalog(undefined, undefined)).toEqual({ models: [], origin: 'none' })
    expect(effectiveCatalog(undefined, [])).toEqual({ models: [], origin: 'none' })
  })
})

describe('the live registry', () => {
  it('boots each engine from its declaration when nothing is free to read', () => {
    // No Kimi config on the test host, so kimi's boot catalog is its declaration.
    const kimi = bootCatalog('kimi')
    expect(['declared', 'discovered']).toContain(kimi.origin)
    expect(kimi.models.length).toBeGreaterThan(0)
  })

  it('shows a discovered catalog immediately, with no restart', () => {
    // This is the whole point: a route registered at boot reads `liveCatalog`, so a
    // catalog published later (an ACP session/new) is visible on the next build.
    const before = liveCatalog('minimaxcode')
    recordDiscoveredCatalog('minimaxcode', [{ id: 'fresh-model', label: 'Fresh' }])
    const after = liveCatalog('minimaxcode')
    expect(after).toEqual([{ id: 'fresh-model', label: 'Fresh' }])
    expect(before).not.toEqual(after)
  })

  it('ignores an empty discovery, so a failed probe cannot blank the menu', () => {
    const before = liveCatalog('grok')
    recordDiscoveredCatalog('grok', [])
    expect(liveCatalog('grok')).toEqual(before)
  })

  it('reports provenance, because "declared" and "discovered" are different claims', () => {
    recordDiscoveredCatalog('grok', [{ id: 'grok-9', label: 'Grok 9' }])
    const report = catalogReport()
    const grok = report.find(entry => entry.engine === 'grok')
    expect(grok?.origin).toBe('discovered')
    expect(grok?.source).toBe('acp-session')
    // An engine with no catalog either way is absent, not an empty row.
    expect(report.every(entry => entry.models.length > 0)).toBe(true)
  })

  it('covers every engine that declares a catalog in the registry', () => {
    // A row added to the registry without reaching the report is a model menu that
    // silently lost a group.
    const declared = Object.entries(ENGINE_REGISTRY)
      .filter(([, descriptor]) => (descriptor as { models?: unknown }).models !== undefined)
      .map(([engine]) => engine)
    const reported = new Set(catalogReport().map(entry => entry.engine))
    for (const engine of declared) expect(reported.has(engine as never), engine).toBe(true)
  })
})

describe('keys and catalogs with nothing to report', () => {
  it('accepts a model key with no provider prefix', () => {
    // `[models."flat"]` is a key with no `/`; the id is the key itself. Slicing
    // at `indexOf('/') + 1` would return '' for it and drop the model.
    expect(parseKimiConfigModels('[models."flat"]\nmodel = "flat"\n'))
      .toEqual([{ id: 'flat', label: 'flat' }])
  })

  it('reports no discovered catalog when the config declares no model table', () => {
    // A config without a `[models."…"]` table is not an empty catalog: it is no
    // catalog, and the declared one must stay in force.
    expect(parseKimiConfigModels('model = "kimi-k2"\n')).toEqual([])
  })
})

describe('a config that declares no models', () => {
  it('reports no discovered catalog rather than an empty one', () => {
    // `discoverKimiCatalog` reads the app's own config. A config that exists but
    // lists no model table means "nothing to discover", NOT "this engine has no
    // models": returning an empty catalog would blank the menu.
    const home = mkdtempSync(join(tmpdir(), 'kimi-home-'))
    const previous = process.env.KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = home
    try {
      writeFileSync(join(home, 'config.toml'), 'default_model = "kimi-code/kimi-for-coding"\n', 'utf8')
      expect(discoverKimiCatalog()).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.KIMI_CODE_HOME
      else process.env.KIMI_CODE_HOME = previous
    }
  })
})
