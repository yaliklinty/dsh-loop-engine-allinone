/**
 * MiniMax Code's dialect: the executable, the region, and the config-option calls.
 *
 * The assertions are MEASURED facts (frames from `scripts/probe/acp-handshake.mjs --bin mcode --argv acp`
 * and the region controls established by running the same probe under each region), and the two that matter most are
 * the ones a plausible-looking implementation gets WRONG:
 *
 *   - the region travels in `MAVIS_REGION`, not `MCODE_REGION` (the latter is inert
 *     on the `mcode acp` path), and its value vocabulary is `cn|en` even though the
 *     login FLAG spells the same choice `cn|global`;
 *   - a model is selected with the BARE-value spelling of
 *     `session/set_config_option`; the `{ value }` wrapper is rejected `-32602`.
 *
 * @module tests/engine-minimaxcode/profile
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import type { AcpClient } from '../../src/driver-acp/client.ts'
import { ENGINE_REGISTRY, regionOf } from '../../src/engine-registry.ts'
import {
  MCODE_DEFAULT_EFFORT,
  MCODE_EFFORT_CONFIG_ID,
  MCODE_MODEL_CONFIG_ID,
  MCODE_PERMISSION_CONFIG_ID,
  mcodePermissionMode,
  minimaxcodeProfile,
} from '../../src/engine-minimaxcode/profile.ts'
import { mcodeAcpArgv, mcodeBinResolver } from '../../src/engine-minimaxcode/process.ts'
import { resolveConfig } from '../../src/engine-minimaxcode/loop.ts'

/** A session with the given durable approval-policy events. */
function sessionWithPolicy(policy: 'ask' | 'never' | undefined): Session {
  return {
    snapshotEvents: () => (policy === undefined ? [] : [{ type: 'approval/policy', data: { policy } }]),
  } as unknown as Session
}

/** A fake client recording every config-option call. */
function fakeClient(): {
  client: AcpClient
  calls: { newSession: unknown[][]; setConfigOption: unknown[][] }
} {
  const calls = { newSession: [] as unknown[][], setConfigOption: [] as unknown[][] }
  const client = {
    newSession: vi.fn(async (...args: unknown[]) => { calls.newSession.push(args); return 'mvs_test' }),
    setConfigOption: vi.fn(async (...args: unknown[]) => { calls.setConfigOption.push(args); return {} }),
  } as unknown as AcpClient
  return { client, calls }
}

describe("MiniMax Code's executable resolution", () => {
  it('runs a package entrypoint under the current node', () => {
    expect(mcodeAcpArgv('D:/npm/node_modules/@minimax-ai/code/cli.js')).toEqual([
      process.execPath, 'D:/npm/node_modules/@minimax-ai/code/cli.js', 'acp',
    ])
  })

  it('launches a .cmd shim through the command interpreter', () => {
    // Measured: `spawn('mcode.cmd')` throws EINVAL synchronously, while
    // `cmd.exe /d /s /c mcode.cmd` works — and that route produced a real ACP
    // session on this host.
    const argv = mcodeAcpArgv('D:/Programs/npm-global/mcode.CMD')
    expect(argv[0]).toBe(process.env.ComSpec ?? 'cmd.exe')
    expect(argv.slice(1, -1)).toEqual(['/c', 'D:/Programs/npm-global/mcode.CMD'])
    expect(argv.at(-1)).toBe('acp')
  })

  it('spawns a real executable directly', () => {
    expect(mcodeAcpArgv('/usr/local/bin/mcode')).toEqual(['/usr/local/bin/mcode', 'acp'])
    expect(mcodeAcpArgv('C:/x/mcode.exe')).toEqual(['C:/x/mcode.exe', 'acp'])
  })

  it('prefers an explicit pin over every probe', () => {
    expect(mcodeBinResolver('/opt/mcode/cli.js', {})).toBe('/opt/mcode/cli.js')
    // An empty pin is "not pinned", not "the empty path".
    expect(mcodeBinResolver('', { MCODE_INSTALL_ROOT: '/opt/mcode' })).not.toBe('')
  })

  it('finds the package entrypoint under an install root', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-root-'))
    const pkg = join(root, 'node_modules', '@minimax-ai', 'code')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'cli.js'), '// stub\n')
    expect(mcodeBinResolver(undefined, { MCODE_INSTALL_ROOT: root })).toBe(join(pkg, 'cli.js'))
  })

  it('finds the package entrypoint under a POSIX lib layout too', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-prefix-'))
    const pkg = join(root, 'lib', 'node_modules', '@minimax-ai', 'code')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'cli.js'), '// stub\n')
    expect(mcodeBinResolver(undefined, { MCODE_INSTALL_ROOT: root })).toBe(join(pkg, 'cli.js'))
  })

  it('falls back to PATH, honouring the Windows shim extensions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcode-path-'))
    const shim = join(dir, process.platform === 'win32' ? 'mcode.CMD' : 'mcode')
    writeFileSync(shim, '@echo off\n')
    // No install root, so the resolver must reach PATH rather than give up.
    expect(mcodeBinResolver(undefined, { PATH: dir })).toBe(shim)
  })
})

describe("MiniMax Code's region", () => {
  it('declares the knob the ACP path actually honours', () => {
    const region = ENGINE_REGISTRY.minimaxcode.region
    expect(region?.configKey).toBe('mcodeRegion')
    // MEASURED: MCODE_REGION is inert on this path; MAVIS_REGION is the one the
    // engine reads. Spelling the other name would look right and do nothing.
    expect(region?.envVar).toBe('MAVIS_REGION')
    expect(region?.envVar).not.toBe('MCODE_REGION')
    expect(region?.default).toBe('cn')
    // The VALUE vocabulary is `cn|en` (validated by the shipped code), even
    // though the login FLAG spells the same choice `cn|global`.
    expect(region?.values).toEqual(['cn', 'en'])
  })

  it('defaults to `cn` and accepts the declared values', () => {
    expect(regionOf('minimaxcode')).toBe('cn')
    expect(regionOf('minimaxcode', '')).toBe('cn')
    expect(regionOf('minimaxcode', 'en')).toBe('en')
  })

  it('refuses a value the CLI does not accept, and says which are allowed', () => {
    expect(() => regionOf('minimaxcode', 'global')).toThrow(/no region "global".*cn, en/)
  })

  it('is undefined for an engine with no region at all', () => {
    expect(regionOf('kimi', 'en')).toBeUndefined()
  })

  it('spells the resolved region into the child environment', () => {
    const envVar = ENGINE_REGISTRY.minimaxcode.region!.envVar
    // A pinned bin keeps the resolver out of the test's way.
    expect(resolveConfig({ bin: '/opt/mcode/cli.js' }).env[envVar]).toBe('cn')
    expect(resolveConfig({ bin: '/opt/mcode/cli.js', region: 'en' }).env[envVar]).toBe('en')
  })

  it('keeps the deployment\'s own environment entries and lets them address the CLI', () => {
    const env = resolveConfig({ bin: '/opt/mcode/cli.js', env: { EXTRA: '1' } }).env
    expect(env.EXTRA).toBe('1')
    expect(env.MAVIS_REGION).toBe('cn')
  })

  it('fails loud when `region` and the environment disagree', () => {
    // Two spellings of one fact: silently picking either would send the child to
    // an account the other setting did not mean.
    expect(() => resolveConfig({ bin: '/opt/mcode/cli.js', region: 'en', env: { MAVIS_REGION: 'cn' } }))
      .toThrow(/region "en".*MAVIS_REGION is "cn"/)
  })

  it('admits an environment entry that AGREES with the region', () => {
    const env = resolveConfig({ bin: '/opt/mcode/cli.js', region: 'en', env: { MAVIS_REGION: 'en' } }).env
    expect(env.MAVIS_REGION).toBe('en')
  })
})

describe("MiniMax Code's ACP dialect", () => {
  it('announces the registry protocol version and accepts images', () => {
    const profile = minimaxcodeProfile('mcode')
    expect(profile.engine).toBe('minimaxcode')
    expect(profile.protocolVersion).toBe(1)
    // Measured: `promptCapabilities.image: true`.
    expect(profile.images).toBe(true)
    expect(profile.errorCode).toBe('MINIMAXCODE_NO_RESULT')
  })

  it('selects a model with the BARE value, which this engine accepts', async () => {
    const { client, calls } = fakeClient()
    await minimaxcodeProfile('mcode').selectModel!(client, 'sess', 'm:minimax:MiniMax-M3:v:thinking')
    expect(calls.setConfigOption).toEqual([['sess', MCODE_MODEL_CONFIG_ID, 'm:minimax:MiniMax-M3:v:thinking']])
  })

  it('sets the reasoning effort AFTER the model, because the engine validates it against the pick', async () => {
    const { client, calls } = fakeClient()
    await minimaxcodeProfile('mcode').selectModel!(
      client,
      'sess',
      'm:minimax:MiniMax-M3.1-Flash:v:thinking',
      'xhigh',
    )
    // Order is the contract: a non-thinking variant answers "Thinking effort is not
    // advertised for the selected model", so the model has to land first.
    expect(calls.setConfigOption).toEqual([
      ['sess', MCODE_MODEL_CONFIG_ID, 'm:minimax:MiniMax-M3.1-Flash:v:thinking'],
      ['sess', MCODE_EFFORT_CONFIG_ID, 'xhigh'],
    ])
  })

  it('leaves the engine\'s own effort alone for its default level', async () => {
    const { client, calls } = fakeClient()
    await minimaxcodeProfile('mcode').selectModel!(
      client,
      'sess',
      'm:minimax:MiniMax-M3:v:thinking',
      MCODE_DEFAULT_EFFORT,
    )
    // Sending `default` is not the same as sending nothing: it would overwrite a
    // level the engine's session already adopted.
    expect(calls.setConfigOption).toEqual([['sess', MCODE_MODEL_CONFIG_ID, 'm:minimax:MiniMax-M3:v:thinking']])
  })

  it('maps the approval knob onto the engine\'s own permission mode', () => {
    expect(MCODE_PERMISSION_CONFIG_ID).toBe('permissionMode')
    expect(mcodePermissionMode(sessionWithPolicy('never'))).toBe('bypassPermissions')
    expect(mcodePermissionMode(sessionWithPolicy('ask'))).toBe('default')
    // An unset knob is not a choice, and the engine's persisted default may be
    // Full access, so it gets the middle mode rather than nothing at all.
    expect(mcodePermissionMode(sessionWithPolicy(undefined))).toBe('auto')
  })

  it('opens the session and states the permission mode every time', async () => {
    const { client, calls } = fakeClient()
    const sessionId = await minimaxcodeProfile('mcode').openSession!(client, 'D:/w', sessionWithPolicy(undefined))
    expect(sessionId).toBe('mvs_test')
    expect(calls.newSession).toEqual([['D:/w']])
    expect(calls.setConfigOption).toEqual([['mvs_test', MCODE_PERMISSION_CONFIG_ID, 'auto']])
  })

  it('states the deny-safe mode under an `ask` policy', async () => {
    const { client, calls } = fakeClient()
    await minimaxcodeProfile('mcode').openSession!(client, 'D:/w', sessionWithPolicy('ask'))
    expect(calls.setConfigOption).toEqual([['mvs_test', MCODE_PERMISSION_CONFIG_ID, 'default']])
  })

  it('lets a permission-mode failure fail the step instead of running a stance nobody chose', async () => {
    const { client } = fakeClient()
    ;(client as unknown as { setConfigOption: () => Promise<never> }).setConfigOption =
      vi.fn(async () => { throw new Error('Invalid params') })
    await expect(minimaxcodeProfile('mcode').openSession!(client, 'D:/w', sessionWithPolicy('never')))
      .rejects.toThrow('Invalid params')
  })

  it('uses the shared approval fold for reverse-RPC permission requests', () => {
    const profile = minimaxcodeProfile('mcode')
    expect(profile.approve?.(sessionWithPolicy('never'))).toBe(true)
    expect(profile.approve?.(sessionWithPolicy('ask'))).toBe(false)
  })
})

describe('the handover hook', () => {
  it('answers the data directory the engine was pointed at, and nothing else', () => {
    const handover = {
      provider: 'meicloud',
      model: 'deepseek-flash',
      baseURL: 'https://ai.example.com/litellm',
      api: 'openai-completions',
      apiKey: 'sk-secret',
    }
    expect(minimaxcodeProfile('mcode').handoverEnv!(handover)).toEqual({
      MINIMAX_DATA_DIR: expect.stringContaining('dsh-loop-engine-allinone-mcode'),
    })
  })
})
