/**
 * The two new engines' spawn plumbing: what the driver actually asks the dsh
 * subprocess seam to launch.
 *
 * The whole point of these engines is that their ACP child is reachable and
 * correctly shaped — `grok agent stdio` and `mcode acp`, with the account region
 * in the environment — so these assertions are on the SEAM CALL rather than on a
 * driver internal.
 *
 * @module tests/driver-acp/engines
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { GrokLoop, GROK_ENGINE_LABEL, resolveConfig as resolveGrokConfig } from '../../src/engine-grok/loop.ts'
import { GROK_DISPOSE_GRACE_MS } from '../../src/engine-grok/process.ts'
import { MINIMAXCODE_DISPOSE_GRACE_MS } from '../../src/engine-minimaxcode/process.ts'
import { MinimaxcodeLoop, MINIMAXCODE_ENGINE_LABEL } from '../../src/engine-minimaxcode/loop.ts'
import { grokProfile } from '../../src/engine-grok/profile.ts'
import { kimiProfile } from '../../src/engine-kimi/profile.ts'
import { minimaxcodeProfile } from '../../src/engine-minimaxcode/profile.ts'
import { ENGINE_REGISTRY } from '../../src/engine-registry.ts'

/** A subprocess handle shaped like the seam returns one. */
function fakeHandle(): SubprocessHandle {
  return {
    pid: 1,
    stdin: new Writable({ write: (_chunk, _encoding, callback) => { callback() } }),
    stdout: new Readable({ read: () => {} }),
    stderr: new Readable({ read: () => {} }),
    collected: {} as SubprocessHandle['collected'],
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate: vi.fn(),
    waitForExit: vi.fn(async () => true),
  } as unknown as SubprocessHandle
}

/** Minimal Context carrying just the services a loop reads at construction. */
async function loopCtx(spawn: (spec: unknown) => unknown): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: 'You are the deployment.' })
  await ctx.plugin(AgentRegistry)
  ctx.provide('subprocess', { spawn })
  return ctx
}

describe('GrokLoop spawn plumbing', () => {
  it('registers itself under its own ctx key', async () => {
    const ctx = await loopCtx(vi.fn(() => fakeHandle()))
    try {
      const loop = new GrokLoop(ctx, { bin: '/opt/grok' })
      expect(loop.label).toBe(GROK_ENGINE_LABEL)
      expect(ctx.get(GROK_ENGINE_LABEL)).toBe(loop)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects the ACP argv onto the subprocess seam with the ACP grace window', async () => {
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new GrokLoop(ctx, { bin: '/opt/grok' })
      loop.spawn({ argv: ['/opt/grok', 'agent', 'stdio'], cwd: '/t', env: { A: '1' } })
      expect(spawn).toHaveBeenCalledWith({
        argv: ['/opt/grok', 'agent', 'stdio'],
        cwd: '/t',
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: GROK_DISPOSE_GRACE_MS,
        env: { A: '1' },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('needs the subprocess service, and says which engine does', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { persona: 'x' })
    await ctx.plugin(AgentRegistry)
    expect(() => new GrokLoop(ctx, {})).toThrow(/the grok engine needs the dsh subprocess service/)
    await ctx.fiber.dispose()
  })

  it('keeps a pinned executable and resolves one when unpinned', () => {
    expect(resolveGrokConfig({ bin: 'D:/x/grok.exe' }).bin).toBe('D:/x/grok.exe')
    expect(resolveGrokConfig({}).bin).not.toBe('')
    // An empty pin means "not pinned", never "the empty path".
    expect(resolveGrokConfig({ bin: '' }).bin).not.toBe('')
  })
})

describe('MinimaxcodeLoop spawn plumbing', () => {
  it('launches the package entrypoint under node and carries the region', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mcode-loop-'))
    const pkg = join(root, 'node_modules', '@minimax-ai', 'code')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'cli.js'), '// stub\n')
    const handle = fakeHandle()
    const spawn = vi.fn(() => handle)
    const ctx = await loopCtx(spawn)
    try {
      const loop = new MinimaxcodeLoop(ctx, { bin: join(pkg, 'cli.js'), region: 'en' })
      expect(loop.label).toBe(MINIMAXCODE_ENGINE_LABEL)
      expect(loop.config.bin).toBe(join(pkg, 'cli.js'))
      expect(loop.config.env.MAVIS_REGION).toBe('en')
      loop.spawn({ argv: [process.execPath, join(pkg, 'cli.js'), 'acp'], cwd: '/t', env: loop.config.env })
      const spec = spawn.mock.calls[0]![0] as { argv: string[]; env: Record<string, string>; graceMs: number }
      expect(spec.argv).toEqual([process.execPath, join(pkg, 'cli.js'), 'acp'])
      // The region reaches the CHILD, which is the only place `mcode acp` can
      // read it: the subcommand takes no region flag.
      expect(spec.env.MAVIS_REGION).toBe('en')
      expect(spec.graceMs).toBe(MINIMAXCODE_DISPOSE_GRACE_MS)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is a different engine from grok in the same process', async () => {
    const ctx = await loopCtx(vi.fn(() => fakeHandle()))
    try {
      const grok = new GrokLoop(ctx, { bin: '/opt/grok' })
      const mcode = new MinimaxcodeLoop(ctx, { bin: '/opt/mcode/cli.js' })
      expect(grok.label).not.toBe(mcode.label)
      expect(grok.config.bin).not.toBe(mcode.config.bin)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('the handover each ACP engine declares', () => {
  it('matches the capability its registry row publishes', () => {
    // The settings page reads the registry, the driver reads the profile: a row
    // that says "yes" while the profile declares no hook would advertise a
    // handover that can never happen, and the reverse would refuse one that works.
    const profiles = {
      kimi: kimiProfile('kimi'),
      grok: grokProfile('grok'),
      minimaxcode: minimaxcodeProfile('mcode'),
    } as const
    for (const [engine, profile] of Object.entries(profiles)) {
      const declared = ENGINE_REGISTRY[engine as keyof typeof profiles].capabilities.modelHandover
      expect(declared).toBe(profile.handoverEnv !== undefined)
      // Every ACP engine that declares one really does hand something over.
      expect(declared).toBe(true)
    }
  })
})
