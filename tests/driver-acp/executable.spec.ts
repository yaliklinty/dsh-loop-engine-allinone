/**
 * Executable resolution for the ACP engines: argv prefixing, PATH lookup and
 * npm package entries.
 *
 * This module exists because of one measured fact on Windows: an npm-installed
 * CLI is a `.cmd` shim, and `spawn('mcode')` fails with ENOENT while
 * `spawn('mcode.cmd')` fails with a SYNCHRONOUS EINVAL — only `cmd.exe /c`
 * works. `execArgvPrefix` is what turns a resolved path into an argv the seam
 * can actually spawn, and `resolveOnPath`/`npmPackageEntry` are the lookups that
 * find it in the first place.
 *
 * The lookups are hand-written rather than shelled out (`where`/`which`):
 * spawning a helper to answer a question about spawning is its own failure mode.
 *
 * @module tests/driver-acp/executable
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'
import { join, sep } from 'node:path'
import { execArgvPrefix, npmPackageEntry, resolveOnPath } from '../../src/driver-acp/executable.ts'

const mockedExistsSync = vi.mocked(existsSync)
const WINDOWS = process.platform === 'win32'

beforeEach(() => {
  mockedExistsSync.mockReset()
  mockedExistsSync.mockReturnValue(false)
})

describe('execArgvPrefix', () => {
  it('runs a script through the current node', () => {
    // An npm-published CLI is usually a JS bundle; the seam needs the
    // interpreter spelled out because the file is not executable on its own.
    expect(execArgvPrefix('/opt/mcode/cli.js')).toEqual([process.execPath, '/opt/mcode/cli.js'])
    expect(execArgvPrefix('/opt/mcode/cli.cjs')).toEqual([process.execPath, '/opt/mcode/cli.cjs'])
    expect(execArgvPrefix('/opt/mcode/cli.mjs')).toEqual([process.execPath, '/opt/mcode/cli.mjs'])
  })

  it('runs a Windows shim through the command interpreter', () => {
    // Measured: `spawn('mcode.cmd')` throws EINVAL synchronously; only
    // `cmd.exe /c <shim>` starts the CLI.
    const comSpec = process.env.ComSpec ?? 'cmd.exe'
    expect(execArgvPrefix('/opt/mcode.cmd')).toEqual([comSpec, '/c', '/opt/mcode.cmd'])
    expect(execArgvPrefix('/opt/mcode.bat')).toEqual([comSpec, '/c', '/opt/mcode.bat'])
  })

  it('falls back to cmd.exe when the environment does not name ComSpec', () => {
    // A scrubbed or minimal environment has no ComSpec; the prefix must still be
    // a spawnable argv rather than `[undefined, '/c', …]`.
    const original = process.env.ComSpec
    delete process.env.ComSpec
    try {
      expect(execArgvPrefix('/opt/mcode.cmd')).toEqual(['cmd.exe', '/c', '/opt/mcode.cmd'])
    } finally {
      if (original !== undefined) process.env.ComSpec = original
    }
  })

  it('spawns a real executable directly', () => {
    expect(execArgvPrefix('/usr/local/bin/mcode')).toEqual(['/usr/local/bin/mcode'])
    expect(execArgvPrefix('mcode')).toEqual(['mcode'])
  })
})

describe('resolveOnPath', () => {
  it('finds the first existing match, trying each PATHEXT entry', () => {
    // Windows resolves `mcode` through PATHEXT; the order of extensions is the
    // order the OS itself would try.
    const dir = WINDOWS ? 'C:\\tools' : '/usr/local/bin'
    mockedExistsSync.mockImplementation((candidate) => String(candidate).endsWith(`mcode${WINDOWS ? '.CMD' : ''}`))
    const found = resolveOnPath('mcode', {
      PATH: dir,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    } as never)
    expect(found).toBe(join(dir, WINDOWS ? 'mcode.CMD' : 'mcode'))
  })

  it('answers undefined when nothing on PATH matches', () => {
    expect(resolveOnPath('missing', { PATH: '/nonexistent' } as never)).toBeUndefined()
  })

  it('reads the Path spelling too, because Windows env keys are case-insensitive', () => {
    // A process started by a toolchain may carry `Path` rather than `PATH`.
    const dir = WINDOWS ? 'C:\\tools' : '/tools'
    mockedExistsSync.mockImplementation((candidate) => String(candidate).includes('found'))
    expect(resolveOnPath('found', { Path: dir } as never)).toBeDefined()
  })

  it('answers undefined when the environment carries no PATH at all', () => {
    expect(resolveOnPath('anything', {} as never)).toBeUndefined()
    expect(resolveOnPath('anything', { PATH: '' } as never)).toBeUndefined()
  })

  it('skips empty entries rather than searching the working directory', () => {
    // An empty segment would resolve against the CWD — a search-path injection
    // when the process runs in a user-writable directory.
    const dir = WINDOWS ? 'C:\\tools' : '/tools'
    mockedExistsSync.mockImplementation((candidate) => String(candidate).includes(`tools${sep}`))
    expect(resolveOnPath('found', { PATH: `;;${dir};;`, PATHEXT: '.EXE' } as never)).toBeDefined()
    expect(mockedExistsSync).not.toHaveBeenCalledWith(expect.stringMatching(/^found/))
  })

  it('honours a custom PATHEXT and ignores empty extension entries', () => {
    mockedExistsSync.mockImplementation((candidate) => String(candidate).endsWith('mcode.XYZ'))
    const found = resolveOnPath('mcode', {
      PATH: WINDOWS ? 'C:\\tools' : '/tools',
      PATHEXT: ';;.XYZ;;',
    } as never)
    expect(found).toContain('mcode')
  })
})

describe('npmPackageEntry', () => {
  it('resolves a plain package under node_modules, then under lib', () => {
    // Two layouts are in the wild: a prefix that already contains
    // `node_modules`, and one whose packages sit under `lib/`.
    mockedExistsSync.mockImplementation((candidate) => String(candidate).endsWith('cli.js')
      && String(candidate).includes('node_modules'))
    expect(npmPackageEntry('/prefix', 'mcode', 'cli.js'))
      .toBe(join('/prefix', 'node_modules', 'mcode', 'cli.js'))

    mockedExistsSync.mockReset()
    mockedExistsSync.mockImplementation((candidate) => String(candidate).includes(`lib${sep}node_modules`))
    expect(npmPackageEntry('/prefix', 'mcode', 'cli.js'))
      .toBe(join('/prefix', 'lib', 'node_modules', 'mcode', 'cli.js'))
  })

  it('resolves a SCOPED package into its scope directory', () => {
    // `@minimax-ai/code` lives at `node_modules/@minimax-ai/code/…`, and the
    // scope is not a package of its own.
    mockedExistsSync.mockImplementation((candidate) => String(candidate).includes(join('@minimax-ai', 'code')))
    expect(npmPackageEntry('/prefix', '@minimax-ai/code', 'cli.js'))
      .toBe(join('/prefix', 'node_modules', '@minimax-ai', 'code', 'cli.js'))
  })

  it('answers undefined for a scoped name with no package part', () => {
    // `@/name` has a truncated scope and `@/` has no package part at all; neither
    // names a package, so neither may be searched for — a lookup that joined
    // them anyway would probe `node_modules//name/…`.
    // `@/` has no package part; a bare `@` has no slash at all. Reading the
    // slash once is what makes the second a rejection rather than a search for
    // `node_modules/@/…` (the old `slice(0, -1)` truncated the `@` away).
    expect(npmPackageEntry('/prefix', '@/', 'cli.js')).toBeUndefined()
    expect(npmPackageEntry('/prefix', '@', 'cli.js')).toBeUndefined()
    expect(mockedExistsSync).not.toHaveBeenCalled()
  })

  it('answers undefined for an empty package name', () => {
    expect(npmPackageEntry('/prefix', '', 'cli.js')).toBeUndefined()
  })

  it('answers undefined when neither layout has the entry', () => {
    expect(npmPackageEntry('/prefix', 'mcode', 'cli.js')).toBeUndefined()
  })
})
