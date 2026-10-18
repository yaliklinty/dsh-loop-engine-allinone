/**
 * Grok Build process projection: where the `grok` executable is, and the argv that
 * starts its ACP server.
 *
 * Measured and documented facts this file encodes (see
 * Grok's shipped user guide, and the frames `scripts/probe/acp-handshake.mjs` dumps):
 *
 *   - the ACP server is `grok agent [options] stdio` — agent options go AFTER
 *     `agent` and BEFORE the mode name, so `grok agent stdio` is the bare form;
 *   - the released binary installs to `<GROK_HOME>/bin/grok[.exe]`
 *     (`x.ai/cli/install.sh`, `GROK_HOME` defaulting to `~/.grok`), while the npm
 *     package `@xai-official/grok` installs a `grok.cmd` shim that launches its
 *     own JS bootstrap;
 *   - the CLI has no `.exe` on PATH after an npm install, so the shim case is
 *     handled through the shared executable helper rather than by spawning the
 *     bare name.
 *
 * @module dsh-loop-engine-allinone/engine-grok/process
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execArgvPrefix, resolveOnPath } from '../driver-acp/executable.ts'

/** Grace in milliseconds for Grok process-tree termination. */
export const GROK_DISPOSE_GRACE_MS = 3000

/** Resolve the Grok home directory from `GROK_HOME` or the current user's home. */
export function grokHomeDir(): string {
  const envHome = process.env.GROK_HOME
  return envHome !== undefined && envHome !== '' ? envHome : join(homedir(), '.grok')
}

/**
 * Resolve the `grok` executable.
 *
 * An explicit config path wins. Otherwise the released-binary location is probed
 * first (it is a real executable and the vendor's own install target), then PATH —
 * where an npm install leaves a `.cmd` shim that {@link grokAcpArgv} knows how to
 * launch.
 * @param configBin - an operator-pinned path (or a bare name), if any.
 * @returns the executable to spawn as `argv[0]`.
 */
export function grokBinResolver(configBin?: string): string {
  if (configBin !== undefined && configBin !== '') return configBin
  /* v8 ignore start -- the POSIX arm cannot run on this project's Windows CI host */
  const executable = process.platform === 'win32' ? 'grok.exe' : 'grok'
  /* v8 ignore stop */
  const candidate = join(grokHomeDir(), 'bin', executable)
  if (existsSync(candidate)) return candidate
  return resolveOnPath('grok') ?? 'grok'
}

/**
 * Build the argv that starts `grok agent stdio` (the ACP server over stdio).
 *
 * `--always-approve` is deliberately NOT here: it is a per-SESSION decision, and
 * the engine expresses that per session through `session/new`'s `_meta.yoloMode`
 * (see `./agent.ts`), which keeps this argv stable for every session the child
 * serves and leaves the approval fold in one place.
 * @param bin - the Grok executable (or its npm shim).
 * @returns the argv, ending in the `stdio` mode name.
 */
export function grokAcpArgv(bin: string): string[] {
  return [...execArgvPrefix(bin), 'agent', 'stdio']
}
