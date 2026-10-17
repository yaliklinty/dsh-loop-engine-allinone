/**
 * Projection of one ACP spawn request onto the dsh subprocess seam.
 *
 * Its own module, apart from `./runtime.ts`, for a concrete reason: the seam types
 * are type-only, so this file imports NO host service, and an engine's
 * `process.ts` (argv + executable resolution) can therefore stay importable
 * without the driver class — which is what lets `scripts/probe/smoke-acp.ts`
 * exercise a real dialect against a real CLI in a process that has no dsh
 * composition at all.
 *
 * @module dsh-loop-engine-allinone/driver-acp/subprocess
 */

import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AcpProcess, AcpSpawnSpec } from './transport.ts'

/** Project one driver spawn request onto the dsh subprocess seam. */
export function acpSubprocessSpec(spec: AcpSpawnSpec, graceMs: number): SubprocessSpawnSpec {
  return {
    argv: [...spec.argv],
    cwd: spec.cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs,
    env: spec.env,
    ...spec.signal === undefined ? {} : { signal: spec.signal },
  }
}

/** Project a dsh subprocess handle onto the ACP process transport. */
export function fromSubprocess(handle: SubprocessHandle): AcpProcess {
  const { stdin, stdout, stderr } = handle
  /* v8 ignore start -- the ACP spawn spec always requests piped stdio, so a missing stream is a wiring hole */
  /* v8 ignore next -- see above */
  if (stdin === undefined || stdout === undefined || stderr === undefined) {
    throw new Error('driver-acp: spawned child must pipe stdin/stdout/stderr')
  }
  /* v8 ignore stop */
  return {
    stdin,
    stdout,
    stderr,
    done: handle.done,
    terminate: () => handle.terminate(),
  }
}
