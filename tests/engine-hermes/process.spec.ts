/**
 * The Hermes process projection, and the environment fact the plan calls out.
 *
 * `HERMES_HOME` is where Hermes keeps ALL of its state — sessions, skills,
 * `auth.json`. The plugin never reads or forwards it; the child inherits it from
 * the ambient environment, because the dsh subprocess seam's scrub only removes
 * `DSH_*` facts and names matching `KEY|PASSWORD|SECRET|TOKEN`, and `HERMES_HOME`
 * matches neither. The test below pins that inheritance.
 *
 * It is worth pinning because the failure would be misdiagnosed: if the plugin
 * ever replaced the child environment wholesale, every Hermes session would
 * start against an empty `HERMES_HOME` — a fresh install with no login — and the
 * user would see "the model is broken" rather than "the plugin dropped a
 * variable". The assertion is deliberately about the INHERITED value surviving
 * the seam's scrub, not about a value the driver sets.
 *
 * @module tests/engine-hermes/process
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import {
  HERMES_HOME_ENV,
  HERMES_PROMPT_FLAG,
  hermesArgv,
  hermesBinResolver,
  hermesOnPath,
  hermesSpawnRequest,
  type HermesSpawnSpec,
} from '../../src/engine-hermes/process.ts'

vi.mock('node:fs', () => ({ existsSync: vi.fn() }))

import { existsSync } from 'node:fs'

const mockedExistsSync = vi.mocked(existsSync)

beforeEach(() => {
  mockedExistsSync.mockReset()
})

/** One minimal spawn spec, so each test states only what it is about. */
function spec(overrides: Partial<HermesSpawnSpec> = {}): HermesSpawnSpec {
  return {
    bin: 'hermes',
    prompt: 'say PONG',
    cwd: '/work',
    env: {},
    model: undefined,
    reasoning: undefined,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('hermesBinResolver', () => {
  it('returns an explicit config path verbatim', () => {
    expect(hermesBinResolver('D:\\tools\\hermes.exe')).toBe('D:\\tools\\hermes.exe')
  })

  it('prefers the installer’s own venv location when it exists', () => {
    // A desktop-launched profile does not always inherit the PATH entry Hermes'
    // installer added, so the venv copy is probed before falling back to PATH.
    process.env.LOCALAPPDATA = 'C:\\Users\\tester\\AppData\\Local'
    mockedExistsSync.mockReturnValue(true)
    expect(hermesBinResolver('')).toBe(join('C:\\Users\\tester\\AppData\\Local', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe'))
  })

  it('falls back to PATH resolution', () => {
    process.env.LOCALAPPDATA = ''
    expect(hermesBinResolver('')).toBe('hermes')
    expect(hermesBinResolver(undefined)).toBe('hermes')
  })
})

describe('hermesOnPath', () => {
  it('is false for an empty or absent PATH', () => {
    expect(hermesOnPath(undefined)).toBe(false)
    expect(hermesOnPath('')).toBe(false)
  })

  it('finds an executable in any entry', () => {
    mockedExistsSync.mockImplementation((candidate) => String(candidate).includes('hermes'))
    expect(hermesOnPath(['/usr/bin', '/opt/hermes/bin'].join(process.platform === 'win32' ? ';' : ':'))).toBe(true)
  })

  it('skips empty entries rather than treating the cwd as one', () => {
    mockedExistsSync.mockReturnValue(false)
    expect(hermesOnPath(['', '/usr/bin'].join(process.platform === 'win32' ? ';' : ':'))).toBe(false)
  })
})

describe('hermesArgv', () => {
  it('passes the prompt as the -z argument', () => {
    expect(hermesArgv(spec())).toEqual(['hermes', HERMES_PROMPT_FLAG, 'say PONG'])
  })

  it('appends the pinned model and reasoning level', () => {
    expect(hermesArgv(spec({ model: 'glm-4', reasoning: 'high' })))
      .toEqual(['hermes', HERMES_PROMPT_FLAG, 'say PONG', '-m', 'glm-4', '--reasoning', 'high'])
  })
})

describe('hermesSpawnRequest', () => {
  it('carries the argv, cwd, env and signal through unchanged', () => {
    const signal = new AbortController().signal
    const request = hermesSpawnRequest(spec({ env: { EXTRA: '1' }, signal }))
    expect(request.argv[0]).toBe('hermes')
    expect(request.cwd).toBe('/work')
    expect(request.env).toEqual({ EXTRA: '1' })
    expect(request.signal).toBe(signal)
  })

  it('does NOT fabricate HERMES_HOME — the child inherits it from the ambient environment', () => {
    // The plan's requirement, stated as an assertion. The driver forwards only
    // what the deployment configured; everything else (including HERMES_HOME)
    // reaches the child because the seam's scrub does not match it.
    const request = hermesSpawnRequest(spec())
    expect(request.env).not.toHaveProperty(HERMES_HOME_ENV)
    expect(Object.keys(request.env)).toEqual([])
  })

  it('forwards an explicitly configured HERMES_HOME, which is how a second profile is selected', () => {
    const request = hermesSpawnRequest(spec({ env: { [HERMES_HOME_ENV]: 'D:\\HermesData\\other' } }))
    expect(request.env[HERMES_HOME_ENV]).toBe('D:\\HermesData\\other')
  })
})
