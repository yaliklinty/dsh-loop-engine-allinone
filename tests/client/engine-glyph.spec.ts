/**
 * The engine marks: every hosted engine has its OWN, and only `in-process`
 * carries the DeepSeek fish.
 *
 * This is a regression pin with a specific history: four engines were added to
 * the registry while the mark switch still knew four, so `agy`, `zcode`,
 * `qoderclicn` and `hermes` all fell through `default` and rendered the
 * harness's own fish beside their names. The plugin was claiming those engines
 * were DeepSeek's.
 *
 * The composer component cannot be imported here — it pulls
 * `@deepseek-ai/dsh-client-ui-primitives`, which resolves React through its own
 * package path and is not aliased by the node test config — so this pins the
 * SWITCH at the source level, the same way `tests/agent-preset-ids.spec.ts` pins
 * a module's import shape. The assertion is exhaustive over the roster rather
 * than a list of the marks somebody remembered to add.
 *
 * @module tests/client/engine-glyph
 */

import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { HOSTED_ENGINE_IDS } from '../../src/engine-registry.ts'

/** The carriage-return character, spelled out to keep this file escape-free. */
const CR = String.fromCharCode(13)

/**
 * The composer module's source, read once, with line endings normalized.
 *
 * The normalization is not cosmetic: the checkout is CRLF, so the structural
 * searches below (which look for a line break then a brace) would silently miss
 * every boundary and the assertions would fail with a confusing negative index.
 */
async function composerSource(): Promise<string> {
  const text = await readFile(new URL('../../src/client/LoopEngineComposerSelect.tsx', import.meta.url), 'utf8')
  return text.split(CR).join('')
}

/**
 * The body of `engineGlyph`'s switch.
 *
 * Cut from the function's opening brace to the closing one at column 0, so a
 * `case` mentioned anywhere else in the file cannot satisfy the assertion.
 * @param text - the module source with normalized line endings.
 * @returns the switch body.
 */
function switchBody(text: string): string {
  const start = text.indexOf('export function engineGlyph(')
  expect(start, 'engineGlyph must exist and be exported for this pin').toBeGreaterThan(-1)
  const open = text.indexOf('{', text.indexOf(')', start))
  const close = text.indexOf('\n}\n', open)
  expect(close, 'engineGlyph must end at column 0').toBeGreaterThan(open)
  return text.slice(open, close)
}

describe('engineGlyph', () => {
  it('has a case of its own for every hosted engine', async () => {
    const body = switchBody(await composerSource())
    for (const engine of HOSTED_ENGINE_IDS) {
      expect(body, engine).toContain(`case '${engine}':`)
    }
  })

  it('falls through to the DeepSeek fish for in-process ONLY', async () => {
    // `default:` is the only branch that may render the harness's own mark: every
    // hosted engine must return before reaching it.
    const body = switchBody(await composerSource())
    const defaults = body.split('\n').filter(line => line.trim().startsWith('default:'))
    expect(defaults).toHaveLength(1)
    const defaultBranch = body.slice(body.indexOf('default:'))
    expect(defaultBranch).toContain('<FishLogo')

    // And no hosted engine's own arm may name the fish either.
    for (const engine of HOSTED_ENGINE_IDS) {
      const from = body.indexOf(`case '${engine}':`)
      const rest = body.slice(from + 1)
      const next = rest.search(/\n {4}(?:case |default:)/)
      const arm = next === -1 ? rest : rest.slice(0, next + 1)
      expect(arm, engine).not.toContain('<FishLogo')
    }
  })

  it('gives no two engines the same drawing', async () => {
    // A copy-pasted arm would make two engines indistinguishable on the trigger.
    const body = switchBody(await composerSource())
    const paths = [...body.matchAll(/d="([^"]{20,})"/g)].map(match => match[1]!)
    expect(paths.length).toBeGreaterThanOrEqual(HOSTED_ENGINE_IDS.length)
    expect(new Set(paths).size).toBe(paths.length)
  })
})
