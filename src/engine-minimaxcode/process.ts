/**
 * MiniMax Code process projection: where the `mcode` entrypoint is, and the argv
 * that starts its ACP server.
 *
 * Measured facts this file encodes (MiniMax Code 0.6.12 on this fork's reference
 * host):
 *
 *   - the ACP server is `mcode acp` (`--help`: "Run MiniMax Code as an Agent
 *     Client Protocol server over stdio");
 *   - the CLI is distributed as the npm package `@minimax-ai/code`, whose own
 *     entrypoint is `cli.js`. A global install leaves `mcode.cmd` / `mcode.ps1` /
 *     `mcode` shims on PATH and NO `mcode.exe`, so spawning the bare name fails
 *     with `ENOENT` under node's spawn — the measured failure this resolver exists
 *     to avoid. The package entrypoint is therefore preferred, and a `.cmd` that is
 *     all a machine has is launched through the command interpreter
 *     (`driver-acp/executable.ts`);
 *   - the account REGION is a first-class fact (`mcode login --region cn|global`,
 *     credentials under `~/.minimax/auth/prod/<region>/…`), so the region travels
 *     in the child's environment rather than as an argv flag — `mcode acp` takes
 *     none. The variable is `MAVIS_REGION`, MEASURED as the one this surface
 *     honours (`MCODE_REGION` is inert here); it is named by the registry row and
 *     resolved by `./loop.ts`, never spelled in this file.
 *
 * @module dsh-loop-engine/engine-minimaxcode/process
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { execArgvPrefix, npmPackageEntry, resolveOnPath } from '../driver-acp/executable.ts'

/** Grace in milliseconds for MiniMax Code process-tree termination. */
export const MINIMAXCODE_DISPOSE_GRACE_MS = 3000

/** The npm package that ships the CLI. */
export const MINIMAXCODE_NPM_PACKAGE = '@minimax-ai/code'

/** The package-relative entrypoint that starts the CLI. */
export const MINIMAXCODE_ENTRYPOINT = 'cli.js'

/**
 * Resolve the MiniMax Code entrypoint.
 *
 * Order: an explicit config path; the package entrypoint under the npm prefixes
 * this machine is likely to have; a PATH lookup that honours `PATHEXT`; and
 * finally the bare name, which the spawner resolves.
 * @param configBin - an operator-pinned path (or a bare name), if any.
 * @param env - the environment to read the npm prefix hints from.
 * @returns the executable (or `.js` entrypoint) to spawn.
 */
export function mcodeBinResolver(configBin?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (configBin !== undefined && configBin !== '') return configBin
  // `MCODE_INSTALL_ROOT` is the CLI's own install root (it is the variable the
  // package reads for its self-update), so a deployment that moved the install
  // does not have to pin the entrypoint by hand.
  const prefixes = [
    env.MCODE_INSTALL_ROOT,
    env.APPDATA === undefined ? undefined : join(env.APPDATA, 'npm'),
    // A standard Windows node install puts the global prefix beside node.exe.
    dirname(process.execPath),
    dirname(dirname(process.execPath)),
    // POSIX global prefixes. The home directory comes from the OS rather than
    // from the environment: a GUI-launched deployment does not always inherit
    // `HOME`, and the whole point of this resolver is to find an install the
    // inherited environment may not describe.
    '/usr/local',
    join(homedir(), '.npm-global'),
  ]
  for (const prefix of prefixes) {
    if (prefix === undefined || prefix === '') continue
    const entry = npmPackageEntry(prefix, MINIMAXCODE_NPM_PACKAGE, MINIMAXCODE_ENTRYPOINT)
    if (entry !== undefined) return entry
  }
  return resolveOnPath('mcode', env) ?? 'mcode'
}

/**
 * Build the argv that starts `mcode acp`.
 *
 * A `.js` entrypoint runs under the current node; a `.cmd` shim goes through
 * `cmd.exe`; a real executable is spawned as itself (see
 * `driver-acp/executable.ts`).
 * @param bin - the resolved entrypoint.
 * @returns the argv, `argv[0]` being the program to launch.
 */
export function mcodeAcpArgv(bin: string): string[] {
  return [...execArgvPrefix(bin), 'acp']
}
