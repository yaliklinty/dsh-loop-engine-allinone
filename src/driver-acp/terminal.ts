/**
 * The terminal bridge: an ACP agent's `terminal/*` calls, executed through the
 * harness's own shell service.
 *
 * This is the piece that makes a tool-using ACP engine actually work. Grok Build
 * runs every shell tool by asking the CLIENT to execute the command
 * (`terminal/create`); a client that answers `methodNotFound` gives the model a
 * broken tool, which is what this plugin shipped before. The bridge fixes that
 * without touching the engine and without inventing a second execution path:
 *
 *   - the command goes through `ctx.shell` (`ShellExecutor.resolve` +
 *     `execute`), which is the SAME service dsh's own `bash` tool uses — so the
 *     sandbox mode, the timeout policy and the output caps are dsh's, not a
 *     plugin-local imitation of them;
 *   - when the composition has no shell service the bridge REFUSES rather than
 *     falling back to a bare `child_process.spawn`: an unconfined execution
 *     channel is exactly the thing a sandbox exists to prevent, and silently
 *     becoming it would be worse than the tool failing;
 *   - the reverse-RPC approval gate still runs first, so a session whose approval
 *     policy says `ask` denies the command before it is ever spawned.
 *
 * ## Terminal lifecycle
 *
 * ACP models a terminal as a long-lived object: `create` returns an id, the agent
 * polls `terminal/output`, awaits `terminal/wait_for_exit`, and finally calls
 * `terminal/release`. The harness's shell handle already has that shape
 * (`readOutput` is incremental, `done` settles at close, `kill` stops it), so the
 * bridge is a thin adapter over one execution.
 *
 * @module dsh-loop-engine/driver-acp/terminal
 */

import type { AcpTerminal, AcpTerminalExit, AcpTerminalSnapshot, AcpTerminalSpawnOptions } from './capabilities.ts'

/**
 * The part of the harness shell service this bridge uses, declared structurally.
 *
 * The real service is `@deepseek-ai/dsh-shell`'s `ShellExecutor`. It is declared
 * here for the same reason every other host service in this plugin is: the plugin
 * depends on the CONTRACT it consumes, and a minimal composition may not carry the
 * package at all.
 */
export interface ShellExecutorLike {
  /**
   * Fill in and cap an execution request.
   * @param request - the caller's request.
   * @returns the resolved spec to hand to {@link ShellExecutorLike.execute}.
   */
  resolve(request: ShellExecRequestLike): ShellExecSpecLike
  /**
   * Prepare and spawn one command.
   * @param spec - a resolved spec.
   * @returns the prepared handle.
   */
  execute(spec: ShellExecSpecLike): Promise<ShellExecutionLike>
}

/** The subset of the shell request shape this bridge fills in. */
export interface ShellExecRequestLike {
  command: string
  workdir?: string
  timeoutMs?: number
  onExpiry?: 'kill' | 'none'
  env?: Record<string, string>
}

/** The resolved spec, echoed so the handle's result can be read. */
export interface ShellExecSpecLike extends ShellExecRequestLike {
  workdir: string
  timeoutMs: number
  onExpiry: 'kill' | 'none'
}

/** The part of one shell execution this bridge reads. */
export interface ShellExecutionLike {
  readonly done: Promise<void>
  readonly exitCode: number | null
  readOutput(): { readonly stdout: string; readonly stderr: string }
  kill(): boolean
  result(): Promise<{
    readonly exitCode: number | null
    readonly stdout: { readonly text: string } | string
    readonly stderr: { readonly text: string } | string
  }>
}

/**
 * One command the agent asked for, backed by a harness shell execution.
 *
 * Output is buffered because ACP's `terminal/output` is a POLL that must be able
 * to return the whole output so far, while the harness's `readOutput` is a
 * CONSUMING cursor. The bridge therefore keeps everything it has drained, which
 * is also what lets `wait_for_exit` answer with a complete transcript.
 */
class BridgedTerminal implements AcpTerminal {
  private output = ''
  private exited = false
  private exitCode: number | undefined
  private released = false
  private readonly settled: Promise<void>

  constructor(private readonly execution: ShellExecutionLike) {
    this.settled = execution.done.then(() => {
      this.drain()
      this.exited = true
      this.exitCode = execution.exitCode ?? undefined
    }, () => {
      // A rejected spawn still settles the terminal: the agent must not hang
      // waiting for a process that will never report an exit code.
      this.drain()
      this.exited = true
    })
  }

  /** Drain whatever the execution has produced since the last call. */
  private drain(): void {
    try {
      const read = this.execution.readOutput()
      if (read.stdout !== '') this.output += read.stdout
      if (read.stderr !== '') this.output += read.stderr
    } catch {
      // A handle that cannot be read has nothing more to contribute; the output
      // collected so far is still the honest answer.
    }
  }

  snapshot(): AcpTerminalSnapshot {
    this.drain()
    return this.exitCode === undefined
      ? { output: this.output, exited: this.exited }
      : { output: this.output, exited: this.exited, exitCode: this.exitCode }
  }

  async waitForExit(): Promise<AcpTerminalExit> {
    await this.settled
    return { exitCode: this.exitCode ?? 1 }
  }

  release(): void {
    if (this.released) return
    this.released = true
    try {
      this.execution.kill()
    } catch {
      // Already finished: nothing to stop.
    }
  }
}

/**
 * Create the bridge an ACP client uses to answer `terminal/*`.
 *
 * @param shell - the harness shell service, or undefined when the composition has
 *   none (the bridge then refuses every command, see the module note).
 * @param defaultCwd - the session's working directory, used when the agent names
 *   none of its own.
 * @returns a spawn function for {@link AcpReverseHandlers.spawnTerminal}.
 */
export function createTerminalBridge(
  shell: ShellExecutorLike | undefined,
  defaultCwd: string,
): (command: string, options: AcpTerminalSpawnOptions) => Promise<AcpTerminal> {
  return async (command, options) => {
    if (shell === undefined) {
      // Deliberately loud, and deliberately NOT a bare spawn: this plugin will not
      // silently become an unconfined execution channel.
      throw new Error(
        'loop-engine: the engine asked to run a command, but this composition has no shell service — '
        + 'add the harness shell executor (it is what dsh\'s own bash tool runs through)',
      )
    }
    const request: ShellExecRequestLike = {
      command,
      workdir: options.cwd ?? defaultCwd,
      // `onExpiry: 'none'` arms no deadline: an ACP terminal is a long-lived
      // object the AGENT decides when to stop, so the bridge must not impose a
      // timeout the agent never asked for. `release` is the stop signal.
      onExpiry: 'none',
      ...options.env === undefined ? {} : { env: options.env },
    }
    const execution = await shell.execute(shell.resolve(request))
    return new BridgedTerminal(execution)
  }
}
