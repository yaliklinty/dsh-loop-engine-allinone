/**
 * The subprocess transport every CLI driver spawns through.
 *
 * One thin layer over the harness's subprocess seam, for two reasons. First, the
 * seam is where the sandbox lives: a spawned CLI is under the deployment's
 * privilege policy, which is the only boundary available for an engine that has
 * no permission system of its own. Second, every driver needs the same four
 * things from a child — write its stdin, read its stdout as lines, know when it
 * exited, and kill it — and doing that four times is how the drivers drift.
 *
 * The transport deliberately knows nothing about any protocol. It hands back
 * streams; deciding what a line MEANS is the adapter's job
 * (`./ndjson.ts`, `./text.ts`).
 *
 * @module dsh-loop-engine/driver-cli/transport
 */

import type { Readable, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'

/** What one driver asks the transport to spawn. */
export interface CliSpawnRequest {
  /** Executable and arguments; `argv[0]` is the program. */
  readonly argv: readonly string[]
  /** Working directory for the child. */
  readonly cwd: string
  /** Explicit environment entries layered over the scrubbed parent environment. */
  readonly env: Record<string, string>
  /** Cancellation: the seam escalates process-tree termination when it fires. */
  readonly signal?: AbortSignal
}

/**
 * A spawned CLI child, as a protocol adapter needs it.
 *
 * `stdin` may be absent when the prompt travels in argv instead (`agy --print=…`,
 * `hermes -z …`, `qoderclicn -p …`): an engine that takes its prompt as an
 * argument has no use for a stdin pipe, and asking for one would leave a pipe
 * the child waits on.
 */
export interface CliTransport {
  /** The child's stdin, or undefined when the spawn did not request a pipe. */
  readonly stdin: Writable | undefined
  /** The child's stdout, or undefined when the spawn did not request a pipe. */
  readonly stdout: Readable | undefined
  /** The child's stderr, or undefined when the spawn did not request a pipe. */
  readonly stderr: Readable | undefined
  /** Resolves when the child closes. */
  readonly done: Promise<unknown>
  /** Request process-tree termination. */
  terminate(): void
}

/** Spawns one CLI child over the given request (a driver's spawn capability). */
export type CliSpawnCapability = (request: CliSpawnRequest) => CliTransport

/**
 * Build a {@link CliSpawnRequest} from a subprocess spawn spec.
 *
 * The two shapes are structurally the same; this exists so a driver can state
 * its request in its own vocabulary and the projection lives in one place.
 * @param request - the driver's spawn request.
 * @param graceMs - grace period for the provider's termination procedure.
 * @param pipeStdin - whether the child reads its prompt from stdin.
 * @returns the seam's spawn spec.
 */
export function cliSubprocessSpec(
  request: CliSpawnRequest,
  graceMs: number,
  pipeStdin: boolean,
): SubprocessSpawnSpec {
  return {
    argv: [...request.argv],
    cwd: request.cwd,
    stdio: { stdin: pipeStdin ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    env: request.env,
    ...request.signal === undefined ? {} : { signal: request.signal },
  }
}

/**
 * Project a subprocess handle onto the transport.
 *
 * A missing stream after a successful spawn is a wiring hole rather than a
 * runtime condition — the spec above always asks for the pipes it needs — so it
 * throws rather than degrading to an empty stream that would look like a silent
 * engine.
 * @param handle - the spawned handle.
 * @param engine - the engine name, for the diagnostic.
 * @returns the transport.
 */
export function transportOf(handle: SubprocessHandle, engine: string): CliTransport {
  const { stdin, stdout, stderr } = handle
  if (stdout === undefined || stderr === undefined) {
    throw new Error(`loop-engine: the ${engine} child was spawned without piped stdout/stderr`)
  }
  return {
    stdin,
    stdout,
    stderr,
    done: handle.done,
    terminate: () => handle.terminate(),
  }
}

/**
 * Wrap a spawn capability so a driver never has to remember the grace period or
 * the stdin decision at each call site.
 * @param spawn - the raw seam projection.
 * @param graceMs - grace period for termination.
 * @param pipeStdin - whether this engine reads its prompt from stdin.
 * @returns a capability taking the driver's own request shape.
 */
export function cliSpawner(
  spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle,
  graceMs: number,
  pipeStdin: boolean,
): CliSpawnCapability {
  return (request) => transportOf(spawn(cliSubprocessSpec(request, graceMs, pipeStdin)), 'cli')
}
