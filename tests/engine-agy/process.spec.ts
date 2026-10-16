/**
 * The Antigravity process projection, and the argument-position trap it exists
 * to avoid.
 *
 * `agy`'s `--print` takes an OPTIONAL value. Left bare, it swallows the NEXT
 * flag as its prompt — so `agy --input-format stream-json --print` makes
 * `--input-format` the prompt and silently ignores the real one (the CLI even
 * says so on stderr, but only after the fact). The driver therefore attaches an
 * EMPTY value (`--print=`), and the assertion below is the regression pin: a
 * well-meaning "clean up the empty value" edit would break every step.
 *
 * @module tests/engine-agy/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  AGY_EFFORTS,
  AGY_MODES,
  agyArgv,
  agyBinResolver,
  agyCredentialPresent,
  agySpawnRequest,
  agyStdinPrompt,
  type AgySpawnSpec,
} from '../../src/engine-agy/process.ts'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  mockedExistsSync.mockReset()
  delete process.env.LOCALAPPDATA
})

function spec(overrides: Partial<AgySpawnSpec> = {}): AgySpawnSpec {
  return {
    bin: 'agy',
    prompt: 'say PONG',
    cwd: '/work',
    env: {},
    model: undefined,
    mode: undefined,
    effort: undefined,
    sandbox: true,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('agyBinResolver', () => {
  it('returns an explicit path verbatim', () => {
    expect(agyBinResolver('C:\tools\agy.exe')).toBe('C:\tools\agy.exe')
  })

  it('probes the CLI’s own per-user install location', () => {
    process.env.LOCALAPPDATA = 'C:\Users\tester\AppData\Local'
    mockedExistsSync.mockReturnValue(true)
    const expected = join('C:\Users\tester\AppData\Local', 'agy', 'bin', process.platform === 'win32' ? 'agy.EXE' : 'agy')
    expect(agyBinResolver('')).toBe(expected)
    expect(mockedExistsSync).toHaveBeenCalledWith(expected)
  })

  it('falls back to PATH resolution', () => {
    expect(agyBinResolver(undefined)).toBe('agy')
  })
})

describe('agyCredentialPresent', () => {
  it('looks for the Google credential file the CLI itself writes', () => {
    mockedExistsSync.mockReturnValue(true)
    expect(agyCredentialPresent('/home/tester')).toBe(true)
    expect(mockedExistsSync).toHaveBeenCalledWith(join('/home/tester', '.gemini', 'oauth_creds.json'))
  })

  it('is a hint about a login having happened, not a readiness check', () => {
    // The file can be present and EXPIRED — that is exactly the state the probe
    // host was in — so the setting must not be read as "ready".
    mockedExistsSync.mockReturnValue(false)
    expect(agyCredentialPresent('/home/tester')).toBe(false)
  })
})

describe('agyArgv', () => {
  it('attaches an EMPTY value to --print, so the flags before it are not eaten', () => {
    const argv = agyArgv(spec())
    expect(argv).toContain('--print=')
    expect(argv).not.toContain('--print')
    // The input-format flag must still be its own argv element: the trap is that
    // a bare --print consumes it.
    expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json')
  })

  it('omits --mode when the deployment pinned none, so the CLI uses its own default', () => {
    // Found by the smoke test: `--mode auto` is refused for some accounts
    // ("not available for this account; continuing in the default mode"), so the
    // set a given account accepts is not knowable ahead of time.
    expect(agyArgv(spec({ mode: undefined }))).not.toContain('--mode')
    expect(agyArgv(spec({ mode: 'plan' }))).toContain('plan')
  })

  it('requests both stream-json formats together', () => {
    // The CLI requires the pair: stream-json input needs stream-json output.
    const argv = agyArgv(spec())
    expect(argv[argv.indexOf('--input-format') + 1]).toBe('stream-json')
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
  })

  it('passes the mode, model and effort when pinned', () => {
    expect(agyArgv(spec({ mode: 'plan', model: 'gemini-3-pro', effort: 'high', sandbox: false }))).toEqual([
      'agy', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--mode', 'plan', '--model', 'gemini-3-pro', '--effort', 'high', '--print=',
    ])
  })

  it('adds --sandbox only when terminal restrictions are requested', () => {
    expect(agyArgv(spec({ sandbox: true }))).toContain('--sandbox')
    expect(agyArgv(spec({ sandbox: false }))).not.toContain('--sandbox')
  })

  it('only ever emits modes and efforts the CLI documents', () => {
    for (const mode of AGY_MODES) expect(agyArgv(spec({ mode }))).toContain(mode)
    for (const effort of AGY_EFFORTS) expect(agyArgv(spec({ effort }))).toContain(effort)
  })
})

describe('agyStdinPrompt', () => {
  it('writes one newline-terminated NDJSON user message', () => {
    const payload = agyStdinPrompt('say PONG')
    expect(payload.endsWith('\n')).toBe(true)
    expect(JSON.parse(payload)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'say PONG' }] },
    })
  })

  it('escapes a multi-line prompt into a single line', () => {
    // The transport is one document per LINE, so an unescaped newline in the
    // prompt would split it into two malformed documents.
    const payload = agyStdinPrompt('line one\nline two')
    expect(payload.split('\n')).toHaveLength(2)
    expect(JSON.parse(payload).message.content[0].text).toBe('line one\nline two')
  })
})

describe('agySpawnRequest', () => {
  it('carries cwd, env and signal through', () => {
    const signal = new AbortController().signal
    const request = agySpawnRequest(spec({ env: { A: '1' }, signal }))
    expect(request.cwd).toBe('/work')
    expect(request.env).toEqual({ A: '1' })
    expect(request.signal).toBe(signal)
  })
})
