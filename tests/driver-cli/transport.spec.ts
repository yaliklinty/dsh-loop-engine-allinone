/**
 * The subprocess transport: the spawn spec every CLI child is spawned through.
 *
 * Two facts are pinned here because both are silent when wrong. The `stdin`
 * decision has to match how the prompt travels — asking for a pipe an engine
 * never reads leaves it waiting, and NOT asking for one an engine does read
 * makes it fail immediately with nothing on its prompt channel. And the
 * environment has to reach the child as an OVERLAY on the scrubbed parent
 * environment rather than as a replacement, because that is what lets an engine
 * inherit its own `HERMES_HOME`, `KIMI_CODE_HOME` and the like.
 *
 * @module tests/driver-cli/transport
 */

import { describe, expect, it, vi } from 'vitest'
import { cliSpawner, cliSubprocessSpec, transportOf, type CliSpawnRequest } from '../../src/driver-cli/transport.ts'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/** One minimal spawn request. */
function request(overrides: Partial<CliSpawnRequest> = {}): CliSpawnRequest {
  return { argv: ['engine', '-p', 'hi'], cwd: '/work', env: {}, ...overrides }
}

/** A handle whose stdout/stderr are present. */
function handle(overrides: Partial<SubprocessHandle> = {}): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: {} as never,
    stderr: {} as never,
    control: undefined,
    collected: {} as never,
    done: Promise.resolve({}),
    terminate: () => {},
    waitForExit: () => Promise.resolve(true),
    ...overrides,
  } as unknown as SubprocessHandle
}

describe('cliSubprocessSpec', () => {
  it('pipes stdin only when the engine reads its prompt from it', () => {
    expect(cliSubprocessSpec(request(), 1000, true).stdio).toEqual({ stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    // An engine that takes its prompt as an argument gets no stdin pipe: a pipe
    // it never reads would leave the child waiting.
    expect(cliSubprocessSpec(request(), 1000, false).stdio).toEqual({ stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  })

  it('always pipes stdout and stderr, which is where the protocol lives', () => {
    for (const pipeStdin of [true, false]) {
      const spec = cliSubprocessSpec(request(), 1000, pipeStdin)
      expect(spec.stdio.stdout).toBe('pipe')
      expect(spec.stdio.stderr).toBe('pipe')
    }
  })

  it('copies the argv rather than aliasing the caller’s array', () => {
    const argv = ['engine', 'x']
    const spec = cliSubprocessSpec(request({ argv }), 1000, false)
    expect(spec.argv).toEqual(argv)
    expect(spec.argv).not.toBe(argv)
  })

  it('carries cwd, grace and env through, and the signal only when given', () => {
    const signal = new AbortController().signal
    const spec = cliSubprocessSpec(request({ env: { A: '1' } }), 2500, false)
    expect(spec.cwd).toBe('/work')
    expect(spec.graceMs).toBe(2500)
    expect(spec.env).toEqual({ A: '1' })
    expect(spec.signal).toBeUndefined()
    expect(cliSubprocessSpec(request({ signal }), 1000, false).signal).toBe(signal)
  })
})

describe('transportOf', () => {
  it('projects the handle onto the transport', () => {
    const terminate = vi.fn()
    const transport = transportOf(handle({ terminate }), 'engine')
    expect(transport.stdout).toBeDefined()
    expect(transport.stderr).toBeDefined()
    transport.terminate()
    expect(terminate).toHaveBeenCalledOnce()
  })

  it('throws on a missing stdout rather than degrading to an empty stream', () => {
    // A spawn without stdout is a wiring hole; an empty stream would look like a
    // silent engine instead of a bug.
    expect(() => transportOf(handle({ stdout: undefined }), 'engine')).toThrow(/without piped stdout\/stderr/)
    expect(() => transportOf(handle({ stderr: undefined }), 'engine')).toThrow(/without piped stdout\/stderr/)
  })
})

describe('cliSpawner', () => {
  it('applies the engine’s own grace period and stdin decision', () => {
    const spawn = vi.fn(() => handle())
    const capability = cliSpawner(spawn as never, 4242, true)
    capability(request())
    expect(spawn).toHaveBeenCalledOnce()
    const spec = spawn.mock.calls[0]![0] as { graceMs: number; stdio: { stdin: string } }
    expect(spec.graceMs).toBe(4242)
    expect(spec.stdio.stdin).toBe('pipe')
  })
})
