/**
 * The Grok process projection: where the executable comes from, and the argv the
 * ACP child is launched with.
 *
 * The argv assertion is the load-bearing one. An npm-installed `grok` is a `.cmd`
 * shim, and the ACP child is spawned through the dsh subprocess seam — so the argv
 * has to be the one `execArgvPrefix` produces for a shim (the command
 * interpreter), not the bare name. Getting that wrong is a spawn failure whose
 * message names the engine, not the shim.
 *
 * MEASURED, and recorded in the fork's probe report §8: `grok agent stdio` is the
 * ACP entry point, and a signed-in GROK_HOME is what makes the child authenticate
 * without an interactive step.
 *
 * @module tests/engine-grok/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GROK_DISPOSE_GRACE_MS, grokAcpArgv, grokBinResolver, grokHomeDir } from '../../src/engine-grok/process.ts'

const mockedExistsSync = vi.mocked(existsSync)
const WINDOWS = process.platform === 'win32'

beforeEach(() => {
  mockedExistsSync.mockReset()
  mockedExistsSync.mockReturnValue(false)
  delete process.env.GROK_HOME
})

describe('grokHomeDir', () => {
  it('prefers the GROK_HOME override', () => {
    process.env.GROK_HOME = 'D:/grokhome'
    expect(grokHomeDir()).toBe('D:/grokhome')
  })

  it('falls back to ~/.grok when the override is empty or absent', () => {
    expect(grokHomeDir()).toBe(join('/home/tester', '.grok'))
    process.env.GROK_HOME = ''
    expect(grokHomeDir()).toBe(join('/home/tester', '.grok'))
  })
})

describe('grokBinResolver', () => {
  it('accepts a pinned path verbatim', () => {
    expect(grokBinResolver('/opt/grok')).toBe('/opt/grok')
    // An empty pin means "not pinned", not "the executable named ''".
    expect(grokBinResolver('')).not.toBe('')
  })

  it('prefers the released binary under the Grok home when it exists', () => {
    // The vendor's own install target is a real executable; an npm install leaves
    // a `.cmd` shim on PATH instead, and probing the binary first keeps the child
    // off that shim.
    process.env.GROK_HOME = 'D:/grokhome'
    mockedExistsSync.mockReturnValue(true)
    expect(grokBinResolver()).toBe(join('D:/grokhome', 'bin', WINDOWS ? 'grok.exe' : 'grok'))
  })

  it('falls back to PATH, then to the bare name', () => {
    // Nothing installed under the home: the ACP child is launched through
    // `execArgvPrefix`, which knows how to start a PATH-resolved shim.
    process.env.GROK_HOME = 'D:/grokhome'
    mockedExistsSync.mockReturnValue(false)
    expect(grokBinResolver()).toBe('grok')
  })
})

describe('grokAcpArgv', () => {
  it('launches `grok agent stdio` for a plain binary', () => {
    // The ACP entry point, MEASURED: `agent stdio` is the subcommand that speaks
    // the protocol on the child's stdio.
    expect(grokAcpArgv('/opt/grok')).toEqual(['/opt/grok', 'agent', 'stdio'])
    expect(grokAcpArgv('grok')).toEqual(['grok', 'agent', 'stdio'])
  })

  it('routes a Windows shim through the command interpreter', () => {
    // `spawn('grok.cmd')` throws EINVAL synchronously; only `cmd.exe /c` starts it.
    const comSpec = process.env.ComSpec ?? 'cmd.exe'
    expect(grokAcpArgv('D:/npm-global/grok.cmd'))
      .toEqual([comSpec, '/c', 'D:/npm-global/grok.cmd', 'agent', 'stdio'])
  })

  it('runs a JavaScript entry point through the current node', () => {
    expect(grokAcpArgv('/opt/grok/cli.js'))
      .toEqual([process.execPath, '/opt/grok/cli.js', 'agent', 'stdio'])
  })

  it('declares the grace period its termination procedure uses', () => {
    expect(GROK_DISPOSE_GRACE_MS).toBeGreaterThan(0)
  })
})
