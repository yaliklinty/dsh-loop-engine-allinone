/**
 * The process transport an ACP driver speaks over, engine-neutral.
 *
 * The driver hands the client a handle carrying the child's stdin/stdout/stderr
 * (projected from the dsh subprocess seam). The three engines differ in HOW the
 * child is launched — `kimi acp`, `grok agent stdio`, `mcode acp` — and not at
 * all in what the driver does with it, so the transport is declared once here and
 * each engine's `process.ts` owns its own argv and executable resolution.
 *
 * The names are deliberately this generic: an engine that wants its own spelling
 * for the published surface (`KimiProcess`) aliases these rather than restating
 * them, so a change to the seam cannot reach one engine and miss another.
 *
 * @module dsh-loop-engine/driver-acp/transport
 */

import type { Readable, Writable } from 'node:stream'

/** The exact argv/cwd/env the driver requests for one ACP child. */
export interface AcpSpawnSpec {
  /** The program plus its flags; `argv[0]` is the engine's executable. */
  readonly argv: readonly string[]
  /** The session's working directory, also the ACP session's `cwd`. */
  readonly cwd: string
  /** The child's environment, layered over the credential-scrubbed parent. */
  readonly env: Record<string, string>
  /** Cancellation: the seam escalates process-tree termination when it fires. */
  readonly signal?: AbortSignal
}

/** A spawned ACP agent process, as the client's transport needs it. */
export interface AcpProcess {
  /** Child stdin (JSON-RPC request frames). */
  readonly stdin: Writable
  /** Child stdout (responses and `session/update` notifications). */
  readonly stdout: Readable
  /** Child stderr (diagnostics; drained and dropped). */
  readonly stderr: Readable
  /** Resolves when the child closes. */
  readonly done: Promise<unknown>
  /** Request process-tree termination. */
  terminate(): void
}

/** Spawns one ACP child over the given spec (the driver's spawn capability). */
export type AcpSpawnCapability = (spec: AcpSpawnSpec) => AcpProcess
