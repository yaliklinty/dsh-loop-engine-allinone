/**
 * The driver dispatch table and its executable-override resolution.
 *
 * Two facts matter here. The table is TOTAL over the hosted ids, which is what
 * makes "registered an engine but forgot its driver" a compile error rather than
 * an engine that appears in the picker and cannot be built. And the executable
 * override has a compatibility rule: `bins.<key>` is the registry-era spelling
 * and `kimiBin` is the published field it replaces, so a deployment that set the
 * old one must keep selecting the binary it chose.
 *
 * The second half of this file pins the OTHER thing the table does: every
 * factory projects the composition entry's flat knobs onto its engine's own
 * config shape. That projection is 60-odd `...cond === undefined ? {} : {…}`
 * spreads — mechanical, and therefore exactly the kind of code that silently
 * drops a knob during a refactor. Each row is asserted twice: with every knob
 * set, and with none, because "omitted means let the engine decide" is a
 * promise (`config.env ?? {}` and friends) and not an accident.
 *
 * @module tests/engine-drivers
 */

import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { ENGINE_DRIVER_FACTORIES, buildEngineDriver, type EngineDriverConfig } from '../src/engine-drivers.ts'
import { ENGINE_REGISTRY, HOSTED_ENGINE_IDS, descriptorOf } from '../src/engine-registry.ts'
import type { HostedEngineId } from '../src/engine-registry.ts'

describe('the driver table', () => {
  it('has one factory per hosted engine and no others', () => {
    expect(Object.keys(ENGINE_DRIVER_FACTORIES).sort()).toEqual([...HOSTED_ENGINE_IDS].sort())
  })

  it('exposes a factory for every id the registry declares', () => {
    // The same property the exhaustive `Record` type enforces, asserted at
    // runtime too: a cast could defeat the type, not this.
    for (const id of HOSTED_ENGINE_IDS) {
      expect(typeof ENGINE_DRIVER_FACTORIES[id], id).toBe('function')
    }
  })

  it('is the only module that imports the driver classes', async () => {
    // `index.ts` used to hold a per-engine `switch`, which meant every new engine
    // edited it. The table is now the single importer, and `index.ts` reads only
    // DATA from the engine modules (one approval-policy list, which is a schema
    // constant rather than a driver) plus the registry.
    const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    for (const driver of [
      'ClaudeCodeLoop', 'CodexLoop', 'PiLoop', 'KimiLoop',
      'AgyLoop', 'ZcodeLoop', 'QoderclicnLoop', 'HermesLoop',
    ]) {
      expect(text, driver).not.toContain(driver)
    }
  })

  it('derives the entry’s mode unions from the registry rather than restating them', async () => {
    // A permission mode an engine declares is a mode the composition entry must
    // accept; deriving it is what keeps the two from drifting.
    const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(text).toContain("ENGINE_REGISTRY['claude-code'].capabilities.permissionModes")
    expect(text).toContain('ENGINE_REGISTRY.codex.capabilities.permissionModes')
  })
})

/**
 * Every engine declares the bin knob this test writes to.
 *
 * Derived from the registry rather than restated: a new engine that omits
 * `binConfigKey` (it only ever runs the bundled copy) is skipped by the
 * override cases below, and one that adds it is picked up automatically.
 */
const BIN_ENGINES = HOSTED_ENGINE_IDS.filter(id => descriptorOf(id).binConfigKey !== undefined)

/** A context with just the subprocess service every CLI engine resolves lazily. */
function subprocessContext(): Context {
  const ctx = new Context()
  ctx.provide('subprocess', { spawn: vi.fn() })
  return ctx
}

/** Build one engine and hand back the config its runtime resolved. */
function build(id: HostedEngineId, config: EngineDriverConfig = {}): Record<string, unknown> {
  const runtime = ENGINE_DRIVER_FACTORIES[id](subprocessContext(), config)
  return (runtime as unknown as { config: Record<string, unknown> }).config
}

describe('the composition entry → engine config projection', () => {
  it('passes every knob of every engine through when all are set', () => {
    // One config object carrying EVERY engine's knobs at once: that is the
    // shape the composition entry really has (any session may select any
    // engine), and it is why each factory has to pick only its own fields.
    const everything: EngineDriverConfig = {
      permissionMode: 'bypassPermissions',
      env: { PROBE: 'set' },
      model: 'probe-model',
      disposeGraceMs: 4321,
      maxTurns: 7,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      piProvider: 'probe-provider',
      piThinking: 'high',
      childIdleMs: 999,
      agyMode: 'plan',
      agyEffort: 'max',
      agySandbox: true,
      agyDangerouslySkipPermissions: true,
      qoderPermissionMode: 'bypass_permissions',
      hermesReasoning: 'xhigh',
      bins: Object.fromEntries(BIN_ENGINES.map(id => [descriptorOf(id).binConfigKey!, `/pinned/${id}`])),
      regions: { mcodeRegion: 'en' },
    }

    expect(build('claude-code', everything)).toEqual({
      permissionMode: 'bypassPermissions',
      env: { PROBE: 'set' },
      model: 'probe-model',
      disposeGraceMs: 4321,
      maxTurns: 7,
      bin: '/pinned/claude-code',
    })
    expect(build('codex', everything)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      env: { PROBE: 'set' },
      model: 'probe-model',
      childIdleMs: 999,
      bin: '/pinned/codex',
    })
    expect(build('pi', everything)).toEqual({
      sandboxMode: 'workspace-write',
      provider: 'probe-provider',
      model: 'probe-model',
      thinkingLevel: 'high',
      env: { PROBE: 'set' },
      bin: '/pinned/pi',
    })
    expect(build('kimi', everything)).toEqual({
      model: 'probe-model',
      env: { PROBE: 'set' },
      bin: '/pinned/kimi',
      childIdleMs: 999,
    })
    expect(build('agy', everything)).toEqual({
      bin: '/pinned/agy',
      env: { PROBE: 'set' },
      model: 'probe-model',
      mode: 'plan',
      effort: 'max',
      sandbox: true,
      dangerouslySkipPermissions: true,
    })
    expect(build('zcode', everything)).toEqual({
      prefix: ['/pinned/zcode'],
      env: { PROBE: 'set' },
      model: 'probe-model',
    })
    expect(build('qoderclicn', everything)).toEqual({
      bin: '/pinned/qoderclicn',
      env: { PROBE: 'set' },
      model: 'probe-model',
      permissionMode: 'bypass_permissions',
    })
    expect(build('hermes', everything)).toEqual({
      bin: '/pinned/hermes',
      env: { PROBE: 'set' },
      model: 'probe-model',
      reasoning: 'xhigh',
    })
    expect(build('grok', everything)).toEqual({
      model: 'probe-model',
      env: { PROBE: 'set' },
      bin: '/pinned/grok',
      childIdleMs: 999,
    })
    expect(build('minimaxcode', everything)).toEqual({
      model: 'probe-model',
      env: { PROBE: 'set', MAVIS_REGION: 'en' },
      bin: '/pinned/minimaxcode',
      childIdleMs: 999,
    })
  })

  it('omits every knob that was not set, so the engine’s own default decides', () => {
    // The negative half of the projection: an absent key must stay absent.
    // `env` is the one exception — every engine resolves it to `{}`, because a
    // child needs a concrete environment rather than "the parent's, somehow".
    expect(build('claude-code')).toEqual({ env: {}, disposeGraceMs: 3000 })
    expect(build('codex')).toEqual({ env: {}, childIdleMs: 0 })
    expect(build('pi')).toEqual({ env: {} })
    expect(build('agy')).toEqual({ env: {} })
    expect(build('zcode')).toEqual({ prefix: ['zcode'], env: {} })
    expect(build('qoderclicn')).toEqual({ env: {} })
    expect(build('hermes')).toEqual({ env: {} })
    // The three engines whose resolver has a PATH/install fallback name it even
    // when the deployment pinned nothing.
    expect(build('kimi')).toEqual({ env: {}, bin: 'kimi', childIdleMs: 0 })
    expect(build('grok')).toEqual({ env: {}, bin: 'grok', childIdleMs: 0 })
    expect(build('minimaxcode')).toMatchObject({ env: { MAVIS_REGION: 'cn' }, childIdleMs: 0 })
  })

  it('treats an empty string as "not pinned" rather than as a path', () => {
    // A composition entry that writes `bin: ""` means "I did not decide", not
    // "run the executable named ''". Same for a region.
    for (const id of BIN_ENGINES) {
      const key = descriptorOf(id).binConfigKey!
      const resolved = build(id, { bins: { [key]: '' } })
      const selected = resolved.bin ?? (resolved.prefix as string[] | undefined)?.[0]
      // `undefined` is the correct answer for an engine that falls back to the
      // bundled copy (Claude Code); the others name their PATH entry.
      expect(selected, id).not.toBe('')
    }
    // Claude Code's resolver always spells `bin` (possibly `undefined`), because
    // its config type has no "absent means bundled" distinction: the SDK owns
    // the default and only an explicit path unbinds it.
    expect(build('claude-code', { bins: { claudeBin: '' } }).bin).toBeUndefined()
    expect(build('minimaxcode', { regions: { mcodeRegion: '' } })).toMatchObject({
      env: { MAVIS_REGION: 'cn' },
    })
  })

  it('prefers bins.<key> over the deprecated kimiBin spelling', () => {
    // Both set: the engine-agnostic form wins, because it is the one the
    // registry names. A deployment migrating between the two spellings must not
    // be surprised by the old one silently winning.
    expect(build('kimi', { bins: { kimiBin: '/new' }, kimiBin: '/old' })).toMatchObject({ bin: '/new' })
    // Only the old spelling set: it still selects the binary, which is the
    // whole point of keeping the alias.
    expect(build('kimi', { kimiBin: '/old' })).toMatchObject({ bin: '/old' })
    // An empty `bins.kimiBin` falls through to the alias rather than blocking it.
    expect(build('kimi', { bins: { kimiBin: '' }, kimiBin: '/old' })).toMatchObject({ bin: '/old' })
    // Neither: the engine's own PATH resolution.
    expect(build('kimi', {})).toMatchObject({ bin: 'kimi' })
  })

  it('rejects a region the CLI does not accept, and one that contradicts env', () => {
    // The region is a real account fact, so a wrong one must fail at
    // construction instead of producing a child that cannot see the account.
    expect(() => build('minimaxcode', { regions: { mcodeRegion: 'global' } }))
      .toThrow(/no region "global"/)
    expect(() => build('minimaxcode', { regions: { mcodeRegion: 'en' }, env: { MAVIS_REGION: 'cn' } }))
      .toThrow(/region "en" but env\.MAVIS_REGION is "cn"/)
  })

  it('builds the runtime the router asks for, through the one dispatch point', () => {
    // `buildEngineDriver` is what `index.ts`/`router-loop.ts` call; it must be
    // exactly the table lookup, for every id.
    for (const id of HOSTED_ENGINE_IDS) {
      const runtime = buildEngineDriver(id, subprocessContext(), {})
      expect((runtime as unknown as { config: unknown }).config, id).toBeDefined()
    }
  })

  it('surfaces the engine’s own missing-subprocess diagnostic, not a generic one', () => {
    // Each engine names itself, which is what makes the failure actionable in a
    // minimal profile. The ACP family names itself from its profile, the CLI
    // family from the engine id it was constructed with.
    const ctx = new Context()
    expect(() => ENGINE_DRIVER_FACTORIES.agy(ctx, {})).toThrow(/agy engine needs the dsh subprocess service/)
    expect(() => ENGINE_DRIVER_FACTORIES.kimi(ctx, {})).toThrow(/kimi engine needs the dsh subprocess service/)
  })

  it('keeps the registry and the table in step about which engines pin an executable', () => {
    // The registry row names the key; the factory reads it. A row that names a
    // key no factory reads would be a silent no-op knob.
    const keys = BIN_ENGINES.map(id => descriptorOf(id).binConfigKey!)
    expect(keys).toContain('claudeBin')
    expect(keys).toContain('minimaxcodeBin')
    expect(keys).toHaveLength(HOSTED_ENGINE_IDS.length)
    for (const id of HOSTED_ENGINE_IDS) {
      expect(ENGINE_REGISTRY[id].id, id).toBe(id)
    }
  })
})
