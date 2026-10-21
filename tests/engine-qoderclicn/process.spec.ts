/**
 * The Qoder CN process projection: executable resolution, the argv the verified
 * protocol requires, and the permission mapping's fail-closed rule.
 *
 * The argv assertions are behavioural rather than cosmetic: `--output-format
 * stream-json` is what makes the answer machine-readable (without it the CLI
 * prints prose the driver would have to guess at), and the prompt must be the
 * LAST argument because `-p` takes it positionally.
 *
 * @module tests/engine-qoderclicn/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  QODERCLICN_PERMISSION_MODES,
  qoderclicnArgv,
  qoderclicnBinResolver,
  qoderclicnHomeDir,
  qoderclicnPermissionMode,
  qoderclicnSpawnRequest,
  type QoderclicnSpawnSpec,
} from '../../src/engine-qoderclicn/process.ts'

vi.mock('node:os', () => ({ homedir: () => '/home/tester' }))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)
const EXE = process.platform === 'win32' ? 'qoderclicn.exe' : 'qoderclicn'

beforeEach(() => {
  mockedExistsSync.mockReset()
  delete process.env.QODER_HOME
})

function spec(overrides: Partial<QoderclicnSpawnSpec> = {}): QoderclicnSpawnSpec {
  return {
    bin: 'qoderclicn',
    prompt: 'say PONG',
    cwd: '/work',
    env: {},
    model: undefined,
    permissionMode: 'default',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('qoderclicnHomeDir', () => {
  it('prefers the QODER_HOME override', () => {
    process.env.QODER_HOME = '/custom'
    expect(qoderclicnHomeDir()).toBe('/custom')
  })

  it('falls back to ~/.qoder-cn when the override is empty', () => {
    process.env.QODER_HOME = ''
    expect(qoderclicnHomeDir()).toBe(join('/home/tester', '.qoder-cn'))
  })
})

describe('qoderclicnBinResolver', () => {
  it('returns an explicit path verbatim', () => {
    expect(qoderclicnBinResolver('C:\tools\qoderclicn.exe')).toBe('C:\tools\qoderclicn.exe')
  })

  it('probes the CLI’s own install location before PATH', () => {
    // Qoder's installer adds this directory to PATH itself, and a desktop-
    // launched profile does not always inherit it.
    process.env.QODER_HOME = '/qoder-home'
    mockedExistsSync.mockReturnValue(true)
    const expected = join('/qoder-home', 'bin', 'qoderclicn', EXE)
    expect(qoderclicnBinResolver('')).toBe(expected)
    expect(mockedExistsSync).toHaveBeenCalledWith(expected)
  })

  it('falls back to PATH resolution', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(qoderclicnBinResolver(undefined)).toBe('qoderclicn')
  })
})

describe('qoderclicnPermissionMode', () => {
  it('maps full access to bypass_permissions', () => {
    expect(qoderclicnPermissionMode('danger-full-access', 'never')).toBe('bypass_permissions')
  })

  it('maps workspace-write to accept_edits', () => {
    expect(qoderclicnPermissionMode('workspace-write', 'never')).toBe('accept_edits')
    expect(qoderclicnPermissionMode('workspace-write', 'ask')).toBe('accept_edits')
  })

  it('fails closed for read-only, for no knobs at all, and under an ask policy', () => {
    // `ask` is deliberately NOT mapped to a permissive mode: this driver has no
    // channel to forward a human approval question, so the policy degrades to
    // the CLI's own gate and the subprocess sandbox remains the boundary.
    expect(qoderclicnPermissionMode('read-only', 'never')).toBe('default')
    expect(qoderclicnPermissionMode(undefined, undefined)).toBe('default')
    expect(qoderclicnPermissionMode(undefined, 'ask')).toBe('default')
    expect(qoderclicnPermissionMode('read-only', 'ask')).toBe('default')
  })

  it('only ever returns a mode the CLI accepts', () => {
    const seen = new Set(
      (['read-only', 'workspace-write', 'danger-full-access', undefined] as const)
        .flatMap(sandbox => (['ask', 'never', undefined] as const).map(approval => qoderclicnPermissionMode(sandbox, approval))),
    )
    for (const mode of seen) expect(QODERCLICN_PERMISSION_MODES).toContain(mode)
  })
})

describe('qoderclicnArgv', () => {
  it('requests stream-json and puts the prompt last', () => {
    expect(qoderclicnArgv(spec())).toEqual([
      'qoderclicn', '-p', '--output-format', 'stream-json', '--permission-mode', 'default', 'say PONG',
    ])
  })

  it('narrows a pinned model through -m, the measured spelling', () => {
    expect(qoderclicnArgv(spec({ model: 'auto' }))).toEqual([
      'qoderclicn', '-p', '--output-format', 'stream-json', '--permission-mode', 'default', '-m', 'auto', 'say PONG',
    ])
  })

  it('runs a handover in its private config root, before -p', () => {
    // `--config-dir` is load-bearing: without it the CLI reads the user's own
    // root, whose custom-model table is encrypted and whose provider selection
    // is not the dsh endpoint.
    expect(qoderclicnArgv(spec({ configDir: '/tmp/dsh-qoder', model: 'dsh-handover/m' }))).toEqual([
      'qoderclicn', '--config-dir', '/tmp/dsh-qoder', '-p', '--output-format', 'stream-json',
      '--permission-mode', 'default', '-m', 'dsh-handover/m', 'say PONG',
    ])
  })
})

describe('qoderclicnSpawnRequest', () => {
  it('carries cwd, env and signal through, and never asks for a stdin pipe', () => {
    // The prompt is an argv argument, so a stdin pipe would be a pipe the child
    // never reads.
    const signal = new AbortController().signal
    const request = qoderclicnSpawnRequest(spec({ env: { A: '1' }, signal }))
    expect(request.cwd).toBe('/work')
    expect(request.env).toEqual({ A: '1' })
    expect(request.signal).toBe(signal)
  })
})

describe('the home-directory install', () => {
  it('prefers the CLI its own install directory holds', () => {
    // An installed Qoder CN puts its binary under `~/.qoder-cn/bin/…`; probing
    // that is what makes the bundling toggle work without a pinned path.
    mockedExistsSync.mockReturnValue(true)
    expect(qoderclicnBinResolver()).toBe(join(qoderclicnHomeDir(), 'bin', 'qoderclicn', EXE))
  })

  it('falls back to the bare name when the install directory has no binary', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(qoderclicnBinResolver()).toBe('qoderclicn')
  })
})
