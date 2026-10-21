/**
 * The failure arm of Qoder's private config root: a copy that fails must remove
 * the half-built root instead of leaving a directory holding a login copy behind.
 *
 * Kept in its own module because it has to replace `cp` for the whole import
 * graph, and the happy-path spec should exercise the real filesystem helpers.
 *
 * @module tests/engine-qoderclicn/model-handover-failure
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: vi.fn(async () => {
      throw new Error('copy failed')
    }),
  }
})

const { prepareQoderclicnHandover } = await import('../../src/engine-qoderclicn/model-handover.ts')

/** One resolved dsh endpoint, in the shape the shared resolver answers. */
const HANDOVER: DshModelHandover = {
  provider: 'meicloud',
  model: 'deepseek-flash',
  baseURL: 'https://ai.example.com/litellm',
  api: 'anthropic-messages',
  apiKey: 'sk-dsh-secret',
}

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('a failed login copy', () => {
  it('removes the half-built root and rethrows the cause', async () => {
    const source = mkdtempSync(join(tmpdir(), 'dsh-qoder-source-'))
    scratch.push(source)
    mkdirSync(join(source, '.auth'))
    writeFileSync(join(source, '.auth', 'user.json'), '{"uid":"user-1"}')

    const before = (await readdir(tmpdir())).filter(entry => entry.startsWith('dsh-qoder-handover-'))
    await expect(prepareQoderclicnHandover(HANDOVER, source)).rejects.toThrow('copy failed')
    const after = (await readdir(tmpdir())).filter(entry => entry.startsWith('dsh-qoder-handover-'))
    // No new root survived: the catch removed it before rethrowing.
    expect(after).toEqual(before)
    // And the source login was never touched.
    expect(existsSync(join(source, '.auth', 'user.json'))).toBe(true)
  })
})
