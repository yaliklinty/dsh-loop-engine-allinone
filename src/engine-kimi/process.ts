/**
 * Kimi CLI process projection: where the executable is, and the argv that
 * launches its ACP server.
 *
 * The transport itself is shared (`driver-acp/transport.ts`); what is kimi's own
 * is the RESOLUTION — kimi ships as a plain executable installed under its own
 * home (`<KIMI_CODE_HOME>/bin/kimi[.exe]`), with PATH as the fallback — and the
 * single `acp` subcommand that starts its Agent Client Protocol server on stdio.
 *
 * The `Kimi*` type names are this engine's published spelling of the shared
 * transport types, kept as aliases rather than restated: a change to the seam
 * cannot then reach one engine and miss another.
 *
 * @module dsh-loop-engine-allinone/engine-kimi/process
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { AcpProcess, AcpSpawnCapability, AcpSpawnSpec } from '../driver-acp/transport.ts'
import { acpSubprocessSpec, fromSubprocess as fromAcpSubprocess } from '../driver-acp/subprocess.ts'

/** The exact argv/cwd/env the driver requests for one `kimi acp` child. */
export type KimiSpawnSpec = AcpSpawnSpec

/** A spawned Kimi process as the agent's transport needs it. */
export type KimiProcess = AcpProcess

/** Spawns one Kimi child over the given spec (the driver's spawn capability). */
export type KimiSpawnCapability = AcpSpawnCapability

/** Resolve the Kimi home directory from `KIMI_CODE_HOME` or the current user's home. */
export function kimiHomeDir(): string {
  const envHome = process.env.KIMI_CODE_HOME
  return envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.kimi-code')
}

/**
 * Resolve the Kimi CLI executable. An explicit config path wins; otherwise this
 * probes the standard `<kimi home>/bin/kimi[.exe]` location and falls back to
 * `'kimi'` (resolved through PATH by the spawner).
 * @param configBin - an operator-pinned absolute path (or `'kimi'`), if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function kimiBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  const executable = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
  const candidate = join(kimiHomeDir(), 'bin', executable)
  return existsSync(candidate) ? candidate : 'kimi'
}

/**
 * Build the persistent `kimi acp` argv. The ACP child stays alive across steps
 * and is spoken to over JSON-RPC on stdio — the prompt is a request body, not an
 * argv positional — so there is no command-line length ceiling and no model flag:
 * a model is selected per ACP session through `session/set_model`, not argv.
 * @param bin - the Kimi executable.
 * @returns the argv, `argv[0]` being the executable.
 */
export function kimiAcpArgv(bin: string): string[] {
  return [bin, 'acp']
}

/** Project the driver's spawn request onto the dsh subprocess seam. */
export function kimiSubprocessSpec(spec: KimiSpawnSpec, graceMs: number): SubprocessSpawnSpec {
  return acpSubprocessSpec(spec, graceMs)
}

/** Project a dsh subprocess handle onto the Kimi process transport. */
export function fromSubprocess(handle: SubprocessHandle): KimiProcess {
  return fromAcpSubprocess(handle)
}
