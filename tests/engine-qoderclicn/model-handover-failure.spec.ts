/**
 * The failure arm of Qoder's private config root: a copy that fails must remove
 * the half-built root instead of leaving a directory holding a login copy behind.
 *
 * Kept in its own module because it has to replace `cp` for the whole import
 * graph, and the happy-path spec should exercise the real filesystem helpers.
 *
 * @module tests/engine-qoderclicn/model-handover-failure
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DshModelHandover } from '../../src/driver-core/model-handover.ts'

// The happy-path spec creates and removes `dsh-qoder-handover-*` roots in the
// SAME OS temp dir. Comparing a before/after listing of the shared dir is then
// racy by construction, so this file points `tmpdir()` at a private root.
const privateTmp = mkdtempSync(join(tmpdir(), 'dsh-qoder-failure-tmp-'))
const savedTemp = { TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR }
process.env.TMP = privateTmp
process.env.TEMP = privateTmp
process.env.TMPDIR = privateTmp

afterAll(() => {
  for (const key of ['TMP', 'TEMP', 'TMPDIR'] as const) {
    const value = savedTemp[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(privateTmp, { recursive: true, force: true })
})

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
