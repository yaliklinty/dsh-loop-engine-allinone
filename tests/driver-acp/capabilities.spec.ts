/**
 * The client-side capability bridges: what an ACP agent may ask THIS client to do.
 *
 * Two properties are pinned here, and both are the kind that fail silently:
 *
 *   1. what the client ANNOUNCES is exactly what it can DO. Declaring `terminal`
 *      without a bridge makes an agent plan a tool call that then dies; declaring
 *      nothing while implementing everything makes an agent never ask. The
 *      declaration is derived from the handlers, so the two cannot drift;
 *   2. the terminal bridge runs commands through the HARNESS executor, not a bare
 *      spawn. That is the difference between "the engine can use tools" and "the
 *      engine bypasses the sandbox", and the refusal path (no shell service) is
 *      asserted rather than assumed.
 *
 * The measured facts behind the method list come from `scripts/probe/acp-handshake.mjs`:
 * grok asks for `fs/read_text_file`, `terminal/create` and
 * `session/request_permission`; MiniMax Code asks for none.
 *
 * @module tests/driver-acp/capabilities
 */

import { Readable, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AcpClient } from '../../src/driver-acp/client.ts'
import type { AcpProcess } from '../../src/driver-acp/transport.ts'
import {
  FULL_CLIENT_CAPABILITIES,
  NO_CLIENT_CAPABILITIES,
  isCapabilityMethod,
  terminalCommandOf,
  terminalCwdOf,
  terminalEnvOf,
} from '../../src/driver-acp/capabilities.ts'
import {
  createTerminalBridge,
  type ShellExecutorLike,
  type ShellExecutionLike,
} from '../../src/driver-acp/terminal.ts'
import { grokProfile } from '../../src/engine-grok/profile.ts'
import { minimaxcodeProfile } from '../../src/engine-minimaxcode/profile.ts'

/** A fake ACP process that records every frame written to its stdin. */
function fakeProcess(): { process: AcpProcess; writes: string[]; push: (frame: unknown) => void } {
  const writes: string[] = []
  const stdin = new Writable({ write: (chunk, _encoding, callback) => { writes.push(chunk.toString()); callback() } })
  const stdout = new Readable({ read: () => {} })
  return {
    process: {
      stdin,
      stdout,
      stderr: new Readable({ read: () => {} }),
      done: Promise.withResolvers<unknown>().promise,
      terminate: vi.fn(),
    },
    writes,
    push: (frame: unknown) => { stdout.push(`${JSON.stringify(frame)}\n`) },
  }
}

/** Wait for a pushed frame to reach the client. */
const queue = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/** A fake shell executor recording every command it is asked to run. */
function fakeShell(output = 'BRIDGED\n'): {
  shell: ShellExecutorLike
  commands: string[]
  requests: Record<string, unknown>[]
  killed: number[]
} {
  const commands: string[] = []
  const requests: Record<string, unknown>[] = []
  const killed: number[] = []
  let index = 0
  const shell: ShellExecutorLike = {
    resolve: request => {
      requests.push({ ...request })
      return { ...request, workdir: request.workdir ?? '/w', timeoutMs: request.timeoutMs ?? 0, onExpiry: request.onExpiry ?? 'none' }
    },
    execute: async (spec) => {
      commands.push(spec.command)
      const slot = index++
      const done = Promise.withResolvers<void>()
      let drained = false
      const execution: ShellExecutionLike = {
        done: done.promise,
        exitCode: 0,
        readOutput: () => {
          if (drained) return { stdout: '', stderr: '' }
          drained = true
          return { stdout: output, stderr: '' }
        },
        kill: () => { killed.push(slot); return true },
        result: async () => ({ exitCode: 0, stdout: output, stderr: '' }),
      }
      // Settle on the next microtask, like a fast command.
      queue().then(() => { done.resolve() })
      return execution
    },
  }
  return { shell, commands, requests, killed }
}

describe('the announced capabilities are derived from what the client can do', () => {
  it('announces nothing when it bridges nothing', () => {
    const client = new AcpClient(fakeProcess().process)
    expect(client.clientCapabilities()).toEqual(NO_CLIENT_CAPABILITIES)
    expect(client.clientCapabilities().terminal).toBe(false)
  })

  it('announces terminal only when a terminal bridge exists', () => {
    const { shell } = fakeShell()
    const client = new AcpClient(fakeProcess().process, {
      handlers: { spawnTerminal: createTerminalBridge(shell, '/w') },
    })
    expect(client.clientCapabilities()).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
      terminal: true,
    })
  })

  it('announces fs reads only when a read bridge exists, and never a write', () => {
    const client = new AcpClient(fakeProcess().process, { handlers: { readTextFile: async () => 'x' } })
    expect(client.clientCapabilities()).toEqual({
      // Writes stay false even with a full read bridge: no measured engine asked
      // for one, and a write behind dsh's edit policy would defeat it.
      fs: { readTextFile: true, writeTextFile: false },
      terminal: false,
    })
  })

  it('sends the derived block on the wire', async () => {
    const fake = fakeProcess()
    const { shell } = fakeShell()
    const client = new AcpClient(fake.process, {
      protocolVersion: 1,
      handlers: { readTextFile: async () => 'x', spawnTerminal: createTerminalBridge(shell, '/w') },
    })
    const pending = client.initialize()
    await queue()
    const sent = JSON.parse(fake.writes[0]!) as { params: { clientCapabilities: unknown } }
    expect(sent.params.clientCapabilities).toEqual(FULL_CLIENT_CAPABILITIES)
    fake.push({ jsonrpc: '2.0', id: 1, result: {} })
    await pending
  })

  it('keeps the capability method list closed', () => {
    // Exactly the measured set plus ACP's own terminal lifecycle. An engine's
    // private extension must fall through to `methodNotFound`.
    for (const method of ['fs/read_text_file', 'terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/release', 'terminal/kill']) {
      expect(isCapabilityMethod(method), method).toBe(true)
    }
    for (const method of ['fs/write_text_file', 'x.ai/fs/read_file', 'terminal/nonsense']) {
      expect(isCapabilityMethod(method), method).toBe(false)
    }
  })
})

describe('reading terminal/create params', () => {
  it('reads the command, cwd and the LIST-shaped environment', () => {
    // ACP spells env as `[{name, value}]`, measured on grok (14 entries).
    const params = {
      sessionId: 's',
      command: 'echo hi',
      cwd: 'D:/w',
      env: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
    }
    expect(terminalCommandOf(params)).toBe('echo hi')
    expect(terminalCwdOf(params)).toBe('D:/w')
    expect(terminalEnvOf(params)).toEqual({ A: '1', B: '2' })
  })

  it('drops malformed entries instead of failing the whole call', () => {
    expect(terminalEnvOf({ env: [{ name: 'A', value: '1' }, { name: '', value: 'x' }, { name: 'C' }, 'junk'] }))
      .toEqual({ A: '1' })
    expect(terminalEnvOf({ env: [] })).toBeUndefined()
    expect(terminalEnvOf({})).toBeUndefined()
  })

  it('returns undefined for an absent or empty command', () => {
    expect(terminalCommandOf({ command: '   ' })).toBeUndefined()
    expect(terminalCommandOf({})).toBeUndefined()
    expect(terminalCommandOf(undefined)).toBeUndefined()
  })
})

describe('the terminal bridge runs through the harness executor', () => {
  it('resolves a request with no deadline and runs it', async () => {
    const { shell, commands, requests } = fakeShell()
    const spawn = createTerminalBridge(shell, '/session-cwd')
    const terminal = await spawn('echo hi', {})
    expect(commands).toEqual(['echo hi'])
    // `onExpiry: 'none'` is load-bearing: an ACP terminal is long-lived and the
    // AGENT decides when to stop it, so the bridge must not impose a deadline.
    expect(requests[0]).toMatchObject({ command: 'echo hi', workdir: '/session-cwd', onExpiry: 'none' })
    expect(terminal.snapshot().output).toBe('BRIDGED\n')
  })

  it('uses the agent\'s cwd and environment when it names them', async () => {
    const { shell, requests } = fakeShell()
    await createTerminalBridge(shell, '/session-cwd')('ls', { cwd: 'D:/elsewhere', env: { A: '1' } })
    expect(requests[0]).toMatchObject({ workdir: 'D:/elsewhere', env: { A: '1' } })
  })

  it('reports the exit code and settles wait_for_exit', async () => {
    const { shell } = fakeShell('done\n')
    const terminal = await createTerminalBridge(shell, '/w')('true', {})
    await expect(terminal.waitForExit()).resolves.toEqual({ exitCode: 0 })
    const snapshot = terminal.snapshot()
    expect(snapshot.exited).toBe(true)
    expect(snapshot.output).toBe('done\n')
  })

  it('stops the command on release, idempotently', async () => {
    const { shell, killed } = fakeShell()
    const terminal = await createTerminalBridge(shell, '/w')('sleep 100', {})
    terminal.release()
    terminal.release()
    expect(killed).toEqual([0])
  })

  it('REFUSES rather than spawning unconfined when the composition has no shell service', async () => {
    // This is the security-relevant assertion: the bridge must not quietly become
    // a bare child_process when the sandboxed executor is missing.
    const spawn = createTerminalBridge(undefined, '/w')
    await expect(spawn('echo hi', {})).rejects.toThrow(/no shell service/)
  })
})

describe('the client answers the measured reverse RPCs', () => {
  /** Drive one reverse request through a client and return the frame it wrote. */
  async function roundTrip(
    handlers: Parameters<typeof AcpClient.create>[2] extends infer O ? O extends { handlers?: infer H } ? H : never : never,
    method: string,
    params: unknown,
  ): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process, { handlers: handlers as never })
    fake.push({ jsonrpc: '2.0', id: 42, method, params })
    await queue()
    await queue()
    const answer = fake.writes.map(line => JSON.parse(line) as { id?: number; result?: unknown; error?: { code: number; message: string } })
      .find(frame => frame.id === 42)
    if (answer === undefined) throw new Error('the client wrote no answer')
    return answer
  }

  it('answers fs/read_text_file with the file content', async () => {
    const answer = await roundTrip({ readTextFile: async () => 'hello' }, 'fs/read_text_file', { path: 'D:/w/a.txt' })
    expect(answer.result).toEqual({ content: 'hello' })
  })

  it('reports a read failure to the agent rather than throwing', async () => {
    const answer = await roundTrip(
      { readTextFile: async () => { throw new Error('nope') } },
      'fs/read_text_file',
      { path: 'D:/w/a.txt' },
    )
    // The agent turns this into a failed tool call, which is what the user sees.
    expect(answer.error?.message).toBe('nope')
  })

  it('creates, polls, awaits and releases a terminal', async () => {
    // ONE client for the whole lifecycle: a terminal id is scoped to the client
    // that created it, which is also what stops one session's engine from
    // touching another's command.
    const { shell, commands } = fakeShell('OUT\n')
    const fake = fakeProcess()
    const client = new AcpClient(fake.process, { handlers: { spawnTerminal: createTerminalBridge(shell, '/w') } })
    const ask = async (method: string, params: unknown): Promise<{ result?: unknown; error?: { message: string } }> => {
      const id = 100 + fake.writes.length
      fake.push({ jsonrpc: '2.0', id, method, params })
      await queue()
      await queue()
      const answer = fake.writes
        .map(line => JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } })
        .find(frame => frame.id === id)
      if (answer === undefined) throw new Error(`no answer to ${method}`)
      return answer
    }

    const created = await ask('terminal/create', { command: 'echo OUT', env: [{ name: 'A', value: '1' }] })
    const terminalId = (created.result as { terminalId?: string }).terminalId
    expect(terminalId).toMatch(/^term-/)
    expect(commands).toEqual(['echo OUT'])

    const polled = await ask('terminal/output', { terminalId })
    expect((polled.result as { output: string }).output).toBe('OUT\n')

    const waited = await ask('terminal/wait_for_exit', { terminalId })
    expect(waited.result).toEqual({ exitCode: 0 })

    await ask('terminal/release', { terminalId })
    // A released terminal is gone: a later poll is an error, not a stale answer.
    const gone = await ask('terminal/output', { terminalId })
    expect(gone.error?.message).toMatch(/no terminal/)
  })

  it('answers methodNotFound for a capability it did not announce', async () => {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process) // no handlers at all
    fake.push({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: { path: 'x' } })
    await queue()
    await queue()
    const answer = fake.writes.map(line => JSON.parse(line) as { id?: number; error?: { code: number; message: string } })
      .find(frame => frame.id === 7)
    // The method IS recognised (it is in the closed list) but this client has no
    // handler, so the refusal names the reason instead of claiming the method does
    // not exist — either way the agent gets a decidable failure.
    expect(answer?.error?.message).toMatch(/does not read files/)
  })

  it('releases every terminal when the client is disposed', async () => {
    const { shell, killed } = fakeShell()
    const fake = fakeProcess()
    const client = new AcpClient(fake.process, { handlers: { spawnTerminal: createTerminalBridge(shell, '/w') } })
    fake.push({ jsonrpc: '2.0', id: 1, method: 'terminal/create', params: { command: 'sleep 100' } })
    await queue()
    await queue()
    client.dispose()
    // A driver going away must not leave the engine's command running.
    expect(killed.length).toBe(1)
  })
})

describe('which engines declare which bridges', () => {
  it('grok declares both bridges, because it drives its tools through the client', () => {
    // Measured: grok asks the client for `terminal/create` and
    // `fs/read_text_file`; without the bridges every tool call fails.
    expect(grokProfile('/x').clientBridges).toEqual(['readTextFile', 'terminal'])
  })

  it('minimaxcode declares none, because it runs its own tools', () => {
    // Measured: minimaxcode executes the command itself and reports
    // `rawOutput.details.execution.exitCode`, so it needs nothing from us.
    expect(minimaxcodeProfile('/x').clientBridges).toBeUndefined()
  })
})

describe('terminal executions that end badly', () => {
  /** A bridge over an execution whose `done` rejects and reports no exit code. */
  function brokenShell(options: { stderr?: string; exitCode?: number | null; reject?: boolean }) {
    const shell: ShellExecutorLike = {
      resolve: request => ({
        ...request,
        workdir: request.workdir ?? '/w',
        timeoutMs: request.timeoutMs ?? 0,
        onExpiry: request.onExpiry ?? 'none',
      }),
      execute: async () => {
        const done = Promise.withResolvers<void>()
        let drained = false
        const execution: ShellExecutionLike = {
          done: done.promise,
          exitCode: options.exitCode === undefined ? 0 : options.exitCode,
          readOutput: () => {
            if (drained) return { stdout: '', stderr: '' }
            drained = true
            return { stdout: 'out', stderr: options.stderr ?? '' }
          },
          kill: () => true,
          result: async () => ({ exitCode: options.exitCode ?? 0, stdout: 'out', stderr: options.stderr ?? '' }),
        }
        queue().then(() => {
          if (options.reject === true) done.reject(new Error('spawn failed'))
          else done.resolve()
        })
        return execution
      },
    }
    return shell
  }

  it('collects stderr into the terminal output', async () => {
    // ACP gives the agent ONE output stream; a command that wrote only on stderr
    // still said something, and dropping it would look like an empty command.
    const terminal = await createTerminalBridge(brokenShell({ stderr: 'boom\n' }), '/w')('false', {})
    await terminal.waitForExit()
    expect(terminal.snapshot().output).toBe('outboom\n')
  })

  it('settles a terminal whose execution rejected, rather than hanging it', async () => {
    // A rejected spawn still settles: the agent must not wait for a process that
    // will never report an exit code.
    const terminal = await createTerminalBridge(brokenShell({ reject: true }), '/w')('ghost', {})
    await expect(terminal.waitForExit()).resolves.toEqual({ exitCode: 1 })
    expect(terminal.snapshot().exited).toBe(true)
  })

  it('omits the exit code when the execution reported none', async () => {
    // `?? undefined` on a null exit code is what keeps the snapshot honest: a
    // signal death has no code, and inventing one would misreport it.
    const terminal = await createTerminalBridge(brokenShell({ exitCode: null }), '/w')('killed', {})
    await terminal.waitForExit()
    expect(terminal.snapshot()).not.toHaveProperty('exitCode')
  })
})

describe('the request methods the drivers call', () => {
  /** A client over a fake process, plus the frames it wrote. */
  function clientWith(handlers?: Record<string, unknown>): {
    client: AcpClient
    writes: string[]
    push: (frame: unknown) => void
  } {
    const fake = fakeProcess()
    const client = new AcpClient(fake.process, handlers === undefined ? {} : { handlers: handlers as never })
    return { client, writes: fake.writes, push: fake.push }
  }

  /** Answer the next request the client wrote, by id. */
  async function answer(writes: string[], push: (frame: unknown) => void, result: unknown): Promise<void> {
    const id = (JSON.parse(writes.at(-1)!) as { id: number }).id
    push({ jsonrpc: '2.0', id, result })
    await queue()
    await queue()
  }

  it('sends each dialect request with the field names the wire expects', async () => {
    // These are thin wrappers, and that is exactly why they are worth pinning:
    // one renamed field is an `-32602` at the agent, far from the caller.
    const { client, writes, push } = clientWith()

    const authenticate = client.authenticate('grok.com')
    await queue()
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({ method: 'authenticate', params: { methodId: 'grok.com' } })
    await answer(writes, push, {})
    await authenticate

    const load = client.loadSession('sess-1', '/work')
    await queue()
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      method: 'session/load',
      params: { sessionId: 'sess-1', cwd: '/work', mcpServers: [] },
    })
    await answer(writes, push, {})
    await load

    const setOption = client.setConfigOption('sess-1', 'model', 'grok-4.7')
    await queue()
    // The BARE value: measured, the `{ value }` wrapper is rejected `-32602` on
    // this dialect.
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: 'grok-4.7' },
    })
    await answer(writes, push, {})
    await setOption

    const setOptionValue = client.setConfigOptionValue('sess-1', 'model', 'grok-4.7')
    await queue()
    // The OTHER dialect, which wants the wrapper. Both exist because the two
    // engines disagree and neither could be probed into the other's shape.
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      method: 'session/set_config_option',
      params: { sessionId: 'sess-1', configId: 'model', value: { value: 'grok-4.7' } },
    })
    await answer(writes, push, {})
    await setOptionValue

    const setMode = client.setMode('sess-1', 'auto')
    await queue()
    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      method: 'session/set_mode',
      params: { sessionId: 'sess-1', modeId: 'auto' },
    })
    await answer(writes, push, {})
    await setMode
  })

  it('publishes no catalog until an engine has been asked', async () => {
    // Before `session/new` the client knows nothing; reporting an empty list would
    // look like "this engine has no models" instead of "not asked yet".
    const { client } = clientWith()
    expect(client.discoveredModels()).toBeUndefined()
  })

  it('refuses a capability method it has no handler for', async () => {
    // Announcing nothing but still answering would make an agent plan a tool call
    // that dies; the client must say it cannot.
    const { client } = clientWith()
    const ask = (client as unknown as {
      capabilityResult: (method: string, params: unknown) => Promise<unknown>
    }).capabilityResult.bind(client)
    await expect(ask('fs/read_text_file', { path: '/a' }))
      .rejects.toThrow(/does not read files/)
    await expect(ask('terminal/create', { command: 'ls' }))
      .rejects.toThrow(/does not run commands/)
    await expect(ask('fs/write_text_file', { path: '/a' }))
      .rejects.toThrow(/unsupported capability method/)
  })

  it('rejects a reverse request whose parameters do not name what it needs', async () => {
    const { client } = clientWith({
      readTextFile: async () => 'x',
      spawnTerminal: async () => ({ snapshot: () => ({ output: '', exited: true }) }),
    })
    const ask = (client as unknown as {
      capabilityResult: (method: string, params: unknown) => Promise<unknown>
    }).capabilityResult.bind(client)
    await expect(ask('fs/read_text_file', {})).rejects.toThrow(/needs a path/)
    await expect(ask('terminal/create', {})).rejects.toThrow(/needs a command/)
    await expect(ask('terminal/output', {})).rejects.toThrow(/names no terminal/)
    await expect(ask('terminal/wait_for_exit', { terminalId: '' })).rejects.toThrow(/names no terminal/)
  })
})
