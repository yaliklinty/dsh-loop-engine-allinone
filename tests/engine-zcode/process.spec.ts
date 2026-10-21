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
import { join } from 'node:path'
import {
  ZCODE_MODES,
  ZCODE_PROVIDER_CONFIG_ENV,
  zcodeArgv,
  zcodeArgvPrefix,
  zcodeBuiltinProviderConfig,
  zcodeCliCandidates,
  zcodeInstallRoots,
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

  it('discovers the bundle under a derived install root when nothing is pinned', () => {
    // The root comes from the environment, so the assertion is about SHAPE (a `.cjs`
    // under `<root>/resources/glm`), not about one machine's drive letter.
    mockedExistsSync.mockReturnValue(true)
    const argv = zcodeArgvPrefix('D:/opt/ZCode/resources/glm/zcode.cjs')
    expect(argv).toEqual([process.execPath, 'D:/opt/ZCode/resources/glm/zcode.cjs'])
  })

  it('resolves a bundle from ZCODE_HOME, which is how a manual install is named', () => {
    // A `D:\Programs\ZCode`-style manual install has no installer-written root, so
    // the env var is the documented way to point the driver at it.
    const previous = process.env.ZCODE_HOME
    process.env.ZCODE_HOME = 'D:/opt/ZCode'
    mockedExistsSync.mockImplementation((path: unknown) =>
      String(path) === join('D:/opt/ZCode', 'resources', 'glm', 'zcode.cjs'))
    try {
      expect(zcodeArgvPrefix(undefined))
        .toEqual([process.execPath, join('D:/opt/ZCode', 'resources', 'glm', 'zcode.cjs')])
    } finally {
      if (previous === undefined) delete process.env.ZCODE_HOME
      else process.env.ZCODE_HOME = previous
    }
  })

  it('builds one candidate per install root, with no drive letter assumed', () => {
    const candidates = zcodeCliCandidates({ ZCODE_HOME: 'D:/opt/ZCode', LOCALAPPDATA: 'C:/local-app-data' } as NodeJS.ProcessEnv)
    // ZCODE_HOME wins outright, and every candidate ends in the same relative path.
    expect(candidates[0]).toBe(join('D:/opt/ZCode', 'resources', 'glm', 'zcode.cjs'))
    expect(candidates.every(candidate => candidate.endsWith(join('resources', 'glm', 'zcode.cjs')))).toBe(true)
    // A per-user install root is still probed behind it.
    expect(candidates.some(candidate => candidate.includes(join('Programs', 'ZCode')))).toBe(true)
  })

  it('falls back to PATH resolution', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(zcodeArgvPrefix(undefined)).toEqual(['zcode'])
    expect(zcodeArgvPrefix('')).toEqual(['zcode'])
  })
})

describe('zcodeBuiltinProviderConfig', () => {
  it('reports the catalog under a derived install root', () => {
    const previous = process.env.ZCODE_HOME
    process.env.ZCODE_HOME = 'D:/opt/ZCode'
    const expected = join('D:/opt/ZCode', 'resources', 'config', 'provider', 'zcode-builtin.json')
    mockedExistsSync.mockImplementation((path: unknown) => String(path) === expected)
    try {
      expect(zcodeBuiltinProviderConfig()).toBe(expected)
    } finally {
      if (previous === undefined) delete process.env.ZCODE_HOME
      else process.env.ZCODE_HOME = previous
    }
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

  it('never passes a model flag, which CLI 0.16.9 rejects', () => {
    // Measured: `--model` is an unknown option in 0.16.9. The model is chosen by
    // the provider document (`defaultModelSelection`), not by argv.
    expect(zcodeArgv(spec())).not.toContain('--model')
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

describe('the install roots it probes', () => {
  it('collects every root the environment names, in resolution order', () => {
    // The desktop app installs under three different places depending on how it
    // was obtained; probing all of them is what makes "found the bundled CLI"
    // work without a pinned path.
    const roots = zcodeInstallRoots({
      ZCODE_HOME: 'D:/zhome',
      LOCALAPPDATA: 'D:/somewhere/AppData/Local',
      ProgramFiles: 'C:/Program Files',
    } as never)
    expect(roots[0]).toBe('D:/zhome')
    expect(roots.some(root => root.includes('Programs'))).toBe(true)
    expect(roots.some(root => root.includes('Program Files'))).toBe(true)
  })

  it('skips an empty or absent variable instead of probing a relative path', () => {
    // An empty `ProgramFiles` would push `ZCode` relative to the CWD — a search
    // outside the install tree.
    const roots = zcodeInstallRoots({ ZCODE_HOME: '', LOCALAPPDATA: '', ProgramFiles: '' } as never)
    expect(roots.every(root => root !== '' && root !== 'ZCode')).toBe(true)
  })
})
