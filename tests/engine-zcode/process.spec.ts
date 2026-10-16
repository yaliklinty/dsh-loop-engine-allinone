/**
 * The ZCode process projection: argv-prefix resolution, the mode mapping, and the
 * provider-catalog environment entry.
 *
 * The argv-prefix assertions encode the three shapes a ZCode install takes — the
 * desktop app's `.cjs` bundle (run under node), a native binary, and a plain
 * `zcode` on PATH — because getting the shape wrong spawns the wrong thing and
 * the failure looks like "the engine is broken".
 *
 * @module tests/engine-zcode/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ZCODE_MODES,
  ZCODE_PROVIDER_CONFIG_ENV,
  zcodeArgv,
  zcodeArgvPrefix,
  zcodeBuiltinProviderConfig,
  zcodeMode,
  zcodeSpawnRequest,
  type ZcodeSpawnSpec,
} from '../../src/engine-zcode/process.ts'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  mockedExistsSync.mockReset()
})

function spec(overrides: Partial<ZcodeSpawnSpec> = {}): ZcodeSpawnSpec {
  return {
    prefix: ['zcode'],
    prompt: 'say PONG',
    cwd: '/work',
    env: {},
    model: undefined,
    mode: 'build',
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('zcodeArgvPrefix', () => {
  it('runs a pinned .cjs bundle under the current node', () => {
    // The desktop app ships a Node bundle, so argv[0] must be node and argv[1]
    // the script; spawning the .cjs directly would fail.
    expect(zcodeArgvPrefix('D:\ZCode\resources\glm\zcode.cjs')).toEqual([process.execPath, 'D:\ZCode\resources\glm\zcode.cjs'])
    expect(zcodeArgvPrefix('/opt/zcode/index.mjs')).toEqual([process.execPath, '/opt/zcode/index.mjs'])
    expect(zcodeArgvPrefix('/opt/zcode/index.js')).toEqual([process.execPath, '/opt/zcode/index.js'])
  })

  it('spawns a pinned native binary directly', () => {
    expect(zcodeArgvPrefix('C:\tools\zcode.exe')).toEqual(['C:\tools\zcode.exe'])
  })

  it('discovers the bundled provider-adjacent bundle when nothing is pinned', () => {
    mockedExistsSync.mockReturnValue(true)
    expect(zcodeArgvPrefix(undefined)).toEqual([process.execPath, 'D:\Programs\ZCode\resources\glm\zcode.cjs'])
  })

  it('falls back to PATH resolution', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(zcodeArgvPrefix(undefined)).toEqual(['zcode'])
    expect(zcodeArgvPrefix('')).toEqual(['zcode'])
  })
})

describe('zcodeBuiltinProviderConfig', () => {
  it('reports the bundled catalog when the app ships one', () => {
    mockedExistsSync.mockReturnValue(true)
    expect(zcodeBuiltinProviderConfig()).toBe('D:\Programs\ZCode\resources\config\provider\zcode-builtin.json')
  })

  it('reports nothing when the app is not installed', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(zcodeBuiltinProviderConfig()).toBeUndefined()
  })
})

describe('zcodeMode', () => {
  it('grants yolo only at full access', () => {
    expect(zcodeMode(true)).toBe('yolo')
    expect(zcodeMode(false)).toBe('build')
  })

  it('only ever returns a mode the CLI accepts', () => {
    expect(ZCODE_MODES).toContain(zcodeMode(true))
    expect(ZCODE_MODES).toContain(zcodeMode(false))
  })
})

describe('zcodeArgv', () => {
  it('appends the print flag, the mode and no-color to the resolved prefix', () => {
    expect(zcodeArgv(spec())).toEqual(['zcode', '-p', 'say PONG', '--mode', 'build', '--no-color'])
  })

  it('appends a pinned model last', () => {
    expect(zcodeArgv(spec({ model: 'glm-4.6' })).slice(-2)).toEqual(['--model', 'glm-4.6'])
  })
})

describe('zcodeSpawnRequest', () => {
  it('supplies the provider catalog under the deployment’s own entries', () => {
    // A deployment's explicit value must win: it may point at a different
    // catalog, and silently overriding it would ignore the operator.
    const request = zcodeSpawnRequest(spec({ env: { [ZCODE_PROVIDER_CONFIG_ENV]: '/custom.json' } }), '/builtin.json')
    expect(request.env[ZCODE_PROVIDER_CONFIG_ENV]).toBe('/custom.json')
  })

  it('supplies the discovered catalog when the deployment named none', () => {
    const request = zcodeSpawnRequest(spec(), '/builtin.json')
    expect(request.env[ZCODE_PROVIDER_CONFIG_ENV]).toBe('/builtin.json')
  })

  it('omits the variable entirely when no catalog was discovered', () => {
    const request = zcodeSpawnRequest(spec(), undefined)
    expect(request.env).not.toHaveProperty(ZCODE_PROVIDER_CONFIG_ENV)
  })

  it('carries cwd and signal through', () => {
    const signal = new AbortController().signal
    const request = zcodeSpawnRequest(spec({ signal }), undefined)
    expect(request.cwd).toBe('/work')
    expect(request.signal).toBe(signal)
  })
})
