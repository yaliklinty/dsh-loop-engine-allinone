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
 * @module tests/engine-drivers
 */

import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { ENGINE_DRIVER_FACTORIES } from '../src/engine-drivers.ts'
import { HOSTED_ENGINE_IDS } from '../src/engine-registry.ts'

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
