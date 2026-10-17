/**
 * ACP client-side capabilities: the reverse-RPC methods an agent may call on US.
 *
 * ACP is bidirectional. Besides the requests a client sends (`initialize`,
 * `session/new`, `session/prompt`), an agent may call BACK into the client for
 * things it cannot do itself. Which ones it calls is the agent's decision, and a
 * client that answers `methodNotFound` is a client that agent cannot fully use.
 *
 * This module is the measured list, not the specification's full menu. Two
 * engines were driven with real tasks and every reverse RPC they issued was
 * recorded with `scripts/probe/acp-handshake.mjs` against the real CLIs:
 *
 *   - `session/request_permission` — already implemented since the kimi driver;
 *   - `fs/read_text_file` — Grok Build asks the client to read a file for it;
 *   - `terminal/create` (+ its lifecycle calls) — Grok Build asks the client to
 *     RUN a command and report its output.
 *
 * MiniMax Code asks for none of these: it executes its own tools and reports the
 * result, which is why its tool calls work without any of this.
 *
 * ## Why the terminal bridge is the interesting one
 *
 * A command the AGENT wants run must not become a second, weaker execution path
 * than the one dsh's own `bash` tool uses. So the bridge does not spawn anything
 * itself: it resolves the harness's `shell` service (`ctx.shell`), which owns the
 * sandbox policy, the timeout policy and the output caps. A grok tool call and a
 * dsh `bash` call therefore run through the SAME executor with the SAME
 * confinement — which is also what makes the approval question answerable: the
 * reverse-RPC permission gate stays the single place a human's policy is applied.
 *
 * @module dsh-loop-engine/driver-acp/capabilities
 */

import type { Readable, Writable } from 'node:stream'

/**
 * One reverse-RPC request frame, as it arrived.
 *
 * `id` is a number for every request an agent sends (JSON-RPC allows strings, but
 * all three measured engines use integers); the client echoes it back verbatim.
 */
export interface AcpReverseRequest {
  readonly id: number
  readonly method: string
  readonly params: unknown
}

/**
 * What the client can do for an agent, as the agent was TOLD it can.
 *
 * The values travel in `initialize`'s `clientCapabilities`. Declaring a capability
 * is a promise: an agent reads it to decide whether to send the request at all, so
 * declaring one this client cannot honour is worse than declaring none — the
 * agent would plan a tool call that then fails.
 */
export interface AcpClientCapabilities {
  /** Whether `fs/read_text_file` and `fs/write_text_file` are answerable. */
  readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean }
  /** Whether the `terminal/*` lifecycle is answerable. */
  readonly terminal: boolean
}

/** The capabilities a client announces when it bridges every measured reverse RPC. */
export const FULL_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: true, writeTextFile: false },
  terminal: true,
}

/**
 * The capabilities a client announces when it bridges nothing.
 *
 * Kept as a named constant because it is a real, supported configuration: the
 * kimi driver has always announced this, and a deployment that would rather not
 * let an engine run commands can keep it.
 */
export const NO_CLIENT_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
}

/**
 * Whether one ACP method name is a capability this client implements.
 *
 * The list is closed on purpose: it is exactly the measured set (plus the
 * terminal lifecycle ACP defines around `terminal/create`). Anything else stays
 * on the `methodNotFound` path, so an engine's private extension never gets a
 * half-answer from a client that only meant to support the standard ones.
 * @param method - the ACP method name from a reverse-RPC request.
 * @returns whether {@link AcpReverseHandlers} can answer it.
 */
export function isCapabilityMethod(method: string): boolean {
  return method === 'fs/read_text_file'
    || method === 'terminal/create'
    || method === 'terminal/output'
    || method === 'terminal/wait_for_exit'
    || method === 'terminal/release'
    || method === 'terminal/kill'
}

/**
 * One live terminal the client owns on the agent's behalf.
 *
 * The agent creates it with a command, then polls/awaits it, then releases it. The
 * client is responsible for the whole lifetime: an agent that never releases one
 * must not leak a process, so the client closes every open terminal when its own
 * process goes away.
 */
export interface AcpTerminal {
  /** Output accumulated so far, plus whether the command has finished. */
  snapshot(): AcpTerminalSnapshot
  /** Resolve when the command finishes, or reject when it could not start. */
  waitForExit(): Promise<AcpTerminalExit>
  /** Terminate the command (idempotent) and drop the terminal. */
  release(): void
}

/** The `terminal/output` answer: what the command has produced so far. */
export interface AcpTerminalSnapshot {
  /** Everything written to stdout so far. */
  readonly output: string
  /** Whether the command has finished (and so whether `output` is final). */
  readonly exited: boolean
  /** Exit code, present once `exited`. */
  readonly exitCode?: number
}

/** The `terminal/wait_for_exit` answer. */
export interface AcpTerminalExit {
  /** Exit code; a signal-killed or timed-out command reports a non-zero code. */
  readonly exitCode: number
}

/**
 * The seam a driver hands the client so it can answer the measured reverse RPCs.
 *
 * Every method is optional: a client built without a bridge answers
 * `methodNotFound` for it, which is the honest answer and what the kimi driver
 * has always done. The `terminal` capability is announced ONLY when
 * {@link AcpReverseHandlers.spawnTerminal} is present, so the declaration and the
 * implementation cannot drift apart.
 */
export interface AcpReverseHandlers {
  /**
   * Read one text file for the agent.
   *
   * The path arrives absolute (measured: grok sends the resolved path). It is
   * read through the harness filesystem service when one is available, so dsh's
   * observation policy applies; a plain `node:fs` read is the fallback for a
   * composition without that service.
   * @param path - the absolute path the agent asked for.
   * @returns the file's decoded text.
   */
  readTextFile?(path: string): Promise<string>
  /**
   * Start one command on the agent's behalf.
   *
   * Implementations MUST route through the harness's own executor (or an
   * equivalently confined path) rather than spawning freely: this is the
   * difference between "the engine can use tools" and "the engine bypasses the
   * sandbox".
   * @param command - the shell command line the agent asked to run.
   * @param options - the agent's requested environment and working directory.
   * @returns the live terminal handle.
   */
  spawnTerminal?(command: string, options: AcpTerminalSpawnOptions): Promise<AcpTerminal>
}

/** What an agent may ask for when creating a terminal. */
export interface AcpTerminalSpawnOptions {
  /** Environment entries the agent wants layered over the child's own. */
  readonly env?: Record<string, string>
  /** Working directory, when the agent named one. */
  readonly cwd?: string
}

/**
 * One `terminal/create` params payload, as the agent sent it.
 *
 * ACP spells the environment as a LIST of `{name, value}` pairs, not a map —
 * measured on grok, which sends 14 entries including its own `GROK_SESSION_ID`.
 */
export interface AcpTerminalCreateParams {
  readonly sessionId?: string
  readonly command?: unknown
  readonly env?: unknown
  readonly cwd?: unknown
}

/**
 * Read the command out of `terminal/create` params, or undefined when absent.
 * @param params - the reverse-RPC params.
 * @returns the command line, when the frame carried a non-empty one.
 */
export function terminalCommandOf(params: unknown): string | undefined {
  const command = (params as AcpTerminalCreateParams | undefined)?.command
  return typeof command === 'string' && command.trim() !== '' ? command : undefined
}

/**
 * Read the agent's environment request out of `terminal/create` params.
 *
 * The wire shape is a list of pairs; a malformed entry is skipped rather than
 * failing the call, because a command with a partial environment is still a
 * command the agent asked for, while a thrown error would fail the whole turn
 * over a field the agent did not need.
 * @param params - the reverse-RPC params.
 * @returns the entries as a map, or undefined when the frame carried none.
 */
export function terminalEnvOf(params: unknown): Record<string, string> | undefined {
  const raw = (params as AcpTerminalCreateParams | undefined)?.env
  if (!Array.isArray(raw)) return undefined
  const env: Record<string, string> = {}
  for (const entry of raw) {
    const name = (entry as { name?: unknown } | undefined)?.name
    const value = (entry as { value?: unknown } | undefined)?.value
    if (typeof name === 'string' && name !== '' && typeof value === 'string') env[name] = value
  }
  return Object.keys(env).length === 0 ? undefined : env
}

/**
 * Read the working directory out of `terminal/create` params.
 * @param params - the reverse-RPC params.
 * @returns the directory, when the frame carried a non-empty one.
 */
export function terminalCwdOf(params: unknown): string | undefined {
  const cwd = (params as AcpTerminalCreateParams | undefined)?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The stream triple an ACP child exposes, as the capability layer needs it.
 *
 * Declared structurally rather than imported from `./transport.ts` so a test can
 * build one without the rest of the transport contract.
 */
export interface AcpStdio {
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
}
