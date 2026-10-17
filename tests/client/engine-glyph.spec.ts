/**
 * The engine marks: every hosted engine has its OWN vendor mark, and only
 * `in-process` carries the DeepSeek fish.
 *
 * This is a regression pin with a specific history. Four engines were added to
 * the registry while the mark switch still knew four, so `agy`, `zcode`,
 * `qoderclicn` and `hermes` all fell through `default` and rendered the harness's
 * own fish beside their names — the plugin was claiming four vendors' CLIs were
 * DeepSeek's. Then, once each had a hand-drawn stand-in, the marks turned out not
 * to resemble the real ones, so they were replaced with paths traced or measured
 * from the vendors' own artwork.
 *
 * The data now lives in its own zero-import module (`./engine-marks.ts`), so the
 * assertions below are REAL imports. The composer component itself cannot be
 * imported here: it pulls `@deepseek-ai/dsh-client-ui-primitives`, whose React
 * resolution escapes the node test alias.
 *
 * @module tests/client/engine-glyph
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { ENGINE_MARKS } from '../../src/client/engine-marks.ts'
import { HOSTED_ENGINE_IDS } from '../../src/engine-registry.ts'

/** The carriage-return character, so this file needs no escape sequences. */
const CR = String.fromCharCode(13)

describe('ENGINE_MARKS', () => {
  it('covers exactly the hosted roster', () => {
    expect(Object.keys(ENGINE_MARKS).sort()).toEqual([...HOSTED_ENGINE_IDS].sort())
  })

  it('leaves `in-process` out, so the fish is the only in-process mark', () => {
    expect(Object.keys(ENGINE_MARKS)).not.toContain('in-process')
  })

  it('gives every engine real path data and a viewBox', () => {
    for (const engine of HOSTED_ENGINE_IDS) {
      const mark = ENGINE_MARKS[engine]
      expect(mark.d.startsWith('M'), engine).toBe(true)
      expect(mark.d.length, engine).toBeGreaterThan(40)
      expect(mark.viewBox, engine).toMatch(/^-?\d+(\.\d+)? -?\d+(\.\d+)? \d+(\.\d+)? \d+(\.\d+)?$/)
      // A path that never draws a curve or a corner is a placeholder, not a mark.
      expect(/[LCHVAZ]/.test(mark.d), engine).toBe(true)
    }
  })

  it('gives no two engines the same drawing', () => {
    const paths = HOSTED_ENGINE_IDS.map(engine => ENGINE_MARKS[engine].d)
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('names a fill rule only where the shape needs one', () => {
    for (const engine of HOSTED_ENGINE_IDS) {
      expect([undefined, 'nonzero', 'evenodd'], engine).toContain(ENGINE_MARKS[engine].fillRule)
    }
  })
})

describe('the composer’s mark renderer', () => {
  it('reserves the DeepSeek fish for in-process', async () => {
    // The one invariant that needs the component's own text: `FishLogo` may sit
    // behind the `in-process` guard and nowhere else.
    const raw = await readFile(new URL('../../src/client/LoopEngineComposerSelect.tsx', import.meta.url), 'utf8')
    const text = raw.split(CR).join('')
    const body = text.slice(text.indexOf('export function engineGlyph('))
    const markAt = body.indexOf('const mark = ENGINE_MARKS')
    expect(markAt, 'the renderer must read its marks from the data module').toBeGreaterThan(-1)
    const guard = body.slice(0, markAt)
    expect(guard).toContain("engine === 'in-process'")
    expect(guard).toContain('<FishLogo')
    // Everything after the guard renders the data module, so no other engine can
    // reach the fish.
    expect(body.slice(markAt)).not.toContain('<FishLogo')
  })
})
