/**
 * The engine registry's contract, and the derivation it promises.
 *
 * `src/engine-registry.ts` is the one table every engine-shaped decision reads.
 * These tests pin the two properties that make it worth having: the roster is
 * single-sourced (nothing restates it), and the derivations actually derive
 * (adding a row changes what the settings schema, the preset ids and the
 * browser half answer).
 *
 * The "nothing restates it" half is asserted against the SOURCE TEXT of the
 * modules that used to carry their own copy, because the failure mode is silent
 * — a hardcoded list that happens to agree with the registry today drifts the
 * moment an engine is added, and no behavioural test would notice.
 *
 * @module tests/engine-registry
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  ENGINE_DESCRIPTORS, ENGINE_REGISTRY, HOSTED_ENGINE_IDS, LOOP_ENGINE_IDS,
  descriptorOf, descriptorOfOptional, isHostedEngine, isLoopEngineId,
} from '../src/engine-registry.ts'
import { enginePresetId, HOSTED_PRESET_PREFIX, SOURCE_PRESET_ID } from '../src/agent-preset-ids.ts'

async function source(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

describe('the engine registry is the single source of the roster', () => {
  it('covers every hosted id exactly once, in the declared order', () => {
    expect(Object.keys(ENGINE_REGISTRY)).toEqual([...HOSTED_ENGINE_IDS])
    expect(ENGINE_DESCRIPTORS.map(descriptor => descriptor.id)).toEqual([...HOSTED_ENGINE_IDS])
  })

  it('keeps `in-process` out of the registry', () => {
    // `in-process` is the harness's own loop, not something this plugin hosts:
    // it has no binary, no protocol and no capabilities to declare. Keeping it
    // out is what lets the registry be a TOTAL record over the hosted ids, which
    // is the exhaustiveness check every other site leans on.
    expect(LOOP_ENGINE_IDS).toEqual(['in-process', ...HOSTED_ENGINE_IDS])
    expect(Object.keys(ENGINE_REGISTRY)).not.toContain('in-process')
    expect(isLoopEngineId('in-process')).toBe(true)
    expect(isHostedEngine('in-process')).toBe(false)
  })

  it('resolves descriptors by id, and refuses anything unhosted', () => {
    for (const id of HOSTED_ENGINE_IDS) {
      expect(descriptorOf(id).id).toBe(id)
      expect(descriptorOfOptional(id)).toBe(ENGINE_REGISTRY[id])
    }
    expect(descriptorOfOptional('in-process')).toBeUndefined()
    expect(descriptorOfOptional(undefined)).toBeUndefined()
  })

  it('gives every engine the fields the surfaces read', () => {
    for (const descriptor of ENGINE_DESCRIPTORS) {
      expect(descriptor.label.length, descriptor.id).toBeGreaterThan(0)
      expect(descriptor.localeKey, descriptor.id).toMatch(/^engine[A-Z]/)
      // Every engine is reachable as a session preset, so every engine needs the
      // two argv facts the settings page's engine-management area renders.
      expect(descriptor.capabilities.protocol, descriptor.id).toMatch(/^(ndjson|jsonrpc|acp|text)$/)
      expect(typeof descriptor.bundled, descriptor.id).toBe('boolean')
    }
  })

  it('never lets a bundled engine carry a runtime updater', () => {
    // A bundled engine's version is this package's dependency pin, so upgrading
    // it means changing the dependency and reinstalling — never running the
    // CLI's own updater at runtime, which would rewrite a dependency in place.
    // The rule is asserted here rather than trusted to review.
    for (const descriptor of ENGINE_DESCRIPTORS) {
      if (descriptor.bundled) expect(descriptor.updateArgv, descriptor.id).toBeUndefined()
    }
  })

  it('gives every external engine a bin key and an update path', () => {
    // An external CLI is one the deployment installs and upgrades itself, so the
    // plugin must be able to (a) be pointed at it and (b) tell the user how to
    // upgrade it. Both are what separate "external" from "bundled" in the UI.
    for (const descriptor of ENGINE_DESCRIPTORS) {
      if (descriptor.bundled) continue
      expect(descriptor.binConfigKey, descriptor.id).toBeTruthy()
      expect(descriptor.updateArgv, descriptor.id).toBeTruthy()
      expect(descriptor.loginHint, descriptor.id).toBeTruthy()
    }
  })

  it('keeps every engine preset id distinct and off the legacy id', () => {
    const ids = HOSTED_ENGINE_IDS.map(engine => enginePresetId(engine))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every(id => id.startsWith(HOSTED_PRESET_PREFIX))).toBe(true)
    expect(ids).not.toContain('loop-engine')
    expect(enginePresetId('in-process')).toBe(SOURCE_PRESET_ID)
  })
})

describe('the roster is not restated anywhere', () => {
  it('leaves no hardcoded engine list in the client half', async () => {
    // The browser half used to carry its own option list and its own
    // label-key switch, which is how "the settings page offers an engine the
    // node half cannot build" became possible. Both now derive from the
    // registry, and this is the regression pin.
    for (const path of [
      '../src/client/LoopEngineSection.tsx',
      '../src/client/LoopEngineComposerSelect.tsx',
      '../src/client/locales.ts',
      '../src/client/store.ts',
    ] as const) {
      const text = await source(path)
      expect(text, path).not.toMatch(/['"]claude-code['"]\s*,/)
      expect(text, path).not.toMatch(/engine:\s*['"](?:claude-code|codex|pi|kimi|agy|zcode|qoderclicn|hermes)['"]/)
    }
  })

  it('leaves no hardcoded engine roster in the settings schema', async () => {
    const text = await source('../src/settings.ts')
    expect(text).not.toMatch(/z\.union\(\[[^\]]*['"](?:claude-code|codex|kimi|agy)['"]/)
  })
})

describe('the handover matrix', () => {
  it('declares, per engine, whether a dsh model can be handed to it', () => {
    // Pinned because the settings page, the refusal message, and the published
    // compatibility table all quote this. The three ACP engines are additionally
    // checked against their real profiles in `engine-grok`/`kimi`/`minimaxcode`.
    const expected: Record<string, boolean> = {
      'claude-code': true,
      codex: true,
      pi: true,
      kimi: true,
      grok: true,
      minimaxcode: true,
      agy: true,
      zcode: false,
      qoderclicn: false,
      hermes: true,
    }
    for (const [engine, capable] of Object.entries(expected)) {
      expect(ENGINE_REGISTRY[engine as keyof typeof ENGINE_REGISTRY].capabilities.modelHandover)
        .toBe(capable)
    }
    // Every declared engine answers, so a new row cannot silently omit it.
    expect(Object.keys(ENGINE_REGISTRY)).toHaveLength(Object.keys(expected).length)
  })
})
